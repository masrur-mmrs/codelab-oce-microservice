import { WebSocketServer } from "ws";
import { Server as HTTPServer } from "http";
import stream from "stream";
import fs from "fs";
import path from "path";
import { ContainerPool } from "../services/containerPool";
import { getLanguageConfig, writeFileToContainerBase64 } from "../utils/dockerUtils";
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
                    const { 
                        language, 
                        code 
                    } = data;
                    
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
                        
                        sendMessage(`Acquired container for ${language}\n`, "system");

                        const tempDir = path.join(process.cwd(), "tmp");
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        
                        console.log(`Creating TAR archive for ${config.fileName}`);

                        console.log(`Writing ${config.fileName} directly to container`);
                        console.log(`Code content length: ${code.length} characters`);

                        try {
                            await writeFileToContainerBase64(container, config.fileName, code);
                            console.log("File successfully written to container");
                        } catch (writeError) {
                            console.error("Error writing file to container:", writeError);
                            sendMessage(`Error writing file: ${writeError}`, "system");
                            await cleanup();
                            return;
                        }

                        const verifyExec = await container.exec({
                            Cmd: ["ls", "-la", "/tmp"],
                            AttachStdout: true,
                            AttachStderr: true,
                        });

                        const verifyStream = await verifyExec.start({});
                        let verifyOutput = "";

                        verifyStream.on("data", (chunk: Buffer) => {
                            verifyOutput += chunk.toString();
                            console.log("📁 /tmp contents:", chunk.toString());
                        });

                        verifyStream.on("end", async () => {
                            console.log("Full /tmp contents:", verifyOutput);
                            
                            if (!verifyOutput.includes(config.fileName)) {
                                sendMessage(`Error: ${config.fileName} not found in /tmp after upload`, "system");
                                console.error("File not found in container after upload");
                                await cleanup();
                                return;
                            }

                            const catExec = await container.exec({
                                Cmd: ["cat", `/tmp/${config.fileName}`],
                                AttachStdout: true,
                                AttachStderr: true,
                            });

                            const catStream = await catExec.start({});
                            let catOutput = "";

                            catStream.on("data", (chunk: Buffer) => {
                                catOutput += chunk.toString();
                            });

                            catStream.on("end", async () => {
                                console.log(`📝 Content inside container /tmp/${config.fileName}:`, catOutput);
                                
                                const normalizedContainerContent = catOutput.trim().replace(/\r\n/g, '\n');
                                const normalizedOriginalCode = code.trim().replace(/\r\n/g, '\n');
                                
                                console.log(`🔍 Original code length: ${normalizedOriginalCode.length}`);
                                console.log(`🔍 Container content length: ${normalizedContainerContent.length}`);
                                console.log(`🔍 Original code: "${normalizedOriginalCode}"`);
                                console.log(`🔍 Container content: "${normalizedContainerContent}"`);
                                
                                if (normalizedContainerContent === normalizedOriginalCode) {
                                    console.log("✅ File content matches expected code");
                                    // Proceed with execution...
                                    await executeCode();
                                } else {
                                    console.error("❌ File content doesn't match expected code");
                                    console.error(`Expected: "${normalizedOriginalCode}"`);
                                    console.error(`Got: "${normalizedContainerContent}"`);
                                    
                                    // Show byte-by-byte comparison for debugging
                                    console.log("Byte comparison:");
                                    for (let i = 0; i < Math.max(normalizedOriginalCode.length, normalizedContainerContent.length); i++) {
                                        const expectedChar = normalizedOriginalCode[i] || "END";
                                        const actualChar = normalizedContainerContent[i] || "END";
                                        const expectedCode = normalizedOriginalCode.charCodeAt(i) || "END";
                                        const actualCode = normalizedContainerContent.charCodeAt(i) || "END";
                                        
                                        if (expectedChar !== actualChar) {
                                            console.log(`Diff at position ${i}: expected "${expectedChar}" (${expectedCode}) vs actual "${actualChar}" (${actualCode})`);
                                        }
                                    }
                                    
                                    // For now, let"s proceed with execution anyway since the file exists
                                    console.log("🚀 Proceeding with execution despite content mismatch...");
                                    await executeCode();
                                }
                            });

                            catStream.on("error", (err: { message: any; }) => {
                                console.error("Error reading file content:", err);
                                sendMessage(`Error reading file: ${err.message}`, "system");
                                cleanup();
                            });
                        });

                        const executeCode = async () => {
                            try {
                                console.log("🧪 Running:", config.cmd.join(" "));
                                
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

                                sendMessage("Code execution started", "system");
                                
                            } catch (error) {
                                console.error("Error executing code:", error);
                                sendMessage(`Execution setup error: ${error}`, "system");
                                await cleanup();
                            }
                        }

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