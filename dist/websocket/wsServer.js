"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shutdownWebSocketPool = exports.getWebSocketPoolStats = exports.setupWebSocketServer = exports.initializeWebSocketPool = void 0;
const ws_1 = require("ws");
// import tar from "tar-stream";
const stream_1 = __importDefault(require("stream"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const containerPool_1 = require("../services/containerPool");
const dockerUtils_1 = require("../utils/dockerUtils");
const dockerode_1 = __importDefault(require("dockerode"));
const docker = new dockerode_1.default();
let containerPool = null;
const initializeWebSocketPool = () => __awaiter(void 0, void 0, void 0, function* () {
    if (containerPool) {
        return;
    }
    containerPool = new containerPool_1.ContainerPool(docker, {
        minSize: 3,
        maxSize: 15,
        maxAge: 45 * 60 * 1000,
        maxIdleTime: 15 * 60 * 1000,
    });
    yield containerPool.preloadImages();
    yield containerPool.initializePools();
});
exports.initializeWebSocketPool = initializeWebSocketPool;
const setupWebSocketServer = (server) => {
    const wss = new ws_1.WebSocketServer({ server });
    wss.on("connection", (ws) => __awaiter(void 0, void 0, void 0, function* () {
        console.log("New WebSocket client connected");
        const session = {
            isRunning: false
        };
        const sendMessage = (message, type = "system") => {
            try {
                ws.send(JSON.stringify({ type, message }));
            }
            catch (error) {
                console.error("Error sending message:", error);
            }
        };
        const cleanup = () => __awaiter(void 0, void 0, void 0, function* () {
            if (session.timeout) {
                clearTimeout(session.timeout);
            }
            if (session.execStream) {
                try {
                    session.execStream.destroy();
                }
                catch (error) {
                    console.error("Error destroying exec stream:", error);
                }
            }
            if (session.pooledContainer && containerPool) {
                try {
                    yield containerPool.release(session.pooledContainer);
                    console.log(`Released container for ${session.language} back to pool`);
                }
                catch (error) {
                    console.error("Error releasing container to pool:", error);
                }
            }
            session.isRunning = false;
            session.pooledContainer = undefined;
            session.execStream = undefined;
        });
        sendMessage("Welcome to the Codelabs code runner server!");
        ws.on("message", (raw) => __awaiter(void 0, void 0, void 0, function* () {
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
                    const config = (0, dockerUtils_1.getLanguageConfig)(language);
                    if (!config) {
                        sendMessage(`Unsupported language: ${language}`, "system");
                        return;
                    }
                    session.isRunning = true;
                    session.language = language;
                    // Updated section from wsServer.ts - around line 70-120
                    try {
                        session.pooledContainer = yield containerPool.acquire(language);
                        const { container } = session.pooledContainer;
                        sendMessage(`Acquired container for ${language}\n`, "system");
                        const tempDir = path_1.default.join(process.cwd(), "tmp");
                        if (!fs_1.default.existsSync(tempDir)) {
                            fs_1.default.mkdirSync(tempDir, { recursive: true });
                        }
                        // const tempFile = path.join(tempDir, `${config.fileName}`);
                        // fs.writeFileSync(tempFile, code);
                        // Create TAR archive with the code - using the fixed function
                        console.log(`Creating TAR archive for ${config.fileName}`);
                        // const pack = await createTarWithSingleFile(config.fileName, code);
                        // Write file directly to container instead of using TAR
                        console.log(`Writing ${config.fileName} directly to container`);
                        console.log(`Code content length: ${code.length} characters`);
                        try {
                            yield (0, dockerUtils_1.writeFileToContainerBase64)(container, config.fileName, code);
                            console.log("File successfully written to container");
                        }
                        catch (writeError) {
                            console.error("Error writing file to container:", writeError);
                            sendMessage(`Error writing file: ${writeError}`, "system");
                            yield cleanup();
                            return;
                        }
                        // Verify the file was uploaded correctly
                        const verifyExec = yield container.exec({
                            Cmd: ["ls", "-la", "/tmp"],
                            AttachStdout: true,
                            AttachStderr: true,
                        });
                        const verifyStream = yield verifyExec.start({});
                        let verifyOutput = "";
                        verifyStream.on("data", (chunk) => {
                            verifyOutput += chunk.toString();
                            console.log("📁 /tmp contents:", chunk.toString());
                        });
                        verifyStream.on("end", () => __awaiter(void 0, void 0, void 0, function* () {
                            console.log("Full /tmp contents:", verifyOutput);
                            if (!verifyOutput.includes(config.fileName)) {
                                sendMessage(`Error: ${config.fileName} not found in /tmp after upload`, "system");
                                console.error("File not found in container after upload");
                                yield cleanup();
                                return;
                            }
                            // Test file readability
                            const catExec = yield container.exec({
                                Cmd: ["cat", `/tmp/${config.fileName}`],
                                AttachStdout: true,
                                AttachStderr: true,
                            });
                            const catStream = yield catExec.start({});
                            let catOutput = "";
                            catStream.on("data", (chunk) => {
                                catOutput += chunk.toString();
                            });
                            // Replace the content verification section in wsServer.ts with this improved version:
                            catStream.on("end", () => __awaiter(void 0, void 0, void 0, function* () {
                                console.log(`📝 Content inside container /tmp/${config.fileName}:`, catOutput);
                                // Normalize both strings for comparison (trim whitespace and normalize line endings)
                                const normalizedContainerContent = catOutput.trim().replace(/\r\n/g, '\n');
                                const normalizedOriginalCode = code.trim().replace(/\r\n/g, '\n');
                                console.log(`🔍 Original code length: ${normalizedOriginalCode.length}`);
                                console.log(`🔍 Container content length: ${normalizedContainerContent.length}`);
                                console.log(`🔍 Original code: "${normalizedOriginalCode}"`);
                                console.log(`🔍 Container content: "${normalizedContainerContent}"`);
                                if (normalizedContainerContent === normalizedOriginalCode) {
                                    console.log("✅ File content matches expected code");
                                    // Proceed with execution...
                                    yield executeCode();
                                }
                                else {
                                    console.error("❌ File content doesn't match expected code");
                                    console.error(`Expected: "${normalizedOriginalCode}"`);
                                    console.error(`Got: "${normalizedContainerContent}"`);
                                    // Show byte-by-byte comparison for debugging
                                    console.log("Byte comparison:");
                                    for (let i = 0; i < Math.max(normalizedOriginalCode.length, normalizedContainerContent.length); i++) {
                                        const expectedChar = normalizedOriginalCode[i] || 'END';
                                        const actualChar = normalizedContainerContent[i] || 'END';
                                        const expectedCode = normalizedOriginalCode.charCodeAt(i) || 'END';
                                        const actualCode = normalizedContainerContent.charCodeAt(i) || 'END';
                                        if (expectedChar !== actualChar) {
                                            console.log(`Diff at position ${i}: expected '${expectedChar}' (${expectedCode}) vs actual '${actualChar}' (${actualCode})`);
                                        }
                                    }
                                    // For now, let's proceed with execution anyway since the file exists
                                    console.log("🚀 Proceeding with execution despite content mismatch...");
                                    yield executeCode();
                                }
                            }));
                            catStream.on("error", (err) => {
                                console.error("Error reading file content:", err);
                                sendMessage(`Error reading file: ${err.message}`, "system");
                                cleanup();
                            });
                        }));
                        // Function to execute the code after verification
                        function executeCode() {
                            return __awaiter(this, void 0, void 0, function* () {
                                try {
                                    console.log('🧪 Running:', config.cmd.join(' '));
                                    const runExec = yield container.exec({
                                        Cmd: config.cmd,
                                        AttachStdin: true,
                                        AttachStdout: true,
                                        AttachStderr: true,
                                        Tty: true,
                                        WorkingDir: "/tmp"
                                    });
                                    session.execStream = yield runExec.start({ hijack: true, stdin: true });
                                    session.pooledContainer.execStream = session.execStream;
                                    const stdout = new stream_1.default.Writable({
                                        write(chunk, _enc, cb) {
                                            sendMessage(chunk.toString(), "stdout");
                                            cb();
                                        },
                                    });
                                    const stderr = new stream_1.default.Writable({
                                        write(chunk, _enc, cb) {
                                            sendMessage(chunk.toString(), "stderr");
                                            cb();
                                        },
                                    });
                                    docker.modem.demuxStream(session.execStream, stdout, stderr);
                                    session.timeout = setTimeout(() => __awaiter(this, void 0, void 0, function* () {
                                        sendMessage("Execution timed out (30 seconds)", "system");
                                        yield cleanup();
                                    }), 30000);
                                    session.execStream.on("end", () => __awaiter(this, void 0, void 0, function* () {
                                        sendMessage("Execution completed", "system");
                                        yield cleanup();
                                    }));
                                    session.execStream.on("error", (err) => __awaiter(this, void 0, void 0, function* () {
                                        sendMessage(`Execution error: ${err.message}`, "system");
                                        yield cleanup();
                                    }));
                                    sendMessage("Code execution started", "system");
                                }
                                catch (error) {
                                    console.error("Error executing code:", error);
                                    sendMessage(`Execution setup error: ${error}`, "system");
                                    yield cleanup();
                                }
                            });
                        }
                    }
                    catch (err) {
                        sendMessage(`Error: ${err.message}`, "system");
                        yield cleanup();
                    }
                }
                else if (data.type === "input") {
                    if (session.execStream && session.isRunning) {
                        try {
                            session.execStream.write(data.message + "\n");
                        }
                        catch (error) {
                            sendMessage("Error sending input to container", "system");
                        }
                    }
                    else {
                        sendMessage("No active execution to send input to", "system");
                    }
                }
                else if (data.type === "stop") {
                    if (session.isRunning) {
                        sendMessage("Stopping execution...", "system");
                        yield cleanup();
                    }
                }
                else if (data.type === "stats") {
                    if (containerPool) {
                        const stats = containerPool.getStats();
                        sendMessage(JSON.stringify(stats, null, 2), "system");
                    }
                    else {
                        sendMessage("Container pool not initialized", "system");
                    }
                }
            }
            catch (err) {
                sendMessage(`Message parsing error: ${err.message}`, "system");
            }
        }));
        ws.on("close", () => __awaiter(void 0, void 0, void 0, function* () {
            console.log("WebSocket client disconnected");
            yield cleanup();
        }));
        ws.on("error", (error) => __awaiter(void 0, void 0, void 0, function* () {
            console.error("WebSocket error:", error);
            yield cleanup();
        }));
    }));
    return wss;
};
exports.setupWebSocketServer = setupWebSocketServer;
const getWebSocketPoolStats = () => {
    if (!containerPool) {
        return { error: "Container pool not initialized" };
    }
    return containerPool.getStats();
};
exports.getWebSocketPoolStats = getWebSocketPoolStats;
const shutdownWebSocketPool = () => __awaiter(void 0, void 0, void 0, function* () {
    if (containerPool) {
        yield containerPool.shutdown();
        containerPool = null;
    }
});
exports.shutdownWebSocketPool = shutdownWebSocketPool;
