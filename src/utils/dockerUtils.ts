import Docker from "dockerode";
import tar from "tar-stream";
import { Readable } from "stream";

export const ensureImageExists = async (docker: Docker, imageName: string): Promise<void> => {
    try {
        await docker.getImage(imageName).inspect();
        console.log(`Image ${imageName} already exists`);
    } catch (error) {
        console.log(`Image ${imageName} not found. Pulling...`);
        await pullImage(docker, imageName);
    }
};

export const pullImage = async (docker: Docker, imageName: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        docker.pull(imageName, (err: any, stream: NodeJS.ReadableStream) => {
            if (err) {
                console.error(`Failed to pull image ${imageName}:`, err);
                return reject(err);
            }

            const onFinished = (err: any) => {
                if (err) {
                    console.error(`Failed to pull image ${imageName}:`, err);
                    return reject(err);
                }
                console.log(`✅ Successfully pulled image ${imageName}`);
                resolve();
            };

            const onProgress = (event: any) => {
                if (event.status && event.progress) {
                    console.log(`Pulling ${imageName}: ${event.status} ${event.progress}`);
                } else if (event.status) {
                    console.log(`Pulling ${imageName}: ${event.status}`);
                }
            };

            docker.modem.followProgress(stream, onFinished, onProgress);
        });
    });
};

export const cleanupOldContainers = async (docker: Docker, maxAge: number = 3600000): Promise<void> => {
    try {
        const containers = await docker.listContainers({ all: true });
        const now = Date.now();
        let cleanedCount = 0;

        for (const containerInfo of containers) {
            const container = docker.getContainer(containerInfo.Id);
            
            try {
                const inspect = await container.inspect();
                const createdAt = new Date(inspect.Created).getTime();
                const age = now - createdAt;

                if (age > maxAge && containerInfo.Names.some(name => name.includes("codelabs"))) {
                    await container.remove({ force: true });
                    cleanedCount++;
                    console.log(`Cleaned up old container: ${containerInfo.Id}`);
                }
            } catch (error) {
                console.warn(`Failed to inspect/cleanup container ${containerInfo.Id}:`, error);
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} old containers`);
        }
    } catch (error) {
        console.error("Error during container cleanup:", error);
    }
};

export const getDockerInfo = async (docker: Docker): Promise<any> => {
    try {
        const info = await docker.info();
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
    } catch (error) {
        console.error("Failed to get Docker info:", error);
        throw error;
    }
};

export const isDockerRunning = async (docker: Docker): Promise<boolean> => {
    try {
        await docker.ping();
        return true;
    } catch (error) {
        console.error("Docker is not running:", error);
        return false;
    }
};

export const createSecureContainer = async (
    docker: Docker,
    image: string,
    cmd: string[],
    workingDir: string = "/tmp"
): Promise<Docker.Container> => {
    return await docker.createContainer({
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
};

export const validateLanguage = (language: string): boolean => {
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

export const getLanguageConfig = (language: string) => {
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

    return configs[language.toLowerCase() as keyof typeof configs];
};

export const getSystemResources = async (docker: Docker): Promise<any> => {
    try {
        const info = await docker.info();
        const containers = await docker.listContainers({ all: true });
        
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
    } catch (error) {
        console.error("Failed to get system resources:", error);
        throw error;
    }
};

export const optimizeDockerForProduction = async (docker: Docker): Promise<void> => {
    try {
        console.log("Optimizing Docker for production...");
        
        await cleanupOldContainers(docker);
        
        try {
            await docker.pruneImages({ 
                filters: { 
                    dangling: { false: true },
                    until: { "24h": true } 
                } 
            });
            console.log("Pruned unused images");
        } catch (error) {
            console.warn("Failed to prune images:", error);
        }
        
        try {
            await docker.pruneVolumes();
            console.log("Pruned unused volumes");
        } catch (error) {
            console.warn("Failed to prune volumes:", error);
        }
        
        try {
            await docker.pruneNetworks();
            console.log("Pruned unused networks");
        } catch (error) {
            console.warn("Failed to prune networks:", error);
        }
        
        console.log("Docker optimization complete");
    } catch (error) {
        console.error("Failed to optimize Docker:", error);
    }
};

export async function execInContainer(
  container: Docker.Container,
  cmd: string[],
  options?: { logOutput?: boolean }
): Promise<{ output: string; exitCode: number }> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise(async (resolve, reject) => {
    try {
      const stream = await exec.start({});
      let output = "";
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
        if (options?.logOutput) {
          process.stdout.write(chunk.toString("utf-8"));
        }
      });

      stream.on("end", async () => {
        try {
          const inspect = await exec.inspect();
          resolve({ output, exitCode: inspect.ExitCode ?? 1 });
        } catch (e) {
          reject(e);
        }
      });

      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

export const createTarWithSingleFile = (filename: string, content: string): Promise<Readable> => {
    return new Promise((resolve, reject) => {
        const pack = tar.pack();
        const buffer = Buffer.from(content, "utf-8");

        pack.entry({ 
            name: filename,
            size: buffer.length,
            mode: 0o644,
            type: "file",
        }, buffer, (err) => {
            if (err) {
                console.error("Error adding file to tar:", err);
                reject(err);
            } else {
                pack.finalize();
                resolve(pack);
            }
        });
    });
};

export const writeFileToContainerBase64 = async (
    container: Docker.Container, 
    filename: string, 
    content: string
): Promise<void> => {
    const base64Content = Buffer.from(content, "utf-8").toString("base64");
    
    console.log(`Original content: "${content}"`);
    console.log(`Base64 content: "${base64Content}"`);
    
    const writeCmd = [
        "sh", "-c", 
        `printf "%s" "${base64Content}" | base64 -d > /tmp/${filename}`
    ];
    
    console.log(`Writing ${filename} to container using base64`);
    console.log(`Command: ${writeCmd.join(" ")}`);
    
    const exec = await container.exec({
        Cmd: writeCmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/tmp"
    });
    
    const stream = await exec.start({});
    
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        
        stream.on("data", (chunk: Buffer) => {
            const output = chunk.toString();
            if (output.includes("stderr")) {
                stderr += output;
            } else {
                stdout += output;
            }
        });
        
        stream.on("end", async () => {
            try {
                const info = await exec.inspect();
                console.log(`Write command exit code: ${info.ExitCode}`);
                
                if (stdout) console.log(`Write stdout: ${stdout}`);
                if (stderr) console.log(`Write stderr: ${stderr}`);
                
                if (info.ExitCode === 0) {
                    console.log(`Successfully wrote ${filename} to container`);
                    
                    const verifyExec = await container.exec({
                        Cmd: ["cat", `/tmp/${filename}`],
                        AttachStdout: true,
                        AttachStderr: true,
                    });
                    
                    const verifyStream = await verifyExec.start({});
                    let verifyOutput = "";
                    
                    verifyStream.on("data", (chunk: Buffer) => {
                        verifyOutput += chunk.toString();
                    });
                    
                    verifyStream.on("end", () => {
                        console.log(`Verification read: "${verifyOutput}"`);
                        console.log(`Original content: "${content}"`);
                        console.log(`Content match: ${verifyOutput === content}`);
                        resolve();
                    });
                    
                } else {
                    console.error(`Failed to write ${filename}:`, stderr || stdout);
                    reject(new Error(`Failed to write file: ${stderr || stdout}`));
                }
            } catch (error) {
                reject(error);
            }
        });
        
        stream.on("error", reject);
    });
};