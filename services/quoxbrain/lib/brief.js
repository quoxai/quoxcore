// brief.js — "what's new in my brain" daily brief (BRAIN2-V3 B3).
// Deterministic, no LLM. Every read goes through vaultStore.scopeClause(), the
// same scoping /brain/search uses, so a brief can only name notes the caller
// could already search for. Cached briefly per org+user+window.

import { getDatabase } from './db.js'
import { scopeClause } from './vaultStore.js'
import { firstClause } from './suggestions.js'
import { getSuggestions } from './suggestions.js'

const CACHE_TTL_MS = 60 * 1000
const CACHE_MAX_ENTRIES = 300
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000
const TOP_NOTES = 8
// Machine exhaust is counted but never surfaced as a "top new note".
const EXHAUST_KINDS = ['code', 'tasks_execution_wisdom', 'file_chunk', 'identity']

const STREAM_RE = /^[A-Z0-9][A-Z0-9-]{1,40}$/
const STREAM_MENTION_LIMIT = 2000

export function isValidStream(s) { return typeof s === 'string' && STREAM_RE.test(s) }

// Stream filter: the stream's own vault notes (quoxplan/<ID>/...) plus notes
// OUTSIDE the quoxplan vault whose title/body mention the id as a whole word.
// The mention lookup is a bounded FTS5 phrase MATCH (tokenizer splits on '-',
// so "AQ-9F" becomes the phrase "AQ 9F"), never a LIKE scan.
function streamClause(stream) {
  if (!stream) return { sql: '1=1', params: [] }
  const prefix = `quoxplan/${stream}/`
  const phrase = `"${stream.replace(/-/g, ' ')}"`
  return {
    sql: `(substr(n.rel_path, 1, ${prefix.length}) = ? OR (n.rel_path NOT LIKE 'quoxplan/%' AND n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? LIMIT ${STREAM_MENTION_LIMIT})))`,
    params: [prefix, phrase]
  }
}

const cache = new Map()
export function clearBriefCache() { cache.clear() }

/** "24h" | "7d" | "90m" | bare number of hours -> ms (clamped), or null if invalid. */
export function parseSince(raw) {
  if (raw == null || raw === '') return DEFAULT_SINCE_MS
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw]?)$/i.exec(String(raw).trim())
  if (!m) return null
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[(m[2] || 'h').toLowerCase()]
  const ms = Number(m[1]) * unit
  if (!(ms > 0)) return null
  return Math.min(ms, MAX_SINCE_MS)
}

function label(kind, sourceType) {
  if (kind === 'quoxplan_stream' || kind === 'quoxplan_note') return 'QuoxPlan'
  if (kind === 'commit' || kind === 'git_commit') return 'git history'
  if (kind === 'transcript_session') return 'past sessions'
  if (kind === 'note') return 'notes and memories'
  return sourceType || kind || 'other'
}

// 2026-10-11: every QuoxPlan note carries its stream's title ("One Brain"),
// so a stream digest listed the same title N times. For those, show the
// note's own first line (skipping front matter and headings).
export function noteHeadline(body) {
  const t = String(body || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim()
    // QuoxPlan notes open with 'Author: x' / 'Date: y' metadata lines.
    if (l && !l.startsWith('#') && !/^(author|date|stream|status|by|at):\s/i.test(l)) return l
  }
  return ''
}
function briefTitle(r) {
  const fallback = firstClause(r.title, 90) || String(r.title || 'Untitled').slice(0, 90)
  if (r.kind !== 'quoxplan_note') return fallback
  const h = noteHeadline(r.head)
  return h ? firstClause(h, 90) || h.slice(0, 90) : fallback
}

export function buildBrief(orgId, userId, { sinceMs = DEFAULT_SINCE_MS, now = Date.now(), stream = null } = {}) {
  const db = getDatabase()
  const sinceIso = new Date(now - sinceMs).toISOString()
  const scoped = scopeClause(orgId, userId, { alias: 'n' })
  const st = streamClause(stream)
  const sql = `${scoped.sql} AND ${st.sql}`
  const params = [...scoped.params, ...st.params]

  const kinds = db.prepare(
    `SELECT n.kind AS kind, n.source_type AS source_type, COUNT(*) AS c FROM notes n
     WHERE ${sql} AND n.created_at >= ? GROUP BY n.kind, n.source_type`
  ).all(...params, sinceIso)
  const bySource = new Map()
  let total = 0
  for (const r of kinds) {
    const l = label(r.kind, r.source_type)
    bySource.set(l, (bySource.get(l) || 0) + r.c)
    total += r.c
  }
  const counts = [...bySource.entries()].map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))

  const ph = EXHAUST_KINDS.map(() => '?').join(',')
  const top = db.prepare(
    `SELECT n.id, n.title, n.kind, n.created_at, substr(n.body, 1, 600) AS head FROM notes n
     WHERE ${sql} AND n.created_at >= ? AND COALESCE(n.kind,'') NOT IN (${ph})
     ORDER BY n.created_at DESC, n.id DESC LIMIT ${TOP_NOTES}`
  ).all(...params, sinceIso, ...EXHAUST_KINDS)
  const topNotes = top.map((r) => ({
    noteId: r.id,
    title: briefTitle(r),
    source: label(r.kind),
    at: r.created_at
  }))

  // BRAIN2-W7 E 139: notes created BEFORE the window but changed inside it. A
  // corrected decision or revised plan is news even though no note is new.
  const updatedRows = db.prepare(
    `SELECT n.id, n.title, n.kind, n.updated_at, substr(n.body, 1, 600) AS head FROM notes n
     WHERE ${sql} AND n.created_at < ? AND n.updated_at >= ? AND COALESCE(n.kind,'') NOT IN (${ph})
     ORDER BY n.updated_at DESC, n.id DESC`
  ).all(...params, sinceIso, sinceIso, ...EXHAUST_KINDS)
  const updates = {
    total: updatedRows.length,
    notes: updatedRows.slice(0, TOP_NOTES).map((r) => ({
      noteId: r.id,
      title: briefTitle(r),
      source: label(r.kind),
      at: r.updated_at
    }))
  }

  // Beliefs live in QuoxMemory, not in quoxbrain tables; the dream run ledger is
  // the only belief signal here (org-level counts, no belief text).
  let beliefs = null
  try {
    const b = db.prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(beliefs_written),0) AS written, COALESCE(SUM(beliefs_deduped),0) AS deduped
       FROM dream_runs WHERE org_id = ? AND started_at >= ?`
    ).get(orgId, sinceIso)
    if (b.runs > 0) beliefs = { dreamRuns: b.runs, written: b.written, deduped: b.deduped }
  } catch { beliefs = null }

  const openQuestions = getSuggestions(orgId, userId, { count: 4, now }).suggestions
    .map((s) => ({ question: s.question, source: s.source, noteId: s.noteId }))

  return {
    since: sinceIso,
    until: new Date(now).toISOString(),
    total,
    counts,
    topNotes,
    updates,
    beliefs,
    openQuestions,
    summary: (total === 0
      ? 'Nothing new entered your brain in this window.'
      : `${total} new item${total === 1 ? '' : 's'}: ${counts.slice(0, 4).map((c) => `${c.count} ${c.source}`).join(', ')}.`)
      + (updates.total > 0 ? ` ${updates.total} existing note${updates.total === 1 ? ' was' : 's were'} updated.` : '')
  }
}

export function getBrief(orgId, userId, { sinceMs = DEFAULT_SINCE_MS, now = Date.now(), stream = null } = {}) {
  const key = `${orgId}\u0000${userId || ''}\u0000${sinceMs}\u0000${stream || ''}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true }
  const value = buildBrief(orgId, userId, { sinceMs, now, stream })
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
  cache.set(key, { at: now, value })
  return { ...value, cached: false }
}

/** Registers GET /brain/brief?since=24h[&stream=ID]. */
export function registerBriefRoutes(app, authenticate) {
  app.get('/brain/brief', authenticate, (req, res) => {
    const sinceMs = parseSince(req.query.since)
    if (sinceMs == null) return res.status(400).json({ error: 'invalid_since', hint: 'use e.g. 24h, 7d, 90m' })
    const stream = req.query.stream == null || req.query.stream === '' ? null : req.query.stream
    if (stream != null && !isValidStream(stream)) return res.status(400).json({ error: 'invalid_stream', hint: 'a QuoxPlan stream id such as AQ-9F' })
    try {
      res.json({ ...getBrief(req.org_id, req.user_id, { sinceMs, stream }), ...(stream ? { stream } : {}) })
    } catch (error) {
      console.error('[Brain] Brief error:', error)
      res.status(500).json({ error: 'internal_error' })
    }
  })
}
