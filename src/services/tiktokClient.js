/**
 * tiktokClient — the TikTok plugin's data layer. TT-4, mirrors
 * src/services/instagramClient.js in shape (route manifest + guard test,
 * pending-as-data contract, org-scoped credential health), but TikTok has
 * its OWN vault credential type ('tiktok'), not a shared Meta one.
 *
 * Two hard external truths this client's health check exists to surface:
 *  1. An unaudited TikTok app is restricted to private (SELF_ONLY) content
 *     until TikTok approves the app audit. That is a TikTok-side gate, not
 *     a bug here.
 *  2. TikTok access tokens live exactly 24 HOURS and there is no auto-refresh
 *     built yet (separate stream, YT-O-2) — getTokenExpiry reports hours
 *     left, not days, and a 401 is classified as token_rejected with the
 *     24h lifetime named as the likely cause.
 *
 * Auth: all calls take `authFetch` from AuthContext (cookie + CSRF pattern).
 * A bare fetch() 401s at the collector auth gate before routing — never add
 * one here. Tokens never appear in client code or tool inputs; the
 * collector's connector bridge resolves the org's vaulted 'tiktok'
 * credential server-side (see services/collector/lib/connectors/types/tiktok.js).
 */

// The one registered way to drive tiktok_* connector tools from the UI.
// Server side: executeConnectorTool (services/collector/lib/connectors/bridge.js)
// resolves the org's vaulted access_token and dispatches to the tool.
const EXECUTE_API = (toolName) => `/collector/connectors/tiktok/tools/${toolName}/execute`

/**
 * Route manifest — consumed by the route-existence guard test. `registered`
 * lists literal strings that must appear in the named collector source file
 * for the route to exist.
 */
export const TIKTOK_ROUTES = [
  {
    method: 'POST',
    path: '/collector/connectors/tiktok/tools/:toolName/execute',
    templated: true,
    serverFile: 'services/collector/server.js',
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    // Token-expiry read — AUTH service, not collector: the vault owns
    // credential metadata. Returns masked rows only, never secrets. TikTok's
    // OWN credential type, not the shared 'meta' one facebook/instagram use.
    method: 'GET',
    path: '/api/orgs/:orgId/integrations?type=tiktok',
    templated: true,
    serverFile: 'services/auth/routes/integrations.js',
    registered: ["router.get('/orgs/:orgId/integrations'"],
  },
  {
    // Activity ledger (TT-4) — the org's governed write history straight
    // from the approval store; the card trail IS the ledger.
    method: 'GET',
    path: '/collector/tiktok/activity',
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/tiktok'"],
    routerFile: 'services/collector/routes/tiktokRoutes.js',
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
  const data = await parseOrThrow(res, `TikTok tool ${toolName}`)
  if (data.pending) {
    // Gated write (publish_video / upload_draft): the bridge filed a human
    // approval card and nothing published. NOT an error — callers render
    // "awaiting approval".
    return {
      pending: true,
      status: 'awaiting_approval',
      approvalId: data.approvalId,
      inboxItemId: data.inbox_item_id || null,
      message: data.message,
    }
  }
  if (!data.success) {
    throw new Error(data.error || `TikTok tool ${toolName} returned failure`)
  }
  return data.result
}

export async function getProfile(authFetch) {
  return callTool(authFetch, 'get_profile', {})
}

export async function listVideos(authFetch, maxCount = 10) {
  return callTool(authFetch, 'list_videos', { max_count: maxCount })
}

export async function getVideoStats(authFetch, videoIds) {
  return callTool(authFetch, 'get_video_stats', { video_ids: videoIds })
}

export async function getPublishStatus(authFetch, publishId) {
  return callTool(authFetch, 'get_publish_status', { publish_id: publishId })
}

export async function publishVideo(authFetch, { title, videoPath, privacyLevel, disableDuet, disableComment, disableStitch }) {
  return callTool(authFetch, 'publish_video', {
    title,
    video_path: videoPath,
    privacy_level: privacyLevel || undefined,
    disable_duet: disableDuet || undefined,
    disable_comment: disableComment || undefined,
    disable_stitch: disableStitch || undefined,
  })
}

export async function uploadDraft(authFetch, { title, videoPath }) {
  return callTool(authFetch, 'upload_draft', {
    title: title || undefined,
    video_path: videoPath,
  })
}

/**
 * Classify a tool-call failure into an honest credential-health verdict.
 * Bridge-level messages mean the org has no usable vaulted token; a 401
 * means TikTok rejected the access token, which for TikTok specifically is
 * MOST LIKELY the 24h token lifetime expiring (no auto-refresh yet), so the
 * message names that as the likely cause rather than a generic "invalid".
 */
function classifyFailure(message) {
  const msg = String(message || '')
  if (/no tiktok credentials|missing credential fields/i.test(msg)) {
    return { connected: false, reason: 'no_credential', error: msg }
  }
  if (/401|expired or invalid/i.test(msg)) {
    return {
      connected: false,
      reason: 'token_rejected',
      error: `${msg} TikTok access tokens live 24 hours with no auto-refresh built yet, so this is most likely a normal expiry, not a broken credential. Rotate the access_token in the vault.`,
    }
  }
  return { connected: false, reason: 'check_failed', error: msg }
}

/**
 * Org-scoped credential health. get_profile is the cheapest live probe: it
 * proves the vaulted access token still works.
 */
export async function checkCredentialHealth(authFetch) {
  try {
    const profile = await getProfile(authFetch)
    return { connected: true, method: 'get_profile', profile }
  } catch (err) {
    return classifyFailure(err.message)
  }
}

/**
 * Read the vaulted TikTok token's expiry, in HOURS not days: TikTok access
 * tokens live exactly 24 hours (tokenLifetimeDays: 1 in
 * integrationTypeRegistry.js), so a days-left figure would round a
 * same-day expiry down to "0 days" and read as far more alarming or far
 * more comfortable than it is. Masked credential metadata from the auth
 * service, never the secret. Returns { label, expiresAt, hoursLeft } for
 * the org's default (or only) tiktok credential, or null when none exists
 * or none carries an expiry.
 */
export async function getTokenExpiry(authFetch, quoxOrgId) {
  if (!quoxOrgId) return null
  const res = await authFetch(`/api/orgs/${encodeURIComponent(quoxOrgId)}/integrations?type=tiktok`)
  const data = await parseOrThrow(res, 'TikTok credential lookup')
  const creds = data.credentials || []
  const cred = creds.find((c) => c.is_default) || creds[0]
  if (!cred?.expires_at) return null
  const expiresAt = cred.expires_at
  const hoursLeft = Math.round((new Date(expiresAt) - Date.now()) / 3600000)
  return { label: cred.label, expiresAt, hoursLeft }
}

/**
 * The org's governed TikTok write history: every drafted publish_video or
 * upload_draft with its human decision — awaiting_approval / published /
 * denied / failed — read from the approval store, no parallel bookkeeping.
 */
export async function getActivity(authFetch, { limit = 50 } = {}) {
  const res = await authFetch(`/collector/tiktok/activity?limit=${encodeURIComponent(limit)}`)
  const data = await parseOrThrow(res, 'TikTok activity')
  return data.items || []
}

const tiktokClient = {
  TIKTOK_ROUTES,
  getTokenExpiry,
  getActivity,
  getProfile,
  listVideos,
  getVideoStats,
  getPublishStatus,
  publishVideo,
  uploadDraft,
  checkCredentialHealth,
}

export default tiktokClient
