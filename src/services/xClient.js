/**
 * xClient — the X plugin's data layer. X-PLUGIN P3.
 *
 * Every function here calls a route that EXISTS in the collector today; the
 * anti-model is linkedinClient.js, whose routes never shipped and whose tests
 * mocked the whole hook so nobody noticed for six months. Two guards keep
 * this honest:
 *   1. X_ROUTES below is the single manifest of every route this client
 *      touches, with the exact server-side registration string for each.
 *   2. src/test/xClientRoutes.test.js greps the collector source for every
 *      one of those registration strings, and asserts this file fetches no
 *      path outside the manifest.
 *
 * Auth: all calls take `authFetch` from AuthContext (cookie + CSRF pattern,
 * same as browserQService.js). A bare fetch() 401s once the collector auth
 * gate is in enforce mode — never add one here.
 */

const TOOLS_API = '/collector/api/v1/tools/execute'
const VERIFY_API = '/collector/connectors/twitter/tools/verify_credentials/execute'
const USER_TWEETS_API = '/collector/connectors/twitter/tools/get_user_tweets/execute'
const MEDIA_API = '/collector/x/media'
const MEDIA_FILE_API = '/collector/x/media/file'
const ACTIVITY_API = '/collector/x/activity'
const ACCOUNT_API = '/collector/x/account'
const OVERVIEW_API = '/collector/x/overview'
const SETTINGS_API = '/collector/x/settings'
const SCHEDULE_API = '/collector/x/schedule'

/**
 * Route manifest — consumed by the route-existence guard test. `registered`
 * lists literal strings that must appear in the named collector source file
 * for the route to exist. Keep in lockstep with the constants above.
 */
export const X_ROUTES = [
  {
    method: 'POST',
    path: TOOLS_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.post('/api/v1/tools/execute'"],
  },
  {
    method: 'POST',
    path: VERIFY_API,
    serverFile: 'services/collector/server.js',
    // Generic connector execute route; the twitter connector + its
    // verify_credentials tool are asserted separately by the guard test.
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    method: 'POST',
    path: USER_TWEETS_API,
    serverFile: 'services/collector/server.js',
    // Same generic connector execute route as VERIFY_API; the twitter
    // connector's get_user_tweets tool is asserted separately below.
    registered: ["app.post('/connectors/:connectorId/tools/:toolName/execute'"],
  },
  {
    method: 'GET',
    path: MEDIA_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/media'"],
  },
  {
    // X-PLUGIN phase 13: the bytes behind a filename, for the Compose media
    // library's thumbnails. Org-scoped and containment-checked server-side,
    // exactly like the listing it pairs with.
    method: 'GET',
    path: MEDIA_FILE_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/media/file'"],
  },
  {
    method: 'GET',
    path: ACTIVITY_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/activity'"],
  },
  {
    method: 'GET',
    path: ACCOUNT_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/account'"],
  },
  {
    method: 'POST',
    path: MEDIA_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.post('/media'"],
  },
  {
    method: 'GET',
    path: OVERVIEW_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/overview'"],
  },
  {
    method: 'GET',
    path: SETTINGS_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/settings'"],
  },
  {
    method: 'PUT',
    path: SETTINGS_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.put('/settings'"],
  },
  {
    method: 'POST',
    path: SCHEDULE_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.post('/schedule'"],
  },
  {
    method: 'GET',
    path: SCHEDULE_API,
    serverFile: 'services/collector/server.js',
    registered: ["app.use('/x'"],
    routerFile: 'services/collector/routes/xRoutes.js',
    routerRegistered: ["router.get('/schedule'"],
  },
  {
    // The approval decision path, on the AUTH service rather than the
    // collector. Compose's "approve and post now" drives THIS, the same
    // endpoint the inbox's own Post button drives, so there is exactly one
    // publish path in the product. Templated per org and item, so it has no
    // path constant for the manifest guard to compare; the registration check
    // below is what proves it still exists.
    method: 'POST',
    path: '/api/orgs/:orgId/inbox/:itemId/respond',
    templated: true,
    serverFile: 'services/auth/routes/inbox.js',
    registered: ["'/orgs/:orgId/inbox/:itemId/respond'"],
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
      // Not JSON: an infrastructure layer (nginx, a proxy) answered before
      // the app did. Raw HTML in an error banner is noise; say what happened
      // instead. The owner hit exactly this as a full nginx 413 page.
      if (/<html/i.test(text)) {
        detail = res.status === 413
          ? 'the file was refused by the server proxy before it reached the app (larger than the proxy accepts)'
          : `the server proxy answered with an error page instead of the app (HTTP ${res.status})`
      }
    }
    throw new Error(`${what} failed (${res.status}): ${detail}`)
  }
  return res.json()
}

async function execTool(authFetch, toolName, input = {}) {
  const res = await authFetch(TOOLS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_name: toolName, input, agent_id: 'xtwitter' }),
  })
  return parseOrThrow(res, `Tool ${toolName}`)
}

/**
 * Live credential check via the twitter connector (vault OAuth 1.0a quad).
 * Resolves to { success, result: { id, username, name } } on a valid quad,
 * or { success: false, error } when credentials are missing/invalid.
 */
export async function verifyCredentials(authFetch) {
  const res = await authFetch(VERIFY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  })
  return parseOrThrow(res, 'verify_credentials')
}

/**
 * Budget via the native gated tool. Tool-shape response:
 * { success, daily_used, daily_limit, monthly_used, monthly_limit, org_id }.
 */
export function getBudgetStatus(authFetch) {
  return execTool(authFetch, 'x_budget_status', {})
}

/**
 * Read the connected account's recent posts (X-PLUGIN P5 engagement panel).
 * Each call spends the org's pay-per-use X read budget (see xPostingStore.js
 * CONFIG.dailyReadLimit) — this is NOT free, and this function never runs on
 * a timer; every call here must originate from an explicit user click.
 * Resolves to { user_id, tweets: [{ id, text, created_at, public_metrics }] }
 * on success. On budget exhaustion or an expired/invalid token the collector
 * returns a non-2xx and this throws — callers must render that as an honest
 * error state, never silently swallow it into an empty list.
 * @param {object} opts - { maxResults?: number } (1-20, default 10)
 */
export function getUserTweets(authFetch, { maxResults = 10 } = {}) {
  return authFetch(USER_TWEETS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { max_results: maxResults } }),
  }).then((res) => parseOrThrow(res, 'get_user_tweets'))
}

/**
 * Draft a single post — files a HITL approval card, never posts directly.
 * Resolves to { success, status: 'awaiting_approval', inbox_item_id, message }.
 * @param {object} opts - { text, imagePaths?: string[], replyToTweetId?: string }
 */
export function draftPost(authFetch, { text, imagePaths, images, replyToTweetId, quote_tweet_id, poll, reply_settings } = {}) {
  const input = { text }
  if (Array.isArray(imagePaths) && imagePaths.length) input.image_paths = imagePaths
  // Phase 10 slice A: {path, alt_text} objects are the alternative to
  // image_paths; the tool refuses both at once, so the caller sends one.
  if (Array.isArray(images) && images.length) input.images = images
  if (replyToTweetId) input.reply_to_tweet_id = replyToTweetId
  if (quote_tweet_id) input.quote_tweet_id = quote_tweet_id
  if (poll) input.poll = poll
  if (reply_settings) input.reply_settings = reply_settings
  return execTool(authFetch, 'x_post', input)
}

/**
 * Draft a thread — same HITL contract as draftPost.
 * @param {object} opts - { posts: Array<{ text, imagePaths?: string[] }> }
 */
export function draftThread(authFetch, { posts } = {}) {
  const input = {
    posts: (posts || []).map((p) => {
      const item = { text: p.text }
      if (Array.isArray(p.imagePaths) && p.imagePaths.length) item.image_paths = p.imagePaths
      if (Array.isArray(p.images) && p.images.length) item.images = p.images
      if (p.quote_tweet_id) item.quote_tweet_id = p.quote_tweet_id
      if (p.poll) item.poll = p.poll
      if (p.reply_settings) item.reply_settings = p.reply_settings
      return item
    }),
  }
  return execTool(authFetch, 'x_thread', input)
}

/**
 * List the org's uploaded media (compose image picker). File names are
 * RELATIVE to the org media root — pass them straight to draftPost imagePaths.
 * Resolves to { success, org_id, files: [{ name, size, modified_at }] }.
 */
export async function listMedia(authFetch) {
  const res = await authFetch(MEDIA_API, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/media')
}

/**
 * The BYTES behind one of those filenames, as an object URL. X-PLUGIN phase 13,
 * for the Compose media library's thumbnail grid.
 *
 * A plain <img src="/collector/x/media/file?name=..."> cannot carry the auth
 * the collector requires, so the image is fetched here through authFetch like
 * every other call and handed to the caller as a blob URL. The caller OWNS
 * that URL and must revokeObjectURL it when the thumbnail unmounts, or a
 * long-lived compose session leaks a blob per image it has ever previewed.
 *
 * Rejects on a non-2xx, and never parses an error body as an image: a JSON
 * refusal rendered as a broken thumbnail is exactly the "an error body is not
 * data" failure the house rules name.
 *
 * @returns {Promise<string>} an object URL for the image
 */
export async function fetchMediaObjectUrl(authFetch, name, orgId) {
  // #605: an approval card's media lives under the org that FILED it, which can
  // differ from the viewer's active org. Pass that org so the collector can
  // serve it (it membership-gates the cross-org read server-side). Omitted for
  // the Compose picker, which reads the viewer's own active-org media.
  const query = orgId
    ? `name=${encodeURIComponent(name)}&org_id=${encodeURIComponent(orgId)}`
    : `name=${encodeURIComponent(name)}`
  const res = await authFetch(`${MEDIA_FILE_API}?${query}`, { method: 'GET' })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) detail = body.error
    } catch { /* keep the status */ }
    throw new Error(`GET /x/media/file failed: ${detail}`)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/**
 * Recent claims + published ledger + full budget (camelCase store shape,
 * incl. dailyRemaining/monthlyRemaining, unlike the x_budget_status tool).
 * Resolves to { success, org_id, claims, ledger, budget }.
 */
export async function listActivity(authFetch, { limit = 20 } = {}) {
  const res = await authFetch(`${ACTIVITY_API}?limit=${encodeURIComponent(limit)}`, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/activity')
}

/**
 * Who is this org connected to X as, and is a credential configured?
 *
 * FREE — this never touches api.x.com. The handle comes from the collector's
 * x_account cache (written the last time verify_credentials succeeded) and the
 * configured flag from a vault lookup. This is the call the view makes on
 * mount; verifyCredentials() is the paid one and only ever runs on a click.
 *
 * Resolves to { success, org_id, account: { username, name, userId,
 * verifiedAt } | null, credential: { configured, label, error } }.
 * account === null means "never verified yet", NOT "not connected".
 */
export async function getAccount(authFetch) {
  const res = await authFetch(ACCOUNT_API, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/account')
}

/**
 * Approve (or deny) an inbox item — X-PLUGIN phase 11.
 *
 * ARCHITECTURE RULE, load-bearing: compose's "approve and post now" mints the
 * approval card through x_post/x_thread exactly as "save as draft" does, and
 * then drives THIS endpoint, which is the same one the inbox's own Post button
 * drives. There is therefore exactly ONE publish path in the product.
 *
 * A second, card-skipping write path would look like a convenience and would
 * quietly cost the budget claim, the replay guard, the credential binding and
 * the AEE evidence, because all four live on the decide path, not on the tool
 * that files the draft. Never add one.
 *
 * @param {string} orgId
 * @param {string} itemId - the inbox_item_id x_post returned
 * @param {{ action?: string, comment?: string }} [opts] - action defaults to
 *   'approved'; pass 'denied' to discard.
 */
export async function respondToInboxItem(authFetch, orgId, itemId, { action = 'approved', comment = '' } = {}) {
  if (!orgId) throw new Error('An organisation is required to approve an X post')
  if (!itemId) throw new Error('No approval card to act on')
  const res = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/inbox/${encodeURIComponent(itemId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, comment }),
  })
  return parseOrThrow(res, `inbox respond (${action})`)
}

/**
 * Schedule an APPROVED post to publish later (X-PLUGIN phase 12).
 *
 * Owner decision 2026-09-12: "approve then schedule! trigger time is not
 * delayed". The approver's tap at compose time IS the approval. The chosen
 * time delays only the publish. There is no second tap and no fresh card at
 * fire time.
 *
 * The caller must have minted the approval card first (x_post / x_thread);
 * this records the human's approve decision against that card together with
 * the publish time, and the collector-side scheduler fires it through the SAME
 * machinery the decide endpoint drives.
 *
 * SCOPE: server-side this is requireHumanAdmin, so a service key and an
 * agent-operated session are both refused. An agent cannot pre-authorise its
 * own future publish; agent-initiated posting keeps full HITL.
 *
 * @param {{ inboxItemId: string, action: string, actionParams: object, scheduledPublishAt: string }} opts
 */
export async function scheduleApprovedPublish(authFetch, { inboxItemId, action, actionParams, scheduledPublishAt } = {}) {
  const res = await authFetch(SCHEDULE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inbox_item_id: inboxItemId,
      action,
      action_params: actionParams,
      scheduled_publish_at: scheduledPublishAt,
    }),
  })
  return parseOrThrow(res, 'POST /x/schedule')
}

/** Everything this org has queued to publish, newest intent first. Free. */
export async function listScheduled(authFetch, { pendingOnly = false } = {}) {
  const res = await authFetch(`${SCHEDULE_API}${pendingOnly ? '?pending=true' : ''}`, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/schedule')
}

/**
 * Stop a pending scheduled publish before it fires, and hand its reserved
 * budget slot back. Only works while it is still pending: one already firing
 * may have reached X, and one already published certainly has, so neither can
 * be cancelled into a state implying nothing happened.
 */
export async function cancelScheduledPublish(authFetch, inboxItemId) {
  const res = await authFetch(`${SCHEDULE_API}/${encodeURIComponent(inboxItemId)}/cancel`, { method: 'POST' })
  return parseOrThrow(res, 'POST /x/schedule/:id/cancel')
}

/**
 * Upload one image into the org's X media root (X-PLUGIN phase 11).
 *
 * FREE — this is the collector's own filesystem, not X. The image is not sent
 * to X until a post that attaches it is APPROVED; uploading is staging, never
 * publishing.
 *
 * Deliberately does NOT set Content-Type: the browser must set it itself so
 * the multipart boundary is included. Setting it by hand is the classic way to
 * make a multipart POST arrive unparseable.
 *
 * Resolves to { success, org_id, file: { name, size, content_type,
 * modified_at } }. `name` is relative to the org media root, which is exactly
 * what draftPost's imagePaths expects.
 *
 * @param {File|Blob} file
 */
export async function uploadMedia(authFetch, file) {
  const form = new FormData()
  form.append('file', file)
  const res = await authFetch(MEDIA_API, { method: 'POST', body: form })
  return parseOrThrow(res, 'POST /x/media')
}

/**
 * The Overview tab's stats (X-PLUGIN phase 11). FREE and required to stay
 * free: this runs on mount, so a paid X call in here would bill the org for
 * opening a page. Everything comes from the collector's own ledgers.
 *
 * Resolves to { success, org_id, account, budget, reads, poll, totals,
 * sparkline: [{ day, posts }], recent }.
 */
export async function getOverview(authFetch) {
  const res = await authFetch(OVERVIEW_API, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/overview')
}

/**
 * The org's X limits and polling settings, with the capability metadata the
 * editor needs (type, min, max, allowedValues) and `can_edit` telling the UI
 * whether this caller may change them. Readable by any member.
 */
export async function getSettings(authFetch) {
  const res = await authFetch(SETTINGS_API, { method: 'GET' })
  return parseOrThrow(res, 'GET /x/settings')
}

/**
 * Change one or more X settings. ADMIN ONLY server-side (owner/admin) — a
 * non-admin gets a 403, which this throws rather than swallowing. The whole
 * batch is applied in one transaction, so a rejected value leaves nothing
 * changed.
 *
 * @param {object} updates - e.g. { X_DAILY_POST_LIMIT: 40 }
 */
export async function saveSettings(authFetch, updates) {
  const res = await authFetch(SETTINGS_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates || {}),
  })
  return parseOrThrow(res, 'PUT /x/settings')
}

export default {
  X_ROUTES,
  verifyCredentials,
  getAccount,
  getOverview,
  getSettings,
  saveSettings,
  uploadMedia,
  respondToInboxItem,
  scheduleApprovedPublish,
  listScheduled,
  cancelScheduledPublish,
  getBudgetStatus,
  getUserTweets,
  draftPost,
  draftThread,
  listMedia,
  fetchMediaObjectUrl,
  listActivity,
}
