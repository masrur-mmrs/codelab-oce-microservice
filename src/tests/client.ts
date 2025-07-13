import WebSocket from 'ws';
import FormData from 'form-data';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const SERVER_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000';

// Test REST API
async function testRestAPI() {
    console.log('🔄 Testing REST API...');
    
    const pythonCode = `
print("Hello from Python!")
name = input("Enter your name: ")
print(f"Hello, {name}!")
for i in range(3):
    print(f"Count: {i}")
`;
    
    // Create temporary file
    const tempFile = path.join(__dirname, 'temp_script.py');
    fs.writeFileSync(tempFile, pythonCode);
    
    try {
        const formData = new FormData();
        formData.append('code', fs.createReadStream(tempFile));
        formData.append('language', 'python');
        formData.append('input', 'John\n');
        formData.append('timeout', '10000');
        
        const response = await fetch(`${SERVER_URL}/api/execute`, {
            method: 'POST',
            body: formData,
        });
        
        const result = await response.json();
        console.log('✅ REST API Result:', result);
        
    } catch (error) {
        console.error('❌ REST API Error:', error);
    } finally {
        // Clean up
        try {
            fs.unlinkSync(tempFile);
        } catch (err) {
            console.warn('Failed to clean up temp file:', err);
        }
    }
}

// Test WebSocket
async function testWebSocket() {
    console.log('🔄 Testing WebSocket...');
    
    return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        
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
            } catch (error) {
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
}

// Test interactive session
async function testInteractiveSession() {
    console.log('🔄 Testing interactive session...');
    
    return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        
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
            } catch (error) {
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
}

// Test system endpoints
async function testSystemEndpoints() {
    console.log('🔄 Testing system endpoints...');
    
    try {
        // Test health endpoint
        const healthResponse = await fetch(`${SERVER_URL}/health`);
        const healthData = await healthResponse.json();
        console.log('🏥 Health check:', healthData);
        
        // Test stats endpoint
        const statsResponse = await fetch(`${SERVER_URL}/stats`);
        const statsData = await statsResponse.json();
        console.log('📊 System stats:', JSON.stringify(statsData, null, 2));
        
        // Test languages endpoint
        const languagesResponse = await fetch(`${SERVER_URL}/api/languages`);
        const languagesData = await languagesResponse.json();
        console.log('🗣️ Supported languages:', languagesData);
        
        // Test API health endpoint
        const apiHealthResponse = await fetch(`${SERVER_URL}/api/health`);
        const apiHealthData = await apiHealthResponse.json();
        console.log('🔧 API health:', apiHealthData);
        
    } catch (error) {
        console.error('❌ System endpoints error:', error);
    }
}

// Run all tests
async function runAllTests() {
    console.log('🚀 Starting comprehensive tests...\n');
    
    try {
        await testSystemEndpoints();
        console.log('\n' + '='.repeat(50) + '\n');
        
        await testRestAPI();
        console.log('\n' + '='.repeat(50) + '\n');
        
        await testWebSocket();
        console.log('\n' + '='.repeat(50) + '\n');
        
        await testInteractiveSession();
        console.log('\n' + '='.repeat(50) + '\n');
        
        console.log('✅ All tests completed successfully!');
        
    } catch (error) {
        console.error('❌ Test suite failed:', error);
        process.exit(1);
    }
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