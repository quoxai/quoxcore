/**
 * toolResume.js — HITL approve→execute bridge, Phase 2: the resume executor
 * + internal endpoint for gated native tools (proxmox_vm_action,
 * docker_fleet_container_action). Clones the PROVEN
 * QLUSTER-LOOP-B resume idiom (qlusterDelegate.js createResumeHandler /
 * createResumeEndpoint).
 *
 * Flow:
 *   1. A gated tool call trips withApprovalGate (approvalGate.js) →
 *      createApprovalRequest mints a resume_token + a `pending` row in
 *      toolApprovalStore, and best-effort mints an inbox item
 *      (payload.type: 'native_tool_approval', aee_correlation_id: approvalId).
 *   2. A human resolves that inbox item. services/auth/routes/inbox.js
 *      POSTs here (fire-and-forget) with {approvalId, action, approver, org_id}.
 *   3. claimForResume(approvalId) is the idempotency lock — conditionally
 *      flips pending → resuming; a duplicate/concurrent resume sees null and
 *      no-ops. This makes a double-resume safe.
 *   4. Deny → finalize('denied'), no execution.
 *      Approve → re-run the SAME tool through executeTool() with the
 *      STORED input PLUS {_approvalId, _resumeToken: row.resume_token}, so
 *      withApprovalGate's token-verified branch executes it directly (no
 *      re-poll of QuoxFlow). Emits P2 tool evidence (toolEvidence.js) and
 *      finalizes('approved', result).
 *
 * NEVER throws to the caller — the endpoint is fire-and-forget (202
 * accepted); the resume itself runs async after responding.
 */

const toolApprovalStore = require('./toolApprovalStore.js');
const { mintInboxItem } = require('./inboxMint.js');
const { APPROVAL_MAX_AGE_MS } = require('./approvalTtl.js');
const { emitToolEvidence } = require('./toolEvidence.js');

// Tools whose approved execution must run in the requesting user's own session (their
// bearer), so the async resume records the approval and leaves the grant for that session.
const { CALLER_SESSION_RESUME_TOOLS } = toolApprovalStore;

/**
 * Build the in-process resume executor.
 *
 * @param {object} deps
 * @param {Function} deps.executeTool          - agentTools.js executeTool(toolName, input, ctx)
 * @param {Function} [deps.storeAuditEnvelope]  - server.js storeAuditEnvelope (P2 evidence)
 * @returns {Function} async runResume({ approvalId, action, approver, approverRole, org_id, reason, comment, inboxItemId })
 */
function createResumeHandler(deps = {}) {
  const { executeTool, storeAuditEnvelope, resolveHatForTurn, hatAllowsToolName } = deps;
  // QUOXHAT #657 (H2): read the real enforcement cache (populated by the real
  // resolveHatForTurn) so a resolve FAILURE can fail closed; test-injectable.
  const lastKnownEnforcement = deps.lastKnownEnforcement || require('./hatManifest').lastKnownEnforcement;
  // QUOXHAT #657 P-C.1: resume must revalidate with the SAME authorization
  // predicate the executeTool gate uses (the agent's CURRENT grant ceiling ∩
  // the hat's mode rule — P-B authzToolNames), NOT the old presentation-
  // membership check (hatAllowsToolName), or the two can disagree: a permissive
  // hat authorizes a granted tool it does not list explicitly, which the old
  // resume check would wrongly deny at the approval→publish step. Both are
  // test-injectable; hatAllowsToolName is retained only as a conservative
  // fallback when the live grant cannot be fetched under enforce.
  const buildTurnManifest = deps.buildTurnManifest || require('./hatManifest').buildTurnManifest;
  const getAgentGrant = deps.getAgentGrant || (async (agentId, orgId) => require('./agentTools').getToolsWithConnectors(agentId, orgId));

  return async function runResume(params = {}) {
    const approvalId = typeof params.approvalId === 'string' ? params.approvalId : '';
    if (!approvalId) return { ok: false, reason: 'missing_approval_id' };
    if (typeof executeTool !== 'function') {
      return { ok: false, reason: 'resume_not_configured' };
    }

    // 0) QUOXON-ASK lane J: a caller-session tool runs AS the person who asked (their own
    //    bearer, which only their live turn carries). This async resume has no bearer, so an
    //    approve must NOT claim the grant (claiming with no identity would burn it): it is
    //    left pending for the caller's next turn, which runs it once through
    //    withApprovalGate's approved path (fingerprint, tool, org and user bound, single
    //    use). A deny or any non-approve action falls through and finalizes as before.
    {
      const APPROVE = new Set(['approve', 'approved', 'accept', 'accepted', 'confirm', 'confirmed']);
      const peek = toolApprovalStore.getByApprovalId(approvalId);
      if (peek && CALLER_SESSION_RESUME_TOOLS.has(peek.tool_name) && peek.status === 'pending'
        && APPROVE.has(String(params.action || '').toLowerCase())) {
        const ageMs = peek.created_at ? (Date.now() - Number(peek.created_at)) : 0;
        if (ageMs > APPROVAL_MAX_AGE_MS) {
          toolApprovalStore.finalize(approvalId, 'expired', JSON.stringify({ reason: 'approval_expired', ageMs, maxAgeMs: APPROVAL_MAX_AGE_MS }));
          return { ok: true, status: 'expired', ageMs, maxAgeMs: APPROVAL_MAX_AGE_MS };
        }
        toolApprovalStore.markCallerApproved(approvalId, params.approver || null);
        return { ok: true, status: 'awaiting_caller', tool: peek.tool_name };
      }
    }

    // 1) IDEMPOTENCY LOCK — must be the first thing we do. A duplicate/
    //    concurrent resume (double-approve, at-least-once webhook) sees
    //    null → no-op.
    const row = toolApprovalStore.claimForResume(approvalId);
    if (!row) {
      return { ok: true, noop: true, status: 'already_processed' };
    }

    // TRUST-PROOF slice 4: the auth service's inbox respond handler
    // (routes/inbox.js) already sends inbox_item_id alongside approvalId on
    // this resume call — thread it onto ctx as hitlApprovedItemId so a
    // gated executor invoked below (e.g. bastionSshExecutor.js) can mint a
    // short-lived X-Bastion-Approval-Grant bound to the SAME item a human
    // just approved. Only meaningful on the approve path below (an inbox
    // item id on a denied/unknown-action resume is never used for anything).
    const ctx = {
      orgId: row.org_id,
      agentId: row.agent_id,
      userId: row.user_id,
      hitlApprovedItemId: typeof params.inboxItemId === 'string' && params.inboxItemId ? params.inboxItemId : null,
      // Who approved, and their org role as auth verified it at respond time. Executors may only
      // NARROW what they lend on this basis (brainNotes: admin flag only for an owner/admin or the
      // note's author); the approval gate stays the one authority on whether the action runs.
      approverId: typeof params.approver === 'string' && params.approver ? params.approver : null,
      approverRole: typeof params.approverRole === 'string' && params.approverRole ? params.approverRole : null,
    };
    const action = String(params.action || '').toLowerCase();

    // 2) FAIL CLOSED on the action string (LI-OVERHAUL P10, codex finding).
    //    The old shape was a deny-LIST: anything not in it — including the
    //    inbox UI's very real 'request_changes' button — fell through to the
    //    approve branch and EXECUTED the gated write. Only an explicit
    //    approve action may execute; an explicit deny finalizes denied; any
    //    other/unknown action (request_changes, typos, future buttons)
    //    finalizes denied WITHOUT executing, recording what was clicked.
    const APPROVE_ACTIONS = new Set(['approve', 'approved', 'accept', 'accepted', 'confirm', 'confirmed']);
    if (!APPROVE_ACTIONS.has(action)) {
      const isExplicitDeny = ['deny', 'denied', 'dismissed', 'reject', 'rejected'].includes(action);
      const reason = (typeof params.reason === 'string' && params.reason)
        || (typeof params.comment === 'string' && params.comment)
        || (isExplicitDeny ? 'denied_by_approver' : `not_executed: non-approve action '${action || 'none'}'`);
      toolApprovalStore.finalize(approvalId, 'denied', JSON.stringify({ reason, action, approver: params.approver || null }));
      return { ok: true, status: 'denied', action };
    }

    // 2b) EXPIRY REVALIDATION (QUOXTRUST T-AUTH, FND_..SRMA). The atomic claim above guarantees
    //     single-use, NOT freshness. A human clicking a STALE inbox card — long after the approval's
    //     TTL, or after the org policy that would now DENY it changed — must not execute. The legacy
    //     poll path (approvalGate.js) checks status.expired; this inbox-driven resume path had no
    //     equivalent. Refuse + finalize 'expired' beyond the max approval age. The default matches the
    //     system HITL timeout (approvalGate.js timeout_ms default, 1h) — a hardcoded security default,
    //     not an env-only knob (per-org configurability would need a real Settings surface).
    const ageMs = row.created_at ? (Date.now() - Number(row.created_at)) : 0;
    if (ageMs > APPROVAL_MAX_AGE_MS) {
      toolApprovalStore.finalize(approvalId, 'expired', JSON.stringify({ reason: 'approval_expired', ageMs, maxAgeMs: APPROVAL_MAX_AGE_MS }));
      return { ok: true, status: 'expired', ageMs, maxAgeMs: APPROVAL_MAX_AGE_MS };
    }

    // 2c) QUOXHAT P2 (study §9 approval resumes): recheck the CURRENT hat
    //     before executing. The approval was minted under whatever hat the
    //     turn wore; a hat switch or revocation between mint and click must
    //     not be bypassed by the stored grant. Only bites when the org has
    //     opted into enforcement AND the current hat's own membership does
    //     not name the tool; hat-resolve failures keep the fail-open posture
    //     documented in hatManifest.js (loudly, never silently).
    if (typeof resolveHatForTurn === 'function') {
      try {
        // H1: re-resolve the hat bound to the ORIGINATING conversation (not the
        // org default) so a per-conversation switch/revocation between mint and
        // click is honoured.
        const hatTurn = await resolveHatForTurn({ orgId: row.org_id, userId: row.user_id || null, conversationId: row.conversation_id || null });
        if (hatTurn?.enforcement === 'enforce' && hatTurn.hat) {
          // P-C.1: revalidate with the P-B authorization predicate (grant
          // ceiling ∩ hat mode), and ARM ctx.hatManifest so the executeTool
          // gate re-authorizes at dispatch too — one authorization source, no
          // competing approval system (per the reconciled design).
          let authorized;
          let authzReason = 'mode';
          try {
            const grant = await getAgentGrant(row.agent_id, row.org_id);
            const manifest = buildTurnManifest({ agentTools: grant, hat: hatTurn.hat, loadedBundles: hatTurn.binding?.loaded_bundles || [], agent: row.agent_id || null });
            if (manifest) {
              authorized = manifest.authzToolNames.has(row.tool_name);
              authzReason = manifest.grantToolNames.has(row.tool_name) ? 'mode_forbidden' : 'not_granted';
              ctx.hatManifest = {
                enforced: true,
                authzToolNames: manifest.authzToolNames,
                grantToolNames: manifest.grantToolNames,
                authzMode: manifest.authzMode,
                authorizedAgents: manifest.authorizedAgents,
                delegationScoped: manifest.delegationScoped,
                toolNames: manifest.toolNames,
                hatKey: manifest.hatKey, hatId: manifest.hatId, revision: manifest.revision, digest: manifest.digest,
              };
            } else {
              authorized = true; // no usable hat definition = no hat opinion (legacy)
            }
          } catch (grantErr) {
            // Cannot fetch the live grant under enforce — availability must not
            // expand authority. Fall back to the conservative membership check
            // when available, else fail closed.
            authorized = typeof hatAllowsToolName === 'function'
              ? hatAllowsToolName(hatTurn.hat, row.tool_name)
              : false;
            console.warn(`[QUOXHAT] approval resume grant fetch failed under enforce (${grantErr?.message}) — ${authorized ? 'membership-fallback allowed' : 'fail-closed denied'} (approval=${approvalId}, org=${row.org_id})`);
          }
          if (!authorized) {
            const reason = `hat_denied (${authzReason}): tool '${row.tool_name}' not authorized by the current hat '${hatTurn.hat.key}' (rev ${hatTurn.hat.current_revision})`;
            console.warn(`[QUOXHAT] approval resume refused: ${reason} (approval=${approvalId}, org=${row.org_id})`);
            toolApprovalStore.finalize(approvalId, 'denied', JSON.stringify({ reason, action, approver: params.approver || null, hat: hatTurn.hat.key }));
            return { ok: true, status: 'denied', reason: 'hat_denied', hat: hatTurn.hat.key };
          }
        }
        if (!hatTurn && lastKnownEnforcement && lastKnownEnforcement(row.org_id) === 'enforce') {
          // H2 fail-CLOSED: resolve returned null for an org we know enforces —
          // refuse rather than execute the stale-approved tool on legacy grant.
          const reason = `hat_resolve_failed_fail_closed: tool '${row.tool_name}' refused (org enforces, hat unresolved at resume)`;
          console.warn(`[QUOXHAT] approval resume FAIL-CLOSED: ${reason} (approval=${approvalId}, org=${row.org_id})`);
          toolApprovalStore.finalize(approvalId, 'denied', JSON.stringify({ reason, action, approver: params.approver || null }));
          return { ok: true, status: 'denied', reason: 'hat_resolve_failed' };
        }
      } catch (hatErr) {
        if (lastKnownEnforcement && lastKnownEnforcement(row.org_id) === 'enforce') {
          const reason = `hat_recheck_threw_fail_closed: ${hatErr?.message}`;
          console.warn(`[QUOXHAT] approval resume FAIL-CLOSED (recheck threw, org enforces): ${reason} (approval=${approvalId}, org=${row.org_id})`);
          toolApprovalStore.finalize(approvalId, 'denied', JSON.stringify({ reason, action, approver: params.approver || null }));
          return { ok: true, status: 'denied', reason: 'hat_recheck_error' };
        }
        console.warn(`[QUOXHAT] approval-resume hat recheck failed (continuing, fail-open — org not known-enforcing): ${hatErr?.message}`);
      }
    }

    // 3) APPROVE — replay the STORED tool input with the verified-token grant.
    let input;
    try {
      input = { ...(row.input_json ? JSON.parse(row.input_json) : {}) };
    } catch {
      input = {};
    }
    input._approvalId = approvalId;
    input._resumeToken = row.resume_token;

    // QUOXTRUST T-AUTH (C1) — the trusted handoff. This resume path is the single
    // consumption owner (claimForResume above); hand the CLAIMED row to the
    // reference monitor via server-set ctx so it can verify the binding
    // (tool + org + stored effective input). Authorization travels on ctx, never
    // on model-writable input — input._approvalId above is correlation only.
    ctx._claimedApproval = {
      approval_id: approvalId,
      tool_name: row.tool_name,
      org_id: row.org_id,
      input_json: row.input_json || null,
      // The human who clicked approve (set by the auth inbox respond handler, never by tool input).
      // DEVFLEET-P15: an ephemeral rehearsal grant is minted in this human's name and only here.
      approver: typeof params.approver === 'string' && params.approver ? params.approver : null,
    };

    const startedAt = Date.now();
    let result;
    let success = true;
    let errorMsg;
    try {
      // QUOXTRUST D6: this resume path emits its own per-tool evidence (below);
      // opt the executeTool choke out to avoid a double-emit.
      if (ctx) ctx._callerEmitsToolEvidence = true;
      result = await executeTool(row.tool_name, input, ctx);
      success = result?.success !== false;
      errorMsg = result?.error;
    } catch (err) {
      success = false;
      errorMsg = err && err.message ? err.message : String(err);
      result = { success: false, error: errorMsg };
    }
    const durationMs = Date.now() - startedAt;

    try {
      emitToolEvidence({
        toolName: row.tool_name,
        input, // QUOXTRUST T1/D1: bind the effective action; _approvalId/_resumeToken excluded (lifecycle-stable)
        ctx,
        corrId: approvalId,
        durationMs,
        success,
        error: errorMsg,
        source: 'hitl_resume',
        storeAuditEnvelope,
      });
    } catch {
      // Evidence is best-effort — never break the resume.
    }

    // LI-OVERHAUL P10 (codex finding): an approved action whose EXECUTION
    // failed used to finalize 'approved' anyway — the card resolved, nothing
    // published, nobody was told. Finalize honestly and tell a human.
    if (!success) {
      toolApprovalStore.finalize(approvalId, 'error', JSON.stringify(result));
      notifyResumeFailure(row, errorMsg).catch(() => {});
      return { ok: true, status: 'error', result };
    }

    toolApprovalStore.finalize(approvalId, 'approved', JSON.stringify(result));
    return { ok: true, status: 'approved', result };
  };
}

/**
 * Fire-and-forget: mint an org inbox item saying the APPROVED action failed
 * to execute (provider 4xx, licence refusal at resume, ...). Without this
 * the approver's mental model is "I approved it, it happened" while nothing
 * did. Uses the same auth internal inbox mint the approval card came from.
 */
async function notifyResumeFailure(row, errorMsg) {
  const authUrl = process.env.AUTH_SERVICE_URL || `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
  // quox#562: mechanics live in lib/inboxMint.js (never throws).
  const r = await mintInboxItem({
    orgId: row.org_id,
    title: `Approved action FAILED to execute: ${row.tool_name} · ${String(row.approval_id).slice(-6)}`,
    bodyMd: `You (or another approver) approved **${row.tool_name}**, but executing it failed:\n\n> ${String(errorMsg || 'unknown error').slice(0, 500)}\n\nNothing was published/executed. Re-run the original action to file a fresh approval.`,
    kind: 'incident',
    priority: 'high',
    payload: { type: 'tool_resume_failure', toolName: row.tool_name, approvalId: row.approval_id },
  }, { authBaseUrl: authUrl });
  if (!r.ok) {
    console.error('[ToolResume] Failed to mint execution-failure inbox item:', r.error);
  }
}

/**
 * Internal resume endpoint factory. Service-key guarded — NOT a Quox JWT
 * (service-to-service within Docker, called by the auth service after a
 * human acts on the inbox item). Responds fast (202) and runs the resume
 * fire-and-forget so the caller is never blocked on the tool execution
 * (proxmox/docker calls can be slow).
 *
 * @param {object} deps
 * @param {Function} deps.executeTool          - agentTools.js executeTool
 * @param {Function} [deps.storeAuditEnvelope]  - server.js storeAuditEnvelope
 * @param {string}   [deps.serviceKey]          - INTERNAL_SERVICE_KEY
 */
function createResumeEndpoint(deps = {}) {
  const { serviceKey = process.env.INTERNAL_SERVICE_KEY || '' } = deps;
  const runResume = createResumeHandler(deps);
  return function resumeEndpoint(req, res) {
    if (serviceKey) {
      const provided = req.headers['x-service-key'] || '';
      if (provided !== serviceKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const body = req.body || {};
    // TRUST-PROOF slice 4: inbox_item_id is already sent by the auth
    // service's inbox respond handler (routes/inbox.js) alongside
    // approvalId — this endpoint previously dropped it. Threaded through to
    // runResume() as inboxItemId, which lands on ctx.hitlApprovedItemId.
    const { approvalId, action, approver, org_id, reason, comment, inbox_item_id: inboxItemId, approver_role: approverRole } = body;
    if (!approvalId || typeof approvalId !== 'string') {
      return res.status(400).json({ error: 'approvalId_required' });
    }
    // A stale approve is refused without running anything, so answer it INLINE:
    // the caller (auth's inbox respond) must learn it expired and tell the human,
    // not mark the card approved off a blind 202 (live 2026-10-10).
    const row = toolApprovalStore.getByApprovalId(approvalId);
    const isApprove = ['approve', 'approved', 'accept', 'accepted', 'confirm', 'confirmed'].includes(String(action || '').toLowerCase());
    if (isApprove && row && row.status === 'pending' && row.created_at && Date.now() - Number(row.created_at) > APPROVAL_MAX_AGE_MS) {
      return Promise.resolve(runResume({ approvalId, action, approver, approverRole, org_id, reason, comment, inboxItemId }))
        .then((out) => res.status(200).json({ approvalId, ...out }))
        .catch((err) => res.status(500).json({ error: 'resume_failed', message: err && err.message }));
    }
    Promise.resolve()
      .then(() => runResume({ approvalId, action, approver, approverRole, org_id, reason, comment, inboxItemId }))
      .catch((err) => console.warn('[toolResume] failed (non-fatal):', err && err.message));
    return res.status(202).json({ accepted: true, approvalId });
  };
}

module.exports = {
  CALLER_SESSION_RESUME_TOOLS,
  createResumeHandler,
  createResumeEndpoint,
};
