# --- Variables ---
APP_NAME = PlanningPokerPro
PORT = 3000

# --- Help ---
help:
	@echo "Available commands:"
	@echo "  make install  - Install dependencies"
	@echo "  make run      - Run the server locally"
	@echo "  make dev      - Run with nodemon (auto-reload)"
	@echo "  make clean    - Remove node_modules"

# --- Local Development ---
install:
	@npm install

run:
	@node server.js

dev:
	@npx nodemon server.js

clean:
	@rm -rf node_modules
	@rm -f package-lock.json

.PHONY: help install run dev clean