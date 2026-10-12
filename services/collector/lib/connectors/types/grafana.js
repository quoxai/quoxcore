/**
 * Grafana Connector — VAULT-INTEG P10
 *
 * Read-only tools for the Grafana HTTP API: dashboards and alert rules.
 * Requires: api_key (glsa_... service account token), base_url.
 *
 * This is a separate, vault-per-org connector module from
 * lib/toolExecutors/grafana.js (the older single-instance
 * GRAFANA_URL/GRAFANA_API_KEY-configured tool). That module stays as-is;
 * this one follows the connectors/types/* + registry.js pattern so each org
 * can point at its own Grafana instance with its own vault-scoped credential.
 */

const REQUEST_TIMEOUT_MS = 15_000

async function grafanaFetch(baseUrl, path, credentials, options = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`

  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.api_key}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    if (resp.status === 401) {
      throw new Error(`Grafana API 401 Unauthorized: invalid or expired service account token. Body: ${body.slice(0, 200)}`)
    }
    throw new Error(`Grafana API ${resp.status}: ${body.slice(0, 200)}`)
  }

  return resp.json()
}

function getTools(credentials) {
  const baseUrl = credentials.base_url

  return [
    {
      name: 'list_dashboards',
      description: 'Search Grafana dashboards by query and/or tag',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text to match against dashboard title' },
          tag: { type: 'string', description: 'Filter by dashboard tag' },
          limit: { type: 'number', description: 'Max results (default 30, max 100)' },
        },
      },
      execute: async (input, creds) => {
        const { query, tag, limit = 30 } = input
        const params = new URLSearchParams({ type: 'dash-db', limit: String(Math.min(limit, 100)) })
        if (query) params.set('query', query)
        if (tag) params.set('tag', tag)
        const dashboards = await grafanaFetch(baseUrl, `/api/search?${params}`, creds)
        return (dashboards || []).map(d => ({
          uid: d.uid,
          title: d.title,
          url: `${baseUrl.replace(/\/$/, '')}${d.url}`,
          tags: d.tags || [],
          folder: d.folderTitle || null,
        }))
      },
    },

    {
      name: 'get_dashboard',
      description: 'Get a Grafana dashboard by UID, including its panel list',
      input_schema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Dashboard UID' },
        },
        required: ['uid'],
      },
      execute: async (input, creds) => {
        const { uid } = input
        const data = await grafanaFetch(baseUrl, `/api/dashboards/uid/${encodeURIComponent(uid)}`, creds)
        return {
          uid: data.dashboard?.uid || uid,
          title: data.dashboard?.title,
          folder: data.meta?.folderTitle || null,
          panels: (data.dashboard?.panels || []).map(p => ({ id: p.id, title: p.title, type: p.type })),
        }
      },
    },

    {
      name: 'list_alerts',
      description: 'List Grafana alert rules with current state (firing, pending, normal)',
      input_schema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by state: firing, pending, or normal' },
        },
      },
      execute: async (input, creds) => {
        const rules = await grafanaFetch(baseUrl, '/api/v1/provisioning/alert-rules', creds)
        let shaped = (rules || []).map(r => ({
          uid: r.uid,
          title: r.title,
          state: (r.state || 'normal').toLowerCase(),
          folder: r.folderUID || null,
        }))
        if (input.state) {
          const s = input.state.toLowerCase()
          shaped = shaped.filter(r => r.state === s)
        }
        const summary = { firing: 0, pending: 0, normal: 0 }
        for (const r of shaped) {
          if (summary[r.state] !== undefined) summary[r.state]++
        }
        return { rules: shaped, summary }
      },
    },
  ]
}

module.exports = { getTools }
