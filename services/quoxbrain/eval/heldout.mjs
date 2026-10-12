// heldout.mjs: held-out paraphrase + near-miss fixtures for the comparative eval.
//
// Answers the auditor's critique of served.mjs: its questions reuse the target
// note's own wording. Here every paraphrase question is checked against the
// target chunk text and REJECTED when it overlaps too much, and the rejected
// count is reported, never hidden.
//
// Fixture format (eval/heldout/*.json), hand-authorable:
//   {
//     "description": "...",
//     "org_id": "optional",
//     "paraphrases": [ { "noteId": "<id>", "question": "...", "seed": "optional", "acceptable": ["<other noteId that also answers it>"] } ],
//     "nearMisses":  [ { "query": "...", "topic": "<corpus topic it is adjacent to>" } ]
//   }
// `acceptable` (optional) lists other notes that legitimately answer the question;
// compare.mjs reports STRICT (noteId only) and LENIENT (noteId or acceptable) metrics.
// The overlap filter looks at the primary note only.
// A near-miss is a query on a topic the corpus covers whose ANSWER is absent;
// the correct outcome is abstention (insufficient=true).

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const HELDOUT_DIR = join(here, 'heldout')

const STOP = new Set('the a an and or of to in on for with is are was were be been by at as it its this that these those from we our my i you your not no do does did how what why when which who where about into than then there their they them can could should would will just have has had any some'.split(' '))

/** Content words: lowercase alnum, len > 2, not a stopword, trailing plural s folded. */
export function contentWords(text) {
  const out = new Set()
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length <= 2 || STOP.has(raw)) continue
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }
  return out
}

/**
 * Overlap between a question and a target chunk.
 * jaccard = |Q n T| / |Q u T| (the headline measure; dilutes on long chunks)
 * coverage = |Q n T| / |Q|     (share of the question's own words found in the chunk;
 *                               catches the long-chunk dilution Jaccard hides)
 */
export function overlap(question, chunkText) {
  const q = contentWords(question)
  const t = contentWords(chunkText)
  let inter = 0
  for (const w of q) if (t.has(w)) inter++
  const union = q.size + t.size - inter
  return { jaccard: union ? inter / union : 0, coverage: q.size ? inter / q.size : 0, shared: inter, questionWords: q.size }
}

export const DEFAULT_OVERLAP = { maxJaccard: 0.3, maxCoverage: 0.5 }

/** Pure filter. items: [{ question, targetText }]. Returns kept + rejected (with reasons). */
export function filterByOverlap(items, limits = DEFAULT_OVERLAP) {
  const kept = []
  const rejected = []
  for (const it of items) {
    if (typeof it.targetText !== 'string' || !it.targetText.trim()) {
      rejected.push({ ...it, reason: 'no-target-text' })
      continue
    }
    const o = overlap(it.question, it.targetText)
    if (o.jaccard > limits.maxJaccard) rejected.push({ ...it, overlap: o, reason: `jaccard ${o.jaccard.toFixed(3)} > ${limits.maxJaccard}` })
    else if (o.coverage > limits.maxCoverage) rejected.push({ ...it, overlap: o, reason: `coverage ${o.coverage.toFixed(3)} > ${limits.maxCoverage}` })
    else kept.push({ ...it, overlap: o })
  }
  return { kept, rejected }
}

/** Validates and merges every *.json fixture in dir. Throws on a malformed fixture. */
export function loadHeldout(dir = HELDOUT_DIR) {
  const paraphrases = []
  const nearMisses = []
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()
  for (const f of files) {
    let j
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch (e) { throw new Error(`heldout ${f}: invalid JSON (${e.message})`) }
    for (const [i, p] of (j.paraphrases || []).entries()) {
      if (!p || typeof p.noteId !== 'string' || typeof p.question !== 'string' || !p.question.trim()) throw new Error(`heldout ${f}: paraphrases[${i}] needs noteId and question`)
      if (p.acceptable !== undefined && (!Array.isArray(p.acceptable) || p.acceptable.some((a) => typeof a !== 'string' || !a))) throw new Error(`heldout ${f}: paraphrases[${i}].acceptable must be an array of noteId strings`)
      paraphrases.push({ noteId: p.noteId, question: p.question, ...(p.acceptable ? { acceptable: p.acceptable } : {}), file: f })
    }
    for (const [i, n] of (j.nearMisses || []).entries()) {
      if (!n || typeof n.query !== 'string' || !n.query.trim()) throw new Error(`heldout ${f}: nearMisses[${i}] needs query`)
      nearMisses.push({ query: n.query, topic: n.topic || null, file: f })
    }
  }
  return { files, paraphrases, nearMisses }
}
