/**
 * linkedinClient — the LinkedIn plugin's data layer. LI-OVERHAUL P2.
 *
 * History, so it never repeats: the first version of this file posted to
 * /collector/tool/execute and read /collector/connectors/linkedin/status,
 * neither of which ever existed in the collector, with a bare fetch that
 * carried no auth. Every panel 404'd for ~6 months while the view tests
 * mocked the data hook wholesale. The guard test
 * (src/test/linkedinClientRoutes.test.js) now greps the collector source for
 * every route this file touches; LINKEDIN_ROUTES below is the manifest it
 * checks. Pattern: src/services/xClient.js.
 *
 * Auth: all calls take `authFetch` from AuthContext (cookie + CSRF pattern).
 * A bare fetch() 401s at the collector auth gate before routing — never add
 * one here.
 */

// The one registered way to drive linkedin_* connector tools from the UI.
// Server side: executeConnectorTool (services/collector/lib/connectors/bridge.js)
// resolves the org's vaulted access_token and dispatches to the tool.
const EXECUTE_API = (toolName) => `/collector/connectors/linkedin/tools/${toolName}/execute`

/**
 * Route manifest — consumed by the route-existence guard test. `registered`
 * lists literal strings that must appear in the named collector source file
 * for the route to exist.
 */
export const LINKEDIN_ROUTES = [
  {
    method: 'POST',
    path: '/collector/connectors/linkedin/tools/:toolName/execute',
    templated: true,
    serverFile: 'services/collector/server.js',
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    // Token-expiry read (LI-OVERHAUL P5) — AUTH service, not collector: the
    // vault owns credential metadata. Returns masked rows only, never secrets.
    method: 'GET',
    path: '/api/orgs/:orgId/integrations?type=linkedin',
    templated: true,
    serverFile: 'services/auth/routes/integrations.js',
    registered: ["router.get('/orgs/:orgId/integrations'"],
  },
  {
    // Activity ledger (LI-OVERHAUL P11) — the org's governed write history
    // straight from the approval store; the card trail IS the ledger.
    method: 'GET',
    path: '/collector/linkedin/activity',
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/linkedin'"],
    routerFile: 'services/collector/routes/linkedinRoutes.js',
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
  const data = await parseOrThrow(res, `LinkedIn tool ${toolName}`)
  if (data.pending) {
    // Gated write (publish_post / create_comment): the bridge filed a human
    // approval card and nothing was published. NOT an error — callers render
    // "awaiting approval", the same contract xClient's drafts return.
    return {
      pending: true,
      status: 'awaiting_approval',
      approvalId: data.approvalId,
      inboxItemId: data.inbox_item_id || null,
      message: data.message,
    }
  }
  if (!data.success) {
    throw new Error(data.error || `LinkedIn tool ${toolName} returned failure`)
  }
  return data.result
}

export async function getPosts(authFetch, author, count = 20) {
  return callTool(authFetch, 'get_posts', { author, count })
}

export async function getPost(authFetch, postUrn) {
  return callTool(authFetch, 'get_post', { post_urn: postUrn })
}

export async function getEngagement(authFetch, postUrn) {
  return callTool(authFetch, 'get_engagement', { post_urn: postUrn })
}

export async function getComments(authFetch, postUrn, count = 20) {
  return callTool(authFetch, 'get_comments', { post_urn: postUrn, count })
}

export async function publishPost(authFetch, { author, text, visibility, mediaId, linkUrl }) {
  return callTool(authFetch, 'publish_post', {
    author,
    text,
    visibility: visibility || 'PUBLIC',
    media_id: mediaId || undefined,
    link_url: linkUrl || undefined,
  })
}

/**
 * Upload an image for attaching to a post. With imageUrl (https, max 10MB)
 * the collector completes the upload server-side and the returned image_urn
 * is ready to pass as mediaId to publishPost.
 */
export async function uploadMedia(authFetch, { owner, imageUrl } = {}) {
  return callTool(authFetch, 'upload_media', {
    owner,
    image_url: imageUrl || undefined,
  })
}

export async function createComment(authFetch, { postUrn, actor, text }) {
  return callTool(authFetch, 'create_comment', { post_urn: postUrn, actor, text })
}

export async function getOrgInfo(authFetch, orgId) {
  return callTool(authFetch, 'get_org_info', { org_id: orgId })
}

/**
 * Classify a tool-call failure into an honest credential-health verdict.
 * Bridge-level messages mean the org has no usable vaulted token; provider
 * 401s mean the token exists but LinkedIn rejected it (expired/revoked).
 * Anything else is NOT a credential problem and must not be reported as one.
 */
function classifyFailure(message) {
  const msg = String(message || '')
  if (/no linkedin credentials|missing credential fields/i.test(msg)) {
    return { connected: false, reason: 'no_credential', error: msg }
  }
  if (/401|expired or invalid/i.test(msg)) {
    return { connected: false, reason: 'token_rejected', error: msg }
  }
  return { connected: false, reason: 'check_failed', error: msg }
}

/**
 * Org-scoped credential health. Drives a real tool through the org's own
 * vaulted credential — the old /connectors/status read was global pool stats
 * across ALL orgs and could never answer "is THIS org connected" (and
 * /connectors/linkedin/status never existed at all).
 *
 * Uses get_org_info when a LinkedIn org page is configured (its result is
 * returned as `orgInfo` so callers need not fetch it twice), else a 1-post
 * read for member-only setups. Each check is a real LinkedIn API call.
 */
export async function checkCredentialHealth(authFetch, { orgId, authorUrn } = {}) {
  try {
    if (orgId) {
      const orgInfo = await getOrgInfo(authFetch, orgId)
      return { connected: true, method: 'get_org_info', orgInfo }
    }
    if (authorUrn) {
      await getPosts(authFetch, authorUrn, 1)
      return { connected: true, method: 'get_posts' }
    }
    return { connected: false, reason: 'not_configured', error: 'No author URN or organisation ID configured' }
  } catch (err) {
    return classifyFailure(err.message)
  }
}

/**
 * Read the vaulted LinkedIn token's expiry (LI-OVERHAUL P5). Masked
 * credential metadata from the auth service — never the secret. Returns
 * { label, expiresAt, daysLeft } for the org's default (or only) linkedin
 * credential, or null when none exists or none carries an expiry.
 */
export async function getTokenExpiry(authFetch, quoxOrgId) {
  if (!quoxOrgId) return null
  const res = await authFetch(`/api/orgs/${encodeURIComponent(quoxOrgId)}/integrations?type=linkedin`)
  const data = await parseOrThrow(res, 'LinkedIn credential lookup')
  const creds = data.credentials || []
  const cred = creds.find((c) => c.is_default) || creds[0]
  if (!cred?.expires_at) return null
  const expiresAt = cred.expires_at
  const daysLeft = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000)
  return { label: cred.label, expiresAt, daysLeft }
}

/**
 * The org's governed LinkedIn write history (LI-OVERHAUL P11): every drafted
 * publish/comment with its human decision — awaiting_approval / published /
 * denied / failed — read from the approval store, no parallel bookkeeping.
 */
export async function getActivity(authFetch, { limit = 50 } = {}) {
  const res = await authFetch(`/collector/linkedin/activity?limit=${encodeURIComponent(limit)}`)
  const data = await parseOrThrow(res, 'LinkedIn activity')
  return data.items || []
}

const linkedinClient = {
  LINKEDIN_ROUTES,
  getTokenExpiry,
  getActivity,
  getPosts,
  getPost,
  getEngagement,
  getComments,
  publishPost,
  uploadMedia,
  createComment,
  getOrgInfo,
  checkCredentialHealth,
}

export default linkedinClient
