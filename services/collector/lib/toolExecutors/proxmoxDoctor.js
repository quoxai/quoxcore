'use strict';
/**
 * VM Doctor tool executors (DEVFLEET-DOCTOR). Thin adapters from agent tool input to
 * lib/proxmoxDoctor.js. The org ALWAYS comes from the trusted ctx (ctx.orgId), never from tool
 * input. Both tools are read only.
 */

const REPORT_ID_RE = /^DR_[0-9A-F]{16}$/;

function noOrg() { return { success: false, error: 'proxmox_vm_doctor needs an org context' }; }

async function proxmoxVmDoctor(input = {}, ctx = {}, deps = {}) {
  if (!ctx.orgId) return noOrg();
  const target = input.target === undefined || input.target === null ? '' : String(input.target).trim();
  if (!target) return { success: false, error: 'missing_target', detail: 'target (VM name or vmid) is required' };
  const doctor = deps.doctor || require('../proxmoxDoctor.js');
  const out = await doctor.diagnose(ctx.orgId, { target }, { callBastion: deps.callBastion, pveGet: deps.pveGet, toolRun: deps.toolRun, store: deps.store, emit: deps.emit });
  if (!out.success) return out;
  return { success: true, ...out.report };
}

async function proxmoxDoctorReport(input = {}, ctx = {}, { store } = {}) {
  if (!ctx.orgId) return noOrg();
  const id = typeof input.report_id === 'string' ? input.report_id.trim() : '';
  if (!REPORT_ID_RE.test(id)) return { success: false, error: 'report_id must look like DR_ followed by 16 hex characters', code: 'bad_request' };
  try {
    const rec = (store || require('../proxmoxDoctorStore.js')).get(ctx.orgId, id);
    if (!rec) return { success: false, error: `no doctor report ${id} for this org`, code: 'not_found' };
    return { success: true, ...rec };
  } catch (e) { return { success: false, error: e && e.message ? e.message : String(e) }; }
}

module.exports = { proxmoxVmDoctor, proxmoxDoctorReport, REPORT_ID_RE };
