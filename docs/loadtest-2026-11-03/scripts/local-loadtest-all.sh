#!/usr/bin/env bash
# Runs every tier in both configurations (card 69c5b5e7 re-run, 2026-11-03):
#   asis  = LAB gateway image release-2026-10-30-tabelab, Sequelize pool default (5), no guard
#   fixed = gateway main + fix/gateway-ws-protection + fix/gateway-crash-on-pool-timeout,
#           BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX=20, CITRINEOS_WS_UPGRADES_PER_SECOND=20 (burst 50)
# Fleet 100% OCPP 2.0.1 (decision of 03/11: Power chargers are 2.0.1 or newer);
# 20% in transaction at boot; ramp 50/s.
set -uo pipefail
S=/home/jthomazinho/data/spotside/csms/scripts
CF=$HOME/.config/spotside/lt-stack/docker-compose.json
C="docker compose -f $CF"
config() {
  python3 - "$1" <<'PY'
import json,sys,os
p=os.path.expanduser('~/.config/spotside/lt-stack/docker-compose.json')
d=json.load(open(p)); e=d['services']['citrineos']['environment']
if sys.argv[1]=='asis':
    d['services']['citrineos']['image']='registry.gitlab.com/spotside/power/citrineos:release-2026-10-30-tabelab'
    for k in ('BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX','CITRINEOS_WS_UPGRADES_PER_SECOND','CITRINEOS_WS_UPGRADE_BURST'): e.pop(k,None)
else:
    d['services']['citrineos']['image']='csms-loadtest/citrineos:guard-crashfix'
    e.update({'BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX':'20','CITRINEOS_WS_UPGRADES_PER_SECOND':'20','CITRINEOS_WS_UPGRADE_BURST':'50'})
json.dump(d,open(p,'w'),indent=1)
PY
  $C up -d citrineos > /dev/null 2>&1
  $C restart citrineos > /dev/null 2>&1
  timeout 300 bash -c 'until (echo > /dev/tcp/127.0.0.1/18081) 2>/dev/null && (echo > /dev/tcp/127.0.0.1/18092) 2>/dev/null; do sleep 3; done'
  sleep 20
  echo "$(date -u +%T) config $1: $($C exec -T citrineos printenv BOOTSTRAP_CITRINEOS_DATABASE_POOL_MAX || echo pool-default)"
}
for CFG in asis fixed; do
  config $CFG
  for N in 100 500 1000 2000; do
    $S/local-loadtest-tier.sh "$CFG-$N" "$N" 50 0.2 0
    $C restart citrineos > /dev/null 2>&1; sleep 40
  done
done
echo ALL-DONE
