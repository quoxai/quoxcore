// notesq.js — NotesQ P0 substrate.
//
// NotesQ notes are markdown docs stored in quoxbrain PUSH vaults tagged
// vaults.app = 'notesq'. Parse/chunk/links/tags reuse lib/ingest.js
// ingestDocuments (no duplicated pipeline); removal reuses store.deleteNote
// (the same call ingest's deleteAbsent path makes; links/tags/chunks/FTS rows
// cascade or trigger off the notes row). Every mutation appends a row to
// note_revisions (migrations/010-notesq.sql).
//
// Authority: visibility = store.scopeClause AND vault.app='notesq'; write =
// store.canWriteVault; delete = author of rev 1, admin, or owner of a
// user-scope vault. Functions throw NotesqError(status, code) for the route
// layer to map; org_id is never part of any returned shape.

import { randomUUID, createHash } from 'crypto'
import { ulid } from 'ulid'
import { getDatabase } from './db.js'
import * as store from './vaultStore.js'
import { ingestDocuments } from './ingest.js'
import matter from 'gray-matter'
import { drainNote } from './retractionOutbox.js'
import { isHybridEnabled, tryHybridFusion } from './contextAssembler.js'
import { getSetting } from './configResolver.js'

export const MAX_CONTENT_BYTES = 1024 * 1024
const APP = 'notesq'
// Every notes query is written `FROM vaults v CROSS JOIN notes n` so SQLite
// drives it from the handful of notesq vaults through idx_notes_vault. With a
// plain JOIN the planner picks the scope OR-index and walks EVERY note in the
// org (400k+ Brain2 notes live): 1.2s for an empty notebook vs ~30ms.
// INDEXED BY pins it: an n.scope = ? filter (scope=org/user) otherwise pulls
// the planner back to idx_notes_scope (live 2026-10-05: facets 11.7s).

export class NotesqError extends Error {
  constructor(status, code, extra = {}) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const nowIso = () => new Date().toISOString()

// In-process per-note serialisation: ingestDocuments yields the event loop,
// so two concurrent writers could both pass the base_hash check.
const locks = new Map()
export async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  let release
  const gate = new Promise((r) => { release = r })
  const chain = prev.then(() => gate)
  locks.set(key, chain)
  await prev
  try { return await fn() } finally {
    release()
    if (locks.get(key) === chain) locks.delete(key)
  }
}

function publicVault(v) {
  return { id: v.id, name: v.name, scope: v.scope, app: v.app, note_count: v.note_count, status: v.status }
}

function validateContent(content) {
  if (typeof content !== 'string') throw new NotesqError(400, 'content_must_be_string')
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) throw new NotesqError(400, 'content_too_large')
}

function validateKind(kind) {
  if (kind !== 'human' && kind !== 'agent') throw new NotesqError(400, 'invalid_author_kind')
}

export function ensureNotesVault({ orgId, userId, scope }) {
  if (scope !== 'org' && scope !== 'user') throw new NotesqError(400, 'invalid_scope')
  const db = getDatabase()
  if (scope === 'org') {
    const existing = db.prepare("SELECT * FROM vaults WHERE org_id = ? AND scope = 'org' AND app = ? AND source_path = 'notesq:org'").get(orgId, APP)
    if (existing) return existing
    const v = store.createVault({ org_id: orgId, name: 'NotesQ', source_type: 'push', source_path: 'notesq:org', scope: 'org', app: APP })
    if (v.app !== APP) throw new NotesqError(409, 'vault_conflict')
    store.setVaultStatus(v.id, 'ready')
    return db.prepare('SELECT * FROM vaults WHERE id = ?').get(v.id)
  }
  const existing = db.prepare("SELECT * FROM vaults WHERE scope = 'user' AND owner_user_id = ? AND app = ?").get(userId, APP)
  if (existing) return existing
  const v = store.createVault({ org_id: orgId, name: 'NotesQ (personal)', source_type: 'push', source_path: `notesq:user:${userId}`, scope: 'user', owner_user_id: userId, app: APP })
  if (v.app !== APP) throw new NotesqError(409, 'vault_conflict')
  store.setVaultStatus(v.id, 'ready')
  return db.prepare('SELECT * FROM vaults WHERE id = ?').get(v.id)
}

// Plain-text preview: the markdown body without its YAML frontmatter block.
function excerptOf(body) {
  let text = body || ''
  try { text = matter(text).content } catch { /* malformed frontmatter: fall back to raw */ }
  // The title is shown separately, so a leading H1 would just repeat it.
  text = text.trimStart().replace(/^#\s+[^\n]*\n*/, '')
  // Plain text for a preview line: drop markdown syntax, keep the words.
  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')          // images -> alt
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1')    // [[Note|alias]] -> Note
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // [text](url) -> text
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')                 // code
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2') // bold/italic/strike
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/gm, '') // headings, quotes, list markers, task boxes
    .replace(/\s+/g, ' ')
  return text.trim().slice(0, 200)
}

function shapeSummary(n, tags) {
  const body = n.body || ''
  const frontmatter = typeof n.frontmatter === 'string' ? safeParse(n.frontmatter) : (n.frontmatter || {})
  return {
    id: n.id,
    rel_path: n.rel_path,
    title: n.title,
    frontmatter,
    properties: frontmatter,
    ...(tags ? { tags } : {}),
    scope: n.scope,
    vault_id: n.vault_id,
    content_hash: n.content_hash,
    updated_at: n.updated_at,
    excerpt: excerptOf(body)
  }
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

function visibleNoteRow(orgId, userId, id) {
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })
  return db.prepare(`
    SELECT n.*, v.app AS v_app FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id
    WHERE ${sc.sql} AND v.app = ? AND n.id = ?
  `).get(...sc.params, APP, id) || null
}

const FM = (key) => `(CASE WHEN json_valid(n.frontmatter) THEN json_extract(n.frontmatter, '${key}') END)`
const FM_PINNED = `COALESCE(${FM('$.pinned')} = 1, 0)`
const FM_ARCHIVED = `COALESCE(${FM('$.archived')} = 1, 0)`

// FTS5 MATCH input is never passed through raw: only word tokens survive,
// each quoted and prefix-starred, AND-joined. No tokens = no filter.
function ftsQuery(q) {
  const toks = String(q || '').match(/[\p{L}\p{N}_]+/gu) || []
  return toks.slice(0, 12).map((t) => `"${t}"*`).join(' ')
}

function checkScope(scope) {
  if (!['org', 'user', 'all'].includes(scope)) throw new NotesqError(400, 'invalid_scope')
}

export function listNotes({ orgId, userId, scope = 'all', limit = 50, offset = 0, q, collection, tag, pinned, archived = 'exclude' }) {
  checkScope(scope)
  if (!['exclude', 'only', 'include'].includes(archived)) throw new NotesqError(400, 'invalid_archived')
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })
  const scopeSql = scope === 'all' ? '' : ` AND n.scope = '${scope}'`
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const off = Math.max(Number(offset) || 0, 0)
  let where = `${sc.sql} AND v.app = ?${scopeSql}`
  const params = [...sc.params, APP]
  const match = ftsQuery(q)
  if (match) { where += ' AND n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)'; params.push(match) }
  if (typeof collection === 'string' && collection) { where += ` AND ${FM('$.collection')} = ?`; params.push(collection) }
  if (typeof tag === 'string' && tag) { where += ' AND EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag = ?)'; params.push(tag) }
  if (pinned === 'true' || pinned === true) where += ` AND ${FM_PINNED} = 1`
  else if (pinned === 'false' || pinned === false) where += ` AND ${FM_PINNED} = 0`
  if (archived === 'exclude') where += ` AND ${FM_ARCHIVED} = 0`
  else if (archived === 'only') where += ` AND ${FM_ARCHIVED} = 1`
  const base = `FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id WHERE ${where}`
  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c
  const rows = db.prepare(`SELECT n.* ${base} ORDER BY ${FM_PINNED} DESC, n.updated_at DESC, n.id LIMIT ? OFFSET ?`).all(...params, lim, off)
  const tagMap = new Map()
  if (rows.length) {
    const ph = rows.map(() => '?').join(',')
    for (const r of db.prepare(`SELECT note_id, tag FROM note_tags WHERE note_id IN (${ph}) ORDER BY tag`).all(...rows.map((r) => r.id))) {
      if (!tagMap.has(r.note_id)) tagMap.set(r.note_id, [])
      tagMap.get(r.note_id).push(r.tag)
    }
  }
  return { notes: rows.map((r) => shapeSummary(r, tagMap.get(r.id) || [])), total }
}

export function getFacets({ orgId, userId, scope = 'all' }) {
  checkScope(scope)
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })
  const scopeSql = scope === 'all' ? '' : ` AND n.scope = '${scope}'`
  const base = `FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id WHERE ${sc.sql} AND v.app = ?${scopeSql}`
  const p = [...sc.params, APP]
  const live = `${base} AND ${FM_ARCHIVED} = 0`
  const collections = db.prepare(`SELECT ${FM('$.collection')} AS coll, COUNT(*) AS count ${live} AND typeof(${FM('$.collection')}) = 'text' AND ${FM('$.collection')} != '' GROUP BY 1 ORDER BY 1`).all(...p).map((r) => ({ name: r.coll, count: r.count }))
  const tags = db.prepare(`SELECT t.tag AS tag, COUNT(*) AS count FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id CROSS JOIN note_tags t ON t.note_id = n.id WHERE ${sc.sql} AND v.app = ?${scopeSql} AND ${FM_ARCHIVED} = 0 GROUP BY t.tag ORDER BY count DESC, t.tag`).all(...p)
  const total = db.prepare(`SELECT COUNT(*) AS c ${live}`).get(...p).c
  const pinned = db.prepare(`SELECT COUNT(*) AS c ${live} AND ${FM_PINNED} = 1`).get(...p).c
  const archived = db.prepare(`SELECT COUNT(*) AS c ${base} AND ${FM_ARCHIVED} = 1`).get(...p).c
  return { collections, tags, total, pinned, archived }
}

export function searchTitles({ orgId, userId, scope = 'all', q }) {
  checkScope(scope)
  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId, { alias: 'n' })
  const scopeSql = scope === 'all' ? '' : ` AND n.scope = '${scope}'`
  const needle = String(q || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase()
  let where = `${sc.sql} AND v.app = ?${scopeSql}`
  const params = [...sc.params, APP]
  if (needle) { where += " AND lower(n.title) LIKE ? ESCAPE '\\'"; params.push(`%${needle}%`, ) }
  const rows = db.prepare(`
    SELECT n.id, n.title, n.scope FROM vaults v CROSS JOIN notes n INDEXED BY idx_notes_vault ON n.vault_id = v.id WHERE ${where}
    ORDER BY (lower(n.title) LIKE ? ESCAPE '\\') DESC, n.title LIMIT 20
  `).all(...params, needle ? `${needle}%` : '%')
  return { titles: rows.map((r) => ({ id: r.id, title: r.title, scope: r.scope })) }
}

// Compose raw content from {markdown, properties}. Raw content stays canonical.
const SCALAR = (v) => ['string', 'number', 'boolean'].includes(typeof v)
export function composeContent({ content, markdown, properties }) {
  if (typeof content === 'string' || (markdown === undefined && properties === undefined)) return content
  if (typeof markdown !== 'string') throw new NotesqError(400, 'content_must_be_string')
  const props = {}
  if (properties !== undefined && properties !== null) {
    if (typeof properties !== 'object' || Array.isArray(properties)) throw new NotesqError(400, 'invalid_properties')
    for (const [k, v] of Object.entries(properties)) {
      if (v === null || v === undefined) continue
      if (SCALAR(v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) props[k] = v
      else throw new NotesqError(400, 'invalid_properties', { key: k })
    }
  }
  if (!Object.keys(props).length) return markdown
  return matter.stringify(markdown, props)
}

export function getNote({ orgId, userId, id }) {
  if (!visibleNoteRow(orgId, userId, id)) return null
  const full = store.getNote(orgId, userId, id)
  if (!full) return null
  let markdown = full.body
  try { markdown = matter(full.body || '').content } catch { /* malformed YAML: body is the markdown */ }
  return {
    ...shapeSummary(full),
    body: full.body,
    markdown,
    tags: full.tags,
    backlinks: full.backlinks,
    outlinks: full.outlinks
  }
}

function nextRev(noteId) {
  const r = getDatabase().prepare('SELECT MAX(rev) AS m FROM note_revisions WHERE note_id = ?').get(noteId)
  return (r.m || 0) + 1
}

function writeRevision({ orgId, vault, noteId, relPath, action, content, hash, userId, kind }) {
  const rev = nextRev(noteId)
  const created_at = nowIso()
  getDatabase().prepare(`
    INSERT INTO note_revisions (id, org_id, vault_id, note_id, rel_path, rev, action, content, content_hash, author_user_id, author_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ulid(), vault.org_id, vault.id, noteId, relPath, rev, action, content, hash, userId || null, kind, created_at)
  return { rev, action, content_hash: hash, created_at }
}

// NOTESQ_REVISION_RETENTION (org setting, collector registry group 'notesq').
// 0 or unset = keep every revision. N > 0 = after each new revision, prune
// older ones so that rev 1 (the author-rule anchor, see deleteNote) and the
// newest N survive. Any lookup failure or unusable value keeps everything:
// a settings hiccup must never delete history.
const RETENTION_KEY = 'NOTESQ_REVISION_RETENTION'
const defaultRetentionResolver = async (orgId) => {
  const r = await getSetting(orgId, RETENTION_KEY)
  return r && typeof r.value === 'string' ? r.value : null
}
let _retentionResolver = defaultRetentionResolver
export function _setRetentionResolverForTest(fn) {
  _retentionResolver = typeof fn === 'function' ? fn : defaultRetentionResolver
}

async function pruneRevisions(orgId, noteId) {
  try {
    const raw = await _retentionResolver(orgId)
    const n = Number(raw)
    if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isInteger(n) || n <= 0) return
    const db = getDatabase()
    const max = db.prepare('SELECT MAX(rev) AS m FROM note_revisions WHERE note_id = ?').get(noteId).m || 0
    const cutoff = max - n
    if (cutoff <= 1) return
    db.prepare('DELETE FROM note_revisions WHERE note_id = ? AND rev > 1 AND rev <= ?').run(noteId, cutoff)
  } catch (err) {
    console.error(`[QuoxBrain notesq] revision pruning skipped for note ${noteId}: ${err.message}`)
  }
}

async function ingestOne(vault, relPath, content) {
  await ingestDocuments(vault, [{ relPath, content }])
}

function requireWritable(vault, { orgId, userId, isAdmin }) {
  if (!store.canWriteVault(vault, { orgId, userId, isAdmin })) throw new NotesqError(403, 'forbidden')
}

export async function createNote({ orgId, userId, scope, content, markdown, properties, authorKind }) {
  if (scope !== 'org' && scope !== 'user') throw new NotesqError(400, 'invalid_scope')
  validateKind(authorKind)
  content = composeContent({ content, markdown, properties })
  validateContent(content)
  const vault = ensureNotesVault({ orgId, userId, scope })
  const relPath = `notes/${randomUUID()}.md`
  const id = store.noteId(vault.id, relPath)
  return withLock(id, async () => {
    await ingestOne(vault, relPath, content)
    const hash = sha1(content)
    // BRAIN2-W5 059: ingest and revision are one logical write. If the
    // revision insert fails, undo the ingest so the failed request leaves no
    // note behind.
    let revision
    try {
      revision = writeRevision({ vault, noteId: id, relPath, action: 'create', content, hash, userId, kind: authorKind })
    } catch (err) {
      store.deleteNote(id, { retract: false })
      store.resolveVaultLinks(vault.id)
      throw err
    }
    await pruneRevisions(orgId, id)
    return { note: getNote({ orgId, userId, id }), revision }
  })
}

export async function updateNote({ orgId, userId, isAdmin = false, id, content, markdown, properties, baseHash, authorKind }) {
  validateKind(authorKind)
  content = composeContent({ content, markdown, properties })
  validateContent(content)
  const row = visibleNoteRow(orgId, userId, id)
  if (!row) throw new NotesqError(404, 'not_found')
  const vault = store.getVault(orgId, userId, row.vault_id)
  requireWritable(vault, { orgId, userId, isAdmin })
  return withLock(id, async () => {
    const cur = visibleNoteRow(orgId, userId, id)
    if (!cur) throw new NotesqError(404, 'not_found')
    if (baseHash !== cur.content_hash) throw new NotesqError(409, 'conflict', { current_hash: cur.content_hash })
    const hash = sha1(content)
    if (hash === cur.content_hash) return { note: getNote({ orgId, userId, id }), revision: null, unchanged: true }
    await ingestOne(vault, cur.rel_path, content)
    // BRAIN2-W5 059: restore the previous body if the revision write fails, so
    // the saved document and its audit history cannot disagree.
    let revision
    try {
      revision = writeRevision({ vault, noteId: id, relPath: cur.rel_path, action: 'update', content, hash, userId, kind: authorKind })
    } catch (err) {
      await ingestOne(vault, cur.rel_path, cur.body || '')
      throw err
    }
    await pruneRevisions(orgId, id)
    return { note: getNote({ orgId, userId, id }), revision, unchanged: false }
  })
}

// purge: true is real erasure (BRAIN2-W7 060). The default delete is the
// documented soft delete (revision history kept so the note can be restored);
// purge additionally removes every revision (bodies included) so nothing
// recoverable remains. Chunks, embeddings, FTS rows, link/tag rows go with the
// notes row (cascade + triggers) and ANN points via the durable delete outbox in
// store.deleteNote.
export async function deleteNote({ orgId, userId, isAdmin = false, id, authorKind, purge = false }) {
  validateKind(authorKind)
  const row = visibleNoteRow(orgId, userId, id)
  if (!row) throw new NotesqError(404, 'not_found')
  const vault = store.getVault(orgId, userId, row.vault_id)
  requireWritable(vault, { orgId, userId, isAdmin })
  const first = getDatabase().prepare('SELECT author_user_id FROM note_revisions WHERE note_id = ? AND rev = 1').get(id)
  const isAuthor = Boolean(first && first.author_user_id && first.author_user_id === userId)
  const isUserOwner = vault.scope === 'user' && vault.owner_user_id === userId
  if (!(isAuthor || isAdmin || isUserOwner)) throw new NotesqError(403, 'forbidden')
  return withLock(id, async () => {
    const db = getDatabase()
    let revision = null
    db.transaction(() => {
      store.deleteNote(id)
      if (purge) { db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(id); return }
      revision = writeRevision({ vault, noteId: id, relPath: row.rel_path, action: 'delete', content: row.body || '', hash: row.content_hash, userId, kind: authorKind })
    })()
    store.resolveVaultLinks(vault.id)
    // BRAIN2-W5 061 + W10 C: the retraction is already queued in the outbox
    // (same transaction as the delete). Try it now for the caller's benefit; on
    // failure the row stays and the scheduled tick retries with backoff.
    const ret = await drainNote(id)
    return { deleted: true, ...(purge ? { purged: true } : {}), revision, beliefs_retracted: ret.retracted, ...(ret.error ? { belief_retract_error: ret.error } : {}) }
  })
}

function revisionAccess(orgId, userId, id) {
  const db = getDatabase()
  const first = db.prepare('SELECT vault_id, rel_path FROM note_revisions WHERE note_id = ? ORDER BY rev DESC LIMIT 1').get(id)
  if (!first) return null
  const vault = store.getVault(orgId, userId, first.vault_id)
  if (!vault || vault.app !== APP) return null
  return { vault, relPath: first.rel_path }
}

export function listRevisions({ orgId, userId, id }) {
  if (!revisionAccess(orgId, userId, id)) return null
  return getDatabase().prepare(`
    SELECT rev, action, content_hash, author_user_id, author_kind, created_at
    FROM note_revisions WHERE note_id = ? ORDER BY rev ASC
  `).all(id)
}

/** One revision's full markdown. Same visibility as listRevisions; null when hidden or missing. */
export function getRevision({ orgId, userId, id, rev }) {
  const n = Number(rev)
  if (!Number.isInteger(n) || n < 1) return null
  if (!revisionAccess(orgId, userId, id)) return null
  const row = getDatabase().prepare(`
    SELECT rev, action, author_kind, created_at, content
    FROM note_revisions WHERE note_id = ? AND rev = ?
  `).get(id, n)
  if (!row) return null
  return { rev: row.rev, action: row.action, author_kind: row.author_kind, created_at: row.created_at, markdown: row.content }
}

export async function restoreRevision({ orgId, userId, isAdmin = false, id, rev, authorKind }) {
  validateKind(authorKind)
  if (!Number.isInteger(rev) || rev < 1) throw new NotesqError(400, 'invalid_rev')
  const access = revisionAccess(orgId, userId, id)
  if (!access) throw new NotesqError(404, 'not_found')
  requireWritable(access.vault, { orgId, userId, isAdmin })
  const target = getDatabase().prepare('SELECT content FROM note_revisions WHERE note_id = ? AND rev = ?').get(id, rev)
  if (!target) throw new NotesqError(404, 'revision_not_found')
  return withLock(id, async () => {
    const hash = sha1(target.content)
    const live = visibleNoteRow(orgId, userId, id)
    if (live && live.content_hash === hash) return { note: getNote({ orgId, userId, id }), revision: null, unchanged: true }
    await ingestOne(access.vault, access.relPath, target.content)
    const revision = writeRevision({ vault: access.vault, noteId: id, relPath: access.relPath, action: 'restore', content: target.content, hash, userId, kind: authorKind })
    await pruneRevisions(orgId, id)
    return { note: getNote({ orgId, userId, id }), revision, unchanged: false }
  })
}

// -----------------------------------------------------------------------------
// RELATED NOTES — reuses the /brain/search retrieval (store.searchChunks sparse
// pool + contextAssembler.tryHybridFusion), restricted to visible notesq
// vaults. No new retrieval path or vector store.
// -----------------------------------------------------------------------------

export function relatedQueryText(title, body) {
  let md = String(body || '')
  try { md = matter(md).content } catch { /* malformed YAML: use raw body */ }
  md = md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a)
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
  return `${title || ''} ${md}`.trim()
}

export async function relatedNotes({ orgId, userId, id, limit = 8, deps = {} }) {
  const row = visibleNoteRow(orgId, userId, id)
  if (!row) return null
  const lim = Math.min(Math.max(Number(limit) || 8, 1), 20)
  const query = relatedQueryText(row.title, row.body)
  if (!query) return { related: [], mode: 'lexical' }

  const db = getDatabase()
  const sc = store.scopeClause(orgId, userId)
  const vaultIds = db.prepare(`SELECT id FROM vaults WHERE ${sc.sql} AND app = ?`).all(...sc.params, APP).map((r) => r.id)
  if (!vaultIds.length) return { related: [], mode: 'lexical' }
  const vset = new Set(vaultIds)

  const hybridOn = deps.isHybridEnabled || isHybridEnabled
  const fuse = deps.tryHybridFusion || tryHybridFusion
  const pool = 200
  let mode = 'lexical'
  // Sparse leg is restricted to notesq vaults here; the dense leg is not
  // facet-filtered, so fused rows are re-filtered to the same vault set below.
  const sparse = store.searchChunks(orgId, userId, { query, limit: 50, offset: 0, vaultIds })
  let rows = sparse
  if (await hybridOn(orgId)) {
    const fused = await fuse(orgId, userId, query, sparse, pool, deps.fusionDeps || {})
    if (fused) { rows = fused; mode = 'hybrid' }
  }

  const best = new Map()
  for (const r of rows) {
    if (r.noteId === id || !vset.has(r.vaultId)) continue
    const score = -r.score
    const cur = best.get(r.noteId)
    if (!cur || score > cur.score) best.set(r.noteId, { noteId: r.noteId, score })
  }
  const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, lim)
  const related = []
  for (const t of top) {
    const n = visibleNoteRow(orgId, userId, t.noteId)
    if (!n) continue
    if (safeParse(n.frontmatter || '{}').archived === true) continue
    related.push({ id: n.id, title: n.title, scope: n.scope, excerpt: excerptOf(n.body), score: Number(t.score.toFixed(6)) })
  }
  return { related, mode }
}

export { publicVault, visibleNoteRow, safeParse, excerptOf, APP }
