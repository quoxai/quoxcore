/**
 * P2 evidence parity (NOC-SUITE / STREAM_NOC_SUITE §Launch P2).
 *
 * Emits the per-tool AEE + AOCL evidence and records the NOC outcome for a
 * single in-process agent-chat tool execution, mirroring the "gold" path in
 * server.js `/api/v1/tools/execute` (~5240-5351). Previously only the MCP /
 * tools-execute endpoints emitted this; agent-chat tool loops (NOC/SOC UI
 * actions dispatched to DAEDALUS/WARDEN) emitted VOLT `tool.call.executed` only,
 * so operator-triggered actions were the least-evidenced path.
 *
 * Scope note: run-lifecycle envelopes (aocl.run.start / aocl.run.complete and
 * the VOLT run itself) stay owned by each chat loop — this helper ONLY adds the
 * per-tool evidence those loops were missing, so there is no double-emit.
 *
 * `storeAuditEnvelope` is injected (it is a server.js module-scope function;
 * injecting avoids a circular require). `recordNocOutcome` and `TOOL_DEFS` live
 * in sibling libs and are required directly.
 */
const { recordNocOutcome } = require('./nocOutcomeRecorder.js');
const { buildCanonicalAction, actionEvidenceCommitment } = require('./canonicalAction.js');

let _toolDefs;
function toolDefs() {
  if (!_toolDefs) {
    try { _toolDefs = require('./agentTools.js').TOOL_DEFS || {}; }
    catch { _toolDefs = {}; }
  }
  return _toolDefs;
}

/**
 * @param {object}   p
 * @param {string}   p.toolName
 * @param {object}   [p.ctx]                 { agentId, orgId, userId, attachLeaseId, holderUserId }
 *   QUOXIDENTITY F2b: attachLeaseId/holderUserId mirror the fields the
 *   POST /api/v1/tools/execute gold path (server.js) stamps onto its own ctx
 *   from req.user.attach_lease_id / req.user.holder_user_id. When present
 *   (attach-lease caller) they are stamped into the AEE envelope payload
 *   below so the receipt names the responsible human alongside the agent.
 *   Callers that do not pass them (every pre-F2b caller) get byte-identical
 *   payloads to before.
 * @param {string}   [p.corrId]              correlation id (chat session id) to chain evidence
 * @param {number}   p.durationMs
 * @param {boolean}  p.success
 * @param {string}   [p.error]
 * @param {string}   [p.source]              default 'chat'
 * @param {Function} p.storeAuditEnvelope    injected server.js fn
 * @param {Function} [p.recordOutcome]       injectable for tests; defaults to the real recordNocOutcome
 * @param {*}        [p.input]               QUOXTRUST T1/D1: the tool input. When
 *   present, a canonical action is built and its CONTENT-FREE commitment
 *   (digest + per-field hashes, never the plaintext) is stamped into the AEE
 *   payload so the witness (which hashes the whole payload) binds WHAT ran, not
 *   just that something ran. Two different commands → different receipts. Omit
 *   it (every pre-D1 caller) and the payload is byte-identical to before.
 * @param {object}   [p.canonicalAction]     a prebuilt canonical action (from the
 *   executeTool entry); takes precedence over `input` so policy/approval/evidence
 *   all commit to the SAME action object.
 */
/**
 * @param {string} [p.disposition] 'executed' (default) or 'denied' — a DENIED
 *   call was refused at the reference monitor BEFORE any adapter fired; its
 *   receipt intent is ops.tool.denied / aocl.tool.denied so auditors can
 *   distinguish "policy stopped it" from "it ran and failed". Denies were
 *   previously UNWITNESSED at both chokes (WP3.5, 2026-09-28).
 */
/**
 * @param {object}  [p.actionCommitment] a PREBUILT content-free commitment
 *   (from a durable evidence-outbox snapshot); takes precedence over
 *   canonicalAction/input. Used by the WP4.1b boot re-emit, which holds the
 *   commitment but deliberately never held the plaintext input.
 * @param {object}  [p.recovery] WP4.1b crash-recovery marker: when set, the
 *   receipt payload carries { recovered: true, intent_state } so an auditor
 *   can tell a re-emitted receipt from a live one. Emit-only — a recovery
 *   receipt NEVER implies the effect was replayed.
 * @returns {{delivered: boolean}} delivered=true only when the audit sink
 *   CONFIRMED storage of both mandatory channels (system.tools + system.aocl).
 *   A sink that returns nothing (legacy signature) reads as not-confirmed, so
 *   the outbox keeps the debt — fail toward owed, never toward silence.
 */
// QUOXIDENTITY F2b + P9: attach-lease attribution (and the splinter id when the
// attach token carries one). Kept OUT of the receipt payload literal so the
// content-free payload stays compact for the w-d6 source-shape guard.
function attachAttribution(ctx) {
  if (!ctx || !ctx.attachLeaseId) return {};
  return {
    attach_lease_id: ctx.attachLeaseId,
    holder_user_id: ctx.holderUserId,
    ...(ctx.splinter ? { splinter: ctx.splinter } : {}),
  };
}

function emitToolEvidence({ toolName, toolDef, ctx = {}, input, canonicalAction, actionCommitment, recovery, corrId, durationMs, success, error, source = 'chat', disposition = 'executed', storeAuditEnvelope, recordOutcome } = {}) {
  if (!toolName) return { delivered: false };
  // toolDef is injectable for testability; production call sites omit it and
  // fall back to the shared TOOL_DEFS registry (same source the gold path uses).
  const def = toolDef !== undefined ? toolDef : toolDefs()[toolName];
  const aeeIntent = def?._aeeIntent || null;
  const aoclClassification = def?._aoclClassification || null;
  const agentId = ctx.agentId || 'quox';
  const errStr = error ? String(error).slice(0, 200) : undefined;

  // QUOXTRUST T1/D1: derive the content-free action commitment. Best-effort —
  // evidence must never throw and break a chat turn, and a caller that passes
  // neither `canonicalAction` nor `input` gets a null commitment (payload
  // byte-identical to the pre-D1 shape, guarded by toolEvidenceHolderAttribution).
  let actionCommit = null;
  try {
    if (actionCommitment) {
      actionCommit = actionCommitment; // outbox snapshot: commitment held, plaintext never was
    } else {
      const action = canonicalAction
        || (input !== undefined ? buildCanonicalAction(toolName, input, ctx) : null);
      if (action) actionCommit = actionEvidenceCommitment(action);
    }
  } catch { actionCommit = null; }

  let _storedTools = false;
  let _storedAocl = false;
  let _envIdTools = null;
  if (typeof storeAuditEnvelope === 'function') {
    // Per-tool AEE envelope — mirrors server.js:5240 (success) / 5312 (fail).
    const _r1 = storeAuditEnvelope({
      type: success ? 'event' : 'error',
      from: `agent.${agentId}`,
      to: 'system.tools',
      intent: disposition === 'denied'
        ? 'ops.tool.denied'
        : (success
          ? (aeeIntent || 'ops.tool.executed')
          : (aeeIntent ? `${aeeIntent}.failed` : 'ops.tool.failed')),
      corr: corrId,
      payload: {
        tool_name: toolName,
        agent_id: ctx.agentId,
        user_id: ctx.userId,
        org_id: ctx.orgId,
        duration_ms: durationMs,
        success,
        ...(errStr ? { error: errStr } : {}),
        ...(aoclClassification ? { aocl: aoclClassification } : {}),
        // QUOXIDENTITY F2b: attach-lease callers only (see jsdoc above).
        ...attachAttribution(ctx),
        // QUOXTRUST T1/D1: bind the effective action into the receipt. The WARD
        // witness recipe hashes the whole payload (payload_commit), so this
        // makes the witness commit to WHAT ran. Content-free (digest + per-field
        // hashes), never plaintext args. wardHookAEE also lifts field_hashes into
        // the WARD tags column for named-field divergence detection.
        ...(actionCommit ? { canonical_action: actionCommit } : {}),
        // WP4.1b: a crash-recovered receipt says so — never passes as live.
        ...(recovery ? { recovered: true, ...(recovery.intent_state ? { intent_state: recovery.intent_state } : {}) } : {}),
      },
    });
    _storedTools = !!(_r1 && _r1.stored);
    _envIdTools = (_r1 && _r1.id) || null;

    // AOCL layer trace — intent prefixed 'aocl.' so wardHookAOCL / the trace
    // viewer (filters intent LIKE 'aocl.%') pick it up. Mirrors server.js:5258 / 5330.
    const _r2 = storeAuditEnvelope({
      type: success ? 'event' : 'error',
      from: `agent.${agentId}`,
      to: 'system.aocl',
      intent: disposition === 'denied' ? 'aocl.tool.denied' : (success ? 'aocl.tool.execute' : 'aocl.tool.execute.failed'),
      corr: corrId,
      payload: {
        tool_name: toolName,
        agent_id: ctx.agentId,
        user_id: ctx.userId,
        org_id: ctx.orgId,
        duration_ms: durationMs,
        success,
        source,
        orgId: ctx.orgId,
        userId: ctx.userId,
        agentId: ctx.agentId,
        ...(errStr ? { error: errStr } : {}),
        ...(aoclClassification ? { aocl: aoclClassification } : {}),
      },
    });
    _storedAocl = !!(_r2 && _r2.stored);
  }

  try {
    const record = typeof recordOutcome === 'function' ? recordOutcome : recordNocOutcome;
    record(toolName, success, durationMs, {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      ...(errStr ? { error: errStr } : {}),
    });
  } catch { /* NOC outcome recorder is best-effort — never break a chat turn */ }

  // WP4.1b: delivered only when BOTH mandatory channels confirmed storage.
  // envelopeId = the system.tools receipt id (the reconciler's direction-1
  // join key: obligation -> envelope -> WARD entry via verifyReceipt).
  const _delivered = _storedTools && _storedAocl;

  // 2026-09-28 live defect: callers that emit their OWN evidence
  // (ctx._callerEmitsToolEvidence — the gold route + the 3 dispatcher paths)
  // made the choke defer its emit, so the obligation recorded at claim was
  // never settled and accumulated 'owed' forever (false stale-owed incidents
  // at the reconciler's grace). ONE settle owner (the C1 lesson): every path
  // that confirms storage through this function settles the debt, keyed by
  // the intent id executeTool stamped on ctx. Best-effort — an unsettled
  // debt degrades to reconciler visibility, never breaks the turn.
  if (_delivered && ctx && ctx._executionIntentId) {
    try {
      const at = require('./agentTools.js');
      if (typeof at.settleObligationDelivered === 'function') {
        at.settleObligationDelivered(ctx._executionIntentId, _envIdTools);
      }
    } catch { /* stays owed; reconciler-visible */ }
  }

  return { delivered: _delivered, envelopeId: _envIdTools };
}

module.exports = { emitToolEvidence };
