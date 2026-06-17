# OCPP Charger Simulator

Multi-protocol (OCPP 1.6 + 2.0.1) charger simulator for the Spotside CSMS.
A single Node process spawns up to **10 virtual chargers** against one CSMS
gateway, exposes a small HTTP API on `:3100` and a live dashboard at `/`.

No physical hardware needed — use it to exercise charging flows, RemoteStart,
SetChargingProfile/DLM and firmware-quirk reproductions end to end.

---

## Requirements

- **Docker** (recommended) — nothing else needed, **or**
- **Node.js 20+** for the local run.

The only runtime dependency is [`ws`](https://www.npmjs.com/package/ws).

---

## Install & run

### Quickest — one-line installer

```bash
# Fresh machine (clones, installs, prints how to run):
curl -fsSL https://raw.githubusercontent.com/jthomazinho/ocpp-simulator/main/install.sh | bash

# …or clone+install+start in one go, auto-connecting a charger to a gateway:
curl -fsSL https://raw.githubusercontent.com/jthomazinho/ocpp-simulator/main/install.sh \
  | bash -s -- --gateway ws://<csms-gateway-host>:8081 --start
```

`install.sh` auto-detects Docker (preferred) or Node, fetches the repo and sets
everything up. Run `./install.sh --help` for all flags
(`--docker`/`--node`, `--dir`, `--gateway`, `--station`, `--protocol`, `--start`).

### Option A — Docker (recommended)

```bash
git clone <repo> && cd ocpp-simulator    # or just copy this folder
GATEWAY_URL=ws://<csms-gateway-host>:8081 docker compose up -d --build
```

On startup it auto-connects **one** charger to the gateway (see
[Configuration](#configuration)). Open the dashboard:

- Local: <http://localhost:3100>
- From another machine on the LAN: `http://<HOST_IP>:3100`

Logs / stop:

```bash
docker compose logs -f ocpp-simulator
docker compose down
```

### Option B — Node (local)

```bash
npm install          # installs `ws`
npm start            # runs on :3100  (or: node simulator.js --port 3100)
```

Then open <http://localhost:3100> and add a charger from the dashboard
(or auto-start one via env — see below).

### Option C — helper script

```bash
./start.sh           # Node on :3100
./start.sh 4000      # Node on a custom port
./start.sh --docker  # Docker, network-accessible
```

---

## Configuration

Set these environment variables to **auto-spawn one charger on startup** that
immediately connects to the gateway (works for both Docker and Node):

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_URL` | _(unset)_ | CSMS gateway WebSocket URL, e.g. `ws://localhost:8081`. **Required to auto-start.** |
| `STATION_ID` | `EVR-SIMULATOR-001` | Station id the charger registers with. |
| `OCPP_PROTOCOL` | `2.0.1` | `1.6` or `2.0.1`. |
| `OCPP_BASIC_AUTH` | _(unset)_ | `user:password` for gateways that require Basic auth. |

```bash
# Node, OCPP 1.6 charger against a local gateway:
GATEWAY_URL=ws://localhost:8081 OCPP_PROTOCOL=1.6 npm start
```

If `GATEWAY_URL` is **not** set the simulator still boots — you just add
chargers manually from the dashboard or the API:

```bash
curl -X POST http://localhost:3100/api/chargers \
  -H 'Content-Type: application/json' \
  -d '{"stationId":"sim-1","gatewayUrl":"ws://localhost:8081","protocol":"2.0.1"}'
```

The dashboard also offers ready-made gateway presets (`local`, staging, …).

> **Docker → host gateway:** the compose file maps
> `host.gateway.docker.internal` to the host, so a gateway running on your
> machine is reachable as `ws://host.gateway.docker.internal:8081` from the
> container (this is the default `GATEWAY_URL`).

---

## RemoteStart response behaviour (OCPP 1.6)

Each 1.6 charger instance carries a `remoteStartBehavior` knob that
controls how it answers `RemoteStartTransaction`:

| Value | Effect |
|---|---|
| `accept` (default) | CALLRESULT `{status:"Accepted"}` + normal charging flow |
| `reject` | CALLRESULT `{status:"Rejected"}`, no charging — reproduces the OVROD DY answer to a RemoteStart with a wrong `connectorId` (2026-06-11) |
| `silent-drop` | No CALLRESULT at all, then drops the websocket ~5s later — reproduces the OVROD DY behaviour when the cable is unplugged (2026-06-11) |

Set it per charger at runtime:

```bash
curl -X POST http://localhost:3100/api/chargers/<stationId>/set-remote-start-behavior \
  -H 'Content-Type: application/json' \
  -d '{"behavior":"reject"}'
```

Use this to exercise the CSMS paths that fail a paid QR session (and
enqueue its refund) when the charger rejects or never answers the
remote start.

## DY-mode (SetChargingProfile unit semantics)

Each charger instance carries an `electrical` config that controls
how `SetChargingProfile` is interpreted at runtime. Knobs:

| Knob | Values | Default | Effect |
|---|---|---|---|
| `unitMode` | `W`, `A`, `both` | `both` | Which `chargingRateUnit` the charger advertises. `both` is the legacy permissive behaviour. |
| `wrongUnitBehavior` | `reject`, `silentIgnore` | `silentIgnore` | What to do when the inbound unit is not in `unitMode`. `silentIgnore` reproduces the OVROD DY pre-2026-05-21 bug: status=Accepted, profile persisted in memory, runtime ignores. |
| `nominalVoltage` | int | `230` | Used to convert A↔W when the active profile is in the other unit. |
| `phases` | `1`, `3` | `1` | Same. |

Process-level defaults can be set via CLI:

```bash
node simulator.js --unit-mode A --wrong-unit-behavior silentIgnore \
  --voltage 230 --phases 1
```

Per-charger overrides at runtime:

```bash
curl -X POST http://localhost:3100/api/chargers/<stationId>/set-electrical \
  -H 'Content-Type: application/json' \
  -d '{"unitMode":"A","wrongUnitBehavior":"silentIgnore"}'
```

### What gets honoured

When a profile passes the unit check, the simulator stores the cap
(converted to Watts) and starts honouring it immediately:

- `MeterValues` `Power.Active.Import` reflects the cap (kW).
- `MeterValues` `Current.Import` is derived from `powerW / (voltage × phases)`.
- `Energy.Active.Import.Register` integrates the cap, so cumulative
  consumption matches the published power.
- The cap expires after `duration` seconds; the meter then reverts to
  the connector's rated power.
- `ClearChargingProfile` resets the cap.

When the unit check fails and `wrongUnitBehavior=silentIgnore`, the
charger responds `status=Accepted` and the profile is appended to
`state.chargingProfiles` (so `GetChargingProfiles` still surfaces it),
but the runtime keeps reporting the previous power — exactly what the
OVROD DY firmware did pre-fix.

### Repro for the DY pre-fix scenario

```bash
# 1. Bring up a 1.6 charger with the same constraints the DY had.
curl -X POST http://localhost:3100/api/chargers \
  -H 'Content-Type: application/json' \
  -d '{"stationId":"sim-dy-1","gatewayUrl":"ws://localhost:8092","protocol":"1.6"}'

curl -X POST http://localhost:3100/api/chargers/sim-dy-1/set-electrical \
  -H 'Content-Type: application/json' \
  -d '{"unitMode":"A","wrongUnitBehavior":"silentIgnore","nominalVoltage":220,"phases":1}'

# 2. Dispatch a profile in W from the CSMS DLM debug endpoint.
#    Expected: simulator returns Accepted, but Power.Active.Import in the
#    next MeterValues tick stays at the rated power.
#
# 3. Dispatch a profile in A. Expected: cap honoured, Current.Import
#    matches A=<limit>, Power = A × V.
```
