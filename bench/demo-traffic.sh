#!/usr/bin/env bash
# Background charging traffic for the demo fleet of the Spotside LAB.
#
# Runs every few minutes (systemd timer). During opening hours in Lisbon it
# starts card sessions on idle guns and stops sessions that have charged long
# enough, so the dashboard always shows guns charging, revenue for the day and
# a realistic history. Energy only grows in real time inside the harness
# (11 kW per gun): the CSMS holds billing for energy faster than the charger
# rating, so no session is fast-forwarded here.
#
# Config (env file passed by systemd):
#   TRAFFIC_PORTS   control ports of the dualgun-sim processes, space separated
#   TRAFFIC_TOKENS  RFID uids to badge with, space separated
#   TRAFFIC_FAULTED optional "port:evse" kept in Faulted (shows the fault tab)
#   TRAFFIC_HOURS   opening hours in Lisbon time, "start-end" (default 07-22)
#   TRAFFIC_STATE   file with "port:evse epoch-started minutes-to-charge"
set -uo pipefail

PORTS=${TRAFFIC_PORTS:?}
read -r -a TOKENS <<<"${TRAFFIC_TOKENS:?}"
FAULTED=${TRAFFIC_FAULTED:-}
HOURS=${TRAFFIC_HOURS:-07-22}
STATE=${TRAFFIC_STATE:-/opt/ocppsim/stations/traffic.state}
touch "$STATE"

now=$(date +%s)
hour=$((10#$(TZ=Europe/Lisbon date +%H)))
open_from=$((10#${HOURS%-*})); open_to=$((10#${HOURS#*-}))
is_open=0; (( hour >= open_from && hour < open_to )) && is_open=1

log() { echo "$(date -u +%FT%TZ) $*"; }

for port in $PORTS; do
  st=$(curl -s --max-time 5 "127.0.0.1:$port/state") || continue
  [[ $(jq -r .connected <<<"$st") == true ]] || { log "port $port offline"; continue; }
  for evse in 1 2; do
    key="$port:$evse"
    if [[ $key == "$FAULTED" ]]; then
      # Re-assert the fault: a reconnect reports every gun Available again.
      [[ $(jq -r ".evses[] | select(.id==$evse) | .status" <<<"$st") == Faulted ]] ||
        { curl -s --max-time 10 "127.0.0.1:$port/status?evse=$evse&s=Faulted" >/dev/null; log "$key faulted"; }
      continue
    fi
    tx=$(jq -r ".evses[] | select(.id==$evse) | .transactionId // empty" <<<"$st")
    if [[ -n $tx ]]; then
      line=$(grep "^$key " "$STATE")
      started=$(awk '{print $2}' <<<"$line"); minutes=$(awk '{print $3}' <<<"$line")
      # A session the state file does not know about gets a fresh budget.
      [[ -z $started ]] && { started=$now; minutes=$((20 + RANDOM % 50)); echo "$key $started $minutes" >>"$STATE"; }
      if (( now - started >= minutes * 60 )) || (( ! is_open && now - started >= 20 * 60 )); then
        curl -s --max-time 15 "127.0.0.1:$port/stop?evse=$evse" >/dev/null && log "$key stop after $(((now - started) / 60)) min"
        sed -i "\|^$key |d" "$STATE"
      fi
    elif (( is_open )) && (( RANDOM % 100 < 30 )); then
      token=${TOKENS[RANDOM % ${#TOKENS[@]}]}
      res=$(curl -s --max-time 20 "127.0.0.1:$port/badge?evse=$evse&token=$token")
      if [[ $(jq -r '.transactionId // empty' <<<"$res") != "" ]]; then
        sed -i "\|^$key |d" "$STATE"
        echo "$key $now $((20 + RANDOM % 50))" >>"$STATE"
        log "$key start token=$token"
      else
        log "$key badge refused: $res"
      fi
    fi
  done
done
