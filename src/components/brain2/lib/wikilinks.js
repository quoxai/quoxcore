// Wikilink preprocessing for the Qortex note reader.
//
// Resolution is SERVER-side: GET /notes/:id already returns `outlinks`
// ({ id, targetRaw, resolved }) resolved at ingest. This pure function only
// rewrites `[[Target]]`, `[[Target|label]]`, `[[path/Target#heading]]` in the
// markdown body into ordinary markdown links using fragment hrefs, which the
// reader's `components.a` override interprets. Code fences and inline code are
// left untouched; embeds (`![[...]]`) are not links and are left as-is.

export const WIKILINK_HREF = '#qx-wikilink/'
export const WIKILINK_MISSING_HREF = '#qx-wikilink-missing/'

const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g
// fenced blocks (``` or ~~~) first, then inline code spans
const CODE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g

function splitTarget(inner) {
  const pipe = inner.indexOf('|')
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe)
  const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim()
  const target = targetPart.split('#')[0].trim()
  return { target, display: (alias || targetPart.replace('#', ' > ')).trim() }
}

function escapeLabel(s) {
  return s.replace(/[\\[\]]/g, '\\$&')
}

export function buildOutlinkIndex(outlinks) {
  const map = new Map()
  for (const ol of Array.isArray(outlinks) ? outlinks : []) {
    if (!ol || !ol.targetRaw) continue
    if (ol.type && ol.type !== 'wikilink') continue
    const key = String(ol.targetRaw).trim().toLowerCase()
    const prev = map.get(key)
    if (!prev || (!prev.id && ol.resolved && ol.id)) map.set(key, ol)
  }
  return map
}

function convertSegment(text, index) {
  return text.replace(WIKI_RE, (whole, bang, inner) => {
    if (bang) return whole
    const { target, display } = splitTarget(inner)
    if (!target) return whole
    const hit = index.get(target.toLowerCase())
    const label = escapeLabel(display)
    if (hit && hit.resolved && hit.id) {
      return `[${label}](${WIKILINK_HREF}${encodeURIComponent(hit.id)})`
    }
    return `[${label}](${WIKILINK_MISSING_HREF}${encodeURIComponent(target)})`
  })
}

export function preprocessWikilinks(body, outlinks) {
  if (typeof body !== 'string' || !body.includes('[[')) return body || ''
  const index = buildOutlinkIndex(outlinks)
  let out = ''
  let last = 0
  CODE_RE.lastIndex = 0
  let m
  while ((m = CODE_RE.exec(body)) !== null) {
    out += convertSegment(body.slice(last, m.index), index) + m[0]
    last = m.index + m[0].length
    if (m[0].length === 0) CODE_RE.lastIndex++
  }
  return out + convertSegment(body.slice(last), index)
}

// Parse an href produced above. Returns { kind: 'note', id } | { kind: 'missing', target } | null.
export function parseWikilinkHref(href) {
  if (typeof href !== 'string') return null
  try {
    if (href.startsWith(WIKILINK_HREF)) return { kind: 'note', id: decodeURIComponent(href.slice(WIKILINK_HREF.length)) }
    if (href.startsWith(WIKILINK_MISSING_HREF)) return { kind: 'missing', target: decodeURIComponent(href.slice(WIKILINK_MISSING_HREF.length)) }
  } catch { /* malformed escape */ }
  return null
}
