'use strict';

/**
 * QUOXHAT P0 — per-turn tool manifest instrumentation (measurement only).
 *
 * Records, per chat turn, the resolved tool count with its ORIGIN
 * decomposition (hardcoded grant vs DB descriptor vs connector vs
 * entity-loaded — the tags agentTools.js already stamps on each definition)
 * plus cap status per provider leg (primary vs the #653 OpenAI fallback
 * leg). This is the baseline the QuoxHat study (QUOXHAT_STUDY.md §1, §12 P0)
 * requires before any hat behaviour ships: real org-specific counts, not the
 * static 172/124/48 incident numbers.
 *
 * In-memory ring buffer, org-scoped reads. Deliberately NOT a durable store:
 * the JSONL baseline log (logToolRetrievalBaseline in server.js) remains the
 * durable record; this buffer feeds the read-only Settings + Mirror surface.
 * Observation only — nothing here may modify the tool array or throw into
 * the chat path.
 */

const TURN_TOOL_STATS_MAX = 500;

let _entries = [];

/**
 * Decompose a resolved tool array by origin. Most specific tag wins:
 * entity (_entity: true, stamped by entityToolLoader.js) >
 * connector (provider: 'connector:<family>', stamped by getToolsWithConnectors) >
 * db / hardcoded (source, stamped by _resolveToolsForAgent) > other.
 *
 * @param {Array} tools resolved tool definitions
 * @returns {{total:number, hardcoded:number, db:number, connector:number, entity:number, other:number}}
 */
function summarizeToolOrigins(tools) {
  const s = { total: 0, hardcoded: 0, db: 0, connector: 0, entity: 0, other: 0 };
  if (!Array.isArray(tools)) return s;
  s.total = tools.length;
  for (const t of tools) {
    if (!t || typeof t !== 'object') { s.other++; continue; }
    if (t._entity === true) s.entity++;
    else if (typeof t.provider === 'string' && t.provider.startsWith('connector:')) s.connector++;
    else if (t.source === 'db') s.db++;
    else if (t.source === 'hardcoded') s.hardcoded++;
    else s.other++;
  }
  return s;
}

/**
 * Record one turn's tool stats. Never throws (instrumentation must not
 * affect chat). Entry shape:
 *   { orgId, agent, provider, leg: 'primary'|'openai_fallback',
 *     raw, final, truncated, smart, cap, origins, estimatedTokens? }
 */
function recordTurnToolStats(entry) {
  try {
    if (!entry || typeof entry !== 'object') return;
    _entries.push({ ts: new Date().toISOString(), ...entry });
    if (_entries.length > TURN_TOOL_STATS_MAX) {
      _entries = _entries.slice(-TURN_TOOL_STATS_MAX);
    }
  } catch { /* never block the request */ }
}

/**
 * Org-scoped read. Returns { entries, agents } where entries are newest
 * first (bounded by limit, default 100) and agents aggregates per agent:
 * { turns, lastRaw, lastFinal, lastOrigins, lastLeg, lastProvider,
 *   truncatedTurns, fallbackCapTurns, lastTs }.
 */
function getTurnToolStats({ orgId, limit = 100 } = {}) {
  const scoped = _entries.filter(e => e.orgId === orgId);
  const agents = {};
  for (const e of scoped) {
    const key = e.agent || 'unknown';
    const a = agents[key] || (agents[key] = {
      turns: 0, truncatedTurns: 0, fallbackCapTurns: 0,
      lastRaw: null, lastFinal: null, lastOrigins: null,
      lastLeg: null, lastProvider: null, lastTs: null,
      lastHat: null, // QUOXHAT P2: { hat_key, hat_revision, hat_source, manifest_digest, manifest_size, enforced }
    });
    a.turns++;
    if (e.truncated) a.truncatedTurns++;
    if (e.leg === 'openai_fallback') a.fallbackCapTurns++;
    a.lastRaw = e.raw ?? a.lastRaw;
    a.lastFinal = e.final ?? a.lastFinal;
    a.lastOrigins = e.origins ?? a.lastOrigins;
    a.lastLeg = e.leg ?? a.lastLeg;
    a.lastProvider = e.provider ?? a.lastProvider;
    a.lastTs = e.ts ?? a.lastTs;
    a.lastHat = e.hat ?? a.lastHat;
  }
  const bounded = Math.max(1, Math.min(Number(limit) || 100, TURN_TOOL_STATS_MAX));
  return { entries: scoped.slice(-bounded).reverse(), agents };
}

/** Test-only reset. */
function _resetTurnToolStats() { _entries = []; }

module.exports = {
  summarizeToolOrigins,
  recordTurnToolStats,
  getTurnToolStats,
  _resetTurnToolStats,
  TURN_TOOL_STATS_MAX,
};
