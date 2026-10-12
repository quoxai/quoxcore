// embeddingStatus.js — BRAIN2-SEMANTIC honest embeddings state for
// GET /brain/status. Composes vaultStore's coverage counts with the
// collector's zero-spend provider probe (GET /internal/embed/provider,
// lib/internalEmbedHandler.js collector-side) into one of four states:
//
//   ready       — full coverage, single space, matching the live provider
//   indexing    — chunks still missing OR rows in a different embedding
//                 space awaiting the healer (pending = how many)
//   no_provider — the collector answered: no embedding key resolves. This
//                 is the state that replaces the silent FTS fallback — the
//                 UI deep-links to provider settings from it.
//   unknown     — the collector could not be asked (down/timeout). Reported
//                 honestly rather than guessed (a fabricated 'ready' here
//                 would be exactly the silent-fallback lie this stream
//                 exists to remove).
//
// Provider probe is cached in-process (default 60s) — /brain/status is hit
// by the cockpit poll and the collector overview fan-out, and the answer
// only changes when someone connects/removes a key.

const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`
const PROVIDER_CACHE_TTL_MS = 60_000

let providerCache = null // { value, expiresAt }

export function _resetProviderCache() {
  providerCache = null
}

/**
 * @returns {Promise<{provider:string|null, model:string|null}|null>} the
 *   collector's answer, or null when the collector can't be reached (the
 *   composer maps that to state 'unknown').
 */
export async function getEmbeddingProviderCached(deps = {}) {
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : PROVIDER_CACHE_TTL_MS
  if (providerCache && providerCache.expiresAt > Date.now()) return providerCache.value

  const fetchImpl = deps.fetchImpl || fetch
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '')

  try {
    const res = await fetchImpl(`${collectorUrl}/internal/embed/provider`, {
      headers: { 'X-Service-Key': serviceKey },
      signal: AbortSignal.timeout(Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 3000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const value = { provider: data?.provider ?? null, model: data?.model ?? null }
    providerCache = { value, expiresAt: Date.now() + ttlMs }
    return value
  } catch {
    // Failures are NOT cached — the next status call retries, so a collector
    // blip doesn't pin 'unknown' for a full TTL.
    return null
  }
}

/**
 * @param {{total:number, embedded:number, missing:number, percent:number, byModel?:Array<{model:string,count:number}>}} coverage
 * @param {{provider:string|null, model:string|null}|null} providerInfo
 */
export function composeEmbeddingsStatus(coverage, providerInfo, annPending = 0) {
  const base = { ...coverage, provider: providerInfo?.provider ?? null, model: providerInfo?.model ?? null }

  if (providerInfo === null || providerInfo === undefined) {
    return { ...base, state: 'unknown', pending: coverage.missing || 0 }
  }
  if (!providerInfo.provider) {
    return { ...base, state: 'no_provider', pending: coverage.missing || 0 }
  }

  const offSpace = (coverage.byModel || [])
    .filter((m) => m.model !== providerInfo.model)
    .reduce((s, m) => s + m.count, 0)
  // 088: SQLite coverage alone is not readiness when the active ANN index has
  // not received those vectors yet.
  const pending = (coverage.missing || 0) + offSpace + (annPending || 0)

  return { ...base, ...(annPending > 0 ? { ann_pending: annPending } : {}), state: pending > 0 ? 'indexing' : 'ready', pending }
}

// quox#557: embeddings COVERAGE is the expensive half of /brain/status
// (a full note_chunks x chunk_embeddings LEFT JOIN GROUP BY: ~5-6s of the
// 7-8s call on the dev warehouse), and it only moves at backfill speed.
// Cache it with the same 60s TTL discipline as the provider probe so
// routine polling pays the scan once a minute, not once a call. Errors are
// NOT cached (next call retries), and the getter is injected so tests pin
// the behaviour without a database.
const COVERAGE_CACHE_TTL_MS = 60_000
// Per-key entries (the 'all-orgs' service key plus one per org for user
// callers) so alternating callers never thrash a single slot.
const coverageCache = new Map()

export function getEmbeddingCoverageCached(key, getter, deps = {}) {
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : COVERAGE_CACHE_TTL_MS
  const now = Number.isFinite(deps.now) ? deps.now : Date.now()
  const hit = coverageCache.get(key)
  if (hit && (now - hit.at) < ttlMs) return hit.value
  const value = getter()
  coverageCache.set(key, { value, at: now })
  return value
}

export function _resetCoverageCache() {
  coverageCache.clear()
}

export default { getEmbeddingProviderCached, composeEmbeddingsStatus, _resetProviderCache, getEmbeddingCoverageCached, _resetCoverageCache }
