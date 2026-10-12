/**
 * System-scope allowlist — QF-MT WP9 (staged enforcement, plan §6).
 *
 * Mirrors the collector default-deny gate pattern (quox-dashboard
 * services/collector/utils/collectorAuthGate.js, stream #52 / plan §3): a
 * small, greppable, path-prefix allowlist so "which routes may a service key
 * legitimately read cross-org, with no X-Org-Id header" is provable by
 * reading this one file, not by tracing every route handler.
 *
 * Used ONLY by resolveOrgScope()'s {kind:'system'} branch, and ONLY when
 * QUOXFLOW_ORG_ENFORCEMENT=enforced. In advisory (default) mode this file's
 * allowlist has no effect — every service-key-no-X-Org-Id call still
 * resolves to {kind:'system'} exactly as before (see org-scope.ts).
 *
 * Every entry below is a genuinely org-agnostic system surface — NOT a
 * tenant-data route. Tenant-data routes (workflows, executions, envelopes,
 * evidence, approvals, budgets, policies, observations, triggers, schedules,
 * skills) are deliberately NOT here: under enforced mode a service key
 * without X-Org-Id gets 403 on those, forcing callers to supply X-Org-Id
 * (the WP8 collector fix, quox-dashboard repo) — that tightening is the
 * entire point of the flip.
 */

const ALLOWLIST: Array<{ methods: '*' | Set<string>; test: (path: string) => boolean }> = [
  // Toolsmith webhook callback + ops-only manual cron triggers
  // (skill-decay/skill-judge/skill-safety-judge/run). No org concept —
  // these operate over the whole skill library, not a single tenant.
  { methods: '*', test: p => p === '/api/internal' || p.startsWith('/api/internal/') },

  // Global engine validation suite (plan §3: "validation.ts ... N/A —
  // global system suite"). Runs synthetic validation agents, not tenant data.
  { methods: '*', test: p => p === '/api/validation' || p.startsWith('/api/validation/') },

  // CLI-PARITY route manifest — introspection of the Hono app's own route
  // table, not tenant data.
  { methods: new Set(['GET']), test: p => p === '/__routes' },
];

/**
 * True if `method`+`path` is a legitimate system-scope (cross-org) surface
 * under enforced mode. Everything else requires X-Org-Id from a service-key
 * caller once enforcement is flipped.
 */
export function isSystemScopeAllowlisted(method: string, path: string): boolean {
  for (const entry of ALLOWLIST) {
    if ((entry.methods === '*' || entry.methods.has(method)) && entry.test(path)) return true;
  }
  return false;
}
