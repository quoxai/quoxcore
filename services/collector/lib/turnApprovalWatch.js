'use strict';
/**
 * CLI-QUOX B1 / R1 #30: let a running conversation turn hear about an approval
 * it raised being resolved (approved, denied, failed) while the turn is still
 * streaming. One listener on toolApprovalStore.onFinalized fans out to the
 * watchers of that approval id. A watcher only ever sees rows of its own org.
 *
 * In-process only: the resume executor and the stream route live in the same
 * collector process. A resolution after the turn has closed is not delivered
 * here (the client's inbox refresh covers that case).
 */

const watchers = new Map(); // approvalId -> Set<{ orgId, fn }>
let registered = false;

function ensureListener() {
  if (registered) return;
  registered = true;
  require('./toolApprovalStore.js').onFinalized((row, status, resultJson) => {
    if (!row || !row.approval_id) return;
    const set = watchers.get(row.approval_id);
    if (!set) return;
    let result = null;
    try { result = resultJson ? JSON.parse(resultJson) : null; } catch { result = null; }
    for (const w of Array.from(set)) {
      if (String(row.org_id) !== String(w.orgId)) continue; // never another org's approval
      try { w.fn({ approvalId: row.approval_id, status, result, tool: row.tool_name }); } catch { /* a watcher must never break finalize */ }
    }
  });
}

/**
 * @param {{approvalId:string, orgId:string}} key
 * @param {(outcome:{approvalId:string,status:string,result:object|null,tool:string})=>void} fn
 * @returns {() => void} unwatch
 */
function watchApproval({ approvalId, orgId }, fn) {
  if (!approvalId || !orgId || typeof fn !== 'function') return () => {};
  ensureListener();
  const entry = { orgId, fn };
  let set = watchers.get(approvalId);
  if (!set) { set = new Set(); watchers.set(approvalId, set); }
  set.add(entry);
  return () => {
    const s = watchers.get(approvalId);
    if (!s) return;
    s.delete(entry);
    if (s.size === 0) watchers.delete(approvalId);
  };
}

function _watchCount() { let n = 0; for (const s of watchers.values()) n += s.size; return n; }

module.exports = { watchApproval, _watchCount };
