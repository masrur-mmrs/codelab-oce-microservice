import express from "express";
import http from "http";
import executeRoute from "./api/routes/execute";
import { setupWebSocketServer, shutdownWebSocketPool } from "./websocket/wsServer";
import { initializeContainerPool, shutdownContainerPool } from "./services/dockerRunner";

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

const gracefulShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
    
    try {
        server.close(() => {
            console.log('HTTP server closed');
        });
        
        await Promise.all([
            shutdownContainerPool(),
            shutdownWebSocketPool()
        ]);
        
        console.log('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

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

const initializeApp = async () => {
    try {
        console.log('Starting Codelabs OCE Microservice...');
        
        console.log('Initializing container pool system...');
        await initializeContainerPool();
        
        app.use(express.json());
        app.use("/api", executeRoute);
        
        setupWebSocketServer(server);
        
        app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });
        
        app.get('/stats', async (req, res) => {
            try {
                const { getPoolStats } = await import('./services/dockerRunner');
                
                const stats = {
                    containerPool: getPoolStats(),
                    system: {
                        uptime: process.uptime(),
                        memory: process.memoryUsage(),
                        cpu: process.cpuUsage()
                    }
                };
                
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: 'Failed to get stats' });
            }
        });
        
        server.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/health`);
            console.log(`Stats endpoint: http://localhost:${PORT}/stats`);
            console.log(`WebSocket ready for connections`);
        });
        
    } catch (error) {
        console.error('Failed to initialize application:', error);
        process.exit(1);
    }
};

initializeApp();