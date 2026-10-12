/**
 * AEE envelope retention policy.
 *
 * Categorises envelopes by intent prefix, assigns a TTL, and exposes a pure
 * resolver. The actual GC query lives in server.js and uses this module to
 * determine which rows are eligible for deletion.
 *
 * Why per-intent TTL?  Some event classes are high-volume / low-signal
 * (AOCL layer ticks, ops sync events) and consume disk without giving
 * long-term audit value; others (chat, auth, vault, objectives) are
 * load-bearing for compliance and must survive for a year by default.
 *
 * All TTLs here are defaults — a future org-level override table can pass
 * merged rules in via `customRules`.
 */

const DAYS = 24 * 60 * 60 * 1000;

/**
 * Rules are evaluated in order; first match wins. Each rule is a
 * { match: (intent) => boolean, ttlMs: number, name: string } triple.
 * Using a function lets us express prefix matches, multi-prefix matches,
 * and exact-intent matches without a mess of LIKE patterns.
 */
export const DEFAULT_RULES = [
  // High-volume infra — short retention
  { name: 'aocl-layer-events',   ttlMs: 7 * DAYS,   match: (i) => i.startsWith('aocl.layer.') },
  { name: 'aocl-run-events',     ttlMs: 30 * DAYS,  match: (i) => i.startsWith('aocl.run.') },
  { name: 'ops-sync-events',     ttlMs: 3 * DAYS,   match: (i) => i.startsWith('ops.volt.') || i.startsWith('ops.sync.') },
  { name: 'heartbeats',          ttlMs: 1 * DAYS,   match: (i) => i.includes('heartbeat') || i === 'quoxagent.heartbeat.report' },
  { name: 'agent-stream-chatter', ttlMs: 14 * DAYS, match: (i) => i === 'quox.agent.thinking' || i === 'quox.agent.session_end' || i === 'quox.agent.session_start' || i === 'quox.agent.session_status' },

  // Compliance-critical — long retention (or forever, represented as Infinity)
  { name: 'auth',                ttlMs: Infinity,   match: (i) => i.startsWith('quox.auth.') },
  { name: 'vault',               ttlMs: Infinity,   match: (i) => i.startsWith('quox.vault.') },
  { name: 'policy-decisions',    ttlMs: Infinity,   match: (i) => i.startsWith('aocl.policy.') },
  { name: 'objectives',          ttlMs: 730 * DAYS, match: (i) => i.startsWith('quox.objective.') },
  { name: 'flow-runs',           ttlMs: 730 * DAYS, match: (i) => i.startsWith('quox.flow.') },
  { name: 'approvals',           ttlMs: Infinity,   match: (i) => i.startsWith('quox.approval.') },

  // Everything else (chat, tool calls, terminal exec, voice, etc.)
  { name: 'default',             ttlMs: 365 * DAYS, match: () => true },
];

/**
 * Resolve the retention TTL for a given intent string.
 * @param {string} intent
 * @param {{ customRules?: typeof DEFAULT_RULES }} [opts]
 * @returns {{ ttlMs: number, ruleName: string }}
 */
export function resolveRetention(intent, opts = {}) {
  const rules = opts.customRules || DEFAULT_RULES;
  const i = String(intent || '');
  for (const rule of rules) {
    try {
      if (rule.match(i)) return { ttlMs: rule.ttlMs, ruleName: rule.name };
    } catch { /* bad matcher — skip */ }
  }
  return { ttlMs: Infinity, ruleName: 'default' };
}

/**
 * Decide whether an envelope (given its intent + ts ISO string) is expired
 * relative to `now`. Witnessed envelopes (VOLT/WARD) should be skipped by
 * the caller regardless of this result — retention is a floor, not a ceiling.
 *
 * @param {string} intent
 * @param {string|number} ts - ISO timestamp or ms epoch
 * @param {{ now?: number, customRules?: typeof DEFAULT_RULES }} [opts]
 * @returns {{ expired: boolean, ageMs: number, ttlMs: number, ruleName: string }}
 */
export function isExpired(intent, ts, opts = {}) {
  const now = opts.now ?? Date.now();
  const tsMs = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const ageMs = now - tsMs;
  const { ttlMs, ruleName } = resolveRetention(intent, opts);
  const expired = Number.isFinite(ttlMs) && ageMs > ttlMs;
  return { expired, ageMs, ttlMs, ruleName };
}

/**
 * Summarise the rule set for logging / admin UI.
 */
export function describePolicy(rules = DEFAULT_RULES) {
  return rules.map(r => ({
    name: r.name,
    ttl_days: Number.isFinite(r.ttlMs) ? Math.round(r.ttlMs / DAYS) : null,
  }));
}

export default {
  DEFAULT_RULES,
  resolveRetention,
  isExpired,
  describePolicy,
};
