import { WebSocketServer } from "ws";
import { Server as HTTPServer } from "http";
import stream from "stream";
import { getLanguageConfig, writeFileToContainerBase64 } from "../utils/dockerUtils";
import { getSharedContainerPool } from "../services/dockerRunner"; // Import shared pool
import Docker from "dockerode";

const docker = new Docker();

interface ClientSession {
    pooledContainer?: any;
    execStream?: any;
    isRunning: boolean;
    language?: string;
    timeout?: NodeJS.Timeout;
}

export const setupWebSocketServer = (server: HTTPServer) => {
    const wss = new WebSocketServer({ server });
    const activeSessions = new Set<ClientSession>();

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

        activeSessions.add(session);

        const cleanup = async () => {
            console.log("Starting cleanup process...");
    
            try {
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
                
                if (session.pooledContainer) {
                    const containerPool = getSharedContainerPool();
                    if (containerPool) {
                        try {
                            await containerPool.release(session.pooledContainer);
                        } catch (error) {
                            console.error("Error releasing container:", error);
                            try {
                                await containerPool.forceRelease(session.pooledContainer);
                            } catch (forceError) {
                                console.error("Error force releasing container:", forceError);
                            }
                        }
                    }
                }
                
                session.isRunning = false;
                session.pooledContainer = undefined;
                session.execStream = undefined;
                session.language = undefined;
                console.log("Session cleanup completed successfully");
            } catch (error) {
                console.error("Fatal error during cleanup:", error);
                session.isRunning = false;
                session.pooledContainer = undefined;
                session.execStream = undefined;
                session.language = undefined;
            }
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

                    const containerPool = getSharedContainerPool();
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
                        
                        sendMessage(`Acquired container for ${language}\n`, "system");

                        try {
                            await writeFileToContainerBase64(container, config.fileName, code);
                            console.log("File successfully written to container");
                        } catch (writeError) {
                            console.error("Error writing file to container:", writeError);
                            sendMessage(`Error writing file: ${writeError}`, "system");
                            await cleanup();
                            return;
                        }

                        // Verify file exists
                        const verifyExec = await container.exec({
                            Cmd: ["ls", "-la", "/tmp"],
                            AttachStdout: true,
                            AttachStderr: true,
                        });

                        const verifyStream = await verifyExec.start({});
                        let verifyOutput = "";

                        verifyStream.on("data", (chunk: Buffer) => {
                            verifyOutput += chunk.toString();
                        });

                        verifyStream.on("end", async () => {
                            if (!verifyOutput.includes(config.fileName)) {
                                sendMessage(`Error: ${config.fileName} not found in /tmp after upload`, "system");
                                await cleanup();
                                return;
                            }

                            await executeCode();
                        });

                        const executeCode = async () => {
                            try {
                                console.log("Running:", config.cmd.join(" "));
                                
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
                                    sendMessage("Execution timed out (5 minutes)", "system");
                                    await cleanup();
                                }, 300000);

                                session.execStream.on("end", async () => {
                                    sendMessage("Execution completed", "system");
                                    session.isRunning = false;
                                    // Don't cleanup here - let the user decide when to cleanup
                                });

                                session.execStream.on("error", async (err: Error) => {
                                    sendMessage(`Execution error: ${err.message}`, "system");
                                    await cleanup();
                                });

                                sendMessage("Code execution started", "system");
                                
                            } catch (error) {
                                console.error("Error executing code:", error);
                                sendMessage(`Execution setup error: ${error}`, "system");
                                await cleanup();
                            }
                        };

                    } catch (err: any) {
                        sendMessage(`Error: ${err.message}`, "system");
                        await cleanup();
                    }
                } else if (data.type === "input") {
                    if (session.execStream && session.isRunning) {
                        try {
                            session.execStream.write(data.message);
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
                    const containerPool = getSharedContainerPool();
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
            activeSessions.delete(session);
        });

        ws.on("error", async (error) => {
            console.error("WebSocket error:", error);
            await cleanup();
            activeSessions.delete(session);
        });
    });

    return wss;
};

export const getWebSocketPoolStats = (): Record<string, any> => {
    const containerPool = getSharedContainerPool();
    if (!containerPool) {
        return { error: "Container pool not initialized" };
    }
    
    return containerPool.getStats();
};

export const shutdownWebSocketPool = async (): Promise<void> => {
    // WebSocket server now uses shared pool, so no separate shutdown needed
    console.log("WebSocket server shutdown - using shared container pool");
};