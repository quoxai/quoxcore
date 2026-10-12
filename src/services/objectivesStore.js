/**
 * objectivesStore — thin store layer over objectivesClient
 *
 * Adds higher-level convenience methods that compose with context
 * (e.g. org_id from localStorage multi-tenant convention).
 *
 * Does NOT replace objectivesClient — callers that already use
 * objectivesClient directly continue to work unchanged.
 */
import { requestTaskServiceJson } from './taskServiceClient'
import { logObjectiveCreated } from './objectivesAudit'

/**
 * Create an objective seeded from a chat conversation.
 * Reads org_id from localStorage('current_org_id') per multi-tenant convention.
 *
 * @param {Function} authFetch
 * @param {string}   corrId   - AEE correlation ID for the conversation
 * @param {object}   [opts]
 * @param {string}   [opts.title]       - override title (defaults to generic)
 * @param {string}   [opts.description] - optional description
 * @returns {Promise<{ id: string, [key: string]: any }>}
 */
export async function createFromConversation(authFetch, corrId, opts = {}) {
  const orgId = localStorage.getItem('current_org_id') || undefined
  const body = {
    title: opts.title || 'Objective from conversation',
    description: opts.description || '',
    corr_id: corrId || undefined,
    org_id: orgId,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  }
  const result = await requestTaskServiceJson(
    authFetch,
    '/api/objectives',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    'Failed to create objective from conversation',
  )
  logObjectiveCreated(result, corrId)
  return result
}
