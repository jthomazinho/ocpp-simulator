#!/usr/bin/env bash
# One load-test tier against the local copy of the LAB stack (card 69c5b5e7).
# usage: local-loadtest-tier.sh <label> <stations> [ramp_per_s] [tx_fraction] [mix16]
# Stack on cores 0-3 (compose cpuset), generator pinned to cores 8-15.
# Phases: ramp (until every station booted, max 10 min) -> 120 s steady ->
# RemoteStart/RemoteStop on 2.0.1 and 1.6 stations -> gateway restart until
# every station is back (max 10 min) -> 60 s settle.
set -uo pipefail
LABEL=$1; N=$2; RAMP=${3:-50}; TX=${4:-0.2}; MIX16=${5:-0.3}
ROOT=/home/jthomazinho/data/spotside/csms
OUT=$ROOT/md/loadtest-2026-11-03/$LABEL
C="docker compose -f $HOME/.config/spotside/lt-stack/docker-compose.json"
mkdir -p "$OUT"; rm -f "$OUT"/*.jsonl
set -a; . "$HOME/.config/spotside/loadtest.env"; set +a
TOKEN=$($C exec -T csms-backend printenv CITRINEOS_API_TOKEN)

last() { grep '"ev":"stats"' "$OUT/loadgen.jsonl" 2>/dev/null | tail -1 || echo '{}'; }
field() { last | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1') or 0)"; }
now_ms() { date +%s%3N; }
note() { echo "{\"ev\":\"note\",\"at\":$(now_ms),\"msg\":\"$*\"}" >> "$OUT/events.jsonl"; echo "$(date -u +%T) $*"; }

"$ROOT/scripts/local-loadtest-metrics.sh" "$OUT/metrics.jsonl" & SAMPLER=$!
cd "$ROOT/ocpp-simulator"
taskset -c 8-15 node bench/loadgen.js --url ws://127.0.0.1:18081 --url16 ws://127.0.0.1:18092 \
  --mix16 "$MIX16" --count "$N" --ramp "$RAMP" --tx "$TX" --out "$OUT/loadgen.jsonl" > /dev/null 2>&1 & GEN=$!
T0=$(now_ms); note "start N=$N ramp=$RAMP tx=$TX mix16=$MIX16"

for _ in $(seq 1 60); do sleep 10; [ "$(field bootAccepted)" -ge "$N" ] && break; done
note "ramp done connected=$(field connected) booted=$(field bootAccepted) after $(( ($(now_ms)-T0)/1000 ))s"

sleep 120; note "steady 120s done"

# Commands through the CitrineOS API, on idle stations of each protocol.
api() { # version module action body station
  local t=$(now_ms)
  $C exec -T csms-backend node -e "
fetch('http://citrineos:8080/ocpp/$1/$2/$3?identifier=$5&tenantId=1',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer $TOKEN'},body:JSON.stringify($4)}).then(r=>r.text()).then(t=>console.log(t.slice(0,160)))" < /dev/null > /dev/null 2>&1
  echo "{\"ev\":\"cmd\",\"version\":\"$1\",\"action\":\"$3\",\"station\":\"$5\",\"sentAt\":$t}" >> "$OUT/events.jsonl"
}
kill -USR2 $GEN; sleep 2
read -r -a IDLE201 <<< "$(grep '"ev":"txdump"' "$OUT/loadgen.jsonl" | tail -1 | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join([x['station'] for x in d['idle'] if x['protocol']=='ocpp2.0.1'][:5]))")"
read -r -a IDLE16 <<< "$(grep '"ev":"txdump"' "$OUT/loadgen.jsonl" | tail -1 | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join([x['station'] for x in d['idle'] if x['protocol']=='ocpp1.6'][:5]))")"
for i in 0 1 2 3 4; do
  [ -n "${IDLE201[$i]:-}" ] && api 2.0.1 evdriver requestStartTransaction "{remoteStartId:$((i+1)),idToken:{idToken:'LTREMOTE$i',type:'Central'},evseId:1}" "${IDLE201[$i]}"
  [ -n "${IDLE16[$i]:-}" ] && api 1.6 evdriver remoteStartTransaction "{idTag:'LTR16$i',connectorId:1}" "${IDLE16[$i]}"
  sleep 2
done
sleep 10
kill -USR2 $GEN; sleep 2
grep '"ev":"txdump"' "$OUT/loadgen.jsonl" | tail -1 | python3 -c "
import json,sys
d=json.load(sys.stdin)
want=set('''${IDLE201[*]:-} ${IDLE16[*]:-}'''.split())
for x in d['tx']:
  if x['station'] in want: print(x['protocol'],x['station'],x['txId'])" > /tmp/lt/stop-targets.txt
while read -r PROTO ST TXID; do
  if [ "$PROTO" = "ocpp1.6" ]; then api 1.6 evdriver remoteStopTransaction "{transactionId:$TXID}" "$ST";
  else api 2.0.1 evdriver requestStopTransaction "{transactionId:'$TXID'}" "$ST"; fi
  sleep 1
done < /tmp/lt/stop-targets.txt
sleep 5; note "commands sent (stop targets: $(wc -l < /tmp/lt/stop-targets.txt))"

R=$(now_ms); note "restart gateway"
$C restart citrineos > /dev/null 2>&1
for _ in $(seq 1 120); do
  sleep 5
  UP=$(field lastAllUpAt); [ "$UP" -gt "$R" ] 2>/dev/null && [ "$(field connected)" -ge "$N" ] && break
done
UP=$(field lastAllUpAt)
if [ "$UP" -gt "$R" ] 2>/dev/null; then note "reconnect: all $N back after $(( (UP - R) / 1000 ))s"
else note "reconnect: NOT all back after 600s (connected=$(field connected))"; fi

sleep 60; note "end"
kill -INT $GEN 2>/dev/null; sleep 3; kill $SAMPLER 2>/dev/null
echo "done $OUT"
