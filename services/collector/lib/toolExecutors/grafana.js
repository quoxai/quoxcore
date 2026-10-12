/**
 * Grafana Tool Executor
 *
 * Server-side Grafana API client for the grafana_dashboards tool.
 * Queries dashboards, alert rules, data sources, panels, and health.
 * Supports annotation creation for agent→Grafana event bridging.
 */

const path = require('path')
const fs = require('fs')

const GRAFANA_CONFIG_PATH = path.join(process.env.AEE_DB_PATH ? path.dirname(process.env.AEE_DB_PATH) : '/var/lib/quox', 'grafana-config.json')

// Load saved URL override from config file, fall back to env var
function loadGrafanaUrl() {
  try {
    if (fs.existsSync(GRAFANA_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(GRAFANA_CONFIG_PATH, 'utf8'))
      if (cfg.url) return cfg.url
    }
  } catch { /* ignore */ }
  return process.env.GRAFANA_URL || ''
}

function saveGrafanaUrl(url) {
  try {
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(GRAFANA_CONFIG_PATH, 'utf8')) } catch { /* new file */ }
    cfg.url = url
    fs.writeFileSync(GRAFANA_CONFIG_PATH, JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.error('[Grafana] Failed to save config:', err.message)
  }
}

let GRAFANA_URL = loadGrafanaUrl()

function getGrafanaUrl() { return GRAFANA_URL }
function setGrafanaUrl(url) { GRAFANA_URL = url; saveGrafanaUrl(url) }

// VAULT-INTEG P3: GRAFANA_API_KEY used to be a module-level const read once
// at process start — structurally single-tenant (every org sharing this
// collector got the same key). Callers now resolve the org's vault
// credential per call (agentTools.js's grafana_dashboards tool, via
// grafanaCredentials.resolveGrafanaApiKey) and pass it through as
// `apiKeyOverride`; reading process.env.GRAFANA_API_KEY here at CALL time
// (not module load) keeps it as the last-resort fallback when no per-call
// key is supplied — e.g. tests that invoke grafanaDashboards() directly, or
// deploys with no org-scoped vault credential configured yet.
function getApiKey(apiKeyOverride) {
  return apiKeyOverride || process.env.GRAFANA_API_KEY || ''
}

function buildHeaders(apiKey) {
  const headers = { 'Accept': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

// baseUrl defaults to the module-global GRAFANA_URL (evaluated at CALL time, so
// it tracks setGrafanaUrl reassignment). server.js's embed/config endpoints call
// with (path[, apiKey]) and rely on that default; the agent-tool path passes a
// per-org baseUrl so each org hits its OWN Grafana, never the global default.
async function grafanaFetch(path, apiKey, baseUrl = GRAFANA_URL) {
  const resp = await fetch(`${baseUrl}${path}`, {
    headers: buildHeaders(apiKey),
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) {
    throw new Error(`Grafana ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 200))
  }
  return resp.json()
}

async function grafanaPost(path, body, apiKey, baseUrl = GRAFANA_URL) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...buildHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) {
    throw new Error(`Grafana ${resp.status}: ${await resp.text().catch(() => '')}`.slice(0, 200))
  }
  return resp.json()
}

/**
 * grafana_dashboards — query Grafana for dashboards, alerts, data sources, panels
 * @param {object} input
 * @param {string} [apiKeyOverride] - per-call API key (vault-resolved by the
 *   caller — see agentTools.js's grafana_dashboards tool). Falls back to
 *   process.env.GRAFANA_API_KEY when omitted.
 */
async function grafanaDashboards(input, apiKeyOverride, baseUrlOverride) {
  const { action = 'search', query, tag } = input
  const apiKey = getApiKey(apiKeyOverride)
  // Per-org base URL wins (resolved from the org's vault credential by the
  // caller); the module-global GRAFANA_URL is the last-resort deploy default.
  const baseUrl = baseUrlOverride || GRAFANA_URL

  if (!baseUrl) {
    return { success: false, error: 'Grafana not configured. Set GRAFANA_URL environment variable.' }
  }

  try {
    switch (action) {
      case 'search': {
        const params = new URLSearchParams({ type: 'dash-db', limit: '30' })
        if (query) params.set('query', query)
        if (tag) params.set('tag', tag)
        const dashboards = await grafanaFetch(`/api/search?${params}`, apiKey, baseUrl)
        return {
          success: true,
          dashboards: dashboards.map(d => ({
            uid: d.uid,
            title: d.title,
            url: `${baseUrl}${d.url}`,
            tags: d.tags,
            folder: d.folderTitle,
            type: d.type,
          })),
          count: dashboards.length,
        }
      }

      case 'alerts': {
        let rules = []
        try {
          // Grafana 9+ unified alerting
          rules = await grafanaFetch('/api/v1/provisioning/alert-rules', apiKey, baseUrl)
        } catch {
          // Fallback to legacy alert API
          try {
            const legacy = await grafanaFetch('/api/alerts', apiKey, baseUrl)
            rules = legacy.map(a => ({
              title: a.name,
              state: a.state,
              dashboardUid: a.dashboardUid,
              panelId: a.panelId,
            }))
          } catch {
            return { success: false, error: 'No alerting API available' }
          }
        }

        const states = { firing: 0, pending: 0, normal: 0 }
        for (const r of rules) {
          const state = (r.state || r.execErrState || 'normal').toLowerCase()
          if (state === 'firing' || state === 'alerting') states.firing++
          else if (state === 'pending') states.pending++
          else states.normal++
        }

        return {
          success: true,
          rules: rules.slice(0, 30).map(r => ({
            title: r.title || r.name,
            state: r.state,
            folder: r.folderTitle || r.folder,
          })),
          summary: states,
          count: rules.length,
        }
      }

      case 'panels': {
        const uid = input.dashboardUID || input.uid
        if (!uid) return { success: false, error: 'dashboardUID required for panels action' }
        const data = await grafanaFetch(`/api/dashboards/uid/${encodeURIComponent(uid)}`, apiKey, baseUrl)
        const panels = (data.dashboard?.panels || []).map(p => ({
          id: p.id,
          title: p.title,
          type: p.type,
          description: p.description || null,
        }))
        // Flatten row panels (Grafana nests panels inside row type)
        const flatPanels = []
        for (const p of panels) {
          if (p.type === 'row' && data.dashboard?.panels) {
            const rowPanel = data.dashboard.panels.find(dp => dp.id === p.id)
            if (rowPanel?.panels) {
              for (const inner of rowPanel.panels) {
                flatPanels.push({ id: inner.id, title: inner.title, type: inner.type, description: inner.description || null })
              }
            }
            flatPanels.push(p)
          } else {
            flatPanels.push(p)
          }
        }
        return {
          success: true,
          dashboardTitle: data.dashboard?.title,
          panels: flatPanels,
          count: flatPanels.length,
        }
      }

      case 'annotate': {
        const { text, tags: annotTags, dashboardUID, panelId, time, timeEnd } = input
        if (!text) return { success: false, error: 'text required for annotate action' }
        const body = { text, tags: annotTags || ['quoxcore'] }
        if (dashboardUID) body.dashboardUID = dashboardUID
        if (panelId) body.panelId = panelId
        if (time) body.time = time
        if (timeEnd) body.timeEnd = timeEnd
        const result = await grafanaPost('/api/annotations', body, apiKey, baseUrl)
        return { success: true, id: result.id, message: result.message }
      }

      case 'datasources': {
        const dataSources = await grafanaFetch('/api/datasources', apiKey, baseUrl)
        return {
          success: true,
          dataSources: dataSources.map(ds => ({
            name: ds.name,
            type: ds.type,
            url: ds.url,
            isDefault: ds.isDefault,
          })),
          count: dataSources.length,
        }
      }

      case 'health': {
        const health = await grafanaFetch('/api/health', apiKey, baseUrl)
        return {
          success: true,
          ...health,
          url: baseUrl,
        }
      }

      default:
        return { success: false, error: `Unknown action: ${action}. Valid: search, alerts, panels, annotate, datasources, health` }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

module.exports = { grafanaDashboards, grafanaFetch, grafanaPost, GRAFANA_URL, getGrafanaUrl, setGrafanaUrl }
