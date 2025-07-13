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
Object.defineProperty(exports, "__esModule", { value: true });
exports.optimizeDockerForProduction = exports.getSystemResources = exports.getLanguageConfig = exports.validateLanguage = exports.createSecureContainer = exports.isDockerRunning = exports.getDockerInfo = exports.cleanupOldContainers = exports.pullImage = exports.ensureImageExists = void 0;
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
            ReadonlyRootfs: true,
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
            cmd: ["python3", "script.py"],
            timeout: 30000,
            extensions: [".py"],
            description: "Python 3.10 with standard library"
        },
        javascript: {
            image: "node:18-slim",
            fileName: "script.js",
            cmd: ["node", "script.js"],
            timeout: 30000,
            extensions: [".js"],
            description: "Node.js 18 with core modules"
        },
        c: {
            image: "gcc:latest",
            fileName: "main.c",
            cmd: ["/bin/sh", "-c", "gcc -std=c11 -Wall -Wextra -O2 main.c -o app && ./app"],
            timeout: 45000,
            extensions: [".c"],
            description: "GCC with C11 standard"
        },
        cpp: {
            image: "gcc:latest",
            fileName: "main.cpp",
            cmd: ["/bin/sh", "-c", "g++ -std=c++17 -Wall -Wextra -O2 main.cpp -o app && ./app"],
            timeout: 45000,
            extensions: [".cpp", ".cc", ".cxx"],
            description: "GCC with C++17 standard"
        },
        java: {
            image: "openjdk:11-slim",
            fileName: "Main.java",
            cmd: ["/bin/sh", "-c", "javac Main.java && java Main"],
            timeout: 45000,
            extensions: [".java"],
            description: "OpenJDK 11"
        },
        go: {
            image: "golang:1.19-alpine",
            fileName: "main.go",
            cmd: ["/bin/sh", "-c", "go run main.go"],
            timeout: 45000,
            extensions: [".go"],
            description: "Go 1.19 with standard library"
        },
        rust: {
            image: "rust:latest",
            fileName: "main.rs",
            cmd: ["/bin/sh", "-c", "rustc -O main.rs -o app && ./app"],
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
