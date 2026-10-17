/**
 * RouterOS transport: fail-closed identity verification (quoxai/quox#1236).
 *
 * Before this module the RouterOS client sent the router login (HTTP Basic)
 * to whatever answered on the configured host:port: plain HTTP when useSSL
 * was false, and TLS with verification switched off (no identity check at all) when
 * it was true. On a LAN where an unknown machine can answer on the router's
 * address, every router question handed the admin login to that machine.
 *
 * Rules enforced here, before a single credential byte leaves the process:
 *   1. HTTPS only (the REST API on www-ssl).
 *   2. The endpoint's identity must be proven: either the leaf certificate
 *      (SHA-256 of the DER cert) or its public key (SHA-256 of the SPKI DER)
 *      matches an operator-configured pin (MIKROTIK_TLS_PIN), or the chain
 *      validates against an operator-provided CA bundle (MIKROTIK_CA_FILE).
 *   3. No pin and no CA: NO connection is attempted at all.
 *   4. A pin mismatch closes the socket during the handshake, before any
 *      request bytes are written, and names the expected and seen digests.
 *   5. Plain http:// is refused unless MIKROTIK_INSECURE_DEV=1, which warns
 *      loudly on every call. It is never the default.
 *
 * Never trust on first use: nothing here ever stores or learns a pin. The
 * operator reads the fingerprint (`quox router trust --show`, which calls
 * probeFingerprint() below and sends NO credentials), compares it out of
 * band, then sets MIKROTIK_TLS_PIN themselves.
 *
 * If both a pin and a CA bundle are set, the pin is authoritative (the
 * strictest check wins): the endpoint must match the pin.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const CONNECT_TIMEOUT_MS = 15000;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** colon-separated upper-case form people compare by eye, e.g. "AB:CD:...". */
function formatFingerprint(hex) {
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

/**
 * Parse MIKROTIK_TLS_PIN. Comma/space/semicolon separated; each entry is a
 * SHA-256 digest in hex, colons optional, optional "sha256:" prefix.
 * @returns {{pins: string[], invalid: string[]}}
 */
function parsePins(raw) {
  const pins = [];
  const invalid = [];
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    if (!part) continue;
    const cleaned = part.replace(/^sha256[:=]/i, '').replace(/:/g, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(cleaned)) pins.push(cleaned);
    else invalid.push(part);
  }
  return { pins, invalid };
}

/** Fingerprints of a presented leaf certificate (raw = DER Buffer). */
function fingerprintsOf(rawDer) {
  const x509 = new crypto.X509Certificate(rawDer);
  const spki = x509.publicKey.export({ type: 'spki', format: 'der' });
  return { cert: sha256Hex(rawDer), spki: sha256Hex(spki) };
}

function readPolicy(env = process.env) {
  const { pins, invalid } = parsePins(env.MIKROTIK_TLS_PIN);
  return {
    pins,
    invalidPins: invalid,
    caFile: (env.MIKROTIK_CA_FILE || '').trim() || null,
    insecureDev: env.MIKROTIK_INSECURE_DEV === '1',
  };
}

function refusal(code, error, extra = {}) {
  return { success: false, error, code, status: 400, ...extra };
}

const NOT_CONFIGURED_MSG =
  'router identity not configured: set MIKROTIK_TLS_PIN (or MIKROTIK_CA_FILE); nothing was sent. ' +
  'Run `quox router trust --show` to read the router certificate fingerprint, compare it out of band, then set the pin.';

/**
 * Open a TLS socket to host:port WITHOUT writing anything, resolving once the
 * handshake completes. Chain validation is off here: identity is decided by
 * the caller (pin) or by `ca` (when given, validation is on).
 */
function openTlsSocket({ host, port, ca, timeoutMs = CONNECT_TIMEOUT_MS, connect = tls.connect }) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      port: Number(port),
      rejectUnauthorized: Boolean(ca),
      // RouterOS 7 REST speaks TLS 1.2+; refuse anything older.
      minVersion: 'TLSv1.2',
    };
    if (ca) opts.ca = ca;
    if (!net.isIP(host)) opts.servername = host; // never send an IP as SNI
    let settled = false;
    const sock = connect(opts);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.once('error', fail);
    sock.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      resolve(sock);
    });
  });
}

/**
 * Read the endpoint's current certificate fingerprints. Sends NO credentials
 * and NO request bytes: handshake, read the cert, close.
 * @returns {Promise<{ok: true, host, port, cert_sha256, spki_sha256, cert_sha256_formatted, subject, issuer, valid_to, self_signed}|{ok:false,error,code}>}
 */
async function probeFingerprint({ host, port = 443, timeoutMs, connect } = {}) {
  let sock;
  try {
    sock = await openTlsSocket({ host, port, timeoutMs, connect });
    const peer = sock.getPeerCertificate(false);
    if (!peer || !peer.raw) return { ok: false, error: 'router presented no certificate', code: 'NO_CERT' };
    const fp = fingerprintsOf(peer.raw);
    const x509 = new crypto.X509Certificate(peer.raw);
    return {
      ok: true,
      host,
      port: Number(port),
      cert_sha256: fp.cert,
      spki_sha256: fp.spki,
      cert_sha256_formatted: formatFingerprint(fp.cert),
      spki_sha256_formatted: formatFingerprint(fp.spki),
      subject: x509.subject,
      issuer: x509.issuer,
      valid_to: x509.validTo,
      self_signed: x509.subject === x509.issuer,
    };
  } catch (err) {
    return { ok: false, error: `could not read the router certificate: ${err.message || err.code}`, code: err.code || 'PROBE_FAILED' };
  } finally {
    if (sock) { try { sock.destroy(); } catch { /* ignore */ } }
  }
}

function mapRequestError(err) {
  const msg = err.message || '';
  if (msg.includes('ECONNREFUSED')) {
    return { success: false, error: "Can't reach router. Check IP address.", code: 'ECONNREFUSED', status: 500 };
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return { success: false, error: 'Router not responding. Check network.', code: 'ETIMEDOUT', status: 500 };
  }
  if (/handshake|certificate|ssl|tls|self.signed|unable to verify/i.test(msg)) {
    return { success: false, error: `TLS verification failed (${msg}); nothing was sent.`, code: 'CERT_ERROR', status: 500 };
  }
  return { success: false, error: msg || 'Connection failed', code: err.code || null, status: 500 };
}

function interpretResponse(status, data) {
  let parsed;
  try { parsed = JSON.parse(data); } catch { parsed = data; }
  if (typeof parsed === 'string' && (parsed.includes('Error 404') || parsed.includes('<title>Error'))) {
    return { success: false, error: 'REST API not enabled. Enable www-ssl on your router (RouterOS 7.1+).', code: 'API_NOT_ENABLED', status: 404 };
  }
  if (status === 401) return { success: false, error: 'Wrong username or password.', status: 401 };
  if (status === 403) return { success: false, error: 'Access denied.', status: 403 };
  if (status === 404) return { success: false, error: 'API endpoint not found.', status: 404 };
  if (status >= 400) return { success: false, error: `HTTP error ${status}`, status };
  return { success: true, data: parsed, status };
}

function sendRequest({ useTlsSocket, socket, host, port, username, password, path, method, body, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const credentials = Buffer.from(`${username || 'admin'}:${password || ''}`).toString('base64');
  const payload = body ? JSON.stringify(body) : null;
  const proto = useTlsSocket ? 'https' : 'http';
  const url = `${proto}://${net.isIPv6(host) ? `[${host}]` : host}:${port}/rest${path}`;
  const options = {
    method: (method || 'GET').toUpperCase(),
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
    timeout: timeoutMs,
    ...(socket ? { createConnection: () => socket } : {}),
  };
  const lib = useTlsSocket ? https : http;
  return new Promise((resolve) => {
    const request = lib.request(url, options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve(interpretResponse(response.statusCode, data)));
    });
    request.on('error', (err) => resolve(mapRequestError(err)));
    request.on('timeout', () => {
      request.destroy();
      resolve({ success: false, error: 'Router not responding (timeout).', code: 'ETIMEDOUT', status: 500 });
    });
    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * The one place a RouterOS login leaves the process. Fail-closed.
 */
async function performRouterosRequest(args, { env = process.env, connect = tls.connect, log = console } = {}) {
  const { host, port, useSSL, username, password, path, method, body } = args;
  const policy = readPolicy(env);

  // 1. Plain HTTP: refused unless the loudly-named dev opt-in is set.
  if (!useSSL) {
    if (!policy.insecureDev) {
      log.error(`[SECURITY] RouterOS request to ${host}:${port} refused: plain http:// would send the router login in clear text. Nothing was sent.`);
      return refusal('INSECURE_TRANSPORT_REFUSED',
        'plain http:// to the router is refused: the login would travel in clear text and to an unverified machine. Use HTTPS (www-ssl) and set MIKROTIK_TLS_PIN; nothing was sent.');
    }
    log.warn(`[SECURITY] MIKROTIK_INSECURE_DEV=1: sending the router login over UNVERIFIED plain http:// to ${host}:${port}. Dev only, never use in production.`);
    return sendRequest({ useTlsSocket: false, host, port, username, password, path, method, body });
  }

  // 2. HTTPS: identity must be configured, else nothing leaves.
  if (policy.pins.length === 0 && !policy.caFile) {
    const bad = policy.invalidPins.length
      ? ` (MIKROTIK_TLS_PIN is set but has no valid SHA-256 digest: ${policy.invalidPins.length} unusable entr${policy.invalidPins.length === 1 ? 'y' : 'ies'})`
      : '';
    log.error(`[SECURITY] RouterOS request to ${host}:${port} refused: router identity not configured${bad}. Nothing was sent.`);
    return refusal('ROUTER_IDENTITY_NOT_CONFIGURED', NOT_CONFIGURED_MSG + bad);
  }

  let ca;
  if (policy.pins.length === 0) {
    try {
      ca = fs.readFileSync(policy.caFile);
    } catch (err) {
      log.error(`[SECURITY] RouterOS request to ${host}:${port} refused: cannot read MIKROTIK_CA_FILE (${err.code || err.message}). Nothing was sent.`);
      return refusal('ROUTER_CA_UNREADABLE', `router identity not verifiable: cannot read MIKROTIK_CA_FILE (${err.code || err.message}); nothing was sent.`);
    }
  }

  // 3. Handshake first, verify, and only then write the request.
  let sock;
  try {
    sock = await openTlsSocket({ host, port, ca, connect });
  } catch (err) {
    return mapRequestError(err);
  }

  if (policy.pins.length > 0) {
    let seen;
    try {
      const peer = sock.getPeerCertificate(false);
      seen = fingerprintsOf(peer.raw);
    } catch (err) {
      sock.destroy();
      log.error(`[SECURITY] RouterOS ${host}:${port} presented an unreadable certificate (${err.message}). Nothing was sent.`);
      return refusal('ROUTER_IDENTITY_MISMATCH', 'router identity could not be verified: it presented no usable certificate; nothing was sent.');
    }
    if (!policy.pins.includes(seen.cert) && !policy.pins.includes(seen.spki)) {
      sock.destroy();
      const expected = policy.pins.map(formatFingerprint).join(', ');
      log.error(`[SECURITY] RouterOS identity MISMATCH at ${host}:${port}: expected ${expected}, saw cert ${formatFingerprint(seen.cert)} / key ${formatFingerprint(seen.spki)}. Credentials were NOT sent. Something other than your router may be answering.`);
      return refusal('ROUTER_IDENTITY_MISMATCH',
        `router identity mismatch at ${host}:${port}: expected ${expected}, saw certificate ${formatFingerprint(seen.cert)} (public key ${formatFingerprint(seen.spki)}); nothing was sent.`,
        { expected_fingerprints: policy.pins.map(formatFingerprint), seen_fingerprint: formatFingerprint(seen.cert), seen_key_fingerprint: formatFingerprint(seen.spki) });
    }
  }

  return sendRequest({ useTlsSocket: true, socket: sock, host, port, username, password, path, method, body });
}

module.exports = {
  performRouterosRequest,
  probeFingerprint,
  parsePins,
  fingerprintsOf,
  formatFingerprint,
  readPolicy,
  NOT_CONFIGURED_MSG,
};
