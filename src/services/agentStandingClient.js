/**
 * agentStandingClient.js
 *
 * Fetches per-agent Standing (score/status/history/events) from the Tasks
 * service. Follows the same /tasks proxy conventions as objectivesClient.js
 * (TASKS_BASE + requestTaskServiceJson) — see taskServiceClient.js.
 *
 * Never-seen agent+task_class is NOT an error: the backend returns the
 * cold-start default (score 50, autonomous, empty history/events), so
 * callers don't need to special-case a 404 here.
 */

import { requestTaskServiceJson } from './taskServiceClient'

/**
 * @param {Function} authFetch
 * @param {string} agentId
 * @param {{ taskClass?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ score: number, status: 'autonomous'|'supervised', history: number[], events: Array }>}
 * @throws {Error} on non-2xx or network failure
 */
export async function fetchAgentStanding(authFetch, agentId, { taskClass = 'general', signal } = {}) {
  const params = new URLSearchParams({ task_class: taskClass })
  return requestTaskServiceJson(
    authFetch,
    `/api/agent-standing/${encodeURIComponent(agentId)}?${params.toString()}`,
    { method: 'GET', signal },
    'Failed to fetch agent standing',
  )
}
