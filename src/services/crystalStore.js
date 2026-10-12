/**
 * crystalStore — Crystal-specific store helpers
 *
 * Supplements quoxflowClient with higher-level draft-creation from chat context.
 * The crystalise-from-execution path (packageSkillFromExecution) remains in
 * quoxflowClient; this module focuses on the "promote conversation" use case.
 *
 * Note on the conversation→crystal lifecycle:
 * Crystals are derived from execution data, not from conversations directly.
 * P9 added the in-flight draft path (mid-loop `propose_crystal`), and the
 * post-hoc Crystalliser still needs ≥3 successful executions before
 * canonicalisation. There is no backend endpoint that creates a Crystal
 * draft straight from a chat conversation, and there shouldn't be — the
 * conversation has no execution trace yet.
 *
 * `createDraftFromConversation` therefore creates a parent objective with
 * `candidate_for_crystal: true` metadata and returns its id. The user
 * lands on the Crystals Library page with a banner explaining that the
 * Crystal will appear once the underlying workflow runs successfully a
 * few times.
 */
import { createFromConversation as createObjectiveFromConversation } from './objectivesStore'

/**
 * Mark a conversation as a candidate for future crystallisation.
 * Creates an objective tagged `candidate_for_crystal:true`.
 * The actual Crystal materialises post-hoc via the Crystalliser once the
 * workflow that follows runs ≥3 times at ≥80% success.
 *
 * @param {string} corrId - AEE correlation ID of the originating conversation
 * @param {object} [opts]
 * @param {Function} [opts.authFetch] - required (passes through to objectivesStore)
 * @returns {Promise<{ id: string, candidate_for_crystal: true }>}
 */
export async function createDraftFromConversation(corrId, opts = {}) {
  const authFetch = opts.authFetch
  if (!authFetch) {
    throw new Error('crystalStore.createDraftFromConversation requires opts.authFetch')
  }
  const objective = await createObjectiveFromConversation(authFetch, corrId, {
    metadata: { candidate_for_crystal: true, source: 'conversation' },
  })
  return { id: objective.id, candidate_for_crystal: true, ...objective }
}
