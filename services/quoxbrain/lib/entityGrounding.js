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
export function groundingVerdict(query, salientTexts) {
  const entities = questionEntities(query)
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
export function groundingForTop(query, items, { passageOf, headOf = () => '', n = 3 } = {}) {
  const salient = (items || []).slice(0, n).map((r) => {
    let head = ''
    try { head = headOf(r) || '' } catch { /* passage only */ }
    return `${r.title || ''} ${r.relPath || ''} ${passageOf(r) || ''} ${head}`
  })
  return groundingVerdict(query, salient)
}

export default { questionEntities, groundingVerdict, groundingForTop }
