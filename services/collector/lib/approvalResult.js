/**
 * quox#791: read the stored outcome of a gated tool call.
 *
 * The HITL resume executor (toolResume.js) runs an approved tool and stores the
 * outcome in tool_approvals.result_json. This module is the ONE governed read of
 * that row, shared by:
 *   - withApprovalGate's `_approvalId` re-invocation (return the stored result,
 *     never "still pending", never a second execution), and
 *   - GET /api/v1/approvals/:id/result.
 * Org-scoped: a row belonging to another org is indistinguishable from absent.
 */
const toolApprovalStore = require('./toolApprovalStore.js');
const { redactSensitive } = require('./contentRedactor.js');

// Redact string LEAVES (never the serialised JSON: the redactor's patterns can
// swallow a closing quote and corrupt the document).
function redactResult(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactSensitive(value);
  if (depth > 12 || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactResult(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactResult(v, depth + 1);
  return out;
}

function parseStored(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}

/** The row, only if it belongs to orgId (and, when given, the same tool/agent). */
function scopedRow(approvalId, orgId, { toolName, agentId } = {}) {
  if (!approvalId || !orgId) return null;
  const row = toolApprovalStore.getByApprovalId(approvalId);
  if (!row || !row.org_id || row.org_id !== orgId) return null;
  if (toolName && row.tool_name !== toolName) return null;
  if (agentId && row.agent_id && row.agent_id !== agentId) return null;
  return row;
}

function readApprovalResult(approvalId, orgId, scope) {
  const row = scopedRow(approvalId, orgId, scope);
  if (!row) return null;
  const done = row.status === 'approved' || row.status === 'error';
  return {
    approval_id: row.approval_id,
    tool: row.tool_name,
    status: row.status,
    executed_at: done && row.result_json ? new Date(Number(row.updated_at)).toISOString() : null,
    result: done || row.status === 'denied' ? redactResult(parseStored(row.result_json)) : null,
  };
}

/**
 * Gate-side outcome for a re-invocation carrying `_approvalId`. Returns null when
 * the caller should fall through to the existing (pending) handling.
 */
function storedApprovalOutcome(approvalId, toolName, ctx = {}) {
  // No org context: there is no scope to read a stored result under, so do not
  // claim "not found" either. Fall through to the legacy `_approvalId` poll path,
  // which keeps its own fingerprint, #670 org binding and single-use claim checks
  // (fd446d441 turned this case into a 404 and broke approved re-invocation).
  if (!ctx || !ctx.orgId) return null;
  const row = scopedRow(approvalId, ctx.orgId, { toolName, agentId: ctx.agentId });
  if (!row) {
    // Only claim "not found" when the local store knows the tool-approval table;
    // legacy QuoxFlow-only approvals (no local row) keep the old path.
    if (toolApprovalStore.getByApprovalId(approvalId)) {
      return { success: false, _inputInvalid: true, status: 404, error: 'Approval not found' };
    }
    return null;
  }
  const meta = (status, extra = {}) => ({ id: approvalId, status, ...extra });
  switch (row.status) {
    case 'approved':
    case 'error': {
      if (!row.result_json) {
        // Approved by the legacy poll path but nothing stored: let it continue.
        return row.status === 'approved' ? null : { success: false, error: 'Approved action failed; no output stored', _approval: meta('error') };
      }
      const stored = redactResult(parseStored(row.result_json));
      const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : { output: stored };
      return {
        ...base,
        success: row.status === 'approved' ? base.success !== false : false,
        _approval: meta(row.status, { executed: true, executed_at: new Date(Number(row.updated_at)).toISOString() }),
      };
    }
    case 'resuming':
      return {
        success: false,
        executing: true,
        message: `Approval ${approvalId} approved, executing. Re-check shortly (quox approvals result ${approvalId}).`,
        _approval: meta('executing'),
      };
    case 'denied':
      return { success: false, error: 'Action denied', _approval: meta('denied') };
    case 'expired':
    case 'expire_close_failed':
      return { success: false, error: 'Approval request has expired', _approval: meta('expired') };
    default:
      return null; // pending: existing behaviour
  }
}

module.exports = { readApprovalResult, storedApprovalOutcome };
