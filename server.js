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

// Socket.IO configuration with native ping/pong heartbeat
const io = new Server(server, {
    pingInterval: 25000,  // Server sends ping every 25 seconds
    pingTimeout: 60000,   // Client has 60 seconds to respond before auto-disconnect
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
const rooms = new Map();

// Track player activity for inactivity-based disconnection
const inactivityTimeout = 5 * 60 * 1000; // 5 minutes of inactivity
const playerActivity = new Map();

io.on('connection', (socket) => {
    // Initialize activity tracking for new player
    playerActivity.set(socket.id, Date.now());

    socket.on('join-room', ({ roomId, user, isCreating }) => {
        const isNewRoom = !rooms.has(roomId);
        if (isCreating && !isNewRoom) return socket.emit('room-error', 'exists');

        if (isNewRoom) { 
            rooms.set(roomId, { 
                players: [], 
                storyTitle: '', 
                newsession: false, 
                revealed: false, 
                currentDeck: 'Fibonacci', 
                customDeck: null 
            }); 
        }

        const room = rooms.get(roomId);
        const nameExists = room.players.find(p => p.name.toLowerCase() === user.name.toLowerCase());
        if (nameExists && nameExists.id !== socket.id) return socket.emit('room-error', 'name_taken');

        if (!room.players.find(p => p.id === socket.id)) {
            room.players.push({ 
                ...user, 
                id: socket.id, 
                voted: false, 
                vote: null, 
                isCreator: isNewRoom || isCreating 
            });
        }
        socket.join(roomId);
        io.to(roomId).emit('update-state', room);
    });

    socket.on('update-user', ({ roomId, user }) => {
        const room = rooms.get(roomId);
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) { 
                p.avatar = user.avatar; 
                playerActivity.set(socket.id, Date.now()); // Track activity
                io.to(roomId).emit('update-state', room); 
            }
        }
    });

    socket.on('update-deck', ({ roomId, deckName, deckValues }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        room.currentDeck = deckName;
        room.deckValues = deckValues;
        playerActivity.set(socket.id, Date.now()); // Track activity
        io.to(roomId).emit('update-state', room);
    });

    socket.on('cast-vote', ({ roomId, vote }) => {
        const room = rooms.get(roomId);
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) { 
                p.vote = vote; 
                p.voted = true; 
                playerActivity.set(socket.id, Date.now()); // Track activity
                io.to(roomId).emit('update-state', room); 
            }
        }
    });

    socket.on('send-emote', (data) => {
        const { roomId, id, icon, x } = data;
        playerActivity.set(socket.id, Date.now()); // Track activity
        socket.broadcast.to(roomId).emit('receive-emote', { id: id, icon: icon, x: x });
    });

    socket.on('throw-emote', (data) => {
        const { roomId, id, targetId, icon, startX, startY } = data;
        playerActivity.set(socket.id, Date.now()); // Track activity
        socket.broadcast.to(roomId).emit('receive-throw', { 
            id: id, 
            targetId: targetId, 
            icon: icon, 
            startX: startX, 
            startY: startY 
        });
    });

    socket.on('update-title', ({ roomId, title }) => {
        const room = rooms.get(roomId);
        if (room) { 
            room.storyTitle = title; 
            playerActivity.set(socket.id, Date.now()); // Track activity
            io.to(roomId).emit('update-state', room); 
        }
    });

    socket.on('broadcast-countdown', ({ roomId, val }) => {
        playerActivity.set(socket.id, Date.now()); // Track activity
        socket.broadcast.to(roomId).emit('auto-reveal-tick', val);
    });

    socket.on('reveal-votes', (roomId) => {
        const room = rooms.get(roomId);
        if (room) { 
            room.revealed = true; 
            playerActivity.set(socket.id, Date.now()); // Track activity
            io.to(roomId).emit('update-state', room); 
        }
    });

    socket.on('reset-table', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            room.newsession = true;
            room.revealed = false; 
            room.storyTitle = '';
            room.players.forEach(p => { p.voted = false; p.vote = null; });
            playerActivity.set(socket.id, Date.now()); // Track activity
            io.to(roomId).emit('update-state', room);
            io.to(roomId).emit('auto-reveal-tick', 0);
            room.newsession = false;
        }
    });

    // Native Socket.IO disconnect event (triggered by ping/pong timeout or explicit disconnect)
    socket.on('disconnect', (reason) => {
        console.log(`Client ${socket.id} disconnected: ${reason}`);
        playerActivity.delete(socket.id);
        
        rooms.forEach((room, roomId) => {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) { 
                const wasCreator = room.players[idx].isCreator;
                room.players.splice(idx, 1); 
                
                // If creator disconnected, promote the next player to creator
                if (wasCreator && room.players.length > 0) { 
                    room.players[0].isCreator = true; 
                    room.creatorMessage = `${room.players[0].name} is now the creator`;
                    
                    io.to(roomId).emit('update-state', room);
                    delete room.creatorMessage;
                } else {
                    io.to(roomId).emit('update-state', room);
                }                
                // If no player reset the room
                if (room.players.length === 0) { rooms.delete(roomId); }
            }
        });
    });
});

// Inactivity-based player cleanup (runs every 2 minutes)
setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, roomId) => {
        let creatorChanged = false;
        
        for (let idx = room.players.length - 1; idx >= 0; idx--) {
            const player = room.players[idx];
            const lastActivity = playerActivity.get(player.id);
            
            // Remove player if inactive for longer than threshold
            if (lastActivity && now - lastActivity > inactivityTimeout) {
                console.log(`Player ${player.name} (${player.id}) removed due to inactivity`);
                const wasCreator = player.isCreator;
                room.players.splice(idx, 1);
                playerActivity.delete(player.id);
                
                // Notify disconnected player
                io.to(player.id).emit('room-error', 'inactivity');
                
                // If creator was inactive, promote next player
                if (wasCreator && room.players.length > 0) {
                    room.players[0].isCreator = true;
                    room.creatorMessage = `${room.players[0].name} is now the creator`;
                    creatorChanged = true;
                }
            }
        }
        
        // Emit updated state if players were removed
        if (room.players.length === 0) {
            rooms.delete(roomId);
        } else if (creatorChanged) {
            io.to(roomId).emit('update-state', room);
            delete room.creatorMessage;
        }
    });
}, 120000); // Check every 2 minutes

server.listen(3000, () => console.log('PlanningPoker Pro Server Running'));