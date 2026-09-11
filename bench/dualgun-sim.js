// Dual-gun OCPP 2.0.1 bench simulator: one station, two EVSEs, both with
// connectorId 1. Exercises the per-EVSE targeting of the CSMS (RemoteStart,
// dynamic load management) and the QR gun picker without hardware.
//
//   env: STATION_ID, OCPP_BASIC_AUTH ("<id>:<password>"), GATEWAY_URL
//   HTTP control plane on 127.0.0.1:3179
//     GET /state                          both EVSEs: status, energy, power, caps
//     GET /calls                          last calls received from the CSMS
//     GET /status?evse=1&s=Occupied       push a StatusNotification
//     GET /authorize?token=04B1C7D2       Authorize only, no transaction
//     GET /badge?evse=2&token=04B1C7D2    RFID tap: Authorize + local start
//     GET /meter?evse=1&kwh=3             fast-forward the energy register
//     GET /stop?evse=2                    end that EVSE's transaction
//     GET /mode?dy=1                      DY3225 firmware quirks on/off (see below)
//     GET /hold?evse=1&on=1               accept RequestStartTransaction but hold the start
//     GET /release?evse=1                 run the oldest held start now (a late start)
//     GET /reboot?stale=1                 reboot: BootNotification, transactions dropped;
//                                         stale=1 also replays a malformed Ended
//
//   DY mode (env DY_MODE=1 or /mode?dy=1) reproduces what the OVROD DY3225
//   (fw 1.0.1) did on the 2026-09-11 bench, which is what exposed the CSMS
//   dual-gun and billing defects:
//     - each gun keeps a LIFETIME odometer (gun 1 starts at 91.577 kWh, gun 2
//       at 12.300 kWh) instead of a per-transaction register;
//     - every TransactionEvent carries seqNo 0;
//     - `evse` is sent on the Started only (Updated/Ended omit it);
//     - standalone MeterValues keep flowing next to the TransactionEvents.
const WebSocket = require('ws');
const http = require('http');
const { randomUUID } = require('crypto');

const STATION = process.env.STATION_ID;
const BASE = (process.env.GATEWAY_URL || 'wss://ocpp.power.spotside.dev/2.0.1').replace(/\/+$/, '');
const AUTH = process.env.OCPP_BASIC_AUTH;
const WS_URL = `${BASE}/${STATION}`;

// Each gun: 11 kW nominal, three-phase 230 V — the shape of the DY3225 bench unit.
const RATED_W = 11000, VOLTAGE = 230, PHASES = 3;
const METER_PERIOD_MS = 20000;

// Lifetime odometers of the DY3225 bench guns (Wh), used in DY mode.
const DY_ODOMETER_WH = { 1: 91577, 2: 12300 };

const evse = (id) => ({
  id, status: 'Available', transactionId: null, seqNo: 0, meterWh: 0,
  idToken: null, cap: null, timer: null, profiles: [],
  hold: false, heldStarts: [],
});
const state = {
  connected: false, boot: null, evses: { 1: evse(1), 2: evse(2) }, calls: [], authorizations: [],
  dyMode: process.env.DY_MODE === '1',
};

// In DY mode the register is the gun's lifetime odometer.
function applyMode() {
  for (const e of Object.values(state.evses)) {
    if (state.dyMode && e.meterWh < DY_ODOMETER_WH[e.id]) e.meterWh = DY_ODOMETER_WH[e.id];
  }
}
applyMode();
const pending = new Map();
let ws;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function call(action, payload) {
  const id = randomUUID();
  ws.send(JSON.stringify([2, id, action, payload]));
  log('>>>', action, JSON.stringify(payload).slice(0, 300));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + action)); }, 30000);
  });
}

function statusNotification(evseId, status) {
  state.evses[evseId].status = status;
  return call('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: status,
    evseId: Number(evseId),
    connectorId: 1, // as duas pistolas usam connectorId 1 — o caso do DY3225
  });
}

// Effective power: honours the cap the CSMS set on that EVSE, if any.
function effectiveW(e) {
  if (!e.cap) return RATED_W;
  const w = e.cap.unit === 'A' ? e.cap.limit * VOLTAGE * PHASES : e.cap.limit;
  return Math.max(0, Math.min(RATED_W, w));
}

function meterSample(e, context = 'Sample.Periodic') {
  const powerW = effectiveW(e);
  const currentA = powerW / (VOLTAGE * PHASES);
  return [{
    timestamp: new Date().toISOString(),
    sampledValue: [
      { value: e.meterWh / 1000, measurand: 'Energy.Active.Import.Register', context, unitOfMeasure: { unit: 'kWh' } },
      { value: powerW, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
      { value: VOLTAGE, measurand: 'Voltage', unitOfMeasure: { unit: 'V' }, phase: 'L1' },
      { value: currentA, measurand: 'Current.Import', unitOfMeasure: { unit: 'A' }, phase: 'L1' },
    ],
  }];
}

function transactionEvent(e, eventType, triggerReason, extra = {}) {
  const seqNo = state.dyMode ? 0 : e.seqNo++;
  // A conformant charger may omit `evse` after the first event; the DY does.
  const withEvse = !state.dyMode || eventType === 'Started';
  return call('TransactionEvent', {
    eventType,
    timestamp: new Date().toISOString(),
    triggerReason,
    seqNo,
    transactionInfo: {
      transactionId: e.transactionId,
      chargingState: eventType === 'Ended' ? 'Idle' : 'Charging',
    },
    ...(withEvse ? { evse: { id: e.id, connectorId: 1 } } : {}),
    ...(e.idToken ? { idToken: e.idToken } : {}),
    // Real chargers tag the first/last reading of a transaction, which is what
    // the CSMS uses as the session baseline; without it the first interval of
    // energy is dropped from the bill.
    meterValue: meterSample(e, eventType === 'Started' ? 'Transaction.Begin'
      : eventType === 'Ended' ? 'Transaction.End' : 'Sample.Periodic'),
    ...extra,
  });
}

async function startTransaction(e, idToken, remoteStartId, triggerReason = 'RemoteStart') {
  if (e.transactionId) return;
  e.transactionId = randomUUID();
  e.idToken = idToken;
  e.seqNo = 0;
  // Per-transaction register, unless the DY's lifetime odometer is on.
  if (!state.dyMode) e.meterWh = 0;
  await statusNotification(e.id, 'Occupied');
  await transactionEvent(e, 'Started', triggerReason,
    remoteStartId ? { transactionInfo: { transactionId: e.transactionId, chargingState: 'Charging', remoteStartId } } : {});
  e.timer = setInterval(() => {
    e.meterWh += (effectiveW(e) * METER_PERIOD_MS) / 3600000;
    call('MeterValues', { evseId: e.id, meterValue: meterSample(e) }).catch(() => {});
    transactionEvent(e, 'Updated', 'MeterValuePeriodic').catch(() => {});
  }, METER_PERIOD_MS);
  log(`EVSE ${e.id}: transaction ${e.transactionId} started`);
}

async function stopTransaction(e, reason = 'Remote') {
  if (!e.transactionId) return;
  clearInterval(e.timer); e.timer = null;
  await transactionEvent(e, 'Ended', reason === 'Remote' ? 'RemoteStop' : 'StopAuthorized',
    { stoppedReason: reason });
  e.transactionId = null;
  e.idToken = null;
  await statusNotification(e.id, 'Available');
  log(`EVSE ${e.id}: transaction ended`);
}

function evseOfTransaction(txId) {
  return Object.values(state.evses).find((e) => e.transactionId === txId);
}

// --- RFID / badge ---------------------------------------------------------
// A badge tap is an Authorize followed (only when accepted) by a locally
// started transaction carrying the same idToken. This is the flow of a
// driver holding an RFID card, as opposed to the CSMS-driven RemoteStart.
async function authorize(idToken, type = 'ISO14443') {
  const res = await call('Authorize', { idToken: { idToken, type } });
  state.authorizations.push({ t: new Date().toISOString(), idToken, type, res });
  return res;
}

async function badgeStart(e, idToken, type = 'ISO14443') {
  const res = await authorize(idToken, type);
  const status = res?.idTokenInfo?.status;
  if (status !== 'Accepted') return { accepted: false, status, res };
  await startTransaction(e, { idToken, type }, undefined, 'Authorized');
  return { accepted: true, status, transactionId: e.transactionId };
}

function handleCall(action, payload) {
  state.calls.push({ t: new Date().toISOString(), action, payload });
  log('<<< CALL', action, JSON.stringify(payload).slice(0, 400));
  switch (action) {
    case 'RequestStartTransaction': {
      const e = state.evses[payload.evseId || 1];
      if (!e) return { status: 'Rejected' };
      if (e.hold) {
        // Accepted, but the Started only goes out on /release — the late
        // start the DY produced after its QR session had been closed.
        e.heldStarts.push({ idToken: payload.idToken, remoteStartId: payload.remoteStartId, t: new Date().toISOString() });
        log(`EVSE ${e.id}: start held (${e.heldStarts.length} waiting)`);
        return { status: 'Accepted' };
      }
      setTimeout(() => startTransaction(e, payload.idToken, payload.remoteStartId).catch((x) => log('start failed', x.message)), 500);
      return { status: 'Accepted' };
    }
    case 'RequestStopTransaction': {
      const e = evseOfTransaction(payload.transactionId);
      if (!e) return { status: 'Rejected' };
      setTimeout(() => stopTransaction(e).catch((x) => log('stop failed', x.message)), 500);
      return { status: 'Accepted' };
    }
    case 'SetChargingProfile': {
      const p = payload.chargingProfile || {};
      const sched = (p.chargingSchedule || [])[0] || {};
      const period = (sched.chargingSchedulePeriod || [])[0] || {};
      const target = payload.evseId === 0 ? Object.values(state.evses) : [state.evses[payload.evseId]];
      for (const e of target) {
        if (!e) continue;
        e.cap = { limit: period.limit, unit: sched.chargingRateUnit, profileId: p.id, purpose: p.chargingProfilePurpose };
        e.profiles.push({ t: new Date().toISOString(), ...e.cap, evseIdRequested: payload.evseId });
        log(`EVSE ${e.id}: cap ${period.limit} ${sched.chargingRateUnit} (profile ${p.id}, ${p.chargingProfilePurpose}) -> ${effectiveW(e)} W`);
      }
      return { status: 'Accepted' };
    }
    case 'SetVariables':
      return { setVariableResult: (payload.setVariableData || []).map((d) => ({
        attributeStatus: 'Accepted', component: d.component, variable: d.variable })) };
    case 'GetVariables':
      return { getVariableResult: (payload.getVariableData || []).map((d) => ({
        attributeStatus: 'Accepted', attributeValue: '0', component: d.component, variable: d.variable })) };
    case 'GetChargingProfiles': return { status: 'NoProfiles' };
    case 'GetLocalListVersion': return { versionNumber: 0 };
    case 'UnlockConnector': return { status: 'Unlocked' };
    default: return { status: 'Accepted' };
  }
}

function connect() {
  log('connecting to', WS_URL);
  ws = new WebSocket(WS_URL, ['ocpp2.0.1'], {
    headers: { Authorization: 'Basic ' + Buffer.from(AUTH, 'utf8').toString('base64') },
  });

  ws.on('open', async () => {
    state.connected = true;
    log('websocket open');
    try {
      state.boot = await call('BootNotification', {
        reason: 'PowerUp',
        chargingStation: {
          model: 'DGS-22 Dual', vendorName: 'Spotside Bench',
          firmwareVersion: '1.0.1', serialNumber: STATION,
        },
      });
      await statusNotification(1, 'Available');
      await statusNotification(2, 'Available');
      setInterval(() => call('Heartbeat', {}).catch(() => {}), 60000);
    } catch (e) { log('boot failed:', e.message); }
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const [type, id] = msg;
    if (type === 2) {
      const [, , action, payload] = msg;
      let res;
      try { res = handleCall(action, payload || {}); }
      catch (e) { ws.send(JSON.stringify([4, id, 'InternalError', e.message, {}])); return; }
      ws.send(JSON.stringify([3, id, res]));
    } else if (type === 3) {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.res(msg[2]); }
    } else if (type === 4) {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.rej(new Error(JSON.stringify(msg.slice(2)))); }
      log('<<< CALLERROR', JSON.stringify(msg.slice(2)));
    }
  });

  ws.on('close', (c) => { state.connected = false; log('closed', c); setTimeout(connect, 5000); });
  ws.on('error', (e) => log('ws error:', e.message));
  ws.on('unexpected-response', (_req, res) => log('handshake refused:', res.statusCode));
}

// Reboot: the socket stays up (a real reboot reconnects within seconds), but
// the station reports a fresh boot and every running transaction is lost.
// `stale` replays the malformed Ended the DY kept resending after its reboot
// (empty transactionId, empty idToken type, 1970 timestamp).
async function reboot(stale) {
  for (const e of Object.values(state.evses)) {
    clearInterval(e.timer); e.timer = null;
    e.transactionId = null; e.idToken = null;
  }
  state.boot = await call('BootNotification', {
    reason: 'PowerUp',
    chargingStation: { model: 'DGS-22 Dual', vendorName: 'Spotside Bench', firmwareVersion: '1.0.1', serialNumber: STATION },
  });
  await statusNotification(1, 'Occupied');
  await statusNotification(2, 'Occupied');
  if (!stale) return { boot: state.boot };
  const replay = await call('TransactionEvent', {
    eventType: 'Ended', timestamp: '1970-01-01T00:00:35.000Z', triggerReason: 'RemoteStop', seqNo: 0,
    idToken: { type: '', idToken: '' }, evse: { id: 1, connectorId: 1 },
    transactionInfo: { transactionId: '', stoppedReason: 'PowerLoss', chargingState: 'EVConnected', remoteStartId: 0 },
  }).then((r) => ({ ok: true, r }), (err) => ({ ok: false, err: err.message }));
  return { boot: state.boot, staleEnded: replay };
}

const view = () => ({
  connected: state.connected,
  dyMode: state.dyMode,
  evses: Object.values(state.evses).map((e) => ({
    id: e.id, status: e.status, transactionId: e.transactionId,
    kwh: +(e.meterWh / 1000).toFixed(3), powerW: e.transactionId ? effectiveW(e) : 0,
    cap: e.cap, profiles: e.profiles, hold: e.hold, heldStarts: e.heldStarts.length,
  })),
  calls: state.calls.length,
  authorizations: state.authorizations.slice(-5),
});

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/state') return res.end(JSON.stringify(view(), null, 1));
  if (u.pathname === '/calls') return res.end(JSON.stringify(state.calls.slice(-30), null, 1));
  if (u.pathname === '/status') {
    const e = u.searchParams.get('evse') || '1';
    statusNotification(e, u.searchParams.get('s') || 'Available')
      .then((r) => res.end(JSON.stringify({ ok: true, r })))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/authorize') {
    authorize(u.searchParams.get('token') || '', u.searchParams.get('type') || 'ISO14443')
      .then((r) => res.end(JSON.stringify(r)))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/badge') {
    const e = state.evses[u.searchParams.get('evse') || '1'];
    badgeStart(e, u.searchParams.get('token') || '', u.searchParams.get('type') || 'ISO14443')
      .then((r) => res.end(JSON.stringify(r)))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/meter') {
    // Fast-forward the energy register so a test does not have to wait for
    // real minutes of charging; the next MeterValues carries the new total.
    const e = state.evses[u.searchParams.get('evse') || '1'];
    const kwh = Number(u.searchParams.get('kwh') || '0');
    if (!e || !Number.isFinite(kwh)) return res.end(JSON.stringify({ ok: false }));
    e.meterWh += kwh * 1000;
    const push = call('MeterValues', { evseId: e.id, meterValue: meterSample(e) })
      .then(() => transactionEvent(e, 'Updated', 'MeterValuePeriodic'));
    push.then(() => res.end(JSON.stringify({ ok: true, kwh: +(e.meterWh / 1000).toFixed(4) })))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/mode') {
    state.dyMode = u.searchParams.get('dy') === '1';
    applyMode();
    return res.end(JSON.stringify(view(), null, 1));
  }
  if (u.pathname === '/hold') {
    const e = state.evses[u.searchParams.get('evse') || '1'];
    if (!e) return res.end(JSON.stringify({ ok: false }));
    e.hold = u.searchParams.get('on') !== '0';
    return res.end(JSON.stringify({ ok: true, evse: e.id, hold: e.hold, heldStarts: e.heldStarts.length }));
  }
  if (u.pathname === '/release') {
    const e = state.evses[u.searchParams.get('evse') || '1'];
    const held = e && e.heldStarts.shift();
    if (!held) return res.end(JSON.stringify({ ok: false, err: 'nothing held' }));
    startTransaction(e, held.idToken, held.remoteStartId)
      .then(() => res.end(JSON.stringify({ ok: true, released: held, transactionId: e.transactionId })))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/reboot') {
    reboot(u.searchParams.get('stale') === '1')
      .then((r) => res.end(JSON.stringify(r)))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  if (u.pathname === '/stop') {
    const e = state.evses[u.searchParams.get('evse') || '1'];
    stopTransaction(e, 'Local').then(() => res.end(JSON.stringify({ ok: true })))
      .catch((err) => res.end(JSON.stringify({ ok: false, err: err.message })));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
}).listen(3179, '127.0.0.1', () => log('control plane on 127.0.0.1:3179'));

connect();
