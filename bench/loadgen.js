#!/usr/bin/env node
/**
 * OCPP load generator for the gateway load test (card 69c5b5e7).
 *
 * Opens N station websockets (security profile 1, Basic Auth), a mix of
 * OCPP 2.0.1 and 1.6 stations (--mix16 = fraction on 1.6). Each station:
 * BootNotification -> StatusNotification -> Heartbeat every interval ->
 * MeterValues every --meter seconds. A fraction (--tx) starts a local
 * transaction at boot (2.0.1 TransactionEvent Started / 1.6 StartTransaction)
 * and sends periodic meter values inside it.
 *
 * Inbound commands change the station state like a real charger:
 *   2.0.1 RequestStartTransaction -> Accepted + TransactionEvent Started
 *         (triggerReason RemoteStart, remoteStartId and idToken echoed);
 *         RequestStopTransaction -> Accepted + TransactionEvent Ended when
 *         the transactionId is the running one, Rejected otherwise.
 *   1.6   RemoteStartTransaction -> Accepted + StartTransaction (idTag
 *         echoed); RemoteStopTransaction -> Accepted + StopTransaction for
 *         the running transactionId, Rejected otherwise.
 * Every inbound call and every transaction start/stop is logged with a
 * timestamp, so the command -> effect latency can be read.
 *
 * A dropped socket reconnects with jittered backoff (1..30 s) honouring
 * Retry-After; the time until every station is back is reported.
 *
 * usage: node bench/loadgen.js --url ws://host:8081 [--url16 ws://host:8092]
 *        [--mix16 0.3] --prefix 7300881 --count 100 [--start 1] [--ramp 20]
 *        [--tx 0.2] [--meter 60] [--out stats.jsonl]
 * env:   LT_PW = station Basic Auth password
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const URL201 = arg('url', 'ws://192.168.240.26:8081');
const URL16 = arg('url16', 'ws://192.168.240.26:8092');
const MIX16 = Number(arg('mix16', '0'));
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
  txStarted: 0,
  txStopped: 0,
  txFailed: 0,
  lastAllRegisteredAt: null,
};
let registered = 0;
const bump = (bag, key) => (bag[key] = (bag[key] || 0) + 1);
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const now = () => new Date().toISOString();

class Station {
  constructor(id, protocol, txAtBoot) {
    this.id = id;
    this.protocol = protocol; // 'ocpp2.0.1' | 'ocpp1.6'
    this.txAtBoot = txAtBoot;
    this.tx = null; // { id, idToken, remoteStartId? }
    this.pending = new Map();
    this.timers = [];
    this.attempt = 0;
    this.energy = Math.floor(Math.random() * 100000);
    this.seq = 0;
  }

  get is16() {
    return this.protocol === 'ocpp1.6';
  }

  connect() {
    const auth = Buffer.from(`${this.id}:${PW}`).toString('base64');
    const base = this.is16 ? URL16 : URL201;
    this.ws = new WebSocket(`${base}/${this.id}`, [this.protocol], {
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
    const boot = this.is16
      ? {
          chargePointVendor: 'Everest',
          chargePointModel: 'AC Wallbox 22',
          chargePointSerialNumber: this.id,
          firmwareVersion: '1.4.2',
        }
      : {
          chargingStation: {
            model: 'AC Wallbox 22',
            vendorName: 'Everest',
            serialNumber: this.id,
            firmwareVersion: '1.4.2',
          },
          reason: 'PowerUp',
        };
    this.boot(boot, t0);
  }

  // Like firmware: a Boot that is not Accepted (timeout, Pending, Rejected)
  // is sent again after the interval the CSMS asked for (or 30 s), so a
  // connected station always ends up registered or keeps trying.
  boot(boot, t0) {
    this.call('BootNotification', boot).then((res) => {
      if (!this.up) return;
      if (res?.status !== 'Accepted') {
        bump(stats.errors, `boot:${res?.status ?? 'timeout'}`);
        const wait = Math.max(10, Number(res?.interval) || 30) * 1000 * (0.5 + Math.random());
        this.timers.push(setTimeout(() => this.boot(boot, Date.now()), wait));
        return;
      }
      stats.bootMs.push(Date.now() - t0);
      stats.bootAccepted += 1;
      if (!this.registered) {
        this.registered = true;
        registered += 1;
        if (registered === COUNT) stats.lastAllRegisteredAt = Date.now();
      }
      const interval = Math.max(30, Number(res.interval) || 60);
      this.status(this.tx || this.txAtBoot ? 'Occupied' : 'Available');
      this.every(interval * 1000, () => this.call('Heartbeat', {}));
      if (this.txAtBoot && !this.tx) {
        this.txAtBoot = false;
        this.startTx({ idToken: `LT${this.id.slice(-8)}`, trigger: 'Authorized' });
      }
      this.every(METER_S * 1000, () => this.meter());
    });
  }

  status(s) {
    if (this.is16) {
      const map = { Available: 'Available', Occupied: 'Charging' };
      return this.call('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: map[s],
        timestamp: now(),
      });
    }
    return this.call('StatusNotification', {
      timestamp: now(),
      connectorStatus: s,
      evseId: 1,
      connectorId: 1,
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

  async startTx({ idToken, trigger, remoteStartId }) {
    if (this.is16) {
      this.tx = { id: null, idToken };
      const res = await this.call('StartTransaction', {
        connectorId: 1,
        idTag: idToken,
        meterStart: this.energy,
        timestamp: now(),
      });
      if (!res || res.transactionId === undefined || res.idTagInfo?.status !== 'Accepted') {
        // A charger stops a transaction the CSMS did not accept.
        if (res?.transactionId !== undefined) {
          this.call('StopTransaction', { transactionId: res.transactionId, meterStop: this.energy, timestamp: now(), reason: 'DeAuthorized' });
        }
        this.tx = null;
        bump(stats.errors, res ? `tx16:idTag:${res.idTagInfo?.status}` : 'tx16:no-response');
        return this.txFailed('start', trigger);
      }
      this.tx.id = res.transactionId;
    } else {
      this.tx = { id: crypto.randomUUID(), idToken };
      const res = await this.call('TransactionEvent', {
        eventType: 'Started',
        timestamp: now(),
        triggerReason: trigger,
        seqNo: this.seq++,
        transactionInfo: { transactionId: this.tx.id, chargingState: 'Charging', ...(remoteStartId !== undefined ? { remoteStartId } : {}) },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken, type: trigger === 'RemoteStart' ? 'Central' : 'ISO14443' },
      });
      if (!res || (res.idTokenInfo && res.idTokenInfo.status !== 'Accepted')) {
        // Not accepted (or no answer): the transaction ends right away.
        const failedId = this.tx.id;
        this.tx = null;
        bump(stats.errors, res ? `tx201:idToken:${res.idTokenInfo.status}` : 'tx201:no-response');
        if (res) {
          this.call('TransactionEvent', {
            eventType: 'Ended', timestamp: now(), triggerReason: 'Deauthorized', seqNo: this.seq++,
            transactionInfo: { transactionId: failedId, chargingState: 'Idle', stoppedReason: 'DeAuthorized' },
            evse: { id: 1, connectorId: 1 },
          });
        }
        return this.txFailed('start', trigger);
      }
    }
    stats.txStarted += 1;
    log({ ev: 'tx', station: this.id, protocol: this.protocol, kind: 'started', trigger, txId: this.tx?.id, at: Date.now() });
    this.status('Occupied');
  }

  txFailed(kind, why) {
    stats.txFailed += 1;
    log({ ev: 'tx', station: this.id, protocol: this.protocol, kind: `${kind}-failed`, why, at: Date.now() });
  }

  async stopTx(reason) {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    let res;
    if (this.is16) {
      res = await this.call('StopTransaction', {
        transactionId: tx.id,
        meterStop: this.energy,
        timestamp: now(),
        reason,
      });
    } else {
      res = await this.call('TransactionEvent', {
        eventType: 'Ended',
        timestamp: now(),
        triggerReason: reason === 'Remote' ? 'RemoteStop' : 'StopAuthorized',
        seqNo: this.seq++,
        transactionInfo: { transactionId: tx.id, chargingState: 'Idle', stoppedReason: reason },
        evse: { id: 1, connectorId: 1 },
      });
    }
    // Only an answered stop counts; a timeout or CALLERROR is a failure.
    if (!res) return this.txFailed('stop', reason);
    stats.txStopped += 1;
    log({ ev: 'tx', station: this.id, protocol: this.protocol, kind: 'stopped', reason, txId: tx.id, at: Date.now() });
    this.status('Available');
  }

  meter() {
    this.energy += 180 + Math.floor(Math.random() * 40);
    if (this.is16) {
      const sampledValue = [
        { value: String(this.energy), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        { value: String(this.tx ? 11000 : 0), measurand: 'Power.Active.Import', unit: 'W' },
      ];
      return this.call('MeterValues', {
        connectorId: 1,
        ...(this.tx?.id !== undefined && this.tx?.id !== null ? { transactionId: this.tx.id } : {}),
        meterValue: [{ timestamp: now(), sampledValue }],
      });
    }
    const sampledValue = [
      { value: this.energy, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } },
      { value: this.tx ? 11000 : 0, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
    ];
    const meterValue = [{ timestamp: now(), sampledValue }];
    if (this.tx) {
      return this.call('TransactionEvent', {
        eventType: 'Updated',
        timestamp: now(),
        triggerReason: 'MeterValuePeriodic',
        seqNo: this.seq++,
        transactionInfo: { transactionId: this.tx.id, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue,
      });
    }
    return this.call('MeterValues', { evseId: 1, meterValue });
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

  reply(id, payload) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify([3, id, payload]));
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
    if (type !== 2) return;
    const action = msg[2];
    const payload = msg[3] || {};
    bump(stats.inbound, action);
    log({ ev: 'inbound', station: this.id, protocol: this.protocol, action, at: Date.now() });

    switch (action) {
      case 'RequestStartTransaction': // 2.0.1
      case 'RemoteStartTransaction': {
        // 1.6
        if (this.tx) return this.reply(id, { status: 'Rejected' });
        this.reply(id, { status: 'Accepted' });
        const idToken = this.is16 ? payload.idTag : payload.idToken?.idToken;
        this.startTx({ idToken, trigger: 'RemoteStart', remoteStartId: payload.remoteStartId });
        return;
      }
      case 'RequestStopTransaction':
      case 'RemoteStopTransaction': {
        const matches = this.tx && String(this.tx.id) === String(payload.transactionId);
        this.reply(id, { status: matches ? 'Accepted' : 'Rejected' });
        if (matches) this.stopTx('Remote');
        return;
      }
      case 'GetVariables':
        return this.reply(id, { getVariableResult: [] });
      case 'SetVariables':
        return this.reply(id, { setVariableResult: [] });
      case 'GetConfiguration':
        return this.reply(id, { configurationKey: [], unknownKey: [] });
      default:
        return this.reply(id, { status: 'Accepted' });
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
    if (this.registered) {
      this.registered = false;
      registered -= 1;
    }
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

// Deterministic protocol split so a station id always uses the same port
// (the gateway registers a station under one protocol).
const stations = [];
for (let i = 0; i < COUNT; i++) {
  const n = START + i;
  const id = PREFIX + String(n).padStart(16 - PREFIX.length, '0');
  const protocol = (n % 100) < MIX16 * 100 ? 'ocpp1.6' : 'ocpp2.0.1';
  stations.push(new Station(id, protocol, Math.random() < TX_FRACTION));
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
    connected16: stations.filter((s) => s.up && s.is16).length,
    registered,
    lastAllRegisteredAt: stats.lastAllRegisteredAt,
    txFailed: stats.txFailed,
    everConnected: stats.everConnected,
    bootAccepted: stats.bootAccepted,
    inTx: stations.filter((s) => s.tx).length,
    txStarted: stats.txStarted,
    txStopped: stats.txStopped,
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
  // Percentiles over the last 10 s window only.
  stats.callMs = [];
}, 10000);

// Lets a test driver ask which stations are in a transaction (and with
// which id) to aim a RemoteStop: SIGUSR2 dumps them to the stats file.
process.on('SIGUSR2', () => {
  log({
    ev: 'txdump',
    at: Date.now(),
    tx: stations.filter((s) => s.tx && s.tx.id !== null).map((s) => ({ station: s.id, protocol: s.protocol, txId: s.tx.id })),
    idle: stations.filter((s) => s.up && !s.tx).map((s) => ({ station: s.id, protocol: s.protocol })).slice(0, 200),
  });
});

process.on('SIGINT', () => {
  stopping = true;
  for (const s of stations) s.ws?.close();
  setTimeout(() => process.exit(0), 1500);
});

// A generator bug must not end the run silently: log it in the stats file
// (and count it) and keep the other stations going.
for (const evt of ['unhandledRejection', 'uncaughtException']) {
  process.on(evt, (err) => {
    bump(stats.errors, `generator:${evt}`);
    log({ ev: 'generator-error', kind: evt, message: String(err?.stack || err).slice(0, 2000), at: Date.now() });
  });
}
