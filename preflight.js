#!/usr/bin/env node
/**
 * Handshake pre-flight for a virtual charger.
 *
 * Opens the OCPP websocket exactly like the simulator does and exits as soon
 * as the gateway has answered, so a misconfigured run fails in two seconds
 * with the reason instead of looping "reconnecting…" in the dashboard.
 *
 * usage: node preflight.js <stationId> <gatewayUrl> <protocol> [basicAuth]
 */
const WebSocket = require('ws');

const [stationId, gatewayUrl, protocol = '2.0.1', basicAuth = process.env.OCPP_BASIC_AUTH] =
  process.argv.slice(2);

if (!stationId || !gatewayUrl) {
  console.error('usage: node preflight.js <stationId> <gatewayUrl> [protocol] [basicAuth]');
  process.exit(2);
}

const base = gatewayUrl.replace(/\/+$/, '');
const url = /\/(1\.6|2\.0\.1)$/.test(base) ? `${base}/${stationId}` : `${base}/${stationId}`;
const creds = basicAuth && !basicAuth.includes(':') ? `${stationId}:${basicAuth}` : basicAuth;
const options = creds
  ? { headers: { Authorization: 'Basic ' + Buffer.from(creds, 'utf8').toString('base64') } }
  : {};

const ws = new WebSocket(url, [`ocpp${protocol}`], options);
const timer = setTimeout(() => {
  console.error(`TIMEOUT  no answer from ${url} in 12s (VPN full-tunnel up? DNS?)`);
  process.exit(1);
}, 12000);

ws.on('open', () => {
  clearTimeout(timer);
  console.log(`OK       handshake accepted at ${url}`);
  ws.close();
  process.exit(0);
});

ws.on('unexpected-response', (_req, res) => {
  clearTimeout(timer);
  if (res.statusCode === 401) {
    console.error(
      `HTTP 401 ${url}\n` +
        `         the gateway runs on security profile 1: the station needs a\n` +
        `         BasicAuthPassword seeded in CitrineOS and the same value here.`,
    );
  } else {
    console.error(`HTTP ${res.statusCode} ${url}`);
  }
  process.exit(1);
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.error(`ERROR    ${err.message}`);
  process.exit(1);
});
