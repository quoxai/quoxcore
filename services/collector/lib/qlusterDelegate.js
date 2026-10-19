/**
 * qlusterDelegate.js — Qluster Phase 5b box-side governed-delegation.
 *
 * The seam where an EXTERNAL Qluster controller tasks THIS box's agent, under
 * THIS box's OWN governance. Sovereignty is the whole point: the controller
 * does not get a privileged back door — the delegated prompt runs through the
 * box's identical chat pipeline (L1 identity → L3 policy gate → HITL → AOCL →
 * L8 output check). The box's policy can DENY the delegation; the box raises
 * its OWN HITL approval; nothing here auto-approves or bypasses a layer.
 *
 * Auth (route-level, before this handler runs):
 *   requireQlusterScope('agent.delegate') — a scoped bearer PLUS, because
 *   agent.delegate is an OPERATIONAL scope (isOperationalScope), an Ed25519-
 *   signed envelope with ±120s ts + replay-nonce protection. Same trust model
 *   as backups/trigger. On success req.qlusterController = { id, name, scopes,
 *   allowed_orgs }.
 *
 * How governance applies (the injection, and its honest limit):
 *   We invoke the box's real chat handler (handleCollectorChat) IN-PROCESS with
 *   a synthetic request. That handler is pure request→JSON (status + json only,
 *   no SSE), so it can be driven with a captured response object. Every
 *   governance layer runs exactly as for a local request:
 *     - service-key auth (INTERNAL_SERVICE_KEY) + body.org_id, NO user_id →
 *       the handler's "org-system actor" branch. We never forge a human user.
 *     - runPreLLMPipeline (L1/L3) evaluates the box's policies for that org and
 *       can DENY or require approval; L8 checks output; AOCL emits its trail.
 *   LIMIT: handleCollectorChat hard-codes its internal audit `from` as
 *   `human.anonymous`/`human.<user>` — it has no hook to stamp the controller
 *   principal. So we emit our OWN qluster.delegate audit envelope carrying
 *   `from: qluster:<controller_id>` and the chained corr. No governance is
 *   skipped; the controller principal is captured in the delegation envelope,
 *   the internal chat trail records the org-system run it actually was.
 *
 * Response contract (the controller builds against this):
 *   200 { status:'completed',   reply, corr }
 *   202 { status:'pending_hitl', corr, inbox_item_id|null, reason }
 *   403 { status:'denied', error:'policy_denied', corr, reason }
 *                                         — a TRUE box sovereignty verdict (L3)
 *   400 { error:'missing_prompt' }        — no prompt
 *   400 { error:'org_id_required' }       — no org binding
 *   403 { error:'org_not_allowed' }       — controller not scoped to the org
 *   401 { error:'not_authorized' }        — middleware didn't attach controller
 *   502 { status:'box_exec_failed', corr, reason, layer:'L7'|null }
 *                                         — the delegation reached the box and
 *                                           passed identity+policy but FAILED at
 *                                           execution (L7 LLM dispatch: expired
 *                                           credential, rate-limit, CLI spawn
 *                                           error) or any non-policy downstream
 *                                           failure. NOT a sovereignty verdict.
 *   502 { status:'error', corr, reason }  — the pipeline itself threw
 *
 * QLUSTER-LOOP-B box-operator control ("require my approval for delegated
 * tasks", see qlusterDelegationSettings.js): a box-wide switch, independent of
 * GOV-4 policy, that short-circuits EVERY delegation straight to 202
 * pending_hitl — checked AFTER org/auth checks, BEFORE the chat pipeline runs,
 * so no LLM call happens pre-approval. Shares the same mint+persist+respond
 * tail (mintPendingAndRespond) as the box's own L3 approval_required outcome.
 * Does not touch aoclPipeline/aoclContext/the approvalGranted grant path.
 */

const crypto = require('crypto');
const { mintInboxItem } = require('./inboxMint.js');

function genCorrDefault() {
  return `QDEL_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`.toUpperCase();
}

// Error codes from runPreLLMPipeline that represent a governance DENIAL (as
// opposed to approval_required, which is a distinct HITL outcome). Anything
// ending in _policy_violation, plus identity/evaluator failures, is a hard
// deny → surfaced to the controller as policy_denied.
function isPolicyDenial(errorCode) {
  if (!errorCode) return false;
  return (
    errorCode.endsWith('_policy_violation') ||
    errorCode === 'identity_required' ||
    errorCode === 'policy_evaluator_error'
  );
}

/**
 * QLUSTER-LOOP-B — shared HITL mint+persist+respond tail. Used by BOTH:
 *   1. the `approval_required` branch (the box's OWN L3 gate ran and required
 *      approval), and
 *   2. the box-operator short-circuit ("require my approval for delegated
 *      tasks" — queues EVERY delegation regardless of L3 policy, BEFORE the
 *      chat pipeline runs).
 *
 * Mints the inbox item on the auth service (best-effort transport — a mint
 * failure never blocks the delegation from becoming resumable), persists the
 * pending_hitl row keyed by corr so the resume executor can replay the STORED
 * prompt, audits qluster.delegate.pending_hitl, and responds 202 pending_hitl.
 * NEVER throws — the inbox mint and store write are both wrapped and
 * non-fatal, mirroring the original Phase 1 tail this was extracted from.
 */
async function mintPendingAndRespond({
  res, corr, orgId, controller, selectedAgent, prompt, reason,
  controllerIdentity, safeAudit, fetchImpl, authBaseUrl, serviceKey, store,
  existingInboxItemId = null,
}) {
  let inboxItemId = existingInboxItemId;
  // quox#562: mechanics live in lib/inboxMint.js (never throws). Best-effort:
  // the pending row is still written so the delegation is resumable by corr.
  if (fetchImpl) {
    const r = await mintInboxItem({
      orgId,
      title: `Delegation approval — ${selectedAgent} · ${String(corr).slice(-6)}`,
      bodyMd: reason,
      kind: 'approval',
      priority: 'high',
      aeeCorrelationId: corr,
      payload: {
        type: 'qluster_delegation',
        controller_id: controller.id,
        selected_agent: selectedAgent,
        what: {
          action: 'delegate to fleet agent',
          target: `agent ${selectedAgent} on controller ${controller.id}`,
          summary: `send this prompt to ${selectedAgent} (controller ${controller.id}): ${String(prompt || '').replace(/\s+/g, ' ').slice(0, 140)}`,
        },
      },
    }, { authBaseUrl, serviceKey, fetchImpl });
    if (r.ok) {
      inboxItemId = r.itemId || inboxItemId;
    } else {
      console.warn('[qluster.delegate] inbox mint failed (non-fatal):', r.error);
    }
  }

  // Persist the pending row (prompt/org/agent/inbox_item_id) so the resume
  // executor can replay the exact stored prompt.
  try {
    if (store && typeof store.putPending === 'function') {
      store.putPending({
        corr,
        org_id: orgId,
        controller_id: controller.id,
        selected_agent: selectedAgent,
        prompt,
        inbox_item_id: inboxItemId,
      });
    }
  } catch (e) {
    console.warn('[qluster.delegate] putPending failed (non-fatal):', e && e.message);
  }

  safeAudit({
    type: 'event',
    from: controllerIdentity,
    to: `agent.${selectedAgent}`,
    intent: 'qluster.delegate.pending_hitl',
    corr,
    payload: { controller_id: controller.id, inbox_item_id: inboxItemId, org_id: orgId || null },
  });
  return res.status(202).json({
    status: 'pending_hitl',
    corr,
    inbox_item_id: inboxItemId,
    reason,
  });
}

/**
 * Factory: build the POST /api/v1/qluster/delegate handler.
 *
 * @param {object} deps
 * @param {Function} deps.chatHandler - async (req,res) => box chat (handleCollectorChat)
 * @param {Function} [deps.audit]     - storeAuditEnvelope (NEVER POST /aee/store — that skips WARD)
 * @param {string}   [deps.serviceKey]- INTERNAL_SERVICE_KEY for the in-process invoke
 * @param {Function} [deps.genCorr]   - correlation-id generator (test override)
 * @param {object}   [deps.store]     - qlusterDelegationStore (QLUSTER-LOOP-B) for pending rows
 * @param {string}   [deps.authBaseUrl] - AUTH_SERVICE_URL base for the inbox POST
 * @param {Function} [deps.fetchImpl] - fetch impl (test override; defaults to global fetch)
 * @param {object}   [deps.settings]  - QLUSTER-LOOP-B box-operator settings store
 *                                      (qlusterDelegationSettings.js) exposing
 *                                      getDelegationRequireApproval(). When it
 *                                      returns true, the handler short-circuits
 *                                      to pending_hitl BEFORE the chat pipeline
 *                                      runs — no LLM call happens pre-approval.
 */
function createDelegateHandler(deps = {}) {
  const {
    chatHandler,
    audit = () => {},
    serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
    genCorr = genCorrDefault,
    store = null,
    authBaseUrl = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101',
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    settings = null,
  } = deps;

  return async function delegateHandler(req, res) {
    // requireQlusterScope('agent.delegate') must have run first.
    const controller = req.qlusterController;
    if (!controller || !controller.id) {
      return res.status(401).json({ error: 'not_authorized' });
    }
    if (typeof chatHandler !== 'function') {
      return res.status(500).json({ error: 'delegate_not_configured' });
    }

    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return res.status(400).json({ error: 'missing_prompt' });
    }

    // Org-binding (mirror qlusterBackupProxy). A delegated prompt runs
    // tool-capable under an org's agents + policies, so the controller MUST be
    // scoped to that org — otherwise a controller enrolled for org A could
    // target org B (cross-tenant). org_id is mandatory (also avoids the
    // null-org branch where the box's org policies may not bind). Fail-closed.
    const orgId = (typeof body.org_id === 'string' && body.org_id) ? body.org_id : '';
    if (!orgId) {
      return res.status(400).json({ error: 'org_id_required' });
    }
    const allowedOrgs = Array.isArray(controller.allowed_orgs) ? controller.allowed_orgs : [];
    if (!allowedOrgs.includes(orgId)) {
      return res.status(403).json({ error: 'org_not_allowed' });
    }

    const controllerIdentity = `qluster:${controller.id}`;
    const corr = (typeof body.corr === 'string' && body.corr) ? body.corr : genCorr();
    const selectedAgent = (typeof body.selected_agent === 'string' && body.selected_agent) ? body.selected_agent : 'quox';

    // Audit the inbound delegation BEFORE running it (chained corr) — via
    // storeAuditEnvelope so it flows through WARD, never a bare /aee/store.
    const safeAudit = (envelope) => { try { audit(envelope); } catch { /* audit never blocks delegation */ } };
    safeAudit({
      type: 'task',
      from: controllerIdentity,
      to: `agent.${selectedAgent}`,
      intent: 'qluster.delegate',
      corr,
      payload: {
        controller_id: controller.id,
        controller_name: controller.name || null,
        org_id: orgId || null,
        prompt_len: prompt.length,
      },
    });

    // QLUSTER-LOOP-B box-operator short-circuit — "require my approval for
    // delegated tasks". Checked AFTER org/auth checks, BEFORE the chat
    // pipeline runs: if the box operator has this switched on, EVERY
    // delegation queues on the inbox regardless of what the box's own L3
    // policy would decide. Does NOT touch aoclPipeline/aoclContext/the
    // approvalGranted grant path — this only decides whether the pipeline
    // runs at all. The resume executor (Phase 3) replays the stored prompt on
    // approval, so no LLM call happens until a human approves.
    let requireApproval = false;
    if (settings && typeof settings.getDelegationRequireApproval === 'function') {
      try { requireApproval = !!settings.getDelegationRequireApproval(); } catch { requireApproval = false; }
    }
    if (requireApproval) {
      return mintPendingAndRespond({
        res, corr, orgId, controller, selectedAgent, prompt,
        reason: 'This box requires approval for all delegated tasks (operator setting).',
        controllerIdentity, safeAudit, fetchImpl, authBaseUrl, serviceKey, store,
      });
    }

    // Synthetic request: run the box's OWN chat pipeline under a service-key,
    // org-scoped, NO-user (system-scope) identity — the governed path. Never
    // forge a human user; never a cookie/JWT.
    const syntheticReq = {
      body: {
        prompt,
        session_id: corr,
        selected_agent: selectedAgent,
        ...(orgId ? { org_id: orgId } : {}),
      },
      headers: {
        'x-service-key': serviceKey,
        'x-qluster-delegated-by': controllerIdentity,
      },
      // handleCollectorChat registers req.on('close', ...) for disconnect tracking.
      on: () => {},
      socket: {},
    };

    const captured = { status: 200, body: null };
    const syntheticRes = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      status(code) { this.statusCode = code; captured.status = code; return this; },
      json(b) { captured.body = b; this.writableEnded = true; return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      write() { return true; },
      end() { this.writableEnded = true; return this; },
    };

    try {
      await chatHandler(syntheticReq, syntheticRes);
    } catch (err) {
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.error',
        corr,
        payload: { error: err && err.message ? err.message : String(err) },
      });
      return res.status(502).json({ status: 'error', corr, reason: 'delegation_pipeline_error' });
    }

    const outBody = captured.body || {};
    const outStatus = captured.status || 200;
    const errorCode = outBody.error || null;

    // 1) HITL — the box requires its own approval. Check FIRST: the pipeline
    //    returns httpStatus 403 for approval_required, so it must be
    //    distinguished before the generic 403 deny branch. Do NOT auto-approve.
    if (errorCode === 'approval_required') {
      const reason = outBody.result || outBody.errorMessage || 'approval_required';

      // QLUSTER-LOOP-B: make this delegation RESUMABLE. The box's L3 gate is
      // stateless — it mints no inbox item and cannot resume. So the delegation
      // path (here, and ONLY here) mints the inbox item on the auth service and
      // persists a pending_hitl row keyed by corr. When a human approves that
      // item, auth calls the collector resume endpoint, which replays the
      // STORED prompt with a grant signal. Shared with the box-operator
      // short-circuit above via mintPendingAndRespond.
      const inboxItemId =
        outBody.inbox_item_id || (outBody.approval && outBody.approval.inbox_item_id) || null;
      return mintPendingAndRespond({
        res, corr, orgId, controller, selectedAgent, prompt, reason,
        controllerIdentity, safeAudit, fetchImpl, authBaseUrl, serviceKey, store,
        existingInboxItemId: inboxItemId,
      });
    }

    // 2) BOX EXECUTION FAILURE at L7 — the delegation reached the box, passed
    //    identity (L1) + policy (L3), then FAILED at the actual LLM dispatch
    //    (expired credential, rate-limit, CLI spawn error). stackModeDispatch
    //    surfaces this as a 403 carrying deniedByLayer:'L7' / error:'l7_denied'
    //    / message:'Blocked at L7'. This is NOT a sovereignty verdict, so it
    //    MUST be classified before the generic 403-deny branch and told truthfully
    //    as an execution failure, never as the box's policy denying the action.
    const isL7Failure = outBody.deniedByLayer === 'L7' || errorCode === 'l7_denied';
    if (isL7Failure) {
      const layer = (outBody.deniedByLayer === 'L7' || errorCode === 'l7_denied') ? 'L7' : null;
      const reason = outBody.message || outBody.result || outBody.errorMessage || errorCode || 'box_exec_failed';
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.exec_failed',
        corr,
        payload: { controller_id: controller.id, reason, error_code: errorCode, layer, org_id: orgId || null },
      });
      return res.status(502).json({ status: 'box_exec_failed', corr, reason, layer });
    }

    // 3) DENY — the box's policy gate blocked the delegation (sovereignty). A
    //    TRUE L3 verdict: a *_policy_violation errorCode (or isPolicyDenial), or
    //    a bare 403 that carries no L7 execution-failure marker (checked above).
    //    A 401 is an auth failure and falls through to the failure path below,
    //    never mislabelled as the box's policy denying the action.
    if (outStatus === 403 || isPolicyDenial(errorCode)) {
      const reason = outBody.result || outBody.errorMessage || errorCode || 'policy_denied';
      safeAudit({
        type: 'event',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.denied',
        corr,
        payload: { controller_id: controller.id, reason, error_code: errorCode, org_id: orgId || null },
      });
      return res.status(403).json({ status: 'denied', error: 'policy_denied', corr, reason });
    }

    // 4) Other non-policy downstream failure (missing API key, 5xx, success:false
    //    without a policy verdict) → fail closed as a box execution failure, not
    //    a sovereignty verdict. No layer marker (not an L7-tagged reject).
    if (outStatus >= 400 || outBody.success === false) {
      const reason = outBody.message || outBody.result || outBody.errorMessage || errorCode || 'delegation_failed';
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.exec_failed',
        corr,
        payload: { controller_id: controller.id, reason, error_code: errorCode, layer: null, org_id: orgId || null },
      });
      return res.status(502).json({ status: 'box_exec_failed', corr, reason, layer: null });
    }

    // 5) Completed — the box ran the prompt to a governed reply.
    const reply = typeof outBody.result === 'string' ? outBody.result : '';
    safeAudit({
      type: 'result',
      from: controllerIdentity,
      to: `agent.${selectedAgent}`,
      intent: 'qluster.delegate.completed',
      corr,
      payload: { controller_id: controller.id, reply_len: reply.length, org_id: orgId || null },
    });
    return res.status(200).json({ status: 'completed', corr, reply });
  };
}

/**
 * QLUSTER-LOOP-B Phase 3 — resume executor.
 *
 * Runs when a human acts on the inbox item minted at the gate (Phase 1). The
 * auth service calls the collector internal resume endpoint (Phase 4), which
 * invokes this. It:
 *   1. claimForResume(corr) FIRST — the idempotency lock. If 0 rows changed
 *      (already resuming/terminal, or unknown corr) it NO-OPS. This is what
 *      makes a double-resume safe.
 *   2. On a DENY action: skips the replay, finalizes denied_hitl with the
 *      approver comment, emits qluster.delegate.denied.
 *   3. On an APPROVE action: replays the STORED prompt through the box chat
 *      pipeline with the grant signal (x-qluster-approval-granted), classifies
 *      the outcome with the SAME branch logic as the synchronous handler, and
 *      finalizes completed / box_exec_failed / denied_hitl accordingly.
 *
 * Every terminal outcome emits an audit envelope carrying from:qluster:<ctrl>,
 * the human approver, and the inbox_item_id. NEVER throws to the caller — the
 * endpoint is fire-and-forget.
 *
 * @param {object} deps
 * @param {Function} deps.chatHandler - handleCollectorChat
 * @param {object}   deps.store       - qlusterDelegationStore (bound)
 * @param {Function} [deps.audit]     - storeAuditEnvelope
 * @param {string}   [deps.serviceKey]- INTERNAL_SERVICE_KEY for the in-process invoke
 * @returns {Function} async runResume({ corr, inbox_item_id, action, approver, org_id })
 */
function createResumeHandler(deps = {}) {
  const {
    chatHandler,
    store,
    audit = () => {},
    serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  } = deps;
  const safeAudit = (envelope) => { try { audit(envelope); } catch { /* never blocks */ } };

  return async function runResume(params = {}) {
    const corr = typeof params.corr === 'string' ? params.corr : '';
    if (!corr) return { ok: false, reason: 'missing_corr' };
    if (!store || typeof store.claimForResume !== 'function') {
      return { ok: false, reason: 'store_not_configured' };
    }
    if (typeof chatHandler !== 'function') {
      return { ok: false, reason: 'resume_not_configured' };
    }

    // 1) IDEMPOTENCY LOCK — must be the first thing we do. A duplicate/concurrent
    //    resume (double-approve, at-least-once webhook) sees 0 changes → no-op.
    const claimed = store.claimForResume(corr);
    if (!claimed) {
      return { ok: true, noop: true, reason: 'already_claimed_or_unknown' };
    }

    const row = store.getByCorr(corr) || {};
    const controllerId = row.controller_id || null;
    const controllerIdentity = controllerId ? `qluster:${controllerId}` : 'qluster:unknown';
    const selectedAgent = row.selected_agent || 'quox';
    const orgId = row.org_id || null;
    const inboxItemId = params.inbox_item_id || row.inbox_item_id || null;
    const approver = params.approver || null;
    const action = String(params.action || '').toLowerCase();

    // 2) DENY — the human declined. No replay; finalize denied_hitl with comment.
    if (action === 'deny' || action === 'denied' || action === 'reject') {
      const reason = (typeof params.reason === 'string' && params.reason)
        || (typeof params.comment === 'string' && params.comment)
        || 'denied_by_approver';
      store.finalize(corr, { status: 'denied_hitl', reason });
      safeAudit({
        type: 'event',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.denied',
        corr,
        payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, reason, org_id: orgId, via: 'hitl' },
      });
      return { ok: true, status: 'denied_hitl' };
    }

    // 3) APPROVE — replay the STORED prompt with the grant signal.
    const syntheticReq = {
      body: {
        prompt: row.prompt || '',
        session_id: corr,
        selected_agent: selectedAgent,
        ...(orgId ? { org_id: orgId } : {}),
      },
      headers: {
        'x-service-key': serviceKey,
        'x-qluster-delegated-by': controllerIdentity,
        // The grant: honored by handleCollectorChat ONLY because this carries a
        // valid service key (serviceAuth). resolveApprovalGrant gates on that.
        'x-qluster-approval-granted': '1',
        ...(inboxItemId ? { 'x-qluster-approval-inbox-item': inboxItemId } : {}),
      },
      on: () => {},
      socket: {},
    };
    const captured = { status: 200, body: null };
    const syntheticRes = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      status(code) { this.statusCode = code; captured.status = code; return this; },
      json(b) { captured.body = b; this.writableEnded = true; return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      write() { return true; },
      end() { this.writableEnded = true; return this; },
    };

    try {
      await chatHandler(syntheticReq, syntheticRes);
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      store.finalize(corr, { status: 'error', reason });
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.error',
        corr,
        payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, error: reason, org_id: orgId },
      });
      return { ok: true, status: 'error' };
    }

    const outBody = captured.body || {};
    const outStatus = captured.status || 200;
    const errorCode = outBody.error || null;

    // Classify with the SAME branch order as the synchronous handler.
    // (approval_required cannot recur here — the grant satisfies that gate.)

    // L7 execution failure.
    if (outBody.deniedByLayer === 'L7' || errorCode === 'l7_denied') {
      const reason = outBody.message || outBody.result || outBody.errorMessage || errorCode || 'box_exec_failed';
      store.finalize(corr, { status: 'box_exec_failed', reason, layer: 'L7' });
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.exec_failed',
        corr,
        payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, reason, layer: 'L7', org_id: orgId },
      });
      return { ok: true, status: 'box_exec_failed' };
    }

    // Policy deny (a real L3 sovereignty verdict on replay — NOT the approval gate).
    if (outStatus === 403 || isPolicyDenial(errorCode)) {
      const reason = outBody.result || outBody.errorMessage || errorCode || 'policy_denied';
      store.finalize(corr, { status: 'denied_hitl', reason });
      safeAudit({
        type: 'event',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.denied',
        corr,
        payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, reason, error_code: errorCode, org_id: orgId, via: 'policy' },
      });
      return { ok: true, status: 'denied_hitl' };
    }

    // Other non-policy downstream failure → box_exec_failed (no layer marker).
    if (outStatus >= 400 || outBody.success === false) {
      const reason = outBody.message || outBody.result || outBody.errorMessage || errorCode || 'delegation_failed';
      store.finalize(corr, { status: 'box_exec_failed', reason, layer: null });
      safeAudit({
        type: 'error',
        from: controllerIdentity,
        to: `agent.${selectedAgent}`,
        intent: 'qluster.delegate.exec_failed',
        corr,
        payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, reason, layer: null, org_id: orgId },
      });
      return { ok: true, status: 'box_exec_failed' };
    }

    // Completed.
    const reply = typeof outBody.result === 'string' ? outBody.result : '';
    store.finalize(corr, { status: 'completed', reply });
    safeAudit({
      type: 'result',
      from: controllerIdentity,
      to: `agent.${selectedAgent}`,
      intent: 'qluster.delegate.completed',
      corr,
      payload: { controller_id: controllerId, approver, inbox_item_id: inboxItemId, reply_len: reply.length, org_id: orgId, via: 'hitl' },
    });
    return { ok: true, status: 'completed', reply };
  };
}

/**
 * QLUSTER-LOOP-B Phase 3A — self-healing retrieval helper (split-brain
 * recovery, decision #3A).
 *
 * Best-effort lookup: is the inbox item the L3 gate minted for this
 * delegation already RESOLVED on the auth service, even though our stored row
 * is still pending_hitl? This covers the case where the collector was
 * unreachable at the exact moment a human approved/denied — the auth→collector
 * resume push (inbox.js's fire-and-forget POST to
 * /api/internal/qluster/delegate/resume) is lost and the row would otherwise
 * stay pending_hitl forever.
 *
 * The internal inbox list endpoint (auth's `GET /api/internal/orgs/:orgId/
 * inbox/items`) has NO filter by id or aee_correlation_id — only kind/status/
 * source/limit. So this lists resolved items for the org and filters
 * CLIENT-SIDE by the stored inbox_item_id. Never throws: any failure (auth
 * unreachable, timeout, bad JSON, item not found/still open) resolves to
 * `null`, meaning "nothing to heal right now" — the caller falls back to the
 * stored pending_hitl row exactly as before this change.
 *
 * @returns {Promise<{action:string, approver:string|null, comment:string|null}|null>}
 */
async function lookupInboxResolution({ fetchImpl, authBaseUrl, serviceKey, orgId, itemId, timeoutMs = 5000 }) {
  if (!fetchImpl || !orgId || !itemId) return null;
  const ac = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const url = `${authBaseUrl}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items?status=resolved&limit=200`;
    const r = await fetchImpl(url, {
      headers: { ...(serviceKey ? { 'x-service-key': serviceKey } : {}) },
      ...(ac ? { signal: ac.signal } : {}),
    });
    if (!r || !r.ok) return null;
    const data = await r.json().catch(() => null);
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    const item = items.find((it) => it && it.id === itemId);
    if (!item) return null; // still open, or fell out of the resolved window
    let parsed = {};
    try { parsed = item.response_json ? JSON.parse(item.response_json) : {}; } catch { parsed = {}; }
    if (!parsed.action) return null;
    return {
      action: parsed.action,
      approver: parsed.responded_by || item.resolved_by || null,
      comment: parsed.comment || null,
    };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * QLUSTER-LOOP-B Phase 5 — signed retrieval handler factory.
 *
 * requireQlusterScope('agent.delegate') must run first (scoped bearer + signed
 * envelope). Enforces ORG-SCOPE on the row: a controller may only read a
 * delegation for an org it is scoped to (allowed_orgs) — corr is semi-guessable,
 * so this is the cross-controller read guard, NOT corr secrecy. Never leaks the
 * stored prompt.
 *
 * Phase 3A self-healing: when the row is still pending_hitl AND has an
 * inbox_item_id, this handler makes ONE best-effort call to auth to check
 * whether that item was actually resolved (the normal auth→collector resume
 * push may have been lost to a split-brain). If resolved, it invokes the SAME
 * in-process resume function (`deps.runResume`, i.e. Phase 3's
 * createResumeHandler output — never an HTTP call back to our own endpoint)
 * for this corr. That function's FIRST action is `claimForResume`, the
 * `WHERE status='pending_hitl'` conditional update — so a concurrent
 * auth-push resume and this self-heal resume race safely: whichever gets
 * there first flips the row to `resuming` and runs it; the other sees 0 rows
 * changed and no-ops. No double-run is possible. Already-terminal rows
 * (completed/denied_hitl/box_exec_failed/error) skip the auth call entirely —
 * the happy path stays as fast as before this change.
 *
 * @param {object} deps
 * @param {object}   deps.store        - qlusterDelegationStore (bound)
 * @param {Function} [deps.runResume]  - Phase 3's createResumeHandler output (in-process resume, idempotent)
 * @param {string}   [deps.authBaseUrl]- AUTH_SERVICE_URL base for the inbox item lookup
 * @param {string}   [deps.serviceKey] - INTERNAL_SERVICE_KEY for the internal auth call
 * @param {Function} [deps.fetchImpl]  - fetch impl (test override; defaults to global fetch)
 * @param {number}   [deps.timeoutMs]  - abort timeout for the auth lookup (default 5000)
 */
function createDelegateResultHandler(deps = {}) {
  const {
    store = null,
    runResume = null,
    authBaseUrl = process.env.AUTH_SERVICE_URL || 'http://quox-auth:3101',
    serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    timeoutMs = 5000,
  } = deps;

  const toOutput = (row) => {
    const out = { status: row.status, corr: row.corr };
    if (row.reply != null) out.reply = row.reply;
    if (row.reason != null) out.reason = row.reason;
    if (row.inbox_item_id != null) out.inbox_item_id = row.inbox_item_id;
    if (row.layer != null) out.layer = row.layer;
    return out;
  };

  return async function delegateResultHandler(req, res) {
    const controller = req.qlusterController;
    if (!controller || !controller.id) {
      return res.status(401).json({ error: 'not_authorized' });
    }
    if (!store || typeof store.getByCorr !== 'function') {
      return res.status(503).json({ error: 'store_unavailable' });
    }
    const corr = req.params.corr;
    const row = store.getByCorr(corr);
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }
    const allowedOrgs = Array.isArray(controller.allowed_orgs) ? controller.allowed_orgs : [];
    if (!row.org_id || !allowedOrgs.includes(row.org_id)) {
      return res.status(403).json({ error: 'org_not_allowed' });
    }

    // Self-healing retrieval (#3A) — ONLY for rows still stuck pending_hitl.
    // Terminal rows never pay the extra auth round-trip.
    if (row.status === 'pending_hitl' && row.inbox_item_id && typeof runResume === 'function') {
      try {
        const resolution = await lookupInboxResolution({
          fetchImpl,
          authBaseUrl,
          serviceKey,
          orgId: row.org_id,
          itemId: row.inbox_item_id,
          timeoutMs,
        });
        if (resolution) {
          await runResume({
            corr,
            inbox_item_id: row.inbox_item_id,
            action: resolution.action,
            approver: resolution.approver,
            org_id: row.org_id,
            reason: resolution.comment,
            comment: resolution.comment,
          });
          const fresh = store.getByCorr(corr);
          if (fresh) {
            return res.status(200).json(toOutput(fresh));
          }
        }
      } catch (e) {
        // Self-heal is best-effort — never let it fail or hang the GET.
        console.warn('[qluster.delegate.result] self-heal failed (non-fatal):', e && e.message);
      }
    }

    return res.status(200).json(toOutput(row));
  };
}

/**
 * QLUSTER-LOOP-B Phase 4 — internal resume endpoint factory.
 *
 * Service-key guarded (NOT a Quox JWT, NOT the qluster signed envelope — this is
 * service-to-service within Docker, called by the auth service after a human
 * acts on the inbox item). Responds fast (202) and runs the resume
 * fire-and-forget so the caller is never blocked on the box pipeline.
 *
 * @param {object} deps
 * @param {Function} deps.runResume  - the Phase 3 resume executor
 * @param {string}   [deps.serviceKey] - INTERNAL_SERVICE_KEY
 */
function createResumeEndpoint(deps = {}) {
  const { runResume, serviceKey = process.env.INTERNAL_SERVICE_KEY || '' } = deps;
  return function resumeEndpoint(req, res) {
    if (serviceKey) {
      const provided = req.headers['x-service-key'] || '';
      if (provided !== serviceKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const body = req.body || {};
    const { corr, inbox_item_id, action, approver, org_id, reason, comment } = body;
    if (!corr || typeof corr !== 'string') {
      return res.status(400).json({ error: 'corr_required' });
    }
    Promise.resolve()
      .then(() => runResume({ corr, inbox_item_id, action, approver, org_id, reason, comment }))
      .catch((err) => console.warn('[qluster.resume] failed (non-fatal):', err && err.message));
    return res.status(202).json({ accepted: true, corr });
  };
}

module.exports = {
  createDelegateHandler,
  createResumeHandler,
  createResumeEndpoint,
  createDelegateResultHandler,
  isPolicyDenial,
  lookupInboxResolution,
  mintPendingAndRespond,
};
