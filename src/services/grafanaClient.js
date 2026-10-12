/**
 * Grafana Client Service
 *
 * All API calls route through the collector proxy (/collector/api/v1/grafana/*)
 * to eliminate CORS and keep the Grafana API key server-side.
 * The Grafana base URL for iframe embedding is fetched from the proxy.
 */

const PROXY_BASE = '/collector/api/v1/grafana'

// Cache the Grafana base URL after first fetch
let _grafanaBaseUrl = null

/**
 * Get the Grafana base URL from the collector proxy.
 * Cached after first successful call.
 */
export async function getGrafanaBaseUrl(orgId) {
  if (_grafanaBaseUrl) return _grafanaBaseUrl
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/config`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(5000)
    })
    const data = await resp.json()
    if (data.success && data.url) {
      _grafanaBaseUrl = data.url
      return _grafanaBaseUrl
    }
  } catch {
    // Fall through to localStorage fallback
  }
  // Fallback: check localStorage settings (legacy support)
  try {
    const settings = JSON.parse(localStorage.getItem('quox-settings') || '{}')
    if (settings.monitoring?.grafana?.url) return settings.monitoring.grafana.url
  } catch { /* ignore */ }
  return null // Not configured — setup required via Monitoring page
}

/**
 * Search for dashboards via collector proxy
 */
export async function searchDashboards(options = {}, orgId) {
  try {
    const params = new URLSearchParams()
    if (options.query) params.set('query', options.query)
    if (options.tag) params.set('tag', options.tag)
    const qs = params.toString()
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/dashboards${qs ? '?' + qs : ''}`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    })
    return await resp.json()
  } catch (error) {
    console.error('[Grafana] Dashboard search failed:', error)
    return { success: false, error: error.message, dashboards: [] }
  }
}

/**
 * Get panels for a specific dashboard
 */
export async function getDashboardPanels(uid, orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/dashboards/${encodeURIComponent(uid)}/panels`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    })
    return await resp.json()
  } catch (error) {
    console.error('[Grafana] Panel fetch failed:', error)
    return { success: false, error: error.message, panels: [] }
  }
}

/**
 * Get alert rules with state categorisation
 */
export async function getAlertStates(orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/alerts`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    })
    return await resp.json()
  } catch (error) {
    console.error('[Grafana] Alert fetch failed:', error)
    return { success: false, error: error.message, rules: [], summary: { firing: 0, pending: 0, normal: 0 } }
  }
}

/**
 * Get Grafana health status via proxy
 */
export async function getHealth(orgId) {
  try {
    const headers = {}
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/health`, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    })
    return await resp.json()
  } catch (error) {
    console.error('[Grafana] Health check failed:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Create a Grafana annotation via proxy
 */
export async function createAnnotation({ text, tags, dashboardUID, panelId }, orgId) {
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/annotations`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ text, tags, dashboardUID, panelId }),
      signal: AbortSignal.timeout(10000),
    })
    return await resp.json()
  } catch (error) {
    console.error('[Grafana] Annotation failed:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Get the base URL for iframe embedding.
 * Uses the nginx reverse proxy (/grafana) to avoid mixed-content blocks
 * when the dashboard is served over HTTPS but Grafana is HTTP.
 * Falls back to the direct URL for "Open in Grafana" links.
 */
function getEmbedBaseUrl() {
  return '/grafana'
}

/**
 * Generate full dashboard embed URL (for iframe src)
 */
export async function getDashboardUrl(uid, options = {}) {
  const baseUrl = getEmbedBaseUrl()
  const params = new URLSearchParams()
  if (options.from) params.set('from', options.from)
  if (options.to) params.set('to', options.to)
  // Template variables
  Object.entries(options).forEach(([key, value]) => {
    if (key.startsWith('var-')) params.set(key, value)
  })
  const qs = params.toString()
  return `${baseUrl}/d/${encodeURIComponent(uid)}${qs ? '?' + qs : ''}`
}

/**
 * Generate panel-level embed URL (Grafana solo panel mode)
 */
export async function getPanelUrl(uid, panelId, options = {}) {
  const baseUrl = getEmbedBaseUrl()
  const params = new URLSearchParams({ panelId: String(panelId) })
  if (options.from) params.set('from', options.from)
  if (options.to) params.set('to', options.to)
  Object.entries(options).forEach(([key, value]) => {
    if (key.startsWith('var-')) params.set(key, value)
  })
  return `${baseUrl}/d-solo/${encodeURIComponent(uid)}/panel?${params}`
}

/**
 * Generate a direct Grafana URL for "Open in Grafana" links (not iframes)
 */
export async function getDirectDashboardUrl(uid, options = {}, orgId) {
  let baseUrl = await getGrafanaBaseUrl(orgId)
  // Guard: if Grafana URL not configured, return null
  if (!baseUrl || !baseUrl.startsWith('http')) {
    return null
  }
  const params = new URLSearchParams()
  if (options.from) params.set('from', options.from)
  if (options.to) params.set('to', options.to)
  Object.entries(options).forEach(([key, value]) => {
    if (key.startsWith('var-')) params.set(key, value)
  })
  const qs = params.toString()
  return `${baseUrl}/d/${encodeURIComponent(uid)}${qs ? '?' + qs : ''}`
}

/**
 * Test connectivity to an arbitrary Grafana URL (without saving)
 */
export async function testGrafanaUrl(url, orgId) {
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/test`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(10000),
    })
    return await resp.json()
  } catch (error) {
    return { success: false, error: error.message }
  }
}

/**
 * Save a new Grafana URL to the collector (persisted across restarts)
 */
export async function saveGrafanaConfig(url, orgId) {
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (orgId) headers['X-Org-Id'] = orgId
    const resp = await fetch(`${PROXY_BASE}/config`, {
      method: 'PUT',
      headers,
      credentials: 'include',
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await resp.json()
    if (data.success) {
      _grafanaBaseUrl = url // Update local cache
    }
    return data
  } catch (error) {
    return { success: false, error: error.message }
  }
}

export default {
  searchDashboards,
  getDashboardPanels,
  getAlertStates,
  getHealth,
  createAnnotation,
  getDashboardUrl,
  getDirectDashboardUrl,
  getPanelUrl,
  getGrafanaBaseUrl,
  testGrafanaUrl,
  saveGrafanaConfig,
}
