import Docker from "dockerode";
import { EventEmitter } from "events";
import { getLanguageConfig, ensureImageExists, execInContainer } from "../utils/dockerUtils";

interface PooledContainer {
    container: Docker.Container;
    language: string;
    createdAt: number;
    lastUsed: number;
    inUse: boolean;
    execStream?: any;
}

interface PoolConfig {
    minSize: number;
    maxSize: number;
    maxAge: number;
    maxIdleTime: number;
}

interface ExtendedContainerCreateOptions extends Docker.ContainerCreateOptions {
    Platform?: string;
}

export class ContainerPool extends EventEmitter {
    private docker: Docker;
    private pools: Map<string, PooledContainer[]> = new Map();
    private config: PoolConfig;
    private cleanupInterval: NodeJS.Timeout;
    private preloadedImages: Set<string> = new Set();

    constructor(
        docker: Docker,
        config: PoolConfig = {
            minSize: 2,
            maxSize: 10,
            maxAge: 30 * 60 * 1000,
            maxIdleTime: 10 * 60 * 1000,
        }
    ) {
        super();
        this.docker = docker;
        this.config = config;
        
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 60000);
    }

    public async getPools(): Promise<Map<string, PooledContainer[]>> {
        return this.pools;
    }

    public async forceRelease(pooledContainer: any): Promise<void> {
        try {
            const language = pooledContainer.language;
            const pool = this.pools.get(language);
            
            if (!pool) {
                console.error(`No pool found for language: ${language}`);
                return;
            }
            
            const containerIndex = pool.findIndex(
                (pc: any) => pc.container.id === pooledContainer.container.id && !pc.inUse
            );
            
            if (containerIndex !== -1) {
                pool[containerIndex].inUse = false;
                pool[containerIndex].lastUsed = Date.now();
                console.log(`Container already in available pool, marked as free`);
                return;
            }
            
            const inUseIndex = pool.findIndex(
                (pc: any) => pc.container.id === pooledContainer.container.id && pc.inUse
            );
            
            if (inUseIndex !== -1) {
                pool[inUseIndex].inUse = false;
                pool[inUseIndex].lastUsed = Date.now();
                console.log(`Moved container from inUse to available pool`);
                return;
            }
            
            console.error(`Container not found in any pool, it may be leaked`);
            
            try {
                await pooledContainer.container.stop({ t: 1 });
                await pooledContainer.container.remove({ force: true });
                console.log(`Removed leaked container`);
            } catch (removeError) {
                console.error(`Failed to remove leaked container:`, removeError);
            }
            
        } catch (error) {
            console.error(`Force release failed:`, error);
            throw error;
        }
    }

    async preloadImages(): Promise<void> {
        const supportedLanguages = ["python", "javascript", "c", "cpp", "java", "go", "rust"];
        
        console.log("Pre-loading Docker images...");
        
        const promises = supportedLanguages.map(async (language) => {
            try {
                const config = getLanguageConfig(language);
                if (config) {
                    await ensureImageExists(this.docker, config.image);
                    this.preloadedImages.add(config.image);
                    console.log(`Image ${config.image} preloaded for ${language}`);
                }
            } catch (error) {
                console.error(`Failed to preload image for ${language}:`, error);
            }
        });

        await Promise.all(promises);
        console.log("All Docker images preloaded successfully!");
    }

    async initializePools(): Promise<void> {
        const supportedLanguages = ["python", "javascript", "c", "cpp", "java", "go", "rust"];
        
        console.log("Initializing container pools...");
        
        for (const language of supportedLanguages) {
            try {
                await this.warmUpPool(language);
                console.log(`Pool initialized for ${language}`);
            } catch (error) {
                console.error(`Failed to initialize pool for ${language}:`, error);
            }
        }
        
        console.log("All container pools initialized!");
    }

    private async warmUpPool(language: string): Promise<void> {
        const pool = this.pools.get(language) || [];
        
        while (pool.length < this.config.minSize) {
            try {
                const container = await this.createContainer(language);
                pool.push(container);
            } catch (error) {
                console.error(`Failed to warm up pool for ${language}:`, error);
                break;
            }
        }
        
        this.pools.set(language, pool);
    }

    private async createContainer(language: string): Promise<PooledContainer> {
        const config = getLanguageConfig(language);
        if (!config) {
            throw new Error(`Unsupported language: ${language}`);
        }

        let envVars = [
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "HOME=/tmp"
        ];

        if (language === 'rust') {
            envVars = [
                "PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
                "CARGO_HOME=/usr/local/cargo",
                "RUSTUP_HOME=/usr/local/rustup",
                "HOME=/tmp"
            ];
        } else if (language === 'go') {
            envVars = [
                "PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
                "GOPATH=/tmp/go",
                "GOCACHE=/tmp/.cache/go-build",
                "HOME=/tmp"
            ];
        }

        const options: ExtendedContainerCreateOptions = {
            Image: config.image,
            Platform: "linux/amd64",
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
                SecurityOpt: ["no-new-privileges"],
                CapDrop: ["ALL"],
                PidsLimit: 256, // 256 PIDs limit for Go compatibility
            },
            User: "root",
            Env: envVars
        };

        const container = await this.docker.createContainer(options);

        await container.start();

        if (language === "rust") {
            try {
                const { output, exitCode } = await execInContainer(container, ["rustc", "--version"]);
                if (exitCode === 0) {
                    console.log(`Rust version in container: ${output.trim()}`);
                } else {
                    console.error(`Rust not available in container. Exit code: ${exitCode}`);
                }
            } catch (error) {
                console.error(`Failed to check Rust version:`, error);
                try {
                    const { output: pathOutput } = await execInContainer(container, 
                        ["/bin/bash", "-c", "export PATH=/usr/local/cargo/bin:$PATH && rustc --version"]
                    );
                    console.log(`Rust version (with PATH): ${pathOutput.trim()}`);
                } catch (pathError) {
                    console.error(`Rust still not found with explicit PATH:`, pathError);
                }
            }
        }

        const now = Date.now();
        return {
            container,
            language,
            createdAt: now,
            lastUsed: now,
            inUse: false,
        };
    }

    async acquire(language: string): Promise<PooledContainer> {
        const pool = this.pools.get(language) || [];
        
        let available = pool.find(c => !c.inUse);
        
        if (!available) {
            if (pool.length < this.config.maxSize) {
                available = await this.createContainer(language);
                pool.push(available);
                this.pools.set(language, pool);
            } else {
                throw new Error(`Container pool exhausted for ${language}`);
            }
        }

        available.inUse = true;
        available.lastUsed = Date.now();

        try {
            const containerInfo = await available.container.inspect();
            if (!containerInfo.State.Running) {
                await available.container.start();
            }
        } catch (error) {
            console.warn(`Container inspection/start failed, creating new one:`, error);
            available = await this.createContainer(language);
            available.inUse = true;
            available.lastUsed = Date.now();
            
            const index = pool.findIndex(c => c === available);
            if (index !== -1) {
                pool[index] = available;
            } else {
                pool.push(available);
            }
            this.pools.set(language, pool);
        }

        return available;
    }

    async release(pooledContainer: PooledContainer): Promise<void> {
        pooledContainer.inUse = false;
        pooledContainer.lastUsed = Date.now();
        
        if (pooledContainer.execStream) {
            try {
                pooledContainer.execStream.destroy();
            } catch (error) {
                console.warn("Failed to destroy exec stream:", error);
            }
            pooledContainer.execStream = undefined;
        }

        try {
            const resetExec = await pooledContainer.container.exec({
                Cmd: ["/bin/sh", "-c", "cd /tmp && rm -rf * && exit"],
                AttachStdout: true,
                AttachStderr: true,
            });
            
            const resetStream = await resetExec.start({});
            await new Promise<void>((resolve) => {
                resetStream.on("end", resolve);
                resetStream.on("error", resolve);
                setTimeout(resolve, 5000);
            });
        } catch (error) {
            console.warn("Failed to reset container state:", error);
        }
    }

    private async cleanup(): Promise<void> {
        const now = Date.now();
        
        for (const [language, pool] of this.pools.entries()) {
            const toRemove: number[] = [];
            
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
                    await this.destroyContainer(container);
                    pool.splice(index, 1);
                    console.log(`Cleaned up container for ${language}`);
                } catch (error) {
                    console.error(`Failed to cleanup container for ${language}:`, error);
                }
            }
            
            if (pool.length < this.config.minSize) {
                await this.warmUpPool(language);
            }
        }
    }

    private async destroyContainer(pooledContainer: PooledContainer): Promise<void> {
        if (pooledContainer.execStream) {
            try {
                pooledContainer.execStream.destroy();
            } catch (error) {
                console.warn("Failed to destroy exec stream:", error);
            }
        }
        
        try {
            await pooledContainer.container.stop({ t: 5 });
        } catch (error) {
            console.warn("Failed to stop container (might already be stopped):", error);
        }
        
        try {
            await pooledContainer.container.remove({ force: true });
        } catch (error) {
            console.warn("Failed to remove container:", error);
        }
    }

    getStats(): Record<string, any> {
        const stats: Record<string, any> = {};
        
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
            config: this.config
        };
    }

    async shutdown(): Promise<void> {
        console.log("Shutting down container pool...");
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        for (const [language, pool] of this.pools.entries()) {
            for (const container of pool) {
                try {
                    await this.destroyContainer(container);
                } catch (error) {
                    console.error(`Failed to destroy container for ${language}:`, error);
                }
            }
        }
        
        this.pools.clear();
        console.log("Container pool shut down complete");
    }
}