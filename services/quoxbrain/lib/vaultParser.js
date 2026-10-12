// vaultParser.js — pure markdown/frontmatter parser (P0.2, roadmap QUOXBRAIN #163)
//
// Parses a single note's raw content into { title, frontmatter, body, wordCount,
// links, tags }. NO DB, NO network, NO fs access — the caller (ingest, P0.3)
// reads the file and hands us { relPath, content }.
//
// Must handle two real-world conventions side by side:
//  - NodeBrain style (docs KB): YAML frontmatter (title/category/tags-array/
//    date/author/status), markdown-relative links `[x](y.md)`, raw HTML
//    `<a href="...">` internal links. NO wikilinks, NO inline #tags.
//  - Obsidian-native vaults: `[[wikilinks]]`, `![[embeds]]`, inline `#tags`.
//
// Never throws — malformed frontmatter/HTML/whatever degrades to best-effort.

import matter from 'gray-matter'

const WIKI_EMBED_RE = /!\[\[([^\]]+)\]\]/g
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g
const MD_LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*"|\s+'[^']*')?\s*\)/g
const HTML_A_RE = /<a\s+[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi
const H1_RE = /^\s{0,3}#\s+(.+?)\s*$/m
const INLINE_TAG_RE = /(^|[^\w#/])#([a-zA-Z0-9][\w\-/]*)/g

// -----------------------------------------------------------------------------
// Code-fence / inline-code masking — links/tags inside code must be ignored.
// We replace the interior of fenced blocks (``` or ~~~) and inline `code` spans
// with spaces of equal length so offsets/line-structure are preserved for the
// heading-vs-hashtag check, but no link/tag pattern can match inside them.
// -----------------------------------------------------------------------------
function maskCode(body) {
  let masked = body

  // Fenced code blocks: ``` ... ``` or ~~~ ... ~~~ (multiline, non-greedy)
  masked = masked.replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/g,
    (match, lead, indent, fence, inner) => {
      const blanked = inner.replace(/[^\n]/g, ' ')
      return `${lead}${indent}${fence}   \n${blanked}\n${indent}${fence}   `
    })

  // Inline code spans: `code` (single backtick, non-greedy, no newlines)
  masked = masked.replace(/`([^`\n]+)`/g, (match, inner) => '`' + ' '.repeat(inner.length) + '`')

  return masked
}

function safeFrontmatter(content) {
  try {
    const parsed = matter(content)
    return { frontmatter: parsed.data || {}, body: parsed.content ?? content }
  } catch {
    // Malformed YAML — degrade to "no frontmatter", body = raw content.
    return { frontmatter: {}, body: content }
  }
}

function titleFromFilename(relPath) {
  if (!relPath) return 'Untitled'
  const base = relPath.split('/').pop() || relPath
  return base.replace(/\.md$/i, '')
}

function resolveTitle({ frontmatter, body, relPath }) {
  if (frontmatter && typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim()
  }
  const h1 = H1_RE.exec(body)
  if (h1 && h1[1]) return h1[1].trim()
  return titleFromFilename(relPath)
}

function isExternal(target) {
  return /^(https?:|mailto:)/i.test(target.trim())
}

function stripWikiTarget(raw) {
  // "Target|alias" -> "Target"; "Target#heading" -> "Target"
  let t = raw.split('|')[0]
  t = t.split('#')[0]
  return t.trim()
}

function stripAnchor(target) {
  return target.split('#')[0]
}

function extractLinks(maskedBody) {
  const links = []
  const seenEmbedSpans = []

  // Embeds first (![[...]]) so the wikilink pass below doesn't double-count.
  let m
  WIKI_EMBED_RE.lastIndex = 0
  while ((m = WIKI_EMBED_RE.exec(maskedBody)) !== null) {
    seenEmbedSpans.push([m.index, m.index + m[0].length])
    const target = stripWikiTarget(m[1])
    if (target) links.push({ targetRaw: target, type: 'embed' })
  }

  WIKI_LINK_RE.lastIndex = 0
  while ((m = WIKI_LINK_RE.exec(maskedBody)) !== null) {
    // Skip if this [[...]] is the tail of an already-matched ![[...]] embed.
    const withinEmbed = seenEmbedSpans.some(([s, e]) => m.index >= s && m.index < e)
    if (withinEmbed) continue
    const target = stripWikiTarget(m[1])
    if (target) links.push({ targetRaw: target, type: 'wikilink' })
  }

  MD_LINK_RE.lastIndex = 0
  while ((m = MD_LINK_RE.exec(maskedBody)) !== null) {
    const isImage = m[1] === '!'
    const rawTarget = (m[3] || '').trim()
    if (isImage || !rawTarget) continue
    if (isExternal(rawTarget)) continue
    const target = stripAnchor(rawTarget)
    if (!target) continue
    links.push({ targetRaw: target, type: 'markdown' })
  }

  HTML_A_RE.lastIndex = 0
  while ((m = HTML_A_RE.exec(maskedBody)) !== null) {
    const rawTarget = (m[1] ?? m[2] ?? '').trim()
    if (!rawTarget) continue
    if (isExternal(rawTarget)) continue
    const target = stripAnchor(rawTarget)
    if (!target) continue
    links.push({ targetRaw: target, type: 'html' })
  }

  return links
}

function normalizeTag(raw) {
  return String(raw).trim().replace(/^#/, '')
}

function extractFrontmatterTags(frontmatter) {
  const raw = frontmatter?.tags
  if (raw == null) return []
  let list
  if (Array.isArray(raw)) {
    list = raw
  } else if (typeof raw === 'string') {
    list = raw.split(/[,\s]+/)
  } else {
    return []
  }
  const out = []
  const seen = new Set()
  for (const item of list) {
    const tag = normalizeTag(item)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push({ tag, source: 'frontmatter' })
  }
  return out
}

function extractInlineTags(maskedBody) {
  const out = []
  const seen = new Set()
  // Line-aware pass: a `#` at line-start immediately followed by whitespace
  // (optionally after more `#`s) is a heading, not a hashtag.
  const lines = maskedBody.split('\n')
  for (const line of lines) {
    // Skip heading lines entirely (# Heading, ## Heading, etc.)
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) continue
    INLINE_TAG_RE.lastIndex = 0
    let m
    while ((m = INLINE_TAG_RE.exec(line)) !== null) {
      const tag = normalizeTag(m[2])
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      out.push({ tag, source: 'inline' })
    }
  }
  return out
}

export function parseNote({ relPath, content }) {
  const safeContent = typeof content === 'string' ? content : ''

  let frontmatter = {}
  let body = safeContent
  try {
    const result = safeFrontmatter(safeContent)
    frontmatter = result.frontmatter
    body = result.body
  } catch {
    frontmatter = {}
    body = safeContent
  }

  const title = resolveTitle({ frontmatter, body, relPath })
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0

  const masked = maskCode(body)
  const links = extractLinks(masked)

  const frontmatterTags = extractFrontmatterTags(frontmatter)
  const inlineTags = extractInlineTags(masked)
  const tags = [...frontmatterTags, ...inlineTags]

  return { title, frontmatter, body, wordCount, links, tags }
}

export default { parseNote }
