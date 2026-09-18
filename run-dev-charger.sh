#!/usr/bin/env bash
# Run one virtual charger locally, connected to the DEV/LAB CSMS at
# power.spotside.dev over the public OCPP endpoint.
#
#   STATION_ID=1200032211102416 OCPP_PASSWORD='<password>' ./run-dev-charger.sh
#
# Everything runs on this machine — the dashboard stays on http://localhost:3100
# and only the websocket leaves the box. No VPN: the Spotside full tunnel
# actually blocks power.spotside.dev (OVH), so the script refuses to start
# with it up.
set -euo pipefail
cd "$(dirname "$0")"

STATION_ID="${STATION_ID:-}"
GATEWAY_URL="${GATEWAY_URL:-wss://ocpp.power.spotside.dev/2.0.1}"
OCPP_PROTOCOL="${OCPP_PROTOCOL:-2.0.1}"
PORT="${PORT:-3100}"

# The station authenticates with its own id as the Basic Auth user, so either
# form works: OCPP_PASSWORD='<password>' or OCPP_BASIC_AUTH='<id>:<password>'.
if [ -z "${OCPP_BASIC_AUTH:-}" ] && [ -n "${OCPP_PASSWORD:-}" ]; then
  OCPP_BASIC_AUTH="${STATION_ID}:${OCPP_PASSWORD}"
fi
export OCPP_BASIC_AUTH

if [ -z "$STATION_ID" ]; then
  echo "STATION_ID is required — use the station id registered in the CSMS." >&2
  exit 2
fi
if [ -z "${OCPP_BASIC_AUTH:-}" ]; then
  echo "OCPP_PASSWORD (or OCPP_BASIC_AUTH) is required: the public endpoint runs" >&2
  echo "on OCPP security profile 1 and rejects an unauthenticated charger." >&2
  exit 2
fi

if ip -4 addr show tun0 >/dev/null 2>&1; then
  echo "The Spotside VPN (tun0) is up and full-tunnels away from OVH, so" >&2
  echo "power.spotside.dev is unreachable. Drop it first:" >&2
  echo "  nmcli con down Spotside_Server_joaothomazinho" >&2
  exit 2
fi

[ -d node_modules/ws ] || npm install --no-audit --no-fund >/dev/null

echo "Pre-flight: ${GATEWAY_URL}/${STATION_ID} (OCPP ${OCPP_PROTOCOL})"
node preflight.js "$STATION_ID" "$GATEWAY_URL" "$OCPP_PROTOCOL" "$OCPP_BASIC_AUTH"

PID=$(lsof -t -i :"$PORT" 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "Stopping process already on :$PORT (PID $PID)"
  kill "$PID" 2>/dev/null || true
  sleep 1
fi

echo "Dashboard: http://localhost:${PORT}"
STATION_ID="$STATION_ID" GATEWAY_URL="$GATEWAY_URL" OCPP_PROTOCOL="$OCPP_PROTOCOL" \
  exec node simulator.js --port "$PORT"
