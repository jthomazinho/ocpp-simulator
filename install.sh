#!/usr/bin/env bash
#
# OCPP Simulator installer.
#
# Run locally from inside the repo:
#   ./install.sh [options]
#
# Or one-line install on a fresh machine:
#   curl -fsSL https://raw.githubusercontent.com/jthomazinho/ocpp-simulator/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --gateway ws://192.168.0.10:8081 --start
#
# Options:
#   --dir <path>       Install location (default: $HOME/ocpp-simulator when cloning)
#   --docker | --node  Force install mode (default: auto — Docker if present, else Node)
#   --gateway <url>    Gateway WebSocket URL to auto-connect a charger (sets GATEWAY_URL)
#   --station <id>     Station id for the auto-started charger (sets STATION_ID)
#   --protocol <v>     OCPP protocol for the auto-started charger: 1.6 | 2.0.1
#   --start            Start the simulator after installing
#   -h | --help        Show this help
#
set -euo pipefail

REPO_SSH="git@github.com:jthomazinho/ocpp-simulator.git"
REPO_HTTPS="https://github.com/jthomazinho/ocpp-simulator.git"
MIN_NODE_MAJOR=20

TARGET_DIR=""
MODE="auto"
GATEWAY_URL="${GATEWAY_URL:-}"
STATION_ID="${STATION_ID:-}"
OCPP_PROTOCOL="${OCPP_PROTOCOL:-}"
DO_START=0

# ── tiny helpers ──────────────────────────────────────────────────────────
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Prints the leading comment block (from line 3) as help, stopping at the
# first non-comment line.
usage() {
  awk 'NR>=3 && /^#/ { sub(/^# ?/, ""); print; next } NR>=3 { exit }' "$0"
  exit 0
}

# ── parse args ────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      TARGET_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --docker)   MODE=docker; shift ;;
    --node)     MODE=node; shift ;;
    --gateway)  GATEWAY_URL="${2:?--gateway needs a url}"; shift 2 ;;
    --station)  STATION_ID="${2:?--station needs an id}"; shift 2 ;;
    --protocol) OCPP_PROTOCOL="${2:?--protocol needs a value}"; shift 2 ;;
    --start)    DO_START=1; shift ;;
    -h|--help)  usage ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

bold "OCPP Simulator — installer"

# ── locate the project: in-repo vs clone ──────────────────────────────────
if [ -f "./simulator.js" ] && [ -f "./package.json" ]; then
  TARGET_DIR="${TARGET_DIR:-$(pwd)}"
  ok "Using the simulator in $(pwd)"
else
  TARGET_DIR="${TARGET_DIR:-$HOME/ocpp-simulator}"
  have git || die "git is required to fetch the simulator. Install git and retry."
  if [ -d "$TARGET_DIR/.git" ]; then
    info "Updating existing checkout at $TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only
  else
    info "Cloning into $TARGET_DIR"
    git clone "$REPO_SSH" "$TARGET_DIR" 2>/dev/null \
      || git clone "$REPO_HTTPS" "$TARGET_DIR" \
      || die "Could not clone the repository (checked SSH and HTTPS)."
  fi
  cd "$TARGET_DIR"
  ok "Repository ready at $TARGET_DIR"
fi

# ── resolve install mode ──────────────────────────────────────────────────
if [ "$MODE" = auto ]; then
  if have docker; then MODE=docker; else MODE=node; fi
fi
info "Install mode: $MODE"

# ── env passthrough for an auto-started charger ───────────────────────────
run_env=()
[ -n "$GATEWAY_URL" ]   && run_env+=("GATEWAY_URL=$GATEWAY_URL")
[ -n "$STATION_ID" ]    && run_env+=("STATION_ID=$STATION_ID")
[ -n "$OCPP_PROTOCOL" ] && run_env+=("OCPP_PROTOCOL=$OCPP_PROTOCOL")

if [ "$MODE" = docker ]; then
  # ── Docker path ─────────────────────────────────────────────────────────
  have docker || die "Docker not found. Install Docker or rerun with --node."
  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose v2 not found ('docker compose'). Update Docker."
  info "Building the container image"
  docker compose build
  ok "Image built"
  if [ "$DO_START" -eq 1 ]; then
    info "Starting (docker compose up -d)"
    env "${run_env[@]}" docker compose up -d
    ok "Running — dashboard at http://localhost:3100"
  else
    bold "Done. Start with:"
    echo "  ${run_env[*]:+${run_env[*]} }docker compose up -d --build"
  fi
else
  # ── Node path ───────────────────────────────────────────────────────────
  have node || die "Node.js $MIN_NODE_MAJOR+ not found. Install it or rerun with --docker."
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge "$MIN_NODE_MAJOR" ] \
    || die "Node.js $MIN_NODE_MAJOR+ required (found $(node -v))."
  have npm || die "npm not found."
  info "Installing dependencies (npm install)"
  npm install --no-audit --no-fund
  ok "Dependencies installed"
  if [ "$DO_START" -eq 1 ]; then
    info "Starting (npm start)"
    exec env "${run_env[@]}" npm start
  else
    bold "Done. Start with:"
    echo "  ${run_env[*]:+${run_env[*]} }npm start"
  fi
fi
