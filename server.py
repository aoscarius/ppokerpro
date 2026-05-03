# Python alternative to nodejs server with Flask + Flask_SocketIO

import time
from flask import Flask, render_template
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__, static_folder='public', static_url_path='')
app.config['SECRET_KEY'] = 'secret_poker_key'
# cors_allowed_origins="*" allows connection from any origin, similar to default Socket.io
socketio = SocketIO(app, cors_allowed_origins="*")

# In-memory store for rooms
rooms = {}

def get_now_ms():
    return int(time.time() * 1000)

@socketio.on('heartbeat')
def handle_heartbeat(room_id):
    room = rooms.get(room_id)
    if room:
        player = next((p for p in room['players'] if p['id'] == request.sid), None)
        if player:
            player['lastSeen'] = get_now_ms()

@socketio.on('join-room')
def handle_join(data):
    room_id = data.get('roomId')
    user = data.get('user')
    is_creating = data.get('isCreating')
    sid = request.sid

    is_new_room = room_id not in rooms
    
    if is_creating and not is_new_room:
        emit('room-error', 'exists')
        return

    if is_new_room:
        rooms[room_id] = {
            'players': [],
            'storyTitle': '',
            'newsession': False,
            'revealed': False,
            'currentDeck': 'Fibonacci',
            'customDeck': None
        }

    room = rooms[room_id]
    
    # Check if name is taken
    name_exists = any(p['name'].lower() == user['name'].lower() and p['id'] != sid for p in room['players'])
    if name_exists:
        emit('room-error', 'name_taken')
        return

    # Add player if not already in list
    if not any(p['id'] == sid for p in room['players']):
        new_player = {
            **user,
            'id': sid,
            'voted': False,
            'vote': None,
            'lastSeen': get_now_ms(),
            'isCreator': is_new_room or is_creating
        }
        room['players'].append(new_player)

    join_room(room_id)
    emit('update-state', room, to=room_id)

@socketio.on('update-user')
def handle_update_user(data):
    room_id = data.get('roomId')
    user_data = data.get('user')
    room = rooms.get(room_id)
    if room:
        player = next((p for p in room['players'] if p['id'] == request.sid), None)
        if player:
            player['avatar'] = user_data.get('avatar')
            emit('update-state', room, to=room_id)

@socketio.on('cast-vote')
def handle_vote(data):
    room_id = data.get('roomId')
    vote = data.get('vote')
    room = rooms.get(room_id)
    if room:
        player = next((p for p in room['players'] if p['id'] == request.sid), None)
        if player:
            player['vote'] = vote
            player['voted'] = True
            emit('update-state', room, to=room_id)

@socketio.on('send-emote')
def handle_emote(data):
    # broadcast.to(room) in JS is equivalent to include_self=False in Flask-SocketIO
    emit('receive-emote', data, to=data['roomId'], include_self=False)

@socketio.on('reveal-votes')
def handle_reveal(room_id):
    room = rooms.get(room_id)
    if room:
        room['revealed'] = True
        emit('update-state', room, to=room_id)

@socketio.on('reset-table')
def handle_reset(room_id):
    room = rooms.get(room_id)
    if room:
        room['newsession'] = True
        room['revealed'] = False
        room['storyTitle'] = ''
        for p in room['players']:
            p['voted'] = False
            p['vote'] = None
        emit('update-state', room, to=room_id)
        emit('auto-reveal-tick', 0, to=room_id)
        room['newsession'] = False

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    rooms_to_delete = []

    for room_id, room in rooms.items():
        player_idx = next((i for i, p in enumerate(room['players']) if p['id'] == sid), -1)
        
        if player_idx != -1:
            was_creator = room['players'][player_idx]['isCreator']
            room['players'].pop(player_idx)

            if was_creator and len(room['players']) > 0:
                room['players'][0]['isCreator'] = True
            
            emit('update-state', room, to=room_id)
            
            if len(room['players']) == 0:
                rooms_to_delete.append(room_id)

    for r_id in rooms_to_delete:
        del rooms[r_id]

# Background task for stale player cleanup
def cleanup_stale_players():
    while True:
        socketio.sleep(5)
        now = get_now_ms()
        for room_id, room in list(rooms.items()):
            initial_len = len(room['players'])
            room['players'] = [p for p in room['players'] if now - p['lastSeen'] < 15000]
            
            if len(room['players']) != initial_len:
                socketio.emit('update-state', room, to=room_id)
                if len(room['players']) == 0:
                    del rooms[room_id]

if __name__ == '__main__':
    # Start the background task
    socketio.start_background_task(cleanup_stale_players)
    socketio.run(app, port=3000, debug=True)