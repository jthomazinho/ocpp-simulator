#!/usr/bin/env node
/**
 * OCPP 2.0.1 load generator for the gateway load test (card 69c5b5e7).
 *
 * Opens N station websockets (security profile 1, Basic Auth), each one:
 * BootNotification -> StatusNotification -> Heartbeat every interval ->
 * MeterValues every 60 s; a fraction runs a transaction (TransactionEvent
 * Started + Updated every 60 s). Inbound CSMS calls are answered Accepted
 * and their arrival is logged, so a RemoteStart/Reset latency can be read.
 * A dropped socket reconnects with jittered backoff; the time until every
 * station is back is reported, which is how the "gateway restart" scenario
 * is measured.
 *
 * usage: node bench/loadgen.js --url ws://host:8081 --prefix 7300881 --count 100
 *        [--start 1] [--ramp 20] [--tx 0.2] [--meter 60] [--out stats.jsonl]
 * env:   LT_PW = station Basic Auth password
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const URL = arg('url', 'ws://192.168.240.26:8081');
const PREFIX = arg('prefix', '7300881');
const COUNT = Number(arg('count', '10'));
const START = Number(arg('start', '1'));
const RAMP = Number(arg('ramp', '20')); // new connections per second
const TX_FRACTION = Number(arg('tx', '0.2'));
const METER_S = Number(arg('meter', '60'));
const OUT = arg('out', `loadgen-${Date.now()}.jsonl`);
const PW = process.env.LT_PW;
if (!PW) {
  console.error('LT_PW is required');
  process.exit(2);
}

const stats = {
  connected: 0,
  everConnected: 0,
  bootAccepted: 0,
  bootMs: [],
  callMs: [],
  errors: {},
  inbound: {},
  disconnects: 0,
  lastAllUpAt: null,
  lastDropAt: null,
};
const bump = (bag, key) => (bag[key] = (bag[key] || 0) + 1);
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

class Station {
  constructor(id, inTx) {
    this.id = id;
    this.inTx = inTx;
    this.pending = new Map();
    this.timers = [];
    this.attempt = 0;
    this.energy = Math.floor(Math.random() * 100000);
    this.seq = 0;
    this.txId = crypto.randomUUID();
  }

  connect() {
    const auth = Buffer.from(`${this.id}:${PW}`).toString('base64');
    this.ws = new WebSocket(`${URL}/${this.id}`, ['ocpp2.0.1'], {
      headers: { Authorization: `Basic ${auth}` },
      handshakeTimeout: 15000,
    });
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (m) => this.onMessage(m));
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', (e) => bump(stats.errors, `ws:${(e.message || '').slice(0, 60)}`));
    this.ws.on('unexpected-response', (req, res) => {
      bump(stats.errors, `http:${res.statusCode}`);
      // A listener here stops ws from closing the socket itself: abort the
      // handshake and honour Retry-After, like firmware would.
      this.retryAfterMs = Number(res.headers['retry-after'] || 0) * 1000;
      res.destroy();
      req.destroy();
      this.ws.terminate();
    });
  }

  onOpen() {
    this.attempt = 0;
    this.up = true;
    stats.connected += 1;
    if (!this.seen) {
      this.seen = true;
      stats.everConnected += 1;
    }
    if (stats.connected === COUNT) stats.lastAllUpAt = Date.now();
    const t0 = Date.now();
    this.call('BootNotification', {
      chargingStation: { model: 'AC Wallbox 22', vendorName: 'Everest', serialNumber: this.id, firmwareVersion: '1.4.2' },
      reason: 'PowerUp',
    }).then((res) => {
      stats.bootMs.push(Date.now() - t0);
      if (res?.status !== 'Accepted') return bump(stats.errors, `boot:${res?.status}`);
      stats.bootAccepted += 1;
      const interval = Math.max(30, Number(res.interval) || 60);
      this.call('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: this.inTx ? 'Occupied' : 'Available',
        evseId: 1,
        connectorId: 1,
      });
      this.every(interval * 1000, () => this.call('Heartbeat', {}));
      if (this.inTx) this.startTx();
      this.every(METER_S * 1000, () => this.meter());
    });
  }

  every(ms, fn) {
    // Spread the first tick so N stations do not fire in lockstep.
    const first = setTimeout(() => {
      fn();
      this.timers.push(setInterval(fn, ms));
    }, Math.random() * ms);
    this.timers.push(first);
  }

  startTx() {
    this.call('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: this.seq++,
      transactionInfo: { transactionId: this.txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: `LT${this.id.slice(-8)}`, type: 'ISO14443' },
    });
  }

  meter() {
    this.energy += 180 + Math.floor(Math.random() * 40);
    const sampledValue = [
      { value: this.energy, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } },
      { value: this.inTx ? 11000 : 0, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
    ];
    const meterValue = [{ timestamp: new Date().toISOString(), sampledValue }];
    if (this.inTx) {
      this.call('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'MeterValuePeriodic',
        seqNo: this.seq++,
        transactionInfo: { transactionId: this.txId, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue,
      });
    } else {
      this.call('MeterValues', { evseId: 1, meterValue });
    }
  }

  call(action, payload) {
    if (!this.up || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = crypto.randomUUID();
    const t0 = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        bump(stats.errors, `timeout:${action}`);
        resolve(null);
      }, 30000);
      this.pending.set(id, (res, err) => {
        clearTimeout(timer);
        stats.callMs.push(Date.now() - t0);
        if (err) bump(stats.errors, `callerror:${action}:${err}`);
        resolve(res);
      });
      this.ws.send(JSON.stringify([2, id, action, payload]));
    });
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return bump(stats.errors, 'badjson');
    }
    const [type, id] = msg;
    if (type === 3 || type === 4) {
      const cb = this.pending.get(id);
      this.pending.delete(id);
      if (cb) cb(type === 3 ? msg[2] : null, type === 4 ? msg[2] : null);
      return;
    }
    if (type === 2) {
      const action = msg[2];
      bump(stats.inbound, action);
      log({ ev: 'inbound', station: this.id, action, at: Date.now() });
      const answers = {
        GetVariables: { getVariableResult: [] },
        SetVariables: { setVariableResult: [] },
        GetBaseReport: { status: 'Accepted' },
      };
      this.ws.send(JSON.stringify([3, id, answers[action] || { status: 'Accepted' }]));
    }
  }

  onClose() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
    for (const cb of this.pending.values()) cb(null, 'closed');
    this.pending.clear();
    if (this.up) {
      stats.connected -= 1;
      stats.disconnects += 1;
      stats.lastDropAt = Date.now();
    }
    this.up = false;
    if (stopping) return;
    // Jittered exponential backoff, like real firmware (1 s .. 30 s).
    const backoff = Math.min(30000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random());
    const delay = Math.max(backoff, (this.retryAfterMs || 0) * (1 + Math.random()));
    this.retryAfterMs = 0;
    setTimeout(() => this.connect(), delay);
  }
}

const out = fs.createWriteStream(OUT, { flags: 'a' });
const log = (obj) => out.write(JSON.stringify(obj) + '\n');
let stopping = false;

const stations = [];
for (let i = 0; i < COUNT; i++) {
  const id = PREFIX + String(START + i).padStart(16 - PREFIX.length, '0');
  stations.push(new Station(id, Math.random() < TX_FRACTION));
}
let next = 0;
const rampTimer = setInterval(() => {
  for (let k = 0; k < RAMP && next < stations.length; k++) stations[next++].connect();
  if (next >= stations.length) clearInterval(rampTimer);
}, 1000);

const started = Date.now();
setInterval(() => {
  const snap = {
    ev: 'stats',
    t: Math.round((Date.now() - started) / 1000),
    connected: stats.connected,
    everConnected: stats.everConnected,
    bootAccepted: stats.bootAccepted,
    bootP50: pct(stats.bootMs, 50),
    bootP95: pct(stats.bootMs, 95),
    callP50: pct(stats.callMs, 50),
    callP95: pct(stats.callMs, 95),
    callP99: pct(stats.callMs, 99),
    calls: stats.callMs.length,
    disconnects: stats.disconnects,
    lastDropAt: stats.lastDropAt,
    lastAllUpAt: stats.lastAllUpAt,
    errors: stats.errors,
    inbound: stats.inbound,
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  };
  log(snap);
  console.log(JSON.stringify(snap));
  // Keep percentiles about the last window only.
  stats.callMs = stats.callMs.slice(-20000);
}, 10000);

process.on('SIGINT', () => {
  stopping = true;
  for (const s of stations) s.ws?.close();
  setTimeout(() => process.exit(0), 1500);
});
