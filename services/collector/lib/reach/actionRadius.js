'use strict';

/**
 * actionRadius.js — BLAST-RADIUS-P1
 *
 * computeActionRadius() turns the P0 static reach closure
 * (reachResolver.createReachResolver) into a per-call summary sized for the
 * HITL approval surface: what this specific call NAMES (requests), plus a
 * compact summary of what the calling agent MAY touch more broadly (the
 * static closure), never the full closure itself — approvers need "3 hosts,
 * 2 credentials, spans 3 classes", not a raw dump of every grant.
 *
 * HONESTY RULES (same discipline as reachResolver.js):
 *  - `requests` is a literal read of a small, fixed set of input field
 *    names. It is never a guess at what the tool MIGHT do — an empty array
 *    is the honest answer when the call names nothing.
 *  - A failed or timed-out static resolution is NEVER silently treated as
 *    "no reach" — `may` is genuinely absent (not emptied) and `unknown`
 *    carries a `zone: 'resolver'` entry naming why. computeActionRadius()
 *    itself never throws; every failure path degrades to this shape.
 *  - The badge is delegated to reachResolver.deriveBadge (not
 *    reimplemented), including on the failure path, where it is computed
 *    from an all-empty input — the same "best-effort floor" contract
 *    documented on deriveBadge itself.
 */

const { deriveBadge } = require('./reachResolver.js');

const DEFAULT_TIMEOUT_MS = 3000;

function defaultNowIso() {
  return new Date().toISOString();
}

// Deriving a badge for the "we could not resolve reach at all" path reuses
// the exact same pure function reachResolver uses for a partial failure —
// no separate/duplicated ladder logic here.
const EMPTY_BADGE_INPUT = { credentials: [], hosts: [], egress: [], delegates: { direct: [], closure: [] } };

// ============================================================================
// requests — literal extraction from a small, fixed set of input fields.
// ============================================================================

function pushRequest(requests, seen, kind, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const v of value) pushRequest(requests, seen, kind, v);
    return;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const id = String(value).trim();
  if (!id) return;
  const dedupeKey = `${kind}:${id}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  requests.push({ kind, id });
}

/**
 * Extract what a tool call NAMES, from a fixed field->kind map:
 *   host, node        -> 'host'
 *   vmid               -> 'vm'
 *   target_id          -> 'target'
 *   url                -> 'url'
 *   command            -> 'command'
 *   credential_id(s)   -> 'credential'
 * Never inspects arbitrary/unknown input keys — that would be a guess, not
 * a naming.
 */
function extractRequests(input) {
  const requests = [];
  const seen = new Set();
  if (!input || typeof input !== 'object') return requests;
  pushRequest(requests, seen, 'host', input.host);
  pushRequest(requests, seen, 'host', input.node);
  pushRequest(requests, seen, 'vm', input.vmid);
  pushRequest(requests, seen, 'target', input.target_id);
  pushRequest(requests, seen, 'url', input.url);
  pushRequest(requests, seen, 'command', input.command);
  pushRequest(requests, seen, 'credential', input.credential_id);
  pushRequest(requests, seen, 'credential', input.credential_ids);
  return requests;
}

// ============================================================================
// timeout wrapper — hard internal cap so a wedged/slow static resolution
// never blocks the approval-gate call path.
// ============================================================================

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`static reach resolution timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => clearTimeout(timer));
}

// ============================================================================
// computeActionRadius
// ============================================================================

/**
 * @param {{toolName:string, input:object, agentId:string, orgId:string}} call
 * @param {{resolveStaticReach: (agentId:string, orgId:string) => Promise<object>, nowIso?: () => string, timeoutMs?: number}} deps
 * @returns {Promise<object>} ActionRadius v1 — never throws.
 */
async function computeActionRadius(call = {}, deps = {}) {
  const { input, agentId, orgId } = call;
  const nowIso = deps.nowIso || defaultNowIso;
  const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const requests = extractRequests(input);

  let staticResult = null;
  let failureReason = null;
  try {
    if (typeof deps.resolveStaticReach !== 'function') {
      throw new Error('computeActionRadius: deps.resolveStaticReach is required');
    }
    staticResult = await withTimeout(deps.resolveStaticReach(agentId, orgId), timeoutMs);
  } catch (err) {
    failureReason = (err && err.message) || String(err);
  }

  if (!staticResult) {
    return {
      v: 1,
      computed_at: nowIso(),
      duration_ms: Date.now() - startedAt,
      requests,
      cannot: [],
      unknown: [{
        zone: 'resolver',
        statement: `reach-unavailable: static reach resolution failed${failureReason ? ` (${failureReason})` : ''}`,
      }],
      badge: deriveBadge(EMPTY_BADGE_INPUT, null),
    };
  }

  const sources = staticResult.sources || {};
  const mayIn = staticResult.may || {};
  const credentialItems = Array.isArray(mayIn.credentials) ? mayIn.credentials : [];
  const hostItems = Array.isArray(mayIn.hosts) ? mayIn.hosts : [];

  return {
    v: 1,
    computed_at: nowIso(),
    duration_ms: Date.now() - startedAt,
    requests,
    may: {
      tools: (sources.tools && sources.tools.count) || 0,
      credentials: (sources.credentials && sources.credentials.count) || 0,
      hosts: (sources.hosts && sources.hosts.count) || 0,
      egress: (sources.egress && sources.egress.count) || 0,
      delegates: (sources.delegation && sources.delegation.count) || 0,
      top: {
        credentials: credentialItems.slice(0, 3).map((c) => (c && (c.name || c.id)) || 'unknown'),
        hosts: hostItems.slice(0, 3).map((h) => (h && h.id) || 'unknown'),
      },
    },
    cannot: Array.isArray(staticResult.cannot) ? staticResult.cannot : [],
    unknown: Array.isArray(staticResult.unknown) ? staticResult.unknown : [],
    badge: staticResult.badge || deriveBadge(EMPTY_BADGE_INPUT, null),
  };
}

module.exports = {
  computeActionRadius,
  extractRequests,
};
