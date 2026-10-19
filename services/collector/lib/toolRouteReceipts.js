'use strict';

/**
 * The per-call receipts of POST /api/v1/tools/execute (every `quox tool exec`, the CLI-tools chat path), in one place.
 *
 * Receipts honesty (SITE-CLI 2026-10-17): the route wrote success:true into aocl.run.complete, ops.tool.executed and
 * aocl.tool.execute whenever the tool did not THROW, so a tool that refused by RETURNING { success:false } was
 * witnessed as a success (live: a gripe refused at the connector choke, repo_not_allowed, carried three success:true
 * receipts). A returned failure now gets the same .failed receipts as a thrown one. A call held for a human is not a
 * failure (same rule as claudeMessagesDispatcher / openaiInvokeDispatcher). The failure payloads are the route's own,
 * unchanged; the success receipts stay inline in server.js.
 */

// HELD = waiting on a human approval: it carries an approval marker. A bare pending:true with no approval is a call
// still RUNNING (a delegation past its wait deadline, live 2026-10-17 08:00:03), which is not "held for approval".
function isHeld(r) {
  return !!r && typeof r === 'object' && ((r._approval && r._approval.status === 'pending')
    || r.status === 'pending_approval' || r.status === 'held'
    || (r.pending === true && !!(r.approvalId || r.approval_id)));
}
const isPending = (r) => !!r && typeof r === 'object' && r.pending === true && !isHeld(r);

/**
 * What a chat dispatcher tells the MODEL about a call that has not finished, or null when it has. The one held rule
 * for the receipts AND the model (HYPERION review): an approval hold says pending_approval with the approval id; a
 * call still running says in_progress with its handle, never "awaiting approval".
 */
function modelPendingContent(toolName, r) {
  if (isHeld(r)) {
    return JSON.stringify({
      status: 'pending_approval',
      approval_id: (r._approval && r._approval.id) || r.approvalId || r.approval_id || null,
      message: r.message || r.error || 'Waiting for a human to approve this action.',
      tool: toolName,
    });
  }
  if (isPending(r)) {
    return JSON.stringify({
      status: 'in_progress',
      ...(r.handle ? { handle: r.handle } : {}),
      message: r.message || r.error || r.response || 'Still running; the result will arrive later.',
      tool: toolName,
    });
  }
  return null;
}

/** 'ok' | 'failed' | 'held' | 'pending' for one call: { result } after a return, { error } after a throw. */
function classifyRouteResult({ result, error } = {}) {
  if (error) return 'failed';
  if (isHeld(result)) return 'held';
  if (isPending(result)) return 'pending';
  if (result && typeof result === 'object' && result.success === false) return 'failed';
  return 'ok';
}

const errorText = ({ result, error }) => String((error && error.message) || (result && (result.error || result.message)) || 'failed');

function emitToolRouteReceipts({
  outcome, result, error, tool_name, ctx = {}, input, durationMs, runStartCorr, corrId, aeeIntent = null,
  aoclClassification = null, toolActionCommit = null, voltRunId,
  storeAuditEnvelope, voltEmitter, recordNocOutcome, settle,
}) {
  const from = `agent.${ctx.agentId || 'quox'}`;
  const ids = { tool_name, agent_id: ctx.agentId, user_id: ctx.userId, org_id: ctx.orgId, duration_ms: durationMs };
  const camel = { orgId: ctx.orgId, userId: ctx.userId, agentId: ctx.agentId };
  // QUOXIDENTITY F2b: attach-lease callers only, names the human who holds the lease alongside the agent that acted
  const lease = ctx.attachLeaseId ? { attach_lease_id: ctx.attachLeaseId, holder_user_id: ctx.holderUserId, ...(ctx.splinter ? { splinter: ctx.splinter } : {}) } : {};
  const aocl = aoclClassification ? { aocl: aoclClassification } : {};
  // QUOXTRUST T1/D1: bind the effective (or attempted) action, content-free, into the receipt
  const action = toolActionCommit ? { canonical_action: toolActionCommit } : {};

  // MCP-AUDIT-1b: the tool RETURNED (ok or a returned failure): VOLT records what it returned
  if (!error && outcome === 'failed') {
    voltEmitter.emit(voltRunId, 'tool.call.executed', {
      actor: {
        actor_type: 'agent',
        actor_id: ctx.agentId || 'quox',
        ...(ctx.attachLeaseId ? { holder_user_id: ctx.holderUserId, attach_lease_id: ctx.attachLeaseId, ...(ctx.splinter ? { splinter: ctx.splinter } : {}) } : {}),
      },
      tool: tool_name,
      input: input || {},
      output: result,
      duration_ms: durationMs,
    });
  }

  // the route writes the success receipts itself (unchanged); the failure and held receipts live here
  if (outcome !== 'failed' && outcome !== 'held' && outcome !== 'pending') throw new Error(`emitToolRouteReceipts: outcome must be 'failed' or 'held' or 'pending' (got ${outcome})`);

  // quox#1235: HELD for a human. Nothing ran, so no executed event, no failRun, no NOC outcome; the request's run
  // completes with the hold recorded; status 'held' + the approval id (the trace links to the inbox item), success
  // never set. The held receipt settles the evidence obligation: a receipt was delivered, and the resumed call after
  // approval writes its own.
  // A call still RUNNING (pending, no approval: a delegation past its wait deadline) is witnessed the same way under
  // its own word: status 'pending' + the handle to follow it, no success, not failed; the late answer is its own record.
  if (outcome === 'held' || outcome === 'pending') {
    const approvalId = outcome === 'held' ? ((result && (result.approvalId || result.approval_id || (result._approval && result._approval.id))) || null) : null;
    const handle = outcome === 'pending' ? ((result && result.handle) || null) : null;
    const st = { status: outcome, ...(approvalId ? { approval_id: approvalId } : {}), ...(handle ? { handle } : {}) };
    voltEmitter.emit(voltRunId, `tool.call.${outcome}`, { tool: tool_name, ...(outcome === 'held' ? { approval_id: approvalId } : { handle }), duration_ms: durationMs });
    voltEmitter.completeRun(voltRunId);
    storeAuditEnvelope({ type: 'event', from, to: 'system.aocl', intent: `aocl.run.${outcome}`, corr: runStartCorr,
      payload: { ...ids, ...st, source: 'mcp', ...camel } });
    const receipt = storeAuditEnvelope({ type: 'event', from, to: 'system.tools', intent: aeeIntent ? `${aeeIntent}.${outcome}` : `ops.tool.${outcome}`, corr: corrId,
      payload: { ...ids, ...st, ...aocl, ...lease, ...action } });
    if (receipt && receipt.stored && ctx._executionIntentId) { try { settle(ctx._executionIntentId, receipt.id); } catch { /* stays owed */ } }
    storeAuditEnvelope({ type: 'event', from, to: 'system.aocl', intent: `aocl.tool.execute.${outcome}`, corr: corrId,
      payload: { ...ids, ...st, source: 'mcp', ...camel, ...aocl } });
    return { outcome };
  }
  const err = errorText({ result, error });
  voltEmitter.failRun(voltRunId, error || new Error(err));
  // MCPB-HARDEN-1c: aocl.run.failed so the trace viewer sees failed tool calls
  storeAuditEnvelope({ type: 'error', from, to: 'system.aocl', intent: 'aocl.run.failed', corr: runStartCorr,
    payload: { ...ids, error: err.slice(0, 200), source: 'mcp', ...camel } });
  // AEE-CORE-1: the failure receipt shares the success path's corr, so it stays chained to its chat/session
  const receipt = storeAuditEnvelope({ type: 'error', from, to: 'system.tools', intent: aeeIntent ? `${aeeIntent}.failed` : 'ops.tool.failed', corr: corrId,
    payload: { ...ids, error: err.slice(0, 200), ...aocl, ...lease, ...action } });
  if (receipt && receipt.stored && ctx._executionIntentId) { try { settle(ctx._executionIntentId, receipt.id); } catch { /* stays owed */ } }
  // MCP-AUDIT-1c: AOCL failure trace
  storeAuditEnvelope({ type: 'error', from, to: 'system.aocl', intent: 'aocl.tool.execute.failed', corr: corrId,
    payload: { ...ids, error: err.slice(0, 200), source: 'mcp', ...camel, ...aocl } });
  recordNocOutcome(tool_name, false, durationMs, { orgId: ctx.orgId, agentId: ctx.agentId, userId: ctx.userId, error: err });
  return { outcome: 'failed' };
}

module.exports = { emitToolRouteReceipts, classifyRouteResult, isHeld, isPending, modelPendingContent };
