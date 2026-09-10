#!/usr/bin/env node
/**
 * Everest OCPP Multi-Protocol Charger Simulator
 *
 * Manages up to 10 charger instances (OCPP 1.6 or 2.0.1) from a single
 * process and dashboard. Supports all messages handled by evcharger-ocppgateway.
 *
 * Usage:
 *   node simulator.js [--port 3100]
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HTTP_PORT = parseInt(arg('--port', '3100'), 10);
const MAX_CHARGERS = 10;

// ---------------------------------------------------------------------------
// Electrical / SetChargingProfile defaults
// ---------------------------------------------------------------------------
// Defaults applied to every new charger instance. The dashboard can flip
// these per-charger at runtime via POST /api/chargers/<id>/set-electrical.
//
// `unitMode`            Which `chargingRateUnit` the simulated charger
//                       advertises support for: 'W', 'A' or 'both'.
// `wrongUnitBehavior`   What happens when the unit does NOT match: either
//                       `reject` (clean OCPP Rejected response — what a
//                       spec-compliant charger should do) or `silentIgnore`
//                       (Accept, persist, but do NOT apply at runtime —
//                       which is exactly the OVROD DY pre-2026-05-21 bug
//                       and the one we want to be able to reproduce here).
// `nominalVoltage` /
// `phases`              Used to convert Amps ↔ Watts whenever the active
//                       profile is in the OTHER unit than internal state.
//                       230 V single-phase matches the OVROD DY setup.
const DEFAULT_ELECTRICAL = Object.freeze({
  unitMode: arg('--unit-mode', 'both'),
  wrongUnitBehavior: arg('--wrong-unit-behavior', 'silentIgnore'),
  nominalVoltage: parseInt(arg('--voltage', '230'), 10),
  phases: parseInt(arg('--phases', '1'), 10),
});

function freshElectricalConfig() {
  // Always return a writable copy so per-charger overrides don't leak
  // back into the frozen module-level defaults.
  return { ...DEFAULT_ELECTRICAL };
}

// Pulls the first non-null limit out of a charging schedule. OCPP 2.0.1
// nests `chargingSchedule` as an array of objects; OCPP 1.6 nests it as
// a single object under `csChargingProfiles`. Both expose
// `chargingSchedulePeriod[]` and the first period carries the limit our
// LoadBalancer sets — that's the one we honour here.
function readScheduleLimit(profile, version) {
  if (!profile) return null;
  const schedule =
    version === '1.6'
      ? profile.csChargingProfiles?.chargingSchedule ?? profile.chargingSchedule
      : Array.isArray(profile.chargingSchedule)
        ? profile.chargingSchedule[0]
        : profile.chargingSchedule;
  if (!schedule) return null;
  const period = Array.isArray(schedule.chargingSchedulePeriod)
    ? schedule.chargingSchedulePeriod[0]
    : null;
  if (!period || typeof period.limit !== 'number') return null;
  return {
    unit: schedule.chargingRateUnit || 'W',
    limit: period.limit,
    durationSeconds: typeof schedule.duration === 'number' ? schedule.duration : null,
  };
}

// Converts an OCPP schedule limit into Watts using the charger's
// electrical configuration. Symmetric: if the simulator's `unitMode` is
// 'W' but the inbound profile is in 'A' (or vice-versa), the conversion
// still runs so the runtime cap stays a single, common-unit value.
function scheduleLimitToWatts({ unit, limit }, electrical) {
  if (unit === 'W') return limit;
  if (unit === 'A') {
    const v = electrical.nominalVoltage || 230;
    const p = electrical.phases || 1;
    return Math.round(limit * v * p);
  }
  return null;
}

// True when the simulated charger advertises support for `unit`. The
// `'both'` mode is the legacy, no-restriction behaviour kept as the
// default so existing simulator users see no change.
function isUnitSupported(unit, electrical) {
  if (electrical.unitMode === 'both') return true;
  return electrical.unitMode === unit;
}

const OCPP_VERSIONS = ['1.6', '2.0.1'];
const DEFAULT_OCPP_VERSION = '2.0.1';

// Two gateway URL shapes are supported:
//   1. Legacy direct-port — CitrineOS exposes 2.0.1 on 8081 and 1.6 on 8092.
//      Path becomes <gatewayUrl>/<stationId> and the port is rewritten by
//      protocol when needed.
//   2. TLS proxy (staging/prod) — single base URL with TLS terminated at the
//      nginx fronting CitrineOS. Path becomes
//      <gatewayUrl>/api/ocpp/<version>/<stationId>. The Authorization header
//      with Basic Auth is read from OCPP_BASIC_AUTH (format "user:pass").
const OCPP_PORT_BY_VERSION = { '2.0.1': 8081, '1.6': 8092 };
const OCPP_PORT_REGEX = /:(8081|8092)(?=\/|$)/;

function isLegacyGatewayUrl(url) {
  return OCPP_PORT_REGEX.test(url);
}

function rewriteGatewayPortForVersion(url, version) {
  const targetPort = OCPP_PORT_BY_VERSION[version];
  if (!targetPort || !isLegacyGatewayUrl(url)) return url;
  try {
    return url.replace(OCPP_PORT_REGEX, ':' + targetPort);
  } catch {
    return url;
  }
}

function buildOcppPath(gatewayUrl, version, stationId) {
  const base = gatewayUrl.replace(/\/+$/, '');
  if (isLegacyGatewayUrl(base)) {
    return `${base}/${stationId}`;
  }
  // Proxy whose base path already carries the OCPP version (e.g. the LAB
  // nginx: wss://ocpp.power.spotside.dev/2.0.1/<stationId>) — append only
  // the station id instead of the staging-style /api/ocpp/<version> prefix.
  if (/\/(1\.6|2\.0\.1)$/.test(base)) {
    return `${base}/${stationId}`;
  }
  return `${base}/api/ocpp/${version}/${stationId}`;
}

function buildWebSocketOptions(gatewayUrl) {
  if (isLegacyGatewayUrl(gatewayUrl)) return undefined;
  const creds = process.env.OCPP_BASIC_AUTH;
  if (!creds) return undefined;
  const token = Buffer.from(creds, 'utf8').toString('base64');
  return { headers: { Authorization: `Basic ${token}` } };
}

const GATEWAY_PRESETS = {
  local: 'ws://localhost:8081',
  staging: 'wss://power-staging.spotside.com',
  stagingNode2: 'ws://192.168.34.202:8081',
};

// ---------------------------------------------------------------------------
// Charger Instance
// ---------------------------------------------------------------------------
// Standard OCPP connector types
const CONNECTOR_TYPES = [
  { id: 'cType2',  name: 'Type 2 (Mennekes)',  powerType: 'AC', maxPowerW: 22000, format: 'Cable' },
  { id: 'cType2S', name: 'Type 2 Socket',      powerType: 'AC', maxPowerW: 22000, format: 'Socket' },
  { id: 'cType1',  name: 'Type 1 (J1772)',     powerType: 'AC', maxPowerW: 7400,  format: 'Cable' },
  { id: 'cCCS2',   name: 'CCS2 (Combo 2)',     powerType: 'DC', maxPowerW: 100000, format: 'Cable' },
  { id: 'cCCS1',   name: 'CCS1 (Combo 1)',     powerType: 'DC', maxPowerW: 100000, format: 'Cable' },
  { id: 'cChaoJi', name: 'CHAdeMO',            powerType: 'DC', maxPowerW: 100000, format: 'Cable' },
  { id: 'cGBT',    name: 'GBT AC',             powerType: 'AC', maxPowerW: 27700, format: 'Cable' },
  { id: 'Other1',  name: 'Schuko (Domestic)',   powerType: 'AC', maxPowerW: 3700,  format: 'Socket' },
];
const DEFAULT_CONNECTOR_TYPE = CONNECTOR_TYPES[0]; // Type 2

class ChargerInstance {
  constructor(stationId, gatewayUrl, connectorTypeId) {
    this.stationId = stationId;
    this.gatewayUrl = gatewayUrl;
    this.protocol = '2.0.1';
    this.ocppWs = null;
    this.pendingCalls = new Map();
    const ct = CONNECTOR_TYPES.find((t) => t.id === connectorTypeId) || DEFAULT_CONNECTOR_TYPE;
    this.connectorType = ct;
    this.state = {
      connected: false,
      booted: false,
      heartbeatInterval: null,
      heartbeatSeconds: 60,
      connectorStatus: 'Available',
      transactionId: null,
      evseId: 1,
      connectorId: 1,
      meterWh: 0,
      meterInterval: null,
      chargingPowerW: ct.maxPowerW,
      idToken: { idToken: 'RFID0001', type: 'ISO14443' },
      logs: [],
      // Reservation tracking
      reservationId: null,
      // Firmware simulation
      firmwareStatus: 'Idle',
      // Local list version
      localListVersion: 0,
      // Monitoring
      monitoringData: [],
      // Installed certificates
      installedCerts: [],
      // Display messages
      displayMessages: [],
      // Charging profiles
      chargingProfiles: [],
      // Electrical configuration governing how SetChargingProfile is
      // accepted / interpreted at runtime. See `DEFAULT_ELECTRICAL`.
      electrical: freshElectricalConfig(),
      // Effective cap in Watts derived from the most recently honoured
      // profile. `null` means "no DLM cap, use rated power". When the
      // active profile expires, this resets to `null` and the meter
      // reverts to `chargingPowerW`.
      activeProfileLimitW: null,
      // Wall-clock expiry (ms) of the active profile. `null` means the
      // profile never expires.
      activeProfileExpiresAt: null,
    };
  }

  // Returns the cap honoured at runtime, in Watts. Reads the active
  // profile when present and non-expired; otherwise the rated power
  // configured for the connector. Centralised here so MeterValues
  // for both 1.6 and 2.0.1 stay in sync with SetChargingProfile.
  effectiveChargingPowerW() {
    if (
      this.state.activeProfileExpiresAt != null &&
      Date.now() > this.state.activeProfileExpiresAt
    ) {
      this.state.activeProfileLimitW = null;
      this.state.activeProfileExpiresAt = null;
    }
    if (this.state.activeProfileLimitW != null) {
      return Math.min(this.state.chargingPowerW, this.state.activeProfileLimitW);
    }
    return this.state.chargingPowerW;
  }

  // Applies a SetChargingProfile payload to the simulator's runtime
  // cap and returns a verdict the OCPP handler can map to a wire
  // status. Three outcomes:
  //   - { applied: true,  accepted: true  } → cap honoured at runtime.
  //   - { applied: false, accepted: true  } → silentIgnore mode; the
  //     charger acknowledges the profile but the current-control loop
  //     never reads it (reproduces the OVROD DY pre-fix behaviour).
  //   - { applied: false, accepted: false } → spec-clean rejection.
  applyChargingProfile(profile, version) {
    const schedule = readScheduleLimit(profile, version);
    if (!schedule) {
      // No usable schedule period — accept the profile envelope but
      // don't touch the cap. Mirrors what a real charger does when
      // the CSMS pushes a profile with no period it understands.
      return { applied: false, accepted: true, reason: 'NO_SCHEDULE' };
    }
    const electrical = this.state.electrical;
    if (!isUnitSupported(schedule.unit, electrical)) {
      if (electrical.wrongUnitBehavior === 'reject') {
        return { applied: false, accepted: false, reason: 'UNSUPPORTED_UNIT' };
      }
      // silentIgnore: persist the envelope so GetChargingProfiles still
      // surfaces it (the DY firmware also did this — it stored the W
      // profile in flash but the runtime never read it).
      this.state.chargingProfiles.push(profile);
      return { applied: false, accepted: true, reason: 'SILENT_IGNORE' };
    }
    const limitW = scheduleLimitToWatts(schedule, electrical);
    if (limitW == null) {
      return { applied: false, accepted: true, reason: 'UNKNOWN_UNIT' };
    }
    this.state.chargingProfiles.push(profile);
    this.state.activeProfileLimitW = Math.max(1, Math.round(limitW));
    this.state.activeProfileExpiresAt = schedule.durationSeconds
      ? Date.now() + schedule.durationSeconds * 1000
      : null;
    return {
      applied: true,
      accepted: true,
      limitW: this.state.activeProfileLimitW,
      expiresAt: this.state.activeProfileExpiresAt,
    };
  }

  // --- Logging ---
  log(direction, msg) {
    const entry = { ts: new Date().toISOString(), direction, msg };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) this.state.logs.shift();
    broadcastDashboard({ type: 'log', stationId: this.stationId, payload: entry });
    const arrow = direction === 'TX' ? '>>>' : direction === 'RX' ? '<<<' : '---';
    console.log(`[${this.stationId}] [${entry.ts}] ${arrow} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  // --- OCPP RPC ---
  sendCall(action, payload) {
    return new Promise((resolve, reject) => {
      if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      const messageId = randomUUID();
      const frame = [2, messageId, action, payload];
      this.ocppWs.send(JSON.stringify(frame));
      this.log('TX', { action, messageId, payload });

      const timer = setTimeout(() => {
        this.pendingCalls.delete(messageId);
        reject(new Error(`Timeout waiting for response to ${action}`));
      }, 30000);

      this.pendingCalls.set(messageId, { resolve, timer, action });
    });
  }

  sendCallResult(messageId, payload) {
    if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) return;
    const frame = [3, messageId, payload];
    this.ocppWs.send(JSON.stringify(frame));
    this.log('TX', { callResult: messageId, payload });
  }

  sendCallError(messageId, errorCode, errorDescription) {
    if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) return;
    const frame = [4, messageId, errorCode, errorDescription, {}];
    this.ocppWs.send(JSON.stringify(frame));
    this.log('TX', { callError: messageId, errorCode, errorDescription });
  }

  // =========================================================================
  // OCPP 2.0.1 — Charger → CSMS messages
  // =========================================================================

  // --- Boot & Connection ---
  async bootNotification() {
    const payload = {
      chargingStation: {
        model: 'Everest AC Wallbox',
        vendorName: 'Everest',
        serialNumber: this.stationId,
        firmwareVersion: '1.0.0-sim',
        modem: { iccid: '89550000000000000001', imsi: '234150000000001' },
      },
      reason: 'PowerUp',
    };
    const result = await this.sendCall('BootNotification', payload);
    if (result.status === 'Accepted') {
      this.state.booted = true;
      this.state.heartbeatSeconds = result.interval || 60;
      this.startHeartbeat();
      this.log('INFO', `Boot accepted. Heartbeat every ${this.state.heartbeatSeconds}s`);
      await this.statusNotification('Available');
    } else {
      this.log('INFO', `Boot rejected: ${result.status}`);
    }
    this.broadcastState();
    return result;
  }

  async heartbeat() {
    try {
      await this.sendCall('Heartbeat', {});
    } catch (e) {
      this.log('INFO', `Heartbeat failed: ${e.message}`);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.state.heartbeatInterval = setInterval(() => this.heartbeat(), this.state.heartbeatSeconds * 1000);
  }

  stopHeartbeat() {
    if (this.state.heartbeatInterval) {
      clearInterval(this.state.heartbeatInterval);
      this.state.heartbeatInterval = null;
    }
  }

  // --- Status ---
  async statusNotification(status) {
    this.state.connectorStatus = status;
    await this.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: status,
      evseId: this.state.evseId,
      connectorId: this.state.connectorId,
    });
    this.broadcastState();
  }

  // --- Authorization ---
  async authorize(idToken) {
    return await this.sendCall('Authorize', { idToken: idToken || this.state.idToken });
  }

  // --- Transactions ---
  async transactionEvent(eventType, triggerReason, extraPayload = {}) {
    if (eventType === 'Started') {
      this.state.transactionId = randomUUID();
    }
    const payload = {
      eventType,
      timestamp: new Date().toISOString(),
      triggerReason,
      seqNo: 0,
      transactionInfo: {
        transactionId: this.state.transactionId,
        chargingState: eventType === 'Ended' ? 'Idle' : 'Charging',
      },
      evse: { id: this.state.evseId, connectorId: this.state.connectorId },
      idToken: this.state.idToken,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: this.state.meterWh / 1000, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'kWh' } },
          { value: this.state.chargingPowerW, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
        ],
      }],
      ...extraPayload,
    };
    const result = await this.sendCall('TransactionEvent', payload);
    if (eventType === 'Ended') {
      this.state.transactionId = null;
    }
    this.broadcastState();
    return result;
  }

  async sendMeterValues() {
    if (!this.state.transactionId) return;
    // Honour the active SetChargingProfile cap when present; otherwise
    // revert to the connector's rated power. Current is derived from
    // the effective power and the configured electrical contract so a
    // cap dispatched in Amps (DY OVROD case) produces the same A
    // reading the real charger would emit.
    const powerW = this.effectiveChargingPowerW();
    const voltage = this.state.electrical.nominalVoltage || 230;
    const phases = this.state.electrical.phases || 1;
    const currentA = powerW / (voltage * phases);
    await this.sendCall('MeterValues', {
      evseId: this.state.evseId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: this.state.meterWh / 1000, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'kWh' } },
          { value: powerW, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
          { value: voltage, measurand: 'Voltage', unitOfMeasure: { unit: 'V' }, phase: 'L1' },
          { value: currentA, measurand: 'Current.Import', unitOfMeasure: { unit: 'A' }, phase: 'L1' },
        ],
      }],
    });
  }

  // --- Data Transfer ---
  async dataTransfer(vendorId, messageId, data) {
    return await this.sendCall('DataTransfer', {
      vendorId: vendorId || 'Everest',
      messageId: messageId || 'SimulatorTest',
      data: data || JSON.stringify({ test: true, timestamp: new Date().toISOString() }),
    });
  }

  // --- Firmware ---
  async firmwareStatusNotification(status) {
    this.state.firmwareStatus = status;
    const result = await this.sendCall('FirmwareStatusNotification', {
      status,
      requestId: 1,
    });
    this.broadcastState();
    return result;
  }

  async publishFirmwareStatusNotification(status) {
    return await this.sendCall('PublishFirmwareStatusNotification', {
      status,
      requestId: 1,
    });
  }

  // --- Diagnostics & Logging ---
  async logStatusNotification(status) {
    return await this.sendCall('LogStatusNotification', {
      status, // Uploaded | UploadFailure | Uploading | AcceptedCanceled | Idle | NotSupportedOperation | PermissionDenied | BadMessage
      requestId: 1,
    });
  }

  async securityEventNotification(type) {
    return await this.sendCall('SecurityEventNotification', {
      type: type || 'SettingSystemTime',
      timestamp: new Date().toISOString(),
      techInfo: `Simulated security event from ${this.stationId}`,
    });
  }

  async notifyEvent(eventType, trigger, component, variable, actualValue) {
    return await this.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      eventData: [{
        eventId: Math.floor(Math.random() * 10000),
        timestamp: new Date().toISOString(),
        trigger: trigger || 'Alerting',
        actualValue: actualValue || 'true',
        eventNotificationType: eventType || 'HardWiredNotification',
        component: component || { name: 'Connector', evse: { id: this.state.evseId, connectorId: this.state.connectorId } },
        variable: variable || { name: 'Available' },
      }],
    });
  }

  // --- Device Model & Reports ---
  async notifyReport(requestId, reportData) {
    return await this.sendCall('NotifyReport', {
      requestId: requestId || 1,
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      reportData: reportData || [{
        component: { name: 'ChargingStation' },
        variable: { name: 'Model' },
        variableAttribute: [{ type: 'Actual', value: 'Everest AC Wallbox', mutability: 'ReadOnly' }],
        variableCharacteristics: { dataType: 'string', supportsMonitoring: false },
      }, {
        component: { name: 'ChargingStation' },
        variable: { name: 'VendorName' },
        variableAttribute: [{ type: 'Actual', value: 'Everest', mutability: 'ReadOnly' }],
        variableCharacteristics: { dataType: 'string', supportsMonitoring: false },
      }, {
        component: { name: 'ChargingStation' },
        variable: { name: 'FirmwareVersion' },
        variableAttribute: [{ type: 'Actual', value: '1.0.0-sim', mutability: 'ReadOnly' }],
        variableCharacteristics: { dataType: 'string', supportsMonitoring: false },
      }, {
        component: { name: 'ChargingStation' },
        variable: { name: 'SerialNumber' },
        variableAttribute: [{ type: 'Actual', value: this.stationId, mutability: 'ReadOnly' }],
        variableCharacteristics: { dataType: 'string', supportsMonitoring: false },
      }],
    });
  }

  async notifyMonitoringReport(requestId) {
    return await this.sendCall('NotifyMonitoringReport', {
      requestId: requestId || 1,
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      monitor: this.state.monitoringData.length > 0 ? this.state.monitoringData : [{
        component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
        variable: { name: 'Available' },
        variableMonitoring: [{ id: 1, transaction: false, value: 0, type: 'PeriodicClockAligned', severity: 0 }],
      }],
    });
  }

  // --- Smart Charging ---
  async notifyChargingLimit(source) {
    return await this.sendCall('NotifyChargingLimit', {
      chargingLimit: {
        chargingLimitSource: source || 'EMS',
        isGridCritical: false,
      },
      evseId: this.state.evseId,
    });
  }

  async notifyEVChargingNeeds() {
    return await this.sendCall('NotifyEVChargingNeeds', {
      evseId: this.state.evseId,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: {
          energyAmount: 50000, // 50 kWh
          evMinCurrent: 6,
          evMaxCurrent: 32,
          evMaxVoltage: 230,
        },
      },
    });
  }

  async notifyEVChargingSchedule(scheduleId) {
    return await this.sendCall('NotifyEVChargingSchedule', {
      timeBase: new Date().toISOString(),
      evseId: this.state.evseId,
      chargingSchedule: {
        id: scheduleId || 1,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: this.state.chargingPowerW, numberPhases: 1 },
        ],
      },
    });
  }

  async clearedChargingLimit(source) {
    return await this.sendCall('ClearedChargingLimit', {
      chargingLimitSource: source || 'EMS',
      evseId: this.state.evseId,
    });
  }

  async reportChargingProfiles(requestId) {
    return await this.sendCall('ReportChargingProfiles', {
      requestId: requestId || 1,
      chargingLimitSource: 'CSO',
      evseId: this.state.evseId,
      tbc: false,
      chargingProfile: this.state.chargingProfiles.length > 0 ? this.state.chargingProfiles : [{
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [{
          id: 1,
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: this.state.chargingPowerW }],
        }],
      }],
    });
  }

  // --- Reservations ---
  async reservationStatusUpdate(reservationId, status) {
    return await this.sendCall('ReservationStatusUpdate', {
      reservationId: reservationId || this.state.reservationId || 1,
      reservationUpdateStatus: status || 'Expired',
    });
  }

  // --- Certificates ---
  async certificateSigned(status) {
    return await this.sendCall('CertificateSigned', {
      certificateSignedStatusEnumType: status || 'Accepted',
    });
  }

  async get15118EVCertificate() {
    return await this.sendCall('Get15118EVCertificate', {
      iso15118SchemaVersion: '2',
      action: 'Install',
      exiRequest: 'base64encodedEXIRequest==',
    });
  }

  async getCertificateStatus() {
    return await this.sendCall('GetCertificateStatus', {
      ocspRequestData: {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'base64hash==',
        issuerKeyHash: 'base64hash==',
        serialNumber: '01',
        responderURL: 'http://ocsp.example.com',
      },
    });
  }

  // --- Display & Customer Info ---
  async notifyDisplayMessages(requestId) {
    return await this.sendCall('NotifyDisplayMessages', {
      requestId: requestId || 1,
      tbc: false,
      messageInfo: this.state.displayMessages.length > 0
        ? this.state.displayMessages
        : [{ id: 1, priority: 'NormalCycle', message: { content: 'Simulator ready', language: 'en' }, state: 'Idle' }],
    });
  }

  async notifyCustomerInformation(requestId) {
    return await this.sendCall('NotifyCustomerInformation', {
      requestId: requestId || 1,
      data: JSON.stringify({
        stationId: this.stationId,
        model: 'Everest AC Wallbox',
        firmware: '1.0.0-sim',
        connectorStatus: this.state.connectorStatus,
      }),
      seqNo: 0,
      generatedAt: new Date().toISOString(),
      tbc: false,
    });
  }

  // --- Cost ---
  async costUpdated(totalCost) {
    return await this.sendCall('CostUpdated', {
      totalCost: totalCost || 0,
      transactionId: this.state.transactionId || 'no-transaction',
    });
  }

  // =========================================================================
  // High-level commands
  // =========================================================================
  async plugIn() {
    if (this.state.transactionId) return { error: 'Already charging' };
    await this.statusNotification('Occupied');
    return { ok: true };
  }

  async startCharging(idToken) {
    // A RemoteStart from the CSMS supersedes any dangling state — mirror real
    // hardware behavior and never refuse because of a stale transactionId.
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    this.state.transactionId = null;
    if (this.state.connectorStatus !== 'Occupied') {
      await this.statusNotification('Occupied');
    }
    // Persist the caller-supplied idToken (from RequestStartTransaction /
    // RemoteStartTransaction) into state BEFORE sending the Authorize and
    // TransactionEvent.Started calls. Otherwise the simulator would reply
    // with the stale default idToken (e.g. RFID0001) and the CSMS rejects
    // the transaction as "unauthorized" because the idToken does not match
    // the token registered at the `qr-charging/initiate` step.
    const effectiveIdToken = idToken || this.state.idToken;
    this.state.idToken = effectiveIdToken;
    const authResult = await this.authorize(effectiveIdToken);
    if (authResult?.idTokenInfo?.status !== 'Accepted') {
      this.log('INFO', `Authorization not accepted: ${JSON.stringify(authResult)}`);
    }
    await this.transactionEvent('Started', 'Authorized');
    this.state.meterInterval = setInterval(() => {
      // Energy delta uses the cap actually honoured at runtime (rated
      // power minus any active SetChargingProfile) so meterWh stays
      // consistent with the Power/Current we publish in MeterValues.
      this.state.meterWh += (this.effectiveChargingPowerW() / 3600) * 5;
      this.sendMeterValues().catch(() => {});
      this.broadcastState();
    }, 5000);
    return { ok: true, transactionId: this.state.transactionId };
  }

  async stopCharging() {
    if (!this.state.transactionId) return { error: 'No active transaction' };
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    await this.transactionEvent('Ended', 'StopAuthorized');
    await this.statusNotification('Available');
    this.state.meterWh = 0;
    return { ok: true };
  }

  async triggerFault() {
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    if (this.state.transactionId) {
      await this.transactionEvent('Ended', 'EVCommunicationLost');
      this.state.transactionId = null;
    }
    await this.statusNotification('Faulted');
    return { ok: true };
  }

  async clearFault() {
    await this.statusNotification('Available');
    return { ok: true };
  }

  // Simulate full firmware update lifecycle
  async simulateFirmwareUpdate() {
    const steps = ['Downloading', 'Downloaded', 'Installing', 'Installed'];
    for (const status of steps) {
      await this.firmwareStatusNotification(status);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: true };
  }

  // =========================================================================
  // Handle CSMS-initiated messages (CSMS → Charger)
  // =========================================================================
  handleIncomingCall(messageId, action, payload) {
    this.log('RX', { action, messageId, payload });
    switch (action) {
      // --- Connection & Control ---
      case 'Reset':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Reset requested: ${payload.type}`);
        setTimeout(async () => {
          if (this.state.transactionId) await this.stopCharging();
          this.disconnect();
          setTimeout(() => this.connect(), 3000);
        }, 1000);
        break;

      case 'ChangeAvailability':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Availability changed to: ${payload.operationalStatus}`);
        if (payload.operationalStatus === 'Inoperative') {
          this.statusNotification('Unavailable').catch(() => {});
        } else {
          this.statusNotification('Available').catch(() => {});
        }
        break;

      case 'UnlockConnector':
        this.sendCallResult(messageId, { status: 'Unlocked' });
        this.log('INFO', `Connector unlocked: EVSE ${payload.evseId} Connector ${payload.connectorId}`);
        break;

      case 'TriggerMessage':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Trigger requested: ${payload.requestedMessage}`);
        this._handleTriggerMessage(payload);
        break;

      // --- Transactions ---
      case 'RequestStartTransaction':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.startCharging(payload.idToken).catch((e) => this.log('INFO', `Remote start failed: ${e.message}`));
        break;

      case 'RequestStopTransaction':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.stopCharging().catch((e) => this.log('INFO', `Remote stop failed: ${e.message}`));
        break;

      case 'GetTransactionStatus':
        this.sendCallResult(messageId, {
          messagesInQueue: false,
          ongoingIndicator: !!this.state.transactionId,
        });
        break;

      case 'CostUpdated':
        this.sendCallResult(messageId, {});
        this.log('INFO', `Cost updated: ${payload.totalCost} for tx ${payload.transactionId}`);
        break;

      // --- Variables & Device Model ---
      case 'SetVariables':
        this.sendCallResult(messageId, {
          setVariableResult: (payload.setVariableData || []).map((v) => ({
            attributeStatus: 'Accepted',
            component: v.component,
            variable: v.variable,
          })),
        });
        break;

      case 'GetVariables':
        this.sendCallResult(messageId, {
          getVariableResult: (payload.getVariableData || []).map((v) => ({
            attributeStatus: 'Accepted',
            component: v.component,
            variable: v.variable,
            attributeValue: this._getSimulatedVariableValue(v.component, v.variable),
          })),
        });
        break;

      case 'GetBaseReport':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Base report requested (requestId: ${payload.requestId})`);
        setTimeout(() => this.notifyReport(payload.requestId).catch(() => {}), 500);
        break;

      case 'GetReport':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Report requested (requestId: ${payload.requestId})`);
        setTimeout(() => this.notifyReport(payload.requestId).catch(() => {}), 500);
        break;

      // --- Monitoring ---
      case 'SetVariableMonitoring':
        this.sendCallResult(messageId, {
          setMonitoringResult: (payload.setMonitoringData || []).map((m, i) => {
            this.state.monitoringData.push({
              component: m.component,
              variable: m.variable,
              variableMonitoring: [{ id: i + 1, transaction: m.transaction || false, value: m.value, type: m.type, severity: m.severity || 0 }],
            });
            return { id: i + 1, status: 'Accepted', type: m.type, severity: m.severity || 0, component: m.component, variable: m.variable };
          }),
        });
        break;

      case 'ClearVariableMonitoring':
        this.sendCallResult(messageId, {
          clearMonitoringResult: (payload.id || []).map((id) => ({
            id,
            status: 'Accepted',
          })),
        });
        this.state.monitoringData = [];
        break;

      case 'SetMonitoringBase':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Monitoring base set to: ${payload.monitoringBase}`);
        break;

      case 'SetMonitoringLevel':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Monitoring level set to: ${payload.severity}`);
        break;

      case 'GetMonitoringReport':
        this.sendCallResult(messageId, { status: 'Accepted' });
        setTimeout(() => this.notifyMonitoringReport(payload.requestId).catch(() => {}), 500);
        break;

      // --- Smart Charging ---
      case 'SetChargingProfile': {
        const verdict = this.applyChargingProfile(payload.chargingProfile, '2.0.1');
        this.sendCallResult(messageId, {
          status: verdict.accepted ? 'Accepted' : 'Rejected',
        });
        const purpose = payload.chargingProfile?.chargingProfilePurpose ?? 'unknown';
        if (verdict.applied) {
          this.log(
            'INFO',
            `Charging profile honoured (${purpose}): limit=${verdict.limitW}W` +
              (verdict.expiresAt
                ? ` until ${new Date(verdict.expiresAt).toISOString()}`
                : ' (no expiry)'),
          );
        } else if (verdict.accepted) {
          this.log(
            'INFO',
            `Charging profile accepted but NOT applied (${purpose}, reason=${verdict.reason})`,
          );
        } else {
          this.log(
            'INFO',
            `Charging profile rejected (${purpose}, reason=${verdict.reason})`,
          );
        }
        this.broadcastState();
        break;
      }

      case 'GetChargingProfiles':
        this.sendCallResult(messageId, { status: 'Accepted' });
        setTimeout(() => this.reportChargingProfiles(payload.requestId).catch(() => {}), 500);
        break;

      case 'ClearChargingProfile':
        this.state.chargingProfiles = [];
        this.state.activeProfileLimitW = null;
        this.state.activeProfileExpiresAt = null;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Charging profiles cleared');
        this.broadcastState();
        break;

      case 'GetCompositeSchedule':
        this.sendCallResult(messageId, {
          status: 'Accepted',
          schedule: {
            evseId: payload.evseId || 0,
            duration: payload.duration || 86400,
            scheduleStart: new Date().toISOString(),
            chargingRateUnit: payload.chargingRateUnit || 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: this.state.chargingPowerW, numberPhases: 1 },
            ],
          },
        });
        break;

      // --- Reservations ---
      case 'ReserveNow':
        this.state.reservationId = payload.id;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Reservation created: ID ${payload.id}, expires ${payload.expiryDateTime}`);
        break;

      case 'CancelReservation':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Reservation cancelled: ${payload.reservationId}`);
        this.state.reservationId = null;
        break;

      // --- Certificates ---
      case 'InstallCertificate':
        this.state.installedCerts.push({
          type: payload.certificateType,
          certificate: payload.certificate?.substring(0, 50) + '...',
        });
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Certificate installed: ${payload.certificateType}`);
        break;

      case 'DeleteCertificate':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Certificate deleted');
        break;

      case 'GetInstalledCertificateIds':
        this.sendCallResult(messageId, {
          status: 'Accepted',
          certificateHashDataChain: this.state.installedCerts.map((c, i) => ({
            certificateType: c.type || 'CSMSRootCertificate',
            certificateHashData: {
              hashAlgorithm: 'SHA256',
              issuerNameHash: 'simhash' + i,
              issuerKeyHash: 'simhash' + i,
              serialNumber: String(i + 1),
            },
          })),
        });
        break;

      case 'SignCertificate':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Certificate signing requested');
        setTimeout(() => this.certificateSigned('Accepted').catch(() => {}), 500);
        break;

      // --- Firmware ---
      case 'UpdateFirmware':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Firmware update requested: ${payload.firmware?.location}`);
        this.simulateFirmwareUpdate().catch(() => {});
        break;

      case 'PublishFirmware':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Firmware publish requested: ${payload.location}`);
        setTimeout(() => this.publishFirmwareStatusNotification('Downloaded').catch(() => {}), 1000);
        break;

      case 'UnpublishFirmware':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Firmware unpublished');
        break;

      // --- Logging ---
      case 'GetLog':
        this.sendCallResult(messageId, { status: 'Accepted', filename: `${this.stationId}-log.txt` });
        this.log('INFO', `Log upload requested: ${payload.logType}`);
        setTimeout(() => this.logStatusNotification('Uploaded').catch(() => {}), 2000);
        break;

      case 'CustomerInformation':
        this.sendCallResult(messageId, { status: 'Accepted' });
        setTimeout(() => this.notifyCustomerInformation(payload.requestId).catch(() => {}), 500);
        break;

      // --- Local Auth List ---
      case 'SendLocalList':
        this.state.localListVersion = payload.versionNumber || 0;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Local list updated: version ${payload.versionNumber}, type ${payload.updateType}`);
        break;

      case 'GetLocalListVersion':
        this.sendCallResult(messageId, { versionNumber: this.state.localListVersion });
        break;

      case 'ClearCache':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Cache cleared');
        break;

      // --- Display Messages ---
      case 'SetDisplayMessage':
        if (payload.message) {
          this.state.displayMessages.push(payload.message);
        }
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Display message set: ${payload.message?.message?.content}`);
        this.broadcastState();
        break;

      case 'GetDisplayMessages':
        this.sendCallResult(messageId, { status: 'Accepted' });
        setTimeout(() => this.notifyDisplayMessages(payload.requestId).catch(() => {}), 500);
        break;

      case 'ClearDisplayMessage':
        this.state.displayMessages = this.state.displayMessages.filter((m) => m.id !== payload.id);
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.broadcastState();
        break;

      // --- Network ---
      case 'SetNetworkProfile':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Network profile set: slot ${payload.configurationSlot}`);
        break;

      // --- Data Transfer ---
      case 'DataTransfer':
        this.sendCallResult(messageId, {
          status: 'Accepted',
          data: JSON.stringify({ received: true, stationId: this.stationId }),
        });
        this.log('INFO', `DataTransfer from CSMS: vendorId=${payload.vendorId}`);
        break;

      default:
        this.sendCallError(messageId, 'NotImplemented', `Action ${action} not supported by simulator`);
        break;
    }
  }

  _handleTriggerMessage(payload) {
    const msg = payload.requestedMessage;
    setTimeout(async () => {
      try {
        switch (msg) {
          case 'BootNotification': await this.bootNotification(); break;
          case 'Heartbeat': await this.heartbeat(); break;
          case 'StatusNotification': await this.statusNotification(this.state.connectorStatus); break;
          case 'MeterValues': await this.sendMeterValues(); break;
          case 'FirmwareStatusNotification': await this.firmwareStatusNotification(this.state.firmwareStatus); break;
          case 'LogStatusNotification': await this.logStatusNotification('Idle'); break;
          case 'TransactionEvent':
            if (this.state.transactionId) await this.transactionEvent('Updated', 'Trigger');
            break;
          default: this.log('INFO', `Trigger not implemented: ${msg}`); break;
        }
      } catch (e) {
        this.log('INFO', `Trigger ${msg} failed: ${e.message}`);
      }
    }, 200);
  }

  _getSimulatedVariableValue(component, variable) {
    const values = {
      'ChargingStation.Model': 'Everest AC Wallbox',
      'ChargingStation.VendorName': 'Everest',
      'ChargingStation.FirmwareVersion': '1.0.0-sim',
      'ChargingStation.SerialNumber': this.stationId,
      'Connector.Available': this.state.connectorStatus === 'Available' ? 'true' : 'false',
      'Connector.ConnectorType': 'cType2',
      'Connector.SupplyPhases': '1',
      'EVSE.AvailabilityState': this.state.connectorStatus,
      'EVSE.Power': String(this.state.chargingPowerW),
      'SmartChargingCtrlr.Enabled': 'true',
      'SmartChargingCtrlr.Available': 'true',
      'AuthCtrlr.Enabled': 'true',
      'SampledDataCtrlr.TxUpdatedInterval': '30',
      'OCPPCommCtrlr.HeartbeatInterval': String(this.state.heartbeatSeconds),
    };
    const key = `${component?.name || ''}.${variable?.name || ''}`;
    return values[key] || 'simulated-value';
  }

  // =========================================================================
  // WebSocket connection
  // =========================================================================
  connect() {
    const url = buildOcppPath(this.gatewayUrl, '2.0.1', this.stationId);
    this.log('INFO', `Connecting to ${url} ...`);

    this.ocppWs = new WebSocket(url, ['ocpp2.0.1'], buildWebSocketOptions(this.gatewayUrl));

    this.ocppWs.on('open', async () => {
      this.state.connected = true;
      this.log('INFO', 'WebSocket connected');
      this.broadcastState();
      try {
        await this.bootNotification();
      } catch (e) {
        this.log('INFO', `Boot failed: ${e.message}`);
      }
    });

    this.ocppWs.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.log('RX', `Invalid JSON: ${data}`);
        return;
      }

      const messageType = frame[0];
      if (messageType === 2) {
        this.handleIncomingCall(frame[1], frame[2], frame[3]);
      } else if (messageType === 3) {
        const msgId = frame[1];
        const pending = this.pendingCalls.get(msgId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(msgId);
          this.log('RX', { callResult: pending.action, messageId: msgId, payload: frame[2] });
          pending.resolve(frame[2]);
        }
      } else if (messageType === 4) {
        const msgId = frame[1];
        const pending = this.pendingCalls.get(msgId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(msgId);
          this.log('RX', { callError: pending.action, messageId: msgId, errorCode: frame[2], errorDescription: frame[3] });
          pending.resolve({ error: frame[2], description: frame[3] });
        }
      }
    });

    this.ocppWs.on('close', (code, reason) => {
      this.state.connected = false;
      this.state.booted = false;
      this.stopHeartbeat();
      this.log('INFO', `WebSocket closed: ${code} ${reason}`);
      this.broadcastState();
    });

    this.ocppWs.on('error', (err) => {
      this.log('INFO', `WebSocket error: ${err.message}`);
    });
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    if (this.ocppWs) {
      this.ocppWs.close();
      this.ocppWs = null;
    }
    this.state.connected = false;
    this.state.booted = false;
    this.state.transactionId = null;
    this.broadcastState();
  }

  destroy() {
    this.disconnect();
    this.state.logs = [];
  }

  broadcastState() {
    broadcastDashboard({
      type: 'state',
      stationId: this.stationId,
      payload: this.getStateSnapshot(),
    });
  }

  getStateSnapshot() {
    return {
      stationId: this.stationId,
      gatewayUrl: this.gatewayUrl,
      protocol: this.protocol,
      connected: this.state.connected,
      booted: this.state.booted,
      connectorStatus: this.state.connectorStatus,
      connectorType: this.connectorType,
      transactionId: this.state.transactionId,
      meterWh: Math.round(this.state.meterWh),
      meterKwh: (this.state.meterWh / 1000).toFixed(3),
      chargingPowerW: this.state.chargingPowerW,
      // Surfacing the runtime cap + electrical config lets the
      // dashboard show "honoured X W until Y" beside the rated power.
      effectiveChargingPowerW: this.effectiveChargingPowerW(),
      activeProfileLimitW: this.state.activeProfileLimitW,
      activeProfileExpiresAt: this.state.activeProfileExpiresAt,
      electrical: { ...this.state.electrical },
      firmwareStatus: this.state.firmwareStatus,
      reservationId: this.state.reservationId,
      localListVersion: this.state.localListVersion,
      displayMessages: this.state.displayMessages,
    };
  }
}

// ===========================================================================
// OCPP 1.6 Charger Instance
// ===========================================================================
// Standalone class implementing the OCPP 1.6 spec subset that the gateway
// (CitrineOS) accepts. Shares the same WebSocket framing pattern as the
// 2.0.1 class but uses the OCPP 1.6 message names and payload shapes.
class ChargerInstance16 {
  constructor(stationId, gatewayUrl, connectorTypeId) {
    this.stationId = stationId;
    this.gatewayUrl = rewriteGatewayPortForVersion(gatewayUrl, '1.6');
    this.protocol = '1.6';
    this.ocppWs = null;
    this.pendingCalls = new Map();
    const ct = CONNECTOR_TYPES.find((t) => t.id === connectorTypeId) || DEFAULT_CONNECTOR_TYPE;
    this.connectorType = ct;
    this.state = {
      connected: false,
      booted: false,
      heartbeatInterval: null,
      heartbeatSeconds: 60,
      connectorStatus: 'Available',  // Available|Preparing|Charging|SuspendedEV|SuspendedEVSE|Finishing|Reserved|Unavailable|Faulted
      transactionId: null,           // 1.6 uses integer transaction ids assigned by CSMS
      connectorId: 1,
      meterWh: 0,
      meterStartWh: 0,
      meterInterval: null,
      chargingPowerW: ct.maxPowerW,
      idTag: 'RFID0001',
      logs: [],
      reservationId: null,
      firmwareStatus: 'Idle',
      localListVersion: 0,
      // 1.6-specific configuration that CSMS may read/write
      configuration: {
        HeartbeatInterval: '60',
        MeterValueSampleInterval: '5',
        ConnectionTimeOut: '60',
        StopTransactionOnInvalidId: 'true',
        AuthorizeRemoteTxRequests: 'false',
        LocalAuthorizeOffline: 'true',
        LocalPreAuthorize: 'false',
        AllowOfflineTxForUnknownId: 'false',
        ResetRetries: '3',
        NumberOfConnectors: '1',
      },
      // Same shape as the 2.0.1 instance — see the comments on
      // `DEFAULT_ELECTRICAL` and `ChargerInstance.applyChargingProfile`.
      chargingProfiles: [],
      electrical: freshElectricalConfig(),
      activeProfileLimitW: null,
      activeProfileExpiresAt: null,
      // How the charger answers RemoteStartTransaction:
      //   accept      — normal behaviour (CALLRESULT Accepted + start charging)
      //   reject      — CALLRESULT {status:"Rejected"}, no charging (OVROD DY
      //                 2026-06-11 with wrong connectorId)
      //   silent-drop — no CALLRESULT at all, then drop the websocket a few
      //                 seconds later (OVROD DY 2026-06-11 with unplugged cable)
      remoteStartBehavior: 'accept',
    };
  }

  // Shared runtime cap accessor, mirroring the 2.0.1 implementation so
  // both classes feed MeterValues from the same source of truth.
  effectiveChargingPowerW() {
    if (
      this.state.activeProfileExpiresAt != null &&
      Date.now() > this.state.activeProfileExpiresAt
    ) {
      this.state.activeProfileLimitW = null;
      this.state.activeProfileExpiresAt = null;
    }
    if (this.state.activeProfileLimitW != null) {
      return Math.min(this.state.chargingPowerW, this.state.activeProfileLimitW);
    }
    return this.state.chargingPowerW;
  }

  // OCPP 1.6 entry point. The incoming payload nests the profile under
  // `csChargingProfiles`, which `readScheduleLimit` already handles.
  applyChargingProfile(profile, version) {
    const schedule = readScheduleLimit(profile, version);
    if (!schedule) {
      return { applied: false, accepted: true, reason: 'NO_SCHEDULE' };
    }
    const electrical = this.state.electrical;
    if (!isUnitSupported(schedule.unit, electrical)) {
      if (electrical.wrongUnitBehavior === 'reject') {
        return { applied: false, accepted: false, reason: 'UNSUPPORTED_UNIT' };
      }
      this.state.chargingProfiles.push(profile);
      return { applied: false, accepted: true, reason: 'SILENT_IGNORE' };
    }
    const limitW = scheduleLimitToWatts(schedule, electrical);
    if (limitW == null) {
      return { applied: false, accepted: true, reason: 'UNKNOWN_UNIT' };
    }
    this.state.chargingProfiles.push(profile);
    this.state.activeProfileLimitW = Math.max(1, Math.round(limitW));
    this.state.activeProfileExpiresAt = schedule.durationSeconds
      ? Date.now() + schedule.durationSeconds * 1000
      : null;
    return {
      applied: true,
      accepted: true,
      limitW: this.state.activeProfileLimitW,
      expiresAt: this.state.activeProfileExpiresAt,
    };
  }

  // --- Logging ---
  log(direction, msg) {
    const entry = { ts: new Date().toISOString(), direction, msg };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) this.state.logs.shift();
    broadcastDashboard({ type: 'log', stationId: this.stationId, payload: entry });
    const arrow = direction === 'TX' ? '>>>' : direction === 'RX' ? '<<<' : '---';
    console.log(`[${this.stationId}] [${entry.ts}] ${arrow} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  // --- OCPP 1.6 RPC framing (same JSON-RPC over WS as 2.0.1) ---
  sendCall(action, payload) {
    return new Promise((resolve, reject) => {
      if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }
      const messageId = randomUUID();
      const frame = [2, messageId, action, payload];
      this.ocppWs.send(JSON.stringify(frame));
      this.log('TX', { action, messageId, payload });

      const timer = setTimeout(() => {
        this.pendingCalls.delete(messageId);
        reject(new Error(`Timeout waiting for response to ${action}`));
      }, 30000);

      this.pendingCalls.set(messageId, { resolve, timer, action });
    });
  }

  sendCallResult(messageId, payload) {
    if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) return;
    const frame = [3, messageId, payload];
    this.ocppWs.send(JSON.stringify(frame));
    this.log('TX', { callResult: messageId, payload });
  }

  sendCallError(messageId, errorCode, errorDescription) {
    if (!this.ocppWs || this.ocppWs.readyState !== WebSocket.OPEN) return;
    const frame = [4, messageId, errorCode, errorDescription, {}];
    this.ocppWs.send(JSON.stringify(frame));
    this.log('TX', { callError: messageId, errorCode, errorDescription });
  }

  // =========================================================================
  // OCPP 1.6 — Charger → CSMS messages
  // =========================================================================

  async bootNotification() {
    // OCPP 1.6 string length constraints (CiString20Type / CiString25Type):
    //   chargePointVendor       <= 20
    //   chargePointModel        <= 20
    //   chargePointSerialNumber <= 25
    //   chargeBoxSerialNumber   <= 25
    //   firmwareVersion         <= 50
    //   iccid                   <= 20
    //   imsi                    <= 20
    //   meterType               <= 25
    //   meterSerialNumber       <= 25
    const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) : s);
    const payload = {
      chargePointVendor: 'Everest',
      chargePointModel: 'AC Wallbox Sim',
      chargePointSerialNumber: truncate(this.stationId, 25),
      chargeBoxSerialNumber: truncate(this.stationId, 25),
      firmwareVersion: '1.0.0-sim16',
      iccid: '89550000000000000001',
      imsi: '234150000000001',
      meterType: 'AC',
      meterSerialNumber: truncate('METER-' + this.stationId, 25),
    };
    const result = await this.sendCall('BootNotification', payload);
    if (result.status === 'Accepted') {
      this.state.booted = true;
      this.state.heartbeatSeconds = result.interval || 60;
      this.state.configuration.HeartbeatInterval = String(this.state.heartbeatSeconds);
      this.startHeartbeat();
      this.log('INFO', `Boot accepted. Heartbeat every ${this.state.heartbeatSeconds}s`);
      await this.statusNotification('Available');
    } else {
      this.log('INFO', `Boot rejected: ${result.status}`);
    }
    this.broadcastState();
    return result;
  }

  async heartbeat() {
    try {
      await this.sendCall('Heartbeat', {});
    } catch (e) {
      this.log('INFO', `Heartbeat failed: ${e.message}`);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.state.heartbeatInterval = setInterval(() => this.heartbeat(), this.state.heartbeatSeconds * 1000);
  }

  stopHeartbeat() {
    if (this.state.heartbeatInterval) {
      clearInterval(this.state.heartbeatInterval);
      this.state.heartbeatInterval = null;
    }
  }

  async statusNotification(status, errorCode = 'NoError') {
    this.state.connectorStatus = status;
    await this.sendCall('StatusNotification', {
      connectorId: this.state.connectorId,
      errorCode,
      status,
      timestamp: new Date().toISOString(),
    });
    this.broadcastState();
  }

  async authorize(idTag) {
    return await this.sendCall('Authorize', { idTag: idTag || this.state.idTag });
  }

  async startTransaction(idTag) {
    const payload = {
      connectorId: this.state.connectorId,
      idTag: idTag || this.state.idTag,
      meterStart: Math.round(this.state.meterStartWh),
      timestamp: new Date().toISOString(),
    };
    const result = await this.sendCall('StartTransaction', payload);
    if (result?.transactionId !== undefined) {
      this.state.transactionId = result.transactionId;
    }
    this.broadcastState();
    return result;
  }

  async stopTransaction(reason = 'Local') {
    if (this.state.transactionId == null) return { error: 'No active transaction' };
    const payload = {
      transactionId: this.state.transactionId,
      idTag: this.state.idTag,
      meterStop: Math.round(this.state.meterWh),
      timestamp: new Date().toISOString(),
      reason,
    };
    const result = await this.sendCall('StopTransaction', payload);
    this.state.transactionId = null;
    this.broadcastState();
    return result;
  }

  async sendMeterValues() {
    if (this.state.transactionId == null) return;
    // Same derivation as the 2.0.1 implementation: cap honoured at
    // runtime → power → current via the configured voltage/phases.
    const powerW = this.effectiveChargingPowerW();
    const voltage = this.state.electrical.nominalVoltage || 230;
    const phases = this.state.electrical.phases || 1;
    const currentA = powerW / (voltage * phases);
    await this.sendCall('MeterValues', {
      connectorId: this.state.connectorId,
      transactionId: this.state.transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: String(Math.round(this.state.meterWh)), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          { value: String(powerW), measurand: 'Power.Active.Import', unit: 'W' },
          { value: String(voltage), measurand: 'Voltage', unit: 'V', phase: 'L1' },
          { value: currentA.toFixed(2), measurand: 'Current.Import', unit: 'A', phase: 'L1' },
        ],
      }],
    });
  }

  async dataTransfer(vendorId, messageId, data) {
    return await this.sendCall('DataTransfer', {
      vendorId: vendorId || 'Everest',
      messageId: messageId || 'SimulatorTest',
      data: data || JSON.stringify({ test: true, timestamp: new Date().toISOString() }),
    });
  }

  async firmwareStatusNotification(status) {
    this.state.firmwareStatus = status;
    const result = await this.sendCall('FirmwareStatusNotification', { status });
    this.broadcastState();
    return result;
  }

  async diagnosticsStatusNotification(status) {
    return await this.sendCall('DiagnosticsStatusNotification', { status: status || 'Idle' });
  }

  // =========================================================================
  // High-level commands
  // =========================================================================
  async plugIn() {
    if (this.state.transactionId != null) return { error: 'Already charging' };
    await this.statusNotification('Preparing');
    return { ok: true };
  }

  async startCharging(idTag) {
    // Real chargers do not "early-return" when an old transaction is dangling
    // in their state — a RemoteStartTransaction supersedes whatever was there.
    // Clean up any stale meter loop / transactionId before starting fresh.
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    this.state.transactionId = null;
    if (this.state.connectorStatus !== 'Preparing') {
      await this.statusNotification('Preparing');
    }
    const authResult = await this.authorize(idTag || this.state.idTag);
    if (authResult?.idTagInfo?.status !== 'Accepted') {
      this.log('INFO', `Authorization not accepted: ${JSON.stringify(authResult)}`);
    }
    this.state.meterStartWh = this.state.meterWh;
    const startResult = await this.startTransaction(idTag || this.state.idTag);
    if (startResult?.idTagInfo?.status !== 'Accepted') {
      // Log loudly so the failure is visible, but DO NOT abort the charging
      // simulation — the CSMS now infers session lifecycle from
      // StatusNotification("Charging"), so we still want the connector to
      // progress and broadcast Charging + MeterValues. A real charger that
      // got Invalid here would refuse, but for local testing we want the
      // pipeline to flow regardless of the gateway's quirks.
      const reason = startResult?.idTagInfo?.status ?? 'unknown';
      console.warn(
        `[${this.stationId}] StartTransaction returned ${reason}; continuing in degraded mode (no transactionId).`,
      );
      this.log('WARN', `StartTransaction degraded: ${JSON.stringify(startResult)}`);
      // Fake a local transactionId so meterInterval/stop logic still works.
      this.state.transactionId = Date.now() % 1_000_000;
    }
    await this.statusNotification('Charging');
    this.state.meterInterval = setInterval(() => {
      // Honour the runtime cap so the cumulative energy reading
      // matches Power.Active.Import published in the same tick.
      this.state.meterWh += (this.effectiveChargingPowerW() / 3600) * 5;
      this.sendMeterValues().catch(() => {});
      this.broadcastState();
    }, 5000);
    return { ok: true, transactionId: this.state.transactionId };
  }

  async stopCharging(reason = 'Local') {
    if (this.state.transactionId == null) return { error: 'No active transaction' };
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    await this.statusNotification('Finishing');
    await this.stopTransaction(reason);
    await this.statusNotification('Available');
    this.state.meterWh = 0;
    this.state.meterStartWh = 0;
    return { ok: true };
  }

  async triggerFault() {
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    if (this.state.transactionId != null) {
      await this.stopTransaction('PowerLoss');
    }
    await this.statusNotification('Faulted', 'PowerSwitchFailure');
    return { ok: true };
  }

  async clearFault() {
    await this.statusNotification('Available');
    return { ok: true };
  }

  async simulateFirmwareUpdate() {
    const steps = ['Downloading', 'Downloaded', 'Installing', 'Installed'];
    for (const status of steps) {
      await this.firmwareStatusNotification(status);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: true };
  }

  // =========================================================================
  // Handle CSMS-initiated messages (CSMS → Charger) — OCPP 1.6
  // =========================================================================
  handleIncomingCall(messageId, action, payload) {
    this.log('RX', { action, messageId, payload });
    switch (action) {
      // --- Connection & Control ---
      case 'Reset':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Reset requested: ${payload.type}`);
        setTimeout(async () => {
          if (this.state.transactionId != null) await this.stopCharging('HardReset');
          this.disconnect();
          setTimeout(() => this.connect(), 3000);
        }, 1000);
        break;

      case 'ChangeAvailability':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Availability changed to: ${payload.type} (connector ${payload.connectorId})`);
        if (payload.type === 'Inoperative') {
          this.statusNotification('Unavailable').catch(() => {});
        } else {
          this.statusNotification('Available').catch(() => {});
        }
        break;

      case 'UnlockConnector':
        this.sendCallResult(messageId, { status: 'Unlocked' });
        this.log('INFO', `Connector unlocked: ${payload.connectorId}`);
        break;

      case 'TriggerMessage':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Trigger requested: ${payload.requestedMessage}`);
        this._handleTriggerMessage(payload);
        break;

      // --- Configuration ---
      case 'GetConfiguration': {
        const requestedKeys = payload.key && payload.key.length > 0 ? payload.key : Object.keys(this.state.configuration);
        const configurationKey = [];
        const unknownKey = [];
        for (const k of requestedKeys) {
          if (k in this.state.configuration) {
            configurationKey.push({ key: k, readonly: false, value: this.state.configuration[k] });
          } else {
            unknownKey.push(k);
          }
        }
        this.sendCallResult(messageId, { configurationKey, unknownKey });
        break;
      }

      case 'ChangeConfiguration': {
        const { key, value } = payload;
        if (!(key in this.state.configuration)) {
          this.sendCallResult(messageId, { status: 'NotSupported' });
          break;
        }
        this.state.configuration[key] = String(value);
        if (key === 'HeartbeatInterval') {
          this.state.heartbeatSeconds = parseInt(value, 10) || 60;
          this.startHeartbeat();
        }
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Configuration changed: ${key} = ${value}`);
        break;
      }

      // --- Transactions ---
      case 'RemoteStartTransaction':
        if (this.state.remoteStartBehavior === 'reject') {
          this.sendCallResult(messageId, { status: 'Rejected' });
          this.log('INFO', `Remote start REJECTED (remoteStartBehavior=reject), idTag ${payload.idTag}`);
          break;
        }
        if (this.state.remoteStartBehavior === 'silent-drop') {
          this.log('INFO', `Remote start IGNORED (remoteStartBehavior=silent-drop), dropping WS in 5s`);
          setTimeout(() => this.disconnect(), 5000);
          break;
        }
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.startCharging(payload.idTag).catch((e) => this.log('INFO', `Remote start failed: ${e.message}`));
        break;

      case 'RemoteStopTransaction':
        if (this.state.transactionId !== payload.transactionId) {
          this.sendCallResult(messageId, { status: 'Rejected' });
          this.log('INFO', `Remote stop rejected: tx ${payload.transactionId} not active`);
          break;
        }
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.stopCharging('Remote').catch((e) => this.log('INFO', `Remote stop failed: ${e.message}`));
        break;

      // --- Reservations ---
      case 'ReserveNow':
        this.state.reservationId = payload.reservationId;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Reservation: id ${payload.reservationId}, idTag ${payload.idTag}, expires ${payload.expiryDate}`);
        this.statusNotification('Reserved').catch(() => {});
        break;

      case 'CancelReservation':
        if (this.state.reservationId === payload.reservationId) {
          this.state.reservationId = null;
          this.sendCallResult(messageId, { status: 'Accepted' });
          this.log('INFO', `Reservation cancelled: ${payload.reservationId}`);
          this.statusNotification('Available').catch(() => {});
        } else {
          this.sendCallResult(messageId, { status: 'Rejected' });
        }
        break;

      // --- Local Auth List ---
      case 'GetLocalListVersion':
        this.sendCallResult(messageId, { listVersion: this.state.localListVersion });
        break;

      case 'SendLocalList':
        this.state.localListVersion = payload.listVersion || 0;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', `Local list updated: version ${payload.listVersion}, type ${payload.updateType}`);
        break;

      case 'ClearCache':
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Cache cleared');
        break;

      // --- Smart Charging ---
      case 'SetChargingProfile': {
        const verdict = this.applyChargingProfile(payload, '1.6');
        this.sendCallResult(messageId, {
          status: verdict.accepted ? 'Accepted' : 'Rejected',
        });
        const purpose =
          payload.csChargingProfiles?.chargingProfilePurpose ?? 'unknown';
        if (verdict.applied) {
          this.log(
            'INFO',
            `Charging profile honoured (${purpose}, connector ${payload.connectorId}): limit=${verdict.limitW}W` +
              (verdict.expiresAt
                ? ` until ${new Date(verdict.expiresAt).toISOString()}`
                : ' (no expiry)'),
          );
        } else if (verdict.accepted) {
          this.log(
            'INFO',
            `Charging profile accepted but NOT applied (${purpose}, connector ${payload.connectorId}, reason=${verdict.reason})`,
          );
        } else {
          this.log(
            'INFO',
            `Charging profile rejected (${purpose}, connector ${payload.connectorId}, reason=${verdict.reason})`,
          );
        }
        this.broadcastState();
        break;
      }

      case 'ClearChargingProfile':
        this.state.chargingProfiles = [];
        this.state.activeProfileLimitW = null;
        this.state.activeProfileExpiresAt = null;
        this.sendCallResult(messageId, { status: 'Accepted' });
        this.log('INFO', 'Charging profile cleared');
        this.broadcastState();
        break;

      case 'GetCompositeSchedule':
        this.sendCallResult(messageId, {
          status: 'Accepted',
          connectorId: payload.connectorId,
          scheduleStart: new Date().toISOString(),
          chargingSchedule: {
            duration: payload.duration || 86400,
            startSchedule: new Date().toISOString(),
            chargingRateUnit: payload.chargingRateUnit || 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: this.state.chargingPowerW, numberPhases: 1 },
            ],
          },
        });
        break;

      // --- Firmware ---
      case 'UpdateFirmware':
        this.sendCallResult(messageId, {});
        this.log('INFO', `Firmware update requested: ${payload.location}`);
        this.simulateFirmwareUpdate().catch(() => {});
        break;

      case 'GetDiagnostics':
        this.sendCallResult(messageId, { fileName: `${this.stationId}-diag.txt` });
        this.log('INFO', `Diagnostics requested: ${payload.location}`);
        setTimeout(() => this.diagnosticsStatusNotification('Uploaded').catch(() => {}), 2000);
        break;

      // --- Data Transfer ---
      case 'DataTransfer':
        this.sendCallResult(messageId, {
          status: 'Accepted',
          data: JSON.stringify({ received: true, stationId: this.stationId }),
        });
        this.log('INFO', `DataTransfer from CSMS: vendorId=${payload.vendorId}`);
        break;

      default:
        this.sendCallError(messageId, 'NotImplemented', `Action ${action} not supported by 1.6 simulator`);
        break;
    }
  }

  _handleTriggerMessage(payload) {
    const msg = payload.requestedMessage;
    setTimeout(async () => {
      try {
        switch (msg) {
          case 'BootNotification': await this.bootNotification(); break;
          case 'Heartbeat': await this.heartbeat(); break;
          case 'StatusNotification': await this.statusNotification(this.state.connectorStatus); break;
          case 'MeterValues': await this.sendMeterValues(); break;
          case 'FirmwareStatusNotification': await this.firmwareStatusNotification(this.state.firmwareStatus); break;
          case 'DiagnosticsStatusNotification': await this.diagnosticsStatusNotification('Idle'); break;
          default: this.log('INFO', `Trigger not implemented: ${msg}`); break;
        }
      } catch (e) {
        this.log('INFO', `Trigger ${msg} failed: ${e.message}`);
      }
    }, 200);
  }

  // =========================================================================
  // WebSocket connection (OCPP 1.6 subprotocol)
  // =========================================================================
  connect() {
    const url = buildOcppPath(this.gatewayUrl, '1.6', this.stationId);
    this.log('INFO', `Connecting to ${url} (ocpp1.6) ...`);

    this.ocppWs = new WebSocket(url, ['ocpp1.6'], buildWebSocketOptions(this.gatewayUrl));

    this.ocppWs.on('open', async () => {
      this.state.connected = true;
      this.log('INFO', 'WebSocket connected');
      this.broadcastState();
      try {
        await this.bootNotification();
      } catch (e) {
        this.log('INFO', `Boot failed: ${e.message}`);
      }
    });

    this.ocppWs.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.log('RX', `Invalid JSON: ${data}`);
        return;
      }

      const messageType = frame[0];
      if (messageType === 2) {
        this.handleIncomingCall(frame[1], frame[2], frame[3]);
      } else if (messageType === 3) {
        const msgId = frame[1];
        const pending = this.pendingCalls.get(msgId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(msgId);
          this.log('RX', { callResult: pending.action, messageId: msgId, payload: frame[2] });
          pending.resolve(frame[2]);
        }
      } else if (messageType === 4) {
        const msgId = frame[1];
        const pending = this.pendingCalls.get(msgId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(msgId);
          this.log('RX', { callError: pending.action, messageId: msgId, errorCode: frame[2], errorDescription: frame[3] });
          pending.resolve({ error: frame[2], description: frame[3] });
        }
      }
    });

    this.ocppWs.on('close', (code, reason) => {
      this.state.connected = false;
      this.state.booted = false;
      this.stopHeartbeat();
      this.log('INFO', `WebSocket closed: ${code} ${reason}`);
      this.broadcastState();
    });

    this.ocppWs.on('error', (err) => {
      this.log('INFO', `WebSocket error: ${err.message}`);
    });
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.state.meterInterval) {
      clearInterval(this.state.meterInterval);
      this.state.meterInterval = null;
    }
    if (this.ocppWs) {
      this.ocppWs.close();
      this.ocppWs = null;
    }
    this.state.connected = false;
    this.state.booted = false;
    this.state.transactionId = null;
    this.broadcastState();
  }

  destroy() {
    this.disconnect();
    this.state.logs = [];
  }

  broadcastState() {
    broadcastDashboard({
      type: 'state',
      stationId: this.stationId,
      payload: this.getStateSnapshot(),
    });
  }

  getStateSnapshot() {
    return {
      stationId: this.stationId,
      gatewayUrl: this.gatewayUrl,
      protocol: this.protocol,
      connected: this.state.connected,
      booted: this.state.booted,
      connectorStatus: this.state.connectorStatus,
      connectorType: this.connectorType,
      transactionId: this.state.transactionId,
      meterWh: Math.round(this.state.meterWh),
      meterKwh: (this.state.meterWh / 1000).toFixed(3),
      chargingPowerW: this.state.chargingPowerW,
      effectiveChargingPowerW: this.effectiveChargingPowerW(),
      activeProfileLimitW: this.state.activeProfileLimitW,
      activeProfileExpiresAt: this.state.activeProfileExpiresAt,
      electrical: { ...this.state.electrical },
      remoteStartBehavior: this.state.remoteStartBehavior,
      firmwareStatus: this.state.firmwareStatus,
      reservationId: this.state.reservationId,
      localListVersion: this.state.localListVersion,
      displayMessages: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Charger registry
// ---------------------------------------------------------------------------
const chargers = new Map();

// ---------------------------------------------------------------------------
// Dashboard WebSocket
// ---------------------------------------------------------------------------
const dashboardClients = new Set();

function broadcastDashboard(msg) {
  const raw = JSON.stringify(msg);
  for (const c of dashboardClients) {
    if (c.readyState === WebSocket.OPEN) c.send(raw);
  }
}

function broadcastChargerList() {
  const list = Array.from(chargers.values()).map((c) => c.getStateSnapshot());
  broadcastDashboard({ type: 'charger-list', payload: list });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS headers for network access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8'));
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed = {};
      try {
        if (body) parsed = JSON.parse(body);
      } catch {}

      const urlParts = req.url.replace('/api/', '').split('/');
      let result;

      try {
        if (urlParts[0] === 'chargers') {
          if (urlParts.length === 1) {
            const { stationId, gatewayUrl, connectorTypeId, protocol } = parsed;
            const ocppVersion = OCPP_VERSIONS.includes(protocol) ? protocol : DEFAULT_OCPP_VERSION;
            if (!stationId || !gatewayUrl) {
              result = { error: 'stationId and gatewayUrl are required' };
            } else if (chargers.has(stationId)) {
              result = { error: `Charger ${stationId} already exists` };
            } else if (chargers.size >= MAX_CHARGERS) {
              result = { error: `Maximum of ${MAX_CHARGERS} chargers reached` };
            } else {
              const finalGatewayUrl = rewriteGatewayPortForVersion(gatewayUrl, ocppVersion);
              const instance =
                ocppVersion === '1.6'
                  ? new ChargerInstance16(stationId, finalGatewayUrl, connectorTypeId)
                  : new ChargerInstance(stationId, finalGatewayUrl, connectorTypeId);
              chargers.set(stationId, instance);
              broadcastChargerList();
              result = { ok: true, stationId, protocol: ocppVersion, gatewayUrl: finalGatewayUrl, connectorType: instance.connectorType };
            }
          } else if (urlParts.length === 2 && urlParts[1] === 'list') {
            result = Array.from(chargers.values()).map((c) => c.getStateSnapshot());
          } else if (urlParts.length === 3 && urlParts[2] === 'remove') {
            const id = decodeURIComponent(urlParts[1]);
            const charger = chargers.get(id);
            if (!charger) {
              result = { error: `Charger ${id} not found` };
            } else {
              charger.destroy();
              chargers.delete(id);
              broadcastChargerList();
              result = { ok: true };
            }
          } else if (urlParts.length === 3) {
            const id = decodeURIComponent(urlParts[1]);
            const cmd = urlParts[2];
            const charger = chargers.get(id);
            if (!charger) {
              result = { error: `Charger ${id} not found` };
            } else {
              result = await handleChargerCommand(charger, cmd, parsed);
            }
          } else {
            result = { error: 'Unknown chargers endpoint' };
          }
        } else if (urlParts[0] === 'get-config') {
          result = {
            presets: GATEWAY_PRESETS,
            maxChargers: MAX_CHARGERS,
            connectorTypes: CONNECTOR_TYPES,
            defaultConnectorType: DEFAULT_CONNECTOR_TYPE.id,
            ocppVersions: OCPP_VERSIONS,
            defaultOcppVersion: DEFAULT_OCPP_VERSION,
          };
        } else {
          result = { error: `Unknown endpoint: ${req.url}` };
        }
      } catch (e) {
        result = { error: e.message };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

async function handleChargerCommand(charger, cmd, parsed) {
  switch (cmd) {
    // Connection
    case 'connect': charger.connect(); return { ok: true };
    case 'disconnect': charger.disconnect(); return { ok: true };
    case 'boot': return await charger.bootNotification();
    case 'heartbeat': await charger.heartbeat(); return { ok: true };
    // Reset mirrors the CSMS-initiated OCPP Reset: stop any ongoing
    // transaction, drop the WS and reconnect so the charger reboots clean.
    case 'reset': {
      if (charger.state.transactionId != null) {
        try { await charger.stopCharging(); } catch {}
      }
      charger.disconnect();
      setTimeout(() => charger.connect(), 1500);
      return { ok: true };
    }

    // Charging flow
    case 'plug-in': return await charger.plugIn();
    case 'start': return await charger.startCharging(parsed.idToken);
    case 'stop': return await charger.stopCharging();
    case 'rfid-tap': {
      const uid = parsed.uid || parsed.idToken?.idToken;
      if (!uid) return { error: 'uid is required' };
      const upper = uid.toUpperCase();
      // OCPP 1.6 Authorize/StartTransaction expect `idTag` as a plain
      // string; OCPP 2.0.1 expects an `idToken` object with type. Sending
      // the 2.0.1 object shape on a 1.6 link triggers a FormatViolation
      // at the gateway (schema validation rejects the Call before the
      // CSMS ever sees it), and the resulting unauthenticated meter
      // values get classified as a Free-mode session.
      if (charger.protocol === '1.6') {
        charger.state.idTag = upper;
        charger.log('INFO', `RFID tap: ${upper}`);
        return await charger.startCharging(upper);
      }
      const token = { idToken: upper, type: 'ISO14443' };
      charger.state.idToken = token;
      charger.log('INFO', `RFID tap: ${token.idToken}`);
      return await charger.startCharging(token);
    }

    // Status
    case 'fault': return await charger.triggerFault();
    case 'clear-fault': return await charger.clearFault();
    case 'status':
      if (parsed.status) await charger.statusNotification(parsed.status);
      return { ok: true };

    // Configuration
    case 'set-power':
      if (parsed.powerW) charger.state.chargingPowerW = parsed.powerW;
      charger.broadcastState();
      return { ok: true, chargingPowerW: charger.state.chargingPowerW };
    case 'set-id-token':
      if (parsed.idToken) charger.state.idToken = parsed.idToken;
      return { ok: true, idToken: charger.state.idToken };
    // Tweak how the charger reacts to SetChargingProfile at runtime.
    // Accepts any subset of {unitMode, wrongUnitBehavior, voltage, phases}
    // so the dashboard can flip a single knob in isolation. Values not
    // provided are left untouched.
    case 'set-electrical': {
      const e = charger.state.electrical;
      if (parsed.unitMode && ['W', 'A', 'both'].includes(parsed.unitMode)) {
        e.unitMode = parsed.unitMode;
      }
      if (
        parsed.wrongUnitBehavior &&
        ['reject', 'silentIgnore'].includes(parsed.wrongUnitBehavior)
      ) {
        e.wrongUnitBehavior = parsed.wrongUnitBehavior;
      }
      if (Number.isFinite(parsed.nominalVoltage) && parsed.nominalVoltage > 0) {
        e.nominalVoltage = parsed.nominalVoltage;
      }
      if (parsed.phases === 1 || parsed.phases === 3) {
        e.phases = parsed.phases;
      }
      charger.broadcastState();
      return { ok: true, electrical: { ...e } };
    }

    // RemoteStartTransaction response behaviour (1.6 instances only).
    case 'set-remote-start-behavior': {
      const allowed = ['accept', 'reject', 'silent-drop'];
      if (!allowed.includes(parsed.behavior)) {
        return { error: `behavior must be one of: ${allowed.join(', ')}` };
      }
      if (charger.protocol !== '1.6') {
        return { error: 'remoteStartBehavior is only supported on OCPP 1.6 chargers' };
      }
      charger.state.remoteStartBehavior = parsed.behavior;
      charger.broadcastState();
      return { ok: true, remoteStartBehavior: parsed.behavior };
    }

    // Data Transfer
    case 'data-transfer':
      return await charger.dataTransfer(parsed.vendorId, parsed.messageId, parsed.data);

    // Firmware
    case 'firmware-status':
      return await charger.firmwareStatusNotification(parsed.status || 'Installed');
    case 'firmware-update-sim':
      charger.simulateFirmwareUpdate().catch(() => {});
      return { ok: true, message: 'Firmware update simulation started' };
    case 'publish-firmware-status':
      return await charger.publishFirmwareStatusNotification(parsed.status || 'Downloaded');

    // Diagnostics & Logging
    case 'log-status':
      return await charger.logStatusNotification(parsed.status || 'Uploaded');
    case 'security-event':
      return await charger.securityEventNotification(parsed.type);
    case 'notify-event':
      return await charger.notifyEvent(parsed.eventType, parsed.trigger, parsed.component, parsed.variable, parsed.actualValue);

    // Device Model & Reports
    case 'notify-report':
      return await charger.notifyReport(parsed.requestId);
    case 'notify-monitoring-report':
      return await charger.notifyMonitoringReport(parsed.requestId);

    // Smart Charging
    case 'notify-charging-limit':
      return await charger.notifyChargingLimit(parsed.source);
    case 'notify-ev-charging-needs':
      return await charger.notifyEVChargingNeeds();
    case 'notify-ev-charging-schedule':
      return await charger.notifyEVChargingSchedule(parsed.scheduleId);
    case 'cleared-charging-limit':
      return await charger.clearedChargingLimit(parsed.source);
    case 'report-charging-profiles':
      return await charger.reportChargingProfiles(parsed.requestId);

    // Reservations
    case 'reservation-status-update':
      return await charger.reservationStatusUpdate(parsed.reservationId, parsed.status);

    // Certificates
    case 'certificate-signed':
      return await charger.certificateSigned(parsed.status);
    case 'get-15118-ev-cert':
      return await charger.get15118EVCertificate();
    case 'get-cert-status':
      return await charger.getCertificateStatus();

    // Display & Customer
    case 'notify-display-messages':
      return await charger.notifyDisplayMessages(parsed.requestId);
    case 'notify-customer-info':
      return await charger.notifyCustomerInformation(parsed.requestId);

    // Cost
    case 'cost-updated':
      return await charger.costUpdated(parsed.totalCost);

    // Authorize (standalone)
    case 'authorize':
      return await charger.authorize(parsed.idToken);

    default:
      return { error: `Unknown command: ${cmd}` };
  }
}

// ---------------------------------------------------------------------------
// Dashboard WebSocket server
// ---------------------------------------------------------------------------
const dashboardWss = new WebSocket.Server({ server });
dashboardWss.on('connection', (ws) => {
  dashboardClients.add(ws);
  const list = Array.from(chargers.values()).map((c) => c.getStateSnapshot());
  ws.send(JSON.stringify({ type: 'charger-list', payload: list }));
  for (const charger of chargers.values()) {
    for (const entry of charger.state.logs.slice(-100)) {
      ws.send(JSON.stringify({ type: 'log', stationId: charger.stationId, payload: entry }));
    }
  }
  ws.on('close', () => dashboardClients.delete(ws));
});

// Optional zero-config bootstrap. When GATEWAY_URL is set in the environment
// (e.g. via docker-compose), spawn one charger on startup so `docker compose
// up` connects to the gateway with no manual API call. Configure it with:
//   GATEWAY_URL    (required to auto-start, e.g. ws://host:8081)
//   STATION_ID     (default EVR-SIMULATOR-001)
//   OCPP_PROTOCOL  (1.6 | 2.0.1, default 2.0.1)
function autoStartFromEnv() {
  const gatewayUrl = process.env.GATEWAY_URL;
  if (!gatewayUrl) return;

  const stationId = process.env.STATION_ID || 'EVR-SIMULATOR-001';
  const protocol = OCPP_VERSIONS.includes(process.env.OCPP_PROTOCOL)
    ? process.env.OCPP_PROTOCOL
    : DEFAULT_OCPP_VERSION;

  if (chargers.has(stationId)) return;

  try {
    const finalGatewayUrl = rewriteGatewayPortForVersion(gatewayUrl, protocol);
    const instance =
      protocol === '1.6'
        ? new ChargerInstance16(stationId, finalGatewayUrl, undefined)
        : new ChargerInstance(stationId, finalGatewayUrl, undefined);
    chargers.set(stationId, instance);
    broadcastChargerList();
    console.log(
      `  Auto-started : ${stationId} (OCPP ${protocol}) → ${finalGatewayUrl}\n`,
    );
  } catch (err) {
    console.error(`  Auto-start failed: ${err.message}`);
  }
}

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n  Everest OCPP Multi-Protocol Simulator (1.6 + 2.0.1)`);
  console.log(`  Dashboard    : http://0.0.0.0:${HTTP_PORT}`);
  console.log(`  Max chargers : ${MAX_CHARGERS}`);
  console.log(`  Protocols    : ${OCPP_VERSIONS.join(', ')}\n`);
  autoStartFromEnv();
});
