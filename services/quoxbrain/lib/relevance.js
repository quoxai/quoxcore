// relevance.js — BRAIN2-AUDIT 2026-10-05 absolute relevance / abstention.
//
// contextAssembler min-max normalises scores per result set, so the best hit
// is always 1.0 and a nonsense query still "finds" something. This module
// supplies the ABSOLUTE signal the normalised score cannot:
//
//   dense    raw cosine of the best dense hit (null when the dense leg did
//            not run). Scale-free across corpus size; the primary signal.
//   coverage fraction of the query's content terms (stopwords dropped,
//            light suffix stemming) found in the top passages' text. Raw
//            bm25 is NOT usable as an absolute: it is IDF-scaled, so a
//            nonsense query matching one rare word scores like a real hit.
//
// insufficient = coverage < MIN_COVERAGE AND NOT (dense >= MIN_DENSE_COSINE).
// Lexical coverage rescues exact-term queries, dense cosine rescues
// paraphrases with no lexical overlap; a query needs neither to abstain.
//
// Thresholds (read per call, configurable):
//   QUOXBRAIN_MIN_COVERAGE      default 0.5
//   QUOXBRAIN_MIN_DENSE_COSINE  default 0.6  (UNCALIBRATED against live
//                               embeddings; tune with a real eval run)

import { FTS_STOPWORDS } from './vaultStore.js'

const TOP_N = 5
const STRONG_COVERAGE = 0.8

function num(envName, dflt) {
  const n = Number(process.env[envName])
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

/** Dense floor/cosine for the embedding model of the dense leg actually used.
 * 3-large@768 has its own cosine distribution (BRAIN2-W11 C). */
export function denseThresholdsFor(thresholds, embedModel) {
  const large = typeof embedModel === 'string' && embedModel.startsWith('text-embedding-3-large')
  return large
    ? { minDenseCosine: thresholds.minDenseCosineLarge ?? thresholds.minDenseCosine, minDenseFloor: thresholds.minDenseFloorLarge ?? thresholds.minDenseFloor }
    : { minDenseCosine: thresholds.minDenseCosine, minDenseFloor: thresholds.minDenseFloor }
}

export function relevanceThresholds() {
  return {
    minCoverage: num('QUOXBRAIN_MIN_COVERAGE', 0.5),
    minDenseCosine: num('QUOXBRAIN_MIN_DENSE_COSINE', 0.6),
    minDenseFloor: num('QUOXBRAIN_MIN_DENSE_FLOOR', 0.465),
    minDenseCosineLarge: num('QUOXBRAIN_MIN_DENSE_COSINE_LARGE', 0.6),
    minDenseFloorLarge: num('QUOXBRAIN_MIN_DENSE_FLOOR_LARGE', 0.472)
  }
}

const SUFFIXES = ['edly', 'ing', 'ed', 'ly', 'es', 's']
function stem(t) {
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, -suf.length)
  }
  return t
}

function words(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
}

/**
 * @param {string} query
 * @param {Array<{text?:string,title?:string}>} topPassages best-first
 * @param {{denseTop?:number|null, bm25Top?:number|null, thresholds?:object|null}} [signals]
 */
export function computeRelevance(query, topPassages = [], { denseTop = null, bm25Top = null, thresholds = null, embedModel = null } = {}) {
  const qTerms = [...new Set(words(query).filter((w) => !FTS_STOPWORDS.has(w)).map(stem))]
  const hay = new Set()
  for (const p of topPassages.slice(0, TOP_N)) {
    for (const w of words(`${p.title || ''} ${p.text || ''}`)) hay.add(stem(w))
  }
  const coverage = qTerms.length === 0 ? 0 : qTerms.filter((t) => hay.has(t)).length / qTerms.length
  // BRAIN2-V3 B4: callers pass org-resolved thresholds (setting > env >
  // default, lib/brainConfig.js); absent = the env/default read as before.
  const all = thresholds || relevanceThresholds()
  const { minCoverage } = all
  const { minDenseCosine, minDenseFloor } = denseThresholdsFor(all, embedModel)
  const denseRan = typeof denseTop === 'number'
  // BRAIN2-W6 recalibration (held-out eval 2026-10-06, text-embedding-3-small):
  // lexical coverage did not separate paraphrased questions (0.125..0.917)
  // from off-corpus ones (0.375..0.625); the dense cosine did (found targets
  // 0.44..0.62, near-misses 0.35..0.53). So when the dense leg ran it decides,
  // with a strong-lexical override (080: exact-term evidence must not be
  // vetoed by a weak or incomplete dense index); FTS-only keeps the coverage
  // rule. minDenseCosine stays for settings compatibility (a cosine at or
  // above it is confident, which the floor rule already implies).
  void minDenseCosine
  const strongLexical = qTerms.length > 0 && coverage >= STRONG_COVERAGE
  const insufficient = topPassages.length === 0 ||
    (denseRan ? (denseTop < minDenseFloor && !strongLexical) : coverage < minCoverage)
  return {
    coverage: Math.round(coverage * 1000) / 1000,
    dense: typeof denseTop === 'number' ? Math.round(denseTop * 1000) / 1000 : null,
    bm25: typeof bm25Top === 'number' ? Math.abs(bm25Top) : null,
    insufficient
  }
}

export default { computeRelevance, relevanceThresholds, denseThresholdsFor }

/**
 * CORTEX-BENCH: may an LLM rerank "nothing answers this" verdict override the
 * retrieval evidence? The veto was nondeterministic: the same question with
 * the same top passage (dense cosine 0.69) abstained on one call in eight,
 * turning answerable questions (and just-saved notes) into "nothing found".
 * A dense cosine at or above minDenseCosine is confident on its own (see
 * computeRelevance), so the veto only stands below that.
 */
export function rerankVetoHolds(relevance, { thresholds = null, embedModel = null } = {}) {
  const dense = relevance && typeof relevance.dense === 'number' ? relevance.dense : null
  if (dense == null) return true
  const { minDenseCosine } = denseThresholdsFor(thresholds || relevanceThresholds(), embedModel)
  return dense < minDenseCosine
}
