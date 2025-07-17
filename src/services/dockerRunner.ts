import Docker from "dockerode";
import path from "path";
import { Writable } from "stream";
import fs from "fs";
import { ContainerPool } from "./containerPool";
import { getLanguageConfig, execInContainer, writeFileToContainerBase64 } from "../utils/dockerUtils";

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
        
        if (!fs.existsSync(filePath)) {
            console.error("[ERROR] Code file not found:", filePath);
            throw new Error(`Code file not found: ${filePath}`);
        }
        
        const fileContent = fs.readFileSync(filePath, "utf8");

        console.log("[DEBUG] filePath:", filePath);
        console.log("[DEBUG] filename:", config.fileName);
        console.log("[DEBUG] content length:", fileContent.length);

        await writeFileToContainerBase64(container, config.fileName, fileContent);

        console.log("[DEBUG] Archive uploaded successfully");

        const catExec = await container.exec({
            Cmd: ["cat", `/tmp/${config.fileName}`],
            AttachStdout: true,
            AttachStderr: true,
        });
        const catStream = await catExec.start({});
        catStream.on("data", (chunk: { toString: () => any; }) => {
            console.log(`📝 Content inside container /tmp/${config.fileName}:`, chunk.toString());
        });
        
        await execInContainer(container, ["touch", "/tmp/hello.txt"]);
        await execInContainer(container, ["ls", "-lh", "/tmp"]);

        const { output: lsOutput } = await execInContainer(container, ["ls", "-lh", "/tmp"]);
        console.log("[DEBUG] /tmp contents:", lsOutput);


        if (!lsOutput.includes(config.fileName)) {
            throw new Error(`File ${config.fileName} not found in container after upload`);
        }

        console.log("🧪 Running:", config.cmd.join(" "));

        await execInContainer(container, ["ls", "-lh", "/tmp"]);

        const debugExec = await container.exec({
            Cmd: ["ls", "-l", "/tmp"],
            AttachStdout: true,
            AttachStderr: true
        });
        const debugStream = await debugExec.start();

        debugStream.on("data", (chunk: { toString: () => any; }) => {
            console.log("[/tmp contents]", chunk.toString());
        });

        console.log("🧪 Running:", config.cmd.join(" "));

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
    
    const tempFile = path.join(tempDir, `${config.fileName}`);

    if (!fs.existsSync(tempFile)) {
        throw new Error(`Code file not found: ${tempFile}`);
    }

    console.log("[DEBUG] Putting archive to /tmp");
    await writeFileToContainerBase64(container, config.fileName, code);
    console.log("[DEBUG] Archive put complete");

    const { output: lsOutput } = await execInContainer(container, ["ls", "-l", "/tmp"]);
    console.log("[DEBUG] /tmp contents:", lsOutput);

    if (!lsOutput.includes(config.fileName)) {
        throw new Error(`File ${config.fileName} not found in container after upload`);
    }

    const debugExec = await container.exec({
        Cmd: ["ls", "-l", "/tmp"],
        AttachStdout: true,
        AttachStderr: true
    });
    const debugStream = await debugExec.start({});

    debugStream.on("data", (chunk: Buffer) => {
        console.log("[/tmp contents]", chunk.toString());
    });

    console.log("🧪 Running:", config.cmd.join(" "));

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