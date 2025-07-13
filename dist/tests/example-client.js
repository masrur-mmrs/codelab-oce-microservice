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
// example-client.ts
const ws_1 = __importDefault(require("ws"));
const form_data_1 = __importDefault(require("form-data"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const SERVER_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000';
// Test REST API
function testRestAPI() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🔄 Testing REST API...');
        const pythonCode = `
print("Hello from Python!")
name = input("Enter your name: ")
print(f"Hello, {name}!")
for i in range(3):
    print(f"Count: {i}")
`;
        // Create temporary file
        const tempFile = path_1.default.join(__dirname, 'temp_script.py');
        fs_1.default.writeFileSync(tempFile, pythonCode);
        try {
            const formData = new form_data_1.default();
            formData.append('code', fs_1.default.createReadStream(tempFile));
            formData.append('language', 'python');
            formData.append('input', 'John\n');
            formData.append('timeout', '10000');
            const response = yield (0, node_fetch_1.default)(`${SERVER_URL}/api/execute`, {
                method: 'POST',
                body: formData,
            });
            const result = yield response.json();
            console.log('✅ REST API Result:', result);
        }
        catch (error) {
            console.error('❌ REST API Error:', error);
        }
        finally {
            // Clean up
            try {
                fs_1.default.unlinkSync(tempFile);
            }
            catch (err) {
                console.warn('Failed to clean up temp file:', err);
            }
        }
    });
}
// Test WebSocket
function testWebSocket() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🔄 Testing WebSocket...');
        return new Promise((resolve, reject) => {
            const ws = new ws_1.default(WS_URL);
            ws.on('open', () => {
                console.log('📡 WebSocket connected');
                // Send code execution request
                const jsCode = `
console.log("Hello from JavaScript!");
console.log("Current time:", new Date().toISOString());

// Simulate some processing
for (let i = 0; i < 5; i++) {
    console.log(\`Processing step \${i + 1}\`);
}

console.log("Finished processing!");
`;
                ws.send(JSON.stringify({
                    type: 'execute',
                    language: 'javascript',
                    code: jsCode
                }));
            });
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log(`📨 [${message.type}] ${message.message}`);
                    if (message.type === 'system' && message.message.includes('completed')) {
                        // Request stats
                        ws.send(JSON.stringify({ type: 'stats' }));
                        setTimeout(() => {
                            ws.close();
                            resolve();
                        }, 1000);
                    }
                }
                catch (error) {
                    console.error('❌ Failed to parse WebSocket message:', error);
                }
            });
            ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error);
                reject(error);
            });
            ws.on('close', () => {
                console.log('📡 WebSocket disconnected');
            });
        });
    });
}
// Test interactive session
function testInteractiveSession() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🔄 Testing interactive session...');
        return new Promise((resolve, reject) => {
            const ws = new ws_1.default(WS_URL);
            ws.on('open', () => {
                console.log('📡 Interactive session connected');
                // Send Python code that requires input
                const interactiveCode = `
print("Interactive Python Session")
name = input("What's your name? ")
age = input("How old are you? ")
print(f"Hello {name}, you are {age} years old!")

hobby = input("What's your hobby? ")
print(f"That's cool! {hobby} is a great hobby.")
print("Thanks for the chat!")
`;
                ws.send(JSON.stringify({
                    type: 'execute',
                    language: 'python',
                    code: interactiveCode
                }));
            });
            let inputStep = 0;
            const inputs = ['Alice', '25', 'Programming'];
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log(`📨 [${message.type}] ${message.message}`);
                    // Send input when program asks for it
                    if (message.type === 'stdout' && message.message.includes('?')) {
                        if (inputStep < inputs.length) {
                            setTimeout(() => {
                                console.log(`📤 Sending input: ${inputs[inputStep]}`);
                                ws.send(JSON.stringify({
                                    type: 'input',
                                    message: inputs[inputStep]
                                }));
                                inputStep++;
                            }, 500);
                        }
                    }
                    if (message.type === 'system' && message.message.includes('completed')) {
                        setTimeout(() => {
                            ws.close();
                            resolve();
                        }, 1000);
                    }
                }
                catch (error) {
                    console.error('❌ Failed to parse message:', error);
                }
            });
            ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error);
                reject(error);
            });
            ws.on('close', () => {
                console.log('📡 Interactive session disconnected');
            });
        });
    });
}
// Test system endpoints
function testSystemEndpoints() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🔄 Testing system endpoints...');
        try {
            // Test health endpoint
            const healthResponse = yield (0, node_fetch_1.default)(`${SERVER_URL}/health`);
            const healthData = yield healthResponse.json();
            console.log('🏥 Health check:', healthData);
            // Test stats endpoint
            const statsResponse = yield (0, node_fetch_1.default)(`${SERVER_URL}/stats`);
            const statsData = yield statsResponse.json();
            console.log('📊 System stats:', JSON.stringify(statsData, null, 2));
            // Test languages endpoint
            const languagesResponse = yield (0, node_fetch_1.default)(`${SERVER_URL}/api/languages`);
            const languagesData = yield languagesResponse.json();
            console.log('🗣️ Supported languages:', languagesData);
            // Test API health endpoint
            const apiHealthResponse = yield (0, node_fetch_1.default)(`${SERVER_URL}/api/health`);
            const apiHealthData = yield apiHealthResponse.json();
            console.log('🔧 API health:', apiHealthData);
        }
        catch (error) {
            console.error('❌ System endpoints error:', error);
        }
    });
}
// Run all tests
function runAllTests() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('🚀 Starting comprehensive tests...\n');
        try {
            yield testSystemEndpoints();
            console.log('\n' + '='.repeat(50) + '\n');
            yield testRestAPI();
            console.log('\n' + '='.repeat(50) + '\n');
            yield testWebSocket();
            console.log('\n' + '='.repeat(50) + '\n');
            yield testInteractiveSession();
            console.log('\n' + '='.repeat(50) + '\n');
            console.log('✅ All tests completed successfully!');
        }
        catch (error) {
            console.error('❌ Test suite failed:', error);
            process.exit(1);
        }
    });
}
// Command line interface
const command = process.argv[2];
switch (command) {
    case 'rest':
        testRestAPI();
        break;
    case 'ws':
        testWebSocket();
        break;
    case 'interactive':
        testInteractiveSession();
        break;
    case 'system':
        testSystemEndpoints();
        break;
    case 'all':
    default:
        runAllTests();
        break;
}
// Usage examples:
// npm run test:client           # Run all tests
// npm run test:client rest      # Test REST API only
// npm run test:client ws        # Test WebSocket only
// npm run test:client interactive # Test interactive session
// npm run test:client system   # Test system endpoints only
