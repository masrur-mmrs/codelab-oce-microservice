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
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const execute_1 = __importDefault(require("./api/routes/execute"));
const wsServer_1 = require("./websocket/wsServer");
const dockerRunner_1 = require("./services/dockerRunner");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const PORT = process.env.PORT || 4000;
const gracefulShutdown = (signal) => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
    try {
        server.close(() => {
            console.log('HTTP server closed');
        });
        yield Promise.all([
            (0, dockerRunner_1.shutdownContainerPool)(),
            (0, wsServer_1.shutdownWebSocketPool)()
        ]);
        console.log('Graceful shutdown complete');
        process.exit(0);
    }
    catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});
const initializeApp = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        console.log('Starting Codelabs OCE Microservice...');
        console.log('Initializing container pools...');
        yield (0, dockerRunner_1.initializeContainerPool)();
        yield (0, wsServer_1.initializeWebSocketPool)();
        app.use(express_1.default.json());
        app.use("/api", execute_1.default);
        (0, wsServer_1.setupWebSocketServer)(server);
        app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });
        app.get('/stats', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const { getPoolStats } = yield Promise.resolve().then(() => __importStar(require('./services/dockerRunner')));
                const { getWebSocketPoolStats } = yield Promise.resolve().then(() => __importStar(require('./websocket/wsServer')));
                const stats = {
                    dockerRunner: getPoolStats(),
                    webSocket: getWebSocketPoolStats(),
                    system: {
                        uptime: process.uptime(),
                        memory: process.memoryUsage(),
                        cpu: process.cpuUsage()
                    }
                };
                res.json(stats);
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to get stats' });
            }
        }));
        server.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/health`);
            console.log(`Stats endpoint: http://localhost:${PORT}/stats`);
            console.log(`WebSocket ready for connections`);
        });
    }
    catch (error) {
        console.error('Failed to initialize application:', error);
        process.exit(1);
    }
});
initializeApp();
