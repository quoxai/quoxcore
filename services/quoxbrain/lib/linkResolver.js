// linkResolver.js — pure link resolution helpers (P0.2, roadmap QUOXBRAIN #163)
//
// Takes the { targetRaw, type } links produced by vaultParser.parseNote and
// resolves them against an in-memory index of a vault's notes. NO DB, NO fs —
// callers (ingest, P0.3) build the note list from already-parsed notes and
// persist the resolved relPath.

import { posix } from 'path'

function basename(relPath) {
  const seg = String(relPath).split('/').pop() || String(relPath)
  return seg.replace(/\.md$/i, '')
}

// Normalizes a vault-relative path: collapses `.`/`..` segments, strips a
// leading slash (vault paths are always relative to the vault root) and any
// trailing slash.
function normalize(relPath) {
  let p = posix.normalize(String(relPath))
  if (p.startsWith('/')) p = p.slice(1)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/**
 * @param {{relPath: string, title?: string}[]} notes
 * @returns {{byBasename: Map, byRelPath: Map, byTitle: Map}}
 */
export function buildNoteIndex(notes) {
  const byBasename = new Map() // lowercase basename (no .md) -> relPath
  const byRelPath = new Map() // lowercase normalized relPath -> relPath
  const byTitle = new Map() // lowercase title -> relPath
  const paths = [] // lowercase normalized relPaths, insertion order (066 suffix match)

  for (const note of notes || []) {
    if (!note || !note.relPath) continue
    const relPath = note.relPath
    const normalizedKey = normalize(relPath).toLowerCase()
    const baseKey = basename(relPath).toLowerCase()

    if (!byRelPath.has(normalizedKey)) { byRelPath.set(normalizedKey, relPath); paths.push(normalizedKey) }
    if (!byBasename.has(baseKey)) byBasename.set(baseKey, relPath)
    if (note.title) {
      const titleKey = String(note.title).trim().toLowerCase()
      if (titleKey && !byTitle.has(titleKey)) byTitle.set(titleKey, relPath)
    }
  }

  // Every path suffix that starts at a '/' boundary (without .md) -> the FIRST
  // path in insertion order that ends with it, so a path-qualified wikilink
  // resolves by lookup instead of scanning every path (ONE-BRAIN CX1).
  const bySuffix = new Map()
  for (const key of paths) {
    const bare = key.replace(/\.md$/i, '')
    for (let i = bare.indexOf('/'); i !== -1; i = bare.indexOf('/', i + 1)) {
      const suffix = bare.slice(i + 1)
      if (suffix && !bySuffix.has(suffix)) bySuffix.set(suffix, byRelPath.get(key))
    }
  }

  return { byBasename, byRelPath, byTitle, paths, bySuffix }
}

/**
 * Resolves a single link's targetRaw to a note relPath, or null (dangling).
 * @param {{targetRaw: string, type: string}} link
 * @param {string} sourceRelPath - relPath of the note containing the link
 * @param {{byBasename: Map, byRelPath: Map, byTitle: Map}} index
 * @returns {string|null}
 */
export function resolveTarget(link, sourceRelPath, index) {
  if (!link || !link.targetRaw || !index) return null
  const targetRaw = String(link.targetRaw).trim()
  if (!targetRaw) return null
  const { type } = link

  if (type === 'wikilink' || type === 'embed') {
    // BRAIN2-W7 066: a directory-qualified wikilink ([[right/Decision]]) names a
    // path, not just a basename. Match it as a full path or a path suffix
    // (Obsidian semantics) and never fall back to a same-named note elsewhere.
    if (targetRaw.includes('/')) {
      const want = normalize(targetRaw).toLowerCase().replace(/\.md$/i, '')
      const exact = index.byRelPath.get(`${want}.md`) || index.byRelPath.get(want)
      if (exact) return exact
      if (index.bySuffix) return index.bySuffix.get(want) || null
      for (const key of index.paths || []) {
        const bare = key.replace(/\.md$/i, '')
        if (bare.endsWith(`/${want}`)) return index.byRelPath.get(key)
      }
      return null
    }
    const baseKey = basename(targetRaw).toLowerCase()
    const byBase = index.byBasename.get(baseKey)
    if (byBase) return byBase
    const byTitle = index.byTitle.get(targetRaw.toLowerCase())
    if (byTitle) return byTitle
    return null
  }

  if (type === 'markdown' || type === 'html') {
    const dir = posix.dirname(sourceRelPath || '.')
    const joined = posix.join(dir, targetRaw)
    const resolved = normalize(joined)

    const candidates = [resolved, `${resolved}.md`, `${resolved}/index.md`]
    for (const candidate of candidates) {
      const match = index.byRelPath.get(normalize(candidate).toLowerCase())
      if (match) return match
    }
    return null
  }

  return null
}

/**
 * Convenience wrapper: resolves every link on an already-parsed note.
 * @param {{relPath: string, links: {targetRaw: string, type: string}[]}} note
 * @param {{byBasename: Map, byRelPath: Map, byTitle: Map}} index
 * @returns {{targetRaw: string, type: string, targetRelPath: string|null, resolved: boolean}[]}
 */
export function resolveNoteLinks(note, index) {
  const links = note?.links || []
  return links.map((link) => {
    const targetRelPath = resolveTarget(link, note.relPath, index)
    return {
      targetRaw: link.targetRaw,
      type: link.type,
      targetRelPath,
      resolved: targetRelPath != null
    }
  })
}

export default { buildNoteIndex, resolveTarget, resolveNoteLinks }
