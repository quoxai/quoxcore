'use strict';
/**
 * LUCID's approvals area is derived from the ONE server-side function that says which approvals
 * are open (auth: lib/openApprovals.js, read here over GET /api/internal/orgs/:org/approvals/open).
 * Journal events from the HITL hook still arrive live and trigger a refresh, but the SET (and so
 * the COUNT) is whatever that function returns: this reconciler appends an `ask` for every open
 * approval and retracts any approval:* subject the function no longer lists (quox#827).
 *
 * A failed read never retracts anything and is NAMED, not dropped: a `lucid:approvals-sync`
 * subject goes failing (operational ledger) until the next good read, and the failure is counted.
 * Nothing here throws into the caller.
 */

const MIN_GAP_MS = 10000;
const TIMEOUT_MS = 8000;
const _last = new Map();      // org -> { at, ok, error, count }
const _inflight = new Map();  // org -> Promise
const _failing = new Set();   // orgs with an open failure subject
const stats = { syncs: 0, ok: 0, failed: 0, last_error: null, last_error_at: null };

const FAIL_SUBJECT = 'lucid:approvals-sync';

function authBase(deps) {
  return deps.authBaseUrl || process.env.AUTH_SERVICE_URL
    || `http://${process.env.AUTH_HOST || 'quox-auth'}:${process.env.AUTH_PORT || '3101'}`;
}

async function fetchOpen(orgId, deps) {
  const key = deps.serviceKey !== undefined ? deps.serviceKey : process.env.INTERNAL_SERVICE_KEY;
  if (!key) throw new Error('INTERNAL_SERVICE_KEY not configured');
  const res = await (deps.fetchImpl || fetch)(`${authBase(deps)}/api/internal/orgs/${encodeURIComponent(orgId)}/approvals/open`, {
    headers: { 'x-service-key': key }, signal: AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.approvals)) throw new Error('unexpected response from auth approvals/open');
  return data;
}

/** The subject id: the tool-held approval id when the card carries one (what the HITL hook uses), else the inbox item id. */
const subjectOf = (a) => `approval:${a.approvalId || a.id}`;

function eventFor(a) {
  const tool = a.source === 'tool' ? ((a.item && a.item.payload && a.item.payload.toolName) || 'tool') : a.source;
  return {
    ledger: 'social', subject: subjectOf(a), kind: 'ask',
    state: { status: 'pending', tool_name: tool, source: a.source, inbox_item_id: a.id, ...(a.privileged ? { privileged: true } : {}), ...(a.conversationId ? { conversation_id: a.conversationId } : {}) },
    summary: String(a.title || `${tool} needs approval`).slice(0, 300),
    salience: { needs: 'owner', gates: [`tool:${tool}`] },
  };
}

async function syncOrg(orgId, deps = {}) {
  const journal = deps.journal || require('./journal.js');
  const now = deps.now ? deps.now() : Date.now();
  stats.syncs += 1;
  let data;
  try {
    data = await fetchOpen(orgId, deps);
  } catch (err) {
    stats.failed += 1; stats.last_error = err && err.message ? err.message : String(err); stats.last_error_at = now;
    _last.set(orgId, { at: now, ok: false, error: stats.last_error });
    console.error('[LUCID] approvals sync failed:', orgId, stats.last_error);
    try {
      if (journal.isReady()) {
        _failing.add(orgId);
        journal.append({ org_id: orgId, ledger: 'operational', subject: FAIL_SUBJECT, kind: 'state', ts: now,
          state: { status: 'failing', error: stats.last_error }, summary: `The approvals list could not be read (${stats.last_error}); LUCID's approvals may be out of date.`,
          source: { surface: 'collector', feed: 'hitl' } });
      }
    } catch (e) { console.error('[LUCID] approvals sync failure note not journaled:', e && e.message); }
    return { ok: false, error: stats.last_error };
  }
  const failedSources = Array.isArray(data.failed_sources) ? data.failed_sources : [];
  try {
    if (journal.isReady()) {
      journal.applySnapshot({ org_id: orgId, feed: 'hitl', prefix: 'approval:', ts: now, as_of: now, surface: 'collector', events: data.approvals.map(eventFor) });
      if (_failing.delete(orgId)) {
        // #968: carry a RECOVERY summary. Without it the retract row kept the previous FAILING
        // summary, so the situation's systems.last.L0 read "The approvals list could not be read ...
        // ago" long after it recovered and chat reported a resolved failure as current.
        journal.append({ org_id: orgId, ledger: 'operational', subject: FAIL_SUBJECT, kind: 'retract', ts: now,
          state: { status: 'recovered' }, summary: "The approvals list is readable again.",
          source: { surface: 'collector', feed: 'hitl' } });
      }
    }
  } catch (err) {
    stats.failed += 1; stats.last_error = err && err.message ? err.message : String(err); stats.last_error_at = now;
    _last.set(orgId, { at: now, ok: false, error: stats.last_error });
    console.error('[LUCID] approvals snapshot failed:', orgId, stats.last_error);
    return { ok: false, error: stats.last_error };
  }
  stats.ok += 1;
  _last.set(orgId, { at: now, ok: true, count: data.count, failed_sources: failedSources });
  if (failedSources.length) console.error('[LUCID] approvals sync: sub-sources failed:', JSON.stringify(failedSources).slice(0, 300));
  return { ok: true, count: data.count, failed_sources: failedSources };
}

/** Fire-and-forget refresh, gap-limited and de-duplicated per org. Safe to call from a hot read path. */
function kick(orgId, deps = {}) {
  if (!orgId) return null;
  if (process.env.VITEST && !deps.fetchImpl) return null; // unit tests that read a situation must not reach for a real auth service
  const now = deps.now ? deps.now() : Date.now();
  const l = _last.get(orgId);
  if (_inflight.has(orgId) || (l && now - l.at < (deps.minGapMs ?? MIN_GAP_MS))) return _inflight.get(orgId) || null;
  const p = syncOrg(orgId, deps).catch((e) => ({ ok: false, error: e && e.message })).finally(() => _inflight.delete(orgId));
  _inflight.set(orgId, p);
  return p;
}

function getStats() { return { ...stats, orgs: Object.fromEntries(_last) }; }
function _resetForTests() { _last.clear(); _inflight.clear(); _failing.clear(); for (const k of Object.keys(stats)) stats[k] = typeof stats[k] === 'number' ? 0 : null; }

module.exports = { syncOrg, kick, getStats, subjectOf, _resetForTests };
