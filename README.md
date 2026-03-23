# PlanningPoker Pro

A real-time, distributed Agile Planning Poker application designed for remote teams. Built with **Node.js**, **Socket.io**, and **Alpine.js**.

## Features
- **Real-time Sessions**: Synchronized voting board for distributed teams.
- **Unique Room IDs**: Automatic generation of unique room IDs with collision prevention.
- **Identity Protection**: Duplicate username check within the same room.
- **Analytics & Pie Chart**: Post-reveal data visualization including average and consensus score.
- **Emote System**: Interactive floating emotes (Fire, Rocket, Airplane, etc.) for instant feedback.
- **Session Persistence**: Saves your name and avatar in local storage.
- **Auto-Cleanup**: Heartbeat system removes inactive/disconnected players automatically.

## Quick Start
1. **Install dependencies**:
   ```bash
   make install
   ```
2. **Run the server**:
   ```bash
   make run
   ```
3. Open `http://localhost:3000` in your browser.

## Tech Stack
- **Server**: Node.js, Express, Socket.io
- **Frontend**: Tailwind CSS, Alpine.js
- **Animations**: Canvas-Confetti, CSS Keyframes
