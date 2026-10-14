'use strict';

/**
 * SEC-PLUGIN-TRUST C1: on-behalf-of org ticket.
 *
 * When the gateway forwards a USER request to a plugin backend it adds
 * `X-Quox-Org-Ticket: <b64url(JSON{p,o,u,exp})>.<b64url(HMAC-SHA256)>`. The
 * backend echoes it when it calls the host (/chat, /aee/*) with its qplg_
 * credential. The host accepts the credential only together with a valid,
 * unexpired ticket whose `p` equals the credential's plugin, and acts as org
 * `o` (user `u`) and no other. So a compromised plugin can act only for orgs
 * whose users recently reached it through the gateway, never for an org it
 * names itself.
 *
 * The MAC key is HKDF(INTERNAL_SERVICE_KEY, label), derived inside the
 * collector (mint and verify are the same process): no new env var, and the
 * master key itself is never transmitted.
 */

const { createHmac, hkdfSync, timingSafeEqual } = require('crypto');

const TICKET_TTL_SEC = 120;
const HKDF_LABEL = 'quox/plugin-org-ticket/v1';

let _keyCache = { src: null, key: null };
function ticketKey() {
  const src = process.env.INTERNAL_SERVICE_KEY || '';
  if (!src) return null;
  if (_keyCache.src !== src) {
    _keyCache = { src, key: Buffer.from(hkdfSync('sha256', Buffer.from(src), Buffer.alloc(0), Buffer.from(HKDF_LABEL), 32)) };
  }
  return _keyCache.key;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

function mac(payloadB64, key) {
  return createHmac('sha256', key).update(payloadB64).digest();
}

/** @returns {string|null} ticket, or null when no signing key is configured. */
function mintOrgTicket({ pluginId, orgId, userId, nowMs = Date.now(), ttlSec = TICKET_TTL_SEC }) {
  const key = ticketKey();
  if (!key || !pluginId || !orgId) return null;
  const payload = b64u(JSON.stringify({
    p: pluginId, o: orgId, u: userId || null, exp: Math.floor(nowMs / 1000) + ttlSec,
  }));
  return `${payload}.${b64u(mac(payload, key))}`;
}

/** @returns {{ok:true, claims:{p:string,o:string,u:string|null,exp:number}}|{ok:false, reason:string}} */
function verifyOrgTicket(ticket, { nowMs = Date.now() } = {}) {
  const key = ticketKey();
  if (!key) return { ok: false, reason: 'ticket_not_configured' };
  if (typeof ticket !== 'string' || ticket.length > 2048) return { ok: false, reason: 'ticket_missing' };
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'ticket_malformed' };
  const given = Buffer.from(parts[1], 'base64url');
  const expect = mac(parts[0], key);
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) return { ok: false, reason: 'ticket_bad_mac' };
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'ticket_malformed' }; }
  if (!claims || typeof claims.p !== 'string' || typeof claims.o !== 'string' || !claims.p || !claims.o
      || typeof claims.exp !== 'number' || (claims.u != null && typeof claims.u !== 'string')) {
    return { ok: false, reason: 'ticket_malformed' };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: 'ticket_expired' };
  return { ok: true, claims: { p: claims.p, o: claims.o, u: claims.u ?? null, exp: claims.exp } };
}

module.exports = { mintOrgTicket, verifyOrgTicket, TICKET_TTL_SEC };
