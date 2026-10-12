// suggestions.js — "Ask Brain2" starter questions generated FROM the caller's
// own corpus (BRAIN2-AUDIT). Deterministic, no LLM, cached per org+user.
//
// Scoping: every read goes through vaultStore.scopeClause(), exactly like
// /brain/search, so a suggestion can only ever name a note the caller could
// already search for. Machine-exhaust kinds (code, execution wisdom, plan
// documents, identity blobs, raw file chunks) are never used as sources.

import { getDatabase } from './db.js'
import { scopeClause } from './vaultStore.js'

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 500
const DEFAULT_COUNT = 8
const POOL_PER_SOURCE = 40
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const EMPTY_MESSAGE = 'Nothing in your brain to suggest from yet. Connect a source or save a memory, then check back.'

const cache = new Map()

export function clearSuggestionCache() {
  cache.clear()
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!?:;,]+$/, '')
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

// Strip emoji, pictographs and decorative markers so a topic reads as prose.
export function stripMarkers(text) {
  return String(text || '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
    .replace(/^[\s\-*#>_~`|\u2022\u2192]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Cut at the first clause boundary so long descriptions do not become questions.
export function firstClause(text, max = 70) {
  let t = stripMarkers(text).replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim()
  const cut = t.search(/\s[\u2014\u2013-]\s|[:;.!?]\s|[:;]$/)
  if (cut > 8) t = t.slice(0, cut)
  return clip(t, max)
}

// "quoxvoice-brutaloop-call-quality-2026-10-02" -> "quoxvoice brutaloop call quality"
export function humaniseName(name) {
  return stripMarkers(String(name || '').replace(/\.md$/i, ''))
    .replace(/[-_]+(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2})$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function memoryTopic(fm, title) {
  const named = humaniseName(fm.name)
  if (named.split(' ').length >= 2 && named.length >= 8) return clip(named, 70)
  const fromDesc = firstClause(fm.description, 70)
  if (fromDesc.length >= 12) return fromDesc
  return firstClause(title, 70)
}

function parseFrontmatter(raw) {
  if (!raw) return {}
  try {
    const fm = JSON.parse(raw)
    return fm && typeof fm === 'object' ? fm : {}
  } catch {
    return {}
  }
}

function recentRows(db, orgId, userId, whereSql, whereParams = []) {
  const { sql, params } = scopeClause(orgId, userId, { alias: 'n' })
  return db.prepare(`
    SELECT n.id, n.title, n.rel_path, n.kind, n.frontmatter, n.occurred_at
    FROM notes n
    WHERE ${sql} AND ${whereSql}
    ORDER BY COALESCE(n.occurred_at, n.updated_at) DESC
    LIMIT ${POOL_PER_SOURCE}
  `).all(...params, ...whereParams)
}

const ts = (row) => Date.parse(row.occurred_at || '') || 0

function streamCandidates(db, orgId, userId) {
  const out = []
  const seen = new Set()
  for (const row of recentRows(db, orgId, userId, "n.kind = 'quoxplan_stream'")) {
    const name = firstClause(row.title, 70)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      question: `What's still open on ${name}?`,
      reason: 'A recently updated QuoxPlan stream',
      source: 'QuoxPlan',
      noteId: row.id,
      at: ts(row)
    })
  }
  // Decisions: stream notes, keyed by the stream name before " — note ".
  const decided = new Set(seen)
  for (const row of recentRows(db, orgId, userId, "n.kind = 'quoxplan_note'")) {
    const name = firstClause(String(row.title || '').split(' \u2014 note ')[0], 70)
    if (!name || decided.has(name.toLowerCase())) continue
    decided.add(name.toLowerCase())
    out.push({
      question: `What did we decide about ${name}?`,
      reason: 'A stream with a recent note',
      source: 'QuoxPlan',
      noteId: row.id,
      at: ts(row)
    })
  }
  return out
}

function memoryCandidates(db, orgId, userId) {
  const out = []
  const seen = new Set()
  for (const row of recentRows(db, orgId, userId, "n.kind = 'note' AND n.rel_path LIKE 'memory/%'")) {
    const fm = parseFrontmatter(row.frontmatter)
    const type = String(fm.type || '').toLowerCase()
    if (type && type !== 'feedback' && type !== 'project') continue
    const basis = memoryTopic(fm, row.title)
    if (basis.length < 12 || /^memory\b/i.test(basis) || seen.has(basis.toLowerCase())) continue
    seen.add(basis.toLowerCase())
    out.push({
      question: `What do I know about ${basis}?`,
      reason: 'A memory you saved recently',
      source: 'saved memory',
      noteId: row.id,
      at: ts(row)
    })
  }
  return out
}

function gitCandidates(db, orgId, userId, now) {
  const out = []
  const seen = new Set()
  for (const row of recentRows(db, orgId, userId, "n.kind IN ('commit', 'git_commit')")) {
    const m = /^git\/([^/]+)\//.exec(row.rel_path || '')
    const repo = m && m[1]
    if (!repo || seen.has(repo)) continue
    seen.add(repo)
    const when = now - ts(row) <= WEEK_MS ? 'this week' : 'recently'
    out.push({
      question: `What changed in ${repo} ${when}?`,
      reason: `Recent commits in ${repo}`,
      source: 'git history',
      noteId: row.id,
      at: ts(row)
    })
  }
  return out
}

// BRAIN2-W7 E 136: ordinary captured notes and connected documents (not the
// memory/ exhaust, which memoryCandidates owns) are valid question sources.
const DOCUMENT_KINDS = "'note', 'obsidian_note', 'notion_page', 'gdrive_file', 'folder_note'"
function documentCandidates(db, orgId, userId) {
  const out = []
  const seen = new Set()
  for (const row of recentRows(db, orgId, userId, `n.kind IN (${DOCUMENT_KINDS}) AND COALESCE(n.rel_path, '') NOT LIKE 'memory/%'`)) {
    const topic = firstClause(row.title, 70)
    if (topic.length < 8 || /^[0-9a-f-]{16,}$/i.test(topic) || /^untitled/i.test(topic) || seen.has(topic.toLowerCase())) continue
    seen.add(topic.toLowerCase())
    out.push({
      question: `What do my notes say about ${topic}?`,
      reason: 'A note or document you added recently',
      source: 'your notes',
      noteId: row.id,
      at: ts(row)
    })
  }
  return out
}

function sessionCandidates(db, orgId, userId) {
  const out = []
  const seen = new Set()
  for (const row of recentRows(db, orgId, userId, "n.kind = 'transcript_session'")) {
    const title = clip(String(row.title || '').replace(/\s*\(part \d+\)$/i, ''), 70)
    // Untitled sessions fall back to a uuid; that is exhaust, not a topic.
    if (title.length < 8 || /^[0-9a-f-]{16,}$/i.test(title) || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    out.push({
      question: `What happened in the ${title} session?`,
      reason: 'A recent past session',
      source: 'past session',
      noteId: row.id,
      at: ts(row)
    })
  }
  return out
}

/**
 * Pure builder (no cache). Round-robins across sources so one noisy source
 * cannot crowd out the rest; within a source, newest first. Sources are
 * ordered by their freshest candidate.
 */
export function buildSuggestions(orgId, userId, { count = DEFAULT_COUNT, now = Date.now() } = {}) {
  const db = getDatabase()
  const lists = [
    streamCandidates(db, orgId, userId),
    memoryCandidates(db, orgId, userId),
    gitCandidates(db, orgId, userId, now),
    documentCandidates(db, orgId, userId),
    sessionCandidates(db, orgId, userId)
  ].filter((l) => l.length > 0)
  lists.sort((a, b) => b[0].at - a[0].at)

  const picked = []
  const seenQ = new Set()
  for (let i = 0; picked.length < count; i += 1) {
    let any = false
    for (const list of lists) {
      if (i >= list.length) continue
      any = true
      const c = list[i]
      const key = c.question.toLowerCase()
      if (seenQ.has(key)) continue
      seenQ.add(key)
      picked.push({ question: c.question, reason: c.reason, source: c.source, noteId: c.noteId })
      if (picked.length >= count) break
    }
    if (!any) break
  }
  return picked
}

// BRAIN2-W7 E 138: a cheap corpus fingerprint (scoped note count + newest update).
// A cached entry is only served while it still matches, so a deleted, corrected
// or retitled note stops being suggested immediately, not after the TTL.
function corpusFingerprint(orgId, userId) {
  try {
    const { sql, params } = scopeClause(orgId, userId, { alias: 'n' })
    const r = getDatabase().prepare(`SELECT COUNT(*) AS c, MAX(n.updated_at) AS u FROM notes n WHERE ${sql}`).get(...params)
    return `${r.c}|${r.u || ''}`
  } catch {
    return `err:${Math.random()}` // never serve cache when the fingerprint cannot be read
  }
}

export function getSuggestions(orgId, userId, { count = DEFAULT_COUNT, now = Date.now() } = {}) {
  const key = `${orgId}\u0000${userId || ''}\u0000${count}`
  const fingerprint = corpusFingerprint(orgId, userId)
  const hit = cache.get(key)
  if (hit && hit.fingerprint === fingerprint && now - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true }

  const suggestions = buildSuggestions(orgId, userId, { count, now })
  const value = suggestions.length
    ? { suggestions, generatedAt: new Date(now).toISOString() }
    : { suggestions: [], message: EMPTY_MESSAGE, generatedAt: new Date(now).toISOString() }

  // Empty results are not cached: a first ingest should show up immediately.
  if (suggestions.length) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
    cache.set(key, { at: now, value, fingerprint })
  }
  return { ...value, cached: false }
}

/** Registers GET /brain/suggestions. `authenticate` is the shared middleware. */
export function registerSuggestionRoutes(app, authenticate) {
  app.get('/brain/suggestions', authenticate, (req, res) => {
    try {
      const n = Number.parseInt(req.query.count, 10)
      const count = Number.isFinite(n) ? Math.min(Math.max(n, 1), 20) : DEFAULT_COUNT
      res.json(getSuggestions(req.org_id, req.user_id, { count }))
    } catch (error) {
      console.error('[Brain] Suggestions error:', error)
      res.status(500).json({ error: error.message })
    }
  })
}
