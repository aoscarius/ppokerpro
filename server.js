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
        const isNewRoom = !rooms.has(roomId);
        if (isCreating && !isNewRoom) return socket.emit('room-error', 'exists');

        if (isNewRoom) { rooms.set(roomId, { players: [], storyTitle: '', newsession: false, revealed: false, currentDeck: 'Fibonacci', customDeck: null, }); }

        const room = rooms.get(roomId);
        const nameExists = room.players.find(p => p.name.toLowerCase() === user.name.toLowerCase());
        if (nameExists && nameExists.id !== socket.id) return socket.emit('room-error', 'name_taken');

        if (!room.players.find(p => p.id === socket.id)) {
            room.players.push({ ...user, id: socket.id, voted: false, vote: null, lastSeen: Date.now(), isCreator: isNewRoom || isCreating });
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

    socket.on('update-deck', ({ roomId, deckName, deckValues }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        room.currentDeck = deckName;
        room.deckValues = deckValues;
        io.to(roomId).emit('update-state', room);
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
        socket.broadcast.to(roomId).emit('receive-emote', { id: id, icon: icon, x: x });
    });

    socket.on('throw-emote', (data) => {
        const { roomId, id, targetId, icon, startX, startY } = data;
        socket.broadcast.to(data.roomId).emit('receive-throw', { id: id, targetId: targetId, icon: icon, startX: startX, startY: startY });
    });

    socket.on('update-title', ({ roomId, title }) => {
        const room = rooms.get(roomId);
        if (room) { room.storyTitle = title; io.to(roomId).emit('update-state', room); }
    });

    socket.on('broadcast-countdown', ({ roomId, val }) => {
        socket.broadcast.to(roomId).emit('auto-reveal-tick', val);
    });

    socket.on('reveal-votes', (roomId) => {
        const room = rooms.get(roomId);
        if (room) { room.revealed = true; io.to(roomId).emit('update-state', room); }
    });

    socket.on('reset-table', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            room.newsession = true;
            room.revealed = false; 
            room.storyTitle = '';
            room.players.forEach(p => { p.voted = false; p.vote = null; });
            io.to(roomId).emit('update-state', room);
            io.to(roomId).emit('auto-reveal-tick', 0);
            room.newsession = false;
        }
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) { 
                const wasCreator = room.players[idx].isCreator;
                room.players.splice(idx, 1); 
                // If creator disconnected promote the next one
                if (wasCreator && room.players.length > 0) { 
                    room.players[0].isCreator = true; 
                    room.creatorMessage = `${room.players[0].name} is now the creator`;
                }
                io.to(roomId).emit('update-state', room);
                delete room.creatorMessage;
                // If no player reset the room
                if (room.players.length === 0) { rooms.delete(roomId); }
            }
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

server.listen(3000, () => console.log('PlanninPoker Pro Server Running'));