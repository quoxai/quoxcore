// contextAssembler.js — P1b budgeted context assembly
// (docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §2, POST /brain/context).
//
// This is the meaty new P1b logic: turns store.searchChunks' scored chunk
// hits (P1a, frozen — retrieval itself is NOT reimplemented here) into a
// token-budgeted, deduped, U-curve-ordered, citation-bearing passage list
// for the collector implant to call.
//
// SCORE NORMALIZATION (bm25 -> 0..1, higher=better):
// SQLite FTS5's bm25() is NEGATIVE and LOWER=BETTER — the opposite of the
// intuitive "higher score, minScore-as-floor" shape the contract wants. We
// min-max normalize per query, within the candidate pool: the best (most
// negative) raw score maps to 1.0, the worst (least negative) maps to 0.0,
// everything else scales linearly between. This is a monotonic transform
// (rank order — the only thing that matters pre-P3 rerank — is preserved
// exactly) and gives `minScore` an intuitive 0..1 meaning without
// pretending BM25 is a calibrated probability. A pool where every candidate
// has the identical raw score degenerates to 1.0 for all of them (nothing
// to rank against, so nothing gets penalized for it).
//
// DEDUP (before assembly, per contract §2):
// The chunker's ~15% tail-overlap between consecutive chunks (lib/chunker.js)
// means two adjacent chunks from the same note can end up near-identical
// after their heading/title prefix is applied. A candidate is dropped when
// its normalized text (lowercased, whitespace-collapsed) is IDENTICAL to,
// or substantially CONTAINS/IS CONTAINED IN, an already-selected
// higher-ranked passage's normalized text. Cheap, no external NLP
// dependency — good enough for P1's FTS-only retrieval; P3's rerank can
// replace this wholesale.
//
// PACKING (hard token budget, never padded; BRAIN2-AUDIT: real emitted tokens, skip-not-stop; default order is best-first, see assembleContext):
// Greedy, highest-score-first (the pool is already in descending-score
// order after threshold+dedup), using each candidate's real token_count
// (chunker.js's char/4 approximation). Adds a candidate only if it fits
// under the remaining budget and STOPS at the first candidate that would
// overflow — this is a simple ceiling, not bin-packing (a later, smaller
// candidate is never pulled forward to fill a gap). An empty result is
// valid and expected for a nonsense query or a budget smaller than the
// smallest surviving chunk.
//
// U-CURVE ORDERING ("Lost in the Middle"):
// Reorders the SELECTED passages (already score-desc) by alternately
// placing them at the front and back of the output array: passage[0]
// (best) leads, passage[1] (2nd best) trails, passage[2] (3rd best) sits
// just after the head, etc. Weakest survivors end up in the middle.

import * as store from './vaultStore.js'
import { filterCitable } from './citationGuard.js'
import { embedQueryCached, embedTextsDetailed } from './embeddingClient.js'
import { getSetting } from './configResolver.js'
import { computeRelevance, rerankVetoHolds } from './relevance.js'
import { maybeRerank } from './rerank.js'
import { groundingForTop } from './entityGrounding.js'
import { resolveRelevanceThresholds, resolveQueryEmbedTimeout, resolveEmbedExclusions, excludedVaultIds } from './brainConfig.js'

// -----------------------------------------------------------------------------
// P4-WP2 HYBRID RETRIEVAL (docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md §P4,
// docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase F) — Reciprocal Rank Fusion
// of the dense (semantic, store.denseSearchChunks) leg with the existing
// sparse (BM25, store.searchChunks) leg, reserved for exactly this seam by
// the P1b comment block above.
//
// FEATURE-FLAGGED + INERT BY DEFAULT: gated on
// process.env.QUOXBRAIN_HYBRID_ENABLED === 'true'. When the flag is off, OR
// the query can't be embedded (network failure, empty vector), OR the dense
// leg returns nothing (no embeddings backfilled yet for this org —
// lib/embeddingBackfill.js), assembleContext falls straight back to the
// FTS-only candidate pool it already had — never worse than today, and
// byte-identical to the pre-P4 code path when the flag is off.
//
// RECIPROCAL RANK FUSION (k=60, the standard default from the original RRF
// paper and this repo's own roadmap doc): score(id) = sum, over every ranked
// list containing id, of 1 / (k + rank), rank 1-based. Higher fused score =
// better (opposite convention from bm25's negative/lower=better raw score)
// — tryHybridFusion negates the fused score before handing candidates back
// to normalizeScores() below, so that function's existing bm25-shaped
// min-max transform (unchanged, see its own comment) treats a fused pool
// exactly like an FTS-only one without a second code path.
//
// DENSE-ONLY HYDRATION: denseSearchChunks only returns {chunkId, score} — a
// chunk it surfaces that the sparse leg missed entirely (the paraphrase case
// hybrid retrieval exists to fix) has no title/kind/relPath yet. Those are
// hydrated via store.getChunkMeta (a small companion lookup, same shape as
// getChunkDetails' own "separate query rather than widen searchChunks"
// reasoning) so a fused passage is indistinguishable downstream from a
// sparse hit regardless of which leg surfaced it.
// -----------------------------------------------------------------------------

const RRF_K = 60
export const LEG_HEAD_N = 5

// BRAIN2-W6 (held-out eval 2026-10-06): equal-weight RRF let a lexical
// ranking that is near-useless on paraphrased questions (FTS MRR 0.069) drag
// dense rank-1 hits down to ranks 2-6 (dense MRR 0.518 vs hybrid 0.291).
// The dense leg is weighted above the sparse leg; lexical still contributes,
// so notes only FTS finds still surface. The default was chosen by a sweep
// over the held-out set AND the lexical served eval (see eval/compare.mjs):
// held-out MRR 0.291 (w=1) / 0.373 (w=2) / 0.434 (w=4) / 0.456 (w=6).
export const DEFAULT_DENSE_WEIGHT = 4

// BRAIN2-W9 source prior: raw session transcripts are long (many chunks per
// note) and crowded curated notes out of the top results on held-out
// questions. Fused scores are multiplied by a per-kind prior; kinds not
// listed keep 1. Chosen on held-out set 1 only; set 2 stays untuned.
export const DEFAULT_KIND_PRIORS = Object.freeze({}) // neutral until measured on a quiet service (2026-10-06: embed timeouts contaminated the sweep)
export function resolveKindPrior(kind, override) {
  const table = override && typeof override === 'object' ? override : DEFAULT_KIND_PRIORS
  const v = table[kind]
  if (Number.isFinite(v) && v > 0 && v <= 2) return v
  // CORTEX-BENCH: '*' is the prior for every kind the table does not name, so
  // a caller can boost human prose and demote ALL machine exhaust (commits,
  // transcripts, code, DB-feed rows whose kind is their table name) in one
  // query instead of a second, curated-only search.
  const d = table['*']
  return Number.isFinite(d) && d > 0 && d <= 2 ? d : 1
}
// BRAIN2-V2 V2-7: opt-in recency weighting, a multiplier beside the kind
// prior: 1 + weight * 2^(-ageDays / halfLifeDays), age from occurredAt (else
// updatedAt). Off (exactly 1) unless both knobs are valid; future dates count
// as age 0; weight capped at 1 so a fresh note can at most double its score.
export function recencyFactor(base, recency, now = Date.now()) {
  const w = Number(recency?.weight)
  const h = Number(recency?.halfLifeDays)
  if (!(w > 0) || !(h > 0)) return 1
  const t = Date.parse(base?.occurredAt || base?.updatedAt || '')
  if (!Number.isFinite(t)) return 1
  const ageDays = Math.max(0, (now - t) / 86400000)
  return 1 + Math.min(w, 1) * Math.pow(2, -ageDays / h)
}
export function resolveDenseWeight(override) {
  if (Number.isFinite(override) && override > 0 && override <= 10) return override
  const env = Number(process.env.QUOXBRAIN_RRF_DENSE_WEIGHT)
  return Number.isFinite(env) && env > 0 && env <= 10 ? env : DEFAULT_DENSE_WEIGHT
}

/** Reciprocal Rank Fusion — merges N best-first-ordered chunkId rank lists
 * into one fused ranking. Exported standalone so the fusion math itself is
 * directly unit-testable without a DB or embeddings.
 *
 * @param {Array<string[]>} rankedLists - each a best-first chunkId array
 * @param {number} [k]
 * @returns {Array<{chunkId:string, score:number}>} fused, sorted desc by score
 */
export function reciprocalRankFusion(rankedLists, k = RRF_K, weights = null) {
  const scores = new Map()
  rankedLists.forEach((list, li) => {
    if (!Array.isArray(list)) return
    const w = Array.isArray(weights) && Number.isFinite(weights[li]) ? weights[li] : 1
    list.forEach((chunkId, idx) => {
      scores.set(chunkId, (scores.get(chunkId) || 0) + w / (k + idx + 1))
    })
  })
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score]) => ({ chunkId, score }))
}

/**
 * CORTEX-BENCH (capture lag): a just-written chunk has no embedding until the
 * backfill scheduler reaches it, so it is absent from the dense list, and with
 * the dense leg weighted DEFAULT_DENSE_WEIGHT x the sparse leg, even a rank-1
 * exact lexical hit was buried under dense-only results: a note saved through
 * Cortex stayed unfindable for minutes. Until it is embedded, a sparse hit is
 * credited on the dense side at its own sparse rank (an imputed dense rank).
 * Embedded chunks are untouched, so a fully embedded corpus ranks identically.
 *
 * @param {Array<{chunkId:string, score:number}>} fused  output of reciprocalRankFusion
 * @param {string[]} sparseRanking  best-first sparse chunk ids
 * @param {Set<string>} unembedded  sparse chunk ids with no embedding yet
 */
export function imputeUnembeddedDense(fused, sparseRanking, unembedded, denseW, k = RRF_K) {
  if (!unembedded || unembedded.size === 0) return fused
  const bonus = new Map()
  sparseRanking.forEach((id, idx) => { if (unembedded.has(id) && !bonus.has(id)) bonus.set(id, denseW / (k + idx + 1)) })
  return fused
    .map((f) => (bonus.has(f.chunkId) ? { chunkId: f.chunkId, score: f.score + bonus.get(f.chunkId) } : f))
    .sort((a, b) => b.score - a.score)
}

// VAULT-INTEG P17: QUOXBRAIN_HYBRID_ENABLED was a bare process.env read —
// quoxbrain never opened collector's org_platform_settings, so an org
// admin's stored override was audited/shown in the Settings UI but never
// actually consulted here. Now resolved fresh on every assembleContext()
// call via configResolver.getSetting() (org-scoped: hybrid retrieval is a
// per-org retrieval-quality choice, resolved fresh per query — a stored
// override applies to the very next query, no restart needed). Fail-safe:
// any resolver failure (no service key, network error, timeout, or no
// override stored) falls back to the plain env read, exactly like every
// other call site rewired in this pass.
export async function isHybridEnabled(orgId, deps = {}) {
  try {
    const resolved = await getSetting(orgId, 'QUOXBRAIN_HYBRID_ENABLED', deps)
    if (resolved && typeof resolved.on === 'boolean') return resolved.on
  } catch (err) {
    console.error(`[Brain] QUOXBRAIN_HYBRID_ENABLED resolver failed for org=${orgId}, falling back to env — ${err.message}`)
  }
  return process.env.QUOXBRAIN_HYBRID_ENABLED === 'true'
}

/**
 * Best-effort hybrid fusion attempt. Returns the fused, hydrated candidate
 * pool (same row shape as store.searchChunks' output, `score` replaced with
 * the negated RRF score), or `null` if hybrid retrieval isn't usable right
 * now for any reason — callers must fall back to their existing sparse pool
 * on `null`.
 */
/**
 * Collapses chunk rows to at most one per noteId, keeping the best-scoring
 * chunk (lowest score: bm25-shaped, lower = better). Order of first-seen
 * notes is preserved. Rows without a noteId pass through untouched.
 */
export function dedupeByNote(rows) {
  const bestIdx = new Map()
  const out = []
  for (const row of rows) {
    if (!row.noteId) { out.push(row); continue }
    const idx = bestIdx.get(row.noteId)
    if (idx === undefined) {
      bestIdx.set(row.noteId, out.length)
      out.push(row)
    } else if (row.score < out[idx].score) {
      out[idx] = row
    }
  }
  return out
}

// BRAIN2-W10 D: per-note candidate quota. Chunks were limited BEFORE note
// dedupe, so one long transcript (dozens of matching chunks) filled the whole
// candidate pool and pushed a relevant curated note out of it. The quota is
// applied inside each leg's candidate generation (sparse + dense), over a
// widened raw fetch, so the pool still fills with distinct notes.
export const PER_NOTE_QUOTA = 2

/** Keeps at most `max` rows per noteId, preserving order. Rows without a noteId pass. */
export function capPerNote(rows, max = PER_NOTE_QUOTA, noteIdOf = (r) => r.noteId) {
  const seen = new Map()
  const out = []
  for (const row of rows) {
    const nid = noteIdOf(row)
    if (!nid) { out.push(row); continue }
    const n = seen.get(nid) || 0
    if (n >= max) continue
    seen.set(nid, n + 1)
    out.push(row)
  }
  return out
}

/** Sparse leg with the per-note quota: fetch wide, cap per note, trim to `limit`. */
export function searchChunksWithQuota(searchFn, org_id, user_id, args, limit, max = PER_NOTE_QUOTA) {
  const rawLimit = Math.min(Math.max(limit * 10, 100), 500)
  // CORTEX-BENCH: snippets only for the pool that survives (see fillChunkSnippets).
  const defer = searchFn === store.searchChunks
  const raw = searchFn(org_id, user_id, { ...args, limit: rawLimit, offset: 0, maxLimit: 500, ...(defer ? { deferSnippets: true } : {}) })
  const pool = capPerNote(raw, max).slice(0, limit)
  return defer ? store.fillChunkSnippets(args.query, pool) : pool
}

// Interactive query-embed bound (BRAIN2-AUDIT 2026-10-05): search and
// context are user-facing; a late embed degrades this one request to sparse.
// Per-caller override (header/param, clamped): the collector implant path keeps
// the 1.5s default; agent/CLI search callers may allow up to
// MAX_QUERY_EMBED_TIMEOUT_MS so a cold embed can still land hybrid.
export const MAX_QUERY_EMBED_TIMEOUT_MS = 4000
function queryEmbedTimeoutMs(override, orgDefault) {
  const o = Number(override)
  if (Number.isFinite(o) && o > 0) return Math.min(Math.max(o, 200), MAX_QUERY_EMBED_TIMEOUT_MS)
  // BRAIN2-V3 B4: org-resolved default (setting > env > 1500ms) from brainConfig.
  if (Number.isFinite(orgDefault) && orgDefault > 0) return orgDefault
  const n = Number(process.env.QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 1500
}

/**
 * BRAIN2-V3 B4: per-org retrieval knobs resolved from platform settings
 * (setting > env > default). Never throws; any resolver failure degrades to
 * the env/default values. `excludedVaultIdSet` = vaults whose chunks are
 * never embedded (and so never surface through the dense leg).
 */
export async function resolveOrgRetrievalConfig(org_id, deps = {}) {
  // 076: resolve against the REQUESTING user's view, else private vaults are
  // invisible here and their exclusion silently never applies.
  const listVaultsFn = deps.listVaults || ((o) => store.listVaults(o, deps.user_id ?? null))
  const [thresholds, timeout, tokens] = await Promise.all([
    resolveRelevanceThresholds(org_id, deps),
    resolveQueryEmbedTimeout(org_id, deps),
    resolveEmbedExclusions(org_id, deps),
  ])
  let excludedVaultIdSet = new Set()
  if (tokens.length > 0) {
    try { excludedVaultIdSet = excludedVaultIds(tokens, listVaultsFn(org_id)) } catch { /* keep empty */ }
  }
  return { thresholds, orgQueryEmbedTimeoutMs: timeout.value, excludedVaultIdSet }
}

const FACET_KEYS = ['vaultIds', 'kinds', 'sources', 'scopes', 'languages']
function hasFacets(filters) {
  return !!filters && (FACET_KEYS.some((k) => Array.isArray(filters[k]) && filters[k].length > 0) || !!filters.since || !!filters.until)
}

/** Lexical coverage below this (or an empty pool) makes the sparse result weak. */
export const WEAK_SPARSE_COVERAGE = 0.5

/**
 * BRAIN2-W10 G: is the sparse leg too weak to stand alone? Uses the same
 * computeRelevance coverage logic over the top sparse passages.
 */
export function isSparsePoolWeak(org_id, user_id, query, sparsePool, deps = {}) {
  if (!Array.isArray(sparsePool) || sparsePool.length === 0) return true
  const top = sparsePool.slice(0, 5)
  const getDetails = deps.getChunkDetails || store.getChunkDetails
  let passages = top
  try {
    const det = new Map(getDetails(org_id, user_id, top.map((c) => c.chunkId)).map((d) => [d.chunkId, d]))
    passages = top.map((c) => ({ title: c.title, text: det.get(c.chunkId)?.text ?? c.snippet ?? c.text ?? '' }))
  } catch { passages = top.map((c) => ({ title: c.title, text: c.snippet ?? c.text ?? '' })) }
  return computeRelevance(query, passages).coverage < WEAK_SPARSE_COVERAGE
}

/**
 * BRAIN2-W11 C: the embedding space to query for this org = the model holding
 * the MOST of its embedded chunks (listOrgEmbeddingModels is count-desc, cached
 * ~60s). During a migration the half-filled new space gives noise top hits, so
 * the query stays in the old space until the new one is the majority.
 * @returns {string|null}
 */
export function majorityEmbedModel(org_id, deps = {}) {
  try {
    const list = (deps.getOrgEmbeddingModels || store.listOrgEmbeddingModels)(org_id) || []
    return list.find((m) => typeof m === 'string' && m) || null
  } catch { return null }
}

/**
 * CORTEX-BENCH (latency): start the query embed BEFORE the synchronous sparse
 * search. embedQueryCached shares one in-flight request per (org, model,
 * query), so tryHybridFusion later joins this pending embed instead of
 * starting the network round trip only after FTS finished: the two overlap.
 * Same model choice as tryHybridFusion. Fire-and-forget; never throws.
 */
export function prefetchQueryEmbedding(org_id, query, deps = {}) {
  try {
    if (deps.embedTextsDetailed || deps.embedTexts) return
    const majority = majorityEmbedModel(org_id, deps)
    const reqModel = majority && majority.startsWith('text-embedding-3-') ? majority.split('@')[0] : undefined
    embedQueryCached(query, reqModel ? { orgId: org_id, model: reqModel } : { orgId: org_id }).catch(() => {})
  } catch { /* prefetch is an optimisation only */ }
}

export async function tryHybridFusion(org_id, user_id, query, sparsePool, limit, deps = {}) {
  // Space-aware embed seam (BRAIN2-SEMANTIC 2026-08-25): the query vector's
  // ACTUAL model rides along so the dense leg scans only its own embedding
  // space — cosine across the OpenAI/Gemini split is noise. A legacy
  // deps.embedTexts injection still works (model unknown -> unfiltered).
  const embedDetailedFn = deps.embedTextsDetailed
    || (deps.embedTexts
      ? async (texts) => ({ vectors: await deps.embedTexts(texts), models: [null] })
      : (texts, d) => embedQueryCached(texts[0], {
        ...d,
        queryTimeoutMs: queryEmbedTimeoutMs(deps.queryEmbedTimeoutMs, deps.orgQueryEmbedTimeoutMs),
        weakExtraMs: deps.weakExtraMs,
        isSparseWeak: () => isSparsePoolWeak(org_id, user_id, query, sparsePool, deps)
      }))
  const denseSearchChunksFn = deps.denseSearchChunks || store.denseSearchChunksAsync
  const getChunkMetaFn = deps.getChunkMeta || store.getChunkMeta
  const filterByFacetsFn = deps.filterChunkIdsByFacets || store.filterChunkIdsByFacets
  const filters = deps.filters
  const faceted = hasFacets(filters)

  try {
    // Majority-space policy (BRAIN2-W11 C): ONE query embed, in the space that
    // holds most of the org's chunks. Only text-embedding-3-* spaces are
    // requestable by name; any other majority uses the provider default.
    const majority = majorityEmbedModel(org_id, deps)
    const reqModel = majority && majority.startsWith('text-embedding-3-') ? majority.split('@')[0] : undefined
    // BRAIN2-W13 C: start the expansion call now so it runs alongside the original embed.
    const expandPromise = typeof deps.expand === 'function' ? Promise.resolve().then(() => deps.expand()).catch(() => ({ ok: false })) : null
    const embedRes = await embedDetailedFn([query], reqModel ? { orgId: org_id, model: reqModel } : { orgId: org_id })
    const { vectors, models } = embedRes
    // BRAIN2-W10 G: the dense leg was wanted but no vector arrived in time.
    if (embedRes?.timedOut && deps.degradedSink) deps.degradedSink.degraded = 'dense_timeout'
    const queryVector = vectors?.[0]
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      console.warn('[Brain] hybrid: no query vector from the embed seam — falling back to FTS-only for this query')
      return null
    }

    // Facet leak fix (BRAIN2-AUDIT 2026-10-05): the dense leg scans every
    // embedding in scope and knows no facets, so with vaultIds/kinds/sources/
    // scopes/languages set it surfaced out-of-facet chunks. Over-fetch, then
    // keep only ids that satisfy the same facets the sparse leg applied.
    const denseFetch = Math.min(Math.max(limit * 6, faceted ? limit * 4 : limit), 200)
    const liveModel = models?.[0] || (reqModel ? majority : null)
    // One dense leg for one query vector: facet filter, vault exclusion, per-note quota, trim.
    const runDenseLeg = async (vec) => {
      let dr = await denseSearchChunksFn(org_id, vec, { ownerUserId: user_id, limit: denseFetch, model: liveModel, filters })
      const coverage = dr?.denseCoverage ?? null // W13 B: survives the facet/quota filters below
      if (faceted && Array.isArray(dr) && dr.length > 0) {
        const allowed = filterByFacetsFn(org_id, user_id, dr.map((d) => d.chunkId), filters)
        dr = dr.filter((d) => allowed.has(d.chunkId))
      }
      // BRAIN2-V3 B4: vaults excluded from embedding must not surface through
      // dense search either (vectors written before the exclusion was set stay
      // in the table) - they fall back to keyword retrieval only.
      if (Array.isArray(dr) && dr.length > 0) {
        const needExclude = deps.excludedVaultIdSet && deps.excludedVaultIdSet.size > 0
        const metaById = new Map(getChunkMetaFn(org_id, user_id, dr.map((d) => d.chunkId)).map((m) => [m.chunkId, m]))
        if (needExclude) {
          dr = dr.filter((d) => {
            const m = metaById.get(d.chunkId)
            return !m || !deps.excludedVaultIdSet.has(m.vaultId)
          })
        }
        // BRAIN2-W10 D: per-note quota on the dense candidates, then trim.
        dr = capPerNote(dr, PER_NOTE_QUOTA, (d) => metaById.get(d.chunkId)?.noteId)
      }
      if (Array.isArray(dr)) dr = dr.slice(0, limit)
      return { results: dr, coverage }
    }
    const primary = await runDenseLeg(queryVector)
    const denseResults = primary.results
    const denseCoverage = primary.coverage
    if (!Array.isArray(denseResults) || denseResults.length === 0) {
      console.warn('[Brain] hybrid: dense leg returned no candidates (no embeddings in this space yet?) - falling back to FTS-only for this query')
      return null
    }

    // BRAIN2-W13 C: opt-in query expansion. The paraphrases + hypothetical answer
    // are embedded in ONE batch (same majority space) and each gets its own dense
    // list; all are fused below. Any failure keeps the original path.
    const extraLists = []
    if (typeof expandPromise?.then === 'function') {
      try {
        const ex = await expandPromise
        const texts = ex?.ok ? [...(ex.variants || []), ...(ex.hypothetical ? [ex.hypothetical] : [])].slice(0, 3) : []
        if (texts.length === 0) throw new Error('no expansion')
        const batchEmbed = deps.embedTextsDetailed
          || (deps.embedTexts ? async (t) => ({ vectors: await deps.embedTexts(t), models: [] }) : embedTextsDetailed)
        const er = await Promise.race([
          batchEmbed(texts, reqModel ? { orgId: org_id, model: reqModel } : { orgId: org_id }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('expand embed timeout')), deps.expandEmbedTimeoutMs || 2500)),
        ])
        for (let i = 0; i < texts.length; i++) {
          const v = er?.vectors?.[i]
          // A vector from a different space than the original query is noise: skip it.
          if (!Array.isArray(v) || v.length === 0 || (er.models?.[i] && liveModel && er.models[i] !== liveModel)) continue
          const leg = await runDenseLeg(v)
          if (Array.isArray(leg.results) && leg.results.length > 0) extraLists.push(leg.results.map((d) => d.chunkId))
        }
        if (deps.expandSink) deps.expandSink.status = extraLists.length > 0 ? 'llm' : 'failed'
      } catch (err) {
        if (deps.expandSink) deps.expandSink.status = 'failed'
        console.warn(`[Brain] expand: keeping the original query only (${err.message})`)
      }
    }

    const sparseRanking = sparsePool.map((c) => c.chunkId)
    const denseRanking = denseResults.map((d) => d.chunkId)
    const denseW = resolveDenseWeight(deps.denseWeight)
    // The original query keeps the highest weight; each expansion list gets half of it.
    let fused = reciprocalRankFusion([sparseRanking, denseRanking, ...extraLists], RRF_K, [1, denseW, ...extraLists.map(() => denseW / 2)])
    if (fused.length === 0) return null
    try {
      const unembeddedFn = deps.unembeddedChunkIds || store.unembeddedChunkIds
      fused = imputeUnembeddedDense(fused, sparseRanking, unembeddedFn(org_id, sparseRanking), denseW)
    } catch (err) {
      console.warn(`[Brain] hybrid: unembedded-chunk imputation skipped (${err.message})`)
    }

    const byId = new Map(sparsePool.map((c) => [c.chunkId, c]))
    const missingIds = fused.map((f) => f.chunkId).filter((id) => !byId.has(id))
    if (missingIds.length > 0) {
      const metaRows = getChunkMetaFn(org_id, user_id, missingIds)
      for (const row of metaRows) byId.set(row.chunkId, row)
    }

    let explainChunks = null
    if (deps.explainSink) {
      explainChunks = new Map()
      const sparseAt = new Map(sparseRanking.map((id, i) => [id, i + 1]))
      const denseAt = new Map(denseResults.map((d, i) => [d.chunkId, { rank: i + 1, cosine: Number.isFinite(d.score) ? d.score : null }]))
      Object.assign(deps.explainSink, { chunks: explainChunks, sparseAt, denseAt, sparseCandidates: sparseRanking.length, denseCandidates: denseRanking.length, denseFetch, fusedOrder: fused.map((f) => f.chunkId) })
    }
    const out = fused
      .map(({ chunkId, score }) => {
        const base = byId.get(chunkId)
        // Dense-only hit whose metadata vanished between the two queries
        // (e.g. concurrent delete) — drop rather than emit a row with no
        // real citation (mirrors assembleContext's own detail-vanished guard).
        if (!base) return null
        const kindPrior = resolveKindPrior(base.kind, deps.kindPriors)
        const recency = recencyFactor(base, deps.recency)
        const prior = kindPrior * recency
        // ONE-BRAIN CX6: capture what fusion already computed for `explain` (no recompute).
        if (explainChunks) explainChunks.set(chunkId, { fusedScore: score * prior, kindPrior, recency })
        return { ...base, score: -(score * prior) } // negate: RRF higher=better -> bm25-shaped lower=better
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
    // Raw cosine of the best (facet-filtered) dense hit: the absolute
    // relevance signal (lib/relevance.js). Carried as a property so the
    // array return shape stays compatible with existing callers.
    out.denseTop = denseResults[0]?.score ?? null
    // ONE-BRAIN CX1: each leg's own head, for ensureLegHeads() before rerank.
    out.legHeads = { sparse: sparseRanking.slice(0, LEG_HEAD_N), dense: denseRanking.slice(0, LEG_HEAD_N) }
    out.embedSpace = liveModel
    out.denseCoverage = denseCoverage
    return out
  } catch (err) {
    console.error('[Brain] hybrid fusion failed, falling back to FTS-only:', err.message)
    return null
  }
}

function normalizeForDedup(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True if `candidateNorm` is a near-duplicate of any already-selected
 * passage: identical, or one substantially contains the other. */
function isNearDuplicate(candidateNorm, selectedNorms) {
  if (!candidateNorm) return false
  return selectedNorms.some((selNorm) => {
    if (!selNorm) return false
    if (candidateNorm === selNorm) return true
    return selNorm.includes(candidateNorm) || candidateNorm.includes(selNorm)
  })
}

/** Min-max normalizes raw bm25 scores (negative, lower=better) to a 0..1
 * range (higher=better) within the given candidate pool. Order-preserving. */
function normalizeScores(rows) {
  if (rows.length === 0) return rows
  const raws = rows.map((r) => r.score)
  const minRaw = Math.min(...raws) // most negative = best match
  const maxRaw = Math.max(...raws) // least negative = worst match
  const span = maxRaw - minRaw
  return rows.map((r) => ({
    ...r,
    score: span > 0 ? (maxRaw - r.score) / span : 1
  }))
}

/** Distributes a score-desc list alternately to the front/back of a new
 * array — highest-value passages at HEAD and TAIL, weakest in the middle. */
function uCurveOrder(sortedDesc) {
  const out = new Array(sortedDesc.length)
  let head = 0
  let tail = sortedDesc.length - 1
  sortedDesc.forEach((item, i) => {
    if (i % 2 === 0) { out[head] = item; head += 1 }
    else { out[tail] = item; tail -= 1 }
  })
  return out
}

/**
 * Assembles a token-budgeted, deduped, U-curve-ordered, citation-bearing
 * passage list for a query. See docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §2
 * (POST /brain/context) for the frozen response shape.
 *
 * @param {string} org_id
 * @param {string} user_id
 * @param {{query:string, tokenBudget?:number, vaultIds?:string[], kinds?:string[], minScore?:number, sources?:string[], scopes?:string[], languages?:string[]}} opts
 *   `sources`/`scopes`/`languages` (P2.5b-1, roadmap QUOXBRAIN #163) are the
 *   same brain-level facet filters as /brain/graph and /brain/sources —
 *   passed straight through to searchChunks, narrowing retrieval to match
 *   whatever facet selection the UI has active.
 * @param {{searchChunks?:Function, denseSearchChunks?:Function, getChunkMeta?:Function, getChunkDetails?:Function, embedTexts?:Function}} [deps]
 *   Injectable overrides for testing (P4-WP2) — everything defaults to the
 *   real store.js/embeddingClient.js implementations.
 * @returns {Promise<{passages:Array, tokensUsed:number, assembly:{candidates:number, afterThreshold:number, afterDedup:number}}>}
 */
export async function assembleContext(org_id, user_id, { query, tokenBudget = 800, vaultIds, kinds, minScore = 0, sources, scopes, languages, queryEmbedTimeoutMs, ordering = 'score', maxPerNote = 3, rerank: rerankOverride } = {}, deps = {}) {
  const searchChunksFn = deps.searchChunks || store.searchChunks
  const getChunkDetailsFn = deps.getChunkDetails || store.getChunkDetails

  // Generous candidate pool so threshold/dedup/packing have something real
  // to work with even for a tight budget.
  const candidateLimit = Math.max(50, Math.ceil(tokenBudget / 50))
  const rawCandidates = searchChunksWithQuota(searchChunksFn, org_id, user_id, { query, vaultIds, kinds, sources, scopes, languages }, candidateLimit)

  // P4-WP2 hybrid fusion (feature-flagged, best-effort) — swaps the FTS-only
  // pool for a dense+sparse RRF-fused one when usable; on ANY failure (flag
  // off, embed failure, no dense results) `pool` stays the untouched
  // FTS-only `rawCandidates`, so the rest of this function is byte-identical
  // to the pre-P4 code path in that case.
  let pool = rawCandidates
  let denseTop = null
  let embedSpace = null
  let denseCoverage = null
  // BRAIN2-W7 C 079: which retrieval path actually served, visible on the
  // response ('fts' unless fusion produced the pool).
  let retrievalMode = 'fts'
  const degradedSink = {}
  const orgCfg = deps.orgConfig || await resolveOrgRetrievalConfig(org_id, { ...deps, user_id })
  if (await isHybridEnabled(org_id, deps) && typeof query === 'string' && query.trim()) {
    const fused = await tryHybridFusion(org_id, user_id, query, rawCandidates, candidateLimit,
      { ...deps, degradedSink, orgQueryEmbedTimeoutMs: orgCfg.orgQueryEmbedTimeoutMs, excludedVaultIdSet: orgCfg.excludedVaultIdSet, queryEmbedTimeoutMs, filters: { vaultIds, kinds, sources, scopes, languages } })
    if (fused) { pool = fused; denseTop = fused.denseTop ?? null; embedSpace = fused.embedSpace ?? null; denseCoverage = fused.denseCoverage ?? null; retrievalMode = 'hybrid' }
  }

  const citableCandidates = filterCitable(pool, { context: 'brain/context candidates' })

  // char_start/char_end/token_count/raw text are not part of searchChunks'
  // frozen response shape — fetched via the small companion lookup instead
  // of widening that function's SELECT.
  const detailsById = new Map(
    getChunkDetailsFn(org_id, user_id, citableCandidates.map((c) => c.chunkId)).map((d) => [d.chunkId, d])
  )

  const candidates = citableCandidates
    .map((c) => {
      const detail = detailsById.get(c.chunkId)
      // Detail row vanished between the two queries (e.g. concurrent
      // delete) — drop rather than emit a passage with no real citation.
      if (!detail) return null
      return { ...c, charStart: detail.charStart, charEnd: detail.charEnd, tokenCount: detail.tokenCount, text: detail.text }
    })
    .filter(Boolean)

  // searchChunks already orders best-first (ASC bm25 = MOST negative
  // first); normalizeScores is a monotonic transform, so this stays
  // descending by (new) score without a re-sort.
  // Absolute relevance (the per-set min-max below always gives the best hit
  // 1.0, so it cannot tell a nonsense query from a good one). Abstain with
  // empty passages when the top candidates don't actually address the query.
  const relevance = computeRelevance(query, candidates, { denseTop, embedModel: embedSpace, bm25Top: rawCandidates[0]?.score ?? null, thresholds: orgCfg.thresholds })
  if (relevance.insufficient) {
    return {
      passages: [], tokensUsed: 0, insufficient: true, relevance, retrieval: retrievalMode, embedSpace, ...(degradedSink.degraded && retrievalMode === 'fts' ? { degraded: degradedSink.degraded } : {}),
      assembly: { candidates: pool.length, afterThreshold: 0, afterDedup: 0 }
    }
  }

  // BRAIN2-W11 B: opt-in LLM rerank of the fused top-N (never when abstaining,
  // which returned above). Failure keeps the fused order.
  const rr = await maybeRerank({
    orgId: org_id, query, ranked: candidates, insufficient: false,
    override: typeof rerankOverride === 'boolean' ? rerankOverride : undefined,
    idOf: (c) => c.chunkId, textOf: (c) => c.text, dated: 'auto',
  }, deps)
  if (rr.rerankVerdict === 'none' && rerankVetoHolds(relevance, { thresholds: orgCfg.thresholds, embedModel: embedSpace })) {
    return {
      passages: [], tokensUsed: 0, insufficient: true, rerank: 'llm', rerankVerdict: 'none',
      relevance: { ...relevance, insufficient: true, rerankVerdict: 'none' }, retrieval: retrievalMode, embedSpace,
      ...(degradedSink.degraded && retrievalMode === 'fts' ? { degraded: degradedSink.degraded } : {}),
      assembly: { candidates: pool.length, afterThreshold: 0, afterDedup: 0 }
    }
  }
  const rerankFlag = rr.rerank ? { rerank: rr.rerank } : {}
  // Codex cycle 6: the same named-thing check /brain/search applies
  // (lib/entityGrounding.js), so an off-topic question never reaches a prompt.
  const grounding = groundingForTop(query, rr.ranked, {
    passageOf: (c) => c.text,
    headOf: (c) => { const n = c.noteId ? (deps.getNote || store.getNote)(org_id, user_id, c.noteId) : null; return typeof n?.body === 'string' ? n.body.slice(0, 1200) : '' },
  })
  if (grounding.ungrounded) {
    return {
      passages: [], tokensUsed: 0, insufficient: true,
      relevance: { ...relevance, insufficient: true, ungrounded: grounding.missing }, retrieval: retrievalMode, embedSpace,
      ...(degradedSink.degraded && retrievalMode === 'fts' ? { degraded: degradedSink.degraded } : {}),
      ...rerankFlag,
      assembly: { candidates: pool.length, afterThreshold: 0, afterDedup: 0 }
    }
  }
  const normalized = normalizeScores(rr.ranked)

  const afterThreshold = normalized.filter((c) => c.score >= minScore)

  const selectedNorms = []
  const afterDedup = []
  for (const c of afterThreshold) {
    const norm = normalizeForDedup(c.text)
    if (isNearDuplicate(norm, selectedNorms)) continue
    selectedNorms.push(norm)
    afterDedup.push(c)
  }

  const packed = []
  let tokensUsed = 0
  // BRAIN2-W7 C 077: cap passages per note so one long document cannot crowd
  // other sources out of the prompt (dedup above is by text, not by note).
  const perNote = new Map()
  for (const c of afterDedup) {
    if ((perNote.get(c.noteId) || 0) >= maxPerNote) continue
    // Real cost = the text actually emitted. Stored text carries the prepended
    // title/heading, which chunker's tokenCount (clean body only) misses.
    const cost = Math.max(c.tokenCount, Math.ceil((c.text || '').length / 4))
    if (tokensUsed + cost > tokenBudget) continue // skip an oversized chunk, keep filling
    packed.push(c)
    perNote.set(c.noteId, (perNote.get(c.noteId) || 0) + 1)
    tokensUsed += cost
  }

  // Default: best-first. The collector implant truncates the TAIL of the
  // block, so the U-curve (2nd-best last) put a top passage on the chopping
  // block. 'ucurve' stays available for callers that don't truncate.
  // BRAIN2-W7 C 078: thresholding/packing removed every candidate. An empty
  // passage list must never read as usable evidence.
  if (packed.length === 0) {
    return {
      passages: [], tokensUsed: 0, insufficient: true, relevance, retrieval: retrievalMode, embedSpace, ...(degradedSink.degraded && retrievalMode === 'fts' ? { degraded: degradedSink.degraded } : {}),
      reason: 'no passage survived thresholding or the token budget',
      ...rerankFlag,
      assembly: { candidates: pool.length, afterThreshold: afterThreshold.length, afterDedup: afterDedup.length }
    }
  }

  const ordered = ordering === 'ucurve' ? uCurveOrder(packed) : packed

  const passages = ordered.map((c) => ({
    chunkId: c.chunkId,
    noteId: c.noteId,
    kind: c.kind,
    text: c.text,
    citation: {
      noteId: c.noteId,
      chunkId: c.chunkId,
      charStart: c.charStart,
      charEnd: c.charEnd,
      title: c.title,
      relPath: c.relPath
    },
    score: c.score
  }))

  return {
    passages,
    tokensUsed,
    insufficient: false,
    relevance,
    ...rerankFlag,
    retrieval: retrievalMode, embedSpace, ...(denseCoverage?.status === 'partial' ? { denseCoverage } : {}), ...(degradedSink.degraded && retrievalMode === 'fts' ? { degraded: degradedSink.degraded } : {}),
    assembly: {
      candidates: pool.length, // === rawCandidates.length when hybrid is off/unused (pool is the same reference)
      afterThreshold: afterThreshold.length,
      afterDedup: afterDedup.length
    }
  }
}

export default { assembleContext, reciprocalRankFusion, tryHybridFusion, isHybridEnabled }

// CORTEX-BENCH (ONE-BRAIN CX1): a note too long to return whole used to come
// back as ONE chunk, often not the one holding the answer (a 12k decision note
// whose key line sat in its summary returned a chunk from its middle). The
// excerpt is the head (curated notes put their key facts first) plus the
// note's best-matching ranges in priority order, merged and laid out in
// document order, gaps marked, within maxChars.
const EXCERPT_GAP = '\n\n[…]\n\n'
export function buildNoteExcerpt(body, ranges = [], { maxChars = 8000, headChars = 1500 } = {}) {
  if (typeof body !== 'string') return ''
  if (body.length <= maxChars) return body
  const picked = [{ start: 0, end: Math.min(headChars, body.length) }]
  const covered = (spans) => merge(spans).reduce((n, s) => n + (s.end - s.start) + EXCERPT_GAP.length, 0)
  for (const r of ranges) {
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start) continue
    const span = { start: Math.max(0, r.start), end: Math.min(body.length, r.end) }
    if (span.end <= span.start) continue
    if (covered([...picked, span]) <= maxChars + EXCERPT_GAP.length) picked.push(span)
  }
  return merge(picked).map((s) => body.slice(s.start, s.end)).join(EXCERPT_GAP)
}
function merge(spans) {
  const s = [...spans].sort((a, b) => a.start - b.start)
  const out = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x.start <= last.end + 200) last.end = Math.max(last.end, x.end)
    else out.push({ ...x })
  }
  return out
}

// ONE-BRAIN CX1: each retriever's top notes are guaranteed a seat in the
// rerank window. The two legs win on DIFFERENT questions (keyword on exact
// names and ids, dense on paraphrase), and with the dense leg weighted above
// the sparse one a note only the keyword leg found, even at #1, fused below the
// window and was never judged. Missing leg heads go to the END of the window
// (displacing the weakest fused rows), so without a reranker the top of the
// list is unchanged; with one, the reranker decides on content.
export function ensureLegHeads(ranked, legHeads, { window = 20, perLeg = 5, chunkNote = null } = {}) {
  if (!Array.isArray(ranked) || !legHeads) return ranked
  const noteOfChunk = new Map(ranked.map((r) => [r.chunkId, r.noteId]))
  if (chunkNote) for (const [c, n] of chunkNote) if (!noteOfChunk.has(c)) noteOfChunk.set(c, n)
  const want = []
  for (const leg of Object.values(legHeads)) {
    for (const c of (Array.isArray(leg) ? leg : []).slice(0, perLeg)) {
      const n = noteOfChunk.get(c)
      if (n && !want.includes(n)) want.push(n)
    }
  }
  const pos = new Map(ranked.map((r, i) => [r.noteId, i]))
  const missing = want.filter((n) => pos.has(n) && pos.get(n) >= window)
  if (missing.length === 0) return ranked
  const moved = new Set(missing)
  const rest = ranked.filter((r) => !moved.has(r.noteId))
  const keep = Math.max(0, window - missing.length)
  return [...rest.slice(0, keep), ...missing.map((n) => ranked[pos.get(n)]), ...rest.slice(keep)]
}
