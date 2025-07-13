import { unlink } from "fs/promises";
import express from "express";
import multer from "multer";
import { runCodeInDocker } from "../../services/dockerRunner";

const router = express.Router();
const upload = multer({ dest: "tmp/" });

router.post("/execute", upload.single("code"), async (req, res) => {
    const startTime = Date.now();
    const input = req.body.input || "";
    const language = req.body.language || "python";
    const timeout = parseInt(req.body.timeout) || 30000;
    const filePath = req.file?.path;

    if (!filePath) {
        return res.status(400).json({ 
            error: "Code file not provided",
            timestamp: new Date().toISOString()
        });
    }

    try {
        const supportedLanguages = ["python", "javascript", "c", "cpp", "java", "go", "rust"];
        if (!supportedLanguages.includes(language)) {
            return res.status(400).json({
                error: `Unsupported language: ${language}`,
                supportedLanguages,
                timestamp: new Date().toISOString()
            });
        }

        if (timeout < 1000 || timeout > 60000) {
            return res.status(400).json({
                error: "Timeout must be between 1000ms and 60000ms",
                timestamp: new Date().toISOString()
            });
        }

        console.log(`Executing ${language} code with timeout ${timeout}ms`);
        
        const result = await runCodeInDocker(filePath, input, language, timeout);
        
        const totalTime = Date.now() - startTime;
        
        console.log(`Code execution completed in ${totalTime}ms`);
        
        return res.json({
            ...result,
            totalTime,
            language,
            timestamp: new Date().toISOString(),
            poolUsed: true
        });
        
        
    } catch (error: any) {
        const totalTime = Date.now() - startTime;
        
        console.error("Execution error:", error);
        
        let errorMessage = "Execution failed";
        let statusCode = 500;
        
        if (error.message?.includes("timed out")) {
            errorMessage = "Code execution timed out";
            statusCode = 408;
        } else if (error.message?.includes("Container pool exhausted")) {
            errorMessage = "Server is busy. Please try again later.";
            statusCode = 503;
        } else if (error.message?.includes("Container pool not initialized")) {
            errorMessage = "Service is starting up. Please try again in a moment.";
            statusCode = 503;
        } else if (error.message?.includes("Unsupported language")) {
            errorMessage = error.message;
            statusCode = 400;
        }
        
        return res.status(statusCode).json({ 
            error: errorMessage,
            details: process.env.NODE_ENV === "development" ? error.message : undefined,
            totalTime,
            language,
            timestamp: new Date().toISOString()
        });
        
    } finally {
        try {
            await unlink(filePath);
        } catch (cleanupErr) {
            console.warn("Failed to clean up file:", cleanupErr);
        }
    }
});

router.get("/health", async (req, res) => {
    try {
        const { getPoolStats } = await import("../../services/dockerRunner");
        const stats = getPoolStats();
        
        const isHealthy = !stats.error && Object.keys(stats.pools || {}).length > 0;
        
        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? "healthy" : "unhealthy",
            ...stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: "unhealthy",
            error: "Failed to get pool stats",
            timestamp: new Date().toISOString()
        });
    }
});

router.get("/languages", (req, res) => {
    const languages = [
        { id: "python", name: "Python", version: "3.10" },
        { id: "javascript", name: "JavaScript", version: "Node.js 18" },
        { id: "c", name: "C", version: "GCC Latest" },
        { id: "cpp", name: "C++", version: "GCC Latest" },
        { id: "java", name: "Java", version: "OpenJDK 11" },
        { id: "go", name: "Go", version: "1.19" },
        { id: "rust", name: "Rust", version: "Latest" }
    ];
    
    res.json({
        languages,
        timestamp: new Date().toISOString()
    });
});

export default router;