import { WebSocketServer } from "ws";
import { Server as HTTPServer } from "http";
import stream from "stream";
import fs from "fs";
import path from "path";
import tarFs from "tar-fs";
import { ContainerPool } from "../services/containerPool";
import { getLanguageConfig } from "../utils/dockerUtils";
import Docker from "dockerode";

const docker = new Docker();

let containerPool: ContainerPool | null = null;

interface ClientSession {
    pooledContainer?: any;
    execStream?: any;
    isRunning: boolean;
    language?: string;
    timeout?: NodeJS.Timeout;
}

export const initializeWebSocketPool = async (): Promise<void> => {
    if (containerPool) {
        return;
    }
    
    containerPool = new ContainerPool(docker, {
        minSize: 3,
        maxSize: 15,
        maxAge: 45 * 60 * 1000,
        maxIdleTime: 15 * 60 * 1000,
    });
    
    await containerPool.preloadImages();
    await containerPool.initializePools();
};

export const setupWebSocketServer = (server: HTTPServer) => {
    const wss = new WebSocketServer({ server });

    wss.on("connection", async (ws) => {
        console.log("New WebSocket client connected");
        
        const session: ClientSession = {
            isRunning: false
        };

        const sendMessage = (message: string, type: "stdout" | "stderr" | "system" = "system") => {
            try {
                ws.send(JSON.stringify({ type, message }));
            } catch (error) {
                console.error("Error sending message:", error);
            }
        };

        const cleanup = async () => {
            if (session.timeout) {
                clearTimeout(session.timeout);
            }
            
            if (session.execStream) {
                try {
                    session.execStream.destroy();
                } catch (error) {
                    console.error("Error destroying exec stream:", error);
                }
            }

            if (session.pooledContainer && containerPool) {
                try {
                    await containerPool.release(session.pooledContainer);
                    console.log(`Released container for ${session.language} back to pool`);
                } catch (error) {
                    console.error("Error releasing container to pool:", error);
                }
            }
            
            session.isRunning = false;
            session.pooledContainer = undefined;
            session.execStream = undefined;
        };

        sendMessage("Welcome to the Codelabs code runner server!");

        ws.on("message", async (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                
                if (data.type === "execute") {
                    const { language, code } = data;
                    
                    if (session.isRunning) {
                        sendMessage("A code execution is already in progress", "system");
                        return;
                    }

                    if (!containerPool) {
                        sendMessage("Container pool not initialized", "system");
                        return;
                    }

                    const config = getLanguageConfig(language);
                    if (!config) {
                        sendMessage(`Unsupported language: ${language}`, "system");
                        return;
                    }

                    session.isRunning = true;
                    session.language = language;

                    try {
                        session.pooledContainer = await containerPool.acquire(language);
                        const { container } = session.pooledContainer;
                        
                        sendMessage(`Acquired container for ${language}`, "system");

                        const tempDir = path.join(process.cwd(), "tmp");
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        
                        const tempFile = path.join(tempDir, `${Date.now()}_${config.fileName}`);
                        fs.writeFileSync(tempFile, code);

                        const tarStream = new stream.PassThrough();
                        const archive = tarFs.pack(path.dirname(tempFile), {
                            entries: [path.basename(tempFile)],
                            map: (header) => {
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

                        session.execStream = await runExec.start({ hijack: true, stdin: true });
                        
                        session.pooledContainer.execStream = session.execStream;

                        const stdout = new stream.Writable({
                            write(chunk, _enc, cb) {
                                sendMessage(chunk.toString(), "stdout");
                                cb();
                            },
                        });

                        const stderr = new stream.Writable({
                            write(chunk, _enc, cb) {
                                sendMessage(chunk.toString(), "stderr");
                                cb();
                            },
                        });

                        docker.modem.demuxStream(session.execStream, stdout, stderr);

                        session.timeout = setTimeout(async () => {
                            sendMessage("Execution timed out (30 seconds)", "system");
                            await cleanup();
                        }, 30000);

                        session.execStream.on("end", async () => {
                            sendMessage("Execution completed", "system");
                            await cleanup();
                        });

                        session.execStream.on("error", async (err: Error) => {
                            sendMessage(`Execution error: ${err.message}`, "system");
                            await cleanup();
                        });

                        try {
                            fs.unlinkSync(tempFile);
                        } catch (error) {
                            console.warn("Failed to cleanup temp file:", error);
                        }

                        sendMessage("Code execution started", "system");

                    } catch (err: any) {
                        sendMessage(`Error: ${err.message}`, "system");
                        await cleanup();
                    }
                } else if (data.type === "input") {
                    if (session.execStream && session.isRunning) {
                        try {
                            session.execStream.write(data.message + "\n");
                        } catch (error) {
                            sendMessage("Error sending input to container", "system");
                        }
                    } else {
                        sendMessage("No active execution to send input to", "system");
                    }
                } else if (data.type === "stop") {
                    if (session.isRunning) {
                        sendMessage("Stopping execution...", "system");
                        await cleanup();
                    }
                } else if (data.type === "stats") {
                    if (containerPool) {
                        const stats = containerPool.getStats();
                        sendMessage(JSON.stringify(stats, null, 2), "system");
                    } else {
                        sendMessage("Container pool not initialized", "system");
                    }
                }
            } catch (err: any) {
                sendMessage(`Message parsing error: ${err.message}`, "system");
            }
        });

        ws.on("close", async () => {
            console.log("WebSocket client disconnected");
            await cleanup();
        });

        ws.on("error", async (error) => {
            console.error("WebSocket error:", error);
            await cleanup();
        });
    });

    return wss;
};

export const getWebSocketPoolStats = (): Record<string, any> => {
    if (!containerPool) {
        return { error: "Container pool not initialized" };
    }
    
    return containerPool.getStats();
};

export const shutdownWebSocketPool = async (): Promise<void> => {
    if (containerPool) {
        await containerPool.shutdown();
        containerPool = null;
    }
};