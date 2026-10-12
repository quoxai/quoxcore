/**
 * Docker Client
 * API client for Docker fleet operations via the collector service.
 * Supports server-side caching — cached data loads instantly, refresh fetches live.
 */

const COLLECTOR_URL = window.location.origin

async function collectorFetch(endpoint, options = {}, orgId) {
  try {
    const headers = { 'Content-Type': 'application/json', ...options.headers }
    if (orgId) headers['X-Org-Id'] = orgId
    const res = await fetch(`${COLLECTOR_URL}/collector${endpoint}`, {
      ...options,
      headers,
      credentials: 'include'
    })
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText)
      return { success: false, error: `${res.status}: ${err}` }
    }
    return await res.json()
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Scan fleet for Docker hosts via bastion
 * @param {object} opts
 * @param {boolean} opts.refresh - Force live scan (default: use cache)
 */
export async function scanFleet({ refresh = false } = {}, orgId) {
  const qs = refresh ? '?refresh=true' : ''
  return collectorFetch(`/docker/fleet${qs}`, {}, orgId)
}

/**
 * List containers on a specific host (or all hosts)
 * @param {string|null} host
 * @param {boolean} showAll
 * @param {object} opts
 * @param {boolean} opts.refresh - Force live fetch
 */
export async function listContainers(host = null, showAll = true, { refresh = false } = {}, orgId) {
  const params = new URLSearchParams()
  if (host) params.set('host', host)
  if (showAll) params.set('all', 'true')
  if (refresh) params.set('refresh', 'true')
  return collectorFetch(`/docker/containers?${params}`, {}, orgId)
}

/**
 * Get container detail (inspect + stats + recent logs)
 */
export async function getContainerDetail(host, containerId, orgId) {
  return collectorFetch(`/docker/containers/${containerId}?host=${encodeURIComponent(host)}`, {}, orgId)
}

/**
 * Container lifecycle action
 */
export async function containerAction(host, containerId, action, orgId) {
  return collectorFetch(`/docker/containers/${containerId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ host })
  }, orgId)
}

/**
 * List compose stacks across fleet
 */
export async function listComposeStacks(host = null, orgId) {
  const params = host ? `?host=${encodeURIComponent(host)}` : ''
  return collectorFetch(`/docker/stacks${params}`, {}, orgId)
}

/**
 * Get Docker system disk usage for a host
 */
export async function getSystemDf(host, orgId) {
  return collectorFetch(`/docker/system-df?host=${encodeURIComponent(host)}`, {}, orgId)
}

/**
 * Get container logs
 */
export async function getContainerLogs(host, containerId, tail = 100, orgId) {
  return collectorFetch(`/docker/containers/${containerId}/logs?host=${encodeURIComponent(host)}&tail=${tail}`, {}, orgId)
}

/**
 * Get container stats
 */
export async function getContainerStats(host, containerId, orgId) {
  return collectorFetch(`/docker/containers/${containerId}/stats?host=${encodeURIComponent(host)}`, {}, orgId)
}

export default {
  scanFleet,
  listContainers,
  getContainerDetail,
  containerAction,
  listComposeStacks,
  getSystemDf,
  getContainerLogs,
  getContainerStats
}
