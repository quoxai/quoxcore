/**
 * RepoBrain Client: frontend API client for the RepoBrain engine
 *
 * Provides code search, cross-repo queries, and health status.
 * All methods return gracefully on error (never throw).
 */

const REPOBRAIN_API = '/collector/api/v1/nucleus'
const QUERY_CACHE_TTL = 60000 // 60s

// Simple in-memory query cache
const _queryCache = new Map()

function cacheKey(question, target) {
  return `${target}::${question}`
}

function getCached(key) {
  const entry = _queryCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > QUERY_CACHE_TTL) {
    _queryCache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key, data) {
  // Keep cache bounded
  if (_queryCache.size > 100) {
    const oldest = _queryCache.keys().next().value
    _queryCache.delete(oldest)
  }
  _queryCache.set(key, { data, ts: Date.now() })
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    // QN Phase 0: the RepoBrain proxy is now governed (auth + licence). Send the
    // session cookie so logged-in dashboard calls authenticate, mirroring
    // quoxbrainClient/memoryClient. The collector auth accepts the cookie
    // (services/collector/utils/httpAuth.js) or a Bearer header.
    const res = await fetch(url, { credentials: 'include', ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/**
 * Query a single repo's codebase
 */
export async function queryCodebase(question, target = 'quox-dashboard', maxSnippets = 5) {
  const key = cacheKey(question, target)
  const cached = getCached(key)
  if (cached) return cached

  try {
    const start = performance.now()
    const res = await fetchWithTimeout(`${REPOBRAIN_API}/targets/${encodeURIComponent(target)}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, max_snippets: maxSnippets }),
    })

    if (!res.ok) {
      return { snippets: [], error: `RepoBrain returned ${res.status}` }
    }

    const data = await res.json()
    const elapsed = Math.round(performance.now() - start)
    const result = {
      snippets: data.results || data.snippets || [],
      notes: data.notes || null,
      run_id: data.run_id || null,
      timings: { total_ms: elapsed, ...(data.timings || {}) },
    }
    setCache(key, result)
    return result
  } catch (err) {
    if (err.name === 'AbortError') {
      return { snippets: [], error: 'Query timed out' }
    }
    return { snippets: [], error: err.message }
  }
}

/**
 * Query across multiple repos
 */
export async function queryCrossRepo(question, targets, maxSnippets = 6) {
  try {
    const start = performance.now()
    const res = await fetchWithTimeout(`${REPOBRAIN_API}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, targets, max_snippets: maxSnippets }),
    })

    if (!res.ok) {
      return { snippets: [], error: `RepoBrain returned ${res.status}` }
    }

    const data = await res.json()
    const elapsed = Math.round(performance.now() - start)
    return {
      snippets: data.results || data.snippets || [],
      notes: data.notes || null,
      run_id: data.run_id || null,
      timings: { total_ms: elapsed, ...(data.timings || {}) },
    }
  } catch (err) {
    return { snippets: [], error: err.name === 'AbortError' ? 'Query timed out' : err.message }
  }
}

/**
 * Get list of indexed targets (repos)
 */
export async function getTargets() {
  // Same retry rationale as getHealth: a cold-start blip must not empty the repo
  // list (the "only two repos until you refresh" symptom was this fetch returning
  // [] on a transient failure).
  const res = await probeWithRetry('/targets', { timeoutMs: 8000 })
  if (res) {
    try {
      const data = await res.json()
      return Array.isArray(data) ? data : (data.targets || [])
    } catch { /* fall through to empty */ }
  }
  return []
}

/**
 * Get RepoBrain health
 */
/**
 * Probe a governed-proxy path, retrying transient failures before giving up.
 *
 * Why retries matter: the collector proxy resolves the org's backend + checks the
 * licence on every request (short-TTL caches). The FIRST request after a cold cache
 * pays a live round-trip to auth, and on a cold connection pool that can spike to
 * 10-20s or transiently fail-closed. Without retries, a single cold blip pinned the
 * whole RepoBrain surface to "not connected" until the user manually refreshed
 * (the classic "refresh and it comes back" bug). A few attempts with backoff ride
 * the cold start out; the warm path is ~75-100ms so retries almost never fire.
 *
 * 401/403 are NOT retried: the collector's nucleus proxy returns them
 * deterministically (no org context / no licence, see resolveNucleusOrgId and
 * isPluginLicensedForOrg in services/collector/server.js), so retrying only delays
 * an honest answer by ~1.5s for no benefit. Everything else (network error,
 * timeout, 5xx, a cold-start fail-closed gate) is treated as transient and retried.
 *
 * Returns the last Response received (ok or not), or null if every attempt threw
 * (timeout/network error) without ever getting a response.
 */
async function probeWithRetry(path, { timeoutMs = 8000, attempts = 3 } = {}) {
  let lastRes = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(`${REPOBRAIN_API}${path}`, {}, timeoutMs)
      if (res.ok) return res
      lastRes = res
      if (res.status === 401 || res.status === 403) return res
    } catch {
      // Timeout/network error: fall through and retry.
    }
    if (i < attempts - 1) {
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
  }
  return lastRes
}

// Best-effort extraction of the collector's `{ error: '...' }` body on a non-ok
// response, so the UI can show the server's actual reason instead of a generic one.
async function extractErrorReason(res) {
  try {
    const data = await res.json()
    return typeof data?.error === 'string' ? data.error : null
  } catch {
    return null
  }
}

/**
 * Fetch RepoBrain health through the governed collector proxy.
 *
 * The proxy can fail closed for reasons that have nothing to do with the engine
 * being down: 401 means this session has no resolved organisation context, 403
 * means RepoBrain isn't licensed for the org. Both are reported as distinct
 * `status` values (not collapsed into 'offline') so the UI can point at the real
 * cause instead of telling a user with a healthy engine to go restart it.
 */
export async function getHealth() {
  // Probe /health/detailed (maps to the engine's /api/health/detailed through the
  // proxy). The bare /health path rewrites to /api/health, which the engine does
  // not serve, so it was never a working fallback and is not used here.
  const res = await probeWithRetry('/health/detailed', { timeoutMs: 8000 })
  if (!res) return { status: 'offline' }

  if (res.ok) {
    try { return await res.json() } catch { return { status: 'offline' } }
  }

  if (res.status === 401) {
    const reason = await extractErrorReason(res)
    return { status: 'unauthorized', httpStatus: 401, reason: reason || 'Organisation context required for RepoBrain' }
  }

  if (res.status === 403) {
    const reason = await extractErrorReason(res)
    return { status: 'unlicensed', httpStatus: 403, reason: reason || 'RepoBrain is not licensed for this organisation' }
  }

  return { status: 'offline', httpStatus: res.status }
}

/**
 * Get stats for a specific target
 */
export async function getTargetStats(targetId) {
  try {
    const res = await fetchWithTimeout(`${REPOBRAIN_API}/targets/${encodeURIComponent(targetId)}/stats`, {}, 5000)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Register a new target (repo) definition. Does not clone or index it —
 * call setupTarget() after to clone + index in the background.
 *
 * @param {Object} opts
 * @param {string} [opts.repoUrl] - Git repo URL (legacy path, auto-detects source type)
 * @param {string} [opts.pin] - Branch, tag, or commit (default 'main')
 * @param {string} [opts.sourceType] - remote_git_https | remote_git_ssh | local_path | gitea_remote
 * @param {Object} [opts.sourceConfig] - Source-specific config (required if sourceType is set)
 * @param {string} [opts.targetId] - Unique target ID (auto-generated if omitted)
 * @param {string} [opts.description] - Human-readable description
 * @param {string[]} [opts.languages] - Programming languages
 */
export async function addTarget({ repoUrl, pin = 'main', sourceType, sourceConfig, targetId, description = '', languages = [] } = {}) {
  try {
    const body = {
      pin,
      description,
      languages,
      ...(targetId ? { target_id: targetId } : {}),
      ...(sourceType && sourceConfig
        ? { source_type: sourceType, source_config: sourceConfig }
        : { repo_url: repoUrl }),
    }

    const res = await fetchWithTimeout(`${REPOBRAIN_API}/targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15000)

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      const detail = errBody.detail
      const message = typeof detail === 'string' ? detail : (detail?.message || `RepoBrain returned ${res.status}`)
      return { error: message }
    }

    return await res.json()
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Request timed out' : err.message }
  }
}

/**
 * Create, fetch, and index a target in one operation. Submits a background
 * clone+index job and returns immediately with a job_id — poll
 * getSetupStatus(targetId) for progress.
 *
 * Accepts the same shape as addTarget().
 */
export async function setupTarget({ repoUrl, pin = 'main', sourceType, sourceConfig, targetId, description = '', languages = [] } = {}) {
  try {
    const body = {
      pin,
      description,
      languages,
      ...(targetId ? { target_id: targetId } : {}),
      ...(sourceType && sourceConfig
        ? { source_type: sourceType, source_config: sourceConfig }
        : { repo_url: repoUrl }),
    }

    const res = await fetchWithTimeout(`${REPOBRAIN_API}/targets/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15000)

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      const detail = errBody.detail
      const message = typeof detail === 'string' ? detail : (detail?.message || `RepoBrain returned ${res.status}`)
      return { error: message }
    }

    return await res.json()
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Request timed out' : err.message }
  }
}

/**
 * Poll the status of a setup (clone+index) job for a target.
 */
export async function getSetupStatus(targetId) {
  try {
    const res = await fetchWithTimeout(`${REPOBRAIN_API}/targets/${encodeURIComponent(targetId)}/setup-status`, {}, 5000)
    if (!res.ok) return { status: 'error', error: `RepoBrain returned ${res.status}` }
    return await res.json()
  } catch (err) {
    return { status: 'error', error: err.message }
  }
}
