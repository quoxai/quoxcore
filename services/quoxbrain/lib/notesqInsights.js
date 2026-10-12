// notesqInsights.js — NotesQ P5: link suggestions + notebook health.
//
// Read-only. Visibility reuses notesq.visibleNoteRow / store.scopeClause, so a
// private (user-scope) note is never suggested to, or counted for, another user.
// Links resolve only inside one vault, so every suggestion is same-vault.

import matter from 'gray-matter'
import { getDatabase } from './db.js'
import * as store from './vaultStore.js'
import { APP, NotesqError, visibleNoteRow, relatedNotes, safeParse, excerptOf } from './notesq.js'

const VAULT_CAP = 2000     // notes scanned per request
const NEAR_CAP = 500       // most recent notes compared for near duplicates
const GROUP_CAP = 100
const BROKEN_CAP = 200
const MIN_TITLE = 4

const isArchived = (frontmatter) => safeParse(frontmatter || '{}').archived === true

function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.trunc(n), lo), hi)
}

function stripFrontMatter(body) {
  try { return matter(String(body || '')).content } catch { return String(body || '') }
}

// Blank (same-length) every region where a title mention must not count, so
// offsets in the masked text line up with the original markdown.
export function maskNonProse(md) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return String(md || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, blank)
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/!?\[\[[^\]\n]*\]\]/g, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/^#[ \t]+[^\n]*/m, blank) // the note's own title heading
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function findMentions(masked, original, title) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(title)}(?![\\p{L}\\p{N}_])`, 'giu')
  let count = 0
  let first = -1
  let m
  while ((m = re.exec(masked)) !== null) {
    if (first < 0) first = m.index
    count++
    if (m[0].length === 0) re.lastIndex++
  }
  if (!count) return null
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(original)
  const from = Math.max(fm ? fm[0].length : 0, first - 40)
  const snippet = original.slice(from, first + title.length + 40).replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, '$1').replace(/\s+/g, ' ').trim()
  return { count, snippet }
}

export async function suggestLinks({ orgId, userId, id, limit = 8, deps = {} }) {
  const row = visibleNoteRow(orgId, userId, id)
  if (!row) return null
  const lim = clampInt(limit, 1, 20, 8)
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })

  const linked = new Set(
    db.prepare('SELECT target_note_id FROM note_links WHERE source_note_id = ? AND resolved = 1 AND target_note_id IS NOT NULL')
      .all(id).map((r) => r.target_note_id)
  )

  // Same vault only; visibility is re-asserted through the scope clause.
  const cands = db.prepare(`
    SELECT n.id, n.title, n.frontmatter FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id
    WHERE ${sc.sql} AND v.app = ? AND n.vault_id = ? AND n.id != ?
    ORDER BY n.updated_at DESC LIMIT ${VAULT_CAP}
  `).all(...sc.params, APP, row.vault_id, id)

  const original = String(row.body || '')
  const masked = maskNonProse(original)
  const mentions = []
  const mentionIds = new Set()
  for (const c of cands) {
    const title = String(c.title || '').trim()
    if (title.length < MIN_TITLE || linked.has(c.id) || isArchived(c.frontmatter)) continue
    const hit = findMentions(masked, original, title)
    if (!hit) continue
    mentions.push({ id: c.id, title: c.title, count: hit.count, snippet: hit.snippet })
  }
  mentions.sort((a, b) => b.count - a.count || String(a.title).localeCompare(String(b.title)))
  const topMentions = mentions.slice(0, lim)
  for (const m of mentions) mentionIds.add(m.id)

  const rel = await relatedNotes({ orgId, userId, id, limit: 20, deps })
  const vaultOf = db.prepare('SELECT vault_id FROM notes WHERE id = ?')
  const related = []
  for (const r of rel?.related || []) {
    if (related.length >= lim) break
    if (linked.has(r.id) || mentionIds.has(r.id)) continue
    if (vaultOf.get(r.id)?.vault_id !== row.vault_id) continue
    related.push({ id: r.id, title: r.title, excerpt: r.excerpt, score: r.score })
  }
  return { mentions: topMentions, related, mode: rel?.mode || 'lexical' }
}

// ---- health -----------------------------------------------------------------

const normBody = (body) => stripFrontMatter(body).replace(/\s+/g, ' ').trim().toLowerCase()
const normTitle = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()
const brief = (n) => ({ id: n.id, title: n.title, updated_at: n.updated_at })
const newestFirst = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at))

function shingles(text) {
  const words = text.split(' ').filter(Boolean)
  if (words.length < 40) return null
  const set = new Set()
  for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '))
  return set
}

function jaccard(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const s of small) if (big.has(s)) inter++
  return inter / (a.size + b.size - inter)
}

// ONE-BRAIN CX6 gardener: the users who own private (user-scope) NotesQ notes in
// an org. Ids only, no content. Service-only caller (the collector scheduler).
export function gardenUsers(orgId) {
  if (!orgId) return []
  return getDatabase().prepare(`
    SELECT DISTINCT v.owner_user_id AS u FROM vaults v
    WHERE v.org_id = ? AND v.app = ? AND v.scope = 'user' AND v.owner_user_id IS NOT NULL AND v.owner_user_id != ''
      AND EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = v.id)
    ORDER BY u
  `).all(orgId, APP).map((r) => r.u)
}

export function notebookHealth({ orgId, userId, scope = 'org', staleDays = 180 }) {
  if (!['org', 'user'].includes(scope)) throw new NotesqError(400, 'invalid_scope')
  const days = clampInt(staleDays, 30, 3650, 180)
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })

  const raw = db.prepare(`
    SELECT n.id, n.title, n.body, n.frontmatter, n.updated_at, n.vault_id
    FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id
    WHERE ${sc.sql} AND v.app = ? AND n.scope = ?
    ORDER BY n.updated_at DESC, n.id LIMIT ${VAULT_CAP + 1}
  `).all(...sc.params, APP, scope)
  const truncated = raw.length > VAULT_CAP
  const notes = raw.slice(0, VAULT_CAP).filter((n) => !isArchived(n.frontmatter))
  const byId = new Map(notes.map((n) => [n.id, n]))

  // exact + title duplicates
  const duplicates = []
  const exactGroups = new Map()
  const prepared = notes.map((n) => ({ n, body: normBody(n.body) }))
  for (const p of prepared) {
    if (!p.body) continue
    if (!exactGroups.has(p.body)) exactGroups.set(p.body, [])
    exactGroups.get(p.body).push(p.n)
  }
  const exactPair = new Set()
  for (const g of exactGroups.values()) {
    if (g.length < 2) continue
    duplicates.push({ kind: 'exact', similarity: 1, notes: g.slice().sort(newestFirst).map(brief) })
    for (const a of g) for (const b of g) exactPair.add(`${a.id}|${b.id}`)
  }
  const titleGroups = new Map()
  for (const p of prepared) {
    const t = normTitle(p.n.title)
    if (!t) continue
    if (!titleGroups.has(t)) titleGroups.set(t, [])
    titleGroups.get(t).push(p)
  }
  for (const g of titleGroups.values()) {
    if (g.length < 2) continue
    if (new Set(g.map((p) => p.body)).size === 1) continue // all identical: already an exact group
    duplicates.push({ kind: 'title', similarity: null, notes: g.map((p) => p.n).sort(newestFirst).map(brief) })
  }

  // near duplicates among the most recent NEAR_CAP notes (same vault only)
  const recent = prepared.slice(0, NEAR_CAP).map((p) => ({ n: p.n, sh: shingles(p.body) })).filter((p) => p.sh)
  const parent = new Map(recent.map((p) => [p.n.id, p.n.id]))
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const edgeSim = new Map() // root-agnostic: collect min similarity per component after union
  const edges = []
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i], b = recent[j]
      if (a.n.vault_id !== b.n.vault_id || exactPair.has(`${a.n.id}|${b.n.id}`)) continue
      const sim = jaccard(a.sh, b.sh)
      if (sim >= 0.8) { edges.push([a.n.id, b.n.id, sim]); parent.set(find(a.n.id), find(b.n.id)) }
    }
  }
  for (const [x, , sim] of edges) {
    const r = find(x)
    edgeSim.set(r, Math.min(edgeSim.get(r) ?? 1, sim))
  }
  const comps = new Map()
  for (const p of recent) {
    const r = find(p.n.id)
    if (!edgeSim.has(r)) continue
    if (!comps.has(r)) comps.set(r, [])
    comps.get(r).push(p.n)
  }
  for (const [r, g] of comps) {
    if (g.length < 2) continue
    duplicates.push({ kind: 'near', similarity: Number(edgeSim.get(r).toFixed(2)), notes: g.sort(newestFirst).map(brief) })
  }

  // stale: old AND relied on by >= 1 resolved backlink from a non-archived note
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const vaultIds = [...new Set(notes.map((n) => n.vault_id))]
  const backlinks = new Map()
  const broken = new Map()
  const linkStmt = db.prepare(`SELECT source_note_id, target_note_id, target_raw, link_type, resolved FROM note_links WHERE vault_id = ? LIMIT 50000`)
  for (const vid of vaultIds) {
    const seen = new Set()
    for (const l of linkStmt.all(vid)) {
      if (!byId.has(l.source_note_id)) continue
      if (l.resolved && l.target_note_id && l.target_note_id !== l.source_note_id) {
        const key = `${l.source_note_id}>${l.target_note_id}`
        if (seen.has(key)) continue
        seen.add(key)
        backlinks.set(l.target_note_id, (backlinks.get(l.target_note_id) || 0) + 1)
      } else if (!l.resolved && l.link_type === 'wikilink') {
        const key = `${l.source_note_id}\u0000${l.target_raw}`
        const cur = broken.get(key)
        if (cur) cur.count++
        else broken.set(key, { source: { id: l.source_note_id, title: byId.get(l.source_note_id).title }, target_raw: l.target_raw, count: 1 })
      }
    }
  }
  const stale = notes
    .filter((n) => n.updated_at < cutoff && (backlinks.get(n.id) || 0) >= 1)
    .map((n) => ({ id: n.id, title: n.title, updated_at: n.updated_at, backlinks: backlinks.get(n.id) }))
    .sort((a, b) => b.backlinks - a.backlinks || String(a.updated_at).localeCompare(String(b.updated_at)))
    .slice(0, GROUP_CAP)

  const broken_links = [...broken.values()]
    .sort((a, b) => b.count - a.count || String(a.target_raw).localeCompare(String(b.target_raw)))
    .slice(0, BROKEN_CAP)

  return { scope, scanned: notes.length, truncated, duplicates: duplicates.slice(0, GROUP_CAP), stale, broken_links }
}
