const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store rooms: { code: { sender: ws, receiver: ws } }
const rooms = {};

// Helper: Generate 5-digit code
function generateCode() {
    let code;
    do {
        code = Math.floor(10000 + Math.random() * 90000).toString();
    } while (rooms[code]); // Ensure uniqueness
    return code;
}

wss.on('connection', (ws) => {
    let currentRoom = null;
    let isSender = false;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON');
            return;
        }

        const type = data.type;

        if (type === 'create-room') {
            // Clean up previous room if sender creates a new one
            if (currentRoom && rooms[currentRoom]) {
                delete rooms[currentRoom];
            }
            const code = generateCode();
            rooms[code] = { sender: ws, receiver: null };
            currentRoom = code;
            isSender = true;
            ws.send(JSON.stringify({ type: 'room-created', code }));
            console.log(`Room created: ${code}`);
        } 
        else if (type === 'join-room') {
            const code = data.code;
            if (rooms[code] && !rooms[code].receiver) {
                rooms[code].receiver = ws;
                currentRoom = code;
                isSender = false;
                
                // Notify both peers
                rooms[code].sender.send(JSON.stringify({ type: 'peer-joined' }));
                ws.send(JSON.stringify({ type: 'room-joined' }));
                console.log(`Peer joined room: ${code}`);
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Room not found or full' }));
            }
        } 
        else if (type === 'signal') {
            if (currentRoom && rooms[currentRoom]) {
                const room = rooms[currentRoom];
                const target = isSender ? room.receiver : room.sender;
                if (target) {
                    target.send(JSON.stringify({ type: 'signal', data: data.data }));
                }
            }
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms[currentRoom]) {
            console.log(`Peer disconnected from room: ${currentRoom}`);
            const room = rooms[currentRoom];
            // Notify other peer
            const other = isSender ? room.receiver : room.sender;
            if (other && other.readyState === WebSocket.OPEN) {
                other.send(JSON.stringify({ type: 'peer-disconnected' }));
            }
            // Clean up room
            delete rooms[currentRoom];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
