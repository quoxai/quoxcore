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
]);

const entries = new Map(); // turnId -> { bearer, userId, orgId, expiresAt }

function sweep(now) {
  for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
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

function registerTurnBearer({ turnId, bearer, userId, orgId, ttlMs, now = Date.now() } = {}) {
  if (!turnId || !userId || !orgId || !isHoldableBearer(bearer, orgId)) return false;
  sweep(now);
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  const ttl = Math.min(MAX_TTL_MS, Math.max(1000, Number(ttlMs) || 0));
  entries.set(String(turnId), { bearer, userId: String(userId), orgId: String(orgId), expiresAt: now + ttl });
  return true;
}

function resolveTurnBearer({ turnId, userId, orgId, now = Date.now() } = {}) {
  if (!turnId) return null;
  const e = entries.get(String(turnId));
  if (!e) return null;
  if (e.expiresAt <= now) { entries.delete(String(turnId)); return null; }
  if (e.userId !== String(userId || '') || e.orgId !== String(orgId || '')) return null;
  return e.bearer;
}

function releaseTurnBearer(turnId) {
  if (turnId) entries.delete(String(turnId));
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

module.exports = {
  isHoldableBearer,
  registerTurnBearer,
  resolveTurnBearer,
  releaseTurnBearer,
  bearerForToolCall,
  MAX_TTL_MS,
  _reset: () => entries.clear(),
};
