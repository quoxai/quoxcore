// expand.js, BRAIN2-W13 C: opt-in query expansion client + orchestration.
//
// Candidate generation was the bottleneck (19 of 51 blind targets missing from
// the top 10 even with hybrid + reranker). When the org switched on the AI
// assist (BRAIN_EXPAND_ENABLED, its own disclosed opt-in, default off; W13 D
// split it from BRAIN_RERANK_ENABLED after expansion lowered blind-set MRR) the
// query is also sent to the collector's POST /internal/expand, which returns
// two paraphrases and a hypothetical answer. quoxbrain embeds those and fuses
// extra dense lists. Any failure or timeout silently keeps today's path and is
// reported as 'failed'; success is 'llm'.

import { resolveExpandEnabled } from './brainConfig.js'

export const DEFAULT_EXPAND_TIMEOUT_MS = 4500
export const EXPAND_MAX_TEXTS = 3

const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`

function timeoutOf(deps) {
  if (Number.isFinite(deps.expandTimeoutMs) && deps.expandTimeoutMs > 0) return deps.expandTimeoutMs
  const n = Number(process.env.QUOXBRAIN_EXPAND_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPAND_TIMEOUT_MS
}

/** Strict shape check on the collector reply. Returns {variants, hypothetical} or null. Never trusts extra fields. */
export function normalizeExpansion(data) {
  if (!data || typeof data !== 'object') return null
  const clean = (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, 300) : '')
  const variants = []
  if (Array.isArray(data.variants)) {
    for (const v of data.variants) { const c = clean(v); if (c && !variants.includes(c)) variants.push(c); if (variants.length >= 2) break }
  }
  const hypothetical = clean(data.hypothetical)
  if (variants.length === 0 && !hypothetical) return null
  return { variants, hypothetical }
}

/** Returns {ok:true, variants, hypothetical, model} or {ok:false}. Never throws. */
export async function callCollectorExpand(orgId, query, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '')
  if (!serviceKey || !orgId) return { ok: false }
  try {
    const res = await fetchImpl(`${collectorUrl}/internal/expand`, {
      method: 'POST',
      headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutOf(deps)),
    })
    if (!res.ok) return { ok: false }
    const norm = normalizeExpansion(await res.json())
    if (!norm) return { ok: false }
    return { ok: true, ...norm }
  } catch (err) {
    console.error(`[QuoxBrain expand] failed for org=${orgId}: ${err.message}`)
    return { ok: false }
  }
}

/**
 * Decides whether to expand and, if so, returns a lazy starter so the caller
 * can run it in parallel with the original query embed.
 * @param {{orgId:string, query:string, override?:boolean}} p
 * @returns {Promise<null | (() => Promise<{ok:boolean, variants?:string[], hypothetical?:string}>)>} null when off
 */
export async function resolveExpansion({ orgId, query, override }, deps = {}) {
  if (typeof query !== 'string' || !query.trim()) return null
  const enabled = typeof override === 'boolean' ? override : await resolveExpandEnabled(orgId, deps)
  if (!enabled) return null
  return () => (deps.callExpand || callCollectorExpand)(orgId, query, deps)
}

export default { callCollectorExpand, resolveExpansion, normalizeExpansion }
