'use strict';
/**
 * QUOXON-ASK lane J2 (quox#852): the caller's own bearer for one Claude CLI turn,
 * held in collector memory only.
 *
 * The CLI-tools subprocess (driven by the model, whose Bash can read its env) carries
 * only the per-turn token (aud quox:tools-execute, lib/turnToken.js). quox_cli needs the
 * caller's real session bearer, because it runs the quox CLI as that user. So the
 * dispatcher registers the bearer here at turn start, keyed by the turn token's turn_id,
 * and releases it at turn end; POST /api/v1/tools/execute resolves it server-side, for
 * quox_cli / quox_cli_write only, when the turn token's user and org match.
 *
 * Never persisted, never logged, never put into any subprocess env. TTL-capped so a
 * turn that never reaches its finally cannot leave a bearer behind.
 */

const { TURN_TOKEN_AUDIENCE } = require('./turnToken.js');

const MAX_TTL_MS = 3600 * 1000; // the turn token's own max lifetime
const MAX_ENTRIES = 2000;
// Tools that act on the caller's behalf with the caller's own bearer: quox_cli runs the CLI as
// them; delegate_to_agent forwards it on the loopback hop so the specialist acts as them too.
// SESSIONS (2026-10-15): the read-only QUOXON proof reads (lib/quoxonProofReadTools.js) forward
// the caller's bearer to the caller's own collector/auth routes, which refuse a turn token, so on
// a Claude CLI turn they all failed 401 authentication_required (owner saw it on live_sessions).
const OBO_TOOLS = new Set([
  'quox_cli', 'quox_cli_write', 'delegate_to_agent',
  'live_sessions', 'llm_status', 'llm_policy', 'backup_overview', 'prompt_list', 'prompt_read',
  // quox#1106: security_audit reads auth's GET /api/orgs/:orgId/audit as the caller (auth enforces ORG_VIEW_AUDIT).
  'security_audit',
  // RunActor slice 3 Part A: a chat-started workflow run is recorded as the human who asked (quoxflow refuses turn tokens).
  'execute_workflow',
]);

const entries = new Map(); // turnId -> { bearer, userId, orgId, expiresAt }
// quox#1090 ruling (b): turns whose hold ran out (or was capped to nothing). An OBO call on one is
// refused with turn_credential_expired, never a bare 401 and never the turn token in its place.
const expired = new Map(); // turnId -> when it ran out
const EXPIRED_KEEP_MS = 2 * 3600 * 1000;
function noteExpired(turnId, at) {
  for (const [k, v] of expired) if (v + EXPIRED_KEEP_MS <= at) expired.delete(k);
  if (expired.size >= MAX_ENTRIES) expired.delete(expired.keys().next().value);
  expired.set(String(turnId), at);
}

function sweep(now) {
  for (const [k, v] of entries) if (v.expiresAt <= now) { entries.delete(k); noteExpired(k, v.expiresAt); }
}

function decodeClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** True when the bearer is a user session JWT for this org (not a service key, not a turn token). */
function isHoldableBearer(bearer, orgId) {
  const serviceKeys = [process.env.INTERNAL_SERVICE_KEY, process.env.QUOX_SERVICE_KEY].filter(Boolean);
  if (!bearer || serviceKeys.includes(bearer)) return false;
  const claims = decodeClaims(bearer);
  if (!claims) return false;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.includes(TURN_TOKEN_AUDIENCE)) return false;
  if (claims.org_id && String(claims.org_id) !== String(orgId)) return false;
  return true;
}

function registerTurnBearer({ turnId, bearer, userId, orgId, ttlMs, holdUntil, now = Date.now() } = {}) {
  if (!turnId || !userId || !orgId || !isHoldableBearer(bearer, orgId)) return false;
  sweep(now);
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  const ttl = Math.min(MAX_TTL_MS, Math.max(1000, Number(ttlMs) || 0));
  let expiresAt = now + ttl;
  // quox#1090 ruling (b): a delegated sub-turn never holds the user's bearer past the parent turn's
  // original hold expiry; started after it, it holds nothing (and its OBO calls are refused).
  if (Number.isFinite(Number(holdUntil)) && holdUntil != null) expiresAt = Math.min(expiresAt, Number(holdUntil));
  if (expiresAt <= now) { noteExpired(turnId, now); return false; }
  expired.delete(String(turnId));
  entries.set(String(turnId), { bearer, userId: String(userId), orgId: String(orgId), expiresAt });
  return true;
}

/** When this turn's held bearer runs out (ms epoch), or null if it holds none. */
function heldUntil(turnId, now = Date.now()) {
  if (!turnId) return null;
  const e = entries.get(String(turnId));
  return e && e.expiresAt > now ? e.expiresAt : null;
}

function resolveTurnBearer({ turnId, userId, orgId, now = Date.now() } = {}) {
  if (!turnId) return null;
  const e = entries.get(String(turnId));
  if (!e) return null;
  if (e.expiresAt <= now) { entries.delete(String(turnId)); noteExpired(turnId, e.expiresAt); return null; }
  if (e.userId !== String(userId || '') || e.orgId !== String(orgId || '')) return null;
  return e.bearer;
}

function releaseTurnBearer(turnId) {
  if (turnId) { entries.delete(String(turnId)); expired.delete(String(turnId)); }
}

/**
 * The bearer a tools/execute call runs with. For an OBO_TOOLS tool on a turn token: the caller's
 * held bearer, else the turn token itself (which quox_cli refuses, so an ended or expired
 * turn fails closed). Every other tool and caller: the header token, unchanged.
 */
function bearerForToolCall({ toolName, user, headerToken } = {}) {
  const isTurnToken = user && (Array.isArray(user.aud) ? user.aud : [user.aud]).includes(TURN_TOKEN_AUDIENCE);
  if (!isTurnToken || !OBO_TOOLS.has(toolName)) return headerToken;
  return resolveTurnBearer({ turnId: user.turn_id, userId: user.id, orgId: user.orgId || user.org_id }) || headerToken;
}

/**
 * quox#1090 ruling (b): the credential a tools/execute call runs with, or a refusal. An OBO tool on a
 * turn token whose hold ran out (or was capped to nothing) is refused with turn_credential_expired;
 * every other tool keeps the header token, so reads still work. A turn that never held a bearer keeps
 * today's fallback (the turn token).
 */
function toolCallCredential({ toolName, user, headerToken, now = Date.now() } = {}) {
  const isTurnToken = user && (Array.isArray(user.aud) ? user.aud : [user.aud]).includes(TURN_TOKEN_AUDIENCE);
  if (!isTurnToken || !OBO_TOOLS.has(toolName)) return { token: headerToken };
  const held = resolveTurnBearer({ turnId: user.turn_id, userId: user.id, orgId: user.orgId || user.org_id, now });
  if (held) return { token: held };
  if (user.turn_id && expired.has(String(user.turn_id))) {
    return { error: 'turn_credential_expired', message: 'turn credential expired: this turn can no longer act as you. Ask again to start a new turn.' };
  }
  return { token: headerToken };
}

module.exports = {
  toolCallCredential,
  heldUntil,
  isHoldableBearer,
  registerTurnBearer,
  resolveTurnBearer,
  releaseTurnBearer,
  bearerForToolCall,
  MAX_TTL_MS,
  _reset: () => { entries.clear(); expired.clear(); },
};
