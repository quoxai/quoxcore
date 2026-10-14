// entityGrounding.js — brain-level abstention for questions about things the
// results never mention (2026-10-10). Mirrors the Cortex recall check
// (collector recallSearch.js entityGrounding) so the brain's own search and
// every caller of it decline the same way.
//
// A named thing is a capitalised or mixed-case word that is not the first
// word, or a word with a digit ("Istio", "mTLS", "Fly.io", "P8"). Month and
// day names are capitalised by convention, not because they name a thing, so
// they never count. The check reads only salient text (titles, paths, the
// matched passage, the note's opening): a name buried deep in a long list is
// not an answer about it.

const STOP = new Set('a an the and or but of to in on at for by with from as is are was were be been being do does did what which who whom whose when where why how we our us i me my you your it its this that these those there here about into over under than then so if not no yes can could should would will shall may might must have has had any all some ever never just only also very much more most such per via'.split(' '))
const CALENDAR = /^(mid-)?(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)$/i

export function questionEntities(query) {
  const toks = String(query || '').match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || []
  const out = []
  toks.forEach((t, i) => {
    const bare = t.replace(/[._-]+$/, '')
    if (bare.length < 2 || STOP.has(bare.toLowerCase()) || CALENDAR.test(bare)) return
    const capital = /\p{Lu}/u.test(bare) && (i > 0 || /\p{Lu}/u.test(bare.slice(1)))
    if (capital || /\d/.test(bare)) out.push(bare.toLowerCase())
  })
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// Opt-in grounding modes (instance-authority callers only; default 'legacy').
// 'legacy' is questionEntities() unchanged. The others consult a corpus
// sampler: sample(term, variants, limit) returns up to ~30 chunk texts of THIS
// org/user's corpus containing the term (any case); [] when it never occurs.
// ---------------------------------------------------------------------------
export const GROUNDING_MODES = ['legacy', 'position', 'corpusCaps', 'corpusCapsAbsentRare']
// Default 'position' (measured 2026-10-12 on dev7/dev8: no cost vs legacy, and a
// sentence-initial name no longer escapes grounding). 'legacy' stays selectable.
export const DEFAULT_GROUNDING_MODE = 'position'
export function normalizeGroundingMode(m) { return GROUNDING_MODES.includes(m) ? m : DEFAULT_GROUNDING_MODE }

const OPENERS = new Set('please list show tell give explain describe find summarise summarize outline compare check does do did is are was were can could should would will how what which who when where why whose whom any also now then so and but or if for in on at to of with from by about as it its this that these those there here let see get set use using run make add'.split(' '))
const CAPS_MIN_NONSTART = 3
const CAPS_MIN_SHARE = 0.8
const SAMPLE_LIMIT = 30
const MAX_MODE_LOOKUPS = 8
const CACHE_TTL = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 5000
const sampleCache = new Map()

/** Spellings a term may take in the corpus: itself, singular, -ies -> -y. */
export function termVariants(term) {
  const v = new Set([term])
  const sing = term.replace(/(es|s)$/, '')
  if (sing.length >= 2 && sing !== term) v.add(sing)
  if (/ies$/.test(term) && term.length > 4) v.add(term.slice(0, -3) + 'y')
  return [...v]
}

function atSentenceStart(text, i) {
  let j = i - 1
  let sawNewline = false
  while (j >= 0 && i - j <= 16) {
    const c = text[j]
    if (c === '\n') { sawNewline = true; j--; continue }
    if (/[\s"'(\[*_>#`~\-•“‘\d]/.test(c)) { j--; continue }
    return sawNewline || /[.!?:;…]/.test(c)
  }
  return j < 0 || sawNewline
}
const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/** Occurrences of a term in sampled texts: {total, nonStart, capital}; capital = capitalised AND not sentence-initial. */
export function termStats(term, texts) {
  const variants = termVariants(term)
  let total = 0
  let nonStart = 0
  let capital = 0
  for (const text of texts) {
    const s = String(text || '')
    const low = s.toLowerCase()
    if (low.length !== s.length) continue
    const seen = new Set()
    for (const v of variants) {
      let i = low.indexOf(v)
      while (i !== -1) {
        if (!seen.has(i) && !isWordChar(s[i - 1])) {
          seen.add(i)
          let e = i + v.length
          while (isWordChar(s[e])) e++
          total++
          if (!atSentenceStart(s, i)) {
            nonStart++
            if (/\p{Lu}/u.test(s.slice(i, e))) capital++
          }
        }
        i = low.indexOf(v, i + v.length)
      }
    }
  }
  return { total, nonStart, capital }
}

// A term that "looks like a name/code token", never an ordinary word:
// contains a digit, camelCase, or a hyphenated alphanumeric code.
function looksLikeCode(tok) {
  if (/\d/.test(tok)) return true
  if (/[a-z][A-Z]/.test(tok)) return true
  return /^[\p{L}\p{N}]+(-[\p{L}\p{N}]+)+$/u.test(tok) && tok.split('-').some((seg) => /\d/.test(seg))
}

/**
 * Entities for an opt-in mode. Never throws: a sampler failure falls back to
 * the legacy rule for the whole query.
 * @returns {string[]}
 */
export function modeEntities(query, mode, sampleFn, scopeKey = '', now = Date.now()) {
  const m = normalizeGroundingMode(mode)
  const base = questionEntities(query)
  if (m === 'legacy' || typeof sampleFn !== 'function') return base
  const stats = (term) => {
    const key = `${scopeKey}\u0000${term}`
    const hit = sampleCache.get(key)
    if (hit && now - hit.at < CACHE_TTL) return hit.stats
    const texts = sampleFn(term, termVariants(term), SAMPLE_LIMIT) || []
    const st = { empty: !texts.length, ...termStats(term, texts) }
    if (sampleCache.size >= CACHE_MAX_ENTRIES) sampleCache.clear()
    sampleCache.set(key, { at: now, stats: st })
    return st
  }
  try {
    const toks = String(query || '').match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || []
    const out = new Set(base)
    let lookups = 0
    toks.forEach((t, i) => {
      const bare = t.replace(/[._-]+$/, '')
      const low = bare.toLowerCase()
      if (bare.length < 2 || STOP.has(low) || CALENDAR.test(bare) || out.has(low) || lookups >= MAX_MODE_LOOKUPS) return
      const upper = /\p{Lu}/u.test(bare)
      if (i === 0 && upper) {
        if (OPENERS.has(low)) return
        lookups++
        if (stats(low).capital >= 1) out.add(low)
      } else if (!upper && !/\d/.test(bare) && (m === 'corpusCaps' || m === 'corpusCapsAbsentRare')) {
        if (OPENERS.has(low)) return
        lookups++
        const st = stats(low)
        if (st.empty) {
          if (m === 'corpusCapsAbsentRare' && looksLikeCode(bare)) out.add(low)
        } else if (st.nonStart >= CAPS_MIN_NONSTART && st.capital / st.nonStart >= CAPS_MIN_SHARE) out.add(low)
      }
    })
    return [...out]
  } catch (err) {
    console.error('[Brain] grounding mode lookup failed, using legacy rule:', err.message)
    return base
  }
}
export function _clearGroundingCache() { sampleCache.clear() }

// "401s" is grounded by "401", "CVEs" by "CVE".
function mentioned(entity, hay) {
  if (hay.includes(entity)) return true
  const singular = entity.replace(/(es|s)$/, '')
  return singular.length >= 2 && singular !== entity && hay.includes(singular)
}

/**
 * @param {string} query
 * @param {string[]} salientTexts  title + path + passage + note opening of each top result
 * @returns {{entities: string[], missing: string[], ungrounded: boolean}}
 */
export function groundingVerdict(query, salientTexts, precomputed) {
  const entities = Array.isArray(precomputed) ? precomputed : questionEntities(query)
  if (!entities.length) return { entities, missing: [], ungrounded: false }
  const hay = salientTexts.map((t) => String(t || '')).join(' ').toLowerCase()
  const missing = entities.filter((e) => !mentioned(e, hay))
  // None of the named things appear.
  if (missing.length === entities.length) return { entities, missing, ungrounded: true }
  // Several named words and at most half appear ("Tekton ... CI" answered by
  // a note about CI). Number tokens never count here: "95th" or "2026" are
  // details of a question, not the thing it is about.
  const words = entities.filter((e) => !/\d/.test(e))
  const missingWords = words.filter((e) => missing.includes(e))
  const ungrounded = words.length >= 2 && (words.length - missingWords.length) / words.length <= 0.5
  return { entities, missing, ungrounded }
}

/**
 * The one entry point both /brain/search and assembleContext use (codex cycle
 * 6: the guard covered search but not automatic context). Salient text of the
 * top results = title, path, passage and the note's opening.
 * @param {string} query
 * @param {object[]} items  ranked results ({title, relPath, noteId, ...})
 * @param {{passageOf:(r:object)=>string, headOf?:(r:object)=>string, n?:number}} opts
 */
export function groundingForTop(query, items, { passageOf, headOf = () => '', n = 3, entities } = {}) {
  const salient = (items || []).slice(0, n).map((r) => {
    let head = ''
    try { head = headOf(r) || '' } catch { /* passage only */ }
    return `${r.title || ''} ${r.relPath || ''} ${passageOf(r) || ''} ${head}`
  })
  return groundingVerdict(query, salient, entities)
}

export default { modeEntities, questionEntities, groundingVerdict, groundingForTop }
