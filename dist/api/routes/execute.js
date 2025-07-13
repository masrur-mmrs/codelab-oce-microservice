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
const promises_1 = require("fs/promises");
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const dockerRunner_1 = require("../../services/dockerRunner");
const router = express_1.default.Router();
const upload = (0, multer_1.default)({ dest: "tmp/" });
router.post("/execute", upload.single("code"), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e;
    const startTime = Date.now();
    const input = req.body.input || "";
    const language = req.body.language || "python";
    const timeout = parseInt(req.body.timeout) || 30000;
    const filePath = (_a = req.file) === null || _a === void 0 ? void 0 : _a.path;
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
        const result = yield (0, dockerRunner_1.runCodeInDocker)(filePath, input, language, timeout);
        const totalTime = Date.now() - startTime;
        console.log(`Code execution completed in ${totalTime}ms`);
        return res.json(Object.assign(Object.assign({}, result), { totalTime,
            language, timestamp: new Date().toISOString(), poolUsed: true }));
    }
    catch (error) {
        const totalTime = Date.now() - startTime;
        console.error("Execution error:", error);
        let errorMessage = "Execution failed";
        let statusCode = 500;
        if ((_b = error.message) === null || _b === void 0 ? void 0 : _b.includes("timed out")) {
            errorMessage = "Code execution timed out";
            statusCode = 408;
        }
        else if ((_c = error.message) === null || _c === void 0 ? void 0 : _c.includes("Container pool exhausted")) {
            errorMessage = "Server is busy. Please try again later.";
            statusCode = 503;
        }
        else if ((_d = error.message) === null || _d === void 0 ? void 0 : _d.includes("Container pool not initialized")) {
            errorMessage = "Service is starting up. Please try again in a moment.";
            statusCode = 503;
        }
        else if ((_e = error.message) === null || _e === void 0 ? void 0 : _e.includes("Unsupported language")) {
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
    }
    finally {
        try {
            yield (0, promises_1.unlink)(filePath);
        }
        catch (cleanupErr) {
            console.warn("Failed to clean up file:", cleanupErr);
        }
    }
}));
router.get("/health", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { getPoolStats } = yield Promise.resolve().then(() => __importStar(require("../../services/dockerRunner")));
        const stats = getPoolStats();
        const isHealthy = !stats.error && Object.keys(stats.pools || {}).length > 0;
        res.status(isHealthy ? 200 : 503).json(Object.assign(Object.assign({ status: isHealthy ? "healthy" : "unhealthy" }, stats), { timestamp: new Date().toISOString() }));
    }
    catch (error) {
        res.status(503).json({
            status: "unhealthy",
            error: "Failed to get pool stats",
            timestamp: new Date().toISOString()
        });
    }
}));
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
exports.default = router;
