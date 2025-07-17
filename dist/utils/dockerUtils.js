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
exports.writeFileToContainerBase64 = exports.writeFileToContainer = exports.createTarWithSingleFile = exports.optimizeDockerForProduction = exports.getSystemResources = exports.getLanguageConfig = exports.validateLanguage = exports.createSecureContainer = exports.isDockerRunning = exports.getDockerInfo = exports.cleanupOldContainers = exports.pullImage = exports.ensureImageExists = void 0;
exports.execInContainer = execInContainer;
const tar_stream_1 = __importDefault(require("tar-stream"));
const ensureImageExists = (docker, imageName) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield docker.getImage(imageName).inspect();
        console.log(`Image ${imageName} already exists`);
    }
    catch (error) {
        console.log(`Image ${imageName} not found. Pulling...`);
        yield (0, exports.pullImage)(docker, imageName);
    }
});
exports.ensureImageExists = ensureImageExists;
const pullImage = (docker, imageName) => __awaiter(void 0, void 0, void 0, function* () {
    return new Promise((resolve, reject) => {
        docker.pull(imageName, (err, stream) => {
            if (err) {
                console.error(`Failed to pull image ${imageName}:`, err);
                return reject(err);
            }
            const onFinished = (err) => {
                if (err) {
                    console.error(`Failed to pull image ${imageName}:`, err);
                    return reject(err);
                }
                console.log(`✅ Successfully pulled image ${imageName}`);
                resolve();
            };
            const onProgress = (event) => {
                if (event.status && event.progress) {
                    console.log(`Pulling ${imageName}: ${event.status} ${event.progress}`);
                }
                else if (event.status) {
                    console.log(`Pulling ${imageName}: ${event.status}`);
                }
            };
            docker.modem.followProgress(stream, onFinished, onProgress);
        });
    });
});
exports.pullImage = pullImage;
const cleanupOldContainers = (docker_1, ...args_1) => __awaiter(void 0, [docker_1, ...args_1], void 0, function* (docker, maxAge = 3600000) {
    try {
        const containers = yield docker.listContainers({ all: true });
        const now = Date.now();
        let cleanedCount = 0;
        for (const containerInfo of containers) {
            const container = docker.getContainer(containerInfo.Id);
            try {
                const inspect = yield container.inspect();
                const createdAt = new Date(inspect.Created).getTime();
                const age = now - createdAt;
                if (age > maxAge && containerInfo.Names.some(name => name.includes("codelabs"))) {
                    yield container.remove({ force: true });
                    cleanedCount++;
                    console.log(`Cleaned up old container: ${containerInfo.Id}`);
                }
            }
            catch (error) {
                console.warn(`Failed to inspect/cleanup container ${containerInfo.Id}:`, error);
            }
        }
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} old containers`);
        }
    }
    catch (error) {
        console.error("Error during container cleanup:", error);
    }
});
exports.cleanupOldContainers = cleanupOldContainers;
const getDockerInfo = (docker) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const info = yield docker.info();
        return {
            containers: info.Containers,
            containersPaused: info.ContainersPaused,
            containersRunning: info.ContainersRunning,
            containersStopped: info.ContainersStopped,
            images: info.Images,
            memTotal: info.MemTotal,
            cpus: info.NCPU,
            dockerVersion: info.ServerVersion,
            kernelVersion: info.KernelVersion,
            operatingSystem: info.OperatingSystem,
            architecture: info.Architecture,
        };
    }
    catch (error) {
        console.error("Failed to get Docker info:", error);
        throw error;
    }
});
exports.getDockerInfo = getDockerInfo;
const isDockerRunning = (docker) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield docker.ping();
        return true;
    }
    catch (error) {
        console.error("Docker is not running:", error);
        return false;
    }
});
exports.isDockerRunning = isDockerRunning;
const createSecureContainer = (docker_1, image_1, cmd_1, ...args_1) => __awaiter(void 0, [docker_1, image_1, cmd_1, ...args_1], void 0, function* (docker, image, cmd, workingDir = "/tmp") {
    return yield docker.createContainer({
        Image: image,
        Cmd: cmd,
        Tty: false,
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: workingDir,
        HostConfig: {
            AutoRemove: true,
            Memory: 512 * 1024 * 1024,
            CpuPeriod: 100000,
            CpuQuota: 50000,
            NetworkMode: "none",
            ReadonlyRootfs: false,
            Tmpfs: {
                "/tmp": "rw,noexec,nosuid,size=100m"
            },
            SecurityOpt: ["no-new-privileges"],
            CapDrop: ["ALL"],
            PidsLimit: 50,
            Ulimits: [
                { Name: "nofile", Soft: 1024, Hard: 1024 },
                { Name: "nproc", Soft: 50, Hard: 50 },
            ],
        },
        User: "nobody",
        Env: [
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "HOME=/tmp"
        ]
    });
});
exports.createSecureContainer = createSecureContainer;
const validateLanguage = (language) => {
    const supportedLanguages = [
        "python",
        "javascript",
        "c",
        "cpp",
        "java",
        "go",
        "rust"
    ];
    return supportedLanguages.includes(language.toLowerCase());
};
exports.validateLanguage = validateLanguage;
const getLanguageConfig = (language) => {
    const configs = {
        python: {
            image: "python:3.10-slim",
            fileName: "script.py",
            cmd: ["python3", "/tmp/script.py"],
            timeout: 30000,
            extensions: [".py"],
            description: "Python 3.10 with standard library"
        },
        javascript: {
            image: "node:18-slim",
            fileName: "script.js",
            cmd: ["node", "/tmp/script.js"],
            timeout: 30000,
            extensions: [".js"],
            description: "Node.js 18 with core modules"
        },
        c: {
            image: "gcc:latest",
            fileName: "main.c",
            cmd: ["/bin/sh", "-c", "gcc -std=c11 -Wall -Wextra -O2 /tmp/main.c -o /tmp/app && /tmp/app"],
            timeout: 45000,
            extensions: [".c"],
            description: "GCC with C11 standard"
        },
        cpp: {
            image: "gcc:latest",
            fileName: "main.cpp",
            cmd: ["/bin/sh", "-c", "g++ -std=c++17 -Wall -Wextra -O2 /tmp/main.cpp -o /tmp/app && /tmp/app"],
            timeout: 45000,
            extensions: [".cpp", ".cc", ".cxx"],
            description: "GCC with C++17 standard"
        },
        java: {
            image: "openjdk:11-slim",
            fileName: "Main.java",
            cmd: ["/bin/sh", "-c", "javac /tmp/Main.java && java -cp /tmp Main"],
            timeout: 45000,
            extensions: [".java"],
            description: "OpenJDK 11"
        },
        go: {
            image: "golang:1.19-alpine",
            fileName: "main.go",
            cmd: ["/bin/sh", "-c", "go run /tmp/main.go"],
            timeout: 45000,
            extensions: [".go"],
            description: "Go 1.19 with standard library"
        },
        rust: {
            image: "rust:latest",
            fileName: "main.rs",
            cmd: ["/bin/sh", "-c", "rustc -O /tmp/main.rs -o /tmp/app && /tmp/app"],
            timeout: 60000,
            extensions: [".rs"],
            description: "Rust with standard library"
        }
    };
    return configs[language.toLowerCase()];
};
exports.getLanguageConfig = getLanguageConfig;
const getSystemResources = (docker) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const info = yield docker.info();
        const containers = yield docker.listContainers({ all: true });
        return {
            memory: {
                total: info.MemTotal,
                available: info.MemTotal - (info.MemTotal * 0.1),
                used: info.MemTotal * 0.1,
            },
            cpu: {
                cores: info.NCPU,
                architecture: info.Architecture,
            },
            containers: {
                total: containers.length,
                running: containers.filter(c => c.State === "running").length,
                stopped: containers.filter(c => c.State === "exited").length,
            },
            disk: {
                images: info.Images,
                layersSize: info.LayersSize || 0,
            },
            docker: {
                version: info.ServerVersion,
                apiVersion: info.APIVersion,
            }
        };
    }
    catch (error) {
        console.error("Failed to get system resources:", error);
        throw error;
    }
});
exports.getSystemResources = getSystemResources;
const optimizeDockerForProduction = (docker) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        console.log("Optimizing Docker for production...");
        yield (0, exports.cleanupOldContainers)(docker);
        try {
            yield docker.pruneImages({
                filters: {
                    dangling: { false: true },
                    until: { "24h": true }
                }
            });
            console.log("Pruned unused images");
        }
        catch (error) {
            console.warn("Failed to prune images:", error);
        }
        try {
            yield docker.pruneVolumes();
            console.log("Pruned unused volumes");
        }
        catch (error) {
            console.warn("Failed to prune volumes:", error);
        }
        try {
            yield docker.pruneNetworks();
            console.log("Pruned unused networks");
        }
        catch (error) {
            console.warn("Failed to prune networks:", error);
        }
        console.log("Docker optimization complete");
    }
    catch (error) {
        console.error("Failed to optimize Docker:", error);
    }
});
exports.optimizeDockerForProduction = optimizeDockerForProduction;
function execInContainer(container, cmd, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const exec = yield container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true,
        });
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            try {
                const stream = yield exec.start({});
                let output = "";
                stream.on("data", (chunk) => {
                    output += chunk.toString("utf-8");
                    if (options === null || options === void 0 ? void 0 : options.logOutput) {
                        process.stdout.write(chunk.toString("utf-8"));
                    }
                });
                stream.on("end", () => __awaiter(this, void 0, void 0, function* () {
                    var _a;
                    try {
                        const inspect = yield exec.inspect();
                        resolve({ output, exitCode: (_a = inspect.ExitCode) !== null && _a !== void 0 ? _a : 1 });
                    }
                    catch (e) {
                        reject(e);
                    }
                }));
                stream.on("error", reject);
            }
            catch (err) {
                reject(err);
            }
        }));
    });
}
// Replace the existing createTarWithSingleFile functions with this fixed version:
const createTarWithSingleFile = (filename, content) => {
    return new Promise((resolve, reject) => {
        const pack = tar_stream_1.default.pack();
        const buffer = Buffer.from(content, "utf-8");
        // Add the file entry and wait for it to complete
        pack.entry({
            name: filename,
            size: buffer.length,
            mode: 0o644,
            type: "file",
        }, buffer, (err) => {
            if (err) {
                console.error("Error adding file to tar:", err);
                reject(err);
            }
            else {
                // Finalize the pack after the entry is written
                pack.finalize();
                resolve(pack);
            }
        });
    });
};
exports.createTarWithSingleFile = createTarWithSingleFile;
// Alternative approach: Write file directly using exec instead of TAR
// Add this function to dockerUtils.ts:
const writeFileToContainer = (container, filename, content) => __awaiter(void 0, void 0, void 0, function* () {
    // Escape the content for shell
    const escapedContent = content.replace(/'/g, "'\"'\"'");
    // Write file using echo command
    const writeCmd = [
        'sh', '-c',
        `echo '${escapedContent}' > /tmp/${filename}`
    ];
    console.log(`Writing ${filename} to container using exec`);
    const exec = yield container.exec({
        Cmd: writeCmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/tmp"
    });
    const stream = yield exec.start({});
    return new Promise((resolve, reject) => {
        let output = '';
        stream.on('data', (chunk) => {
            output += chunk.toString();
        });
        stream.on('end', () => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const info = yield exec.inspect();
                if (info.ExitCode === 0) {
                    console.log(`Successfully wrote ${filename} to container`);
                    resolve();
                }
                else {
                    console.error(`Failed to write ${filename}:`, output);
                    reject(new Error(`Failed to write file: ${output}`));
                }
            }
            catch (error) {
                reject(error);
            }
        }));
        stream.on('error', reject);
    });
});
exports.writeFileToContainer = writeFileToContainer;
// Alternative using base64 encoding for binary safety
const writeFileToContainerBase64 = (container, filename, content) => __awaiter(void 0, void 0, void 0, function* () {
    // Encode content as base64
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');
    console.log(`Original content: "${content}"`);
    console.log(`Base64 content: "${base64Content}"`);
    // Use printf instead of echo for better handling of special characters
    const writeCmd = [
        'sh', '-c',
        `printf '%s' '${base64Content}' | base64 -d > /tmp/${filename}`
    ];
    console.log(`Writing ${filename} to container using base64`);
    console.log(`Command: ${writeCmd.join(' ')}`);
    const exec = yield container.exec({
        Cmd: writeCmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/tmp"
    });
    const stream = yield exec.start({});
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk) => {
            const output = chunk.toString();
            if (output.includes('stderr')) {
                stderr += output;
            }
            else {
                stdout += output;
            }
        });
        stream.on('end', () => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const info = yield exec.inspect();
                console.log(`Write command exit code: ${info.ExitCode}`);
                if (stdout)
                    console.log(`Write stdout: ${stdout}`);
                if (stderr)
                    console.log(`Write stderr: ${stderr}`);
                if (info.ExitCode === 0) {
                    console.log(`Successfully wrote ${filename} to container`);
                    // Verify the file was written correctly
                    const verifyExec = yield container.exec({
                        Cmd: ['cat', `/tmp/${filename}`],
                        AttachStdout: true,
                        AttachStderr: true,
                    });
                    const verifyStream = yield verifyExec.start({});
                    let verifyOutput = '';
                    verifyStream.on('data', (chunk) => {
                        verifyOutput += chunk.toString();
                    });
                    verifyStream.on('end', () => {
                        console.log(`Verification read: "${verifyOutput}"`);
                        console.log(`Original content: "${content}"`);
                        console.log(`Content match: ${verifyOutput === content}`);
                        resolve();
                    });
                }
                else {
                    console.error(`Failed to write ${filename}:`, stderr || stdout);
                    reject(new Error(`Failed to write file: ${stderr || stdout}`));
                }
            }
            catch (error) {
                reject(error);
            }
        }));
        stream.on('error', reject);
    });
});
exports.writeFileToContainerBase64 = writeFileToContainerBase64;
