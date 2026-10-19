'use strict';

/**
 * loopSpawnGrant: mint the X-Bastion-Approval-Grant for a QLoop dev-loop spawn.
 *
 * WHY: the Bastion refuses a governed exec that carries no approval grant. A
 * loop spawn is human-approved at the objective's before_start checkpoint (an
 * Approvals inbox item), so the grant is anchored to THAT resolved item and
 * bound to the exact per-spawn command + host. FAIL CLOSED: the only grantless
 * path is "no approval item at all" (scheduler / skip-checkpoint objectives,
 * unchanged behaviour). Anything else that is not provably this objective's
 * human approval throws, so the objective fails loudly instead of silently
 * spawning grantless.
 */

const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 300;

function makeLoopSpawnGrantFn({ orgId, objectiveId, approvalItemId, deps = {} } = {}) {
  return async function grantFn(hostId, command) {
    // The ONLY null path: no checkpoint item means no human gate was raised.
    if (!approvalItemId) return null;

    const fetchFn = deps.fetchFn || globalThis.fetch;
    const mintFn = deps.mintFn || require('./bastionSshExecutor')._internal.mintApprovalGrant;
    const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const nowFn = deps.nowFn || Date.now;
    const authUrl = deps.authUrl || process.env.AUTH_SERVICE_URL || `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
    const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');
    const maxWaitMs = deps.maxWaitMs !== undefined ? deps.maxWaitMs : DEFAULT_MAX_WAIT_MS;
    const pollIntervalMs = deps.pollIntervalMs !== undefined ? deps.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;

    const url = `${authUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items/${encodeURIComponent(approvalItemId)}`;
    const headers = serviceKey ? { 'X-Service-Key': serviceKey } : {};

    // Dispatch runs concurrently with the auth-side card resolve, so the item
    // can still read 'open' for a moment after the human approved. Poll,
    // bounded, rather than failing on that sub-second race.
    const started = nowFn();
    let item = null;
    let lastErr = null;
    for (;;) {
      try {
        const resp = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          lastErr = `auth returned ${resp.status}`;
          item = null;
        } else {
          const data = await resp.json();
          item = data && data.item ? data.item : null;
          lastErr = item ? null : 'response had no item';
          if (item && item.status === 'resolved') break;
        }
      } catch (err) {
        lastErr = err && err.message ? err.message : String(err);
        item = null;
      }
      if (nowFn() - started >= maxWaitMs) break;
      await sleepFn(pollIntervalMs);
    }

    const fail = (why) => new Error(`loop spawn grant refused for approval item ${approvalItemId}: ${why}`);
    if (!item) throw fail(`item not found or unreadable (${lastErr || 'unknown'})`);
    if (item.status !== 'resolved') throw fail(`item status is '${item.status}', not 'resolved' after ${maxWaitMs}ms`);
    if (item.kind !== 'approval') throw fail(`item kind is '${item.kind}', not 'approval'`);
    if (item.org_id !== orgId) throw fail('item org_id does not match the spawn org');
    const action = item.response && typeof item.response.action === 'string' ? item.response.action.trim().toLowerCase() : '';
    if (action !== 'approve' && action !== 'approved') throw fail(`response action is '${action || 'missing'}', not an approval`);
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
    if (!objectiveId || payload.objective_id !== objectiveId) throw fail('item payload.objective_id does not match this objective');
    if (payload.checkpoint_type !== 'before_start') throw fail(`item checkpoint_type is '${payload.checkpoint_type}', not 'before_start'`);

    // mintApprovalGrant is soft-fail (null on any error): treat null as a hard
    // refusal so a mint outage can never degrade into a grantless spawn.
    const grant = await mintFn({ itemId: approvalItemId, action: 'exec', command, targets: [hostId] });
    if (!grant) {
      throw new Error(`loop spawn grant mint failed for approved item ${approvalItemId}; refusing to spawn without X-Bastion-Approval-Grant`);
    }
    return grant;
  };
}

module.exports = { makeLoopSpawnGrantFn };
