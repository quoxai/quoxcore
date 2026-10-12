// compare.mjs: held-out, comparative served eval (BRAIN2 W6).
//
//   node eval/compare.mjs [--out report.json] [--md report.md]
//
// Runs one question set (held-out paraphrases + near-miss negatives from
// eval/heldout/*.json) through ARMS and reports them side by side.
// Default (EVAL_FTS_URL unset): all arms run on the SAME BRAIN_URL using the
// per-request `retrieval` override on POST /brain/search (service-key callers
// only): arms fts, dense, hybrid. Legacy mode (EVAL_FTS_URL set): fts runs on
// that FTS-only instance (QUOXBRAIN_HYBRID_ENABLED=false), hybrid on BRAIN_URL
// with no override, and no dense arm. Each arm's response `retrieval` field is tallied and an arm whose
// path does not match its label is marked INVALID (never silently trusted).
// Hybrid is always reported, win or lose.
//
// Env (values never printed):
//   BRAIN_URL (default http://localhost:3106)  INTERNAL_SERVICE_KEY  EVAL_ORG_ID  EVAL_USER_ID
//   EVAL_FTS_URL            FTS-only instance (arm skipped, with reason, if unset)
//   EVAL_FTS_SERVICE_KEY    key for the FTS instance (default INTERNAL_SERVICE_KEY)
//   EVAL_MAX_JACCARD (0.3)  EVAL_MAX_COVERAGE (0.5)   overlap rejection limits
//   Gates, applied to the HYBRID arm: EVAL_MIN_RECALL5 (0.5) EVAL_MIN_NDCG10 (0.35)
//   EVAL_MIN_ABSTAIN_PRECISION (0.5) EVAL_MIN_ABSTAIN_RECALL (0.5)
// Read-only: POST /brain/search and GET /notes/:id. Each query logs a usage event.

import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ndcgAt, rankOf } from './served.mjs'
import { loadHeldout, filterByOverlap, DEFAULT_OVERLAP } from './heldout.mjs'

export function reciprocalRank(rank, k = 10) { return rank && rank <= k ? 1 / rank : 0 }

/** Lenient rank: best (lowest) 1-based rank of noteId or any acceptable id; null if none is present. */
export function lenientRank(noteIds, noteId, acceptable) {
  let best = rankOf(noteIds, noteId)
  for (const a of acceptable || []) {
    const r = rankOf(noteIds, a)
    if (r !== null && (best === null || r < best)) best = r
  }
  return best
}

/** Retrieval metrics over ranks (1-based or null). */
export function retrievalMetrics(ranks) {
  const n = ranks.length
  if (!n) return { n: 0, recallAt5: null, ndcgAt10: null, mrr: null }
  return {
    n,
    recallAt5: ranks.filter((r) => r && r <= 5).length / n,
    ndcgAt10: ranks.reduce((s, r) => s + ndcgAt(r, 10), 0) / n,
    mrr: ranks.reduce((s, r) => s + reciprocalRank(r), 0) / n
  }
}

/**
 * Abstention as a binary classifier where "abstain" is the positive class.
 * negatives: booleans, one per near-miss (true = system abstained = correct).
 * answerables: booleans, one per answerable query (true = system abstained = wrong).
 * precision = TP/(TP+FP), recall = TP/(TP+FN); null when the denominator is 0.
 */
export function abstentionMetrics(negatives, answerables) {
  const tp = negatives.filter(Boolean).length
  const fn = negatives.length - tp
  const fp = answerables.filter(Boolean).length
  const tn = answerables.length - fp
  return {
    truePositive: tp, falseNegative: fn, falsePositive: fp, trueNegative: tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null
  }
}

/** Gate check on one arm. Null metric = not measured = failure (never a silent pass). */
export function gateVerdict(arm, th) {
  const failures = []
  const chk = (name, v, min) => {
    if (!Number.isFinite(min)) return
    if (v === null || v === undefined) failures.push(`${name} not measured`)
    else if (v < min) failures.push(`${name} ${v.toFixed(3)} < ${min}`)
  }
  chk('recall@5', arm.retrieval.recallAt5, th.recall5)
  chk('nDCG@10', arm.retrieval.ndcgAt10, th.ndcg10)
  chk('abstention precision', arm.abstention.precision, th.abstainPrecision)
  chk('abstention recall', arm.abstention.recall, th.abstainRecall)
  return failures
}

/** Does the observed retrieval-path tally match the arm label? */
export function armValidity(label, paths) {
  const total = Object.values(paths).reduce((a, b) => a + b, 0)
  if (!total) return { valid: false, reason: 'no queries answered' }
  const want = label === 'fts' ? 'fts' : label === 'dense' ? 'dense' : 'hybrid'
  const got = paths[want] || 0
  return got === total ? { valid: true } : { valid: false, reason: `expected every query on '${want}' path, saw ${JSON.stringify(paths)}` }
}

/** Run the question set through one search function. search(query) -> { results, retrieval, insufficient }. */
export async function runArm(label, search, { paraphrases, nearMisses }) {
  const ranks = []
  const lenientRanks = []
  const paths = {}
  const perQuery = []
  const answerableAbstained = []
  let degraded = 0
  // BRAIN2-W12 C: rerank outcomes per response. 'off' = no rerank field (reranker not engaged).
  const rerank = { llm: 0, failed: 0, skipped: 0, off: 0, verdictNone: 0 }
  // BRAIN2-W13 C: query-expansion outcomes per response. 'off' = no expand field.
  const expand = { llm: 0, failed: 0, off: 0 }
  const tally = (r) => {
    expand[r.expand === 'llm' || r.expand === 'failed' ? r.expand : 'off'] += 1
    const k = r.retrieval || 'unknown'; paths[k] = (paths[k] || 0) + 1; if (r.degraded) degraded += 1
    const rr = r.rerank === 'llm' || r.rerank === 'failed' || r.rerank === 'skipped' ? r.rerank : 'off'
    rerank[rr] += 1
    if (r.rerankVerdict === 'none') rerank.verdictNone += 1
  }
  for (const p of paraphrases) {
    const s = await search(p.question)
    tally(s)
    const ids = (s.results || []).map((x) => x.noteId)
    const rank = rankOf(ids, p.noteId)
    const lRank = lenientRank(ids, p.noteId, p.acceptable)
    ranks.push(rank)
    lenientRanks.push(lRank)
    answerableAbstained.push(s.insufficient === true)
    perQuery.push({ kind: 'paraphrase', noteId: p.noteId, rank, lenientRank: lRank, insufficient: s.insufficient === true })
  }
  const negatives = []
  for (const n of nearMisses) {
    const s = await search(n.query)
    tally(s)
    negatives.push(s.insufficient === true)
    perQuery.push({ kind: 'near-miss', topic: n.topic, insufficient: s.insufficient === true, topResult: (s.results || [])[0]?.noteId ?? null })
  }
  const arm = { label, retrieval: retrievalMetrics(ranks), retrievalLenient: retrievalMetrics(lenientRanks), abstention: abstentionMetrics(negatives, answerableAbstained), retrievalPaths: paths, rerank, expand, perQuery }
  arm.validity = armValidity(label, paths)
  // BRAIN2-W10 G: degraded responses (dense leg wanted, no vector in time) are
  // counted, never silently mixed into the quality numbers.
  if (degraded > 0) arm.degraded = degraded
  return arm
}

/** Assemble the single JSON report. arms: { fts?: arm | { skipped: reason }, hybrid: arm }. */
export function buildReport({ config, heldout, arms, th }) {
  const hybrid = arms.hybrid
  const dense = arms.dense && !arms.dense.skipped ? arms.dense : null
  const fts = arms.fts && !arms.fts.skipped ? arms.fts : null
  const delta = fts && hybrid ? {
    recallAt5: diff(hybrid.retrieval.recallAt5, fts.retrieval.recallAt5),
    ndcgAt10: diff(hybrid.retrieval.ndcgAt10, fts.retrieval.ndcgAt10),
    mrr: diff(hybrid.retrieval.mrr, fts.retrieval.mrr),
    abstentionPrecision: diff(hybrid.abstention.precision, fts.abstention.precision),
    abstentionRecall: diff(hybrid.abstention.recall, fts.abstention.recall)
  } : null
  const failures = hybrid ? gateVerdict(hybrid, th) : ['hybrid arm missing']
  if (hybrid && !hybrid.validity.valid) failures.push(`hybrid arm invalid: ${hybrid.validity.reason}`)
  if (fts && !fts.validity.valid) failures.push(`fts arm invalid: ${fts.validity.reason}`)
  if (dense && !dense.validity.valid) failures.push(`dense arm invalid: ${dense.validity.reason}`)
  const degradedArms = Object.entries(arms).filter(([, a]) => a && a.degraded > 0).map(([k, a]) => `${k}: ${a.degraded}`)
  return {
    generatedAt: new Date().toISOString(),
    degradedArms,
    config,
    heldout,
    arms,
    hybridMinusFts: delta,
    gates: th,
    failures,
    verdict: failures.length ? 'FAIL' : 'PASS'
  }
}

function diff(a, b) { return a === null || b === null || a === undefined || b === undefined ? null : a - b }
const f3 = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(3))
const sgn = (v) => (v === null || v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`)

export function renderMarkdown(r) {
  const { fts, hybrid, dense } = r.arms
  const f = fts && !fts.skipped ? fts : null
  const dn = dense && !dense.skipped ? dense : null
  const row = (name, get, d) => `| ${name} | ${f ? f3(get(f)) : 'n/a'} | ${dn ? f3(get(dn)) : 'n/a'} | ${f3(get(hybrid))} | ${r.hybridMinusFts ? sgn(r.hybridMinusFts[d]) : 'n/a'} |`
  const rowL = (name, get) => `| ${name} | ${f ? f3(get(f)) : 'n/a'} | ${dn ? f3(get(dn)) : 'n/a'} | ${f3(get(hybrid))} | ${f && get(f) !== undefined && get(hybrid) !== undefined ? sgn(diff(get(hybrid), get(f))) : 'n/a'} |`
  const lines = [
    '# QuoxBrain held-out comparative eval',
    '',
    `Generated ${r.generatedAt}. Verdict: **${r.verdict}**.`,
    '',
    `Held-out set: ${r.heldout.paraphraseKept} paraphrases kept of ${r.heldout.paraphraseLoaded} loaded (${r.heldout.rejected} rejected for overlap or missing text), ${r.heldout.nearMisses} near-miss negatives. Overlap limits: Jaccard <= ${r.config.overlap.maxJaccard}, coverage <= ${r.config.overlap.maxCoverage}.`,
    '',
    'Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.',
    '',
    '| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |',
    '|---|---|---|---|---|',
    row('recall@5 (strict, noteId only)', (a) => a.retrieval.recallAt5, 'recallAt5'),
    row('nDCG@10 (strict, noteId only)', (a) => a.retrieval.ndcgAt10, 'ndcgAt10'),
    row('MRR (strict, noteId only)', (a) => a.retrieval.mrr, 'mrr'),
    rowL('recall@5 (lenient, noteId or acceptable)', (a) => a.retrievalLenient?.recallAt5),
    rowL('MRR (lenient, noteId or acceptable)', (a) => a.retrievalLenient?.mrr),
    row('abstention precision', (a) => a.abstention.precision, 'abstentionPrecision'),
    row('abstention recall', (a) => a.abstention.recall, 'abstentionRecall'),
    ''
  ]
  if (!f) lines.push(`FTS-only arm: ${fts?.skipped ? `skipped (${fts.skipped})` : 'absent'}. No comparison is claimed.`, '')
  if (!dn) lines.push(`Dense-only arm: ${dense?.skipped ? `skipped (${dense.skipped})` : 'absent'}.`, '')
  lines.push(`Retrieval paths seen: hybrid arm ${JSON.stringify(hybrid.retrievalPaths)}${f ? `, fts arm ${JSON.stringify(f.retrievalPaths)}` : ''}${dn ? `, dense arm ${JSON.stringify(dn.retrievalPaths)}` : ''}.`)
  for (const [name, a] of Object.entries(r.arms)) {
    const t = a && a.expand
    if (t && (t.llm + t.failed) > 0) {
      lines.push('', `Expand outcomes, ${name} arm: llm ${t.llm}, failed ${t.failed}, off ${t.off}.`)
      if (t.failed > 0 && t.llm === 0) lines.push(`WARNING: ${name} arm: every expansion failed, this run did NOT measure query expansion.`)
      else if (t.failed > 0) lines.push(`WARNING: ${name} arm: ${t.failed} of ${t.llm + t.failed} expansions failed; those queries used the original query only.`)
    }
  }
  for (const [name, a] of Object.entries(r.arms)) {
    const t = a && a.rerank
    if (t && (t.llm + t.failed + t.skipped) > 0) {
      lines.push('', `Rerank outcomes, ${name} arm: llm ${t.llm}, failed ${t.failed}, skipped ${t.skipped}, off ${t.off}, abstained by reranker ${t.verdictNone}.`)
      if (t.failed > 0 && t.llm === 0) lines.push(`WARNING: ${name} arm: every rerank failed, this run did NOT measure the reranker.`)
      else if (t.failed > 0) lines.push(`WARNING: ${name} arm: ${t.failed} of ${t.llm + t.failed} reranks failed; those queries kept the fused order.`)
    }
  }
  for (const [name, a] of Object.entries(r.arms)) {
    if (a && a.degraded > 0) lines.push('', `WARNING: ${name} arm degraded: ${a.degraded} (responses carried degraded:'dense_timeout'; quality numbers for this arm mix keyword-only results, rerun when the collector is healthy)`)
  }
  if (r.failures.length) lines.push('', 'Gate failures:', ...r.failures.map((x) => `- ${x}`))
  return lines.join('\n') + '\n'
}

function cfg() {
  const num = (k, d) => { const v = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(v) ? v : d }
  return {
    base: (process.env.BRAIN_URL || 'http://localhost:3106').replace(/\/+$/, ''),
    key: process.env.INTERNAL_SERVICE_KEY || '',
    ftsBase: (process.env.EVAL_FTS_URL || '').replace(/\/+$/, ''),
    ftsKey: process.env.EVAL_FTS_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY || '',
    orgId: process.env.EVAL_ORG_ID || '',
    userId: process.env.EVAL_USER_ID || 'service',
    overlap: { maxJaccard: num('EVAL_MAX_JACCARD', DEFAULT_OVERLAP.maxJaccard), maxCoverage: num('EVAL_MAX_COVERAGE', DEFAULT_OVERLAP.maxCoverage) },
    th: { recall5: num('EVAL_MIN_RECALL5', 0.5), ndcg10: num('EVAL_MIN_NDCG10', 0.35), abstainPrecision: num('EVAL_MIN_ABSTAIN_PRECISION', 0.5), abstainRecall: num('EVAL_MIN_ABSTAIN_RECALL', 0.5) }
  }
}

function http(base, key, orgId, userId) {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-Service-Key': key, 'X-Org-Id': orgId, 'X-User-Id': userId },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`)
    return res.json()
  }
}

/** Target text for the overlap check: whole note body if the read route returns it, else the chunk the search surfaces. */
async function targetText(call, noteId, question) {
  try {
    const n = await call('GET', `/notes/${encodeURIComponent(noteId)}`)
    const t = n.text ?? n.content ?? n.body
    if (typeof t === 'string' && t.trim()) return `${n.title || ''}\n${t}`
  } catch { /* unresolvable id or no read access: fall through, then reported as no-target-text */ }
  try {
    const s = await call('POST', '/brain/search', { query: question, limit: 50, includeText: true })
    const hit = (s.results || []).find((r) => r.noteId === noteId && typeof r.text === 'string')
    if (hit) return `${hit.title || ''}\n${hit.text}`
  } catch { /* leave undefined */ }
  return undefined
}

async function main() {
  const c = cfg()
  if (!c.key) { console.error('INTERNAL_SERVICE_KEY is required'); process.exit(2) }
  if (!c.orgId) { console.error('EVAL_ORG_ID is required'); process.exit(2) }
  const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null }
  const set = loadHeldout(arg('--dir') || undefined)
  if (!set.paraphrases.length && !set.nearMisses.length) { console.error('no held-out fixtures found in eval/heldout/ (files starting with _ are templates)'); process.exit(2) }
  const hybridCall = http(c.base, c.key, c.orgId, c.userId)
  const items = []
  for (const p of set.paraphrases) items.push({ ...p, targetText: await targetText(hybridCall, p.noteId, p.question) })
  const { kept, rejected } = filterByOverlap(items, c.overlap)
  console.log(`held-out: ${kept.length} kept, ${rejected.length} rejected of ${items.length} paraphrases`)
  for (const r of rejected) console.log(`  rejected ${r.noteId.slice(0, 8)}: ${r.reason}`)
  const questionSet = { paraphrases: kept, nearMisses: set.nearMisses }
  // EVAL_DENSE_WEIGHT: optional fusion-weight sweep (service-key callers only).
const evalDenseWeight = Number.isFinite(Number(process.env.EVAL_DENSE_WEIGHT)) && process.env.EVAL_DENSE_WEIGHT ? Number(process.env.EVAL_DENSE_WEIGHT) : undefined
const evalRerank = process.env.EVAL_RERANK === 'true' ? true : process.env.EVAL_RERANK === 'false' ? false : undefined // EVAL_RERANK: measure the opt-in LLM reranker (service key only)
// EVAL_KIND_PRIORS: optional JSON source-prior table for a sweep (service-key callers only).
let evalKindPriors
try { evalKindPriors = process.env.EVAL_KIND_PRIORS ? JSON.parse(process.env.EVAL_KIND_PRIORS) : undefined } catch { evalKindPriors = undefined }
const evalExpand = process.env.EVAL_EXPAND === 'true' ? true : process.env.EVAL_EXPAND === 'false' ? false : undefined // EVAL_EXPAND: measure opt-in query expansion (service key only)
// Codex cycle 6: the fts and dense arms are BASELINES, so they run plain (no
// LLM rerank, no query expansion); only the hybrid arm measures the product's
// rerank/expand settings. The report's per-arm rerank outcomes show 'off'.
const plainBaseline = (retrieval) => retrieval === 'fts' || retrieval === 'dense'
const searchOn = (call, retrieval) => (query) => call('POST', '/brain/search', { query, limit: 10, ...(retrieval ? { retrieval } : {}), ...(evalDenseWeight ? { denseWeight: evalDenseWeight } : {}), ...(plainBaseline(retrieval) ? { rerank: false, expand: false } : { ...(evalRerank !== undefined ? { rerank: evalRerank } : {}), ...(evalExpand !== undefined ? { expand: evalExpand } : {}) }), ...(evalKindPriors ? { kindPriors: evalKindPriors } : {}) })
  let arms
  if (c.ftsBase) {
    arms = { hybrid: await runArm('hybrid', searchOn(hybridCall), questionSet) }
    arms.fts = await runArm('fts', searchOn(http(c.ftsBase, c.ftsKey, c.orgId, c.userId)), questionSet)
    arms.dense = { skipped: 'EVAL_FTS_URL legacy mode runs no dense arm; unset it to use the per-request retrieval override' }
  } else {
    arms = {}
    for (const label of ['fts', 'dense', 'hybrid']) arms[label] = await runArm(label, searchOn(hybridCall, label), questionSet)
  }
  const report = buildReport({
    config: { base: c.base, ftsBase: c.ftsBase || null, orgId: c.orgId, overlap: c.overlap },
    heldout: { files: set.files, paraphraseLoaded: items.length, paraphraseKept: kept.length, rejected: rejected.length, rejectedDetail: rejected.map((r) => ({ noteId: r.noteId, reason: r.reason })), nearMisses: set.nearMisses.length },
    arms, th: c.th
  })
  const md = renderMarkdown(report)
  writeFileSync(arg('--out') || 'compare-report.json', JSON.stringify(report, null, 2) + '\n')
  writeFileSync(arg('--md') || 'compare-report.md', md)
  console.log(md)
  process.exit(report.verdict === 'PASS' ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`compare-eval ERROR: ${e.message}`); process.exit(2) })
}
