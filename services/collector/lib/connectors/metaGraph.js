/**
 * Meta Graph API — shared helper
 *
 * Common fetch wrapper for the Meta Graph API, shared by the Facebook
 * connector (types/facebook.js) and a future Instagram connector. Organic
 * surfaces only — no ads/marketing endpoints live here (that boundary is
 * owned by a future META-ADS plugin).
 *
 * Pinned version: v26.0 was live-probed valid; v27.0 rejects requests as of
 * this writing. Re-verify against the Graph API changelog before bumping.
 *
 * API docs: https://developers.facebook.com/docs/graph-api/
 */

const GRAPH_API_VERSION = 'v26.0'
const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`

async function graphFetch(path, credentials, options = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH_API}${path}`
  // Bearer header keeps the token out of the URL/logs, matching the LinkedIn
  // connector's auth pattern (Bearer access_token from resolved credentials).
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    if (resp.status === 401) {
      throw new Error(`Meta Graph API 401: Access token expired or invalid. Re-authenticate via vault.`)
    }
    if (resp.status === 403) {
      throw new Error(`Meta Graph API 403: Permission denied. Check the token's scopes (pages_read_engagement, pages_show_list, pages_manage_posts, leads_retrieval).`)
    }
    if (resp.status === 429) {
      throw new Error(`Meta Graph API 429: Rate limit exceeded. Try again later.`)
    }
    throw new Error(`Meta Graph API ${resp.status}: ${body.slice(0, 300)}`)
  }

  const text = await resp.text()
  return text ? JSON.parse(text) : null
}

module.exports = { GRAPH_API_VERSION, GRAPH_API, graphFetch }
