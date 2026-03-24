const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const nodeVersion = process.version.replace('v', '').split('.');
const majorVersion = parseInt(nodeVersion[0]);

if (majorVersion < 12) {
    console.warn(`[Compatibility Warning] Node.js ${process.version} detected. Applying Object.fromEntries polyfill...`);
    
    if (!Object.fromEntries) {
        Object.fromEntries = function (entries) {
            if (!entries || !entries[Symbol.iterator]) { 
                throw new TypeError('Object.fromEntries require an iterable object'); 
            }
            let obj = {};
            for (let [key, value] of entries) {
                obj[key] = value;
            }
            return obj;
        };
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
const rooms = new Map();

io.on('connection', (socket) => {
    // Heartbeat listener to keep player alive
    socket.on('heartbeat', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) p.lastSeen = Date.now();
        }
    });

    socket.on('join-room', ({ roomId, user, isCreating }) => {
        if (isCreating && rooms.has(roomId)) return socket.emit('room-error', 'exists');
        if (!rooms.has(roomId)) rooms.set(roomId, { players: [], storyTitle: '', revealed: false });
        
        const room = rooms.get(roomId);
        const nameExists = room.players.find(p => p.name.toLowerCase() === user.name.toLowerCase());
        if (nameExists && nameExists.id !== socket.id) return socket.emit('room-error', 'name_taken');

        if (!room.players.find(p => p.id === socket.id)) {
            room.players.push({ ...user, id: socket.id, voted: false, vote: null, lastSeen: Date.now() });
        }
        socket.join(roomId);
        io.to(roomId).emit('update-state', room);
    });

    socket.on('update-user', ({ roomId, user }) => {
        const room = rooms.get(roomId);
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) { p.avatar = user.avatar; io.to(roomId).emit('update-state', room); }
        }
    });

    socket.on('cast-vote', ({ roomId, vote }) => {
        const room = rooms.get(roomId);
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) { p.vote = vote; p.voted = true; io.to(roomId).emit('update-state', room); }
        }
    });

    socket.on('send-emote', (data) => {
        const { roomId, id, icon, x } = data;
        socket.to(roomId).emit('receive-emote', { id: id, icon: icon, x: x });
    });

    socket.on('throw-emote', (data) => {
        socket.to(data.roomId).emit('receive-throw', data);
    });

    socket.on('update-title', ({ roomId, title }) => {
        const room = rooms.get(roomId);
        if (room) { room.storyTitle = title; io.to(roomId).emit('update-state', room); }
    });

    socket.on('broadcast-countdown', ({ roomId, val }) => {
        socket.to(roomId).emit('auto-reveal-tick', val);
    });

    socket.on('reveal-votes', (roomId) => {
        const room = rooms.get(roomId);
        if (room) { room.revealed = true; io.to(roomId).emit('update-state', room); }
    });

    socket.on('reset-table', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            room.revealed = false; room.storyTitle = '';
            room.players.forEach(p => { p.voted = false; p.vote = null; });
            io.to(roomId).emit('update-state', room);
            io.to(roomId).emit('auto-reveal-tick', 0);
        }
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) { room.players.splice(idx, 1); io.to(roomId).emit('update-state', room); }
        });
    });
});

// Stale player cleanup (Heartbeat check)
setInterval(() => {
    rooms.forEach((room, roomId) => {
        const now = Date.now();
        const initialLen = room.players.length;
        room.players = room.players.filter(p => now - p.lastSeen < 15000); 
        if (room.players.length !== initialLen) io.to(roomId).emit('update-state', room);
    });
}, 5000);

server.listen(3000, () => console.log('PokerPlan Pro Server Running'));