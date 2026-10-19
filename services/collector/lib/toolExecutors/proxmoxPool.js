/**
 * Proxmox VM pool tool executors (DEVFLEET-P10).
 *
 * Thin adapters from agent tool input to lib/proxmoxPool.js. The org ALWAYS comes from the
 * trusted ctx (ctx.orgId), never from tool input. Host commands are governed one level down
 * (each goes through ssh_exec under the org's standing grant / HITL), so lease and release
 * add no approval card of their own; configure is a settings write and is gated by the
 * caller (agentTools.js, always-propose).
 */

'use strict';

const { PoolError, getPool } = require('../proxmoxPool.js');

function noOrg() {
  return { success: false, error: 'proxmox pool tools need an org context' };
}

function failure(e) {
  if (e instanceof PoolError) {
    return {
      success: false, error: e.message, code: e.code,
      ...(e.approvalId ? { pending: true, approvalId: e.approvalId, message: `A pool host command needs approval (${e.approvalId}); the VM was marked failed and nothing was retried.` } : {}),
    };
  }
  return { success: false, error: e && e.message ? e.message : String(e) };
}

async function proxmoxPoolStatus(ctx = {}, { pool = getPool() } = {}) {
  if (!ctx.orgId) return noOrg();
  try { return { success: true, ...pool.status(ctx.orgId) }; } catch (e) { return failure(e); }
}

async function proxmoxPoolLease(input = {}, ctx = {}, { pool = getPool() } = {}) {
  if (!ctx.orgId) return noOrg();
  try { return { success: true, lease: await pool.lease(ctx.orgId, input) }; } catch (e) { return failure(e); }
}

async function proxmoxPoolRelease(input = {}, ctx = {}, { pool = getPool() } = {}) {
  if (!ctx.orgId) return noOrg();
  const vmid = Number(input.vmid);
  try { return { success: true, released: await pool.release(ctx.orgId, vmid) }; } catch (e) { return failure(e); }
}

async function proxmoxPoolConfigure(input = {}, ctx = {}, { pool = getPool() } = {}) {
  if (!ctx.orgId) return noOrg();
  const patch = { ...input };
  for (const k of Object.keys(patch)) if (k.startsWith('_')) delete patch[k]; // approval-gate plumbing, not config
  try { return { success: true, config: pool.configure(ctx.orgId, patch) }; } catch (e) { return failure(e); }
}

/**
 * DEVFLEET-P15, PROPOSE phase: validate, read the target over the read-only REST path, compute the FULL
 * deterministic plan and store it. Mints nothing, runs no host command. Returns the exact input the
 * approval gate binds ({ ..., rehearsal_id, plan_sha256 }). Org from ctx only.
 */
async function proxmoxRehearsePrepare(input = {}, ctx = {}, { rehearser } = {}) {
  if (!ctx.orgId) return noOrg();
  const { getRehearser, RehearseError } = require('../proxmoxRehearse.js');
  try {
    const p = await (rehearser || getRehearser()).prepare(ctx.orgId, input);
    // The gate input is server-computed, but the caller's stated reason must still reach the card
    // (otherwise it reads "inferred, not stated by the caller"). It is display-only: the run never reads it.
    const why = typeof input._reason === 'string' ? input._reason.trim().slice(0, 500) : '';
    return { success: true, gateInput: why ? { ...p.gateInput, _reason: why } : p.gateInput, plan: p.plan };
  } catch (e) {
    if (e instanceof RehearseError) return { success: false, error: e.message, code: e.code };
    return failure(e);
  }
}

/** Approver identity must be a human principal, never the agent or a system label. */
// ALLOWLIST, not denylist: the approver must be a human user id exactly as the auth inbox
// respond handler sends it (req.user.id, a Crockford ULID). Anything else mints nothing.
const HUMAN_USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function humanApprover(a, ctx) {
  if (typeof a !== 'string') return null;
  const t = a.trim();
  if (!HUMAN_USER_ID_RE.test(t)) return null;
  if (ctx.agentId && t.toLowerCase() === String(ctx.agentId).toLowerCase()) return null;
  return t;
}

/**
 * DEVFLEET-P15, RUN phase. Called ONLY as the executeAction of withApprovalGate, i.e. after the gate
 * verified an approved resume and bound the input to what was approved. A grant is minted only when the
 * server-set ctx._claimedApproval (set by toolResume, never by tool input) names THIS approval and its
 * approver, and the stored approval row re-binds with the gate's own fingerprint helpers. Any doubt:
 * the run proceeds un-granted (each command individually governed by ssh_exec) and mints nothing.
 * Returns at once with { rehearsal_id, state:'running' }; poll proxmox_rehearsal_status.
 */
async function proxmoxRehearseRun(gateInput = {}, ctx = {}, { rehearser, approvals } = {}) {
  if (!ctx.orgId) return noOrg();
  const { getRehearser, RehearseError } = require('../proxmoxRehearse.js');
  const r = rehearser || getRehearser();
  let approval = null;
  try {
    const ca = ctx._claimedApproval;
    const approver = ca ? humanApprover(ca.approver, ctx) : null;
    if (ca && approver && gateInput._approvalId && ca.approval_id === gateInput._approvalId
      && ca.tool_name === 'proxmox_rehearse' && ca.org_id === ctx.orgId) {
      const gate = approvals || require('../approvalGate.js');
      const st = gate.getStoredInputFingerprint(gateInput._approvalId);
      if (st.ok && st.fingerprint === gate.computeInputFingerprint(gateInput)
        && st.row.tool_name === 'proxmox_rehearse' && st.row.org_id === ctx.orgId && st.row.status === 'resuming') {
        approval = { approvalId: gateInput._approvalId, approvedBy: approver };
      }
    }
    const s = await r.startApproved(ctx.orgId, gateInput, approval);
    s.done.catch(() => {});
    return {
      success: true, rehearsal_id: s.rehearsal_id, state: 'running', granted: !!s.grant_id, poll: 'proxmox_rehearsal_status',
      message: 'Rehearsal started. It takes minutes; poll proxmox_rehearsal_status with this rehearsal_id.',
    };
  } catch (e) {
    if (e instanceof RehearseError) return { success: false, error: e.message, code: e.code };
    return failure(e);
  }
}

async function proxmoxRehearsalStatus(input = {}, ctx = {}, { store } = {}) {
  if (!ctx.orgId) return noOrg();
  const id = typeof input.rehearsal_id === 'string' ? input.rehearsal_id.trim() : '';
  if (!/^RH_[0-9A-F]{16}$/.test(id)) return { success: false, error: 'rehearsal_id must look like RH_ followed by 16 hex characters', code: 'bad_request' };
  try {
    const rec = (store || require('../proxmoxRehearseStore.js')).get(ctx.orgId, id);
    if (!rec) return { success: false, error: `no rehearsal ${id} for this org`, code: 'not_found' };
    return { success: true, rehearsal: rec, ...rec };
  } catch (e) { return failure(e); }
}

module.exports = { proxmoxPoolStatus, proxmoxPoolLease, proxmoxPoolRelease, proxmoxPoolConfigure, proxmoxRehearsePrepare, proxmoxRehearseRun, proxmoxRehearsalStatus };
