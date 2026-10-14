// quoxDream.js — P3 WP2 QuoxDream consolidation engine
// (docs/STREAM_QUOXBRAIN_P3_DREAM_CONTRACT.md §Design, §WP2)
//
// Reads Brain notes since the last dream_cursor watermark (WP1,
// lib/vaultStore.js: getNotesSinceCursor/getDreamCursor/setDreamCursor/
// startDreamRun/finishDreamRun) and distills them into weighted, deduped
// QuoxMemory beliefs. Every HTTP call (collector LLM extraction + memory
// service reads/writes) goes through a `deps` param so every function here
// is fully unit-testable with no network — mirrors the fetchFn-injection
// shape already used by collector/lib/memoryConsolidationScheduler.js (the
// "scheduler template to mirror" named in the contract).
//
// Best-effort throughout, per the contract's Guardrails: any LLM or memory-
// service error is caught, logged, and skipped — a single bad note or claim
// never aborts a consolidation slice, and never crashes the service.

import * as vaultStore from './vaultStore.js'
import { embedTexts as embedTextsDefault } from './embeddingClient.js'
import { getInstanceSetting, getSetting } from './configResolver.js'
import { resolveEmbedExclusionsDetailed, excludedVaultIds } from './brainConfig.js'
import { getDatabase } from './db.js'

// -----------------------------------------------------------------------------
// CONFIG — env-driven module defaults, overridable per-call via `deps` (tests
// inject deps.fetchImpl/memoryUrl/collectorUrl/serviceKey and never touch the
// network). Host defaults ('memory'/'collector', ports 3103/9848) mirror the
// real docker-network convention confirmed in
// collector/lib/memoryConsolidationScheduler.js:40 (MEMORY_URL) and this
// repo's docker-compose.yml (COLLECTOR_URL=http://collector:9848 on the
// tasks/quoxflow/screencap services) — NOT the "quox-memory"/"quox-collector"
// names a naive guess would produce. 127.0.0.1 fallbacks cover local
// (non-container) dev runs of quoxbrain.
// -----------------------------------------------------------------------------

const MEMORY_URL_DEFAULT = process.env.MEMORY_URL
  || `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`
const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || ''

// BRAIN2-W5 107: deadline for every memory-service call, so a wedged memory
// endpoint cannot hold a consolidation run open.
const MEMORY_TIMEOUT_MS_DEFAULT = 15000

// BRAIN2-W5 092: org-scope beliefs are written under this shared owner id
// (memory service reads include it for every member of the org). Previously
// they landed under the memory service's 'service' user and no human or
// Cortex recall could ever see them. User-scope beliefs stay private.
export const ORG_BELIEF_USER_ID = '__org__'

function resolveDeps(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl || fetch,
    memoryUrl: deps.memoryUrl || MEMORY_URL_DEFAULT,
    collectorUrl: deps.collectorUrl || COLLECTOR_URL_DEFAULT,
    serviceKey: deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT,
    // Semantic-dedup embedder (see §SEMANTIC DEDUP below) — defaults to the
    // real collector-backed embeddingClient.embedTexts; tests inject a stub
    // here so no network call is ever made off this path.
    embedFn: deps.embedFn || embedTextsDefault,
    contradictionLlm: deps.contradictionLlm,
    memoryTimeoutMs: Number.isFinite(deps.memoryTimeoutMs) && deps.memoryTimeoutMs > 0 ? deps.memoryTimeoutMs : MEMORY_TIMEOUT_MS_DEFAULT
  }
}

// -----------------------------------------------------------------------------
// EXTRACTION — collector /chat/complete seam (contract §The seams). Best
// effort: on ANY failure (non-2xx, network error, malformed completion)
// returns [] rather than throwing, so one bad note never aborts a slice.
// -----------------------------------------------------------------------------

const MAX_CLAIMS_PER_NOTE = 12 // per extraction round (BRAIN2-W7 102: further rounds continue)
const MAX_EXTRACT_ROUNDS = 4
// Per-note extraction timeout — bounds a hung/slow collector so one note can't
// wedge the whole consolidation pass (extraction is best-effort; on timeout the
// note is skipped and the pass continues).
const EXTRACT_TIMEOUT_MS_DEFAULT = 90000

// VAULT-INTEG P17: was a bare process.env read frozen at module load — now
// resolved through configResolver.getInstanceSetting() (an instance-wide
// tuning knob, not a per-org policy choice), called fresh on every
// extractBeliefs() call, so a stored/env override applies to the very next
// extraction, no restart needed. Fail-safe: any resolver failure (no
// service key, network error, timeout) falls back to the env value passed
// in, same as every other call site rewired in this pass.
async function extractTimeoutMs(deps = {}) {
  try {
    const resolved = await getInstanceSetting('QUOXDREAM_EXTRACT_TIMEOUT_MS', deps)
    if (resolved && resolved.value !== undefined) {
      const n = Number(resolved.value)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch (err) {
    console.error(`[QuoxDream] QUOXDREAM_EXTRACT_TIMEOUT_MS instance-setting resolver failed, falling back to env — ${err.message}`)
  }
  const envMs = Number(process.env.QUOXDREAM_EXTRACT_TIMEOUT_MS)
  return Number.isFinite(envMs) && envMs > 0 ? envMs : EXTRACT_TIMEOUT_MS_DEFAULT
}

const VALID_MEMORY_TYPES = new Set(['fact', 'preference', 'decision', 'entity', 'constraint', 'observation'])
const VALID_IMPORTANCE = new Set(['low', 'medium', 'high', 'critical'])

const EXTRACT_SYSTEM_PROMPT = `You are a strict fact-extraction engine for QuoxDream, a memory consolidation pass.
Read the note text and extract every durable, standalone belief worth remembering long-term — facts, stated preferences, decisions made, entities described, constraints/rules, or notable observations.
Respond with ONLY a JSON array (no prose, no markdown fences, no explanation) where each element is:
{
  "content": "<one self-contained sentence stating the belief, understandable without the original note>",
  "memory_type": "fact" | "preference" | "decision" | "entity" | "constraint" | "observation",
  "confidence": <number 0-1, how certain the text supports this belief>,
  "importance": "low" | "medium" | "high" | "critical",
  "evidence": "<a short VERBATIM quote copied exactly from the note that supports this belief; claims without a real quote are discarded>",
  "supersedes_hint": "<optional: a short phrase describing an older belief this one replaces, omit if not applicable>"
}
If the note contains no durable belief worth remembering, respond with an empty array: []
Return AT MOST 12 claims — the most important, durable ones first; do not pad. Keep each "content" to a single concise sentence.
Do not include anything other than the JSON array in your response.`

/** Strips a leading/trailing markdown code fence (\`\`\` or \`\`\`json) some
 * models wrap JSON output in, so JSON.parse sees a bare array. */
function normalizeWs(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function stripFences(text) {
  const trimmed = String(text || '').trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

/** Parse the completion into a claim array, tolerating a TRUNCATED response.
 * A rich note can exceed max_tokens and get cut mid-array — rather than drop
 * every belief from that note, salvage the complete objects: trim to the last
 * closed `}` and re-close the array. If even that fails, return null. */
function parseClaimArray(text, info = null) {
  const s = stripFences(text)
  try { return JSON.parse(s) } catch { /* fall through to salvage */ }
  if (s[0] === '[') {
    const lastClose = s.lastIndexOf('}')
    if (lastClose > 0) {
      try {
        const salvaged = JSON.parse(s.slice(0, lastClose + 1) + ']')
        if (info) info.salvaged = true // BRAIN2-W7 101: the tail was cut off
        return salvaged
      } catch { /* give up */ }
    }
  }
  return null
}

/** Defensive per-claim validation — drops anything that doesn't match the
 * extraction contract rather than letting a malformed item corrupt a write.
 * Returns a normalized claim object, or null if invalid. */
function validateClaim(raw) {
  if (!raw || typeof raw !== 'object') return null
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!content) return null
  if (!VALID_MEMORY_TYPES.has(raw.memory_type)) return null

  let confidence = Number(raw.confidence)
  if (!Number.isFinite(confidence)) confidence = 0.5
  confidence = Math.min(Math.max(confidence, 0), 1)

  const importance = VALID_IMPORTANCE.has(raw.importance) ? raw.importance : 'medium'

  const claim = { content, memory_type: raw.memory_type, confidence, importance }
  if (typeof raw.evidence === 'string') claim.evidence = raw.evidence.trim()
  if (typeof raw.supersedes_hint === 'string' && raw.supersedes_hint.trim()) {
    claim.supersedes_hint = raw.supersedes_hint.trim()
  }
  return claim
}

/**
 * Extracts distilled beliefs from a single note's text via the collector's
 * /chat/complete LLM seam. `meta` (note title/occurred_at/etc.) is accepted
 * for call-site symmetry with consolidateSlice's per-note loop but not
 * currently folded into the prompt — noteText alone is what's sent, per the
 * contract's request shape.
 *
 * @param {string} noteText
 * @param {object} [meta]
 * @param {object} [deps]
 * @returns {Promise<Array<{content:string, memory_type:string, confidence:number, importance:string, supersedes_hint?:string}>>}
 */
export async function extractBeliefs(noteText, meta = {}, deps = {}) {
  const r = await extractBeliefsChecked(noteText, meta, deps)
  return r.claims
}

/**
 * Same as extractBeliefs but distinguishes FAILURE from "no claims":
 * { ok:true, claims } on a real answer (possibly an empty list), and
 * { ok:false, claims:[], error, infra } on failure. infra:true = the
 * dependency failed (HTTP non-2xx, network error, timeout): says nothing
 * about the note. infra:false = the completion came back but is unparseable
 * even after salvage: a note-specific failure. consolidateSlice uses this so a failed note is retried (and
 * eventually retired) rather than silently skipped (BRAIN2-AUDIT).
 */
export async function extractBeliefsChecked(noteText, meta = {}, deps = {}) {
  // BRAIN2-W7 101/102: one completion can be truncated or capped at
  // MAX_CLAIMS_PER_NOTE. Continue in rounds ("do not repeat these") until a
  // round is complete and under the cap, adds nothing new, or the round budget
  // is spent. A note still known-incomplete is reported (incomplete:true), never
  // silently treated as fully consolidated.
  const first = await extractRound(noteText, meta, deps, [])
  if (!first.ok) return first
  const claims = [...first.claims]
  let rejectedUnsupported = first.rejectedUnsupported
  let more = first.more
  let incomplete = false
  for (let round = 1; more && round < MAX_EXTRACT_ROUNDS; round++) {
    const next = await extractRound(noteText, meta, deps, claims)
    // BRAIN2-W12 B2: an infrastructure failure in a later round means the note was
    // NOT fully extracted. Fail like a first-round failure so the caller holds the
    // cursor and retries (already-written claims dedup on retry). Only a
    // model-declared complete or the max-rounds cap may advance.
    if (!next.ok && next.infra) return next
    if (!next.ok) { incomplete = true; more = false; break }
    rejectedUnsupported += next.rejectedUnsupported
    const seen = new Set(claims.map((c) => normalizeWs(c.content)))
    const fresh = next.claims.filter((c) => !seen.has(normalizeWs(c.content)))
    claims.push(...fresh)
    more = fresh.length > 0 && next.more
  }
  if (more) incomplete = true
  if (incomplete) console.error(`[QuoxDream] extraction for note "${meta.title || ''}" may be incomplete after ${MAX_EXTRACT_ROUNDS} round(s); ${claims.length} claim(s) kept`)
  return { ok: true, claims, rejectedUnsupported, ...(incomplete ? { incomplete: true } : {}) }
}

async function extractRound(noteText, meta, deps, already) {
  const { fetchImpl, collectorUrl, serviceKey } = resolveDeps(deps)
  const prompt = already.length === 0
    ? noteText
    : `${noteText}\n\n---\nALREADY EXTRACTED (do not repeat these; extract only further durable beliefs from the note above, or [] if none remain):\n${already.map((c) => `- ${c.content}`).join('\n')}`

  try {
    const res = await fetchImpl(`${collectorUrl}/chat/complete`, {
      method: 'POST',
      // BRAIN2-W5 094: carry tenant identity so the collector applies the org's
      // provider policy/credentials, not the instance default.
      headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json', ...(meta.orgId ? { 'X-Org-Id': meta.orgId } : {}) },
      body: JSON.stringify({ prompt, system_prompt: EXTRACT_SYSTEM_PROMPT, max_tokens: 2500 }),
      // Bound the call so a slow/wedged collector can't make consolidation hang
      // indefinitely holding a connection (it can — extraction is best-effort;
      // a timeout just skips this note). ~30s is a normal extraction; 90s is the
      // default ceiling before we give up.
      signal: AbortSignal.timeout(await extractTimeoutMs(deps))
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[QuoxDream] extractBeliefs: /chat/complete HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      return { ok: false, infra: true, claims: [], error: `HTTP ${res.status}` }
    }

    const data = await res.json()
    // collector's /chat/complete responds { success, text, usage, provider }
    // (services/collector/server.js:17942) — the completion body is `text`.
    const completionText = typeof data.text === 'string' ? data.text : ''

    const info = { salvaged: false }
    const parsed = parseClaimArray(completionText, info)
    if (parsed === null) {
      console.error('[QuoxDream] extractBeliefs: could not parse completion as JSON (even after salvage)')
      return { ok: false, claims: [], error: 'unparseable completion' }
    }
    // BRAIN2-W5 100: valid JSON of the wrong shape is model format drift, not
    // "this note has no beliefs". Note-specific failure (counts toward retry).
    if (!Array.isArray(parsed)) {
      console.error('[QuoxDream] extractBeliefs: completion JSON is not an array')
      return { ok: false, claims: [], error: 'unexpected completion shape' }
    }

    const claims = []
    let structurallyValid = 0
    let rejectedUnsupported = 0
    const haystack = normalizeWs(noteText)
    for (const item of parsed) {
      const claim = validateClaim(item)
      if (!claim) continue
      structurallyValid += 1
      // BRAIN2-W5 103: a belief must be backed by a verbatim quote that really
      // appears in the note. A missing/unmatched quote DROPS that claim (and is
      // counted); it never fails the note, so it cannot drive retirement.
      if (!claim.evidence || !haystack.includes(normalizeWs(claim.evidence))) { rejectedUnsupported += 1; continue }
      // A quote that is really in the note is not enough: the claim must not
      // CONTRADICT it ("Refunds never require approval" citing "Refunds
      // require approval"). Deterministic check first; the optional LLM check
      // (same QUOXDREAM_SEMANTIC_DEDUP gate) can only add a rejection.
      // deps.skipEvidenceRelevance is a TEST-ONLY seam for legacy fixtures that stamp stub evidence.
      const unrelated = deps.skipEvidenceRelevance ? null : evidenceRelevanceVerdict(claim.content, claim.evidence)
      if (unrelated) { rejectedUnsupported += 1; console.error(`[QuoxDream] rejected claim with unrelated evidence (${unrelated})`); continue }
      const verdict = await evidenceContradiction(claim, deps, meta.orgId)
      if (verdict) { rejectedUnsupported += 1; console.error(`[QuoxDream] rejected claim contradicting its evidence (${verdict})`); continue }
      claims.push(claim)
    }
    // BRAIN2-W5 100: an array with items but none structurally valid is model
    // format drift (note-specific failure), unlike a genuine [] or all-unsupported.
    if (parsed.length > 0 && structurallyValid === 0) {
      return { ok: false, claims: [], error: 'no valid claims in completion' }
    }
    if (rejectedUnsupported > 0) console.error(`[QuoxDream] dropped ${rejectedUnsupported} claim(s) without a supporting quote from the note`)
    // `more`: the answer was cut off, or it filled the per-round cap, so the
    // note may hold further claims.
    const more = info.salvaged || parsed.length >= MAX_CLAIMS_PER_NOTE
    return { ok: true, claims, rejectedUnsupported, more }
  } catch (err) {
    console.error(`[QuoxDream] extractBeliefs failed: ${err.message}`)
    return { ok: false, infra: true, claims: [], error: err.message }
  }
}

// -----------------------------------------------------------------------------
// STABILITY MAPPING (contract §Design "stability mapping (decay tier)") —
// pure, no I/O.
// -----------------------------------------------------------------------------

/** decision/constraint/fact/entity/preference -> 'stable'; observation ->
 * 'volatile'. Kept simple + explicit now per the contract; tune later. */
export function stabilityFor(memory_type) {
  return memory_type === 'observation' ? 'volatile' : 'stable'
}

// -----------------------------------------------------------------------------
// DEDUP HEURISTIC — no embeddings yet (contract §Design explicitly flags this
// as a later upgrade), so near-duplicate detection is a Jaccard word-overlap
// check: lowercase + whitespace-tokenize both strings, compare set overlap.
// This is the SAME technique collector/lib/memoryConsolidationScheduler.js's
// jaccardSimilarity() already uses for memory-vs-memory dedup — reusing it
// here (rather than inventing a second heuristic) keeps "near-duplicate"
// meaning consistent across the two consolidation paths. Threshold 0.6
// matches that module's DEFAULT_DUP_THRESHOLD. An exact-content match (after
// trim+lowercase) always counts as a match even for very short strings where
// word-overlap alone would be noisy.
// -----------------------------------------------------------------------------

function normalize(str) {
  return String(str || '').trim().toLowerCase()
}

const DUP_OVERLAP_THRESHOLD = 0.6

function isNearDuplicate(a, b) {
  const normA = normalize(a)
  const normB = normalize(b)
  if (!normA || !normB) return false
  if (normA === normB) return true

  const wordsA = new Set(normA.split(/\s+/).filter(Boolean))
  const wordsB = new Set(normB.split(/\s+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) return false

  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)))
  const union = new Set([...wordsA, ...wordsB])
  return (intersection.size / union.size) >= DUP_OVERLAP_THRESHOLD
}

// -----------------------------------------------------------------------------
// CONTRADICTION DETECTION (BRAIN2-V3 B2) — a claim that is a near-duplicate of
// an existing belief by words/embedding but with OPPOSITE POLARITY is a
// reversal, not a repeat: "We must retain customer data forever" vs "We must
// not retain customer data forever" are 5/6 word-overlap, so Jaccard alone
// called them DUPLICATE and the old, reversed decision stayed believed.
//
// Cheap heuristics only (no I/O): polarity parity = (count of negation tokens
// + count of negative-side antonym words) mod 2. Covers not/never/no/n't,
// must vs must not, always vs never, enable vs disable, keep/retain vs
// remove/delete, allow vs forbid, start vs stop, increase vs decrease. Two
// texts about the same topic whose parities differ CONTRADICT.
// -----------------------------------------------------------------------------

const NEGATION_RE = /^(not|no|never|none|nor|cannot|n't|\w+n't)$/
// negative-side antonym stems (the positive side is "default": enable, keep,
// retain, allow, require, start, increase, ...).
const NEG_ANTONYM_RE = /^(disabl|remov|delet|forbid|forbad|prohibit|disallow|deny|denie|block|stop|avoid|reject|declin|purg|discard|drop|decreas|reduc|lower|revok|ban|unsupport|deprecat|abandon|disconnect|unsubscrib)/
const POS_ANTONYM_RE = /^(enabl|keep|kept|retain|allow|permit|requir|start|increas|add|support|adopt|approv|accept|grant|rais|subscrib|connect|use|store|preserv)/
const NEUTRAL_WORDS = new Set([
  'we', 'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'be', 'been', 'was', 'were', 'will', 'shall', 'would',
  'should', 'must', 'may', 'might', 'can', 'could', 'always', 'ever', 'do', 'does', 'did', 'it', 'its', 'our', 'that',
  'this', 'all', 'any', 'only', 'has', 'have', 'had', 'org', 'team', 'must', 'need', 'needs', 'to', 'in', 'on', 'for'
])

function tokens(str) {
  return normalize(str).replace(/[\u2019]/g, "'").split(/[^a-z0-9']+/).filter(Boolean)
}

/** 0 or 1: parity of negation tokens + negative-side antonyms in `str`. */
export function polarityOf(str) {
  let flips = 0
  for (const t of tokens(str)) {
    if (NEGATION_RE.test(t) || t.endsWith("n't")) flips += 1
    else if (NEG_ANTONYM_RE.test(t)) flips += 1
  }
  return flips % 2
}

function topicWords(str) {
  const out = new Set()
  for (const t of tokens(str)) {
    if (NEGATION_RE.test(t) || t.endsWith("n't")) continue
    if (NEG_ANTONYM_RE.test(t) || POS_ANTONYM_RE.test(t)) continue
    if (NEUTRAL_WORDS.has(t)) continue
    out.add(t)
  }
  return out
}

// BRAIN2-W5 097: 0.6 let "retain data, delete expired backups" contradict
// "retain data, keep encrypted backups" (3/5 shared topic words). 0.8 requires
// near-identical subjects before a polarity difference counts as a reversal.
const TOPIC_OVERLAP_THRESHOLD = 0.8

/** Same subject (topic-word Jaccard after stripping polarity/modal words)? */
function sameTopic(a, b) {
  const A = topicWords(a)
  const B = topicWords(b)
  if (A.size === 0 || B.size === 0) return false
  let inter = 0
  for (const w of A) if (B.has(w)) inter += 1
  return inter / (A.size + B.size - inter) >= TOPIC_OVERLAP_THRESHOLD
}

// VALUE CORRECTIONS (BRAIN2-W2 3): same claim template, different number /
// date / duration / version / percentage / named value ("retain records for 90
// days" -> "... 30 days", "v1.2" -> "v1.3", "use Gemini" -> "use OpenAI").
// Deterministic: numeric tokens are masked to '#', templates must be equal and
// the numeric token lists must differ. A named-value swap needs EXACTLY one
// differing position, capitalised on both sides (never the first word).
const NUM_TOKEN_RE = /v?\d+(?:[.\-/:]\d+)*%?/g

function numericParts(str) {
  const low = String(str || '').trim().toLowerCase().replace(/[\u2019]/g, "'")
  const nums = low.match(NUM_TOKEN_RE) || []
  const template = low.replace(NUM_TOKEN_RE, '#').split(/[^a-z0-9#']+/).filter(Boolean).join(' ')
  return { nums, template }
}

const EXCLUSIVE_PREDICATE_RE = /\b(uses?|primary|is|are|was|were|equals?|set to|defaults? to|default|costs?|lives? in|located in|stored in|written in|runs? (?:on|at|in)|ships?|deadline|version|ceo|cto|cfo|owner|only|approved by|managed by|hosted (?:in|on))\b/
// Audit R06: "<X> is the <role>" is functional: a different subject for the same
// unique role ("Alice is the CEO" vs "Bob is the CEO") is a contradiction.
function uniqueRoleSwapped(a, b) {
  const re = /^\s*(.+?)\s+(?:is|was|are|were)\s+(the\s+.+?)\s*[.!]?\s*$/i
  const ma = re.exec(String(a)), mb = re.exec(String(b))
  if (!ma || !mb) return false
  return ma[2].toLowerCase() === mb[2].toLowerCase() && ma[1].toLowerCase() !== mb[1].toLowerCase() && !/\b(not|never|no)\b/i.test(`${a} ${b}`)
}

export function isValueChange(a, b) {
  if (!normalize(a) || !normalize(b)) return false
  const A = numericParts(a)
  const B = numericParts(b)
  if (A.nums.length > 0 && A.nums.length === B.nums.length && A.template === B.template) {
    return A.nums.some((n, i) => n !== B.nums[i])
  }
  if (A.nums.length > 0 || B.nums.length > 0) return false
  // Audit R06: swapping the object of a non-exclusive predicate ("likes tea" ->
  // "likes coffee") is compatible, not a correction. Only exclusive/functional
  // predicates (is, equals, default, costs, lives in, ...) make it one.
  if (!EXCLUSIVE_PREDICATE_RE.test(normalize(a)) || !EXCLUSIVE_PREDICATE_RE.test(normalize(b))) return false
  const wa = String(a).trim().split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  const wb = String(b).trim().split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean)
  if (wa.length !== wb.length || wa.length < 3) return false
  const diff = []
  for (let i = 0; i < wa.length; i++) if (wa[i].toLowerCase() !== wb[i].toLowerCase()) diff.push(i)
  if (diff.length !== 1 || diff[0] === 0) return false
  const i = diff[0]
  if (/^[A-Z]/.test(wa[i]) && /^[A-Z]/.test(wb[i])) return true
  // Codex cycle 5 F2: a lowercase content word swapped in an otherwise identical
  // claim ("only for contractors" -> "only for administrators") is a change too.
  // Function words (a/the/an/this...) are wording, not meaning.
  const x = wa[i].toLowerCase(), y = wb[i].toLowerCase()
  return /^[a-z][a-z-]{2,}$/.test(x) && /^[a-z][a-z-]{2,}$/.test(y) && !SWAP_FUNCTION_WORDS.has(x) && !SWAP_FUNCTION_WORDS.has(y)
}
// Negations and modals are polarity, which polarityOf already judges ('not' -> 'never' is no change).
const SWAP_FUNCTION_WORDS = new Set('the a an this that these those its our their his her your my some any each every all also just very really not never none nor cannot must should shall will would can could may might always ever'.split(' '))

/** BRAIN2-W10 E 8: split a belief into atomic clauses (semicolons, commas, and/but/while). */
export function splitClauses(str) {
  return String(str || '').split(/\s*[;,]\s*|\s+(?:and|but|while|whereas)\s+/i).map((c) => c.trim()).filter(Boolean)
}

/** Any aligned clause pair (same topic) with opposite polarity is a reversal. */
function clauseReversal(a, b) {
  const A = splitClauses(a)
  const B = splitClauses(b)
  if (A.length < 2 && B.length < 2) return false
  for (const ca of A) {
    for (const cb of B) {
      if (polarityOf(ca) !== polarityOf(cb) && sameTopic(ca, cb)) return true
    }
  }
  return false
}


// OUTSIDE AUDIT: meaning differences the older checks missed. "All refunds
// require approval" vs "Some refunds require approval" is a 5/6 word repeat to
// Jaccard and passed the evidence check. Deterministic, no I/O.
const UNIVERSAL_Q = new Set(['all', 'every', 'each', 'always', 'everyone', 'everything', 'invariably'])
const MAJORITY_Q = new Set(['many', 'most', 'usually', 'often', 'generally', 'typically'])
const MINORITY_Q = new Set(['some', 'several', 'few', 'sometimes', 'occasionally', 'certain'])
const QUANT_WORDS = new Set([...UNIVERSAL_Q, ...MAJORITY_Q, ...MINORITY_Q])
function quantClasses(str) {
  const out = new Set()
  for (const t of tokens(str)) {
    if (UNIVERSAL_Q.has(t)) out.add('U')
    else if (MAJORITY_Q.has(t)) out.add('M')
    else if (MINORITY_Q.has(t)) out.add('F')
  }
  return out
}
function sameSet(x, y) { return x.size === y.size && [...x].every((v) => y.has(v)) }
function topicSansWords(str, drop) {
  return new Set([...topicWords(str)].filter((w) => !drop.has(w)))
}
function topicOverlap(A, B, min) {
  if (A.size === 0 || B.size === 0) return false
  let inter = 0
  for (const w of A) if (B.has(w)) inter += 1
  return inter / (A.size + B.size - inter) >= min
}
// strict (evidence check): a quantifier added or dropped counts (strengthening /
// weakening). Non-strict (dedup): both sides must carry one, since an added
// "all" in a restatement is wording, not a changed belief.
function quantifierChanged(a, b, strict = false) {
  const qa = quantClasses(a), qb = quantClasses(b)
  if (sameSet(qa, qb)) return false
  if (!strict && (qa.size === 0 || qb.size === 0)) return false
  return topicOverlap(topicSansWords(a, QUANT_WORDS), topicSansWords(b, QUANT_WORDS), TOPIC_OVERLAP_THRESHOLD)
}

// Condition clauses: the content after only if / unless / when / after /
// before / until / once / if. A different clause is a different rule.
const CONDITION_RE = /\b(only if|only when|unless|if|whenever|when|after|before|until|once)\s+([^,;.]+)/g
function conditionsOf(str) {
  const out = new Set()
  for (const m of normalize(str).matchAll(CONDITION_RE)) {
    out.add(`${m[1].replace(/^only /, '')} ${m[2].trim().split(/\s+/).filter((w) => !['the', 'a', 'an', 'is', 'are', 'was', 'were'].includes(w)).join(' ')}`)
  }
  return out
}
function stripConditions(str) { return normalize(str).replace(CONDITION_RE, ' ') }
function conditionChanged(a, b) {
  const ca = conditionsOf(a), cb = conditionsOf(b)
  if (ca.size === 0 && cb.size === 0) return false
  if (sameSet(ca, cb)) return false
  const A = topicSansWords(stripConditions(a), QUALIFIER_WORDS)
  const B = topicSansWords(stripConditions(b), QUALIFIER_WORDS)
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  if (small.size < 2) return false
  let inside = 0
  for (const w of small) if (big.has(w)) inside += 1
  return inside / small.size >= 0.75
}

// Explicit dates: months, weekdays, ISO dates, ordinals. Numbers are covered
// by isValueChange / numberMismatch; this adds the word-shaped ones.
const MONTH_DAY_RE = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)s?$/
const MONTH_DAY_AMBIGUOUS = new Set(['may', 'mar', 'sun', 'sat', 'dec', 'wed', 'mon', 'jun', 'jan', 'feb', 'apr', 'aug', 'sep', 'sept', 'oct', 'nov', 'jul', 'thu', 'thur', 'thurs', 'tue', 'tues', 'fri'])
function dateWords(str) {
  const out = new Set()
  const raw = String(str || '')
  for (const m of raw.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add(m[0])
  for (const m of raw.matchAll(/\b[A-Za-z]+\b/g)) {
    const w = m[0].toLowerCase()
    if (!MONTH_DAY_RE.test(w)) continue
    // abbreviations and "may" only count when capitalised (not the modal verb)
    if (MONTH_DAY_AMBIGUOUS.has(w) && !/^[A-Z]/.test(m[0])) continue
    out.add(w.replace(/s$/, '').slice(0, 3))
  }
  return out
}
const DATE_DROP = new Set('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays thursdays fridays saturdays sundays jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun'.split(' '))
const MEANING_WORDS = new Set([...QUANT_WORDS, ...DATE_DROP])
function dateChanged(a, b) {
  const da = dateWords(a), db = dateWords(b)
  if (da.size === 0 && db.size === 0) return false
  if (sameSet(da, db)) return false
  return topicOverlap(topicSansWords(a, DATE_DROP), topicSansWords(b, DATE_DROP), TOPIC_OVERLAP_THRESHOLD)
}

/** True when two texts differ in quantifier, condition clause or explicit date. */
export function meaningDiffers(a, b, strict = false) {
  return quantifierChanged(a, b, strict) || conditionChanged(a, b) || dateChanged(a, b)
}

/** True when `a` and `b` are about the same thing but state opposite polarity (or a changed value). */
export function isContradiction(a, b) {
  if (!normalize(a) || !normalize(b)) return false
  if (isValueChange(a, b)) return true
  if (uniqueRoleSwapped(a, b)) return true
  if (polarityOf(a) !== polarityOf(b) && sameTopic(a, b)) return true
  if (rolesReversed(a, b)) return true
  if (qualifierChanged(a, b)) return true
  if (meaningDiffers(a, b)) return true
  return clauseReversal(a, b)
}

// Codex cycle 4 #3: a correction that only adds or drops an exception,
// condition, scope limit or status change ("except contractors", "only if",
// "postponed", "replaced by") shares most of its words with the old belief, so
// Jaccard called it a repeat and the correction was lost. Same subject (the
// shorter claim's topic words mostly inside the longer one) plus a different
// set of qualifiers is a change, not a duplicate.
const QUALIFIER_RE = /\b(except|excluding|exclude[sd]?|unless|only|until|but not|no longer|any ?more|instead|postpone[sd]?|defer(?:red|s)?|delayed|cancel(?:l?ed|s)?|paused|on hold|revert(?:ed|s)?|rolled back|replaced|superseded|switched|temporarily|if|provided that|as of|from now on)\b/g
function qualifiersOf(str) {
  const set = new Set()
  for (const m of normalize(str).matchAll(QUALIFIER_RE)) set.add(m[1].replace(/\s+/g, ' ').replace(/^(postpone|exclude|revert|cancel|defer)\w*$/, '$1'))
  return set
}
function qualifierChanged(a, b) {
  const qa = qualifiersOf(a), qb = qualifiersOf(b)
  if (qa.size === qb.size && [...qa].every((q) => qb.has(q))) return false
  const strip = (t) => new Set([...topicWords(t)].filter((w) => !QUALIFIER_WORDS.has(w)))
  const A = strip(a), B = strip(b)
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  if (small.size < 2) return false
  let inside = 0
  for (const w of small) if (big.has(w)) inside += 1
  return inside / small.size >= 0.75
}
const QUALIFIER_WORDS = new Set('except excluding exclude excludes unless only until but no longer any anymore more instead postpone postponed postpones deferred defer defers delayed cancel cancelled canceled cancels paused on hold revert reverted reverts rolled back replaced superseded switched temporarily if provided as of from now by was were'.split(' '))

// Codex cycle 4: "Bob manages Alice" is not a repeat of "Alice manages Bob".
// Two or more shared capitalised names in a different order, on the same
// topic, is a reversal; passive voice ("is managed by") legitimately flips the
// order and is left alone. Heuristic, like the rest of this file.
const PASSIVE_RE = /\b(is|are|was|were|been|being|be)\s+\w+(ed|en)\s+by\b/i
function namesInOrder(text) {
  const out = []
  for (const m of String(text || '').matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const n = m[0].toLowerCase()
    if (!out.includes(n)) out.push(n)
  }
  return out
}
function rolesReversed(a, b) {
  if (PASSIVE_RE.test(a) || PASSIVE_RE.test(b) || !sameTopic(a, b)) return false
  const x = namesInOrder(a), y = namesInOrder(b)
  const shared = x.filter((n) => y.includes(n))
  if (shared.length < 2) return false
  const inY = y.filter((n) => shared.includes(n))
  return shared.some((n, i) => n !== inY[i])
}

const CONTRADICTION_LLM_PROMPT = `You compare two beliefs. Do they directly CONTRADICT each other (one states the reverse of the other)?
Respond with ONLY the single word YES or NO.`

/** LLM tie-break via the existing collector /chat/complete path (or an injected
 * deps.contradictionLlm), reached ONLY for semantically-close pairs the
 * heuristics cannot call, i.e. already behind QUOXDREAM_SEMANTIC_DEDUP. Any
 * failure returns false (stays DUPLICATE: the safe, pre-existing outcome). */
async function llmSaysContradiction(a, b, deps, orgId = null) {
  try {
    if (typeof deps.contradictionLlm === 'function') return Boolean(await deps.contradictionLlm(a, b))
    const res = await deps.fetchImpl(`${deps.collectorUrl}/chat/complete`, {
      method: 'POST',
      headers: { 'X-Service-Key': deps.serviceKey, 'Content-Type': 'application/json', ...(orgId ? { 'X-Org-Id': orgId } : {}) },
      body: JSON.stringify({ prompt: `Belief A: ${a}\nBelief B: ${b}`, system_prompt: CONTRADICTION_LLM_PROMPT, max_tokens: 5 }),
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return false
    const data = await res.json()
    return /^\s*yes/i.test(typeof data.text === 'string' ? data.text : '')
  } catch (err) {
    console.error(`[QuoxDream] contradiction LLM check failed (treating as duplicate): ${err.message}`)
    return false
  }
}

// CLAIM-vs-EVIDENCE CHECK. Returns a reason string when `claim` contradicts its
// quoted `evidence`, else null. Uncertain-but-not-contradicted claims pass.
const UNIT_NUM_RE = /(\d+(?:\.\d+)?)\s*(%|[a-z]+)?/g
function numberUnits(str) {
  const out = []
  for (const m of String(str || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2').matchAll(UNIT_NUM_RE)) out.push([m[1], m[2] || ''])
  return out
}
function numberMismatch(claim, evidence) {
  const c = numberUnits(claim), e = numberUnits(evidence)
  if (c.length === 0 || e.length === 0) return false
  for (const [n, unit] of c) {
    if (!unit || e.some(([en, eu]) => en === n && eu === unit)) continue
    // same unit in the evidence but never with this number: a changed value
    if (e.some(([, eu]) => eu === unit)) return true
  }
  return false
}
function evidenceClauses(evidence) {
  return String(evidence || '').split(/(?<=[.!?])\s+/).flatMap((sent) => [sent, ...splitClauses(sent)]).filter(Boolean)
}
export function claimContradictsEvidence(claim, evidence) {
  if (!normalize(claim) || !normalize(evidence)) return null
  if (numberMismatch(claim, evidence)) return 'number differs from evidence'
  const topic = topicWords(claim)
  if (topic.size === 0) return null
  const pol = polarityOf(claim)
  let opposed = false, agreed = false, differing = false, matching = false
  for (const cl of evidenceClauses(evidence)) {
    const t = topicWords(cl)
    let inside = 0
    for (const w of topic) if (t.has(w)) inside += 1
    if (inside / topic.size < 0.75) {
      // a quantifier / date word is exactly what may differ: judge the subject without them
      const core = topicSansWords(claim, MEANING_WORDS)
      const tc = topicSansWords(cl, MEANING_WORDS)
      let ci = 0
      for (const w of core) if (tc.has(w)) ci += 1
      if (core.size === 0 || ci / core.size < 0.75 || !meaningDiffers(claim, cl, true)) continue
      differing = true
      continue
    }
    if (polarityOf(cl) === pol) agreed = true
    else opposed = true
    if (rolesReversed(claim, cl)) return 'roles reversed relative to evidence'
    if (meaningDiffers(claim, cl, true)) differing = true
    else matching = true
  }
  if (differing && !matching) return 'quantifier, condition or date differs from evidence'
  if (opposed && !agreed) return 'polarity opposes evidence'
  return null
}

// EVIDENCE RELEVANCE (audit R05): a quote that exists and does not contradict
// the claim can still be irrelevant ("ten million dollars in cash" citing "The
// office has blue chairs"). Content-word overlap (stemmed, stopwords removed)
// must reach 50% of the claim's key terms, and every number / mid-sentence
// capitalised name in the claim must appear in the evidence.
const RELEVANCE_MIN_OVERLAP = 0.5
const RELEVANCE_STOPWORDS = new Set(('a an the and or but nor of to in on at by for from with without into onto over under about as is are was were be been being am '
  + 'it its this that these those there their they them we our us you your he she his her i my has have had having do does did will would shall should may might can could '
  + 'must not no never also just very than then so such per via within all any each every some more most other only same own too if when while which who whom whose what where why how').split(' '))
const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 }
function stemWord(w) {
  let t = w
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`
  else if (t.length > 4) t = t.replace(/(ing|ed|es|s)$/, '')
  if (t.length > 4) t = t.replace(/e$/, '')
  return t
}
function relevanceTerms(str) {
  const out = new Set()
  for (const raw of String(str || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2').split(/[^a-z0-9.]+/)) {
    const w = raw.replace(/^\.+|\.+$/g, '')
    if (!w || RELEVANCE_STOPWORDS.has(w)) continue
    out.add(w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : stemWord(w))
  }
  return out
}
/** Returns 'evidence_unrelated' when `evidence` cannot be what supports `claim`, else null. */
export function evidenceRelevanceVerdict(claim, evidence) {
  const c = relevanceTerms(claim)
  if (c.size === 0) return null
  const e = relevanceTerms(evidence)
  let hit = 0
  for (const t of c) if (e.has(t)) hit += 1
  if (hit / c.size < RELEVANCE_MIN_OVERLAP) return 'evidence_unrelated'
  const must = []
  for (const t of c) if (/^\d/.test(t)) must.push(t)
  const text = String(claim || '')
  for (const m of text.matchAll(/(?<=[a-z0-9,;:]\s)([A-Z][\w-]{2,})/g)) must.push(stemWord(m[1].toLowerCase()))
  for (const t of must) if (!e.has(t)) return 'evidence_unrelated'
  return null
}

async function evidenceContradiction(claim, deps, orgId) {
  const det = claimContradictsEvidence(claim.content, claim.evidence)
  if (det) return det
  if (!isSemanticDedupEnabled()) return null
  try {
    const d = resolveDeps(deps)
    if (await llmSaysContradiction(claim.content, claim.evidence, d, orgId)) return 'semantic check: contradicts evidence'
  } catch { /* fail safe: keep the deterministic verdict (accept) */ }
  return null
}

// -----------------------------------------------------------------------------
// SEMANTIC DEDUP (Night-2 Pillar 2, I3) — upgrades the miss case above: two
// beliefs the LLM phrases very differently ("The org migrated its primary
// datastore to Postgres." vs "The team decided to use Postgres as the
// database.") share almost no words, so Jaccard scores them as distinct even
// though they're the same fact. Feature-flagged + strictly additive: OFF (the
// default) leaves writeBelief's decision 100% Jaccard, byte-identical to
// before this change. ON, it's a SECOND chance to catch a duplicate Jaccard
// missed — it never overrides an existing Jaccard match, and any embedding
// failure (network error, null vectors, [] from a hard embedTexts failure)
// falls straight back to "no semantic match", i.e. the same outcome as flag
// OFF for that claim. Never throws.
//
// cosineSim mirrors vaultStore.js's private cosineSimilarity() (used there
// for denseSearchChunks) — that function isn't exported, so this is a local
// 3-line reimplementation rather than a cross-module reach-in.
// -----------------------------------------------------------------------------

const SEMANTIC_DEDUP_THRESHOLD_DEFAULT = 0.90
const SEMANTIC_RECENT_POOL = 25

// VAULT-INTEG P17: QUOXDREAM_SEMANTIC_DEDUP_THRESHOLD is a per-org tuning
// knob (writeBelief already has orgId in scope at its one call site below)
// — resolved fresh on every writeBelief() call via
// configResolver.getSetting(), env fallback on any resolver failure.
// QUOXDREAM_SEMANTIC_DEDUP itself (the boolean gate) stays env-only here:
// it is registered in platformCapabilities.js as an 'operator'-visibility
// flag, not 'user'-settable, so there is no stored override for this
// function to consult — VAULT-INTEG P17's territory is the threshold
// knob, not re-classifying the gate.
function isSemanticDedupEnabled() {
  return process.env.QUOXDREAM_SEMANTIC_DEDUP === 'true'
}

async function semanticDedupThreshold(orgId, deps = {}) {
  try {
    const resolved = await getSetting(orgId, 'QUOXDREAM_SEMANTIC_DEDUP_THRESHOLD', deps)
    if (resolved && resolved.value !== undefined) {
      const n = Number(resolved.value)
      if (Number.isFinite(n)) return n
    }
  } catch (err) {
    console.error(`[QuoxDream] QUOXDREAM_SEMANTIC_DEDUP_THRESHOLD resolver failed for org=${orgId}, falling back to env — ${err.message}`)
  }
  const raw = Number(process.env.QUOXDREAM_SEMANTIC_DEDUP_THRESHOLD)
  return Number.isFinite(raw) ? raw : SEMANTIC_DEDUP_THRESHOLD_DEFAULT
}

function cosineSim(a, b) {
  const len = Math.min(a.length, b.length)
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * BRAIN2-W2 2: may this claim's text go to the embedder? False when the
 * source note lives in a vault the org excluded from embedding, or when the
 * exclusion setting is unknowable (no answer, no last-known-good): fail
 * closed. Never throws.
 */
export async function semanticEmbedAllowed(orgId, sourceNoteId, deps = {}) {
  try {
    const { tokens, known } = await resolveEmbedExclusionsDetailed(orgId, deps)
    if (!known) return false
    if (tokens.length === 0) return true
    const db = getDatabase()
    const note = db.prepare('SELECT vault_id FROM notes WHERE id = ? AND org_id = ?').get(sourceNoteId, orgId)
    if (!note) return false // cannot place the note in a vault: do not embed
    const vaults = db.prepare('SELECT id, name FROM vaults WHERE org_id = ?').all(orgId)
    return !excludedVaultIds(tokens, vaults).has(note.vault_id)
  } catch (err) {
    console.error(`[QuoxDream] embed-exclusion check failed for org=${orgId}, not embedding (fail closed): ${err.message}`)
    return false
  }
}

/**
 * Best-effort semantic near-duplicate check against Jaccard-missed
 * candidates. Returns `{ id, score }` of the best match at/above threshold,
 * or `null` if there's no semantic match OR the embedder failed/was
 * unavailable (both cases fall back to the existing Jaccard-only decision).
 * Never throws.
 *
 * @param {string} orgId
 * @param {string} claimContent
 * @param {Array<{id:string, content:string}>} candidates
 * @param {object} deps — resolved deps (fetchImpl/collectorUrl/serviceKey/embedFn)
 * @returns {Promise<{id:string, score:number}|null>}
 */
async function findSemanticDuplicate(orgId, claimContent, candidates, deps) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  try {
    const { embedFn, fetchImpl, collectorUrl, serviceKey } = deps
    const vectors = await embedFn(
      [claimContent, ...candidates.map((c) => c.content)],
      { fetchImpl, collectorUrl, serviceKey }
    )

    if (!Array.isArray(vectors) || vectors.length !== candidates.length + 1) return null
    const claimVec = vectors[0]
    if (!claimVec) return null

    const threshold = await semanticDedupThreshold(orgId, deps)
    let best = null
    let bestScore = -1
    for (let i = 0; i < candidates.length; i++) {
      const vec = vectors[i + 1]
      if (!vec) continue
      const score = cosineSim(claimVec, vec)
      if (score > bestScore) {
        bestScore = score
        best = candidates[i]
      }
    }

    if (best && bestScore >= threshold) return { id: best.id, score: bestScore }
    return null
  } catch (err) {
    console.error(`[QuoxDream] findSemanticDuplicate failed (falling back to Jaccard): ${err.message}`)
    return null
  }
}

// -----------------------------------------------------------------------------
// WRITE — QuoxMemory seam (contract §The seams). Dedup-checks via
// GET /api/memory/search before every write; POSTs /api/memory on a miss.
// Never throws — any HTTP error (bad status or network failure) is caught
// and returned as {action:'error', error}, letting the caller (consolidateSlice)
// skip the claim and move on.
//
// Supersede-on-update (POST /api/memory/consolidate) is explicitly OPTIONAL
// for this MVP per the contract ("if you skip it, note that in a comment")
// — SKIPPED here: a claim carrying supersedes_hint still goes through the
// same dedup-or-add path as any other claim, it just doesn't yet mark an
// existing belief's superseded_by. Wiring that up is left for a later pass
// once there's a reliable way to resolve supersedes_hint (free text) to a
// specific existing memory id.
// -----------------------------------------------------------------------------

const CORROBORATION_CONFIDENCE_BUMP = 0.02
const CORROBORATION_CONFIDENCE_CAP = 0.99
const MAX_CORROBORATING_EVIDENCE = 10

// Audit R07: a duplicate from a NEW source used to be a bare noop and the
// second source was lost. Append it to the existing belief's metadata via the
// memory PATCH route (no new row) and nudge confidence. The same source seen
// again (a held-cursor retry / re-run) stays an idempotent noop.
async function corroborate(match, claim, sourceNoteId, { fetchImpl, memoryUrl, headers, signal }, extra = {}) {
  const meta = (match.metadata && typeof match.metadata === 'object') ? match.metadata : {}
  const known = []
  for (const sid of [match.source_message_id, ...(Array.isArray(meta.sources) ? meta.sources : [])]) {
    if (sid && !known.includes(sid)) known.push(sid)
  }
  if (!sourceNoteId || known.includes(sourceNoteId)) return { action: 'noop', matchedId: match.id, ...extra }
  const sources = [...known, sourceNoteId]
  const evidence = Array.isArray(meta.corroborating_evidence) ? [...meta.corroborating_evidence] : []
  if (claim.evidence && !evidence.includes(claim.evidence) && evidence.length < MAX_CORROBORATING_EVIDENCE) evidence.push(claim.evidence)
  const body = {
    metadata: { ...meta, sources, corroboration_count: sources.length, corroborating_evidence: evidence, last_corroborated_at: new Date().toISOString() }
  }
  if (typeof match.confidence === 'number') {
    body.confidence = Math.min(CORROBORATION_CONFIDENCE_CAP, Math.max(match.confidence, match.confidence + CORROBORATION_CONFIDENCE_BUMP))
  }
  const res = await fetchImpl(`${memoryUrl}/api/memory/${encodeURIComponent(match.id)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal()
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    return { action: 'error', error: `corroborate HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}` }
  }
  return { action: 'corroborated', matchedId: match.id, sources: sources.length, ...extra }
}

/**
 * @param {string} orgId
 * @param {string|null} ownerUserId
 * @param {{content:string, memory_type:string, confidence:number, importance:string, supersedes_hint?:string}} claim
 * @param {string} sourceNoteId
 * @param {object} [deps]
 * @returns {Promise<{action:'noop', matchedId:string}|{action:'add', id:string}|{action:'supersede', id:string, supersededId:string}|{action:'error', error:string}>}
 */
export async function writeBelief(orgId, ownerUserId, claim, sourceNoteId, deps = {}) {
  const resolved = resolveDeps(deps)
  const { fetchImpl, memoryUrl, serviceKey } = resolved
  const headers = {
    'X-Service-Key': serviceKey,
    'X-Org-Id': orgId,
    'X-User-Id': ownerUserId || ORG_BELIEF_USER_ID
  }
  const signal = () => AbortSignal.timeout(resolved.memoryTimeoutMs)

  try {
    const q = encodeURIComponent(claim.content)
    const searchRes = await fetchImpl(`${memoryUrl}/api/memory/search?q=${q}&limit=3`, { headers, signal: signal() })
    if (!searchRes.ok) {
      const bodyText = await searchRes.text().catch(() => '')
      return { action: 'error', error: `search HTTP ${searchRes.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}` }
    }

    const searchData = await searchRes.json()
    const results = Array.isArray(searchData.results) ? searchData.results : []

    // 0) CONTRADICTION first: same topic, opposite polarity. Checked before
    //    the duplicate tests so a reversal is never swallowed as a repeat.
    let contradicted = results.find((m) => isContradiction(claim.content, m.content))
    let contradictionVia = 'heuristic'

    // Codex cycle 4 #10: a user reinstated this belief over the exact wording
    // we are about to write (memory reinstate records it in disputed_claims).
    // Re-reading the source must not re-apply a correction the user rejected.
    if (contradicted && Array.isArray(contradicted.metadata?.disputed_claims) &&
        contradicted.metadata.disputed_claims.some((d) => isNearDuplicate(claim.content, d) && !isContradiction(claim.content, d))) {
      return { action: 'noop', matchedId: contradicted.id, reason: 'disputed_by_user' }
    }

    // 1) Existing Jaccard word-overlap check — unchanged, and checked FIRST
    //    regardless of the semantic flag so an obvious/cheap match never pays
    //    for an embedding call.
    if (!contradicted) {
      const match = results.find((m) => isNearDuplicate(claim.content, m.content))
      if (match) {
        return corroborate(match, claim, sourceNoteId, { fetchImpl, memoryUrl, headers, signal })
      }
    }

    // 2) Semantic dedup — ONLY runs when QUOXDREAM_SEMANTIC_DEDUP=true and
    //    there are FTS candidates to compare against. Best-effort: any
    //    embedder failure/unavailability resolves to `null` (no semantic
    //    match), which is exactly the "flag off" outcome for this claim —
    //    i.e. this is a strict ADDITION on top of the Jaccard decision above,
    //    never a replacement of it. A semantic match with opposite polarity
    //    is a CONTRADICTION; when the heuristics cannot tell, an opt-in LLM
    //    check may (never required, failure keeps DUPLICATE).
    if (!contradicted && isSemanticDedupEnabled() && await semanticEmbedAllowed(orgId, sourceNoteId, deps)) {
      // BRAIN2-W7 096: the lexical top-3 can never contain a paraphrase that
      // shares no words, so widen the candidate pool with the owner's recent
      // valid beliefs of the same type. Best-effort: a failed fetch leaves the
      // lexical candidates unchanged.
      let semanticPool = results
      try {
        const recentRes = await fetchImpl(`${memoryUrl}/api/memory?memory_type=${encodeURIComponent(claim.memory_type)}&valid=true&limit=${SEMANTIC_RECENT_POOL}`, { headers, signal: signal() })
        if (recentRes.ok) {
          const recent = (await recentRes.json()).memories
          if (Array.isArray(recent)) {
            const seen = new Set(results.map((m) => m.id))
            semanticPool = [...results, ...recent.filter((m) => m && m.id && typeof m.content === 'string' && !seen.has(m.id))]
          }
        }
      } catch { /* best-effort */ }
      const semanticMatch = semanticPool.length > 0 ? await findSemanticDuplicate(orgId, claim.content, semanticPool, resolved) : null
      if (semanticMatch) {
        const other = semanticPool.find((m) => m.id === semanticMatch.id)
        if (other && (polarityOf(claim.content) !== polarityOf(other.content) || meaningDiffers(claim.content, other.content))) {
          contradicted = other
          contradictionVia = 'semantic'
        } else if (other && await llmSaysContradiction(claim.content, other.content, resolved, orgId)) {
          contradicted = other
          contradictionVia = 'llm'
        } else {
          return corroborate(other || semanticMatch, claim, sourceNoteId, { fetchImpl, memoryUrl, headers, signal }, { via: 'semantic' })
        }
      }
    }

    const sourceOccurredAt = claim.occurred_at || null
    const body = {
      memory_type: claim.memory_type,
      content: claim.content,
      confidence: claim.confidence,
      stability: stabilityFor(claim.memory_type),
      importance: claim.importance || 'medium',
      provenance: 'model_inference',
      source_message_id: sourceNoteId,
      tags: ['quoxdream']
    }
    if (sourceOccurredAt || contradicted) {
      body.metadata = {
        ...(sourceOccurredAt ? { source_occurred_at: sourceOccurredAt } : {}),
        ...(contradicted ? { supersedes: contradicted.id } : {})
      }
    }

    // RETRY after a failed supersession link: the belief row was already
    // created by the earlier attempt (it carries metadata.supersedes). Reuse it
    // and only redo the link, so a held-cursor retry never duplicates.
    const prior = contradicted
      ? results.find((m) => m.id !== contradicted.id && m.metadata?.supersedes === contradicted.id && isNearDuplicate(claim.content, m.content))
      : null
    let created
    if (prior) {
      created = { id: prior.id }
    } else {
      const postRes = await fetchImpl(`${memoryUrl}/api/memory`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal()
      })

      if (!postRes.ok) {
        const bodyText = await postRes.text().catch(() => '')
        return { action: 'error', error: `create HTTP ${postRes.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}` }
      }

      created = await postRes.json()
    }
    if (!contradicted) return { action: 'add', id: created.id }

    // SUPERSESSION: the NEWER belief wins. Normally that is the claim we just
    // wrote; but a back-dated import (ingested now, dated before the existing
    // belief's source) is the OLDER one and is itself retired instead. Both
    // rows are kept (valid=false + superseded_by link), so history stays
    // queryable while default recall (valid=1 only) returns the live belief.
    // BRAIN2-W7 099: an existing belief with no source date falls back to when it
    // was recorded, so a back-dated import cannot win merely by arriving later.
    const existingAt = contradicted.metadata?.source_occurred_at || contradicted.created_at || null
    const incomingIsOlder = Boolean(sourceOccurredAt && existingAt && Date.parse(sourceOccurredAt) < Date.parse(existingAt))
    const supersededId = incomingIsOlder ? created.id : contradicted.id
    const winnerId = incomingIsOlder ? contradicted.id : created.id
    const reason = `contradiction (${contradictionVia}): "${String(claim.content).slice(0, 120)}" reverses "${String(contradicted.content).slice(0, 120)}"`
    const supersededAt = new Date().toISOString()
    const linkRes = await fetchImpl(`${memoryUrl}/api/memory/consolidate`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contradictions: [{ memory_ids: [supersededId, winnerId], supersede_id: supersededId, resolution: reason, superseded_at: supersededAt }]
      }),
      signal: signal()
    })
    const linkBody = linkRes.ok ? await linkRes.json().catch(() => ({})) : null
    const linked = Boolean(linkRes.ok && (linkBody?.resolved ?? 1) > 0)
    if (!linked) {
      // Infra failure: the caller holds the cursor and retries (see `prior`).
      return { action: 'error', error: linkRes.ok ? 'consolidate resolved 0' : `consolidate HTTP ${linkRes.status}`, createdId: created.id }
    }
    return {
      action: 'supersede',
      id: created.id,
      supersededId,
      winnerId,
      reason,
      linked,
      ...(linked ? {} : { linkError: linkRes.ok ? 'consolidate resolved 0' : `consolidate HTTP ${linkRes.status}` })
    }
  } catch (err) {
    return { action: 'error', error: err.message }
  }
}

// -----------------------------------------------------------------------------
// CONSOLIDATION UNIT (contract §Design consolidateOrg / §WP2) — one tenant
// slice (a single dream_cursor row's worth of work): read new notes since the
// watermark in bounded batches, extract + write beliefs, advance the cursor
// after each batch, record run stats.
// -----------------------------------------------------------------------------

// A note whose extraction fails this many times is retired (never retried).
const DEFAULT_MAX_NOTE_FAILURES = 3

/**
 * @param {string} orgId
 * @param {{scope:string, ownerUserId?:string|null, dryRun?:boolean, maxBatches?:number, batchSize?:number}} opts
 * @param {object} [deps]
 * @returns {Promise<{runId:string, notesRead:number, beliefsWritten:number, beliefsDeduped:number, beliefsSuperseded:number, error:string|null}>}
 */
export async function consolidateSlice(orgId, { scope, ownerUserId = null, dryRun = false, maxBatches = 5, batchSize = 40, maxNoteFailures = DEFAULT_MAX_NOTE_FAILURES } = {}, deps = {}) {
  const runId = vaultStore.startDreamRun(orgId)

  let notesRead = 0
  let beliefsWritten = 0
  let beliefsDeduped = 0
  let beliefsSuperseded = 0
  let notesFailed = 0
  let notesRetired = 0
  let infraFailed = 0
  let claimsRejectedUnsupported = 0
  let notesIncomplete = 0 // BRAIN2-W7 101/102: extraction may not have covered the whole note
  let runError = null

  try {
    batches: for (let batchNum = 0; batchNum < maxBatches; batchNum++) {
      const cursor = vaultStore.getDreamCursor(orgId, scope, ownerUserId)
      const notes = vaultStore.getNotesSinceCursor(orgId, {
        scope,
        ownerUserId,
        // BRAIN2-V3 B2: ingestion order (rowid), not occurred_at, so back-dated
        // imports are not skipped. A legacy cursor with no seq re-sweeps once
        // from 0 (idempotent via dedup).
        afterIngestSeq: cursor?.last_ingest_seq ?? 0,
        limit: batchSize
      })

      if (notes.length === 0) break

      // The cursor only ever advances over notes that were either processed
      // or durably retired. A failed note holds the cursor in place so the
      // next run retries it (BRAIN2-AUDIT: failure accounting + retirement).
      let lastDone = null
      let halted = false
      for (const note of notes) {
        const prior = dryRun ? null : vaultStore.getDreamNoteFailure(orgId, scope, ownerUserId, note.id)
        if (prior?.retired_at) {
          lastDone = note // retired earlier: never retried, move past it
          continue
        }

        notesRead += 1

        let extraction
        try {
          extraction = await extractBeliefsChecked(note.body, { title: note.title, occurredAt: note.occurred_at, orgId }, deps)
        } catch (err) {
          console.error(`[QuoxDream] extractBeliefs threw for note ${note.id}: ${err.message}`)
          extraction = { ok: false, infra: true, claims: [], error: err.message }
        }

        if (!extraction.ok && extraction.infra) {
          // Dependency failure (collector down, 5xx, timeout): says nothing
          // about this note, so it never counts toward retirement. Hold the
          // cursor, record a run-level infra failure, stop the slice; the
          // caller (consolidateOrg -> scheduler) backs off.
          infraFailed += 1
          notesRead -= 1
          runError = `infra failure: ${extraction.error}`
          console.error(`[QuoxDream] extraction dependency failed for note ${note.id} (${extraction.error}); cursor held, not counted against the note`)
          halted = true
          break
        }

        if (!extraction.ok) {
          notesFailed += 1
          if (dryRun) { halted = true; break }
          const count = vaultStore.recordDreamNoteFailure(orgId, scope, ownerUserId, note.id, extraction.error)
          if (count >= maxNoteFailures) {
            vaultStore.retireDreamNote(orgId, scope, ownerUserId, note.id)
            notesRetired += 1
            console.error(`[QuoxDream] note ${note.id} (org=${orgId} scope=${scope}) retired after ${count} failed extractions, last error: ${extraction.error}`)
            lastDone = note
            continue
          }
          console.error(`[QuoxDream] note ${note.id} extraction failed (${count}/${maxNoteFailures}): ${extraction.error}; cursor held, will retry next run`)
          halted = true
          break
        }

        claimsRejectedUnsupported += extraction.rejectedUnsupported || 0
        if (extraction.incomplete) notesIncomplete += 1
        if (!dryRun) vaultStore.clearDreamNoteFailure(orgId, scope, ownerUserId, note.id)

        let writeFailed = null
        for (const claim of extraction.claims) {
          if (dryRun) {
            // dry-run: count only, no memory-service call at all (per
            // contract "(dryRun ? count only : writeBelief)") — tallied into
            // beliefsWritten as "beliefs that would be written".
            beliefsWritten += 1
            continue
          }

          let result
          try {
            result = await writeBelief(orgId, ownerUserId, { ...claim, occurred_at: note.occurred_at }, note.id, deps)
          } catch (err) {
            result = { action: 'error', error: err.message }
          }
          if (result.action === 'add') beliefsWritten += 1
          else if (result.action === 'supersede') { beliefsWritten += 1; beliefsSuperseded += 1 }
          else if (result.action === 'noop' || result.action === 'corroborated') beliefsDeduped += 1
          else {
            // Memory search/create/consolidate failure: says nothing about the
            // note, so it is an infra failure (never toward retirement). Hold
            // the cursor at this note; already-written claims dedup on retry.
            writeFailed = result.error || 'memory write failed'
            break
          }
        }
        if (writeFailed) {
          infraFailed += 1
          notesRead -= 1
          runError = `infra failure: memory write: ${writeFailed}`
          console.error(`[QuoxDream] memory write failed for note ${note.id} (${writeFailed}); cursor held, not counted against the note`)
          halted = true
          break
        }
        lastDone = note
      }

      if (!dryRun && lastDone) {
        vaultStore.setDreamCursor(orgId, scope, ownerUserId, lastDone.occurred_at, lastDone.id, lastDone.ingest_seq ?? null)
      }

      if (halted) break batches
      if (notes.length < batchSize) break // drained
    }
  } catch (err) {
    runError = err.message
  }

  vaultStore.finishDreamRun(runId, { notesRead, beliefsWritten, beliefsDeduped, notesFailed, notesRetired, infraFailed, error: runError })

  return { runId, notesRead, beliefsWritten, beliefsDeduped, beliefsSuperseded, notesFailed, notesRetired, infraFailed, claimsRejectedUnsupported, notesIncomplete, error: runError }
}

/**
 * Runs consolidation for the two ownerless tenant slices of an org: its own
 * 'org'-scope notes, and the instance-wide 'shared'-scope notes (from this
 * org's own dream_cursor watermark into that stream). Per-user-slice
 * enumeration (scope:'user' for every owner_user_id that has authored a
 * note) is explicitly OUT of scope for WP2 — TODO(WP3): enumerate live
 * owner_user_ids and run a consolidateSlice({scope:'user', ownerUserId})
 * per user, mirroring the org-fan-out pattern in
 * collector/lib/memoryConsolidationScheduler.js's fetchLiveOrgIds(). Do NOT
 * build that enumeration here — it's explicitly deferred by the contract's
 * WP breakdown.
 *
 * @param {string} orgId
 * @param {{dryRun?:boolean}} [opts]
 * @param {object} [deps]
 */
export async function consolidateOrg(orgId, { dryRun = false, maxBatches, batchSize, includeShared = false, maxUsers = MAX_USER_SLICES } = {}, deps = {}) {
  const slice = { scope: 'org', dryRun, maxBatches, batchSize }
  const org = await consolidateSlice(orgId, slice, deps)
  // Dependency outage: surface it as a throw so the scheduler's per-org
  // failure streak and backoff engage (an empty return would look healthy).
  if (org.infraFailed > 0) throw new Error(`QuoxDream org=${orgId}: ${org.error}`)
  // BRAIN2-AUDIT: the shared slice is instance-wide content, so consolidating
  // it for EVERY org turned one author's shared notes into beliefs inside
  // every other org's memory. It is now opt-in per call (default off): an org
  // only receives shared-derived beliefs when its caller explicitly asks.
  const shared = includeShared ? await consolidateSlice(orgId, { ...slice, scope: 'shared' }, deps) : null
  // BRAIN2-W5 093: ordinary capture defaults to private (user-scope) notes, so
  // consolidating only the org slice left the front-door content out of the
  // belief loop. One slice per owner of a user-scope note in this org; their
  // beliefs are written under that user (private), never into the org pool.
  const users = []
  for (const ownerUserId of listUserOwners(orgId, maxUsers)) {
    const r = await consolidateSlice(orgId, { scope: 'user', ownerUserId, dryRun, maxBatches, batchSize }, deps)
    users.push({ ownerUserId, ...r })
    if (r.infraFailed > 0) throw new Error(`QuoxDream org=${orgId} user=${ownerUserId}: ${r.error}`)
  }
  return { org, shared, users }
}

const MAX_USER_SLICES = 200

/** Distinct owners of user-scope notes in this org (bounded). */
function listUserOwners(orgId, limit) {
  return getDatabase()
    .prepare("SELECT DISTINCT owner_user_id AS id FROM notes WHERE scope = 'user' AND org_id = ? AND owner_user_id IS NOT NULL AND owner_user_id != '' ORDER BY owner_user_id LIMIT ?")
    .all(orgId, limit)
    .map((r) => r.id)
}

/**
 * BRAIN2-W5 061: delete is not erasure of what was learned from the note.
 * Hard-deletes beliefs whose source_message_id is this note, under the owner
 * the beliefs were written for (shared org owner, or the user for a private
 * note). Best-effort with a deadline; the result is returned so the caller can
 * surface a failure instead of reporting a clean retraction.
 *
 * @returns {Promise<{retracted:number, error:string|null}>}
 */
export async function retractBeliefsForNote(orgId, ownerUserId, noteId, deps = {}) {
  const { fetchImpl, memoryUrl, serviceKey, memoryTimeoutMs } = resolveDeps(deps)
  // deps.before (ISO): only retract beliefs created at or before it, so beliefs
  // derived from a note recreated at the same id after the delete survive.
  const beforeMs = deps.before ? Date.parse(deps.before) : NaN
  const headers = { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId, 'X-User-Id': ownerUserId || ORG_BELIEF_USER_ID }
  let retracted = 0
  try {
    // Codex cycle 6: page until a short page. Deleted rows drop out of the next
    // listing, so the offset only advances past rows kept on purpose (created
    // after `before`, or a server that ignored the filter).
    const PAGE = 200
    for (const valid of ['true', 'false']) {
      let kept = 0
      for (;;) {
        const listRes = await fetchImpl(`${memoryUrl}/api/memory?source_message_id=${encodeURIComponent(noteId)}&valid=${valid}&limit=${PAGE}&offset=${kept}`, { headers, signal: AbortSignal.timeout(memoryTimeoutMs) })
        if (!listRes.ok) return { retracted, error: `list HTTP ${listRes.status}` }
        const { memories = [] } = await listRes.json()
        for (const m of memories) {
          if (m.source_message_id !== noteId) { kept += 1; continue } // server ignored the filter: never delete on a guess
          if (Number.isFinite(beforeMs) && m.created_at && Date.parse(m.created_at) > beforeMs) { kept += 1; continue }
          const delRes = await fetchImpl(`${memoryUrl}/api/memory/${encodeURIComponent(m.id)}?hard=true`, { method: 'DELETE', headers, signal: AbortSignal.timeout(memoryTimeoutMs) })
          if (!delRes.ok) return { retracted, error: `delete HTTP ${delRes.status}` }
          retracted += 1
        }
        if (memories.length < PAGE) break
      }
    }
    return { retracted, error: null }
  } catch (err) {
    return { retracted, error: err.message }
  }
}

export default { retractBeliefsForNote, extractBeliefs, extractBeliefsChecked, stabilityFor, writeBelief, consolidateSlice, consolidateOrg }
