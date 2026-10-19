// embeddingClient.js — Brain2 P4-WP1 embedding seam client
// (docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase F,
//  docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md §P4)
//
// Talks to the collector's POST /internal/embed (server.js, wrapping
// routes/quoxchat.js's embedText — Gemini gemini-embedding-001, 768-dim)
// over X-Service-Key, the same service-to-service convention as
// lib/quoxDream.js's collector calls and readers/lib/brainClient.mjs.
//
// Best-effort throughout, mirroring quoxDream.js's extractBeliefs contract:
// any network/HTTP failure returns [] rather than throwing, so a caller
// (e.g. the P4 indexer) never crashes a slice over one embedding-service
// hiccup. Individual `null` entries from the collector (a single text the
// provider couldn't embed) are preserved and NOT converted to [] — only a
// total request failure collapses to [].
//
// Every network call goes through an injectable deps param (fetchImpl/
// collectorUrl/serviceKey) so this module is fully unit-testable with no
// network, same shape as lib/quoxDream.js's resolveDeps().

import { getInstanceSetting } from './configResolver.js'

const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || ''

// Bound each batch call so a slow/wedged collector can't hang embedTexts
// (and therefore the embedding backfill scheduler) indefinitely holding a
// connection, using the same rationale and AbortSignal.timeout() mechanism
// as lib/quoxDream.js's EXTRACT_TIMEOUT_MS. 45s is proportional to a full
// 64-text batch (the collector's own EMBED_BATCH_CAP, see BATCH_SIZE below)
// against Gemini's embedding API; overridable via QUOXBRAIN_EMBED_TIMEOUT_MS
// or deps.timeoutMs (tests).
const EMBED_TIMEOUT_MS_ENV_DEFAULT = Number(process.env.QUOXBRAIN_EMBED_TIMEOUT_MS) || 45000

// Dimensionality of vectors returned by the collector's embedder — matches
// QDRANT_VECTOR_SIZE server-side (routes/quoxchat.js) and the
// chunk_embeddings.dim column (migrations/001-chunks.sql).
const EMBED_DIM = 768

// Mirrors the collector's own per-call cap (server.js /internal/embed,
// lib/internalEmbedHandler.js EMBED_BATCH_CAP) — batching below it means
// every request this client sends is accepted, never 400'd.
const BATCH_SIZE = 64

// ADAPTIVE SPLIT ON TIMEOUT (2026-08-31 poison-batch incident, org
// 01KKNKH398KKEWB36JXRYR70QH): a single oversized/slow text anywhere in a
// batch of up to BATCH_SIZE made the WHOLE batch time out, and the old
// contract treated ANY batch-level failure — timeout included — as total
// failure, discarding every text in the batch (good and bad alike) with no
// way to ever separate them. That permanently blocked the org's queue: 372
// docs never embedded across every attempt while other orgs' batches (no
// poison text) embedded fine in the same 45s window.
//
// A batch that times out is now bisected and each half retried
// independently, recursively, down to a single text — so a batch's good
// texts still embed and only the actual poison text(s) narrow out. Only a
// TIMEOUT triggers bisection: a non-ok HTTP response, a malformed response
// body, or a non-timeout network error means the seam itself is down, not
// one bad text, so those keep the pre-existing "abort the whole call"
// contract untouched (bisecting into a down collector would just multiply
// failed requests against a dead endpoint for no benefit).
//
// A single-text "batch" that still times out gets a few extra attempts in
// case it was a transient provider blip, then is retired: its vector comes
// back `null` same as a provider-declined text, but flagged in the
// `timedOutRetired` array so a caller with durable storage (embeddingBackfill.js)
// can distinguish "the provider explicitly declined this text" (safe to
// keep retrying — the text may embed fine once the provider issue clears)
// from "this text itself cannot be sent in bounded time" (must be durably
// retired, or it blocks the org's queue forever, which is exactly this
// incident).
const SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS = 2

// PER-TICK BISECTION BUDGET (2026-08-31 systemic-slowness incident, live on
// quox-brain): the adaptive bisection above assumes failures are RARE — one
// poison text in an otherwise-healthy batch. When the embed endpoint is
// SYSTEMICALLY slow (box under load, not one bad text), EVERY batch times
// out, and unbounded recursive bisection turns one failing top-level batch
// into O(N) sequential aborted 45s fetches — hundreds of
// AbortController/socket teardowns per tick, pegging the process at ~99.6%
// CPU (70% system time) and starving health probes. Log signature:
// alternating "500 failed" / "25 embedded" ticks.
//
// Bound it: embedTextsDetailed() gives itself a total sub-call budget of
// BISECTION_BUDGET_PER_BATCH per INITIALLY-PLANNED top-level batch call
// (splitIntoBatches' batches.length, pre-bisection), shared across the
// whole call. BISECTION_BUDGET_PER_BATCH (16) is sized with headroom above
// the worst case to fully isolate ONE poison text within a single
// BATCH_SIZE=64 batch — at each of ~log2(64)=6 split levels, one call
// resolves the clean sibling and one call re-attempts the still-timing-out
// half before splitting again, plus SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS calls
// to retire the final single-text leaf: 2*6 + 2 = 14 sub-calls worst case.
// So the "rare failure, isolate the one poison text" contract this module
// exists for (ADAPTIVE SPLIT ON TIMEOUT above) always has room to complete
// — the budget only ever engages for GENUINE multi-failure amplification
// within a tick, not the ordinary one-poison-text case. Once exhausted, any
// batch/half that would still need a request is instead marked
// `budgetExhausted` and its texts given up on for THIS call, with NO
// further request sent — those texts are ordinary `failed` in
// embeddingBackfill.js (not retired: budget running out says nothing about
// whether the text itself is bad), so a healthy tick later gets a normal
// shot at them. Overridable via deps.bisectionBudgetPerBatch (tests).
const BISECTION_BUDGET_PER_BATCH = 16

// VAULT-INTEG P17: QUOXBRAIN_EMBED_TIMEOUT_MS is an instance-wide tuning
// knob (a tool-executor-style timeout, not a per-org policy choice — mirrors
// collector's own PERPLEXITY_TIMEOUT treatment) — resolved fresh on every
// embedTextsDetailed() call via configResolver.getInstanceSetting(), env
// fallback on any resolver failure (no service key, network error, no
// override stored). deps.timeoutMs (tests) still wins over both.
async function resolveEmbedTimeoutMs(deps) {
  if (Number.isFinite(deps.timeoutMs)) return deps.timeoutMs
  try {
    const resolved = await getInstanceSetting('QUOXBRAIN_EMBED_TIMEOUT_MS', deps)
    if (resolved && resolved.value !== undefined) {
      const n = Number(resolved.value)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch (err) {
    console.error(`[EmbedClient] QUOXBRAIN_EMBED_TIMEOUT_MS instance-setting resolver failed, falling back to env — ${err.message}`)
  }
  return EMBED_TIMEOUT_MS_ENV_DEFAULT
}

async function resolveDeps(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl || fetch,
    collectorUrl: deps.collectorUrl || COLLECTOR_URL_DEFAULT,
    serviceKey: deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT,
    // Optional — org-scopes the collector's provider-key resolution
    // (server.js getProviderKeys) so BYOK keys can resolve for internal
    // embed callers. Omitted entirely from the request body when not
    // given, so callers with no org context keep working unchanged
    // (instance/legacy keys via the collector's merged fallback).
    orgId: deps.orgId,
    model: deps.model || undefined,
    timeoutMs: await resolveEmbedTimeoutMs(deps),
    bisectionBudgetPerBatch: Number.isFinite(deps.bisectionBudgetPerBatch) ? deps.bisectionBudgetPerBatch : BISECTION_BUDGET_PER_BATCH,
  }
}

function splitIntoBatches(items, batchSize) {
  const batches = []
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize))
  }
  return batches
}

/** A single, unretried POST to /internal/embed for exactly `batch`.
 * Returns one of:
 *   { outcome: 'ok', vectors, models }
 *   { outcome: 'timeout' }  — AbortSignal fired (bisection-eligible)
 *   { outcome: 'error' }    — non-ok HTTP, malformed body, or any other
 *                             thrown error (NOT bisection-eligible)
 */
async function postEmbedBatch(batch, { fetchImpl, collectorUrl, serviceKey, orgId, timeoutMs, model }) {
  // A manual AbortController + setTimeout, NOT AbortSignal.timeout(): the
  // bisection retry path (SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS) calls this
  // function sequentially more than once per embedTextsDetailed() call, and
  // AbortSignal.timeout()'s single-fire internal timer does not reliably
  // re-arm across sequential awaited calls in this runtime — a second
  // sequential AbortSignal.timeout(ms) can simply never fire, hanging the
  // retry forever. A plain AbortController fires every time.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = { texts: batch }
    if (orgId) body.org_id = orgId
    // BRAIN2-W11: explicit embedding model (query embed in the previous space
    // during a model migration). Omitted -> collector uses BRAIN_EMBED_MODEL.
    if (model) body.model = model
    const res = await fetchImpl(`${collectorUrl}/internal/embed`, {
      method: 'POST',
      headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Bound the call so a slow/wedged collector can't make embedTexts
      // (and downstream, the embedding backfill scheduler) hang
      // indefinitely holding a connection. A timeout just fails this
      // batch (bisection-eligible, see SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS
      // above) rather than stalling the process.
      signal: controller.signal,
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[embeddingClient] /internal/embed HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      return { outcome: 'error' }
    }

    const data = await res.json()
    if (!Array.isArray(data?.vectors)) {
      console.error('[embeddingClient] /internal/embed response missing vectors array')
      return { outcome: 'error' }
    }

    // Pre-models collectors (or a malformed response) report no per-text
    // model — align with nulls rather than trusting the legacy top-level
    // `model` field, which was a hardcoded constant that mis-stamped rows.
    const models = Array.isArray(data.models) && data.models.length === data.vectors.length
      ? data.models
      : data.vectors.map(() => null)
    return { outcome: 'ok', vectors: data.vectors, models }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || controller.signal.aborted) {
      console.warn(`[embeddingClient] /internal/embed timed out after ${timeoutMs}ms for a batch of ${batch.length} text(s)`)
      return { outcome: 'timeout' }
    }
    console.error('[embeddingClient] /internal/embed request failed:', err?.message)
    return { outcome: 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/** All texts in `batch` given up on without (further) requests — either the
 * per-tick bisection budget ran out, or (from probeFirstBatch) the endpoint
 * was judged down. Shape matches embedBatchAdaptive's normal return, with
 * every text flagged `budgetExhausted` and `vectors`/`models` null. */
function budgetExhaustedResult(batch) {
  return {
    vectors: batch.map(() => null),
    models: batch.map(() => null),
    timedOutRetired: batch.map(() => false),
    budgetExhausted: batch.map(() => true),
  }
}

function combineAdaptive(left, right) {
  return {
    vectors: [...left.vectors, ...right.vectors],
    models: [...left.models, ...right.models],
    timedOutRetired: [...left.timedOutRetired, ...right.timedOutRetired],
    budgetExhausted: [...left.budgetExhausted, ...right.budgetExhausted],
  }
}

/** Retries a single-text "batch" up to SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS
 * times, budget-guarded, starting the count from `attemptsAlreadyMade` (so a
 * caller — probeFirstBatch — that already spent one attempt probing this
 * text at a higher level doesn't spend a duplicate extra attempt). */
async function retrySingleText(batch, ctx, budgetState, attemptsAlreadyMade) {
  let attempt = attemptsAlreadyMade
  for (;;) {
    if (budgetState.remaining <= 0) return budgetExhaustedResult(batch)
    attempt += 1
    budgetState.remaining -= 1
    const r = await postEmbedBatch(batch, ctx)
    if (r.outcome === 'ok') return { vectors: r.vectors, models: r.models, timedOutRetired: [false], budgetExhausted: [false] }
    if (r.outcome === 'error') return { failedAll: true }
    // r.outcome === 'timeout'
    if (attempt >= SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS) {
      console.warn(`[embeddingClient] a single text timed out ${attempt} time(s) in a row and is being retired — it will not be retried again this call`)
      return { vectors: [null], models: [null], timedOutRetired: [true], budgetExhausted: [false] }
    }
  }
}

/**
 * Embeds `batch`, bisecting recursively on timeout (see the ADAPTIVE SPLIT
 * ON TIMEOUT comment above), budget-guarded (see BISECTION_BUDGET_PER_BATCH
 * above) at every recursive entry. Returns either:
 *   { vectors, models, timedOutRetired, budgetExhausted } — all aligned 1:1
 *     with `batch`; timedOutRetired[i] is true only for a single text that
 *     exhausted SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS attempts and was retired
 *     (vectors[i] is null); budgetExhausted[i] is true only for a text
 *     given up on because the tick's sub-call budget ran out (vectors[i]
 *     also null, but NOT a timeout retirement — see budgetExhaustedResult).
 *   { failedAll: true } — a non-timeout failure occurred anywhere in this
 *     batch's recursion; the whole top-level call must abort per the
 *     pre-existing best-effort contract (caller returns { vectors: [],
 *     models: [] }).
 */
async function embedBatchAdaptive(batch, ctx, budgetState) {
  if (budgetState.remaining <= 0) return budgetExhaustedResult(batch)

  if (batch.length === 1) return retrySingleText(batch, ctx, budgetState, 0)

  budgetState.remaining -= 1
  const r = await postEmbedBatch(batch, ctx)
  if (r.outcome === 'ok') return { vectors: r.vectors, models: r.models, timedOutRetired: batch.map(() => false), budgetExhausted: batch.map(() => false) }
  if (r.outcome === 'error') return { failedAll: true }

  // Timeout on a multi-text batch: bisect and retry each half
  // independently, recursively, min batch size 1 — each recursive call
  // re-checks the budget at its own entry above, so a run of consecutive
  // failures can't multiply into unbounded sub-calls.
  const mid = Math.ceil(batch.length / 2)
  const left = await embedBatchAdaptive(batch.slice(0, mid), ctx, budgetState)
  if (left.failedAll) return left
  const right = await embedBatchAdaptive(batch.slice(mid), ctx, budgetState)
  if (right.failedAll) return right
  return combineAdaptive(left, right)
}

/**
 * ENDPOINT-DOWN FAST-FAIL (2026-08-31 systemic-slowness incident): runs
 * ONLY for the very first top-level batch of a tick. A single batch timing
 * out is the ordinary "one poison text" case the bisection above already
 * handles — but if the batch AND both its immediate halves (one level of
 * bisection, tested directly here rather than via full recursion) ALL time
 * out, that's not one bad text, the endpoint itself isn't answering.
 * Returns { endpointDown: true } in that case so the caller can fail the
 * rest of the tick fast with no further requests (the exact O(N)
 * aborted-fetch storm this fixes). Otherwise falls back to the normal
 * budgeted adaptive bisection (embedBatchAdaptive) for this batch — the
 * ordinary path, taken whenever the endpoint isn't judged down.
 */
async function probeFirstBatch(batch, ctx, budgetState) {
  if (budgetState.remaining <= 0) return budgetExhaustedResult(batch)
  budgetState.remaining -= 1
  const top = await postEmbedBatch(batch, ctx)
  if (top.outcome === 'ok') return { vectors: top.vectors, models: top.models, timedOutRetired: batch.map(() => false), budgetExhausted: batch.map(() => false) }
  if (top.outcome === 'error') return { failedAll: true }

  // top.outcome === 'timeout'. Only test "both immediate halves" when
  // there's something to split — a single-text first batch can't be
  // narrowed further by this check; continue its retry loop from the
  // attempt already spent above rather than restarting the attempt count
  // (which would let it exceed SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS).
  if (batch.length === 1) return retrySingleText(batch, ctx, budgetState, 1)

  if (batch.length > 1) {
    const mid = Math.ceil(batch.length / 2)
    const leftBatch = batch.slice(0, mid)
    const rightBatch = batch.slice(mid)

    if (budgetState.remaining > 0) {
      budgetState.remaining -= 1
      const leftTop = await postEmbedBatch(leftBatch, ctx)

      if (leftTop.outcome === 'timeout') {
        if (budgetState.remaining > 0) {
          budgetState.remaining -= 1
          const rightTop = await postEmbedBatch(rightBatch, ctx)
          if (rightTop.outcome === 'timeout') {
            return { endpointDown: true }
          }
          // Right resolved (ok/error) — not confirmed down. Left is already
          // known to have timed out at its own top-level attempt; continue
          // bisecting it (budget-guarded), and use right's already-fetched
          // result directly rather than re-asking. A single-text left
          // continues its retry count from the attempt already spent above
          // (same reasoning as the batch.length === 1 branch); a multi-text
          // left re-attempts its own "whole half" call once more inside the
          // ordinary recursion — one extra call, but no attempt-count
          // contract to violate there.
          const leftResult = leftBatch.length === 1
            ? await retrySingleText(leftBatch, ctx, budgetState, 1)
            : await embedBatchAdaptive(leftBatch, ctx, budgetState)
          if (leftResult.failedAll) return leftResult
          if (rightTop.outcome === 'error') return { failedAll: true }
          const rightResult = { vectors: rightTop.vectors, models: rightTop.models, timedOutRetired: rightBatch.map(() => false), budgetExhausted: rightBatch.map(() => false) }
          return combineAdaptive(leftResult, rightResult)
        }
        // Budget ran out before we could test the right half — can't
        // confirm down; treat the rest of this batch as budget-exhausted.
        return budgetExhaustedResult(batch)
      }

      // Left resolved (ok/error) at its own top-level attempt — not
      // confirmed down. Use it directly, continue the ordinary algorithm on
      // the right half.
      if (leftTop.outcome === 'error') return { failedAll: true }
      const leftResult = { vectors: leftTop.vectors, models: leftTop.models, timedOutRetired: leftBatch.map(() => false), budgetExhausted: leftBatch.map(() => false) }
      const rightResult = await embedBatchAdaptive(rightBatch, ctx, budgetState)
      if (rightResult.failedAll) return rightResult
      return combineAdaptive(leftResult, rightResult)
    }
  }

  // Not confirmed down (single-text batch, or budget ran out mid-probe) —
  // fall back to the normal budgeted adaptive bisection for this batch.
  return embedBatchAdaptive(batch, ctx, budgetState)
}

/**
 * Batch-embed a list of texts via the collector's /internal/embed seam.
 *
 * @param {string[]} texts
 * @param {object} [deps] — injectable { fetchImpl, collectorUrl, serviceKey, orgId }.
 *   `orgId`, when given, is sent as `org_id` in the request body so the
 *   collector can resolve org-scoped BYOK provider keys; omitted from the
 *   body entirely when not given (backward compatible — instance/legacy
 *   keys still resolve via the collector's merged fallback).
 * @returns {Promise<Array<number[]|null>>} one entry per input text, aligned
 *   by index; `null` where the collector couldn't produce a vector for that
 *   text (or where it timed out repeatedly and was retired — see
 *   embedTextsDetailed's `timedOutRetired`). Returns [] (best-effort) if the
 *   request itself fails outright — callers should treat a shorter-than-input
 *   result as "embedding unavailable for this batch" and skip dense
 *   indexing for it.
 */
async function embedTexts(texts, deps = {}) {
  const { vectors } = await embedTextsDetailed(texts, deps)
  return vectors
}

/**
 * Like embedTexts, but also surfaces which model ACTUALLY produced each
 * vector — { vectors, models, timedOutRetired }, all aligned by input index.
 *
 * BRAIN2-SEMANTIC (2026-08-25): the collector's embedText picks OpenAI or
 * Gemini per call depending on which keys resolve, and those two models
 * produce vectors in unrelated spaces (cosine across them is noise). Any
 * caller that STORES a vector (embeddingBackfill) or COMPARES one against
 * stored vectors (contextAssembler's dense leg) must know the real model;
 * `models[i]` is null where the vector is null or a legacy collector didn't
 * report it.
 *
 * `timedOutRetired[i]` (2026-08-31 poison-batch incident) is true only when
 * `vectors[i]` is null BECAUSE that single text timed out
 * SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS times in a row and was given up on, as
 * opposed to the provider responding 200 and explicitly declining that text
 * (ordinary null, timedOutRetired[i] false). A caller with durable storage
 * uses this to retire a genuinely poison text permanently rather than
 * retrying it forever.
 *
 * `budgetExhausted[i]` / `endpointDown[i]` (2026-08-31 systemic-slowness
 * incident, see BISECTION_BUDGET_PER_BATCH and probeFirstBatch above) are
 * true only when `vectors[i]` is null because this text's sub-call was
 * never (re)sent — the tick's per-call bisection budget ran out, or the
 * embed endpoint was judged down for the rest of this call. Unlike
 * timedOutRetired, neither says anything about the text itself, so a caller
 * with durable storage must NOT retire these — they stay retry-eligible.
 *
 * Total request failure returns { vectors: [], models: [] } (no
 * timedOutRetired/budgetExhausted/endpointDown — a shorter-than-input
 * vectors array is itself the total-failure signal, per embedTexts'
 * existing contract).
 */
async function embedTextsDetailed(texts, deps = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return { vectors: [], models: [] }

  const ctx = await resolveDeps(deps)
  const batches = splitIntoBatches(texts, BATCH_SIZE)
  const results = []
  const models = []
  const timedOutRetired = []
  const budgetExhausted = []
  const endpointDown = []

  // PER-TICK BISECTION BUDGET: one shared budget for this whole call (see
  // BISECTION_BUDGET_PER_BATCH above), sized off the batches this call
  // ITSELF planned (pre-bisection) — every top-level batch attempt, every
  // recursive half, and every single-text retry spends from it.
  const budgetState = { remaining: batches.length * ctx.bisectionBudgetPerBatch, warnedExhausted: false }
  let endpointDownForRest = false

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]

    if (endpointDownForRest) {
      results.push(...batch.map(() => null))
      models.push(...batch.map(() => null))
      timedOutRetired.push(...batch.map(() => false))
      budgetExhausted.push(...batch.map(() => false))
      endpointDown.push(...batch.map(() => true))
      continue
    }

    // ENDPOINT-DOWN FAST-FAIL only ever runs its extra probe for the FIRST
    // top-level batch of the call — that's the only place "the endpoint
    // itself is down, not one poison text" can be told apart cheaply (see
    // probeFirstBatch above). Every other batch uses the ordinary budgeted
    // bisection.
    const r = bi === 0 ? await probeFirstBatch(batch, ctx, budgetState) : await embedBatchAdaptive(batch, ctx, budgetState)

    if (r.endpointDown) {
      endpointDownForRest = true
      console.warn('[embeddingClient] embed endpoint unresponsive, failing fast for this tick (first batch and both its immediate halves all timed out)')
      results.push(...batch.map(() => null))
      models.push(...batch.map(() => null))
      timedOutRetired.push(...batch.map(() => false))
      budgetExhausted.push(...batch.map(() => false))
      endpointDown.push(...batch.map(() => true))
      continue
    }
    if (r.failedAll) return { vectors: [], models: [] }

    if (!budgetState.warnedExhausted && r.budgetExhausted.some(Boolean)) {
      budgetState.warnedExhausted = true
      console.warn(`[embeddingClient] per-tick bisection budget (${batches.length * ctx.bisectionBudgetPerBatch} sub-call(s)) exhausted — remaining text(s) in this tick are being counted failed without further splitting`)
    }

    results.push(...r.vectors)
    models.push(...r.models)
    timedOutRetired.push(...r.timedOutRetired)
    budgetExhausted.push(...r.budgetExhausted)
    endpointDown.push(...batch.map(() => false))
  }

  return { vectors: results, models, timedOutRetired, budgetExhausted, endpointDown }
}

// BRAIN2-AUDIT 2026-10-05: single-query embeds (search/context) cost 220-265ms
// per request (2.5s cold) through the collector. Identical queries are common
// (retries, UI re-fires, agent loops), so cache successful results in-process.
// Keyed by org + normalized query; the value carries the model the collector
// actually used. Failures (empty/short vectors, null vector) are never cached.
const QUERY_CACHE_MAX = 500
const QUERY_CACHE_TTL_MS = 30 * 60 * 1000
const queryEmbedInflight = new Map() // key -> pending embedTextsDetailed promise
const queryEmbedCache = new Map() // key -> { vector, model, expiresAt } (insertion order = LRU order)

function queryCacheKey(orgId, query, model) {
  return `${orgId || ''}\u0000${model || ''}\u0000${String(query).toLowerCase().replace(/\s+/g, ' ').trim()}`
}

// Circuit breaker (2026-10-15, SITE-CLI/HYPERION): with the provider on 429
// (quota gone) every /brain/context still waited the full interactive bound
// for a vector that never came, so the collector's 2.5s BrainImplant timed out
// on EVERY turn. Per org: after BREAKER_THRESHOLD straight failures, query
// embeds are skipped (sparse only, at once) for a cooldown that doubles on each
// failed probe, capped. One success closes it. Cache hits are still served.
const BREAKER_THRESHOLD = 3
const BREAKER_BASE_MS = 60 * 1000
const BREAKER_MAX_MS = 10 * 60 * 1000
const queryEmbedBreaker = new Map() // orgId -> { fails, openUntil, cooldownMs }

function breakerState(orgId) {
  const k = orgId || ''
  let b = queryEmbedBreaker.get(k)
  if (!b) { b = { fails: 0, openUntil: 0, cooldownMs: 0 }; queryEmbedBreaker.set(k, b) }
  return b
}

function breakerRecord(orgId, ok, now) {
  const b = breakerState(orgId)
  if (ok) { b.fails = 0; b.openUntil = 0; b.cooldownMs = 0; return }
  b.fails += 1
  if (b.fails < BREAKER_THRESHOLD) return
  b.cooldownMs = b.cooldownMs ? Math.min(b.cooldownMs * 2, BREAKER_MAX_MS) : BREAKER_BASE_MS
  b.openUntil = now() + b.cooldownMs
  console.warn(`[embeddingClient] query embeds failing (${b.fails} in a row, org=${orgId || '-'}); skipping them for ${Math.round(b.cooldownMs / 1000)}s, sparse-only meanwhile`)
}

export function _resetQueryEmbedCache() {
  queryEmbedCache.clear()
  queryEmbedInflight.clear()
  queryEmbedBreaker.clear()
}

/**
 * Same return shape as embedTextsDetailed for ONE text: { vectors:[v], models:[m] }.
 * deps.cacheMax / deps.cacheTtlMs override the limits (tests).
 */
export async function embedQueryCached(query, deps = {}) {
  const key = queryCacheKey(deps.orgId, query, deps.model)
  const now = Date.now()
  const hit = queryEmbedCache.get(key)
  if (hit && hit.expiresAt > now) {
    queryEmbedCache.delete(key)
    queryEmbedCache.set(key, hit) // refresh LRU position
    return { vectors: [hit.vector], models: [hit.model] }
  }
  if (hit) queryEmbedCache.delete(key)

  const clock = typeof deps.now === 'function' ? deps.now : Date.now
  const brk = breakerState(deps.orgId)
  if (brk.openUntil > clock()) return { vectors: [], models: [], skipped: 'embed_breaker_open' }

  // In-flight dedup (BRAIN2-AUDIT 2026-10-05): a cold embed takes 4-5s, longer
  // than the 1.5s interactive bound, so repeats of the same new query inside
  // that window each started a FRESH upstream embed, each timing out at 1.5s,
  // and the cache never filled (3 consecutive runs stayed 'fts'). Later
  // callers now join the pending embed instead.
  const pending = queryEmbedInflight.get(key)
  const embedding = pending || embedTextsDetailed([query], deps).then((res) => {
    const vector = res?.vectors?.[0]
    if (Array.isArray(vector) && vector.length > 0) {
      const max = Number.isFinite(deps.cacheMax) ? deps.cacheMax : QUERY_CACHE_MAX
      const ttl = Number.isFinite(deps.cacheTtlMs) ? deps.cacheTtlMs : QUERY_CACHE_TTL_MS
      queryEmbedCache.set(key, { vector, model: res.models?.[0] ?? null, expiresAt: Date.now() + ttl })
      while (queryEmbedCache.size > max) queryEmbedCache.delete(queryEmbedCache.keys().next().value)
      breakerRecord(deps.orgId, true, clock)
    } else {
      breakerRecord(deps.orgId, false, clock)
    }
    return res
  }, (err) => { breakerRecord(deps.orgId, false, clock); throw err }).finally(() => { queryEmbedInflight.delete(key) })
  if (!pending) queryEmbedInflight.set(key, embedding)

  // Interactive bound (BRAIN2-AUDIT 2026-10-05): a cold query embed took
  // 4-5s live, past the collector implant's 2.5s budget. Past queryTimeoutMs
  // this request gets no vector (callers fall back to sparse, visibly as
  // retrieval:'fts'); the embed keeps running and fills the cache, so the
  // next ask of the same question is hybrid. Background callers (backfill)
  // never pass queryTimeoutMs and keep the long timeout.
  const limit = deps.queryTimeoutMs
  if (!Number.isFinite(limit) || limit <= 0) return embedding
  embedding.catch(() => {}) // a late failure must not become an unhandled rejection
  const TIMED_OUT = Symbol('timedOut')
  const bound = (ms) => {
    let timer
    const p = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
    return { p, clear: () => clearTimeout(timer) }
  }
  const b1 = bound(limit)
  let res
  try {
    res = await Promise.race([embedding, b1.p])
  } finally {
    b1.clear()
  }
  if (res !== TIMED_OUT) return res

  // BRAIN2-W10 G adaptive wait: missed the interactive bound. When the sparse
  // result is weak (caller-supplied check) keep waiting on the SAME in-flight
  // embed for an extra budget; strong sparse keeps the fast fallback.
  let weak = false
  if (typeof deps.isSparseWeak === 'function') {
    try { weak = !!(await deps.isSparseWeak()) } catch { weak = false }
  }
  const extra = Number.isFinite(deps.weakExtraMs) ? deps.weakExtraMs : weakExtraMsDefault()
  if (weak && extra > 0) {
    const b2 = bound(extra)
    try {
      res = await Promise.race([embedding, b2.p])
    } finally {
      b2.clear()
    }
    if (res !== TIMED_OUT) return res
    console.warn(`[embeddingClient] query embed exceeded ${limit}+${extra}ms with weak sparse results; serving sparse-only (degraded)`)
  } else {
    console.warn(`[embeddingClient] query embed exceeded ${limit}ms; serving sparse-only now, cache fills when it lands`)
  }
  return { vectors: [], models: [], timedOut: true }
}

/** Extra wait (ms) past the interactive bound when the sparse result is weak. */
export function weakExtraMsDefault() {
  const n = Number(process.env.QUOXBRAIN_QUERY_EMBED_WEAK_EXTRA_MS)
  return process.env.QUOXBRAIN_QUERY_EMBED_WEAK_EXTRA_MS !== undefined && process.env.QUOXBRAIN_QUERY_EMBED_WEAK_EXTRA_MS !== '' && Number.isFinite(n) && n >= 0 ? n : 3500
}

export { embedTexts, embedTextsDetailed, EMBED_DIM, SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS, BISECTION_BUDGET_PER_BATCH }
