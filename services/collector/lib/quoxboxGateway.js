'use strict';
/**
 * Fetch from the QuoxBox governed Mac-mini gateway (quoxbox-proxy routes). Never throws:
 * callers get { ok, status, data, error }.
 *
 * quox#882: an unreachable gateway used to hang each call for the full 15 s request budget and
 * then report only "fetch failed". A short TCP connect probe runs first, a failure is remembered
 * for DOWN_MS so the next calls answer at once, and the error names the address and the reason.
 */
const net = require('node:net');

const DEFAULT_URL = process.env.QUOXBOX_GATEWAY_URL || 'http://172.19.0.1:8877';
const CONNECT_MS = 3000;
const DOWN_MS = 30000;
const REQUEST_MS = 15000;
const down = new Map(); // url -> { until, reason }

function probe(u, connectMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => { if (done) return; done = true; sock.destroy(); resolve(reason); };
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
    sock.setTimeout(connectMs, () => finish('timed out'));
    sock.once('connect', () => finish(null));
    sock.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'connection refused'
      : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'unreachable'
        : e.code === 'ENOTFOUND' ? 'unknown host' : (e.code || e.message)));
  });
}

async function gatewayFetch(path, options = {}, { url = DEFAULT_URL, token = process.env.QUOXBOX_GATEWAY_TOKEN || '', connectMs = CONNECT_MS } = {}) {
  const named = (reason) => `QuoxBox isn't reachable at ${url} (${reason})`;
  const known = down.get(url);
  if (known && known.until > Date.now()) return { ok: false, status: 502, data: null, error: named(known.reason) };
  let u;
  try { u = new URL(url); } catch { return { ok: false, status: 502, data: null, error: named('bad gateway URL') }; }
  const reason = await probe(u, connectMs);
  if (reason) { down.set(url, { until: Date.now() + DOWN_MS, reason }); return { ok: false, status: 502, data: null, error: named(reason) }; }
  down.delete(url);
  try {
    const resp = await fetch(`${url}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    let data = null;
    try { data = await resp.json(); } catch (_) { data = null; }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: null, error: named(err.name === 'TimeoutError' ? 'no answer within 15 s' : err.message) };
  }
}

module.exports = { gatewayFetch, resetReach: () => down.clear() };
