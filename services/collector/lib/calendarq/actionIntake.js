'use strict';

/**
 * Calendar-Q -> Action-Q follow-up intake (L2-C3 U3).
 *
 * proposeFollowUp is the ONLY way a Calendar-Q surface (agent tool or route)
 * can land an item on the user's Action Tracker board. It is explicit-only:
 * a human or agent must call it with named provenance (sourceRefs pointing
 * at a real occurrenceKey or receipt id in THIS org) — nothing in Calendar-Q
 * watches for "meeting ended" or any other signal and calls this on its own.
 * See the "NO INFERENCE" pin test in calendarqActionIntake.test.js, which
 * greps scheduler.js/syncWorker.js (the only two recurring-loop surfaces
 * Calendar-Q has) and asserts neither references this module at all.
 *
 * WRITE PATH: this module NEVER inserts into Action-Q's own storage
 * directly. It calls through lib/actionToolHandlers.js's handleActionTool
 * ('action_add', ...) — the EXACT same in-process entry point every
 * action_add agent tool call already uses (see
 * src/config/agentRegistry.js-driven lib/agentTools.js's action_add tool) —
 * which in turn proxies to the auth service's internal, service-key-gated
 * Action Tracker route. There is no parallel/second write path here.
 *
 * IDEMPOTENCY: a (orgId, idempotencyKey) pair may only ever create ONE
 * action item. The FIRST call records a calendarq_action_intake row naming
 * the created item; every subsequent call with the SAME key short-circuits
 * on that row and returns the SAME ack, never calling action_add again. The
 * check-then-insert happens synchronously against better-sqlite3 (see
 * store.js's recordActionIntake), the same race-free pattern
 * transitionOperation relies on elsewhere in this plugin.
 *
 * Zero LLM calls: title/owner/sourceRefs are taken as given, never generated
 * or rewritten here.
 */

const store = require('./store');
const { validateActionQIntakeV1 } = require('./contracts');
const { handleActionTool } = require('../actionToolHandlers');

/** True iff `ref` resolves, in THIS org, to either a receipt id or an
 * occurrenceKey present in some connection's latest published generation.
 * Both lookups are org-scoped by construction (store.getReceipt /
 * store.readPublishedOccurrences both filter on org_id), so a ref that only
 * exists in a DIFFERENT org is never accepted — see the cross-tenant pin
 * test in calendarqActionIntake.test.js. */
function isValidProvenanceRef(orgId, ref) {
  if (!ref) return false;
  if (store.getReceipt(orgId, ref)) return true;
  const connections = store.listConnections(orgId);
  for (const conn of connections) {
    const published = store.readPublishedOccurrences(orgId, conn.id);
    if (published && published.occurrences.some((o) => o.occurrenceKey === ref)) return true;
  }
  return false;
}

/** Build the Action Tracker description from the intake's provenance, so a
 * human looking at the board can always see WHY this item exists without
 * needing to cross-reference Calendar-Q separately. */
function buildDescription(intake) {
  const lines = [];
  if (intake.deadlineEvidence) lines.push(`Deadline evidence: ${intake.deadlineEvidence}`);
  lines.push(`Created by Calendar-Q follow-up intake. Source ref(s): ${intake.sourceRefs.join(', ')}.`);
  lines.push(`Owner: ${intake.owner}`);
  return lines.join('\n');
}

/**
 * @param {string} orgId
 * @param {object} intake { idempotencyKey, title, sourceRefs, owner, deadlineTs, deadlineEvidence }
 * @param {object} [ctx] { userId, agentId, token } — threaded into the
 *   action_add call exactly as every other action_* agent tool does.
 * @returns {Promise<{ok:true, duplicate:boolean, actionItemId:string, item?:object}|{ok:false, errors:string[]}>}
 */
async function proposeFollowUp(orgId, intake, ctx = {}) {
  if (!orgId) throw new Error('proposeFollowUp requires orgId');
  const input = intake || {};

  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) return { ok: false, errors: ['idempotencyKey is required'] };

  // Idempotent short-circuit BEFORE validating the rest of the payload — a
  // retried call with the same key gets the same ack back without needing
  // to resend a fully-formed, still-valid body.
  const existing = store.getActionIntakeByKey(orgId, idempotencyKey);
  if (existing) {
    return { ok: true, duplicate: true, actionItemId: existing.actionItemId };
  }

  const full = {
    v: '1',
    orgId,
    idempotencyKey,
    title: input.title,
    sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
    owner: input.owner,
    deadlineTs: input.deadlineTs ?? null,
    deadlineEvidence: input.deadlineEvidence ?? null,
  };

  const validated = validateActionQIntakeV1(full);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  // Stronger-than-the-generic-contract check: ActionQIntakeV1's sourceRefs
  // field only pins "array of non-empty strings" (any array, including
  // empty, passes that shape check) — the phase brief requires at least one
  // of them to be REAL, RESOLVABLE Calendar-Q provenance in this org, not
  // merely present.
  const hasValidRef = full.sourceRefs.some((r) => isValidProvenanceRef(orgId, r));
  if (!hasValidRef) {
    return { ok: false, errors: ['sourceRefs must include at least one calendarq occurrenceKey or receipt ref that exists in this org'] };
  }

  const actionCtx = {
    orgId,
    userId: ctx.userId || null,
    agentId: ctx.agentId || 'calendar-q',
    token: ctx.token || null,
  };

  const params = {
    title: full.title,
    description: buildDescription(full),
    category: 'calendar-q-followup',
  };
  if (full.deadlineTs) params.dueDate = new Date(full.deadlineTs).toISOString().slice(0, 10);

  const result = await handleActionTool('action_add', params, actionCtx);
  if (!result || result.success !== true) {
    return { ok: false, errors: [(result && result.error) || 'action_add failed'] };
  }

  store.recordActionIntake({ orgId, idempotencyKey, actionItemId: result.item.id, sourceRefs: full.sourceRefs });

  return { ok: true, duplicate: false, actionItemId: result.item.id, item: result.item };
}

module.exports = { proposeFollowUp, isValidProvenanceRef };
