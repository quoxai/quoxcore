/**
 * approvalSideEffects — the shared "what happens when an approval resolves"
 * logic, extracted so POST /inbox/:id/respond and POST /inbox/bulk witness +
 * resume IDENTICALLY (Approvals-Q gap #1: bulk previously did neither).
 *
 * Pure + dependency-injected: no module-level side effects, so it is unit
 * tested directly (tests/approvalSideEffects.test.js) with mocked deps.
 *
 * Two effects, each independent and fire-and-forget (never throws):
 *   1. VOLT witness — only for terminal approval-kind decisions (not
 *      request_changes, which spawns a new review round rather than resolving).
 *   2. QuoxFlow resume — if the item is linked to a paused execution.
 */

const EXEC_ID_RE = /^[A-Z0-9]{26}$/i;

/**
 * @param {object} p
 * @param {{id:string, kind?:string, quoxflow_execution_id?:string|null}} p.item
 * @param {string} p.orgId
 * @param {boolean} p.approved         resolved as approved (grant/continue) vs denied
 * @param {boolean} [p.isRequestChanges=false]  request-changes iteration (not terminal)
 * @param {string} p.approver          actor label (email/display/id)
 * @param {string} [p.comment]         reason / note
 * @param {object} [p.data]            optional structured response data
 * @param {object} [deps]
 * @param {Function} [deps.emitApprovalVoltWitness]
 * @param {Function} [deps.fetchFn]
 * @param {string}   [deps.quoxflowUrl]
 * @param {string}   [deps.serviceKey]
 * @param {object}   [deps.log]
 * @param {number}   [deps.timeoutMs]
 * @returns {Promise<{witnessed:boolean, resumed:boolean}>}
 */
export async function resolveApprovalSideEffects(
    { item, orgId, approved, isRequestChanges = false, approver, comment, data } = {},
    deps = {}
) {
    const {
        emitApprovalVoltWitness,
        fetchFn = globalThis.fetch,
        quoxflowUrl = process.env.QUOXFLOW_URL || 'http://quoxflow:3200',
        serviceKey = process.env.INTERNAL_SERVICE_KEY,
        log = console,
        timeoutMs = 10000,
    } = deps;

    const out = { witnessed: false, resumed: false };
    if (!item) return out;

    // 1. VOLT witness — terminal approval decisions only.
    if (item.kind === 'approval' && !isRequestChanges && typeof emitApprovalVoltWitness === 'function') {
        try {
            await emitApprovalVoltWitness({
                orgId,
                itemId: item.id,
                decision: approved ? 'granted' : 'denied',
                actor: approver,
                comment,
            });
            out.witnessed = true;
        } catch (err) {
            // Never fail the resolution because of the witness path (it queues
            // + retries internally anyway); defense-in-depth only.
            log?.error?.('[Inbox/VOLT] witness error (non-fatal):', err?.message);
        }
    }

    // 2. QuoxFlow resume — linked paused execution.
    const execId = item.quoxflow_execution_id;
    if (execId && EXEC_ID_RE.test(execId) && typeof fetchFn === 'function') {
        const resumePayload = {
            approved,
            approver,
            reason: comment || undefined,
            ...(isRequestChanges ? { requestChanges: true } : {}),
            ...(data ? { data } : {}),
        };
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const resumeRes = await fetchFn(`${quoxflowUrl}/api/executions/${execId}/resume`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
                },
                body: JSON.stringify(resumePayload),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (resumeRes?.ok) {
                out.resumed = true;
            } else {
                const errBody = resumeRes?.text ? await resumeRes.text().catch(() => '') : '';
                log?.error?.(`[Inbox/HV2] QuoxFlow resume failed (${resumeRes?.status}):`, errBody);
            }
        } catch (err) {
            log?.error?.('[Inbox/HV2] QuoxFlow resume error:', err?.message);
        }
    }

    return out;
}

export default resolveApprovalSideEffects;
