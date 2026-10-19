'use strict';
/**
 * Per-turn tool gate for the Claude CLI tools path (2026-10-19, rel424-evidence on dev).
 *
 * The turn's tool selection was enforced only at OFFER: the CLI path lists its tools in the prompt and
 * the model runs them by name through `quox tool exec`, so a withheld tool (quoxbrain_search on a packs
 * question) still ran. Now the dispatcher registers exactly the names its prompt lists (catalogue +
 * index) under the turn token's turn_id, signs the token tools_gated, and POST /api/v1/tools/execute
 * refuses anything else for that turn. Covers cold spawns and warm spares alike (both carry this turn's
 * token); a native-name call the CLI refuses comes back through the same route.
 *
 * Collector memory only, TTL-capped, released at turn end. A gated token whose set is missing (released,
 * expired, collector restarted) fails CLOSED.
 */

const MAX_TTL_MS = 2 * 3600 * 1000;
const MAX_ENTRIES = 2000;
const entries = new Map(); // turnId -> { names: Set<string>, expiresAt }

function sweep(now) {
  for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
}

function registerTurnTools({ turnId, names, ttlMs, now = Date.now() } = {}) {
  if (!turnId) return false;
  sweep(now);
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  const ttl = Math.min(MAX_TTL_MS, Math.max(1000, Number(ttlMs) || 0));
  const set = new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n));
  entries.set(String(turnId), { names: set, expiresAt: now + ttl });
  return true;
}

function releaseTurnTools(turnId) {
  if (turnId) entries.delete(String(turnId));
}

/** null = may run; else the route's JSON body (a tool result the model reads). Only gated turn tokens are checked. */
function turnToolRefusal(user, toolName, { now = Date.now() } = {}) {
  if (!user || user.tools_gated !== true) return null;
  const e = user.turn_id ? entries.get(String(user.turn_id)) : null;
  if (e && e.expiresAt > now && e.names.has(toolName)) return null;
  const why = e && e.expiresAt > now
    ? `Not run: ${toolName} is not available in this turn (it was not offered for this request). Use only the tools listed in your prompt; if none of them can answer, say so plainly.`
    : `Not run: ${toolName} is not available in this turn (this turn's tool set has ended). Answer with what you already have.`;
  try { console.warn(`[TurnToolGate] refused ${toolName}: not offered on turn ${user.turn_id || '-'}${e ? '' : ' (no turn set)'}`); } catch { /* log only */ }
  return { success: false, dropped: true, not_offered: true, error: why };
}

function _reset() { entries.clear(); }

module.exports = { registerTurnTools, releaseTurnTools, turnToolRefusal, _reset };
