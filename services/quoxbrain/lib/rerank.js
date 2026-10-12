// rerank.js — BRAIN2-W11 B: opt-in LLM reranker client + orchestration.
//
// User content goes to a third-party AI only when the org switched
// BRAIN_RERANK_ENABLED on (brainConfig.resolveRerankEnabled, fail closed).
// The collector's POST /internal/rerank does the governed LLM call. Any
// failure or timeout keeps the fused order and is reported as 'failed'; a
// guessed order is never applied.

import { resolveRerankEnabled } from './brainConfig.js'

export const RERANK_TOP_N = 20
export const RERANK_TOP_N_EXPANDED = 30 // W13 C: wider pool when query expansion widened candidate generation
export const RERANK_TEXT_CAP = 800 // CORTEX-BENCH: 400 hid the answer in most notes; the reranker judged blind
export const DEFAULT_RERANK_TIMEOUT_MS = 6000

const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`

function timeoutOf(deps) {
  if (Number.isFinite(deps.rerankTimeoutMs) && deps.rerankTimeoutMs > 0) return deps.rerankTimeoutMs
  const n = Number(process.env.QUOXBRAIN_RERANK_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RERANK_TIMEOUT_MS
}

/** Calls the collector. Returns {ok:true, order:[ids], model} or {ok:false}. Never throws. */
export async function callCollectorRerank(orgId, query, items, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '')
  if (!serviceKey || !orgId) return { ok: false }
  // One deadline covers both attempts (2026-10-11: connection-level failures
  // during collector stall bursts let off-topic questions through unvetoed).
  const signal = AbortSignal.timeout(timeoutOf(deps))
  const body = JSON.stringify({ query, candidates: items.map((i) => ({ id: i.id, text: String(i.text || '').slice(0, RERANK_TEXT_CAP) })), ...(deps.dated ? { dated: true } : {}) })
  const send = () => fetchImpl(`${collectorUrl}/internal/rerank`, {
    method: 'POST',
    headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId, 'Content-Type': 'application/json' },
    body,
    signal,
  })
  try {
    let res
    try {
      res = await send()
    } catch (err) {
      // Read-only call: retry once when the collector never answered
      // (reset, refused), never after a timeout.
      if (signal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err
      console.warn(`[QuoxBrain rerank] retrying once for org=${orgId}: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`)
      res = await send()
    }
    if (!res.ok) return { ok: false }
    const data = await res.json()
    const ids = new Set(items.map((i) => i.id))
    if (!Array.isArray(data?.order)) return { ok: false }
    // W12 C: order lists only the passages that answer the query (may be empty).
    // Unknown ids and duplicates are ignored, never trusted.
    const seen = new Set()
    const order = []
    for (const id of data.order) { if (typeof id === 'string' && ids.has(id) && !seen.has(id)) { seen.add(id); order.push(id) } }
    return { ok: true, order, model: data.model || null }
  } catch (err) {
    console.error(`[QuoxBrain rerank] failed for org=${orgId}: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`)
    return { ok: false }
  }
}

/**
 * @param {object} p
 * @param {string} p.orgId
 * @param {string} p.query
 * @param {object[]} p.ranked    fused-order items
 * @param {(item) => string} p.idOf    stable id per item
 * @param {(item) => string} [p.textOf]  passage text per item
 * @param {(head: object[]) => Map<string,string>} [p.loadTexts]  lazy bulk text lookup, only called once rerank is going ahead
 * @param {boolean} p.insufficient     abstention verdict: never rerank when true
 * @param {boolean|undefined} p.override  service-key eval override (true|false) or undefined
 * @returns {Promise<{ranked: object[], rerank?: 'llm'|'failed'|'skipped', rerankVerdict?: 'none', insufficient?: true, model?: string|null}>}
 */
// CORTEX-BENCH: a note chunk that opens with YAML frontmatter spent most of
// the 400-char rerank window on bookkeeping (metadata, node_type, session ids,
// timestamps). Keep only the human fields (name/title/description) so the
// window carries what the note says.
const FM_KEEP = /^(name|title|description|summary):/i
export function compactFrontmatter(text) {
  const t = String(text || '')
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return t
  const kept = m[1].split(/\r?\n/).filter((l) => FM_KEEP.test(l.trim())).map((l) => l.trim()).join('\n')
  return `${kept ? `${kept}\n` : ''}${t.slice(m[0].length)}`
}

const TITLE_STOP = new Set('the a an and or of for to in on with by from at is are was be this that note part plan stream'.split(' '))
function titleWords(t) {
  return new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !TITLE_STOP.has(w)))
}
function sharedSubjectIds(head, idOf) {
  const words = head.map((r) => titleWords(r.title))
  const out = new Set()
  for (let i = 0; i < head.length; i++) {
    for (let j = i + 1; j < head.length; j++) {
      let n = 0
      for (const w of words[i]) if (words[j].has(w)) n += 1
      if (n >= 2) { out.add(String(idOf(head[i]))); out.add(String(idOf(head[j]))) }
    }
  }
  return out
}

export async function maybeRerank({ orgId, query, ranked, idOf, textOf, loadTexts, insufficient, override, topN = RERANK_TOP_N, dated = false }, deps = {}) {
  if (!Array.isArray(ranked)) return { ranked }
  const enabled = typeof override === 'boolean' ? override : await resolveRerankEnabled(orgId, deps)
  if (!enabled) return { ranked }
  // Enabled but nothing to do: report 'skipped' so telemetry can tell a measured
  // reranker from one that never ran.
  if (insufficient || ranked.length < 2) return { ranked, rerank: 'skipped' }
  const head = ranked.slice(0, topN)
  const texts = loadTexts ? await loadTexts(head) : null
  // CORTEX-BENCH: the passage alone often hides what the note IS (a curated
  // memory's descriptive title, an incident name); the reranker sees the title
  // first. Same RERANK_TEXT_CAP applies to the combined text.
  // 2026-10-11 'auto': date only passages whose title shares two or more
  // content words with another passage's title (likely the same subject, so a
  // possible old-vs-new conflict); unrelated passages carry no date.
  const datedIds = dated === 'auto' ? sharedSubjectIds(head, idOf) : null
  const items = head.map((r) => {
    const body = compactFrontmatter((texts && texts.get(String(idOf(r)))) || (textOf ? textOf(r) : '') || '')
    const title = typeof r.title === 'string' && r.title.trim() && !body.startsWith(r.title) ? `[${r.title.trim()}] ` : ''
    // 2026-10-11 (opt-in): the passage's date, so the reranker can put the
    // current answer above a superseded one when they disagree.
    const day = (dated === true || (datedIds && datedIds.has(String(idOf(r))))) ? String(r.occurredAt || r.updatedAt || '').slice(0, 10) : ''
    const when = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `(dated ${day}) ` : ''
    return { id: String(idOf(r)), text: title + when + body }
  })
  const anyDated = items.some((i) => /\(dated \d{4}-\d{2}-\d{2}\) /.test(i.text))
  const out = await (deps.callRerank || callCollectorRerank)(orgId, query, items, anyDated ? { ...deps, dated: true } : deps)
  if (!out || !out.ok) return { ranked, rerank: 'failed' }
  // The model says nothing answers the query: abstain (the main abstention win).
  if (out.order.length === 0) return { ranked, rerank: 'llm', rerankVerdict: 'none', insufficient: true, model: out.model || null }
  const byId = new Map(head.map((r) => [String(idOf(r)), r]))
  const listed = new Set(out.order)
  const rest = ranked.filter((r, i) => i >= topN || !listed.has(String(idOf(r))))
  return { ranked: [...out.order.map((id) => byId.get(id)), ...rest], rerank: 'llm', model: out.model || null }
}

export default { maybeRerank, callCollectorRerank, RERANK_TOP_N }
