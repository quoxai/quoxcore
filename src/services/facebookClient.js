/**
 * facebookClient — the Facebook plugin's data layer. FB-3, mirrors
 * src/services/linkedinClient.js exactly.
 *
 * Auth: all calls take `authFetch` from AuthContext (cookie + CSRF pattern).
 * A bare fetch() 401s at the collector auth gate before routing — never add
 * one here. Tokens/credentials never appear in client code or tool inputs;
 * the collector's connector bridge resolves the org's vaulted `meta`
 * credential server-side (see services/collector/lib/connectors/types/facebook.js).
 */

// The one registered way to drive facebook_pages_* connector tools from the
// UI. Server side: executeConnectorTool (services/collector/lib/connectors/bridge.js)
// resolves the org's vaulted access_token and dispatches to the tool.
const EXECUTE_API = (toolName) => `/collector/connectors/facebook_pages/tools/${toolName}/execute`

/**
 * Route manifest — consumed by the route-existence guard test. `registered`
 * lists literal strings that must appear in the named collector source file
 * for the route to exist.
 */
export const FACEBOOK_ROUTES = [
  {
    method: 'POST',
    path: '/collector/connectors/facebook_pages/tools/:toolName/execute',
    templated: true,
    serverFile: 'services/collector/server.js',
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    // Token-expiry read — AUTH service, not collector: the vault owns
    // credential metadata. Returns masked rows only, never secrets.
    method: 'GET',
    path: '/api/orgs/:orgId/integrations?type=meta',
    templated: true,
    serverFile: 'services/auth/routes/integrations.js',
    registered: ["router.get('/orgs/:orgId/integrations'"],
  },
  {
    // Activity ledger (FB-3) — the org's governed write history straight
    // from the approval store; the card trail IS the ledger.
    method: 'GET',
    path: '/collector/facebook/activity',
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/facebook'"],
    routerFile: 'services/collector/routes/facebookRoutes.js',
    routerRegistered: ["router.get('/activity'"],
  },
]

async function parseOrThrow(res, what) {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let detail = text.slice(0, 300)
    try {
      const body = JSON.parse(text)
      if (body?.error) detail = body.error
    } catch {
      if (/<html/i.test(text)) {
        detail = `the server proxy answered with an error page instead of the app (HTTP ${res.status})`
      }
    }
    throw new Error(`${what} failed (${res.status}): ${detail}`)
  }
  return res.json()
}

async function callTool(authFetch, toolName, input = {}) {
  const res = await authFetch(EXECUTE_API(toolName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  const data = await parseOrThrow(res, `Facebook tool ${toolName}`)
  if (data.pending) {
    // Gated write (publish_page_post): the bridge filed a human approval
    // card and nothing was published. NOT an error — callers render
    // "awaiting approval", the same contract linkedinClient's writes return.
    return {
      pending: true,
      status: 'awaiting_approval',
      approvalId: data.approvalId,
      inboxItemId: data.inbox_item_id || null,
      message: data.message,
    }
  }
  if (!data.success) {
    throw new Error(data.error || `Facebook tool ${toolName} returned failure`)
  }
  return data.result
}

export async function getPages(authFetch, limit = 25) {
  return callTool(authFetch, 'get_pages', { limit })
}

export async function getPageInfo(authFetch, pageId) {
  return callTool(authFetch, 'get_page_info', { page_id: pageId })
}

export async function getPagePosts(authFetch, pageId, limit = 10) {
  return callTool(authFetch, 'get_page_posts', { page_id: pageId, limit })
}

export async function getPageInsights(authFetch, pageId, { metrics, period } = {}) {
  return callTool(authFetch, 'get_page_insights', {
    page_id: pageId,
    metrics: metrics || undefined,
    period: period || undefined,
  })
}

export async function getLeadForms(authFetch, pageId, limit = 25) {
  return callTool(authFetch, 'get_lead_forms', { page_id: pageId, limit })
}

export async function getLeads(authFetch, formId, limit = 25) {
  return callTool(authFetch, 'get_leads', { form_id: formId, limit })
}

export async function publishPagePost(authFetch, { pageId, message, link, imageUrl }) {
  return callTool(authFetch, 'publish_page_post', {
    page_id: pageId,
    message,
    link: link || undefined,
    image_url: imageUrl || undefined,
  })
}

/**
 * Classify a tool-call failure into an honest credential-health verdict.
 * Bridge-level messages mean the org has no usable vaulted token; provider
 * 401s mean the token exists but Facebook rejected it (expired/revoked).
 * Anything else is NOT a credential problem and must not be reported as one.
 */
function classifyFailure(message) {
  const msg = String(message || '')
  if (/no facebook_pages credentials|missing credential fields/i.test(msg)) {
    return { connected: false, reason: 'no_credential', error: msg }
  }
  if (/401|expired or invalid/i.test(msg)) {
    return { connected: false, reason: 'token_rejected', error: msg }
  }
  return { connected: false, reason: 'check_failed', error: msg }
}

/**
 * Org-scoped credential health. Drives a real tool through the org's own
 * vaulted credential. Uses get_page_info when a default Page ID is
 * configured (its result is returned as `pageInfo` so callers need not
 * fetch it twice), else a cheap get_pages read.
 */
export async function checkCredentialHealth(authFetch, { pageId } = {}) {
  try {
    if (pageId) {
      const pageInfo = await getPageInfo(authFetch, pageId)
      return { connected: true, method: 'get_page_info', pageInfo }
    }
    await getPages(authFetch, 1)
    return { connected: true, method: 'get_pages' }
  } catch (err) {
    return classifyFailure(err.message)
  }
}

/**
 * Read the vaulted Facebook (meta) token's expiry. Masked credential
 * metadata from the auth service — never the secret. Returns
 * { label, expiresAt, daysLeft } for the org's default (or only) meta
 * credential, or null when none exists or none carries an expiry.
 */
export async function getTokenExpiry(authFetch, quoxOrgId) {
  if (!quoxOrgId) return null
  const res = await authFetch(`/api/orgs/${encodeURIComponent(quoxOrgId)}/integrations?type=meta`)
  const data = await parseOrThrow(res, 'Facebook credential lookup')
  const creds = data.credentials || []
  const cred = creds.find((c) => c.is_default) || creds[0]
  if (!cred?.expires_at) return null
  const expiresAt = cred.expires_at
  const daysLeft = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000)
  return { label: cred.label, expiresAt, daysLeft }
}

/**
 * The org's governed Facebook write history: every drafted publish_page_post
 * with its human decision — awaiting_approval / published / denied / failed —
 * read from the approval store, no parallel bookkeeping.
 */
export async function getActivity(authFetch, { limit = 50 } = {}) {
  const res = await authFetch(`/collector/facebook/activity?limit=${encodeURIComponent(limit)}`)
  const data = await parseOrThrow(res, 'Facebook activity')
  return data.items || []
}

const facebookClient = {
  FACEBOOK_ROUTES,
  getTokenExpiry,
  getActivity,
  getPages,
  getPageInfo,
  getPagePosts,
  getPageInsights,
  getLeadForms,
  getLeads,
  publishPagePost,
  checkCredentialHealth,
}

export default facebookClient
