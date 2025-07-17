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
exports.createInteractiveContainer = exports.runCodeInDocker = exports.shutdownContainerPool = exports.getPoolStats = exports.initializeContainerPool = void 0;
const dockerode_1 = __importDefault(require("dockerode"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
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
        if (!fs_1.default.existsSync(filePath)) {
            console.error("[ERROR] Code file not found:", filePath);
            throw new Error(`Code file not found: ${filePath}`);
        }
        const fileContent = fs_1.default.readFileSync(filePath, 'utf8');
        // const archive = createTarWithSingleFile(config.fileName, fileContent);
        console.log("[DEBUG] filePath:", filePath);
        console.log("[DEBUG] filename:", config.fileName);
        console.log("[DEBUG] content length:", fileContent.length);
        // await container.putArchive(archive, { path: "/tmp" });
        yield (0, dockerUtils_1.writeFileToContainerBase64)(container, config.fileName, fileContent);
        console.log("[DEBUG] Archive uploaded successfully");
        const catExec = yield container.exec({
            Cmd: ["cat", `/tmp/${config.fileName}`],
            AttachStdout: true,
            AttachStderr: true,
        });
        const catStream = yield catExec.start({});
        catStream.on("data", (chunk) => {
            console.log(`📝 Content inside container /tmp/${config.fileName}:`, chunk.toString());
        });
        yield (0, dockerUtils_1.execInContainer)(container, ["touch", "/tmp/hello.txt"]);
        yield (0, dockerUtils_1.execInContainer)(container, ["ls", "-lh", "/tmp"]);
        // Verify file exists
        const { output: lsOutput } = yield (0, dockerUtils_1.execInContainer)(container, ["ls", "-lh", "/tmp"]);
        console.log("[DEBUG] /tmp contents:", lsOutput);
        if (!lsOutput.includes(config.fileName)) {
            throw new Error(`File ${config.fileName} not found in container after upload`);
        }
        console.log('🧪 Running:', config.cmd.join(' '));
        yield (0, dockerUtils_1.execInContainer)(container, ["ls", "-lh", "/tmp"]);
        const debugExec = yield container.exec({
            Cmd: ['ls', '-l', '/tmp'],
            AttachStdout: true,
            AttachStderr: true
        });
        const debugStream = yield debugExec.start();
        debugStream.on('data', (chunk) => {
            console.log('[/tmp contents]', chunk.toString());
        });
        console.log('🧪 Running:', config.cmd.join(' '));
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
    const tempFile = path_1.default.join(tempDir, `${config.fileName}`);
    // fs.writeFileSync(tempFile, code);
    if (!fs_1.default.existsSync(tempFile)) {
        throw new Error(`Code file not found: ${tempFile}`);
    }
    // const archive = await createTarWithSingleFile(config.fileName, code);
    // archive.pipe(tarStream);
    console.log("[DEBUG] Putting archive to /tmp");
    // await container.putArchive(archive, { path: "/tmp" });
    yield (0, dockerUtils_1.writeFileToContainerBase64)(container, config.fileName, code);
    console.log("[DEBUG] Archive put complete");
    // Verify file exists
    const { output: lsOutput } = yield (0, dockerUtils_1.execInContainer)(container, ["ls", "-l", "/tmp"]);
    console.log('[DEBUG] /tmp contents:', lsOutput);
    if (!lsOutput.includes(config.fileName)) {
        throw new Error(`File ${config.fileName} not found in container after upload`);
    }
    const debugExec = yield container.exec({
        Cmd: ['ls', '-l', '/tmp'],
        AttachStdout: true,
        AttachStderr: true
    });
    const debugStream = yield debugExec.start({});
    debugStream.on('data', (chunk) => {
        console.log('[/tmp contents]', chunk.toString());
    });
    console.log('🧪 Running:', config.cmd.join(' '));
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
