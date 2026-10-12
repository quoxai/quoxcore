'use strict';
/**
 * LUCID's approval filer: turns a "run" measure into a REAL human approval through the existing
 * governed gate (approvalGate.withApprovalGate -> agent-propose gate -> inbox card). It never runs
 * anything itself and never approves: the executor handed to the gate always refuses. When a person
 * approves the card, toolResume re-invokes the real ssh_exec tool (bastion, grant-aware) with the
 * stored host + command, witnessed like any other gated call.
 *
 * Covered: ssh_exec only (bastion shell on a fleet host by short hostname). Anything else, or a
 * "this box" target whose item carries no host, is reported as
 * unavailable so the caller stays honest ("manual, nothing filed").
 */

const ALLOWED_TOOL = 'ssh_exec';

async function fileApproval(orgId, spec, deps = {}) {
  const gate = deps.withApprovalGate || require('../approvalGate.js').withApprovalGate;
  if (!spec || spec.tool_name !== ALLOWED_TOOL) {
    return { unavailable: `LUCID can only file approvals for ${ALLOWED_TOOL}, not ${spec && spec.tool_name}` };
  }
  const params = spec.params || {};
  const command = String(params.command || '').trim();
  if (!command) return { unavailable: 'the measure has no command to run' };
  // "this box" means the host the item was reported from (the gatherer stamps state.host); no env-only setting.
  const selfHost = deps.selfHost !== undefined ? deps.selfHost : (spec.host || '');
  let host = String(params.host || '').trim();
  if (!host || host === 'this box' || /\{host\}/.test(host)) host = String(selfHost || '').trim();
  if (!host) return { unavailable: 'LUCID does not know which host this item came from, so it cannot file a governed command for it' };

  const agentId = spec.area === 'systems' ? 'nova' : 'lucid';
  const reason = `${spec.title || 'LUCID measure'}. ${String(spec.body_md || '').replace(/\n{2,}/g, ' ').trim()} Asked for by ${spec.requested_by || 'a person'} through LUCID (${spec.ref || 'item'}, ${spec.measure_id || 'measure'}).`.slice(0, 1500);
  const input = { host, command, reason };
  const res = await gate(ALLOWED_TOOL, input, async () => ({ success: false, error: 'LUCID never executes; a person must approve the filed request' }),
    { orgId, agentId });
  if (!res || !res.approvalId) {
    throw Object.assign(new Error('approval could not be filed'), { code: 'file_failed' });
  }
  return { approval_id: res.approvalId };
}

module.exports = { fileApproval };
