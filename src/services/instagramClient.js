/**
 * instagramClient — the Instagram plugin's data layer. IG-3, mirrors
 * src/services/facebookClient.js exactly.
 *
 * Instagram is its own plugin SKU on the SHARED Meta foundation: the org's
 * Instagram professional account is reached through its linked Facebook
 * Page, using the SAME vaulted 'meta' credential the facebook plugin uses.
 * There is no separate credential to paste. Auth: all calls take
 * `authFetch` from AuthContext (cookie + CSRF pattern). A bare fetch() 401s
 * at the collector auth gate before routing — never add one here. Tokens
 * never appear in client code or tool inputs; the collector's connector
 * bridge resolves the org's vaulted 'meta' credential server-side (see
 * services/collector/lib/connectors/types/instagram.js).
 */

// The one registered way to drive instagram_* connector tools from the UI.
// Server side: executeConnectorTool (services/collector/lib/connectors/bridge.js)
// resolves the org's vaulted access_token and dispatches to the tool.
const EXECUTE_API = (toolName) => `/collector/connectors/instagram/tools/${toolName}/execute`

/**
 * Route manifest — consumed by the route-existence guard test. `registered`
 * lists literal strings that must appear in the named collector source file
 * for the route to exist.
 */
export const INSTAGRAM_ROUTES = [
  {
    method: 'POST',
    path: '/collector/connectors/instagram/tools/:toolName/execute',
    templated: true,
    serverFile: 'services/collector/server.js',
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    // Token-expiry read — AUTH service, not collector: the vault owns
    // credential metadata. Returns masked rows only, never secrets. Same
    // 'meta' credential type the facebook plugin reads: one pasted token
    // powers both plugins.
    method: 'GET',
    path: '/api/orgs/:orgId/integrations?type=meta',
    templated: true,
    serverFile: 'services/auth/routes/integrations.js',
    registered: ["router.get('/orgs/:orgId/integrations'"],
  },
  {
    // Activity ledger (IG-3) — the org's governed write history straight
    // from the approval store; the card trail IS the ledger.
    method: 'GET',
    path: '/collector/instagram/activity',
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/instagram'"],
    routerFile: 'services/collector/routes/instagramRoutes.js',
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
  const data = await parseOrThrow(res, `Instagram tool ${toolName}`)
  if (data.pending) {
    // Gated write (publish_media / reply_comment): the bridge filed a human
    // approval card and nothing published. NOT an error — callers render
    // "awaiting approval", the same contract facebookClient's writes return.
    return {
      pending: true,
      status: 'awaiting_approval',
      approvalId: data.approvalId,
      inboxItemId: data.inbox_item_id || null,
      message: data.message,
    }
  }
  if (!data.success) {
    throw new Error(data.error || `Instagram tool ${toolName} returned failure`)
  }
  return data.result
}

export async function discoverAccount(authFetch, pageId) {
  return callTool(authFetch, 'discover_account', { page_id: pageId || undefined })
}

export async function getAccount(authFetch, igUserId) {
  return callTool(authFetch, 'get_account', { ig_user_id: igUserId })
}

export async function listMedia(authFetch, igUserId, limit = 10) {
  return callTool(authFetch, 'list_media', { ig_user_id: igUserId, limit })
}

export async function getMediaInsights(authFetch, mediaId, metrics) {
  return callTool(authFetch, 'get_media_insights', { media_id: mediaId, metrics: metrics || undefined })
}

export async function getAccountInsights(authFetch, igUserId, { metrics, period } = {}) {
  return callTool(authFetch, 'get_account_insights', {
    ig_user_id: igUserId,
    metrics: metrics || undefined,
    period: period || undefined,
  })
}

export async function getComments(authFetch, mediaId, limit = 25) {
  return callTool(authFetch, 'get_comments', { media_id: mediaId, limit })
}

export async function getPublishingLimit(authFetch, igUserId) {
  return callTool(authFetch, 'get_publishing_limit', { ig_user_id: igUserId })
}

export async function publishMedia(authFetch, { igUserId, caption, imageUrl, videoUrl, mediaType }) {
  return callTool(authFetch, 'publish_media', {
    ig_user_id: igUserId,
    caption: caption || undefined,
    image_url: imageUrl || undefined,
    video_url: videoUrl || undefined,
    media_type: mediaType || undefined,
  })
}

export async function replyComment(authFetch, commentId, message) {
  return callTool(authFetch, 'reply_comment', { comment_id: commentId, message })
}

/**
 * Classify a tool-call failure into an honest credential-health verdict.
 * Bridge-level messages mean the org has no usable vaulted token; provider
 * 401s mean the token exists but Meta rejected it; a discover_account probe
 * with no linked Instagram account is a REAL distinct state (the Page
 * exists and the token works, but no professional Instagram account is
 * linked to it) and must never be reported as a credential problem.
 */
function classifyFailure(message) {
  const msg = String(message || '')
  if (/no instagram credentials|missing credential fields/i.test(msg)) {
    return { connected: false, reason: 'no_credential', error: msg }
  }
  if (/401|expired or invalid/i.test(msg)) {
    return { connected: false, reason: 'token_rejected', error: msg }
  }
  if (/no instagram professional account is linked/i.test(msg)) {
    return { connected: false, reason: 'no_ig_linked', error: msg }
  }
  return { connected: false, reason: 'check_failed', error: msg }
}

/**
 * Org-scoped credential health. discover_account is the cheap probe: it
 * proves the shared meta token works AND resolves the linked Instagram
 * account in one call. Honest four-way verdict: connected, no_credential,
 * token_rejected, or no_ig_linked (Page/token fine, nothing linked).
 */
export async function checkCredentialHealth(authFetch, { pageId } = {}) {
  try {
    const account = await discoverAccount(authFetch, pageId)
    return { connected: true, method: 'discover_account', account }
  } catch (err) {
    return classifyFailure(err.message)
  }
}

/**
 * Read the vaulted Instagram (meta) token's expiry. This is the SAME vault
 * credential the facebook plugin reads — one pasted token powers both
 * plugins. Masked credential metadata from the auth service — never the
 * secret. Returns { label, expiresAt, daysLeft } for the org's default (or
 * only) meta credential, or null when none exists or none carries an expiry.
 */
export async function getTokenExpiry(authFetch, quoxOrgId) {
  if (!quoxOrgId) return null
  const res = await authFetch(`/api/orgs/${encodeURIComponent(quoxOrgId)}/integrations?type=meta`)
  const data = await parseOrThrow(res, 'Instagram credential lookup')
  const creds = data.credentials || []
  const cred = creds.find((c) => c.is_default) || creds[0]
  if (!cred?.expires_at) return null
  const expiresAt = cred.expires_at
  const daysLeft = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000)
  return { label: cred.label, expiresAt, daysLeft }
}

/**
 * The org's governed Instagram write history: every drafted publish_media
 * or reply_comment with its human decision — awaiting_approval / published /
 * denied / failed — read from the approval store, no parallel bookkeeping.
 */
export async function getActivity(authFetch, { limit = 50 } = {}) {
  const res = await authFetch(`/collector/instagram/activity?limit=${encodeURIComponent(limit)}`)
  const data = await parseOrThrow(res, 'Instagram activity')
  return data.items || []
}

const instagramClient = {
  INSTAGRAM_ROUTES,
  getTokenExpiry,
  getActivity,
  discoverAccount,
  getAccount,
  listMedia,
  getMediaInsights,
  getAccountInsights,
  getComments,
  getPublishingLimit,
  publishMedia,
  replyComment,
  checkCredentialHealth,
}

export default instagramClient
