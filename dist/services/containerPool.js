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
exports.ContainerPool = void 0;
const events_1 = require("events");
const dockerUtils_1 = require("../utils/dockerUtils");
class ContainerPool extends events_1.EventEmitter {
    constructor(docker, config = {
        minSize: 2,
        maxSize: 10,
        maxAge: 30 * 60 * 1000,
        maxIdleTime: 10 * 60 * 1000,
    }) {
        super();
        this.pools = new Map();
        this.preloadedImages = new Set();
        this.docker = docker;
        this.config = config;
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 60000);
    }
    preloadImages() {
        return __awaiter(this, void 0, void 0, function* () {
            const supportedLanguages = ["python", "javascript", "c", "cpp", "java", "go", "rust"];
            console.log("Pre-loading Docker images...");
            const promises = supportedLanguages.map((language) => __awaiter(this, void 0, void 0, function* () {
                try {
                    const config = (0, dockerUtils_1.getLanguageConfig)(language);
                    if (config) {
                        yield (0, dockerUtils_1.ensureImageExists)(this.docker, config.image);
                        this.preloadedImages.add(config.image);
                        console.log(`✅ Image ${config.image} preloaded for ${language}`);
                    }
                }
                catch (error) {
                    console.error(`Failed to preload image for ${language}:`, error);
                }
            }));
            yield Promise.all(promises);
            console.log("All Docker images preloaded successfully!");
        });
    }
    initializePools() {
        return __awaiter(this, void 0, void 0, function* () {
            const supportedLanguages = ["python", "javascript", "c", "cpp", "java", "go", "rust"];
            console.log("Initializing container pools...");
            for (const language of supportedLanguages) {
                try {
                    yield this.warmUpPool(language);
                    console.log(`Pool initialized for ${language}`);
                }
                catch (error) {
                    console.error(`Failed to initialize pool for ${language}:`, error);
                }
            }
            console.log("All container pools initialized!");
        });
    }
    warmUpPool(language) {
        return __awaiter(this, void 0, void 0, function* () {
            const pool = this.pools.get(language) || [];
            while (pool.length < this.config.minSize) {
                try {
                    const container = yield this.createContainer(language);
                    pool.push(container);
                }
                catch (error) {
                    console.error(`Failed to warm up pool for ${language}:`, error);
                    break;
                }
            }
            this.pools.set(language, pool);
        });
    }
    createContainer(language) {
        return __awaiter(this, void 0, void 0, function* () {
            const config = (0, dockerUtils_1.getLanguageConfig)(language);
            if (!config) {
                throw new Error(`Unsupported language: ${language}`);
            }
            const container = yield this.docker.createContainer({
                Image: config.image,
                Cmd: ["/bin/sh"],
                Tty: true,
                OpenStdin: true,
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                WorkingDir: "/tmp",
                HostConfig: {
                    AutoRemove: false,
                    Memory: 1024 * 1024 * 1024,
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
                },
                User: "nobody",
                Env: [
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=/tmp"
                ]
            });
            const now = Date.now();
            return {
                container,
                language,
                createdAt: now,
                lastUsed: now,
                inUse: false,
            };
        });
    }
    acquire(language) {
        return __awaiter(this, void 0, void 0, function* () {
            const pool = this.pools.get(language) || [];
            let available = pool.find(c => !c.inUse);
            if (!available) {
                if (pool.length < this.config.maxSize) {
                    available = yield this.createContainer(language);
                    pool.push(available);
                    this.pools.set(language, pool);
                }
                else {
                    throw new Error(`Container pool exhausted for ${language}`);
                }
            }
            available.inUse = true;
            available.lastUsed = Date.now();
            try {
                const containerInfo = yield available.container.inspect();
                if (!containerInfo.State.Running) {
                    yield available.container.start();
                }
            }
            catch (error) {
                available = yield this.createContainer(language);
                available.inUse = true;
                available.lastUsed = Date.now();
                const index = pool.findIndex(c => c === available);
                if (index !== -1) {
                    pool[index] = available;
                }
                else {
                    pool.push(available);
                }
                this.pools.set(language, pool);
                yield available.container.start();
            }
            return available;
        });
    }
    release(pooledContainer) {
        return __awaiter(this, void 0, void 0, function* () {
            pooledContainer.inUse = false;
            pooledContainer.lastUsed = Date.now();
            if (pooledContainer.execStream) {
                try {
                    pooledContainer.execStream.destroy();
                }
                catch (error) {
                    console.warn("Failed to destroy exec stream:", error);
                }
                pooledContainer.execStream = undefined;
            }
            try {
                const resetExec = yield pooledContainer.container.exec({
                    Cmd: ["/bin/sh", "-c", "cd /tmp && rm -rf * && exit"],
                    AttachStdout: true,
                    AttachStderr: true,
                });
                const resetStream = yield resetExec.start({});
                yield new Promise((resolve) => {
                    resetStream.on("end", resolve);
                    resetStream.on("error", resolve);
                });
            }
            catch (error) {
                console.warn("Failed to reset container state:", error);
            }
        });
    }
    cleanup() {
        return __awaiter(this, void 0, void 0, function* () {
            const now = Date.now();
            for (const [language, pool] of this.pools.entries()) {
                const toRemove = [];
                for (let i = 0; i < pool.length; i++) {
                    const container = pool[i];
                    const age = now - container.createdAt;
                    const idleTime = now - container.lastUsed;
                    if (!container.inUse &&
                        (age > this.config.maxAge || idleTime > this.config.maxIdleTime) &&
                        pool.length > this.config.minSize) {
                        toRemove.push(i);
                    }
                }
                for (let i = toRemove.length - 1; i >= 0; i--) {
                    const index = toRemove[i];
                    const container = pool[index];
                    try {
                        yield this.destroyContainer(container);
                        pool.splice(index, 1);
                        console.log(`🗑️ Cleaned up container for ${language}`);
                    }
                    catch (error) {
                        console.error(`Failed to cleanup container for ${language}:`, error);
                    }
                }
                if (pool.length < this.config.minSize) {
                    yield this.warmUpPool(language);
                }
            }
        });
    }
    destroyContainer(pooledContainer) {
        return __awaiter(this, void 0, void 0, function* () {
            if (pooledContainer.execStream) {
                try {
                    pooledContainer.execStream.destroy();
                }
                catch (error) {
                    console.warn("Failed to destroy exec stream:", error);
                }
            }
            try {
                yield pooledContainer.container.stop();
            }
            catch (error) {
                // Container might already be stopped
                console.warn("Failed to stop container:", error);
            }
            try {
                yield pooledContainer.container.remove();
            }
            catch (error) {
                console.warn("Failed to remove container:", error);
            }
        });
    }
    getStats() {
        const stats = {};
        for (const [language, pool] of this.pools.entries()) {
            stats[language] = {
                total: pool.length,
                inUse: pool.filter(c => c.inUse).length,
                available: pool.filter(c => !c.inUse).length,
            };
        }
        return {
            pools: stats,
            preloadedImages: Array.from(this.preloadedImages),
        };
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("Shutting down container pool...");
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }
            for (const [language, pool] of this.pools.entries()) {
                for (const container of pool) {
                    try {
                        yield this.destroyContainer(container);
                    }
                    catch (error) {
                        console.error(`Failed to destroy container for ${language}:`, error);
                    }
                }
            }
            this.pools.clear();
            console.log("Container pool shut down complete");
        });
    }
}
exports.ContainerPool = ContainerPool;
