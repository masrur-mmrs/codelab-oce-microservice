"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.createInteractiveContainer = exports.runCodeInDocker = exports.shutdownContainerPool = exports.getPoolStats = exports.initializeContainerPool = void 0;
const dockerode_1 = __importDefault(require("dockerode"));
const path_1 = __importDefault(require("path"));
const stream_1 = __importStar(require("stream"));
const fs_1 = __importDefault(require("fs"));
const containerPool_1 = require("./containerPool");
const dockerUtils_1 = require("../utils/dockerUtils");
const docker = new dockerode_1.default();
let containerPool = null;
const initializeContainerPool = () => __awaiter(void 0, void 0, void 0, function* () {
    if (containerPool) {
        return;
    }
    console.log("Initializing container pool system...");
    containerPool = new containerPool_1.ContainerPool(docker, {
        minSize: 2,
        maxSize: 10,
        maxAge: 30 * 60 * 1000, // 30 minutes
        maxIdleTime: 10 * 60 * 1000, // 10 minutes
    });
    yield containerPool.preloadImages();
    yield containerPool.initializePools();
    console.log("Container pool system initialized successfully!");
});
exports.initializeContainerPool = initializeContainerPool;
const getPoolStats = () => {
    if (!containerPool) {
        return { error: "Container pool not initialized" };
    }
    return containerPool.getStats();
};
exports.getPoolStats = getPoolStats;
const shutdownContainerPool = () => __awaiter(void 0, void 0, void 0, function* () {
    if (containerPool) {
        yield containerPool.shutdown();
        containerPool = null;
    }
});
exports.shutdownContainerPool = shutdownContainerPool;
const runCodeInDocker = (filePath_1, input_1, language_1, ...args_1) => __awaiter(void 0, [filePath_1, input_1, language_1, ...args_1], void 0, function* (filePath, input, language, timeoutMs = 30000) {
    if (!containerPool) {
        throw new Error("Container pool not initialized. Call initializeContainerPool() first.");
    }
    const startTime = Date.now();
    const config = (0, dockerUtils_1.getLanguageConfig)(language);
    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }
    let pooledContainer = null;
    try {
        pooledContainer = yield containerPool.acquire(language);
        const { container } = pooledContainer;
        const tarStream = new stream_1.default.PassThrough();
        const fileName = path_1.default.basename(filePath);
        const archive = require("tar-fs").pack(path_1.default.dirname(filePath), {
            entries: [fileName],
            map: (header) => {
                header.name = config.fileName;
                return header;
            },
        });
        archive.pipe(tarStream);
        yield container.putArchive(tarStream, { path: "/tmp" });
        const exec = yield container.exec({
            Cmd: config.cmd,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: "/tmp"
        });
        const execStream = yield exec.start({ hijack: true, stdin: true });
        pooledContainer.execStream = execStream;
        return new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            let isResolved = false;
            const stdoutStream = new stream_1.Writable({
                write(chunk, _encoding, callback) {
                    stdout += chunk.toString();
                    callback();
                },
            });
            const stderrStream = new stream_1.Writable({
                write(chunk, _encoding, callback) {
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
            execStream.on("end", () => __awaiter(void 0, void 0, void 0, function* () {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    try {
                        const execInfo = yield exec.inspect();
                        const executionTime = Date.now() - startTime;
                        resolve({
                            stdout: stdout.trim(),
                            stderr: stderr.trim(),
                            success: execInfo.ExitCode === 0,
                            executionTime
                        });
                    }
                    catch (error) {
                        reject(error);
                    }
                }
            }));
            execStream.on("error", (err) => {
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
    }
    catch (error) {
        throw error;
    }
    finally {
        if (pooledContainer && containerPool) {
            try {
                yield containerPool.release(pooledContainer);
            }
            catch (error) {
                console.error("Failed to release container to pool:", error);
            }
        }
    }
});
exports.runCodeInDocker = runCodeInDocker;
const createInteractiveContainer = (code, language) => __awaiter(void 0, void 0, void 0, function* () {
    if (!containerPool) {
        throw new Error("Container pool not initialized. Call initializeContainerPool() first.");
    }
    const config = (0, dockerUtils_1.getLanguageConfig)(language);
    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }
    const pooledContainer = yield containerPool.acquire(language);
    const { container } = pooledContainer;
    const tempDir = path_1.default.join(process.cwd(), "tmp");
    if (!fs_1.default.existsSync(tempDir)) {
        fs_1.default.mkdirSync(tempDir, { recursive: true });
    }
    const tempFile = path_1.default.join(tempDir, `${Date.now()}_${config.fileName}`);
    fs_1.default.writeFileSync(tempFile, code);
    const tarStream = new stream_1.default.PassThrough();
    const archive = require("tar-fs").pack(path_1.default.dirname(tempFile), {
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
    const execStream = yield runExec.start({ hijack: true, stdin: true });
    pooledContainer.execStream = execStream;
    const cleanup = () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            fs_1.default.unlinkSync(tempFile);
        }
        catch (error) {
            console.warn("Failed to cleanup temp file:", error);
        }
        if (execStream) {
            try {
                execStream.destroy();
            }
            catch (error) {
                console.warn("Failed to destroy exec stream:", error);
            }
        }
        if (containerPool) {
            try {
                yield containerPool.release(pooledContainer);
            }
            catch (error) {
                console.error("Failed to release container to pool:", error);
            }
        }
    });
    return { container, execStream, cleanup };
});
exports.createInteractiveContainer = createInteractiveContainer;
