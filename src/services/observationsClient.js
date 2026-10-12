/**
 * Observations Client — STUDY-REV P6.C
 *
 * Fetches Observation records from quoxflow via the collector proxy.
 * Canonical URL: /collector/quoxflow/observations
 *
 * The collector proxy forwards the request to quoxflow's
 * GET /api/observations with X-Service-Key.
 *
 * Usage:
 *   import { listObservations } from './observationsClient'
 *   const { observations, meta } = await listObservations({ authFetch, correlationId: 'corr-123' })
 */

const PROXY_BASE = '/collector/quoxflow'

/**
 * List observation records via the collector proxy.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch - Authenticated fetch (from useAuth)
 * @param {string} [opts.taskId]
 * @param {string} [opts.correlationId]
 * @param {string} [opts.workflowId]
 * @param {string} [opts.orgId]
 * @returns {Promise<{ observations: object[], meta: { count: number, requestId: string, timestamp: string } }>}
 */
export async function listObservations({ authFetch, taskId, correlationId, workflowId, orgId } = {}) {
  const params = new URLSearchParams()
  if (taskId) params.set('taskId', taskId)
  if (correlationId) params.set('correlationId', correlationId)
  if (workflowId) params.set('workflowId', workflowId)
  if (orgId) params.set('orgId', orgId)

  const qs = params.toString()
  const url = `${PROXY_BASE}/observations${qs ? '?' + qs : ''}`

  const fetcher = authFetch || fetch
  const res = await fetcher(url, {
    method: 'GET',
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `listObservations failed: HTTP ${res.status}`)
  }

  return res.json()
}

/**
 * List quoxflow evidence records via the collector proxy.
 * This is the bridge URL the task spec calls for — resolves to quoxflow's
 * /api/evidence regardless of whether quoxflow is internal-network-only.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch - Authenticated fetch (from useAuth)
 * @param {string} [opts.correlationId] — maps to ?corr= on quoxflow
 * @param {string} [opts.envelopeId]
 * @param {string} [opts.workflowId]
 * @param {string} [opts.executionId]
 * @param {string} [opts.type]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {Promise<{ success: boolean, data: object[], pagination: object, meta: object }>}
 */
export async function listQuoxflowEvidence({ authFetch, correlationId, envelopeId, workflowId, executionId, type, limit, offset } = {}) {
  const params = new URLSearchParams()
  if (correlationId) params.set('correlationId', correlationId)
  if (envelopeId) params.set('envelopeId', envelopeId)
  if (workflowId) params.set('workflowId', workflowId)
  if (executionId) params.set('executionId', executionId)
  if (type) params.set('type', type)
  if (limit != null) params.set('limit', String(limit))
  if (offset != null) params.set('offset', String(offset))

  const qs = params.toString()
  const url = `${PROXY_BASE}/evidence${qs ? '?' + qs : ''}`

  const fetcher = authFetch || fetch
  const res = await fetcher(url, {
    method: 'GET',
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `listQuoxflowEvidence failed: HTTP ${res.status}`)
  }

  return res.json()
}
