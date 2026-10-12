/**
 * GitHub Client Service — Phase R1 + R2
 *
 * All GitHub API calls are proxied through the collector at /collector/github/*.
 * The PAT never reaches the browser. Config (selected repos, org, policies)
 * stays in localStorage — these are preferences, not secrets.
 *
 * R2: Config is now org-scoped. Switching Quox orgs shows different GitHub configs.
 * Key pattern: quox-github-${orgId} (falls back to legacy key if no orgId set).
 */

const LEGACY_STORAGE_KEY = 'quox-plugin-github-config'
const COLLECTOR_BASE = '/collector/github'

// Current org context — set by setOrgContext()
let _currentOrgId = null

/**
 * Set the org context for org-scoped config keys.
 * Called by GitHubPanel when it receives orgId from WorkspaceContext.
 */
export function setOrgContext(orgId) {
  _currentOrgId = orgId
}

/**
 * Get the storage key for the current org.
 * Falls back to legacy key if no org is set (backward compat).
 */
function getStorageKey() {
  if (_currentOrgId) return `quox-github-${_currentOrgId}`
  return LEGACY_STORAGE_KEY
}

// ─── Internal Fetch Helper ──────────────────────────────────────────

// Token expiry flag — set when any API call returns 401
let _tokenExpired = false

/**
 * Check whether the GitHub token has been flagged as expired.
 */
export function isTokenExpired() {
  return _tokenExpired
}

/**
 * Clear the token-expired flag (e.g. after reconnecting).
 */
export function clearTokenExpired() {
  _tokenExpired = false
}

async function proxyFetch(path, options = {}) {
  const url = `${COLLECTOR_BASE}${path}`
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    credentials: 'include', // send auth cookie
  })

  if (!resp.ok) {
    if (resp.status === 401) {
      _tokenExpired = true
    }
    const body = await resp.json().catch(() => ({}))
    const msg = body.error || body.message || resp.statusText
    throw new Error(`GitHub proxy ${resp.status}: ${msg}`)
  }

  if (resp.status === 204) return null
  return resp.json()
}

// ─── Config (localStorage — preferences only, no secrets) ───────────

/**
 * Read GitHub plugin configuration from localStorage.
 * Contains: orgName, selectedRepos, connectedAt, policies.
 * Does NOT contain the GitHub token (stored server-side since R1).
 */
export function getConfig() {
  try {
    const stored = localStorage.getItem(getStorageKey())
    if (!stored) return null
    return JSON.parse(stored)
  } catch (err) {
    console.error('[GitHubClient] Failed to read config:', err)
    return null
  }
}

/**
 * Save GitHub plugin configuration to localStorage.
 */
export function saveConfig(config) {
  try {
    // Strip token if accidentally included — it belongs server-side
    const clean = { ...config }
    delete clean.githubToken
    localStorage.setItem(getStorageKey(), JSON.stringify(clean))
    return true
  } catch (err) {
    console.error('[GitHubClient] Failed to save config:', err)
    return false
  }
}

/**
 * Get current connection status.
 * Checks localStorage config + server-side token status.
 */
export function getConnectionStatus() {
  const config = getConfig()
  if (!config || !config.orgName || !config.selectedRepos?.length) {
    return { connected: false }
  }
  return {
    connected: true,
    org: config.orgName || null,
    repoCount: config.selectedRepos?.length || 0,
  }
}

/**
 * Check if the server has a GitHub token configured.
 */
export async function checkServerStatus() {
  try {
    return await proxyFetch('/status')
  } catch {
    return { configured: false, source: 'none' }
  }
}

// ─── Connection & Setup ─────────────────────────────────────────────

/**
 * Test a GitHub token via the collector proxy.
 * The collector validates it and stores it server-side.
 * @param {string} token - GitHub PAT to test and store
 */
export async function testConnection(token) {
  return proxyFetch('/test-connection', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

/**
 * Fetch organisations (token already stored server-side).
 */
export async function fetchOrgs() {
  return proxyFetch('/orgs')
}

/**
 * Fetch repos for an organisation.
 * @param {string} _token - Ignored (kept for API compat, token is server-side)
 * @param {string} org - Organisation name
 */
export async function fetchRepos(_token, org) {
  return proxyFetch(`/repos/${encodeURIComponent(org)}`)
}

// ─── Issues ─────────────────────────────────────────────────────────

/**
 * Fetch issues across all tracked repos, merged and sorted by updated_at desc.
 */
export async function fetchIssues(options = {}) {
  const config = getConfig()
  if (!config?.selectedRepos?.length) {
    throw new Error('No repos configured. Complete setup first.')
  }

  const { state = 'open', labels, search, page = 1, per_page = 30 } = options
  const params = new URLSearchParams({
    repos: config.selectedRepos.join(','),
    org: config.orgName,
    state,
    page: String(page),
    per_page: String(per_page),
  })
  if (labels) params.set('labels', labels)
  if (search) params.set('search', search)

  const result = await proxyFetch(`/issues?${params}`)
  // Return flat array for backward compat with GitHubPanel
  return result.issues || []
}

/**
 * Fetch a single issue with full details and comments.
 */
export async function fetchIssue(owner, repo, number) {
  const result = await proxyFetch(`/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`)
  return result.issue
}

/**
 * Fetch comments for an issue.
 */
export async function fetchIssueComments(owner, repo, number) {
  const result = await proxyFetch(`/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`)
  return result.comments || []
}

/**
 * Create a new issue.
 */
export async function createIssue(owner, repo, { title, body, labels }) {
  const result = await proxyFetch('/issues', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, title, body, labels }),
  })
  return result.issue
}

/**
 * Create an issue and return the FULL governed response (not just .issue), so
 * callers can tell a filed issue ({ issue }) from one held for human approval
 * ({ pending: true }, HTTP 202). Used by the Gripe page, which must never claim
 * "filed" without an issue URL.
 */
export async function createIssueGoverned(owner, repo, { title, body, labels }) {
  return proxyFetch('/issues', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, title, body, labels }),
  })
}

/**
 * Update an existing issue.
 * Returns the full response object (not just .issue) so callers can check for policy_blocked.
 */
export async function updateIssue(owner, repo, number, { state, labels, assignees, override_reason }) {
  const payload = {}
  if (state !== undefined) payload.state = state
  if (labels !== undefined) payload.labels = labels
  if (assignees !== undefined) payload.assignees = assignees
  if (override_reason !== undefined) payload.override_reason = override_reason
  const result = await proxyFetch(`/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return result
}

/**
 * Add a comment to an issue.
 */
export async function addComment(owner, repo, number, body) {
  const result = await proxyFetch(`/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  return result.comment
}

// ─── Pull Requests ──────────────────────────────────────────────────

/**
 * Fetch pull requests across tracked repos.
 */
export async function fetchPRs(owner, repo, state = 'open') {
  const config = getConfig()
  // If called with specific owner/repo, use those; otherwise use config
  const repos = repo ? repo : (config?.selectedRepos?.join(',') || '')
  const org = owner || config?.orgName || ''

  const result = await proxyFetch(`/prs?repos=${encodeURIComponent(repos)}&org=${encodeURIComponent(org)}&state=${state}`)
  return result.prs || []
}

// ─── Releases ───────────────────────────────────────────────────────

/**
 * Fetch releases across tracked repos.
 */
export async function fetchReleases(owner, repo) {
  const config = getConfig()
  const repos = repo || (config?.selectedRepos?.join(',') || '')
  const org = owner || config?.orgName || ''

  const result = await proxyFetch(`/releases?repos=${encodeURIComponent(repos)}&org=${encodeURIComponent(org)}&per_page=10`)
  return result.releases || []
}

/**
 * Fetch milestones for a repo.
 * Note: Not yet proxied — returns empty array. Will be added in R2.
 */
export async function fetchMilestones(owner, repo, state = 'open') {
  // TODO: Add /github/milestones proxy endpoint in R2
  console.warn('[GitHubClient] fetchMilestones not yet proxied (R2)')
  return []
}

/**
 * Create a release.
 * Returns the full response object so callers can check for policy_blocked.
 */
export async function createRelease(owner, repo, { tag_name, name, body, draft, prerelease, checklist_confirmed }) {
  const result = await proxyFetch('/releases', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, tag_name, name, body, draft, prerelease, checklist_confirmed }),
  })
  return result
}

/**
 * Generate release notes using GitHub's built-in generator.
 */
export async function generateReleaseNotes(owner, repo, { tag_name, previous_tag_name }) {
  return proxyFetch('/releases/generate-notes', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, tag_name, previous_tag_name }),
  })
}

// ─── Rate Limit (now server-side — this is a no-op stub) ────────────

/**
 * Rate limit info is now managed server-side.
 * This stub exists for backward compat.
 */
export function getRateLimitInfo() {
  return { remaining: null, reset: null }
}

// ─── AOCL Policy Gates (Phase 6) ───────────────────────────────────

const DEFAULT_POLICIES = {
  requireChecklistBeforeRelease: true,
  requireLinkedPRForClosure: false,
  requireReviewApproval: false,
}

export function getPolicies() {
  const config = getConfig()
  return { ...DEFAULT_POLICIES, ...config?.policies }
}

export function savePolicies(policies) {
  const config = getConfig() || {}
  config.policies = policies
  saveConfig(config)
}

/**
 * Disconnect: clear server-side token and local config.
 */
export async function disconnect() {
  try {
    await proxyFetch('/disconnect', { method: 'POST' })
  } catch (err) {
    console.warn('[GitHubClient] Server disconnect failed:', err.message)
  }
  localStorage.removeItem(getStorageKey())
}
