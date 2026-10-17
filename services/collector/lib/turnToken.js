'use strict';
/**
 * QUOXON-IDENTITY: per-turn scoped credential for the Claude CLI "CLI-TOOLS"
 * dispatch path (QUOX_TOOL_MODE=cli).
 *
 * Before: the model-driven `quox tool exec` subprocess carried the collector's
 * service key (QUOX_SERVICE_KEY + QUOX_FORCE_SERVICE_KEY=1) and NO user token.
 * Two defects: tools reading ctx.token (org_directory ...) failed "No
 * authenticated user session", and /api/v1/tools/execute trusted body
 * org_id/user_id for service-key callers, so a model-driven Bash could name
 * another org or user.
 *
 * Now: the turn gets a short-lived JWT for the CALLER (sub = user, org_id,
 * conversation_id, agent_id, turn_id), audience 'quox:tools-execute', expiry =
 * turn timeout + margin. The audience is enforced by wsAuth.verifyToken: any
 * audience-bearing token is REJECTED unless the route opts in, and only
 * /api/v1/tools/execute does. The service key is stripped from the env.
 * The token is never logged.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const TURN_TOKEN_AUDIENCE = 'quox:tools-execute';
const TURN_TOKEN_MARGIN_SEC = 60;
const TURN_TOKEN_MAX_TTL_SEC = 3600;

function mintTurnToken({ userId, orgId, conversationId, agentId, ttlMs, turnId, secret = process.env.JWT_SECRET } = {}) {
  if (!secret) throw new Error('turn token: JWT_SECRET not configured');
  if (!userId || !orgId) throw new Error('turn token: userId and orgId are required');
  const ttlSec = Math.min(
    TURN_TOKEN_MAX_TTL_SEC,
    Math.max(30, Math.ceil((Number(ttlMs) || 0) / 1000) + TURN_TOKEN_MARGIN_SEC),
  );
  const claims = {
    sub: String(userId),
    org_id: String(orgId),
    type: 'access',
    aud: TURN_TOKEN_AUDIENCE,
    scope: 'tools.execute',
    // QUOXON-ASK J2: the caller may pin turn_id so the collector can hold the caller's
    // bearer for this turn (lib/turnBearerStore.js) without it ever reaching the env.
    turn_id: turnId ? String(turnId) : crypto.randomBytes(8).toString('hex'),
  };
  if (conversationId) claims.conversation_id = String(conversationId);
  if (agentId) claims.agent_id = String(agentId);
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: ttlSec });
}

/**
 * Build the subprocess env for a CLI-tools turn. Strips every service
 * credential inherited from the collector's own env, then (if a caller
 * identity exists) adds QUOX_AUTH_TOKEN. With no identity or no secret the
 * env carries NO credential at all (tools fail closed; never the service key).
 */
function applyTurnCredential(baseEnv, ident, { mint = mintTurnToken, log = console } = {}) {
  const env = { ...baseEnv };
  delete env.QUOX_SERVICE_KEY;
  delete env.QUOX_FORCE_SERVICE_KEY;
  delete env.QUOX_AUTH_TOKEN;
  delete env.QUOX_TOKEN;
  try {
    env.QUOX_AUTH_TOKEN = mint(ident);
  } catch (e) {
    log.warn(`[CLI-TOOLS] no turn credential minted (${e.message}); tools will fail closed`);
  }
  return env;
}

// QUOXON-IDENTITY: the model-driven subprocess gets an ALLOWLISTED slice of the
// collector env, never `...process.env` (JWT_SECRET / INTERNAL_SERVICE_KEY /
// provider API keys must not be readable from the model's Bash).
const CLI_TOOLS_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ', 'TMPDIR',
  'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'QUOX_SUPERVISOR_TURN',
]);
function pickCliToolsEnv(parentEnv) {
  const out = {};
  for (const [k, v] of Object.entries(parentEnv || {})) {
    if (CLI_TOOLS_ENV_ALLOW.has(k) || k.startsWith('LC_')) out[k] = v;
  }
  return out;
}

module.exports = { mintTurnToken, applyTurnCredential, pickCliToolsEnv, TURN_TOKEN_AUDIENCE };
