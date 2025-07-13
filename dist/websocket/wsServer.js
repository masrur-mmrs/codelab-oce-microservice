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
const stream_1 = __importDefault(require("stream"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const tar_fs_1 = __importDefault(require("tar-fs"));
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
                    try {
                        session.pooledContainer = yield containerPool.acquire(language);
                        const { container } = session.pooledContainer;
                        sendMessage(`Acquired container for ${language}`, "system");
                        const tempDir = path_1.default.join(process.cwd(), "tmp");
                        if (!fs_1.default.existsSync(tempDir)) {
                            fs_1.default.mkdirSync(tempDir, { recursive: true });
                        }
                        const tempFile = path_1.default.join(tempDir, `${Date.now()}_${config.fileName}`);
                        fs_1.default.writeFileSync(tempFile, code);
                        const tarStream = new stream_1.default.PassThrough();
                        const archive = tar_fs_1.default.pack(path_1.default.dirname(tempFile), {
                            entries: [path_1.default.basename(tempFile)],
                            map: (header) => {
                                header.name = config.fileName;
                                return header;
                            },
                        });
                        archive.pipe(tarStream);
                        yield container.putArchive(tarStream, { path: "/tmp" });
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
                        session.timeout = setTimeout(() => __awaiter(void 0, void 0, void 0, function* () {
                            sendMessage("Execution timed out (30 seconds)", "system");
                            yield cleanup();
                        }), 30000);
                        session.execStream.on("end", () => __awaiter(void 0, void 0, void 0, function* () {
                            sendMessage("Execution completed", "system");
                            yield cleanup();
                        }));
                        session.execStream.on("error", (err) => __awaiter(void 0, void 0, void 0, function* () {
                            sendMessage(`Execution error: ${err.message}`, "system");
                            yield cleanup();
                        }));
                        try {
                            fs_1.default.unlinkSync(tempFile);
                        }
                        catch (error) {
                            console.warn("Failed to cleanup temp file:", error);
                        }
                        sendMessage("Code execution started", "system");
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
