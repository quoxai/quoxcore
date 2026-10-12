/**
 * AEE-FULL Gap 4 — Cancel Execution Service
 *
 * Wraps POST /api/executions/:id/cancel with consistent result codes the UI
 * can switch on without parsing HTTP status manually.
 *
 * Per orchestrator decisions:
 *   - SD-1 / 200: returns { code: OK, execution } (updated execution row from response)
 *   - SD-1 refinement / 409: returns { code: ALREADY_TERMINAL, currentStatus }
 *     so the UI can refresh state from the response without a second GET
 *   - SD-1 / 404: returns { code: NOT_FOUND }
 *   - Network error: returns { code: NETWORK_ERROR, error }
 *   - SD-2: HTTP route hardcodes cancelled_by='user' server-side; client
 *     never sends it. Body only contains optional `reason`.
 *   - SD-9: uses authFetch (auth required); no client-side role check.
 *     Engine is the authority.
 *   - SD-10: reason is omitted from POST body if absent/empty/whitespace-only
 *     to avoid audit noise (server stores undefined instead of '').
 *
 * Callers:
 *   - ExecutionDetailView: detail-page cancel modal with optional reason textarea
 *   - WorkflowsView running-now panel: listing-page Yes/No confirm with no reason
 */

export const CANCEL_RESULT_CODES = Object.freeze({
  OK: 'ok',
  NOT_FOUND: 'not_found',
  ALREADY_TERMINAL: 'already_terminal',
  NETWORK_ERROR: 'network_error',
  UNEXPECTED: 'unexpected',
})

/**
 * Cancel a running quoxflow execution.
 *
 * @param {string} executionId
 * @param {object} [options]
 * @param {string} [options.reason] - free-text reason; empty/whitespace is omitted
 * @param {Function} [options.authFetch] - auth-aware fetch wrapper (required)
 * @returns {Promise<
 *   | { code: 'ok', execution: object }
 *   | { code: 'not_found' }
 *   | { code: 'already_terminal', currentStatus: string | null }
 *   | { code: 'network_error', error: Error }
 *   | { code: 'unexpected', status: number, body: any }
 * >}
 */
export async function cancelExecution(executionId, options = {}) {
  const { reason, authFetch } = options
  if (!authFetch) {
    throw new Error('cancelExecution: authFetch is required')
  }

  const body = {}
  if (typeof reason === 'string' && reason.trim().length > 0) {
    body.reason = reason
  }

  let response
  try {
    response = await authFetch(`/api/executions/${executionId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { code: CANCEL_RESULT_CODES.NETWORK_ERROR, error: err }
  }

  let parsed = null
  try { parsed = await response.json() } catch { /* swallow parse error */ }

  if (response.ok) {
    return {
      code: CANCEL_RESULT_CODES.OK,
      execution: parsed?.data ?? null,
    }
  }

  if (response.status === 404) {
    return { code: CANCEL_RESULT_CODES.NOT_FOUND }
  }

  if (response.status === 409) {
    return {
      code: CANCEL_RESULT_CODES.ALREADY_TERMINAL,
      currentStatus: parsed?.error?.current_status ?? null,
    }
  }

  return {
    code: CANCEL_RESULT_CODES.UNEXPECTED,
    status: response.status,
    body: parsed,
  }
}
