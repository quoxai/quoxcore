/**
 * Triggers Client — STUDY-REV-2 P8.A
 *
 * Fetches trigger enumeration data from quoxflow via the collector proxy.
 * Three read endpoints + one test-fire action.
 *
 * Proxy base: /collector/quoxflow/triggers/...
 *
 * Usage:
 *   import { listWebhookTriggers, listScheduleTriggers, listEventTriggers, testFireWebhook } from './triggersClient'
 *   const { webhooks } = await listWebhookTriggers({ authFetch })
 */

const PROXY_BASE = '/collector/quoxflow/triggers'

/**
 * List all registered webhook triggers from WebhookRegistry.
 *
 * @param {object} opts
 * @param {Function} [opts.authFetch] - Authenticated fetch (from useAuth)
 * @returns {Promise<{ webhooks: Array<{ workflowId: string, nodeId: string, path: string, method: string, lastFiredAt: string|null, fireCount: number|null }> }>}
 */
export async function listWebhookTriggers({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/webhooks`, {
    method: 'GET',
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `listWebhookTriggers failed: HTTP ${res.status}`)
  }

  const json = await res.json()
  return json.data || json
}

/**
 * List active schedule triggers.
 *
 * When quoxflow does not own scheduling (default in QuoxCORE), returns:
 *   { schedules: [], owned_by: 'tasks', note: '...' }
 *
 * When QUOXFLOW_OWN_SCHEDULER=true:
 *   { schedules: [...], owned_by: 'quoxflow' }
 *
 * @param {object} opts
 * @param {Function} [opts.authFetch] - Authenticated fetch (from useAuth)
 * @returns {Promise<{ schedules: Array, owned_by: string, note?: string }>}
 */
export async function listScheduleTriggers({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/schedules`, {
    method: 'GET',
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `listScheduleTriggers failed: HTTP ${res.status}`)
  }

  const json = await res.json()
  return json.data || json
}

/**
 * List EventBus subscriptions (trigger:event nodes).
 *
 * @param {object} opts
 * @param {Function} [opts.authFetch] - Authenticated fetch (from useAuth)
 * @returns {Promise<{ subscriptions: Array<{ id: string, pattern: string, workflowId: string|null, once: boolean, lastMatchAt: string|null }> }>}
 */
export async function listEventTriggers({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/events`, {
    method: 'GET',
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `listEventTriggers failed: HTTP ${res.status}`)
  }

  const json = await res.json()
  return json.data || json
}

/**
 * Test-fire a registered webhook by path.
 * POSTs an empty body to the webhook's registered path.
 *
 * @param {object} opts
 * @param {Function} [opts.authFetch] - Authenticated fetch (from useAuth)
 * @param {string} opts.path - The webhook path (e.g. 'deploy' or '/deploy')
 * @returns {Promise<{ executionId: string, workflowId: string, status: string }>}
 */
export async function testFireWebhook({ authFetch, path } = {}) {
  if (!path) throw new Error('testFireWebhook: path is required')

  const fetcher = authFetch || fetch
  const res = await fetcher(`${PROXY_BASE}/webhooks/fire`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.message || `testFireWebhook failed: HTTP ${res.status}`)
  }

  const json = await res.json()
  return json.data || json
}
