#!/usr/bin/env bash
# Start/restart the OCPP Multi-Charger Simulator
#
# Usage:
#   ./start.sh              # Run with Node.js on port 3100
#   ./start.sh 4000         # Run with Node.js on custom port
#   ./start.sh --docker     # Run with Docker (accessible from network)

set -e

cd "$(dirname "$0")"

# Docker mode — builds and runs the container
if [ "$1" = "--docker" ]; then
  echo "Starting simulator with Docker (network-accessible on port 3100)..."
  docker compose down 2>/dev/null || true
  docker compose up -d --build
  IP=$(hostname -I | awk '{print $1}')
  echo ""
  echo "Simulator is running."
  echo "  Local:   http://localhost:3100"
  echo "  Network: http://${IP}:3100"
  echo ""
  echo "Logs: docker compose logs -f ocpp-simulator"
  exit 0
fi

# Node.js mode (original behavior)
PORT="${1:-3100}"

# Kill any existing simulator on that port
PID=$(lsof -t -i :"$PORT" 2>/dev/null)
if [ -n "$PID" ]; then
  echo "Stopping existing process on port $PORT (PID: $PID)..."
  kill $PID 2>/dev/null
  sleep 1
fi

echo "Starting simulator on port $PORT..."
node simulator.js --port "$PORT"
