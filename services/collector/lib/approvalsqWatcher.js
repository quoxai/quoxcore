/**
 * ApprovalsQ watcher (QVOICE-OUTBOUND #521 P2): escalates a STALE HITL
 * approval by placing a phone call so a HUMAN decides.
 *
 * HARD RULE: this module never approves, denies or otherwise resolves an
 * approval. It detects due items, asks the voice bridge to phone a person,
 * and tracks escalation state in approvalsq_escalations. The decision is made
 * by the human, on the call (PIN-gated) or in the dashboard.
 *
 * Loop hygiene (the mandatory triad, modeled on feedScheduler.js):
 *  (a) FAILURE ACCOUNTING: an auth-fetch error or a bridge POST error is
 *      counted in `errors` (plus fetchFailed / placeFailed) and logged as a
 *      failure. It is never folded into "0 due items".
 *  (b) BACKOFF: an org whose dependency failed is skipped for
 *      min(consecutiveFailures, FAILURE_COOLDOWN_CAP_TICKS) ticks, success
 *      resets the streak. A tick that made no progress at all (no call placed,
 *      nothing reconciled) stretches the next interval, capped.
 *  (c) RETIREMENT: resolved / exhausted / cancelled rows are never
 *      re-attempted; calls per approval are bounded by policy.max_retries.
 *
 * Kill switch: QUOX_APPROVALSQ_WATCHER (default OFF). While unset or falsy
 * startApprovalsqWatcher() creates no timers and returns null.
 *
 * Deployment note: the voice bridge listens on the HOST loopback (:3112). The
 * collector runs in a container, so 127.0.0.1 inside it is NOT the host. Set
 * QUOX_TELEPHONY_BRIDGE_URL (docker-compose defaults it to
 * http://host.docker.internal:3112, which needs the host-gateway extra_hosts
 * mapping) so the container can reach the bridge.
 */

'use strict';

const crypto = require('crypto');
const { normalizePolicy, isDue } = require('./approvalsqPolicy.js');

const DEFAULT_WARMUP_MS = 90 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const FAILURE_COOLDOWN_CAP_TICKS = 4;
const ZERO_PROGRESS_BACKOFF_CAP_TICKS = 4;
const HTTP_TIMEOUT_MS = 10 * 1000;
const OPEN_ITEMS_LIMIT = 200;
const POLICY_PLUGIN_ID = 'quox-voice';
const POLICY_KEY = 'approvalsq.policy';

function cooldownTicks(failureStreak) {
  return Math.min(Math.max(failureStreak, 0), FAILURE_COOLDOWN_CAP_TICKS);
}

function isTruthyEnv(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function parseItemPayload(p) {
  if (p && typeof p === 'object') return p;
  try { return JSON.parse(p || '{}'); } catch { return {}; }
}

function createApprovalsqWatcher(deps = {}) {
  const nowFn = deps.nowFn || (() => new Date());
  const log = deps.log || ((m) => console.log(`[ApprovalsQ] ${m}`));
  const store = deps.store;
  const callbackBase = String(deps.callbackBase || '').replace(/\/+$/, '');

  // Per-org failure streaks and remaining cooldown ticks. Keyed by org id.
  const failureStreak = new Map();
  const cooldownLeft = new Map();
  let zeroProgressStreak = 0;
  let zeroProgressSkip = 0;
  let running = false;

  function noteFailure(orgId) {
    const n = (failureStreak.get(orgId) || 0) + 1;
    failureStreak.set(orgId, n);
    cooldownLeft.set(orgId, cooldownTicks(n));
  }

  function noteSuccess(orgId) {
    failureStreak.delete(orgId);
    cooldownLeft.delete(orgId);
  }

  async function reconcile(orgId, openIds, summary) {
    for (const row of store.listActive(orgId)) {
      if (openIds.has(row.approval_id)) continue;
      let next = 'cancelled';
      if (typeof deps.fetchApprovalById === 'function') {
        let item;
        try {
          item = await deps.fetchApprovalById(orgId, row.approval_id);
        } catch (e) {
          summary.errors++;
          summary.fetchFailed++;
          log(`reconcile lookup FAILED org=${orgId} approval=${row.approval_id}: ${String(e && e.message || e).slice(0, 120)}`);
          continue; // unknown state: leave the row alone, retry next tick
        }
        // Item still pending (e.g. fell off the list page): leave it be.
        if (item && ['open', 'in_progress', 'waiting'].includes(item.status)) continue;
        if (item && item.status === 'resolved') next = 'resolved';
      }
      store.update(row.id, { state: next });
      summary.reconciled++;
    }
  }

  async function placeCall(orgId, policy, item, row, summary) {
    const now = nowFn();
    let current = row;
    if (!current) {
      store.insert({ id: crypto.randomUUID(), org_id: orgId, approval_id: item.id, item_id: item.id });
      current = store.getRow(orgId, item.id);
    }
    const attempts = (current.attempts || 0) + 1;
    // Count the attempt BEFORE the network call so a crash mid-POST still
    // bounds the number of calls placed for this approval.
    store.update(current.id, {
      state: 'calling',
      attempts,
      last_attempt_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + policy.gap_minutes * 60000).toISOString(),
      last_outcome: null,
    });
    summary.due++;
    try {
      const res = await deps.placeApprovalCall({
        approval_id: item.id,
        org_id: orgId,
        escalation_id: current.id,
        callback_url: `${callbackBase}/api/v1/approvalsq/escalations/${current.id}/outcome`,
        to: policy.destination_number || undefined,
      });
      const sid = res && res.call_sid;
      if (sid) store.update(current.id, { last_call_sid: String(sid).slice(0, 128) });
      summary.placed++;
      return true;
    } catch (e) {
      store.update(current.id, { last_outcome: 'error' });
      summary.errors++;
      summary.placeFailed++;
      log(`bridge call FAILED org=${orgId} approval=${item.id} attempt=${attempts}: ${String(e && e.message || e).slice(0, 120)}`);
      return false;
    }
  }

  async function processOrg(orgId, summary) {
    let policy;
    try {
      policy = normalizePolicy(await deps.readPolicy(orgId));
    } catch (e) {
      summary.errors++;
      summary.policyFailed++;
      noteFailure(orgId);
      log(`policy read FAILED org=${orgId}: ${String(e && e.message || e).slice(0, 120)}`);
      return;
    }
    if (!policy.enabled) return;
    summary.orgsEnabled++;

    let items;
    try {
      items = await deps.fetchOpenApprovals(orgId);
      if (!Array.isArray(items)) throw new Error('open approvals response was not a list');
    } catch (e) {
      summary.errors++;
      summary.fetchFailed++;
      noteFailure(orgId);
      log(`auth fetch FAILED org=${orgId}: ${String(e && e.message || e).slice(0, 120)}`);
      return;
    }

    const now = nowFn();
    const openIds = new Set(items.map((i) => i.id));
    await reconcile(orgId, openIds, summary);

    let orgPlaceFailed = false;
    for (const item of items) {
      summary.checked++;
      const row = store.getRow(orgId, item.id);
      if (row && ['resolved', 'exhausted', 'cancelled'].includes(row.state)) continue; // RETIREMENT
      let evalRow = row;
      if (row && row.state === 'calling') {
        if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now.getTime()) continue; // still in the gap
        const noMoreCalls =
          (row.attempts || 0) >= policy.max_retries ||
          row.last_outcome === 'answered' ||
          (row.last_outcome === 'voicemail' && policy.voicemail_policy === 'leave');
        if (noMoreCalls) {
          // Leave the HITL item pending: the human still has it in the dashboard.
          store.update(row.id, { state: 'exhausted' });
          summary.exhausted++;
          continue;
        }
        evalRow = { ...row, state: 'pending' }; // retry candidate, re-check the policy
      }
      const verdict = isDue(item, policy, evalRow, now);
      if (!verdict.due) continue;
      const ok = await placeCall(orgId, policy, item, row, summary);
      if (!ok) orgPlaceFailed = true;
    }
    if (orgPlaceFailed) noteFailure(orgId);
    else noteSuccess(orgId);
  }

  /** One pass over every org. Per-org errors never block other orgs. */
  async function tick() {
    const summary = {
      orgs: 0, orgsEnabled: 0, skippedCooldown: 0, checked: 0, due: 0, placed: 0,
      reconciled: 0, exhausted: 0, errors: 0, fetchFailed: 0, placeFailed: 0, policyFailed: 0,
    };
    let orgIds;
    try {
      orgIds = await deps.listOrgIdsFn();
    } catch (e) {
      summary.errors++;
      log(`org list FAILED: ${String(e && e.message || e).slice(0, 120)}`);
      return summary;
    }
    for (const orgId of orgIds || []) {
      summary.orgs++;
      const left = cooldownLeft.get(orgId) || 0;
      if (left > 0) {
        cooldownLeft.set(orgId, left - 1);
        summary.skippedCooldown++;
        continue;
      }
      try {
        await processOrg(orgId, summary);
      } catch (e) {
        summary.errors++;
        noteFailure(orgId);
        log(`org tick FAILED org=${orgId}: ${String(e && e.message || e).slice(0, 120)}`);
      }
    }
    if (summary.errors > 0) {
      log(`tick ERRORS=${summary.errors} (fetch=${summary.fetchFailed} bridge=${summary.placeFailed} policy=${summary.policyFailed}) placed=${summary.placed} due=${summary.due}`);
    } else if (summary.placed > 0 || summary.reconciled > 0 || summary.exhausted > 0) {
      log(`tick ok placed=${summary.placed} reconciled=${summary.reconciled} exhausted=${summary.exhausted}`);
    }
    return summary;
  }

  /** Interval entry point: adds the guard against overlap and the tick-level zero-progress backoff. */
  async function scheduledTick() {
    if (running) return null;
    if (zeroProgressSkip > 0) {
      zeroProgressSkip--;
      return null;
    }
    running = true;
    try {
      const s = await tick();
      const progress = s.placed + s.reconciled + s.exhausted > 0;
      if (progress) {
        zeroProgressStreak = 0;
      } else {
        zeroProgressStreak++;
        zeroProgressSkip = Math.min(zeroProgressStreak, ZERO_PROGRESS_BACKOFF_CAP_TICKS);
      }
      return s;
    } catch (e) {
      log(`tick CRASHED: ${String(e && e.message || e).slice(0, 120)}`);
      return null;
    } finally {
      running = false;
    }
  }

  return { tick, scheduledTick };
}

let active = null;

/**
 * Starts the recurring watcher. Returns null (and creates NO timers) unless
 * QUOX_APPROVALSQ_WATCHER is truthy.
 */
function startApprovalsqWatcher(deps = {}) {
  const env = deps.env || process.env;
  if (!isTruthyEnv(env.QUOX_APPROVALSQ_WATCHER)) return null;
  if (active) return active.handle;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const intervalMs = num(env.QUOX_APPROVALSQ_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const warmupMs = num(env.QUOX_APPROVALSQ_WARMUP_MS, DEFAULT_WARMUP_MS);
  const w = createApprovalsqWatcher(deps);
  const warmup = setTimeoutFn(() => { w.scheduledTick(); }, warmupMs);
  if (warmup && warmup.unref) warmup.unref();
  const interval = setIntervalFn(() => { w.scheduledTick(); }, intervalMs);
  if (interval && interval.unref) interval.unref();
  active = { handle: w, interval, warmup, clearIntervalFn, clearTimeoutFn };
  console.log(`[ApprovalsQ] watcher started interval=${intervalMs}ms warmup=${warmupMs}ms`);
  return w;
}

function stopApprovalsqWatcher() {
  if (!active) return;
  active.clearIntervalFn(active.interval);
  active.clearTimeoutFn(active.warmup);
  active = null;
}

// ---------------------------------------------------------------------------
// Real-network adapters (injected by server.js; tests use fakes instead).
// ---------------------------------------------------------------------------

async function httpJson(url, init, fetchFn = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function createDefaultAdapters({ env = process.env, fetchFn = fetch } = {}) {
  const authBase = (env.AUTH_SERVICE_URL || 'http://auth:3101').replace(/\/+$/, '');
  const bridgeBase = (env.QUOX_TELEPHONY_BRIDGE_URL || 'http://host.docker.internal:3112').replace(/\/+$/, '');
  const serviceHeaders = () => ({ 'x-service-key': env.INTERNAL_SERVICE_KEY || '' });
  return {
    async fetchOpenApprovals(orgId) {
      const q = `kind=approval&status=open&limit=${OPEN_ITEMS_LIMIT}`;
      const body = await httpJson(`${authBase}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items?${q}`, { headers: serviceHeaders() }, fetchFn);
      return Array.isArray(body && body.items) ? body.items : null;
    },
    async fetchApprovalById(orgId, itemId) {
      try {
        const body = await httpJson(`${authBase}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items/${encodeURIComponent(itemId)}`, { headers: serviceHeaders() }, fetchFn);
        return body && body.item ? body.item : null;
      } catch (e) {
        if (/HTTP 404/.test(String(e && e.message))) return null; // genuinely gone
        throw e;
      }
    },
    async placeApprovalCall({ approval_id, org_id, escalation_id, callback_url, to }) {
      const secret = env.TELEPHONY_TRIGGER_SECRET || '';
      if (!secret) throw new Error('TELEPHONY_TRIGGER_SECRET not set');
      // The bridge route reads these as query parameters (FastAPI scalars).
      const qs = new URLSearchParams({ approval_id, org_id, escalation_id, callback_url });
      if (to) qs.set('to', to);
      return httpJson(`${bridgeBase}/telephony/approval-call?${qs.toString()}`, {
        method: 'POST',
        headers: { 'X-Quox-Trigger': secret },
      }, fetchFn);
    },
  };
}

module.exports = {
  createApprovalsqWatcher,
  startApprovalsqWatcher,
  stopApprovalsqWatcher,
  createDefaultAdapters,
  cooldownTicks,
  FAILURE_COOLDOWN_CAP_TICKS,
  POLICY_PLUGIN_ID,
  POLICY_KEY,
};
