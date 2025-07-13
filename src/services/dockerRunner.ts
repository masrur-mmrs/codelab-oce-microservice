import Docker from "dockerode";
import path from "path";
import stream, { Writable } from "stream";
import fs from "fs";
import type { Pack } from "tar-fs";
import { ContainerPool } from "./containerPool";
import { getLanguageConfig } from "../utils/dockerUtils";

const docker = new Docker();

let containerPool: ContainerPool | null = null;

interface RunResult {
    stdout: string;
    stderr: string;
    success: boolean;
    executionTime: number;
}


export const initializeContainerPool = async (): Promise<void> => {
    if (containerPool) {
        return;
    }
    
    console.log("Initializing container pool system...");
    
    containerPool = new ContainerPool(docker, {
        minSize: 2,
        maxSize: 10,
        maxAge: 30 * 60 * 1000, // 30 minutes
        maxIdleTime: 10 * 60 * 1000, // 10 minutes
    });
    
    await containerPool.preloadImages();
    
    await containerPool.initializePools();
    
    console.log("Container pool system initialized successfully!");
};

export const getPoolStats = (): Record<string, any> => {
    if (!containerPool) {
        return { error: "Container pool not initialized" };
    }
    
    return containerPool.getStats();
};

export const shutdownContainerPool = async (): Promise<void> => {
    if (containerPool) {
        await containerPool.shutdown();
        containerPool = null;
    }
};

export const runCodeInDocker = async (
    filePath: string, 
    input: string, 
    language: string,
    timeoutMs: number = 30000
): Promise<RunResult> => {
    if (!containerPool) {
        throw new Error("Container pool not initialized. Call initializeContainerPool() first.");
    }
    
    const startTime = Date.now();
    const config = getLanguageConfig(language);
    
    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }

    let pooledContainer: any = null;
    
    try {
        pooledContainer = await containerPool.acquire(language);
        const { container } = pooledContainer;
        
        const tarStream = new stream.PassThrough();
        const fileName = path.basename(filePath);
        const archive: Pack = require("tar-fs").pack(path.dirname(filePath), {
            entries: [fileName],
            map: (header: { name: string }) => {
                header.name = config.fileName;
                return header;
            },
        });
        archive.pipe(tarStream);
        await container.putArchive(tarStream, { path: "/tmp" });

        const exec = await container.exec({
            Cmd: config.cmd,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: "/tmp"
        });

        const execStream = await exec.start({ hijack: true, stdin: true });
        
        pooledContainer.execStream = execStream;

        return new Promise<RunResult>((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            let isResolved = false;

            const stdoutStream = new Writable({
                write(chunk: Buffer, _encoding: any, callback: () => void) {
                    stdout += chunk.toString();
                    callback();
                },
            });

            const stderrStream = new Writable({
                write(chunk: Buffer, _encoding: any, callback: () => void) {
                    stderr += chunk.toString();
                    callback();
                },
            });

            docker.modem.demuxStream(execStream, stdoutStream, stderrStream);

            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    execStream.destroy();
                    reject(new Error("Execution timed out"));
                }
            }, timeoutMs);

            execStream.on("end", async () => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    
                    try {
                        const execInfo = await exec.inspect();
                        const executionTime = Date.now() - startTime;
                        
                        resolve({
                            stdout: stdout.trim(),
                            stderr: stderr.trim(),
                            success: execInfo.ExitCode === 0,
                            executionTime
                        });
                    } catch (error) {
                        reject(error);
                    }
                }
            });

            execStream.on("error", (err: Error) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            if (input) {
                const lines = input.split("\n");
                lines.forEach((line) => {
                    execStream.write(line + "\n");
                });
            }
            
            execStream.end();
        });

    } catch (error) {
        throw error;
    } finally {
        if (pooledContainer && containerPool) {
            try {
                await containerPool.release(pooledContainer);
            } catch (error) {
                console.error("Failed to release container to pool:", error);
            }
        }
    }
};

export const createInteractiveContainer = async (
    code: string,
    language: string
): Promise<{
    container: Docker.Container;
    execStream: any;
    cleanup: () => Promise<void>;
}> => {
    if (!containerPool) {
        throw new Error("Container pool not initialized. Call initializeContainerPool() first.");
    }
    
    const config = getLanguageConfig(language);
    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }

    const pooledContainer = await containerPool.acquire(language);
    const { container } = pooledContainer;

    const tempDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFile = path.join(tempDir, `${Date.now()}_${config.fileName}`);
    fs.writeFileSync(tempFile, code);

    const tarStream = new stream.PassThrough();
    const archive = require("tar-fs").pack(path.dirname(tempFile), {
        entries: [path.basename(tempFile)],
        map: (header: { name: string }) => {
            header.name = config.fileName;
            return header;
        },
    });
    archive.pipe(tarStream);
    await container.putArchive(tarStream, { path: "/tmp" });

    const runExec = await container.exec({
        Cmd: config.cmd,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        WorkingDir: "/tmp"
    });

    const execStream = await runExec.start({ hijack: true, stdin: true });
    
    pooledContainer.execStream = execStream;

    const cleanup = async () => {
        try {
            fs.unlinkSync(tempFile);
        } catch (error) {
            console.warn("Failed to cleanup temp file:", error);
        }
        
        if (execStream) {
            try {
                execStream.destroy();
            } catch (error) {
                console.warn("Failed to destroy exec stream:", error);
            }
        }

        if (containerPool) {
            try {
                await containerPool.release(pooledContainer);
            } catch (error) {
                console.error("Failed to release container to pool:", error);
            }
        }
    };

    return { container, execStream, cleanup };
};