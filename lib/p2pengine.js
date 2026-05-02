/**
 * p2p-engine.js — PeerJS-based P2P layer for PlanningPoker Pro
 *
 * Architecture:
 *  - The room CREATOR becomes the HOST peer. It owns the authoritative room state.
 *  - Every other player connects directly to the HOST as a DATA-channel peer.
 *  - If the host disconnects, the first surviving peer is promoted to HOST:
 *      it inherits the last known state, opens a new PeerJS ID = roomId,
 *      and all remaining peers reconnect to it automatically.
 *
 * Public API (mirrors the socket.io surface used by index.html):
 *   P2PEngine.init(options)  → returns an object with:
 *     .emit(event, data)     → send an event TO the engine (replacing socket.emit)
 *     .on(event, cb)         → listen for events FROM the engine (replacing socket.on)
 *     .id                    → this peer's stable local ID (replacing socket.id)
 *
 * Events the app emits → engine:
 *   join-room, heartbeat, cast-vote, reveal-votes, reset-table,
 *   update-title, update-deck, send-emote, throw-emote, broadcast-countdown, update-user
 *
 * Events the engine emits → app:
 *   connect, update-state, room-error, auto-reveal-tick, receive-emote, receive-throw
 */

(function (global) {
    'use strict';

    /* ─────────────────────────────────────────────────────────────
       CONSTANTS
    ───────────────────────────────────────────────────────────── */
    const HEARTBEAT_INTERVAL  = 5000;   // ms between heartbeats
    const STALE_THRESHOLD     = 15000;  // ms before a player is considered gone
    const STALE_CHECK         = 5000;   // ms between stale-player sweeps (host only)

    /* ─────────────────────────────────────────────────────────────
       HELPERS
    ───────────────────────────────────────────────────────────── */
    function makeLocalId() {
        // A stable per-tab ID — NOT the PeerJS room ID.
        return 'peer-' + Math.random().toString(36).substring(2, 10);
    }

    function deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /* ─────────────────────────────────────────────────────────────
       ENGINE FACTORY
    ───────────────────────────────────────────────────────────── */
    function createEngine() {
        /* ── internal state ── */
        const listeners   = {};   // event → [callbacks]
        let   localId     = makeLocalId();  // stable tab-scoped peer ID
        let   peer        = null;   // PeerJS Peer instance
        let   hostConn    = null;   // DataConnection to the host (non-host only)
        const guestConns  = {};     // peerId → DataConnection (host only)

        let   roomId      = null;
        let   isHost      = false;
        let   myUser      = null;   // { name, avatar }

        /* Host-owned state (mirrors what server.js kept in `rooms`) */
        let roomState = null;
        // roomState shape:
        // { players: [], storyTitle: '', revealed: false,
        //   currentDeck: 'Fibonacci', deckValues: null }

        /* ── event bus ── */
        function emit(event, data) {
            (listeners[event] || []).forEach(cb => cb(data));
        }

        function on(event, cb) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        }

        /* ─────────────────────────────────────────
           HOST HELPERS
        ───────────────────────────────────────── */
        function broadcastState(state) {
            const snapshot = deepClone(state);
            // deliver to every connected guest
            Object.values(guestConns).forEach(conn => {
                if (conn.open) {
                    conn.send({ type: 'update-state', payload: snapshot });
                }
            });
            // also deliver locally (to the host's own Alpine app)
            emit('update-state', snapshot);
        }

        function getOrCreateRoom() {
            if (!roomState) {
                roomState = {
                    players: [],
                    storyTitle: '',
                    newsession: false,
                    revealed: false,
                    currentDeck: 'Fibonacci',
                    deckValues: null,
                };
            }
            return roomState;
        }

        /* Add / refresh a player entry. Returns the mutated room. */
        function upsertPlayer(peerId, user, forceCreator) {
            const room = getOrCreateRoom();
            let p = room.players.find(p => p.id === peerId);
            if (!p) {
                p = {
                    id: peerId,
                    name: user.name,
                    avatar: user.avatar,
                    voted: false,
                    vote: null,
                    lastSeen: Date.now(),
                    isCreator: forceCreator || (room.players.length === 0)
                };
                room.players.push(p);
            } else {
                p.lastSeen = Date.now();
                if (forceCreator) p.isCreator = true;
            }
            return room;
        }

        /* HOST: handle messages arriving from a guest */
        function handleGuestMessage(peerId, msg) {
            const room = roomState;
            if (!room) return;

            switch (msg.type) {

                case 'join-room': {
                    const { user, isCreating } = msg.payload;
                    // duplicate name check
                    const nameConflict = room.players.find(
                        p => p.name.toLowerCase() === user.name.toLowerCase() && p.id !== peerId
                    );
                    if (nameConflict) {
                        const c = guestConns[peerId];
                        if (c && c.open) c.send({ type: 'room-error', payload: 'name_taken' });
                        return;
                    }
                    upsertPlayer(peerId, user, false);
                    broadcastState(room);
                    break;
                }

                case 'heartbeat': {
                    const p = room.players.find(p => p.id === peerId);
                    if (p) p.lastSeen = Date.now();
                    break;
                }

                case 'update-user': {
                    const { user } = msg.payload;
                    const p = room.players.find(p => p.id === peerId);
                    if (p) { p.avatar = user.avatar; broadcastState(room); }
                    break;
                }

                case 'cast-vote': {
                    const { vote } = msg.payload;
                    const p = room.players.find(p => p.id === peerId);
                    if (p) { p.vote = vote; p.voted = true; broadcastState(room); }
                    break;
                }

                case 'reveal-votes': {
                    room.revealed = true;
                    broadcastState(room);
                    break;
                }

                case 'reset-table': {
                    room.newsession = true;
                    room.revealed = false;
                    room.storyTitle = '';
                    room.players.forEach(p => { p.voted = false; p.vote = null; });
                    broadcastState(room);
                    broadcastRaw({ type: 'auto-reveal-tick', payload: 0 });
                    emit('auto-reveal-tick', 0);
                    room.newsession = false;
                    break;
                }

                case 'update-title': {
                    const { title } = msg.payload;
                    room.storyTitle = title;
                    broadcastState(room);
                    break;
                }

                case 'update-deck': {
                    const { deckName, deckValues } = msg.payload;
                    room.currentDeck = deckName;
                    room.deckValues  = deckValues;
                    broadcastState(room);
                    break;
                }

                case 'broadcast-countdown': {
                    const { val } = msg.payload;
                    // relay to all guests except sender
                    Object.entries(guestConns).forEach(([id, conn]) => {
                        if (id !== peerId && conn.open) {
                            conn.send({ type: 'auto-reveal-tick', payload: val });
                        }
                    });
                    emit('auto-reveal-tick', val);
                    break;
                }

                case 'send-emote': {
                    const data = msg.payload;
                    // relay to all guests except sender
                    Object.entries(guestConns).forEach(([id, conn]) => {
                        if (id !== peerId && conn.open) {
                            conn.send({ type: 'receive-emote', payload: data });
                        }
                    });
                    emit('receive-emote', data);
                    break;
                }

                case 'throw-emote': {
                    const data = msg.payload;
                    Object.entries(guestConns).forEach(([id, conn]) => {
                        if (id !== peerId && conn.open) {
                            conn.send({ type: 'receive-throw', payload: data });
                        }
                    });
                    emit('receive-throw', data);
                    break;
                }
            }
        }

        /* HOST: broadcast a raw message to all guests */
        function broadcastRaw(msg) {
            Object.values(guestConns).forEach(conn => {
                if (conn.open) conn.send(msg);
            });
        }

        /* HOST: remove a disconnected guest */
        function removeGuest(peerId) {
            if (!roomState) return;
            const idx = roomState.players.findIndex(p => p.id === peerId);
            if (idx === -1) return;

            const wasCreator = roomState.players[idx].isCreator;
            roomState.players.splice(idx, 1);
            delete guestConns[peerId];

            if (wasCreator && roomState.players.length > 0) {
                roomState.players[0].isCreator = true;
                roomState.creatorMessage = `${roomState.players[0].name} is now the creator`;
            }
            broadcastState(roomState);
            delete roomState.creatorMessage;
            if (roomState.players.length === 0) roomState = null;
        }

        /* HOST: stale-player sweeper */
        function startStaleSweep() {
            setInterval(() => {
                if (!roomState) return;
                const now  = Date.now();
                const prev = roomState.players.length;
                roomState.players = roomState.players.filter(p => now - p.lastSeen < STALE_THRESHOLD);
                if (roomState.players.length !== prev) broadcastState(roomState);
            }, STALE_CHECK);
        }

        /* ─────────────────────────────────────────
           GUEST HELPERS
        ───────────────────────────────────────── */
        function handleHostMessage(msg) {
            switch (msg.type) {
                case 'update-state':      emit('update-state',     msg.payload); break;
                case 'room-error':        emit('room-error',       msg.payload); break;
                case 'auto-reveal-tick':  emit('auto-reveal-tick', msg.payload); break;
                case 'receive-emote':     emit('receive-emote',    msg.payload); break;
                case 'receive-throw':     emit('receive-throw',    msg.payload); break;

                case 'become-host': {
                    // Promotion: we are now the host
                    const { state } = msg.payload;
                    promoteToHost(state);
                    break;
                }
            }
        }

        /* ─────────────────────────────────────────
           HOST PROMOTION (guest becomes host)
        ───────────────────────────────────────── */
        function promoteToHost(inheritedState) {
            console.log('[P2P] Promoted to host');
            isHost    = true;
            hostConn  = null;
            roomState = inheritedState || getOrCreateRoom();

            // re-open peer under the roomId so new joiners find us
            if (peer) { try { peer.destroy(); } catch(e) {} }

            peer = new Peer(roomId, { debug: 1 });

            peer.on('open', (id) => {
                console.log('[P2P] New host peer open:', id);
                // Mark ourselves in the state
                const me = roomState.players.find(p => p.id === localId);
                if (me) { me.isCreator = true; me.lastSeen = Date.now(); }
                broadcastState(roomState);
                emit('update-state', deepClone(roomState));
            });

            peer.on('connection', (conn) => {
                setupGuestConnection(conn);
            });

            peer.on('error', (err) => {
                console.error('[P2P] Host peer error:', err);
            });

            startStaleSweep();
        }

        /* ─────────────────────────────────────────
           GUEST → HOST connection setup (host side)
        ───────────────────────────────────────── */
        function setupGuestConnection(conn) {
            conn.on('open', () => {
                console.log('[P2P] Guest connected:', conn.peer);
                guestConns[conn.peer] = conn;
            });
            conn.on('data', (msg) => {
                handleGuestMessage(conn.peer, msg);
            });
            conn.on('close', () => {
                console.log('[P2P] Guest disconnected:', conn.peer);
                removeGuest(conn.peer);
            });
            conn.on('error', (err) => {
                console.warn('[P2P] Guest connection error:', conn.peer, err);
                removeGuest(conn.peer);
            });
        }

        /* ─────────────────────────────────────────
           GUEST → HOST connection (guest side)
        ───────────────────────────────────────── */
        function connectToHost(targetRoomId, user, isCreating) {
            console.log('[P2P] Connecting to host:', targetRoomId);
            const conn = peer.connect(targetRoomId, { reliable: true });
            hostConn = conn;

            conn.on('open', () => {
                console.log('[P2P] Connected to host');
                conn.send({ type: 'join-room', payload: { user, isCreating } });
            });

            conn.on('data', (msg) => {
                handleHostMessage(msg);
            });

            conn.on('close', () => {
                console.log('[P2P] Host disconnected');
                hostConn = null;
                // Attempt reconnect after a short delay (host may be re-opening)
                setTimeout(() => {
                    if (!hostConn) attemptReconnect(targetRoomId, user);
                }, 2000);
            });

            conn.on('error', (err) => {
                console.warn('[P2P] Host connection error:', err);
                hostConn = null;
            });
        }

        function attemptReconnect(targetRoomId, user) {
            if (hostConn && hostConn.open) return; // already reconnected
            console.log('[P2P] Attempting reconnect to host...');
            connectToHost(targetRoomId, user, false);
        }

        /* ─────────────────────────────────────────
           PUBLIC: app-facing emit (replaces socket.emit)
        ───────────────────────────────────────── */
        function appEmit(event, data) {
            if (isHost) {
                // Host handles its own events directly
                handleGuestMessage(localId, { type: event, payload: data });
            } else {
                if (hostConn && hostConn.open) {
                    hostConn.send({ type: event, payload: data });
                } else {
                    console.warn('[P2P] Cannot send, no host connection:', event);
                }
            }
        }

        /* ─────────────────────────────────────────
           INIT (called once by the app)
        ───────────────────────────────────────── */
        function init({ roomId: rid, isCreating, user }) {
            roomId = rid;
            myUser = user;
            isHost = isCreating;

            // The host's stable "socket ID" is the roomId itself (it opens the peer under that ID).
            // Guests get a random local ID.
            if (isHost) {
                localId = roomId;   // host's peer ID = roomId
            }
            // else localId stays as the random peer-xxxx value

            // Fire connect immediately so Alpine can grab .id
            setTimeout(() => emit('connect'), 0);

            if (isHost) {
                // ── HOST path ──
                peer = new Peer(roomId, { debug: 1 });

                peer.on('open', (id) => {
                    console.log('[P2P] Host peer open:', id);
                    // Register host as the first player
                    const room = getOrCreateRoom();
                    upsertPlayer(localId, user, true);
                    broadcastState(room);
                });

                peer.on('connection', (conn) => {
                    setupGuestConnection(conn);
                });

                peer.on('error', (err) => {
                    console.error('[P2P] Host peer error:', err.type, err);
                    if (err.type === 'unavailable-id') {
                        // Room ID already taken
                        emit('room-error', 'exists');
                    }
                });

                startStaleSweep();

            } else {
                // ── GUEST path ──
                peer = new Peer(localId, { debug: 1 });

                peer.on('open', (id) => {
                    console.log('[P2P] Guest peer open:', id);
                    connectToHost(roomId, user, false);
                });

                peer.on('error', (err) => {
                    console.error('[P2P] Guest peer error:', err.type, err);
                });
            }

            // Heartbeat loop (matches server.js behavior)
            setInterval(() => {
                if (isHost) {
                    // Update host's own lastSeen
                    if (roomState) {
                        const p = roomState.players.find(p => p.id === localId);
                        if (p) p.lastSeen = Date.now();
                    }
                } else {
                    appEmit('heartbeat', roomId);
                }
            }, HEARTBEAT_INTERVAL);
        }

        /* ─────────────────────────────────────────
           EXPORTED OBJECT  (mirrors socket interface)
        ───────────────────────────────────────── */
        return {
            get id() { return localId; },
            init,
            on,
            emit: appEmit,
        };
    }

    /* Expose globally */
    global.P2PEngine = createEngine();

})(window);
