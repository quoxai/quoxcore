// vaultStore.js — org-scoped data access for vaults/notes/links/tags
// (P0.3, roadmap QUOXBRAIN #163). Mirrors services/memory/lib/memoryStore.js
// shape: plain functions over getDatabase(), every read/write scoped by the
// caller-supplied org_id (never trust a client-supplied org_id — callers
// pass req.org_id from the auth middleware).

import { ulid } from 'ulid'
import { createHash } from 'crypto'
import { Worker } from 'node:worker_threads'
import { getDatabase } from './db.js'
import { normalizeVector, loadDensePacked, packDenseRows, countDenseEligible, denseTailPages } from './denseLoader.js'
import * as ann from './annIndex.js'
import { buildNoteIndex, resolveTarget } from './linkResolver.js'
import { indexedText } from './chunker.js'

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

function now() {
  return new Date().toISOString()
}

// -----------------------------------------------------------------------------
// SCOPE TIERS (P2.5a, roadmap QUOXBRAIN #163, migrations/003-scope.sql)
//
// Every scoped read in this file (vaults/notes/chunks) filters through this
// union instead of a flat `org_id = ?`:
//
//   (scope = 'org'    AND org_id = ?)        -- current behaviour: client-isolated
//   OR (scope = 'user'   AND owner_user_id = ?) -- follows the user across every org
//   OR (scope = 'shared')                       -- instance-wide, visible to all
//
// `alias` lets a caller scope a column reference inside a JOINed query (e.g.
// `nc.` for note_chunks in searchChunks). The table being queried MUST carry
// both `scope` and `owner_user_id` columns — true for vaults, notes and
// note_chunks (denormalized, see migrations/003-scope.sql); note_tags/
// note_links deliberately do NOT carry these columns — every read against
// them is already narrowed to a single, already-scope-checked vault_id (see
// getGraph/getTags below), so no additional filter is needed there.
//
// orgId/userId are always req.org_id/req.user_id from the auth middleware —
// never client-supplied.
// -----------------------------------------------------------------------------

export function scopeClause(orgId, userId, { alias = '' } = {}) {
  const p = alias ? `${alias}.` : ''
  return {
    sql: `((${p}scope = 'org' AND ${p}org_id = ?) OR (${p}scope = 'user' AND ${p}owner_user_id = ?) OR (${p}scope = 'shared'))`,
    params: [orgId, userId]
  }
}

// -----------------------------------------------------------------------------
// VAULTS
// -----------------------------------------------------------------------------

/**
 * @param {object} v
 * @param {string} v.org_id - the creating org (never changes meaning: always
 *   "which org registered this vault", regardless of scope)
 * @param {string} v.scope - 'org' (default) | 'user' | 'shared'
 * @param {string|null} v.owner_user_id - required for scope='user' (the
 *   owning user — visibility for that row keys off THIS, not org_id); null
 *   for 'org'/'shared'
 */
export function createVault({ org_id, name, source_type = 'local', source_path, scope = 'org', owner_user_id = null, app = null }) {
  const db = getDatabase()
  const id = ulid()
  const ts = now()

  db.prepare(`
    INSERT INTO vaults (id, org_id, name, source_type, source_path, status, note_count, edge_count, scope, owner_user_id, app, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, source_path) DO NOTHING
  `).run(id, org_id, name, source_type, source_path, scope, owner_user_id, app, ts, ts)

  // Whether this INSERT won (new vault) or hit the UNIQUE(org_id, source_path)
  // conflict (already registered), fetch the canonical row either way.
  return db.prepare('SELECT * FROM vaults WHERE org_id = ? AND source_path = ?').get(org_id, source_path)
}

/** Write-authorization check for a specific vault row (delete/reindex/
 * documents-ingest routes) — distinct from the READ-side scope union above.
 * A scope='org' vault requires org membership (today's behaviour: the
 * caller's org_id must match the vault's org_id). A scope='user' vault is
 * writable ONLY by its owning user (owner_user_id) — it follows them across
 * orgs for READS, but ownership stays exclusive for WRITES. A scope='shared'
 * vault requires admin (mirrors the requireAdmin gate on shared-vault
 * creation in server.js). */
export function canWriteVault(vault, { orgId, userId, isAdmin = false } = {}) {
  if (!vault) return false
  if (vault.scope === 'shared') return Boolean(isAdmin)
  if (vault.scope === 'user') return vault.owner_user_id === userId
  return vault.org_id === orgId
}

export function getVault(org_id, user_id, id) {
  const db = getDatabase()
  const { sql, params } = scopeClause(org_id, user_id)
  return db.prepare(`SELECT * FROM vaults WHERE ${sql} AND id = ?`).get(...params, id) || null
}

export function listVaults(org_id, user_id) {
  const db = getDatabase()
  const { sql, params } = scopeClause(org_id, user_id)
  return db.prepare(`SELECT * FROM vaults WHERE ${sql} ORDER BY created_at DESC`).all(...params)
}

export function deleteVault(org_id, id) {
  const db = getDatabase()
  // note_links/note_tags cascade off notes; notes cascades off vaults — all
  // via ON DELETE CASCADE in migrations/000-baseline.sql (foreign_keys=ON,
  // see lib/db.js).
  const annIds = ann.annEnabled() ? db.prepare('SELECT id FROM note_chunks WHERE vault_id = ? AND org_id = ?').all(id, org_id).map((r) => r.id) : []
  // Codex cycle 4: deleting a whole vault must forget what Dream learned from
  // it too. Queue a belief retraction per note in the same transaction as the
  // delete (the per-note path, deleteNote, already does this).
  let info
  db.transaction(() => {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO belief_retraction_outbox (note_id, org_id, owner_user_id, queued_at, deleted_at, next_attempt_at)
      SELECT id, org_id, CASE WHEN scope = 'user' THEN owner_user_id ELSE NULL END, ?, ?, ? FROM notes WHERE vault_id = ? AND org_id = ?
      ON CONFLICT(note_id) DO UPDATE SET deleted_at = excluded.deleted_at, attempts = 0, last_error = NULL, retired_at = NULL, next_attempt_at = excluded.next_attempt_at`)
      .run(now, now, now, id, org_id)
    info = db.prepare('DELETE FROM vaults WHERE org_id = ? AND id = ?').run(org_id, id)
  })()
  if (info.changes > 0) { ann.deleteChunksBestEffort(annIds, db); invalidateDenseCache(org_id) }
  return { deleted: info.changes > 0 }
}

export function setVaultStatus(id, status, { note_count, edge_count, error, last_indexed_at } = {}) {
  const db = getDatabase()
  const fields = ['status = ?', 'updated_at = ?']
  const values = [status, now()]

  if (note_count !== undefined) { fields.push('note_count = ?'); values.push(note_count) }
  if (edge_count !== undefined) { fields.push('edge_count = ?'); values.push(edge_count) }
  if (error !== undefined) { fields.push('error = ?'); values.push(error) }
  if (last_indexed_at !== undefined) { fields.push('last_indexed_at = ?'); values.push(last_indexed_at) }

  values.push(id)
  db.prepare(`UPDATE vaults SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

// -----------------------------------------------------------------------------
// ORG VAULT ROOTS (R2, migrations/002-vault-roots.sql) — explicit per-org
// grants beyond the default <QUOXBRAIN_VAULT_ROOT>/<org_id> subdir every org
// already owns (see lib/vaultRoot.js orgAllowedRoots). Admin-only via
// server.js POST/GET /admin/vault-roots.
// -----------------------------------------------------------------------------

export function createVaultRootGrant({ org_id, root_path, restricted = false }) {
  const db = getDatabase()
  const id = ulid()
  const ts = now()

  db.prepare(`
    INSERT INTO org_vault_roots (id, org_id, root_path, restricted, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, root_path) DO NOTHING
  `).run(id, org_id, root_path, restricted ? 1 : 0, ts)

  // Whether this INSERT won or hit the UNIQUE(org_id, root_path) conflict
  // (already granted), fetch the canonical row either way.
  return db.prepare('SELECT * FROM org_vault_roots WHERE org_id = ? AND root_path = ?').get(org_id, root_path)
}

/** Every org id the instance knows about (vaults + grants), for overlap checks. */
export function listKnownOrgIds() {
  const db = getDatabase()
  return db.prepare('SELECT org_id FROM vaults UNION SELECT org_id FROM org_vault_roots').all().map((r) => r.org_id)
}

export function listVaultRootGrants(org_id) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM org_vault_roots WHERE org_id = ? ORDER BY created_at DESC').all(org_id)
}

// -----------------------------------------------------------------------------
// NOTES
// -----------------------------------------------------------------------------

/** Deterministic note id — stable across re-index so UPSERTs converge. */
export function noteId(vault_id, rel_path) {
  return createHash('sha1').update(`${vault_id}\0${rel_path}`).digest('hex')
}

// source_type/kind/occurred_at (migrations/001-chunks.sql) — provenance for
// the P5.5 dream engine, populated now so nothing re-integrates later.
// `occurred_at` defaults to the file's mtime (the natural "event time" for
// a vault-sourced note) when not explicitly overridden.
// scope/owner_user_id (P2.5a, migrations/003-scope.sql) — stamped from the
// PARENT VAULT's own scope/owner_user_id (never client-supplied) so the
// denormalized columns on notes stay in lockstep with the vault they belong
// to; every ingest call site (lib/ingest.js) passes `vault.scope`/
// `vault.owner_user_id` straight through.
// language (P2.5b-1, migrations/004-language.sql) — same denormalization
// pattern, but sourced per-DOCUMENT rather than per-vault: a push vault's
// documents can each carry their own `language` (e.g. a translation reader
// mixing 'en'/'fr' notes in one vault), so callers pass it straight through
// rather than defaulting from the vault. NULL (unspecified) until a reader
// populates it.
// origin_store/origin_id (ONE-BRAIN A1, migrations/009-origin-provenance.sql)
// — an optional pointer back to the canonical row this note was distilled
// from (e.g. origin_store='memory', origin_id=<memories.id>). NULL unless
// the caller (a push-ingest reader/feed writing FROM a canonical store, or
// the boot-time rel_path backfill — lib/originBackfill.js) explicitly knows
// the origin; never guessed here.
export function upsertNote({
  vault_id, org_id, rel_path, title, frontmatter, body, word_count = 0, mtime = null, content_hash,
  source_type = 'vault', kind = 'note', occurred_at, scope = 'org', owner_user_id = null, language = null,
  origin_store = null, origin_id = null
}) {
  const db = getDatabase()
  const id = noteId(vault_id, rel_path)
  const ts = now()
  const resolvedOccurredAt = occurred_at !== undefined ? occurred_at : mtime
  // ingest_seq (astra2 090/091): monotonic, never reused, bumped on insert and
  // on any content change (an unchanged re-upsert keeps its seq).
  const seq = db.prepare('UPDATE ingest_seq_counter SET value = value + 1 WHERE id = 1 RETURNING value').get().value

  db.prepare(`
    INSERT INTO notes (id, vault_id, org_id, rel_path, title, frontmatter, body, word_count, mtime, content_hash, source_type, kind, occurred_at, scope, owner_user_id, language, origin_store, origin_id, created_at, updated_at, ingest_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_id, rel_path) DO UPDATE SET
      ingest_seq = CASE WHEN notes.content_hash IS excluded.content_hash AND notes.body IS excluded.body AND notes.title IS excluded.title THEN notes.ingest_seq ELSE excluded.ingest_seq END,
      title = excluded.title,
      frontmatter = excluded.frontmatter,
      body = excluded.body,
      word_count = excluded.word_count,
      mtime = excluded.mtime,
      content_hash = excluded.content_hash,
      source_type = excluded.source_type,
      kind = excluded.kind,
      occurred_at = excluded.occurred_at,
      scope = excluded.scope,
      owner_user_id = excluded.owner_user_id,
      language = excluded.language,
      origin_store = excluded.origin_store,
      origin_id = excluded.origin_id,
      updated_at = excluded.updated_at
  `).run(id, vault_id, org_id, rel_path, title, frontmatter, body, word_count, mtime, content_hash, source_type, kind, resolvedOccurredAt, scope, owner_user_id, language, origin_store, origin_id, ts, ts, seq)

  return id
}

/** Partial provenance update — used by the chunk backfill path (lib/ingest.js
 * backfillChunks) to seed occurred_at for notes that predate migrations/001-chunks.sql
 * without forcing a full re-parse/re-upsert. */
export function setNoteProvenance(id, { source_type, kind, occurred_at } = {}) {
  const db = getDatabase()
  const fields = []
  const values = []
  if (source_type !== undefined) { fields.push('source_type = ?'); values.push(source_type) }
  if (kind !== undefined) { fields.push('kind = ?'); values.push(kind) }
  if (occurred_at !== undefined) { fields.push('occurred_at = ?'); values.push(occurred_at) }
  if (fields.length === 0) return
  values.push(id)
  db.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteNote(id, { retract = true } = {}) {
  const db = getDatabase()
  // BRAIN2-W10 C: queue the Dream belief retraction in the same transaction as
  // the delete (callers wrap in db.transaction; standalone it is its own
  // implicit atomic pair via the transaction below).
  if (retract) {
    const meta = db.prepare('SELECT org_id, scope, owner_user_id FROM notes WHERE id = ?').get(id)
    if (meta) {
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO belief_retraction_outbox (note_id, org_id, owner_user_id, queued_at, deleted_at, next_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_id) DO UPDATE SET deleted_at = excluded.deleted_at, attempts = 0, last_error = NULL, retired_at = NULL, next_attempt_at = excluded.next_attempt_at`)
        .run(id, meta.org_id, meta.scope === 'user' ? meta.owner_user_id : null, now, now, now)
    }
  }
  const annIds = ann.annEnabled() ? db.prepare('SELECT id FROM note_chunks WHERE note_id = ?').all(id).map((r) => r.id) : []
  const orgRow = db.prepare('SELECT org_id FROM notes WHERE id = ?').get(id)
  db.prepare('DELETE FROM notes WHERE id = ?').run(id)
  ann.deleteChunksBestEffort(annIds, db)
  if (orgRow) invalidateDenseCache(orgRow.org_id)
}

/**
 * Account erasure (GDPR Art. 17, FND_01M4HZQ5P004YSXH0BWY04YSXH), across every org.
 * Deletes what is personal to the user: their user-scoped vaults and notes, the
 * brain copies of their conversations (`conversations`: [{orgId, relPaths}],
 * resolved by the collector from its envelopes before it purges them), the
 * revision bodies of those notes, and their activity rows. Org knowledge they
 * wrote stays, with the author link removed. Sequential and idempotent, so a
 * partial run is finished by re-running it.
 */
export function eraseUser(userId, { conversations = [] } = {}) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('eraseUser: userId required')
  const db = getDatabase()
  const out = { vaultsDeleted: 0, notesDeleted: 0, revisionsDeleted: 0, revisionsAnonymised: 0, notesAnonymised: 0, activityRowsDeleted: 0 }
  const vaults = db.prepare("SELECT id, org_id FROM vaults WHERE scope = 'user' AND owner_user_id = ?").all(userId)
  const inVaults = new Set()
  for (const v of vaults) for (const r of db.prepare('SELECT id FROM notes WHERE vault_id = ?').all(v.id)) inVaults.add(r.id)
  const loose = new Set(db.prepare("SELECT id FROM notes WHERE scope = 'user' AND owner_user_id = ?").all(userId).map((r) => r.id).filter((id) => !inVaults.has(id)))
  const conv = db.prepare("SELECT id FROM notes WHERE org_id = ? AND source_type = 'conversation' AND rel_path = ?")
  for (const c of Array.isArray(conversations) ? conversations : []) {
    if (!c || typeof c.orgId !== 'string') continue
    for (const rel of Array.isArray(c.relPaths) ? c.relPaths : []) {
      const row = typeof rel === 'string' ? conv.get(c.orgId, rel) : null
      if (row && !inVaults.has(row.id)) loose.add(row.id)
    }
  }
  const delRev = db.prepare('DELETE FROM note_revisions WHERE note_id = ?')
  for (const id of [...inVaults, ...loose]) out.revisionsDeleted += delRev.run(id).changes
  for (const id of loose) { db.transaction(() => deleteNote(id))(); out.notesDeleted++ }
  for (const v of vaults) if (deleteVault(v.org_id, v.id).deleted) out.vaultsDeleted++
  out.notesDeleted += inVaults.size
  db.transaction(() => {
    out.revisionsAnonymised = db.prepare('UPDATE note_revisions SET author_user_id = NULL WHERE author_user_id = ?').run(userId).changes
    out.notesAnonymised = db.prepare('UPDATE notes SET owner_user_id = NULL WHERE owner_user_id = ?').run(userId).changes
    for (const t of ['usage_events', 'citation_events', 'citation_records', 'capture_drafts', 'relevance_judgements']) {
      out.activityRowsDeleted += db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId).changes
    }
    out.activityRowsDeleted += db.prepare('DELETE FROM topic_subscriptions WHERE user_id = ?').run(userId).changes
    out.activityRowsDeleted += db.prepare("DELETE FROM notesq_schedules WHERE user_id = ? AND scope = 'user'").run(userId).changes
  })()
  return out
}

export function listNoteRelPaths(vault_id) {
  const db = getDatabase()
  return db.prepare('SELECT rel_path FROM notes WHERE vault_id = ?').all(vault_id).map((r) => r.rel_path)
}

// -----------------------------------------------------------------------------
// LINKS / TAGS
// -----------------------------------------------------------------------------

export function replaceNoteLinks(note_id, vault_id, org_id, links = []) {
  const db = getDatabase()
  db.prepare('DELETE FROM note_links WHERE source_note_id = ?').run(note_id)

  const insert = db.prepare(`
    INSERT INTO note_links (vault_id, org_id, source_note_id, target_note_id, target_raw, link_type, resolved, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, 0, ?)
    ON CONFLICT(source_note_id, target_raw, link_type) DO NOTHING
  `)
  const ts = now()
  for (const link of links) {
    insert.run(vault_id, org_id, note_id, link.targetRaw, link.type, ts)
  }
}

export function replaceNoteTags(note_id, vault_id, org_id, tags = []) {
  const db = getDatabase()
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(note_id)

  const insert = db.prepare(`
    INSERT INTO note_tags (vault_id, org_id, note_id, tag, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(note_id, tag) DO NOTHING
  `)
  for (const t of tags) {
    insert.run(vault_id, org_id, note_id, t.tag, t.source)
  }
}

/**
 * Post-ingest link resolution sweep: matches every unresolved link in the
 * vault against the vault's own notes (via linkResolver) and persists
 * target_note_id + resolved. Must run after ALL notes for the vault have
 * been upserted (a link may point at a note that was only just created in
 * this same ingest pass). Runs inside a single transaction.
 *
 * @returns {number} count of links resolved (resolved=1) after the sweep
 */
export function resolveVaultLinks(vault_id, { changedNoteIds = null } = {}) {
  const db = getDatabase()
  const incremental = changedNoteIds instanceof Set
  if (incremental && changedNoteIds.size === 0) {
    return db.prepare('SELECT COUNT(*) AS c FROM note_links WHERE vault_id = ? AND resolved = 1').get(vault_id).c
  }

  const result = resolveOneVault(vault_id, changedNoteIds)

  // AQ-9D cross-scope links: when the ORG notesq vault changes (note created,
  // retitled, deleted), user notesq vaults in the SAME org that link into it
  // must be re-resolved too. Never any other app, never another org.
  const v = db.prepare('SELECT org_id, scope, app FROM vaults WHERE id = ?').get(vault_id)
  if (v && v.app === NOTESQ_APP && v.scope === 'org') {
    if (incremental) {
      // Autosave path: touch only dependent links that can have changed.
      const ids = [...changedNoteIds]
      const idJson = JSON.stringify(ids)
      const cur = db.prepare('SELECT title, rel_path FROM notes WHERE id IN (SELECT value FROM json_each(?))').all(idJson)
      const keys = new Set()
      for (const n of cur) {
        if (n.title) keys.add(String(n.title).trim().toLowerCase())
        if (n.rel_path) keys.add(String(n.rel_path).replace(/\.md$/i, '').toLowerCase())
      }
      // (a) links already targeting a changed note (retitle/delete);
      // (b) unresolved wikilinks/embeds whose target matches a changed note's
      // CURRENT title or rel_path (also the [[T#heading]] and [[T|alias]] forms).
      const cand = db.prepare(`
        SELECT nl.id, nl.vault_id, nl.target_raw, nl.target_note_id, nl.resolved, nl.link_type
        FROM note_links nl JOIN vaults v2 ON v2.id = nl.vault_id
        WHERE v2.org_id = ? AND v2.scope = 'user' AND v2.app = ?
          AND (nl.target_note_id IN (SELECT value FROM json_each(?))
            OR (nl.resolved = 0 AND nl.link_type IN ('wikilink', 'embed')))
      `).all(v.org_id, NOTESQ_APP, idJson)
      const idSet = new Set(ids)
      const byVault = new Map()
      for (const l of cand) {
        let hit = l.target_note_id && idSet.has(l.target_note_id)
        if (!hit && !l.resolved && keys.size) {
          const raw = String(l.target_raw).trim().toLowerCase()
          hit = keys.has(raw) || keys.has(raw.split('#')[0].split('|')[0].trim())
        }
        if (!hit) continue
        if (!byVault.has(l.vault_id)) byVault.set(l.vault_id, [])
        byVault.get(l.vault_id).push(l.id)
      }
      if (byVault.size > 0) {
        const fallback = buildOrgFallback(vault_id)
        for (const [vid, linkIds] of byVault) resolveOneVault(vid, null, { linkIds, fallback })
      }
    } else {
      const dependents = db.prepare(`
        SELECT DISTINCT v2.id FROM vaults v2
        JOIN note_links nl ON nl.vault_id = v2.id
        WHERE v2.org_id = ? AND v2.scope = 'user' AND v2.app = ?
          AND (nl.resolved = 0
            OR (nl.target_note_id IS NOT NULL
                AND nl.target_note_id NOT IN (SELECT id FROM notes WHERE vault_id = v2.id)))
      `).all(v.org_id, NOTESQ_APP)
      if (dependents.length > 0) {
        const fallback = buildOrgFallback(vault_id)
        for (const d of dependents) resolveOneVault(d.id, null, { crossOnly: true, fallback })
      }
    }
  }
  return result
}

// Index of the org notesq vault's notes, built once per resolve call.
function buildOrgFallback(orgVaultId) {
  const orgNotes = getDatabase().prepare('SELECT id, rel_path, title FROM notes WHERE vault_id = ?').all(orgVaultId)
  return {
    index: buildNoteIndex(orgNotes.map((n) => ({ relPath: n.rel_path, title: n.title }))),
    idByRelPath: new Map(orgNotes.map((n) => [n.rel_path, n.id]))
  }
}

const NOTESQ_APP = 'notesq'

// Resolves one vault's links. For a USER-scope notesq vault, unresolved links
// fall back to the same org's ORG-scope notesq vault (AQ-9D). Org vaults and
// every other app resolve against their own notes only.
function resolveOneVault(vault_id, changedNoteIds, { crossOnly = false, linkIds = null, fallback: givenFallback = null } = {}) {
  const db = getDatabase()
  // 068: with changedNoteIds (a Set of notes added/edited/deleted by this pass)
  // only links that can have changed are re-resolved: links FROM changed notes,
  // links pointing AT changed notes (retitled/removed targets), and links still
  // unresolved (a new note may satisfy them). An empty set re-resolves nothing.
  // Without it, every link in the vault is rescanned (the old behaviour).
  const incremental = changedNoteIds instanceof Set
  const totalResolved = () => db.prepare('SELECT COUNT(*) AS c FROM note_links WHERE vault_id = ? AND resolved = 1').get(vault_id).c

  const notes = db.prepare('SELECT id, rel_path, title FROM notes WHERE vault_id = ?').all(vault_id)
  // linkResolver's buildNoteIndex/resolveTarget contract expects camelCase
  // `relPath` (it's a pure lib shared with the parser, agnostic of our
  // snake_case DB columns) — map rows before handing them over.
  const indexNotes = notes.map((n) => ({ relPath: n.rel_path, title: n.title }))
  const index = buildNoteIndex(indexNotes)
  const idByRelPath = new Map(notes.map((n) => [n.rel_path, n.id]))

  // Fallback (org notesq vault) only for a user-scope notesq vault, same org.
  let fallback = givenFallback
  const self = db.prepare('SELECT org_id, scope, app FROM vaults WHERE id = ?').get(vault_id)
  const isUserNotesq = Boolean(self && self.app === NOTESQ_APP && self.scope === 'user')
  if (isUserNotesq && !fallback) {
    const orgVault = db.prepare("SELECT id FROM vaults WHERE org_id = ? AND scope = 'org' AND app = ? AND source_path = 'notesq:org'").get(self.org_id, NOTESQ_APP)
    if (orgVault) {
      fallback = buildOrgFallback(orgVault.id)
    }
  }

  const crossCond = '(nl.resolved = 0 OR (nl.target_note_id IS NOT NULL AND nl.target_note_id NOT IN (SELECT id FROM notes WHERE vault_id = nl.vault_id)))'
  let links
  if (linkIds) {
    links = db.prepare(`
      SELECT nl.id, nl.target_raw, nl.link_type, n.rel_path AS source_rel_path
      FROM note_links nl JOIN notes n ON n.id = nl.source_note_id
      WHERE nl.vault_id = ? AND nl.id IN (SELECT value FROM json_each(?))
    `).all(vault_id, JSON.stringify(linkIds))
  } else if (crossOnly) {
    links = db.prepare(`
      SELECT nl.id, nl.target_raw, nl.link_type, n.rel_path AS source_rel_path
      FROM note_links nl JOIN notes n ON n.id = nl.source_note_id
      WHERE nl.vault_id = ? AND ${crossCond}
    `).all(vault_id)
  } else if (incremental) {
    const ids = JSON.stringify([...changedNoteIds])
    // A user vault also re-checks cross-vault links when its own notes change:
    // a new same-titled own note must win over an org note.
    links = db.prepare(`
      SELECT nl.id, nl.target_raw, nl.link_type, n.rel_path AS source_rel_path
      FROM note_links nl
      JOIN notes n ON n.id = nl.source_note_id
      WHERE nl.vault_id = ?
        AND (nl.resolved = 0
          OR nl.source_note_id IN (SELECT value FROM json_each(?))
          OR nl.target_note_id IN (SELECT value FROM json_each(?))
          ${isUserNotesq ? `OR ${crossCond}` : ''})
    `).all(vault_id, ids, ids)
  } else {
    links = db.prepare(`
      SELECT nl.id, nl.target_raw, nl.link_type, n.rel_path AS source_rel_path
      FROM note_links nl
      JOIN notes n ON n.id = nl.source_note_id
      WHERE nl.vault_id = ?
    `).all(vault_id)
  }

  const update = db.prepare('UPDATE note_links SET target_note_id = ?, resolved = ? WHERE id = ?')

  let resolvedCount = 0
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const link = { targetRaw: row.target_raw, type: row.link_type }
      const targetRelPath = resolveTarget(link, row.source_rel_path, index)
      let targetNoteId = targetRelPath ? idByRelPath.get(targetRelPath) : null
      // Own vault wins; only wikilinks/embeds reach into the org vault.
      if (!targetNoteId && fallback && (row.link_type === 'wikilink' || row.link_type === 'embed')) {
        const rel = resolveTarget(link, row.source_rel_path, fallback.index)
        targetNoteId = rel ? fallback.idByRelPath.get(rel) : null
      }
      update.run(targetNoteId || null, targetNoteId ? 1 : 0, row.id)
      if (targetNoteId) resolvedCount += 1
    }
  })
  tx(links)

  return incremental || crossOnly || linkIds ? totalResolved() : resolvedCount
}

// -----------------------------------------------------------------------------
// CHUNKS (P1a, docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §1) — the addressable
// retrieval unit. notes stays the portable atom / parent-document; chunks
// are what /brain/search (P1b) actually returns.
//
// TEXT / indexedText DECISION (contract §1 calls this out explicitly as the
// "cleanest for P1" path — implemented here, not left ambiguous):
// `note_chunks.text` stores the INDEXED text — `${title}\n${headingPath}\n
// ${cleanBody}` via chunker.js's indexedText() helper — NOT the clean chunk
// body alone. This is the "free tier of contextual retrieval" the contract
// calls for (BM25 today, embeddings in P3 reuse the same indexed string).
// The clean body is never lost: `char_start`/`char_end` are exact offsets
// into `notes.body`, so a caller wanting the pristine passage (e.g. P1b's
// GET /notes/:id?range=) re-slices `notes.body` directly rather than
// stripping the prefix back off `note_chunks.text`.
// -----------------------------------------------------------------------------

/** Stable chunk id — sha1(note_id \0 heading_path \0 ordinal). Stable across
 * re-index when content is unchanged; ordinal disambiguates repeated
 * heading_path values (UNIQUE(note_id, ordinal) is still the DB-level guard). */
export function chunkId(note_id, headingPath, ordinal) {
  return createHash('sha1').update(`${note_id}\0${headingPath || ''}\0${ordinal}`).digest('hex')
}

/**
 * Delete-then-insert this note's chunks. The note_chunks_fts triggers
 * (migrations/001-chunks.sql) keep the FTS index in sync automatically.
 *
 * @param {string} note_id
 * @param {string} vault_id
 * @param {string} org_id
 * @param {Array} chunks - chunker.js chunkNote() output (ordinal, headingPath, text, charStart, charEnd, tokenCount, contentHash)
 * @param {string} title - the note's title, prefixed into the indexed text (see decision above)
 * @param {{scope?:string, owner_user_id?:string|null, language?:string|null}} [scopeOpts] - P2.5a
 *   (migrations/003-scope.sql): scope/owner_user_id stamped from the PARENT
 *   VAULT's own scope/owner_user_id, mirroring upsertNote — every chunk row a
 *   note produces must carry the same visibility as the note/vault it
 *   belongs to. `language` (P2.5b-1, migrations/004-language.sql) is
 *   PER-NOTE, not per-vault — callers pass the note's own `language` straight
 *   through (see upsertNote comment).
 * @returns {number} chunks written
 */
export function replaceNoteChunks(note_id, vault_id, org_id, chunks = [], title = '', { scope = 'org', owner_user_id = null, language = null } = {}) {
  const db = getDatabase()
  const insert = db.prepare(`
    INSERT INTO note_chunks (id, note_id, vault_id, org_id, ordinal, heading_path, text, char_start, char_end, token_count, content_hash, scope, owner_user_id, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const newRows = chunks.map((c) => ({ c, id: chunkId(note_id, c.headingPath, c.ordinal), text: indexedText(c, title) }))

  // BRAIN2-W10 H: never throw away embeddings for text that did not change.
  const old = db.prepare('SELECT id, text, char_start, char_end, scope, owner_user_id, language FROM note_chunks WHERE note_id = ?').all(note_id)

  // Fast path: identical chunk set (a metadata-only re-push). Chunks, FTS rows
  // and embeddings stay untouched; only a language change is applied in place.
  // A scope/owner change falls through so the ANN payload is re-synced.
  if (old.length === newRows.length && old.length > 0) {
    const byId = new Map(old.map((r) => [r.id, r]))
    const same = newRows.every((n) => {
      const o = byId.get(n.id)
      return o && o.text === n.text && o.char_start === n.c.charStart && o.char_end === n.c.charEnd &&
        o.scope === scope && (o.owner_user_id ?? null) === (owner_user_id ?? null)
    })
    if (same) {
      db.prepare('UPDATE note_chunks SET language = ? WHERE note_id = ? AND language IS NOT ?').run(language, note_id, language)
      return chunks.length
    }
  }

  // Snapshot embeddings so unchanged text can be carried over. Multiset by text.
  const oldEmb = old.length
    ? db.prepare(`SELECT ce.chunk_id, ce.org_id, ce.model, ce.dim, ce.vector, ce.updated_at, nc.text
                  FROM chunk_embeddings ce JOIN note_chunks nc ON nc.id = ce.chunk_id WHERE nc.note_id = ?`).all(note_id)
    : []
  const pool = new Map()
  for (const e of oldEmb) {
    if (!pool.has(e.text)) pool.set(e.text, [])
    pool.get(e.text).push(e)
  }
  const insEmb = db.prepare('INSERT INTO chunk_embeddings (chunk_id, org_id, model, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const keptSameId = new Set()
  const carried = new Set()

  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM note_chunks WHERE note_id = ?').run(note_id)
    for (const { c, id, text } of rows) {
      insert.run(
        id, note_id, vault_id, org_id, c.ordinal, c.headingPath ?? null,
        text, c.charStart, c.charEnd, c.tokenCount, c.contentHash,
        scope, owner_user_id, language
      )
      const list = pool.get(text)
      if (list && list.length) {
        // prefer the old embedding that sat on the same chunk id
        let i = list.findIndex((e) => e.chunk_id === id)
        if (i < 0) i = 0
        const e = list.splice(i, 1)[0]
        insEmb.run(id, e.org_id, e.model, e.dim, e.vector, e.updated_at)
        carried.add(id)
        if (e.chunk_id === id) keptSameId.add(id)
      }
    }
  })
  tx(newRows)
  // Old ids that no longer carry an embedding on the same id: drop their
  // points (never an id that is being re-upserted below). Carried rows are
  // re-upserted via the same live hook the embedding backfill uses, which also
  // rewinds the ANN cursor on failure, so qdrant stays consistent.
  if (ann.annEnabled()) {
    const gone = old.map((r) => r.id).filter((id) => !carried.has(id))
    ann.deleteChunksBestEffort(gone, db)
    if (carried.size) ann.syncChunks(db, [...carried])
  }
  invalidateDenseCache(org_id)

  return chunks.length
}

/**
 * Builds an FTS5 MATCH expression from a free-text query using OR semantics
 * across whitespace-separated tokens (P1d measured fix,
 * docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §5). The previous implementation
 * passed `query` straight through, which FTS5 treats as IMPLICIT AND across
 * bareword tokens — so a 5-word natural-language question ("how do I
 * contact support") needed EVERY token present in a chunk to match at all,
 * and a single off-topic word could zero out results the eval harness
 * proved this was really happening (9/40 zero-hit queries on the golden
 * NodeBrain set, eval/README.md). BM25 (`bm25(note_chunks_fts)` below)
 * still ranks chunks matching MORE terms higher, so switching the join to
 * OR widens recall without discarding precision ordering.
 *
 * Each token is wrapped in double quotes (FTS5 string-literal syntax,
 * internal quotes doubled per FTS5's own escaping rule) so punctuation,
 * FTS5 operator keywords (AND/OR/NOT/NEAR), and column-filter syntax
 * (`col:term`) inside the raw query can never be parsed as FTS5 query
 * syntax — every token is always searched as a literal string.
 *
 * @param {string} query
 * @returns {string|null} the MATCH expression, or null if query has no tokens
 */
// Common English stopwords. 'the' alone matches ~75k chunks and feeds bm25's
// ORDER BY temp b-tree (500-750ms per multi-token query, BRAIN2-AUDIT
// 2026-10-05); they carry no ranking signal under OR semantics.
export const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'about', 'to', 'from',
  'in', 'on', 'up', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'doing', 'have', 'has', 'had', 'having', 'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'than', 'then', 'so', 'not', 'no', 'can', 'will',
  'would', 'should', 'could', 'into', 'over', 'out', 'any', 'some', 'there', 'here'
])

const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g

export function buildOrMatchQuery(query) {
  const all = String(query).trim().split(/\s+/).filter(Boolean)
  if (all.length === 0) return null
  const kept = all.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))
  const tokens = kept.length > 0 ? kept : all
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * Grounding-mode sampler: up to `limit` chunk texts in the same scope a search
 * uses that contain any of the spellings (case-insensitive FTS). [] = the term
 * never occurs. Errors propagate.
 */
export function sampleTermChunks(org_id, user_id, variants, limit = 30) {
  const db = getDatabase()
  const terms = (variants || []).map((v) => String(v).trim()).filter(Boolean)
  if (!terms.length) return []
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  return db.prepare(`
    SELECT nc.text AS text
    FROM note_chunks_fts
    JOIN note_chunks nc ON nc.rowid = note_chunks_fts.rowid
    WHERE note_chunks_fts MATCH ? AND ${scoped.sql}
    LIMIT ?
  `).all(match, ...scoped.params, Math.min(Math.max(Number(limit) || 30, 1), 100)).map((r) => r.text)
}

/**
 * Date-window facet (ONE-BRAIN CX2): note date = COALESCE(occurred_at,
 * updated_at), compared as instants via julianday so mixed ISO formats and
 * ms/Z suffixes compare correctly. Shared by searchChunks (sparse leg) and
 * filterChunkIdsByFacets (dense leg) so both legs apply the identical window.
 * `since` inclusive, `until` inclusive. Inputs are ISO strings (server validates).
 */
export function noteDateConditions(since, until) {
  const conditions = []
  const params = []
  const expr = 'julianday(COALESCE(n.occurred_at, n.updated_at))'
  if (since) { conditions.push(`${expr} >= julianday(?)`); params.push(since) }
  if (until) { conditions.push(`${expr} <= julianday(?)`); params.push(until) }
  return { conditions, params }
}

/**
 * Scope-union BM25 search over note_chunks_fts, joined to note_chunks + notes
 * (P2.5a, roadmap QUOXBRAIN #163) — returns the union of org_id's own
 * 'org'-scope chunks, user_id's 'user'-scope chunks (from ANY org), and every
 * 'shared'-scope chunk. Shape matches the frozen /brain/search response
 * contract (§2) minus the route-level `tookMs` wrapper. Never throws on FTS5
 * syntax errors — returns `[]` (mirrors searchNotes's fallback contract
 * elsewhere in this file).
 *
 * `sources`/`scopes`/`languages` (P2.5b-1, roadmap QUOXBRAIN #163) are the
 * same brain-level facet filters GET /brain/graph and /brain/sources expose
 * — request-only additions, the response shape above is unchanged. `sources`
 * accepts vault ids OR vault names (resolved to ids here); `vaultIds` (the
 * existing, already-resolved-id filter) still works unchanged and is
 * intersected with `sources` when both are given. `scopes`/`languages`
 * filter directly against note_chunks' own denormalized columns.
 */
export function searchChunks(org_id, user_id, { query, limit = 10, offset = 0, vaultIds, kinds, sources, scopes, languages, since, until, maxLimit = 50, deferSnippets = false } = {}) {
  const db = getDatabase()
  if (!query) return []

  const matchQuery = buildOrMatchQuery(query)
  if (!matchQuery) return []

  // maxLimit: pool callers (search pagination, hybrid fusion) pass up to 500 so
  // dedupe-by-note + later pages are not starved by the default 50-chunk cap (071).
  const hardMax = Math.min(Math.max(Number(maxLimit) || 50, 1), 500)
  const clampedLimit = Math.min(Math.max(Number(limit) || 10, 1), hardMax)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  const conditions = ['note_chunks_fts MATCH ?', scoped.sql]
  const params = [matchQuery, ...scoped.params]

  // `sources` (vault id OR name) resolves to a concrete vault-id set, then
  // intersects with any explicit `vaultIds` already provided — mirrors the
  // sources-vs-vaultIds relationship documented above.
  let effectiveVaultIds = vaultIds
  if (Array.isArray(sources) && sources.length > 0) {
    const ph = sources.map(() => '?').join(',')
    const resolvedIds = db.prepare(`SELECT id FROM vaults WHERE id IN (${ph}) OR name IN (${ph})`)
      .all(...sources, ...sources)
      .map((r) => r.id)
    effectiveVaultIds = (Array.isArray(vaultIds) && vaultIds.length > 0)
      ? vaultIds.filter((id) => resolvedIds.includes(id))
      : resolvedIds
    if (effectiveVaultIds.length === 0) return [] // sources given but resolved to nothing visible/matching
  }

  if (Array.isArray(effectiveVaultIds) && effectiveVaultIds.length > 0) {
    conditions.push(`nc.vault_id IN (${effectiveVaultIds.map(() => '?').join(',')})`)
    params.push(...effectiveVaultIds)
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    conditions.push(`n.kind IN (${kinds.map(() => '?').join(',')})`)
    params.push(...kinds)
  }
  if (Array.isArray(scopes) && scopes.length > 0) {
    conditions.push(`nc.scope IN (${scopes.map(() => '?').join(',')})`)
    params.push(...scopes)
  }
  if (Array.isArray(languages) && languages.length > 0) {
    conditions.push(`nc.language IN (${languages.map(() => '?').join(',')})`)
    params.push(...languages)
  }
  const dated = noteDateConditions(since, until)
  conditions.push(...dated.conditions)
  params.push(...dated.params)

  const sql = `
    SELECT
      nc.id AS chunkId, nc.note_id AS noteId, nc.vault_id AS vaultId,
      n.kind AS kind, n.title AS title, n.rel_path AS relPath,
      nc.heading_path AS headingPath, bm25(note_chunks_fts) AS score,
      ${deferSnippets ? 'note_chunks_fts.rowid AS ftsRowid, NULL AS snippet' : "snippet(note_chunks_fts, 0, '[', ']', '...', 64) AS snippet"},
      nc.char_start AS charStart, nc.char_end AS charEnd,
      n.occurred_at AS occurredAt, n.updated_at AS updatedAt,
      n.origin_store AS originStore, n.origin_id AS originId
    FROM note_chunks_fts
    JOIN note_chunks nc ON nc.rowid = note_chunks_fts.rowid
    JOIN notes n ON n.id = nc.note_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(note_chunks_fts)
    LIMIT ? OFFSET ?
  `
  const facetConditions = conditions.slice(1)
  const facetParams = params.slice(1)
  params.push(clampedLimit, safeOffset)

  // CORTEX-BENCH (latency): score the FTS index alone first and join only the
  // best rows. Joining EVERY match (tens of thousands for common terms) to
  // note_chunks/notes before ORDER BY cost 0.4-1.2s per long question; this
  // gives an identical top 50 in 70-600ms. If scope/facet filtering leaves
  // fewer rows than asked (the pre-limit was dominated by out-of-scope
  // chunks), the full query runs instead, so results are never starved.
  const innerLimit = Math.max(3000, (clampedLimit + safeOffset) * 6)
  // Only with deferred snippets: snippet()/bm25() in the outer query need the
  // MATCH context, and an outer MATCH re-scores every match (measured: no gain).
  const fastSql = deferSnippets ? `
    SELECT
      nc.id AS chunkId, nc.note_id AS noteId, nc.vault_id AS vaultId,
      n.kind AS kind, n.title AS title, n.rel_path AS relPath,
      nc.heading_path AS headingPath, f.s AS score,
      f.frowid AS ftsRowid, NULL AS snippet,
      nc.char_start AS charStart, nc.char_end AS charEnd,
      n.occurred_at AS occurredAt, n.updated_at AS updatedAt,
      n.origin_store AS originStore, n.origin_id AS originId
    FROM (SELECT rowid AS frowid, bm25(note_chunks_fts) AS s FROM note_chunks_fts WHERE note_chunks_fts MATCH ? ORDER BY s LIMIT ?) f
    JOIN note_chunks nc ON nc.rowid = f.frowid
    JOIN notes n ON n.id = nc.note_id
    WHERE ${conditions.slice(1).join(' AND ')}
    ORDER BY f.s
    LIMIT ? OFFSET ?
  ` : null
  let rows
  try {
    if (fastSql) {
      rows = db.prepare(fastSql).all(matchQuery, innerLimit, ...params.slice(1))
      if (rows.length < clampedLimit) rows = null
    }
    if (!rows) rows = db.prepare(sql).all(...params)
  } catch (err) {
    console.error('[Brain] searchChunks FTS error:', err.message)
    rows = []
  }

  // 081: unicode61 tokenizes a CJK run as ONE token, so a meaningful substring
  // never matches. Substring (LIKE) fallback for CJK segments, same scope and
  // facet filters, merged behind the FTS hits; only when FTS left room.
  const cjk = String(query).match(CJK_RUN_RE)
  if (cjk && rows.length < clampedLimit) {
    try {
      const segs = [...new Set(cjk)].slice(0, 6)
      const need = clampedLimit + safeOffset
      const cols = `
          nc.id AS chunkId, nc.note_id AS noteId, nc.vault_id AS vaultId,
          n.kind AS kind, n.title AS title, n.rel_path AS relPath,
          nc.heading_path AS headingPath, -0.000001 AS score,
          substr(nc.text, 1, 20000) AS _text,
          nc.char_start AS charStart, nc.char_end AS charEnd,
          n.occurred_at AS occurredAt, n.updated_at AS updatedAt,
          n.origin_store AS originStore, n.origin_id AS originId`
      const cand = new Map()
      // V2-9 (migration 028): trigram index over CJK chunks. Segments of 3+
      // chars are matched as the OR of their overlapping trigrams (tolerates
      // particle/word-order/typo drift), bm25-ordered; scope and facet
      // conditions are the same ones the main FTS query used.
      const grams = new Set()
      for (const s of segs) {
        const cp = Array.from(s)
        for (let i = 0; i + 3 <= cp.length && grams.size < 80; i++) grams.add(cp.slice(i, i + 3).join(''))
      }
      if (grams.size > 0) {
        const triSql = `
          SELECT ${cols}, bm25(note_chunks_cjk_fts) AS _bm
          FROM note_chunks_cjk_fts
          JOIN note_chunks nc ON nc.rowid = note_chunks_cjk_fts.rowid
          JOIN notes n ON n.id = nc.note_id
          WHERE note_chunks_cjk_fts MATCH ? AND ${facetConditions.join(' AND ')}
          ORDER BY _bm
          LIMIT ?`
        const match = [...grams].map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ')
        for (const r of db.prepare(triSql).all(match, ...facetParams, Math.max(200, need * 4))) cand.set(r.chunkId, r)
      }
      // Segments under 3 chars cannot be trigram-indexed: keep the substring scan.
      const shorts = segs.filter((s) => Array.from(s).length < 3)
      if (shorts.length > 0) {
        const likeSql = `
          SELECT ${cols}, 0 AS _bm
          FROM note_chunks nc
          JOIN notes n ON n.id = nc.note_id
          WHERE (${shorts.map(() => 'instr(nc.text, ?) > 0').join(' OR ')}) AND ${facetConditions.join(' AND ')}
          LIMIT ?`
        for (const r of db.prepare(likeSql).all(...shorts, ...facetParams, Math.max(200, need * 4))) if (!cand.has(r.chunkId)) cand.set(r.chunkId, r)
      }
      // Rank: segments contained verbatim, then trigram overlap, then bm25. Drop
      // candidates that share neither a whole segment nor >=50% of the trigrams
      // (keeps absent-answer queries from returning noise).
      const have = new Set(rows.map((r) => r.chunkId))
      const scored = []
      for (const r of cand.values()) {
        if (have.has(r.chunkId)) continue
        const t = r._text || ''
        const whole = segs.filter((s) => t.includes(s)).length
        let frac = 0
        if (grams.size > 0) { let m = 0; for (const g of grams) if (t.includes(g)) m++; frac = m / grams.size }
        if (whole === 0 && frac < 0.5) continue
        const first = segs.map((s) => t.indexOf(s)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
        r.snippet = t.slice(Math.max(first - 20, 0), Math.max(first - 20, 0) + 120)
        delete r._text
        scored.push({ r, whole, frac, bm: r._bm })
      }
      scored.sort((a, b) => b.whole - a.whole || b.frac - a.frac || a.bm - b.bm)
      const extra = scored.map((s) => { delete s.r._bm; return s.r })
      rows = rows.concat(extra).slice(0, clampedLimit)
    } catch (err) {
      console.error('[Brain] searchChunks CJK substring fallback error:', err.message)
    }
  }
  return rows
}

/**
 * Fetches char_start/char_end/token_count/raw text for a set of chunk ids —
 * scope-union (P2.5a). Used by lib/contextAssembler.js (P1b) to pack
 * passages under a token budget and populate citations; deliberately a
 * SEPARATE lookup rather than widening searchChunks' SELECT, since that
 * function's return shape is the frozen /brain/search contract (§2) and
 * these fields are not part of it. Must apply the SAME scope union as
 * searchChunks — otherwise a 'user'/'shared' chunk found cross-org by
 * searchChunks would silently vanish here (its stored org_id is the
 * CREATION org, not necessarily the caller's current org_id).
 *
 * @param {string} org_id
 * @param {string} user_id
 * @param {string[]} chunkIds
 * @returns {Array<{chunkId:string, noteId:string, charStart:number, charEnd:number, tokenCount:number, text:string}>}
 */
export function getChunkDetails(org_id, user_id, chunkIds = []) {
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) return []
  const db = getDatabase()
  const { sql, params } = scopeClause(org_id, user_id, { alias: 'nc' })
  return db.prepare(`
    ${idsCte(chunkIds)}
    SELECT nc.id AS chunkId, nc.note_id AS noteId,
      nc.char_start AS charStart, nc.char_end AS charEnd, nc.token_count AS tokenCount, nc.text AS text
    FROM ids CROSS JOIN note_chunks nc ON nc.id = ids.id
    WHERE ${sql}
  `).all(...chunkIds, ...params)
}

// BRAIN2-AUDIT (2026-10-05): "scope AND id IN (...)" let SQLite drive the
// lookup from idx_chunks_org/idx_chunks_scope, walking every chunk in the org
// (1.4s for 90 ids on a 275k-chunk org, the unattributed second of every
// hybrid search). A VALUES CTE CROSS JOINed first forces one primary-key
// probe per id (3ms). Scope is still enforced in WHERE.
function idsCte(ids) {
  return `WITH ids(id) AS (VALUES ${ids.map(() => '(?)').join(',')})`
}

/**
 * Subset of `chunkIds` that satisfy the retrieval facet filters (vaultIds,
 * sources, kinds, scopes, languages) AND the caller's scope union. Used to
 * apply the same facets to the hybrid dense leg that searchChunks applies to
 * the sparse leg (BRAIN2-AUDIT 2026-10-05: dense hits ignored facets).
 *
 * @returns {Set<string>}
 */
export function filterChunkIdsByFacets(org_id, user_id, chunkIds = [], { vaultIds, kinds, sources, scopes, languages, since, until } = {}) {
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) return new Set()
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  const conditions = [scoped.sql]
  const params = [...scoped.params]

  let effectiveVaultIds = vaultIds
  if (Array.isArray(sources) && sources.length > 0) {
    const ph = sources.map(() => '?').join(',')
    const resolvedIds = db.prepare(`SELECT id FROM vaults WHERE id IN (${ph}) OR name IN (${ph})`)
      .all(...sources, ...sources).map((r) => r.id)
    effectiveVaultIds = (Array.isArray(vaultIds) && vaultIds.length > 0)
      ? vaultIds.filter((id) => resolvedIds.includes(id))
      : resolvedIds
    if (effectiveVaultIds.length === 0) return new Set()
  }
  if (Array.isArray(effectiveVaultIds) && effectiveVaultIds.length > 0) {
    conditions.push(`nc.vault_id IN (${effectiveVaultIds.map(() => '?').join(',')})`)
    params.push(...effectiveVaultIds)
  }
  if (Array.isArray(kinds) && kinds.length > 0) {
    conditions.push(`n.kind IN (${kinds.map(() => '?').join(',')})`)
    params.push(...kinds)
  }
  if (Array.isArray(scopes) && scopes.length > 0) {
    conditions.push(`nc.scope IN (${scopes.map(() => '?').join(',')})`)
    params.push(...scopes)
  }
  if (Array.isArray(languages) && languages.length > 0) {
    conditions.push(`nc.language IN (${languages.map(() => '?').join(',')})`)
    params.push(...languages)
  }
  const dated = noteDateConditions(since, until)
  conditions.push(...dated.conditions)
  params.push(...dated.params)
  const rows = db.prepare(`
    ${idsCte(chunkIds)}
    SELECT nc.id AS chunkId
    FROM ids CROSS JOIN note_chunks nc ON nc.id = ids.id
    JOIN notes n ON n.id = nc.note_id
    WHERE ${conditions.join(' AND ')}
  `).all(...chunkIds, ...params)
  return new Set(rows.map((r) => r.chunkId))
}

/**
 * Fetches title/kind/relPath/heading metadata for a specific chunk-id set —
 * scope-union (mirrors getChunkDetails), but joined to `notes` for the
 * display fields getChunkDetails deliberately omits (kind/title/relPath).
 * Used by the P4 hybrid RRF fusion (lib/contextAssembler.js) to hydrate
 * DENSE-ONLY chunk hits — found by denseSearchChunks but absent from the
 * sparse searchChunks candidate pool it's being fused with — so a fused
 * passage carries the same fields a sparse hit already has, regardless of
 * which leg (dense or sparse) surfaced it. No `score` field (that's the
 * fusion's job, not this lookup's).
 *
 * @param {string} org_id
 * @param {string} user_id
 * @param {string[]} chunkIds
 * @returns {Array<{chunkId:string, noteId:string, vaultId:string, kind:string, title:string, relPath:string, headingPath:string}>}
 */
export function getChunkMeta(org_id, user_id, chunkIds = []) {
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) return []
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  return db.prepare(`
    ${idsCte(chunkIds)}
    SELECT
      nc.id AS chunkId, nc.note_id AS noteId, nc.vault_id AS vaultId,
      n.kind AS kind, n.title AS title, n.rel_path AS relPath,
      nc.heading_path AS headingPath, n.occurred_at AS occurredAt, n.updated_at AS updatedAt,
      n.origin_store AS originStore, n.origin_id AS originId,
      substr(nc.text, 1, 320) AS snippet,
      nc.char_start AS charStart, nc.char_end AS charEnd
    FROM ids CROSS JOIN note_chunks nc ON nc.id = ids.id
    JOIN notes n ON n.id = nc.note_id
    WHERE ${scoped.sql}
  `).all(...chunkIds, ...scoped.params)
}

// -----------------------------------------------------------------------------
// DENSE (SEMANTIC) SEARCH — P4-WP2 (docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md
// §P4, docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase F). Cosine similarity
// over migrations/001-chunks.sql's `chunk_embeddings` table, populated by
// lib/embeddingBackfill.js. Inert until that table has rows for an org — an
// empty table just yields an empty result, never an error (mirrors
// searchChunks' "no candidates" shape so a caller can fall back cleanly).
//
// Scope-union via scopeClause() joined against note_chunks (chunk_embeddings
// itself only carries org_id — the CREATION org, migrations/001-chunks.sql —
// not scope/owner_user_id; note_chunks is the source of truth for visibility,
// same reasoning as getChunkDetails' comment above). The optional `scope`
// filter narrows further to a single scope tier (e.g. a QuoxDream-style
// per-slice read) — distinct from scopeClause's 3-way visibility UNION.
//
// DECODED-VECTOR CACHE: reading+decoding every chunk_embeddings BLOB for an
// org on every query is wasteful for a chat-latency path, so decoded
// Float32Arrays are cached per (org_id, scope, ownerUserId) key for a short
// TTL (30s — long enough to absorb a burst of queries in one
// conversation/session, short enough that a backfill run's new rows show up
// within a query or two without needing an explicit invalidation hook).
// -----------------------------------------------------------------------------

// 10 min (was 120s, was 30s). Staleness is now cheap: an expired entry is
// served immediately and refreshed in the background (stale-while-revalidate),
// so only the very first fill per key ever blocks a query. Cost of the long
// hold is memory (~140MB per cached org key on the dev corpus); new backfill
// rows become dense-visible within one TTL plus one refresh.
const DENSE_CACHE_TTL_MS = 600_000
function denseCacheTtl() {
  const env = process.env.QUOXBRAIN_DENSE_CACHE_TTL_MS
  if (env === undefined || env === '') return DENSE_CACHE_TTL_MS
  const n = Number(env)
  return Number.isFinite(n) && n >= 0 ? n : DENSE_CACHE_TTL_MS
}
// Safety valve on the raw SELECT, the overall ceiling across both tiers.
const DENSE_RAW_SCAN_CAP = 100_000 // post-purge curated corpus ~74k (2026-10-05); every curated vector fits
function denseScanCap() {
  const env = Number(process.env.QUOXBRAIN_DENSE_SCAN_CAP)
  return Number.isFinite(env) && env > 0 ? env : DENSE_RAW_SCAN_CAP
}
// BRAIN2-AUDIT (2026-10-05): the newest-60k window by updated_at was 99.7%
// machine exhaust on the real org (423k embeddings), so curated sources
// (memories, docs, decisions) were invisible to semantic recall. Machine
// exhaust sources are now capped to a small newest slice; every other
// source_type is loaded in full up to the overall cap.
const DENSE_LOW_SIGNAL_DEFAULT = ['fleet', 'aocl_policy', 'noc_tool_outcomes', 'conversation']
const DENSE_LOW_SIGNAL_CAP_DEFAULT = 5_000
function denseLowSignalSources() {
  const env = process.env.QUOXBRAIN_DENSE_LOW_SIGNAL_SOURCES
  if (env === undefined) return DENSE_LOW_SIGNAL_DEFAULT
  return env.split(',').map((x) => x.trim()).filter(Boolean)
}
function denseLowSignalCap() {
  const env = Number(process.env.QUOXBRAIN_DENSE_LOW_SIGNAL_CAP)
  return Number.isFinite(env) && env >= 0 && process.env.QUOXBRAIN_DENSE_LOW_SIGNAL_CAP !== undefined && process.env.QUOXBRAIN_DENSE_LOW_SIGNAL_CAP !== ''
    ? env : DENSE_LOW_SIGNAL_CAP_DEFAULT
}

// key -> { vectors: packed dense set (see packDenseRows; unit-length rows), expiresAt, refreshing }
const denseVectorCache = new Map()

/** 074: true when any cached dense set for this org hit a tier cap, i.e. older
 * embeddings are invisible to the dense leg (completeness warning). */
export function denseWindowTruncated(org_id) {
  const prefix = `${org_id}::`
  for (const [key, entry] of denseVectorCache) if (key.startsWith(prefix) && entry.vectors?.truncated && entry.vectors._tailComplete !== true) return true
  return false
}

/** Test hook: drops every cached dense entry. */
export function _resetDenseCache() {
  denseVectorCache.clear()
  eligibleCache.clear()
}

function dot(a, b) {
  const len = Math.min(a.length, b.length)
  let d = 0
  for (let i = 0; i < len; i++) d += a[i] * b[i]
  return d
}

// The cache holds the ORG-WIDE vector set once per (org, model) and applies
// user/scope visibility at query time (same rule as scopeClause), so different
// users/scopes of one org share a single load instead of each reloading the
// whole window (live evidence 2026-10-05: ~58s per search, cache never hit).
// Two-phase load (BRAIN2-AUDIT 2026-10-05): the tier SELECTs sort ids only,
// never the 3KB vector BLOBs (sorting blob-carrying rows took 159s and blocked
// the event loop on the 424k-embedding org). Vectors are then fetched by
// primary key in batches; the async path yields between batches so a warm or
// background refresh never starves requests.
const DENSE_BLOB_BATCH = 1000

function denseLoadConfig() {
  return { low: denseLowSignalSources(), lowCap: denseLowSignalCap(), cap: denseScanCap() }
}

function readDenseVectors(org_id, model) {
  return loadDensePacked(getDatabase(), org_id, model, denseLoadConfig())
}

const DENSE_WORKER_TIMEOUT_MS = 120_000
function denseWorkerTimeout() {
  const n = Number(process.env.QUOXBRAIN_DENSE_WORKER_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DENSE_WORKER_TIMEOUT_MS
}

/** Runs the whole dense load in a worker thread with its own read-only DB
 * connection (WAL allows concurrent readers). Always terminates the worker;
 * rejects on error, exit, or timeout. */
function readDenseVectorsInWorker(org_id, model) {
  const dbPath = getDatabase().name
  if (!dbPath || dbPath === ':memory:') return Promise.reject(new Error('database is not file-backed; worker cannot open it'))
  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(new URL('./denseLoadWorker.js', import.meta.url), {
      workerData: { dbPath, org_id, model, cfg: denseLoadConfig(), testDelayMs: Number(process.env.QUOXBRAIN_DENSE_WORKER_TEST_DELAY_MS) || 0, testFail: process.env.QUOXBRAIN_DENSE_WORKER_TEST_FAIL === '1' }
    })
    const finish = (fn, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      fn(val)
    }
    const timer = setTimeout(() => finish(reject, new Error(`dense worker timed out after ${denseWorkerTimeout()}ms`)), denseWorkerTimeout())
    worker.once('message', (m) => {
      if (m && m.error) return finish(reject, new Error(m.error))
      const p = m.packed
      p.scopeIdx = new Map(p.scopeTable.map((sc, i) => [sc, i]))
      finish(resolve, p)
    })
    worker.once('error', (err) => finish(reject, err))
    worker.once('exit', (code) => finish(reject, new Error(`dense worker exited (code ${code}) without a result`)))
  })
}

async function readDenseVectorsAsync(org_id, model) {
  return readDenseVectorsInWorker(org_id, model)
}

function denseCacheKey(org_id, model) {
  return `${org_id}::${model || ''}`
}

// 075: writes (new/changed embeddings, deleted or re-chunked notes) must not
// wait out the TTL. A small cached set is dropped (rebuild is cheap); a big one
// is marked expired so stale-while-revalidate refreshes it off the request path
// instead of blocking a query on a multi-second reload. A per-org generation
// stops a refresh that started BEFORE the write from re-arming stale data.
const DENSE_INVALIDATE_DROP_MAX = 20_000
function denseInvalidateDropMax() {
  const raw = process.env.QUOXBRAIN_DENSE_INVALIDATE_DROP_MAX
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DENSE_INVALIDATE_DROP_MAX
}
const denseGeneration = new Map()
const denseGen = (org_id) => denseGeneration.get(org_id) || 0

export function invalidateDenseCache(org_id) {
  denseGeneration.set(org_id, denseGen(org_id) + 1)
  const prefix = `${org_id}::`
  for (const [key, entry] of denseVectorCache) {
    if (!key.startsWith(prefix)) continue
    if ((entry.vectors?.length ?? 0) <= denseInvalidateDropMax()) denseVectorCache.delete(key)
    else entry.expiresAt = 0
  }
}

// 155: total resident-vector budget across ALL cached (org, model) entries.
// Least-recently-used entries (Map insertion order, refreshed on read) are
// evicted until the total fits; the entry just set is never evicted.
const DENSE_CACHE_MAX_VECTORS_DEFAULT = 400_000
function denseCacheMaxVectors() {
  const raw = process.env.QUOXBRAIN_DENSE_CACHE_MAX_VECTORS
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : DENSE_CACHE_MAX_VECTORS_DEFAULT
}
function evictDenseCacheOverBudget(keepKey) {
  const max = denseCacheMaxVectors()
  let total = 0
  for (const e of denseVectorCache.values()) total += e.vectors?.length ?? 0
  for (const key of denseVectorCache.keys()) {
    if (total <= max) break
    if (key === keepKey) continue
    total -= denseVectorCache.get(key).vectors?.length ?? 0
    denseVectorCache.delete(key)
  }
}

function setDenseCache(cacheKey, vectors, startedGen = null) {
  const org_id = cacheKey.split('::')[0]
  const stale = startedGen !== null && startedGen !== denseGen(org_id)
  denseVectorCache.delete(cacheKey)
  denseVectorCache.set(cacheKey, { vectors, expiresAt: stale ? 0 : Date.now() + denseCacheTtl(), refreshing: false })
  evictDenseCacheOverBudget(cacheKey)
  return vectors
}

function fillDenseCache(cacheKey, org_id, model) {
  return setDenseCache(cacheKey, readDenseVectors(org_id, model), denseGen(org_id))
}

async function fillDenseCacheAsync(cacheKey, org_id, model) {
  const startedGen = denseGen(org_id)
  try {
    return setDenseCache(cacheKey, await readDenseVectorsAsync(org_id, model), startedGen)
  } catch (err) {
    // Sync in-process fallback ONLY for a cold load (no cache to serve). It
    // blocks the loop, so the failure is logged loudly first.
    if (denseVectorCache.has(cacheKey)) throw err
    console.error(`[Brain] dense worker load FAILED for org ${org_id} (${err.message}); falling back to blocking in-process load`)
    return fillDenseCache(cacheKey, org_id, model)
  }
}

function loadDenseVectors(org_id, model) {
  const cacheKey = denseCacheKey(org_id, model)
  const cached = denseVectorCache.get(cacheKey)
  if (cached) {
    // LRU: refresh recency so eviction (155) drops the least recently used.
    denseVectorCache.delete(cacheKey)
    denseVectorCache.set(cacheKey, cached)
    if (cached.expiresAt <= Date.now() && !cached.refreshing) {
      // Stale-while-revalidate: serve the stale vectors now, refresh off the
      // request path. One in-flight refresh per key.
      cached.refreshing = true
      fillDenseCacheAsync(cacheKey, org_id, model).catch((err) => {
        cached.refreshing = false
        cached.expiresAt = Date.now() + 30_000 // back off: keep serving stale, retry in 30s (no worker-spawn storm)
        console.error(`[Brain] dense cache background refresh failed for org ${org_id}, serving stale cache: ${err.message}`)
      })
    }
    return cached.vectors
  }
  return fillDenseCache(cacheKey, org_id, model)
}

/**
 * Pre-fills the dense cache for an org (one entry per embedding model present;
 * user/scope visibility is applied at query time, so the warm entry serves
 * every user of the org). Resolves to the number of
 * vectors warmed; rejects on failure so the caller can log it.
 */
export async function warmDenseCache(org_id) {
  const db = getDatabase()
  const models = db.prepare('SELECT DISTINCT model FROM chunk_embeddings WHERE org_id = ?').all(org_id).map((r) => r.model)
  let total = 0
  for (const model of models) {
    total += (await fillDenseCacheAsync(denseCacheKey(org_id, model), org_id, model)).length
  }
  return total
}

/** Orgs that have at least one embedding (drives startup warm). */
export function listEmbeddedOrgIds() {
  return getDatabase().prepare('SELECT DISTINCT org_id FROM chunk_embeddings').all().map((r) => r.org_id)
}

/**
 * Facet pushdown for the dense (SQLite) legs: resolve the facet predicates to
 * the set of chunk ids that satisfy them (same predicates as searchChunks /
 * filterChunkIdsByFacets, plus excludeKinds / excludeVaultIds) so the top-k is
 * computed WITHIN the faceted set instead of globally then post-filtered.
 * Returns null when no facet is active (unfaceted path unchanged).
 */
function resolveDenseFacetAllowSet(org_id, user_id, filters) {
  if (!filters) return null
  const { vaultIds, kinds, sources, scopes, languages, since, until, excludeKinds, excludeVaultIds } = filters
  const arr = (a) => Array.isArray(a) && a.length > 0
  if (!(arr(vaultIds) || arr(kinds) || arr(sources) || arr(scopes) || arr(languages) || since || until || arr(excludeKinds) || arr(excludeVaultIds))) return null
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  const conditions = [scoped.sql]
  const params = [...scoped.params]
  let effectiveVaultIds = vaultIds
  if (arr(sources)) {
    const ph = sources.map(() => '?').join(',')
    const resolved = db.prepare(`SELECT id FROM vaults WHERE id IN (${ph}) OR name IN (${ph})`).all(...sources, ...sources).map((r) => r.id)
    effectiveVaultIds = arr(vaultIds) ? vaultIds.filter((id) => resolved.includes(id)) : resolved
    if (effectiveVaultIds.length === 0) return new Set()
  }
  const inList = (col, vals, not = false) => { conditions.push(`${col} ${not ? 'NOT IN' : 'IN'} (${vals.map(() => '?').join(',')})`); params.push(...vals) }
  if (arr(effectiveVaultIds)) inList('nc.vault_id', effectiveVaultIds)
  if (arr(excludeVaultIds)) inList('nc.vault_id', excludeVaultIds, true)
  if (arr(kinds)) inList('n.kind', kinds)
  if (arr(excludeKinds)) inList('COALESCE(n.kind, \'\')', excludeKinds, true)
  if (arr(scopes)) inList('nc.scope', scopes)
  if (arr(languages)) inList('nc.language', languages)
  const dated = noteDateConditions(since, until)
  conditions.push(...dated.conditions)
  params.push(...dated.params)
  const rows = db.prepare(`SELECT nc.id AS id FROM note_chunks nc JOIN notes n ON n.id = nc.note_id WHERE ${conditions.join(' AND ')}`).raw().all(...params)
  return new Set(rows.map((r) => r[0]))
}

/**
 * Cosine-ranked dense (semantic) search over chunk_embeddings, the P4
 * counterpart to searchChunks' BM25 leg. Stored vectors are unit-normalised at
 * load, so scoring is a dot product with the normalised query (cosine
 * semantics, zero-norm guarded). An org with no embeddings returns [].
 *
 * @param {string} org_id
 * @param {number[]} queryVector
 * @param {{scope?:string, ownerUserId?:string|null, limit?:number}} [opts]
 * @returns {Array<{chunkId:string, score:number}>} ranked desc, bounded to `limit`.
 */
export function denseSearchChunks(org_id, queryVector, { scope, ownerUserId = null, limit = 30, model = null, filters = null } = {}) {
  if (!Array.isArray(queryVector) || queryVector.length === 0) return []
  const clampedLimit = Math.min(Math.max(Number(limit) || 30, 1), 200)

  const vectors = loadDenseVectors(org_id, model)
  if (vectors.length === 0 || vectors.stride === 0) return []

  const allow = resolveDenseFacetAllowSet(org_id, ownerUserId, filters)
  if (allow && allow.size === 0) return setCoverage([], { status: 'complete', fraction: 1 })
  const top = scoreTopK(vectors, queryVector, { scope, ownerUserId, limit: clampedLimit, allow })
  if (!vectors.truncated) { setCoverage(top, { status: 'complete', fraction: 1 }); return top }
  return scanDenseTail(org_id, model, vectors, queryVector, top, { scope, ownerUserId, limit: clampedLimit, allow })
}

/** Same result as denseSearchChunks but yields the event loop between tail pages (production path). */
async function denseSearchChunksPaged(org_id, queryVector, { scope, ownerUserId = null, limit = 30, model = null, filters = null } = {}) {
  if (!Array.isArray(queryVector) || queryVector.length === 0) return []
  const clampedLimit = Math.min(Math.max(Number(limit) || 30, 1), 200)
  const vectors = loadDenseVectors(org_id, model)
  if (vectors.length === 0 || vectors.stride === 0) return []
  const allow = resolveDenseFacetAllowSet(org_id, ownerUserId, filters)
  if (allow && allow.size === 0) return setCoverage([], { status: 'complete', fraction: 1 })
  const top = scoreTopK(vectors, queryVector, { scope, ownerUserId, limit: clampedLimit, allow })
  if (!vectors.truncated) { setCoverage(top, { status: 'complete', fraction: 1 }); return top }
  return scanDenseTailAsync(org_id, model, vectors, queryVector, top, { scope, ownerUserId, limit: clampedLimit, allow })
}

// Non-enumerable so the result stays a plain array for deepStrictEqual callers.
// The eligible count only labels coverage, and it is a full join count (3.4s
// at 100k vectors): cache it briefly per visibility key.
const ELIGIBLE_TTL_MS = 60_000
const eligibleCache = new Map()
function cachedEligibleCount(db, org_id, model, opts) {
  const key = `${org_id}|${model}|${opts.scope || ''}|${opts.ownerUserId || ''}`
  const hit = eligibleCache.get(key)
  if (hit && Date.now() - hit.at < ELIGIBLE_TTL_MS) return hit.n
  const n = countDenseEligible(db, org_id, model, opts)
  eligibleCache.set(key, { n, at: Date.now() })
  if (eligibleCache.size > 500) eligibleCache.delete(eligibleCache.keys().next().value)
  return n
}
function setCoverage(arr, cov) { Object.defineProperty(arr, 'denseCoverage', { value: cov, enumerable: false, configurable: true, writable: true }); return arr }
const DENSE_TAIL_BUDGET_MS_DEFAULT = 2500
const DENSE_TAIL_PAGE_DEFAULT = 2000
function envNonNeg(name, dflt) {
  const raw = process.env[name]
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : dflt
}

/** Rows of the packed cache this query may see (same rule as scoreTopK). */
function countCacheEligible(vectors, scope, ownerUserId) {
  const { length: n, scopeCodes, ownerUserIds, userCode, scopeIdx } = vectors
  let want = -1
  if (scope) want = scopeIdx.has(scope) ? scopeIdx.get(scope) : -2
  if (want === -2) return 0
  let c = 0
  for (let r = 0; r < n; r++) {
    const code = scopeCodes[r]
    if (want !== -1 && code !== want) continue
    if (code === userCode && ownerUserIds[r] !== ownerUserId) continue
    c++
  }
  return c
}

/**
 * BRAIN2-W13 B: the cache is a capped speed window, not the coverage
 * boundary. Vectors outside it are streamed in keyset pages with a per-query
 * time budget; a budget hit is reported as denseCoverage.status 'partial' with
 * the scanned fraction (never silent).
 */
function* scanDenseTailGen(org_id, model, vectors, queryVector, top, { scope, ownerUserId, limit, allow = null }) {
  const budgetMs = envNonNeg('QUOXBRAIN_DENSE_TAIL_BUDGET_MS', DENSE_TAIL_BUDGET_MS_DEFAULT)
  const pageSize = Math.max(1, Math.floor(envNonNeg('QUOXBRAIN_DENSE_TAIL_PAGE', DENSE_TAIL_PAGE_DEFAULT)))
  const db = getDatabase()
  const started = Date.now()
  if (!vectors._idSet) vectors._idSet = new Set(vectors.chunkIds)
  const cacheEligible = countCacheEligible(vectors, scope, ownerUserId)
  const eligible = cachedEligibleCount(db, org_id, model, { scope, ownerUserId })
  let merged = top
  let tailScanned = 0
  let complete = true
  for (const { page, scannedRows, last } of denseTailPages(db, org_id, model, { scope, ownerUserId, skipIds: vectors._idSet, pageSize })) {
    if (page) {
      merged = merged.concat(scoreTopK(page, queryVector, { scope, ownerUserId, limit, allow }))
      merged.sort((a, b) => b.score - a.score)
      if (merged.length > limit) merged.length = limit
    }
    tailScanned += scannedRows
    // Bounded by wall time from the start: requiring scored progress first let
    // a walk over cached rows run unbounded (2026-10-09 incident).
    if (!last && Date.now() - started >= budgetMs) { complete = false; break }
    if (!last) yield // page boundary: the async driver hands the event loop back here
  }
  const scanned = cacheEligible + tailScanned
  const total = Math.max(eligible, scanned)
  setCoverage(merged, complete
    ? { status: 'complete', fraction: 1, scanned, total }
    : { status: 'partial', fraction: total > 0 ? Math.round((scanned / total) * 1000) / 1000 : 1, scanned, total })
  vectors._tailComplete = complete
  if (!complete) console.warn(`[Brain] dense fallback scan budget (${budgetMs}ms) hit for org ${org_id}: scanned ${scanned}/${total} vectors; older knowledge not searched (QUOXBRAIN_DENSE_TAIL_BUDGET_MS)`)
  return merged
}

function scanDenseTail(...args) {
  const g = scanDenseTailGen(...args)
  for (let r = g.next(); ; r = g.next()) if (r.done) return r.value
}

async function scanDenseTailAsync(...args) {
  const g = scanDenseTailGen(...args)
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Dense search with the ANN backend when QUOXBRAIN_ANN=qdrant, falling back to
 * the packed scan (loudly) when qdrant is unreachable or has no usable answer.
 * Facets (vaultIds/kinds/sources/scopes) are applied inside the qdrant filter.
 * Same result shape as denseSearchChunks.
 */
export async function denseSearchChunksAsync(org_id, queryVector, opts = {}) {
  const { scope, ownerUserId = null, limit = 30, model = null, filters = null } = opts
  if (ann.annEnabled() && model && Array.isArray(queryVector) && queryVector.length > 0 && !ann.inCooldown()) {
    try {
      // 073: no qdrant collection for this model yet (index being enabled or
      // rebuilt) is not "no results": the SQLite vectors are the source of truth,
      // so answer from the packed scan instead of returning an empty dense leg.
      if (!(await ann.hasCollection(model))) return denseSearchChunksPaged(org_id, queryVector, { scope, ownerUserId, limit, model, filters })
      let vaultIds = filters?.vaultIds
      if (Array.isArray(filters?.sources) && filters.sources.length > 0) {
        const db = getDatabase()
        const ph = filters.sources.map(() => '?').join(',')
        const resolved = db.prepare(`SELECT id FROM vaults WHERE id IN (${ph}) OR name IN (${ph})`).all(...filters.sources, ...filters.sources).map((r) => r.id)
        vaultIds = (Array.isArray(vaultIds) && vaultIds.length > 0) ? vaultIds.filter((v) => resolved.includes(v)) : resolved
        if (vaultIds.length === 0) return []
      }
      const clamped = Math.min(Math.max(Number(limit) || 30, 1), 200)
      return await ann.search({ model, vector: queryVector, limit: clamped, orgId: org_id, userId: ownerUserId, scope, vaultIds, kinds: filters?.kinds, scopes: filters?.scopes, excludeKinds: filters?.excludeKinds, excludeVaultIds: filters?.excludeVaultIds, since: filters?.since, until: filters?.until })
    } catch (err) {
      ann.noteFailure(err, 'search')
    }
  }
  return denseSearchChunksPaged(org_id, queryVector, { scope, ownerUserId, limit, model, filters })
}

function scoreTopK(vectors, queryVector, { scope, ownerUserId, limit: clampedLimit, allow = null }) {
  const q = normalizeVector(queryVector)
  const { mat, stride, length: n, chunkIds, ownerUserIds, scopeCodes, userCode, scopeIdx } = vectors
  let wantCode = -1
  if (scope) {
    wantCode = scopeIdx.has(scope) ? scopeIdx.get(scope) : -2
    if (wantCode === -2) return []
  }
  const qlen = Math.min(q.length, stride)
  // Bounded top-k by insertion into parallel sorted-desc arrays; the
  // threshold check skips almost every row once k results are held.
  const topIdx = new Int32Array(clampedLimit)
  const topScore = new Float64Array(clampedLimit)
  let held = 0
  for (let r = 0; r < n; r++) {
    const code = scopeCodes[r]
    if (wantCode !== -1 && code !== wantCode) continue
    if (code === userCode && ownerUserIds[r] !== ownerUserId) continue
    if (allow && !allow.has(chunkIds[r])) continue
    const base = r * stride
    // 4-way unrolled with independent accumulators (breaks the add dependency chain)
    let d0 = 0, d1 = 0, d2 = 0, d3 = 0
    let i = 0
    for (; i + 3 < qlen; i += 4) {
      d0 += q[i] * mat[base + i]
      d1 += q[i + 1] * mat[base + i + 1]
      d2 += q[i + 2] * mat[base + i + 2]
      d3 += q[i + 3] * mat[base + i + 3]
    }
    for (; i < qlen; i++) d0 += q[i] * mat[base + i]
    const d = d0 + d1 + d2 + d3
    if (held === clampedLimit && d <= topScore[held - 1]) continue
    let pos = held < clampedLimit ? held++ : held - 1
    while (pos > 0 && topScore[pos - 1] < d) {
      topScore[pos] = topScore[pos - 1]
      topIdx[pos] = topIdx[pos - 1]
      pos--
    }
    topScore[pos] = d
    topIdx[pos] = r
  }
  const out = new Array(held)
  for (let i = 0; i < held; i++) out[i] = { chunkId: chunkIds[topIdx[i]], score: topScore[i] }
  return out
}

/** Test hooks for the packed scorer (benchmark test). */
export function _packForTest(rows) { return packDenseRows(rows.map((r) => ({ ...r, vec: normalizeVector(r.vec) }))) }
export function _scoreTopKForTest(packed, q, opts) { return scoreTopK(packed, q, { scope: opts.scope, ownerUserId: opts.ownerUserId ?? null, limit: opts.limit ?? 30 }) }

/**
 * Notes with zero chunk rows — drives the backfill path (lib/ingest.js
 * backfillChunks) so notes indexed before migrations/001-chunks.sql landed
 * (e.g. NodeBrain's 203 pre-existing notes) get chunked without a full
 * content-hash-forcing reindex. Carries scope/owner_user_id (P2.5a) so the
 * backfilled chunks are stamped with the same visibility as the note itself.
 */
export function getNotesMissingChunks(vault_id) {
  const db = getDatabase()
  const where = vault_id ? 'WHERE n.vault_id = ? AND nc.id IS NULL' : 'WHERE nc.id IS NULL'
  const params = vault_id ? [vault_id] : []
  return db.prepare(`
    SELECT n.id, n.vault_id, n.org_id, n.title, n.body, n.rel_path, n.mtime, n.occurred_at, n.scope, n.owner_user_id, n.language
    FROM notes n
    LEFT JOIN note_chunks nc ON nc.note_id = n.id
    ${where}
    GROUP BY n.id
  `).all(...params)
}

// -----------------------------------------------------------------------------
// READS — graph, notes list, single note, tags, search (P2.5a scope-union;
// roadmap QUOXBRAIN #163). Every function below takes (org_id, user_id, ...)
// and applies scopeClause() against `notes` (which carries its own
// scope/owner_user_id, denormalized from its vault at ingest time — see
// upsertNote). vault_id already narrows to a single, already scope-checked
// vault (the route handler 404s via a scope-aware getVault() call before
// reaching any of these), so note_tags/note_links — which do NOT carry scope
// columns (migrations/003-scope.sql deliberately only touches
// vaults/notes/note_chunks) — are filtered by vault_id alone; that's already
// the full authorization boundary for those two tables.
// -----------------------------------------------------------------------------

export function getGraph(org_id, user_id, vault_id) {
  const db = getDatabase()
  const { sql, params } = scopeClause(org_id, user_id)
  const notes = db.prepare(`SELECT id, rel_path, title FROM notes WHERE ${sql} AND vault_id = ?`).all(...params, vault_id)

  const tagsByNote = new Map()
  const tagRows = db.prepare('SELECT note_id, tag FROM note_tags WHERE vault_id = ?').all(vault_id)
  for (const row of tagRows) {
    if (!tagsByNote.has(row.note_id)) tagsByNote.set(row.note_id, [])
    tagsByNote.get(row.note_id).push(row.tag)
  }

  // AQ-9D: a user notesq note can link to an org note in ANOTHER vault. That
  // target is not in this vault's node set, so the edge is DROPPED here (the
  // per-vault graph is a closed subgraph; the multi-vault brain graph shows
  // cross-vault edges). Degree is computed over kept edges only.
  const nodeIds = new Set(notes.map((n) => n.id))
  const edgeRows = db.prepare(`
    SELECT source_note_id, target_note_id, link_type
    FROM note_links
    WHERE vault_id = ? AND resolved = 1 AND target_note_id IS NOT NULL
  `).all(vault_id).filter((e) => nodeIds.has(e.source_note_id) && nodeIds.has(e.target_note_id))

  const degree = new Map()
  for (const e of edgeRows) {
    degree.set(e.source_note_id, (degree.get(e.source_note_id) || 0) + 1)
    degree.set(e.target_note_id, (degree.get(e.target_note_id) || 0) + 1)
  }

  return {
    nodes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      relPath: n.rel_path,
      tags: tagsByNote.get(n.id) || [],
      degree: degree.get(n.id) || 0
    })),
    edges: edgeRows.map((e) => ({
      source: e.source_note_id,
      target: e.target_note_id,
      type: e.link_type
    }))
  }
}

// -----------------------------------------------------------------------------
// BRAIN-LEVEL (P2.5b-1, roadmap QUOXBRAIN #163) — the cross-vault, scope-union
// graph + facet reads that back GET /brain/graph and GET /brain/sources, so
// the frontend can show ONE brain with sources as filterable facets instead
// of a per-vault picker. Unlike getGraph()/getTags() above (which take an
// already scope-checked, single vault_id), these union across EVERY vault
// visible to (org_id, user_id) via scopeClause() — same union
// /brain/search and /brain/context already retrieve over.
// -----------------------------------------------------------------------------

const BRAIN_GRAPH_EDGE_CAP = 4000

// -----------------------------------------------------------------------------
// BRAIN2-V2 visual (Wave 1) — per-note "lens" decorations for getBrainGraph.
// Each is a single pass, built ONCE per graph call and then membership/lookup
// tested per node, so the additions cost O(events + covered-slice) not
// O(nodes × query). Both never throw: a missing/empty ledger or cursor yields
// an empty Map/Set, so nodes fall back to citedCount 0 / consolidated false.
// -----------------------------------------------------------------------------

/** One-pass citation tally: read the org's citation_events, parse each row's
 * cited_note_ids JSON array, and tally per-note-id counts into a Map. A note
 * cited across N events lands N in the Map; ids never returned in this graph
 * are simply never looked up. Scoped to the same org as the graph query. */
function buildCitationTally(db, orgId) {
  const counts = new Map()
  try {
    const rows = db.prepare('SELECT cited_note_ids FROM citation_events WHERE org_id = ?').all(orgId)
    for (const row of rows) {
      let ids
      try {
        ids = JSON.parse(row.cited_note_ids)
      } catch {
        continue
      }
      if (!Array.isArray(ids)) continue
      for (const nid of ids) counts.set(nid, (counts.get(nid) || 0) + 1)
    }
  } catch (err) {
    console.warn('[Brain] citation tally for graph failed (non-fatal):', err.message)
  }
  return counts
}

/** The set of candidate note ids QuoxDream's cursor has already PASSED —
 * "consolidated". Reuses getDreamCoverage's EXACT keyset predicate
 * (occurred_at < cursor OR (occurred_at = cursor AND id <= last_note_id)) over
 * the two scheduled slices ('org', 'shared'); scope='user' notes are never
 * scheduled, so they never enter this set (consolidated=false). Restricted to
 * the graph's own candidate ids, so it is one bounded pass per scheduled
 * slice, never a per-node subquery. A slice with no cursor yet contributes
 * nothing. */
function buildConsolidatedSet(db, orgId, candidateIds) {
  const covered = new Set()
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return covered
  try {
    const idPh = candidateIds.map(() => '?').join(',')
    for (const scope of DREAM_SCHEDULED_SCOPES) {
      const cursor = getDreamCursor(orgId, scope, null)
      const cursorAt = cursor?.last_occurred_at ?? null
      if (cursorAt === null || cursorAt === undefined) continue
      const slice = dreamScopeSlice(orgId, scope, null)
      const lastNoteId = cursor.last_note_id ?? ''
      const rows = db.prepare(`
        SELECT id FROM notes
        WHERE ${slice.sql} AND id IN (${idPh})
          AND (occurred_at < ? OR (occurred_at = ? AND id <= ?))
      `).all(...slice.params, ...candidateIds, cursorAt, cursorAt, lastNoteId)
      for (const r of rows) covered.add(r.id)
    }
  } catch (err) {
    console.warn('[Brain] consolidated set for graph failed (non-fatal):', err.message)
  }
  return covered
}

/**
 * Cross-vault node/edge read. Facet filters (`sources`, `scopes`,
 * `languages`) are all optional and narrow the SAME scope-union rather than
 * widening it — a caller can never use them to see a vault they aren't
 * already authorized for. `sources` accepts vault ids OR names (matches
 * either column, mirrors searchChunks' own sources resolution).
 *
 * Pagination is a stable LIMIT/OFFSET over a deterministic ORDER BY (not a
 * post-hoc slice of an in-memory array like the per-vault getGraph/route) —
 * P2.5b-1 explicitly does NOT require highest-degree-first ordering, just a
 * stable cap + `truncated` flag; degree here is informational per-node
 * metadata, not a sort key. Edges are the full set for every vault a
 * returned node belongs to (same as the per-vault graph's contract: an edge
 * may reference a node outside the paginated page).
 *
 * @param {string} org_id
 * @param {string} user_id
 * @param {{sources?:string[], scopes?:string[], languages?:string[], limit?:number, offset?:number}} [opts]
 * @returns {{nodes:Array, edges:Array, total:number}}
 */
export function getBrainGraph(org_id, user_id, { sources, scopes, languages, limit = 800, offset = 0 } = {}) {
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'n' })
  const conditions = [scoped.sql]
  const params = [...scoped.params]

  if (Array.isArray(sources) && sources.length > 0) {
    const ph = sources.map(() => '?').join(',')
    conditions.push(`(v.id IN (${ph}) OR v.name IN (${ph}))`)
    params.push(...sources, ...sources)
  }
  if (Array.isArray(scopes) && scopes.length > 0) {
    conditions.push(`n.scope IN (${scopes.map(() => '?').join(',')})`)
    params.push(...scopes)
  }
  if (Array.isArray(languages) && languages.length > 0) {
    conditions.push(`n.language IN (${languages.map(() => '?').join(',')})`)
    params.push(...languages)
  }

  const whereSql = conditions.join(' AND ')

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM notes n JOIN vaults v ON v.id = n.vault_id WHERE ${whereSql}
  `).get(...params).c

  const clampedLimit = Math.min(Math.max(Number(limit) || 800, 1), 2000)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const notes = db.prepare(`
    SELECT n.id, n.title, n.rel_path AS relPath, n.vault_id AS vaultId,
      v.name AS source, v.source_type AS sourceType, n.scope AS scope, n.language AS language,
      n.updated_at AS updatedAt
    FROM notes n
    JOIN vaults v ON v.id = n.vault_id
    WHERE ${whereSql}
    ORDER BY n.updated_at DESC, n.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, clampedLimit, safeOffset)

  if (notes.length === 0) {
    return { nodes: [], edges: [], total }
  }

  const noteIds = notes.map((n) => n.id)
  const vaultIds = [...new Set(notes.map((n) => n.vaultId))]

  // Batch tag/edge fetch (avoid N+1) — mirrors getGraph's own batching, just
  // widened to the multi-vault node set.
  const tagPh = noteIds.map(() => '?').join(',')
  const tagRows = db.prepare(`SELECT note_id, tag FROM note_tags WHERE note_id IN (${tagPh})`).all(...noteIds)
  const tagsByNote = new Map()
  for (const row of tagRows) {
    if (!tagsByNote.has(row.note_id)) tagsByNote.set(row.note_id, [])
    tagsByNote.get(row.note_id).push(row.tag)
  }

  // Edges = resolved note_links from the included vaults. Since AQ-9D a user
  // notesq note may link to an org note in another vault, so BOTH endpoints are
  // re-checked against the caller's scope: an edge whose source or target the
  // caller cannot see is never emitted (a target outside the page but visible
  // is kept, as before).
  const vaultPh = vaultIds.map(() => '?').join(',')
  const sSc = scopeClause(org_id, user_id, { alias: 'ns' })
  const tSc = scopeClause(org_id, user_id, { alias: 'nt' })
  const edgeRows = db.prepare(`
    SELECT nl.source_note_id, nl.target_note_id, nl.link_type
    FROM note_links nl
    JOIN notes ns ON ns.id = nl.source_note_id
    JOIN notes nt ON nt.id = nl.target_note_id
    WHERE nl.vault_id IN (${vaultPh}) AND nl.resolved = 1 AND nl.target_note_id IS NOT NULL
      AND ${sSc.sql} AND ${tSc.sql}
  `).all(...vaultIds, ...sSc.params, ...tSc.params)

  const degree = new Map()
  for (const e of edgeRows) {
    degree.set(e.source_note_id, (degree.get(e.source_note_id) || 0) + 1)
    degree.set(e.target_note_id, (degree.get(e.target_note_id) || 0) + 1)
  }

  // BRAIN2-V2 visual (Wave 1) — three per-note "lens" fields. Both are built
  // ONCE per call (not per node): a single-pass citation tally over the org's
  // citation_events, and a covered-id set membership test that reuses
  // QuoxDream's exact keyset predicate. Both are best-effort: a missing table
  // or empty ledger yields citedCount 0 / consolidated false, never a throw —
  // a decoration read must not fail the graph it is decorating.
  const citedCount = buildCitationTally(db, org_id)
  const consolidatedSet = buildConsolidatedSet(db, org_id, noteIds)

  return {
    nodes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      relPath: n.relPath,
      vaultId: n.vaultId,
      source: n.source,
      sourceType: n.sourceType,
      scope: n.scope,
      language: n.language,
      updatedAt: n.updatedAt,
      tags: tagsByNote.get(n.id) || [],
      degree: degree.get(n.id) || 0,
      citedCount: citedCount.get(n.id) || 0,
      consolidated: consolidatedSet.has(n.id)
    })),
    edges: edgeRows.slice(0, BRAIN_GRAPH_EDGE_CAP).map((e) => ({
      source: e.source_note_id,
      target: e.target_note_id,
      type: e.link_type
    })),
    edgesTotal: edgeRows.length,
    total
  }
}

// -----------------------------------------------------------------------------
// BRAIN STATUS / GROWTH (Brain2 D-WP1, roadmap QUOXBRAIN2,
// docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 3 "growth story" +
// idea_quoxbrain_living_brain_3d milestone ladder). Powers the brain-status
// pill + milestone progress bar — "the number climbing is the product's
// heartbeat". Bounded: ONE grouped COUNT(*) over `vaults` LEFT JOIN `notes`
// (indexed on notes.vault_id, migrations/000-baseline.sql) — never reads
// note bodies, mirrors getBrainSources' per-vault count query below.
// -----------------------------------------------------------------------------

export const BRAIN_STATUS_THRESHOLDS = [500, 2000, 5000, 10000]

export const BRAIN_MILESTONE_LABELS = {
  500: 'Sparks',
  2000: 'Taking shape',
  5000: 'My brain is growing',
  10000: 'Dense'
}

function brainStatusForCount(noteCount) {
  if (noteCount >= 10000) return 'dense'
  if (noteCount >= 5000) return 'alive'
  if (noteCount >= 2000) return 'growing'
  if (noteCount >= 500) return 'forming'
  return 'dormant'
}

function brainMilestoneForCount(noteCount) {
  const next = BRAIN_STATUS_THRESHOLDS.find((t) => t > noteCount)
  if (next === undefined) return null
  return { next, current: noteCount, remaining: next - noteCount, label: BRAIN_MILESTONE_LABELS[next] }
}

/**
 * @param {string} orgId - req.org_id from the auth middleware (never
 *   client-supplied).
 * @param {{ownerUserId?: string|null}} opts - ownerUserId plays the role of
 *   scopeClause's `userId` param (matched against notes/vaults.owner_user_id
 *   for scope='user' rows) — same scope-union semantics as getBrainSources/
 *   getBrainGraph above, just renamed here for call-site clarity since this
 *   is the one brain-level read that doesn't also take a caller-facing
 *   user_id for anything else.
 * @returns {{noteCount:number, sources:Array<{vaultId:string,name:string,count:number}>, status:string, milestone:object|null}}
 */
export function getBrainStatus(orgId, { ownerUserId = null } = {}) {
  const db = getDatabase()
  const vScoped = scopeClause(orgId, ownerUserId, { alias: 'v' })

  const sourceRows = db.prepare(`
    SELECT v.id AS vaultId, v.name AS name, COUNT(n.id) AS count
    FROM vaults v
    LEFT JOIN notes n ON n.vault_id = v.id
    WHERE ${vScoped.sql}
    GROUP BY v.id
    ORDER BY v.name ASC
  `).all(...vScoped.params)

  const noteCount = sourceRows.reduce((sum, r) => sum + r.count, 0)

  // BRAIN2 P2d: newest note timestamp powers the "newest note Nm ago" growth
  // affordance (and the collector /api/brain/overview aggregate).
  const nScoped = scopeClause(orgId, ownerUserId, { alias: 'n' })
  const newestRow = db.prepare(`
    SELECT MAX(n.created_at) AS newest FROM notes n WHERE ${nScoped.sql}
  `).get(...nScoped.params)

  // BRAIN2 P2a follow-up (owner confusion 2026-08-25): user-scope notes follow
  // their owner into EVERY org context by design (scopeClause's user branch has
  // no org condition), so a per-org aggregate that sums scope-union noteCounts
  // double-counts the caller's personal notes once per org. Expose the split so
  // aggregators can count org notes per org and personal notes once.
  const byScopeRow = db.prepare(`
    SELECT
      SUM(CASE WHEN n.scope = 'org' AND n.org_id = ? THEN 1 ELSE 0 END) AS org_count,
      SUM(CASE WHEN n.scope = 'user' AND n.owner_user_id = ? THEN 1 ELSE 0 END) AS user_count,
      SUM(CASE WHEN n.scope = 'shared' THEN 1 ELSE 0 END) AS shared_count
    FROM notes n
  `).get(orgId, ownerUserId)

  return {
    noteCount,
    newestNoteAt: newestRow?.newest || null,
    noteCountByScope: {
      org: byScopeRow?.org_count || 0,
      user: byScopeRow?.user_count || 0,
      shared: byScopeRow?.shared_count || 0
    },
    sources: sourceRows.map((r) => ({ vaultId: r.vaultId, name: r.name, count: r.count })),
    status: brainStatusForCount(noteCount),
    milestone: brainMilestoneForCount(noteCount)
  }
}

// -----------------------------------------------------------------------------
// EMBEDDING COVERAGE (no-env-only-config #setecastronomy: hybrid retrieval's
// dense leg silently starves when chunk_embeddings lags note_chunks, so
// coverage must be visible in the dashboard, not just inferrable from a
// manual SQL count). note_chunks.org_id / chunk_embeddings.org_id are both
// denormalized at write time (migrations/001-chunks.sql), so a single
// LEFT JOIN COUNT(*) is enough, no scopeClause needed: this is a coverage
// stat over an org's OWN chunks, not a scope-union retrieval read (same
// distinction getChunksMissingEmbeddings' comment in embeddingBackfill.js
// draws for its own org-scoped query).
// -----------------------------------------------------------------------------

function coverageFromCounts(total, embedded) {
  const missing = total - embedded
  const percent = total > 0 ? Math.round((embedded / total) * 1000) / 10 : 0
  return { total, embedded, missing, percent }
}

/**
 * Chunk embedding coverage for a single org, powers the `embeddings` block
 * on GET /brain/status for a JWT-scoped caller (own org only).
 * @param {string} orgId
 * @returns {{total:number, embedded:number, missing:number, percent:number}}
 */
export function getEmbeddingCoverage(orgId) {
  const db = getDatabase()
  // 2026-10-10: two indexed counts, never a note_chunks x chunk_embeddings
  // join. chunk_embeddings.org_id is denormalised at write and rows cascade
  // away with their chunk (foreign_keys ON), so the counts are the same; the
  // join cost 5.2s per refresh on a 131k-chunk org and blocked every search
  // landing in that window (test/embeddingCoverageCheap.test.js).
  const total = db.prepare('SELECT COUNT(*) AS n FROM note_chunks WHERE org_id = ?').get(orgId).n
  // byModel: which embedding SPACES the org's vectors live in — feeds the
  // ready|indexing state on /brain/status (rows off the current provider's
  // space are pending healing, BRAIN2-SEMANTIC 2026-08-25).
  const byModel = db.prepare(`
    SELECT model, COUNT(*) AS count
    FROM chunk_embeddings
    WHERE org_id = ?
    GROUP BY model
    ORDER BY count DESC
  `).all(orgId)
  const embedded = Math.min(total, byModel.reduce((sum, r) => sum + r.count, 0))
  return { ...coverageFromCounts(total, embedded), byModel }
}

/**
 * BRAIN2-W11: embedding models with at least one vector for this org (the
 * spaces the dense leg may need to query during a model migration). Cached
 * briefly in-process because it runs on every hybrid query.
 * @returns {string[]}
 */
const orgModelsCache = new Map() // orgId -> { models, expiresAt }
const ORG_MODELS_TTL_MS = 60 * 1000
export function listOrgEmbeddingModels(orgId, { ttlMs = ORG_MODELS_TTL_MS } = {}) {
  const hit = orgModelsCache.get(orgId)
  if (hit && hit.expiresAt > Date.now()) return hit.models
  const models = getDatabase().prepare(
    'SELECT model, COUNT(*) AS n FROM chunk_embeddings WHERE org_id = ? GROUP BY model ORDER BY n DESC'
  ).all(orgId).map((r) => r.model).filter(Boolean)
  orgModelsCache.set(orgId, { models, expiresAt: Date.now() + ttlMs })
  return models
}
export function _resetOrgModelsCache() { orgModelsCache.clear() }

/**
 * Chunk embedding coverage broken down per org, powers the `embeddings`
 * block on GET /brain/status for a trusted service-key caller (cross-org
 * visibility, e.g. an ops dashboard or the embedding backfill scheduler's
 * own reporting). Orgs with zero chunks are simply absent (nothing to
 * report), matching getOrgIdsWithMissingEmbeddings' "nothing missing ->
 * not returned" contract below.
 * @returns {Array<{orgId:string, total:number, embedded:number, missing:number, percent:number}>}
 */
export function getEmbeddingCoverageAllOrgs() {
  const db = getDatabase()
  // Same two-count shape as getEmbeddingCoverage (no join, see there).
  const totals = db.prepare('SELECT org_id AS orgId, COUNT(*) AS total FROM note_chunks GROUP BY org_id ORDER BY org_id ASC').all()
  const embedded = new Map(db.prepare('SELECT org_id AS orgId, COUNT(*) AS n FROM chunk_embeddings GROUP BY org_id').all().map((r) => [r.orgId, r.n]))
  return totals.map((r) => ({ orgId: r.orgId, ...coverageFromCounts(r.total, Math.min(r.total, embedded.get(r.orgId) || 0)) }))
}

/**
 * Distinct org ids that have at least one chunk with no chunk_embeddings
 * row, drives embeddingBackfillScheduler.js's per-tick fan-out (deps.
 * getOrgIdsWithMissingEmbeddings). Bounded by `limit` (the scheduler's
 * max-orgs-per-tick knob) so one tick can never enumerate every org in a
 * large instance; an org this tick skips because of the cap is simply
 * picked up on a later tick once its earlier-listed peers catch up.
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getOrgIdsWithMissingEmbeddings(limit = 100) {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT DISTINCT nc.org_id AS orgId
    FROM note_chunks nc
    LEFT JOIN chunk_embeddings ce ON ce.chunk_id = nc.id
    WHERE ce.chunk_id IS NULL
    ORDER BY nc.org_id ASC
    LIMIT ?
  `).all(limit)
  return rows.map((r) => r.orgId)
}

/**
 * Org ids the embedding backfill scheduler should visit this tick: orgs
 * with missing embeddings (as above) UNION fully-covered orgs whose rows
 * span more than one embedding model. The latter matters because vectors
 * from different models live in unrelated spaces (BRAIN2-SEMANTIC
 * 2026-08-25: the OpenAI/Gemini split) — such an org has nothing "missing"
 * yet dense search can only see one space per query, so the backfill's
 * healing pass must keep visiting it until it converges on a single space.
 * Honest limitation: an org uniformly embedded in a single WRONG space is
 * indistinguishable from clean here; it heals once any new note lands
 * (missing -> embed -> current model learned -> mismatch heals).
 * @param {number} [limit]
 * @returns {string[]}
 */
export function getOrgIdsNeedingEmbeddingWork(limit = 100, currentModel = null) {
  const db = getDatabase()
  // 2026-10-10: per-org counts instead of note_chunks x chunk_embeddings
  // joins (live profile: 10.3s main-thread block per tick on 245k chunks).
  // chunk_embeddings.org_id is denormalised at write and rows cascade with
  // their chunk, so "an org chunk has no embedding row" is exactly "the org
  // has more chunks than embedding rows". Sentinel-retired rows still count
  // as rows and as models, as before (test/embeddingCoverageCheap.test.js).
  const totals = db.prepare('SELECT org_id AS orgId, COUNT(*) AS n FROM note_chunks GROUP BY org_id').all()
  const emb = new Map(db.prepare('SELECT org_id AS orgId, COUNT(*) AS n, COUNT(DISTINCT model) AS models FROM chunk_embeddings GROUP BY org_id').all().map((r) => [r.orgId, r]))
  // 084: when the live provider model is known, an org whose vectors include
  // ANY other model needs healing even if it is uniformly in one old space.
  const stale = currentModel
    ? new Set(db.prepare('SELECT DISTINCT org_id AS orgId FROM chunk_embeddings WHERE model != ?').all(currentModel).map((r) => r.orgId))
    : new Set()
  const need = totals.filter((t) => {
    const e = emb.get(t.orgId)
    return !e || t.n > e.n || e.models > 1 || stale.has(t.orgId)
  }).map((t) => t.orgId)
  for (const orgId of stale) if (!need.includes(orgId)) need.push(orgId)
  if (need.length === 0) return []
  // 082: least-recently-attempted first (never-attempted orgs lead), so a few
  // permanently-pending orgs cannot monopolise the per-tick cap.
  const attempted = new Map(db.prepare('SELECT org_id AS orgId, last_attempt_at AS at FROM embed_org_attempts').all().map((r) => [r.orgId, r.at || '']))
  need.sort((x, y) => {
    const ax = attempted.get(x) || ''
    const ay = attempted.get(y) || ''
    return ax < ay ? -1 : ax > ay ? 1 : (x < y ? -1 : x > y ? 1 : 0)
  })
  return need.slice(0, limit)
}

/** Records that the embedding scheduler visited this org (082 rotation). */
export function markEmbedOrgAttempted(orgId) {
  getDatabase().prepare(`
    INSERT INTO embed_org_attempts (org_id, last_attempt_at) VALUES (?, ?)
    ON CONFLICT(org_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
  `).run(orgId, now())
}

/**
 * Facet metadata for the caller's (org_id, user_id) scope-union — what the
 * frontend renders as filter chips (sources/scopes/languages) instead of a
 * vault picker. `sources` is per-vault (scopeClause applied to `vaults`
 * directly, since a vault with zero notes still belongs in the facet list);
 * `scopes`/`languages`/`totalNotes` are per-NOTE counts across the same union
 * (scopeClause applied to `notes`) — every vault's notes already carry the
 * same scope/owner_user_id as their parent vault (denormalized at ingest),
 * so the two scopeClause applications resolve the identical visibility set.
 */
export function getBrainSources(org_id, user_id) {
  const db = getDatabase()
  const vScoped = scopeClause(org_id, user_id, { alias: 'v' })
  const nScoped = scopeClause(org_id, user_id, { alias: 'n' })

  const sourceRows = db.prepare(`
    SELECT v.id AS vaultId, v.name AS name, v.source_type AS sourceType, v.scope AS scope,
      COUNT(n.id) AS noteCount
    FROM vaults v
    LEFT JOIN notes n ON n.vault_id = v.id
    WHERE ${vScoped.sql}
    GROUP BY v.id
    ORDER BY v.name ASC
  `).all(...vScoped.params)

  // Per-vault dominant language: only surfaced when every language-tagged
  // note in the vault agrees on ONE non-null value (e.g. a translation
  // reader's single-language vault) — ambiguous/mixed vaults simply omit the
  // optional `language` field rather than guess.
  let langByVault = new Map()
  if (sourceRows.length > 0) {
    const vaultPh = sourceRows.map(() => '?').join(',')
    const langRows = db.prepare(`
      SELECT vault_id, language
      FROM notes
      WHERE vault_id IN (${vaultPh}) AND language IS NOT NULL
      GROUP BY vault_id, language
    `).all(...sourceRows.map((r) => r.vaultId))
    for (const row of langRows) {
      if (!langByVault.has(row.vault_id)) langByVault.set(row.vault_id, [])
      langByVault.get(row.vault_id).push(row.language)
    }
  }

  const sources = sourceRows.map((r) => {
    const out = { vaultId: r.vaultId, name: r.name, sourceType: r.sourceType, scope: r.scope, noteCount: r.noteCount }
    const langs = langByVault.get(r.vaultId)
    if (langs && langs.length === 1) out.language = langs[0]
    return out
  })

  const scopes = db.prepare(`
    SELECT n.scope AS scope, COUNT(*) AS noteCount
    FROM notes n
    WHERE ${nScoped.sql}
    GROUP BY n.scope
    ORDER BY noteCount DESC
  `).all(...nScoped.params)

  const languages = db.prepare(`
    SELECT n.language AS language, COUNT(*) AS noteCount
    FROM notes n
    WHERE ${nScoped.sql}
    GROUP BY n.language
    ORDER BY noteCount DESC
  `).all(...nScoped.params)

  const totalNotes = db.prepare(`SELECT COUNT(*) AS c FROM notes n WHERE ${nScoped.sql}`).get(...nScoped.params).c

  return { sources, scopes, languages, totalNotes }
}

export function listNotes(org_id, user_id, vault_id, { limit = 50, offset = 0, q } = {}) {
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'n' })

  if (q) {
    try {
      return db.prepare(`
        SELECT n.id, n.rel_path, n.title, n.word_count, n.mtime, n.updated_at
        FROM notes n
        JOIN notes_fts ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ? AND ${scoped.sql} AND n.vault_id = ?
        ORDER BY bm25(notes_fts)
        LIMIT ? OFFSET ?
      `).all(q, ...scoped.params, vault_id, limit, offset)
    } catch {
      // FTS5 query syntax error — fall back to LIKE (mirrors memoryStore.searchMemoriesLike)
      const like = `%${q}%`
      const flat = scopeClause(org_id, user_id)
      return db.prepare(`
        SELECT id, rel_path, title, word_count, mtime, updated_at
        FROM notes WHERE ${flat.sql} AND vault_id = ? AND (title LIKE ? OR body LIKE ?)
        ORDER BY title ASC LIMIT ? OFFSET ?
      `).all(...flat.params, vault_id, like, like, limit, offset)
    }
  }

  const flat = scopeClause(org_id, user_id)
  return db.prepare(`
    SELECT id, rel_path, title, word_count, mtime, updated_at
    FROM notes WHERE ${flat.sql} AND vault_id = ?
    ORDER BY title ASC
    LIMIT ? OFFSET ?
  `).all(...flat.params, vault_id, limit, offset)
}

/** ONE-BRAIN CX6: chunk ids of a note the caller can see ([] when invisible or unknown). */
export function getNoteChunkIds(org_id, user_id, noteId) {
  const db = getDatabase()
  const scoped = scopeClause(org_id, user_id, { alias: 'nc' })
  return db.prepare(`SELECT nc.id AS chunkId FROM note_chunks nc WHERE ${scoped.sql} AND nc.note_id = ?`).all(...scoped.params, noteId).map((r) => r.chunkId)
}

export function getNote(org_id, user_id, id) {
  const db = getDatabase()
  const { sql, params } = scopeClause(org_id, user_id)
  const note = db.prepare(`SELECT * FROM notes WHERE ${sql} AND id = ?`).get(...params, id)
  if (!note) return null

  const tags = db.prepare('SELECT tag FROM note_tags WHERE note_id = ?').all(id).map((t) => t.tag)

  // The target must be visible too (an outlink never leaks an invisible id/title).
  const tgtScope = scopeClause(org_id, user_id, { alias: 't' })
  const outlinks = db.prepare(`
    SELECT CASE WHEN t.id IS NULL THEN NULL ELSE nl.target_note_id END AS id, t.title, nl.target_raw AS targetRaw, nl.link_type AS type, nl.resolved
    FROM note_links nl
    LEFT JOIN notes t ON t.id = nl.target_note_id AND ${tgtScope.sql}
    WHERE nl.source_note_id = ?
  `).all(...tgtScope.params, id).map((r) => ({ ...r, resolved: Boolean(r.resolved) }))

  // AQ-9D: links now cross vaults (user notesq note -> org note), so a source
  // note must itself be visible to the caller: org notes plus the caller's own
  // user notes. Another member's private note never appears as a backlink.
  const srcScope = scopeClause(org_id, user_id, { alias: 's' })
  const backlinks = db.prepare(`
    SELECT s.id, s.title
    FROM note_links nl
    JOIN notes s ON s.id = nl.source_note_id
    WHERE nl.target_note_id = ? AND nl.resolved = 1 AND ${srcScope.sql}
  `).all(id, ...srcScope.params)

  return {
    ...note,
    frontmatter: safeJsonParse(note.frontmatter, {}),
    tags,
    backlinks,
    outlinks
  }
}

// org_id/user_id accepted for call-site symmetry with the rest of this
// READS section (server.js always threads req.org_id/req.user_id through
// uniformly) but note_tags carries no scope column (see section comment
// above) — vault_id is already the full authorization boundary here, since
// the caller only reaches this function after a scope-aware getVault() call
// already confirmed the vault (and therefore every tag row under it) is
// visible to (org_id, user_id).
export function getTags(org_id, user_id, vault_id) {
  const db = getDatabase()
  return db.prepare(`
    SELECT tag, COUNT(*) AS count
    FROM note_tags
    WHERE vault_id = ?
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `).all(vault_id)
}

export function searchNotes(org_id, user_id, vault_id, q) {
  const db = getDatabase()
  if (!q) return []

  try {
    const scoped = scopeClause(org_id, user_id, { alias: 'n' })
    return db.prepare(`
      SELECT n.id, n.rel_path, n.title
      FROM notes n
      JOIN notes_fts ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ? AND ${scoped.sql} AND n.vault_id = ?
      ORDER BY bm25(notes_fts)
      LIMIT 50
    `).all(q, ...scoped.params, vault_id)
  } catch {
    const like = `%${q}%`
    const { sql, params } = scopeClause(org_id, user_id)
    return db.prepare(`
      SELECT id, rel_path, title FROM notes
      WHERE ${sql} AND vault_id = ? AND (title LIKE ? OR body LIKE ?)
      ORDER BY title ASC LIMIT 50
    `).all(...params, vault_id, like, like)
  }
}

// -----------------------------------------------------------------------------
// DREAM WATERMARK (P3 WP1, migrations/005-dream.sql,
// docs/STREAM_QUOXBRAIN_P3_DREAM_CONTRACT.md §WP1) — the idempotency
// backbone for the QuoxDream consolidation engine. Unlike scopeClause()'s
// UNION-of-three-scopes read (org's own + user's own from any org + every
// shared row), a dream_cursor is kept PER TENANT SLICE — one cursor for
// (orgId, 'org', null), one per (anyOrgId, 'user', ownerUserId), one for
// (anyOrgId, 'shared', null) — so consolidateOrg (WP2) processes each slice
// as its own independent, resumable stream rather than a merged one. Hence
// getNotesSinceCursor filters to the SINGLE given scope tier, not the union.
//
// owner_user_id NULL <-> '' sentinel: see migrations/005-dream.sql's header
// comment for why the DB-level PK column always stores '' for "no owner"
// while every JS-facing value is null — ownerKey()/nullifyOwner() below are
// the only two places that boundary is crossed.
// -----------------------------------------------------------------------------

const DREAM_NO_OWNER_SENTINEL = ''

function ownerKey(ownerUserId) {
  return (ownerUserId === null || ownerUserId === undefined) ? DREAM_NO_OWNER_SENTINEL : ownerUserId
}

function nullifyOwner(row) {
  if (!row) return null
  return { ...row, owner_user_id: row.owner_user_id === DREAM_NO_OWNER_SENTINEL ? null : row.owner_user_id }
}

/** Single-scope-tier filter (as opposed to scopeClause()'s 3-way union) —
 * matches exactly the notes a dream_cursor for (orgId, scope, ownerUserId)
 * is responsible for. */
function dreamScopeSlice(orgId, scope, ownerUserId) {
  if (scope === 'org') return { sql: "(scope = 'org' AND org_id = ?)", params: [orgId] }
  if (scope === 'user') return { sql: "(scope = 'user' AND owner_user_id = ?)", params: [ownerUserId] }
  if (scope === 'shared') return { sql: "(scope = 'shared')", params: [] }
  throw new Error(`dreamScopeSlice: invalid scope "${scope}"`)
}

/**
 * Notes strictly AFTER the (occurred_at, id) cursor for one dream_cursor
 * tenant slice — deterministic keyset pagination so a consolidation pass
 * never re-processes nor skips a row, even when two notes share the exact
 * same occurred_at (the id tie-break makes the ordering total).
 *
 * WHERE clause (first-run/null cursor omits the second condition entirely,
 * so everything from the beginning is read):
 *   (occurred_at > ?) OR (occurred_at = ? AND id > ?)
 *
 * @param {string} orgId
 * @param {{scope:string, ownerUserId?:string|null, afterOccurredAt?:string|null, afterNoteId?:string|null, limit?:number}} opts
 * @returns {Array<{id,org_id,title,body,occurred_at,source_type,kind,scope,owner_user_id}>}
 */
export function getNotesSinceCursor(orgId, { scope, ownerUserId = null, afterOccurredAt = null, afterNoteId = null, afterIngestSeq, limit = 40 } = {}) {
  const db = getDatabase()
  const slice = dreamScopeSlice(orgId, scope, ownerUserId)
  const conditions = [slice.sql]
  const params = [...slice.params]

  if (afterOccurredAt !== null && afterOccurredAt !== undefined) {
    conditions.push('(occurred_at > ? OR (occurred_at = ? AND id > ?))')
    params.push(afterOccurredAt, afterOccurredAt, afterNoteId ?? '')
  }

  const clampedLimit = Math.min(Math.max(Number(limit) || 40, 1), 200)

  // BRAIN2-V3 B2: ingestion-order mode. When afterIngestSeq is a number the
  // occurred_at keyset is replaced by rowid order, so a back-dated import
  // (older occurred_at, later insert) is still read. Undefined keeps the
  // legacy occurred_at keyset (dream status coverage and old callers).
  if (afterIngestSeq !== undefined && afterIngestSeq !== null) {
    return db.prepare(`
      SELECT ingest_seq, id, org_id, title, body, occurred_at, source_type, kind, scope, owner_user_id
      FROM notes
      WHERE ${slice.sql} AND ingest_seq > ?
      ORDER BY ingest_seq ASC
      LIMIT ?
    `).all(...slice.params, Number(afterIngestSeq), clampedLimit)
  }

  params.push(clampedLimit)

  return db.prepare(`
    SELECT id, org_id, title, body, occurred_at, source_type, kind, scope, owner_user_id
    FROM notes
    WHERE ${conditions.join(' AND ')}
    ORDER BY occurred_at ASC, id ASC
    LIMIT ?
  `).all(...params)
}

/** @returns {object|null} the dream_cursor row for this tenant slice, or null
 *  if no consolidation pass has run yet (owner_user_id mapped back to null). */
export function getDreamCursor(orgId, scope, ownerUserId = null) {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT * FROM dream_cursor WHERE org_id = ? AND scope = ? AND owner_user_id = ?'
  ).get(orgId, scope, ownerKey(ownerUserId))
  return nullifyOwner(row)
}

/** Upserts the high-water mark for one tenant slice — INSERT..ON CONFLICT so
 * repeated calls for the same (org_id, scope, owner_user_id) update in place
 * rather than accumulating rows. */
export function setDreamCursor(orgId, scope, ownerUserId, lastOccurredAt, lastNoteId, lastIngestSeq = null) {
  const db = getDatabase()
  const ts = now()
  db.prepare(`
    INSERT INTO dream_cursor (org_id, scope, owner_user_id, last_occurred_at, last_note_id, last_ingest_seq, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, scope, owner_user_id) DO UPDATE SET
      last_occurred_at = excluded.last_occurred_at,
      last_note_id = excluded.last_note_id,
      last_ingest_seq = excluded.last_ingest_seq,
      updated_at = excluded.updated_at
  `).run(orgId, scope, ownerKey(ownerUserId), lastOccurredAt, lastNoteId, lastIngestSeq, ts)
}

/** Opens a dream_runs row at the start of a consolidation pass (WP2's
 * consolidateOrg) — returns the run id to pass to finishDreamRun. */
export function startDreamRun(orgId) {
  const db = getDatabase()
  const id = ulid()
  db.prepare(`
    INSERT INTO dream_runs (id, org_id, started_at, notes_read, beliefs_written, beliefs_deduped)
    VALUES (?, ?, ?, 0, 0, 0)
  `).run(id, orgId, now())
  return id
}

/** Closes out a dream_runs row with final stats (and an error message, if the
 * pass failed best-effort rather than crashing the service). notesFailed and
 * notesRetired are counted DISTINCTLY from notesRead so "0 claims" and
 * "extraction failed" are never conflated (BRAIN2-AUDIT). */
export function finishDreamRun(id, { notesRead = 0, beliefsWritten = 0, beliefsDeduped = 0, notesFailed = 0, notesRetired = 0, infraFailed = 0, error = null } = {}) {
  const db = getDatabase()
  db.prepare(`
    UPDATE dream_runs
    SET finished_at = ?, notes_read = ?, beliefs_written = ?, beliefs_deduped = ?,
        notes_failed = ?, notes_retired = ?, infra_failed = ?, error = ?
    WHERE id = ?
  `).run(now(), notesRead, beliefsWritten, beliefsDeduped, notesFailed, notesRetired, infraFailed, error, id)
}

/** @returns {{failures:number, retired_at:string|null}|null} */
export function getDreamNoteFailure(orgId, scope, ownerUserId, noteId) {
  const db = getDatabase()
  return db.prepare(
    'SELECT failures, retired_at FROM dream_note_failures WHERE org_id = ? AND scope = ? AND owner_user_id = ? AND note_id = ?'
  ).get(orgId, scope, ownerKey(ownerUserId), noteId) || null
}

/** Increments a note's extraction-failure count. Returns the new count. */
export function recordDreamNoteFailure(orgId, scope, ownerUserId, noteId, errorMsg) {
  const db = getDatabase()
  const ts = now()
  db.prepare(`
    INSERT INTO dream_note_failures (org_id, scope, owner_user_id, note_id, failures, last_error, last_failed_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(org_id, scope, owner_user_id, note_id)
    DO UPDATE SET failures = failures + 1, last_error = excluded.last_error, last_failed_at = excluded.last_failed_at
  `).run(orgId, scope, ownerKey(ownerUserId), noteId, String(errorMsg || '').slice(0, 300), ts)
  return getDreamNoteFailure(orgId, scope, ownerUserId, noteId).failures
}

/** Durably retires a note: it is never retried again. */
export function retireDreamNote(orgId, scope, ownerUserId, noteId) {
  const db = getDatabase()
  db.prepare(
    'UPDATE dream_note_failures SET retired_at = ? WHERE org_id = ? AND scope = ? AND owner_user_id = ? AND note_id = ?'
  ).run(now(), orgId, scope, ownerKey(ownerUserId), noteId)
}

/** A note that eventually extracted fine no longer carries a failure record. */
export function clearDreamNoteFailure(orgId, scope, ownerUserId, noteId) {
  const db = getDatabase()
  db.prepare(
    'DELETE FROM dream_note_failures WHERE org_id = ? AND scope = ? AND owner_user_id = ? AND note_id = ? AND retired_at IS NULL'
  ).run(orgId, scope, ownerKey(ownerUserId), noteId)
}

// -----------------------------------------------------------------------------
// DREAM COVERAGE (BRAIN2-V2 phase V2-4, read-only) — "how far has QuoxDream
// actually got?" as a number instead of an inference.
//
// BRAIN2 audit finding M5: consolidation advances a keyset watermark a batch
// at a time (batch=6 every 6h measured ≈ a 2-year full pass on a 20k-note
// org, ~6.9% covered after 55 days) and NOTHING surfaced that lag. This is
// the measurement half only: every read below is a COUNT/MIN/MAX. It does
// not touch lib/dreamScheduler.js's cadence, batch size, or the
// failure/backoff/retirement triad.
//
// HOW COVERAGE IS DERIVED (and where it is imprecise) — there is no
// "consolidated" column on notes, so the ONLY honest source is the same
// keyset predicate lib/quoxDream.js consolidates by. getNotesSinceCursor
// reads notes strictly AFTER (last_occurred_at, last_note_id); its exact
// complement is therefore "already consolidated":
//
//     covered   = occurred_at <  cursor OR (occurred_at = cursor AND id <= last_note_id)
//     remaining = occurred_at >  cursor OR (occurred_at = cursor AND id >  last_note_id)
//
// Caveats, stated rather than smoothed over:
//   1. "Covered" means the cursor has PASSED the note, not that a belief was
//      written from it. consolidateSlice advances the watermark per batch
//      regardless of whether extraction returned claims or the memory
//      service rejected the write (both are best-effort skips), so coverage
//      is an upper bound on distillation, an exact measure of cursor
//      progress.
//   2. Only the two slices consolidateOrg actually schedules are counted:
//      scope 'org' and the instance-wide scope 'shared'. scope 'user' notes
//      are never consolidated at all today (quoxDream.js's own WP3 TODO), so
//      counting them in the denominator would misreport the scheduler's job;
//      they are surfaced separately as notesUnscheduled.
//   3. Notes with a NULL occurred_at match NEITHER predicate (SQL NULL
//      comparisons are never true), so once a cursor exists they are
//      unreachable by getNotesSinceCursor, not merely pending. They are
//      reported as notesUndated rather than being folded into either bucket,
//      which is why covered + remaining + undated = total.
//   4. Throughput comes from dream_runs.notes_read (the only per-run count
//      stored). It counts notes READ, includes runs that later errored (their
//      earlier batches did advance the cursor), and counts a dryRun pass that
//      advanced nothing — so estFullPassDays is an estimate off observed
//      read rate, null whenever that rate is 0 or unknown.
// -----------------------------------------------------------------------------

// The slices consolidateOrg() actually runs (lib/quoxDream.js) — 'user' is
// deliberately absent, see caveat 2 above.
const DREAM_SCHEDULED_SCOPES = ['org', 'shared']
const DREAM_THROUGHPUT_WINDOW_DAYS = 7

function emptyDreamCoverage() {
  return {
    notesTotal: 0,
    notesCovered: 0,
    notesRemaining: 0,
    notesUndated: 0,
    notesUnscheduled: 0,
    coveragePct: 0,
    cursorAt: null,
    oldestUncoveredAt: null,
    lastRunAt: null,
    lastRunFinishedAt: null,
    recentThroughput: 0,
    recentRuns: 0,
    recentNotesPerDay: 0,
    throughputWindowDays: DREAM_THROUGHPUT_WINDOW_DAYS,
    estFullPassDays: null,
    slices: DREAM_SCHEDULED_SCOPES.map((scope) => ({
      scope, notesTotal: 0, notesCovered: 0, notesRemaining: 0, notesUndated: 0,
      cursorAt: null, cursorUpdatedAt: null, oldestUncoveredAt: null
    }))
  }
}

/** Coverage for ONE dream_cursor tenant slice — the complement of
 * getNotesSinceCursor's keyset predicate (see §HOW COVERAGE IS DERIVED). */
function dreamSliceCoverage(db, orgId, scope) {
  const slice = dreamScopeSlice(orgId, scope, null)
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END) AS undated,
           MIN(occurred_at) AS oldest
    FROM notes WHERE ${slice.sql}
  `).get(...slice.params)
  const notesTotal = totals?.total || 0
  const notesUndated = totals?.undated || 0

  const cursor = getDreamCursor(orgId, scope, null)
  const cursorAt = cursor?.last_occurred_at ?? null

  if (cursorAt === null) {
    // No pass has advanced this slice yet. Nothing is covered, and every
    // note is still reachable — the first-run query carries no occurred_at
    // predicate at all, so even undated rows are read on that pass.
    return {
      scope,
      notesTotal,
      notesCovered: 0,
      notesRemaining: notesTotal,
      notesUndated,
      cursorAt: null,
      cursorUpdatedAt: cursor?.updated_at ?? null,
      oldestUncoveredAt: totals?.oldest ?? null
    }
  }

  if (cursor.last_ingest_seq !== null && cursor.last_ingest_seq !== undefined) {
    // Ingestion-order cursor (BRAIN2-V3 B2): covered = ingest_seq <= seq.
    const c = db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE ${slice.sql} AND ingest_seq <= ?`).get(...slice.params, cursor.last_ingest_seq)
    const r = db.prepare(`SELECT COUNT(*) AS c, MIN(occurred_at) AS oldest FROM notes WHERE ${slice.sql} AND ingest_seq > ?`).get(...slice.params, cursor.last_ingest_seq)
    return {
      scope, notesTotal, notesCovered: c?.c || 0, notesRemaining: r?.c || 0, notesUndated,
      cursorAt, cursorUpdatedAt: cursor.updated_at ?? null, oldestUncoveredAt: r?.oldest ?? null
    }
  }

  const lastNoteId = cursor.last_note_id ?? ''
  const covered = db.prepare(`
    SELECT COUNT(*) AS c FROM notes
    WHERE ${slice.sql} AND (occurred_at < ? OR (occurred_at = ? AND id <= ?))
  `).get(...slice.params, cursorAt, cursorAt, lastNoteId)
  const remaining = db.prepare(`
    SELECT COUNT(*) AS c, MIN(occurred_at) AS oldest FROM notes
    WHERE ${slice.sql} AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
  `).get(...slice.params, cursorAt, cursorAt, lastNoteId)

  return {
    scope,
    notesTotal,
    notesCovered: covered?.c || 0,
    notesRemaining: remaining?.c || 0,
    notesUndated,
    cursorAt,
    cursorUpdatedAt: cursor.updated_at ?? null,
    oldestUncoveredAt: remaining?.oldest ?? null
  }
}

/**
 * QuoxDream consolidation coverage for one org — the data source for
 * GET /brain/dream/status. Pure read: COUNT/MIN/MAX only, no writes, no
 * scheduler interaction.
 *
 * Never throws: any failure (bad org id, missing table, DB hiccup) is caught
 * and returned as the zero/null shape, because a reporting read must never
 * fail the request it is decorating — same best-effort contract as
 * recordUsageEvent/getCitations above.
 *
 * `cursorAt` is the LAGGING edge across the scheduled slices: the oldest
 * watermark among slices that have notes, and null if any slice with notes
 * has no watermark at all (that slice has not started, so there is no single
 * honest "we are here" timestamp to report).
 *
 * @param {string} orgId - req.org_id from the auth middleware.
 * @returns {{notesTotal:number, notesCovered:number, notesRemaining:number, notesUndated:number, notesUnscheduled:number, coveragePct:number, cursorAt:string|null, oldestUncoveredAt:string|null, lastRunAt:string|null, lastRunFinishedAt:string|null, recentThroughput:number, recentRuns:number, recentNotesPerDay:number, throughputWindowDays:number, estFullPassDays:number|null, slices:Array<object>}}
 */
export function getDreamCoverage(orgId) {
  try {
    const db = getDatabase()
    const slices = DREAM_SCHEDULED_SCOPES.map((scope) => dreamSliceCoverage(db, orgId, scope))

    const sum = (key) => slices.reduce((acc, s) => acc + s[key], 0)
    const notesTotal = sum('notesTotal')
    const notesCovered = sum('notesCovered')
    const notesRemaining = sum('notesRemaining')
    const notesUndated = sum('notesUndated')

    // Slices with zero notes have nothing to consolidate, so their missing
    // watermark is not a lag — only a slice that HAS notes and no cursor
    // makes the aggregate watermark unreportable.
    const slicesWithNotes = slices.filter((s) => s.notesTotal > 0)
    const cursorAt = slicesWithNotes.length > 0 && slicesWithNotes.every((s) => s.cursorAt !== null)
      ? slicesWithNotes.map((s) => s.cursorAt).sort()[0]
      : null

    const uncoveredTimestamps = slices.map((s) => s.oldestUncoveredAt).filter((ts) => ts !== null && ts !== undefined)
    const oldestUncoveredAt = uncoveredTimestamps.length > 0 ? uncoveredTimestamps.sort()[0] : null

    // Never consolidated by anyone: scope='user' notes filed under this org.
    const unscheduled = db.prepare(
      `SELECT COUNT(*) AS c FROM notes WHERE scope = 'user' AND org_id = ?`
    ).get(orgId)

    const runWindow = db.prepare(`
      SELECT COUNT(*) AS runs, COALESCE(SUM(notes_read), 0) AS notesRead
      FROM dream_runs
      WHERE org_id = ? AND started_at >= datetime('now', ?)
    `).get(orgId, `-${DREAM_THROUGHPUT_WINDOW_DAYS} days`)
    const lastRun = db.prepare(
      'SELECT MAX(started_at) AS started, MAX(finished_at) AS finished FROM dream_runs WHERE org_id = ?'
    ).get(orgId)

    const recentThroughput = runWindow?.notesRead || 0
    const notesPerDayRaw = recentThroughput / DREAM_THROUGHPUT_WINDOW_DAYS
    // Never divide by zero and never fabricate: no observed throughput means
    // the full-pass estimate is unknown, not "instant" and not Infinity.
    const estFullPassDays = notesPerDayRaw > 0
      ? Math.round((notesRemaining / notesPerDayRaw) * 10) / 10
      : null

    return {
      notesTotal,
      notesCovered,
      notesRemaining,
      notesUndated,
      notesUnscheduled: unscheduled?.c || 0,
      coveragePct: notesTotal > 0 ? Math.round((notesCovered / notesTotal) * 1000) / 10 : 0,
      cursorAt,
      oldestUncoveredAt,
      lastRunAt: lastRun?.started || null,
      lastRunFinishedAt: lastRun?.finished || null,
      recentThroughput,
      recentRuns: runWindow?.runs || 0,
      recentNotesPerDay: Math.round(notesPerDayRaw * 100) / 100,
      throughputWindowDays: DREAM_THROUGHPUT_WINDOW_DAYS,
      estFullPassDays,
      slices
    }
  } catch (err) {
    console.warn('[Brain] dream coverage read failed (non-fatal):', err.message)
    return emptyDreamCoverage()
  }
}

// -----------------------------------------------------------------------------
// USAGE LEDGER (BRAIN2-PRODUCT P3a, migrations/006-usage-events.sql) — makes
// "is it used?" a visible number instead of an inference. One row per hit on
// the four read surfaces (search/context/note_read/graph); `source`
// distinguishes the calling channel (ui/agent/cli/mcp/service — see
// server.js's X-Quox-Source header handling), separately from `surface`.
// -----------------------------------------------------------------------------

const USAGE_SURFACES = ['search', 'context', 'note_read', 'graph']

/**
 * Records one usage-ledger row. Self-contained best-effort: ANY failure here
 * (bad params, DB hiccup) is caught, logged, and swallowed — a usage-logging
 * error must never fail the real request the caller is fulfilling. Returns
 * true/false rather than throwing, purely for tests to assert on.
 */
export function recordUsageEvent({ org_id, user_id = null, surface, source }) {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO usage_events (id, org_id, user_id, surface, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ulid(), org_id, user_id, surface, source, now())
    return true
  } catch (err) {
    console.warn('[Brain] usage-event record failed (non-fatal):', err.message)
    return false
  }
}

/** Best-effort boot-time hygiene (called once from server.js, mirroring the
 * other schedulers' startup calls) — deletes usage_events older than `days`
 * (default 90) so the ledger doesn't grow unbounded. Never throws. */
export function cleanupOldUsageEvents({ days = 90 } = {}) {
  try {
    const db = getDatabase()
    const info = db.prepare(`DELETE FROM usage_events WHERE created_at < datetime('now', ?)`).run(`-${days} days`)
    return info.changes
  } catch (err) {
    console.warn('[Brain] usage-event cleanup failed (non-fatal):', err.message)
    return 0
  }
}

/**
 * GET /brain/usage's data source. `week` is a rolling 7-day window (not
 * calendar week); `total` is lifetime. `byExternalSource` on each bucket
 * groups by the calling channel (ui/agent/cli/mcp/service), independent of
 * `surface`. lastAgentQueryAt/lastSearchAt are the two "is anything actually
 * reading this brain?" headline timestamps for the settings card.
 */
export function getUsage(orgId) {
  const db = getDatabase()

  function summarize(sinceClause, sinceParams) {
    const rows = db.prepare(`
      SELECT surface, source, COUNT(*) AS count
      FROM usage_events
      WHERE org_id = ? ${sinceClause}
      GROUP BY surface, source
    `).all(orgId, ...sinceParams)

    const bySurface = { search: 0, context: 0, note_read: 0, graph: 0 }
    const byExternalSource = {}
    for (const row of rows) {
      if (USAGE_SURFACES.includes(row.surface)) bySurface[row.surface] += row.count
      byExternalSource[row.source] = (byExternalSource[row.source] || 0) + row.count
    }
    return { ...bySurface, byExternalSource }
  }

  const week = summarize(`AND created_at >= datetime('now', '-7 days')`, [])
  const total = summarize('', [])

  const lastAgentRow = db.prepare(
    `SELECT MAX(created_at) AS ts FROM usage_events WHERE org_id = ? AND source = 'agent'`
  ).get(orgId)
  const lastSearchRow = db.prepare(
    `SELECT MAX(created_at) AS ts FROM usage_events WHERE org_id = ? AND surface = 'search'`
  ).get(orgId)

  return {
    week,
    total,
    lastAgentQueryAt: lastAgentRow?.ts || null,
    lastSearchAt: lastSearchRow?.ts || null,
    citations: getCitations(orgId, db)
  }
}

// -----------------------------------------------------------------------------
// CITATION LEDGER (BRAIN2-V2 phase V2-1, migrations/008-citation-events.sql) —
// the other half of the usage question. The usage ledger above answers "is the
// brain READ?"; this answers "does what it returned end up in the ANSWER?".
// One row per agent answer that followed a quoxbrain_search: the collector
// detects which retrieved notes the final answer actually cited and POSTs it
// to /brain/citations. Same best-effort contract as recordUsageEvent.
// -----------------------------------------------------------------------------

/**
 * Records one citation-ledger row. Self-contained best-effort: ANY failure
 * here (bad params, DB hiccup) is caught, logged, and swallowed — citation
 * telemetry must never fail the answer the caller just produced. Returns
 * true/false rather than throwing, purely for tests to assert on.
 */
export function recordCitationEvent({
  org_id, user_id = null, agent_id = null, corr = null,
  retrieved_count, cited_count, supported_count = null, overlap_count = null, fabricated_count = null, cited_note_ids = []
}) {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO citation_events (id, org_id, user_id, agent_id, corr, retrieved_count, cited_count, supported_count, overlap_count, fabricated_count, cited_note_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ulid(), org_id, user_id, agent_id, corr,
      retrieved_count, cited_count,
      Number.isInteger(supported_count) ? supported_count : null,
      Number.isInteger(overlap_count) ? overlap_count : null,
      Number.isInteger(fabricated_count) ? fabricated_count : null,
      JSON.stringify(Array.isArray(cited_note_ids) ? cited_note_ids : []),
      now()
    )
    return true
  } catch (err) {
    console.warn('[Brain] citation-event record failed (non-fatal):', err.message)
    return false
  }
}

/** Retrieval-time revision pin: {noteId: content_hash} for the org's notes. Never throws. */
export function getNoteContentHashes(orgId, noteIds = []) {
  const out = {}
  try {
    const ids = [...new Set((noteIds || []).filter(i => typeof i === 'string' && i))].slice(0, 200)
    if (!ids.length) return out
    const db = getDatabase()
    const rows = db.prepare(`SELECT id, content_hash FROM notes WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(orgId, ...ids)
    for (const r of rows) if (r.content_hash) out[r.id] = r.content_hash
  } catch (err) {
    console.warn('[Brain] note hash pin lookup failed (non-fatal):', err.message)
  }
  return out
}

const triBool =(v) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null)
const spanInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null)

/**
 * BRAIN2-W13 A 118: persists a finalized turn's per-reference citation records
 * (migration 022). Best-effort like recordCitationEvent; invalid rows (no
 * note_id) are skipped. note_hash falls back to the note's CURRENT
 * content_hash (org-scoped lookup) when the caller did not send one. Returns
 * the number of rows written.
 */
export function recordCitationRecords({ org_id, user_id = null, session = null, records = [] }) {
  try {
    if (!org_id || !Array.isArray(records)) return 0
    const db = getDatabase()
    const ins = db.prepare(`
      INSERT INTO citation_records (id, org_id, user_id, session, handle, note_id, char_start, char_end, note_hash, passage_hash, supported, contradicted, support_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const hashOf = db.prepare('SELECT content_hash FROM notes WHERE id = ? AND org_id = ?')
    let n = 0
    const ts = now()
    for (const r of records.slice(0, 200)) {
      const fab = !!r && r.support_method === 'fabricated'
      if (!r || (!fab && (typeof r.note_id !== 'string' || !r.note_id))) continue
      let hash = typeof r.note_hash === 'string' && r.note_hash ? r.note_hash : null
      if (!hash && !fab) hash = hashOf.get(r.note_id, org_id)?.content_hash ?? null
      ins.run(
        ulid(), org_id, user_id, session,
        typeof r.handle === 'string' ? r.handle.slice(0, 16) : null,
        fab ? '' : r.note_id, spanInt(r.char_start), spanInt(r.char_end), hash,
        typeof r.passage_hash === 'string' && r.passage_hash ? r.passage_hash.slice(0, 128) : null,
        triBool(r.supported), triBool(r.contradicted),
        r.support_method === 'entailment' || r.support_method === 'overlap' || r.support_method === 'unchecked' || r.support_method === 'fabricated' ? r.support_method : null, ts
      )
      n++
    }
    return n
  } catch (err) {
    console.warn('[Brain] citation-records record failed (non-fatal):', err.message)
    return 0
  }
}

/** Org-scoped read of persisted citation records, newest first. userId, when
 * given, narrows to that user (a user caller never sees another user's turns). */
export function listCitationRecords(orgId, { userId = null, session = null, limit = 50 } = {}) {
  const db = getDatabase()
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const where = ['org_id = ?']
  const args = [orgId]
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  if (session) { where.push('session = ?'); args.push(session) }
  const rows = db.prepare(`SELECT r.session, r.handle, r.note_id, r.char_start, r.char_end, r.note_hash, r.passage_hash, r.supported, r.contradicted, r.support_method, r.created_at,
      n.content_hash AS current_hash
    FROM citation_records r LEFT JOIN notes n ON n.id = r.note_id AND n.org_id = r.org_id
    WHERE ${where.map(w => 'r.' + w).join(' AND ')} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...args, cap)
  const tri = (v) => (v === null || v === undefined ? null : v === 1)
  return rows.map(({ current_hash, ...r }) => {
    // Pinned at retrieval time: never silently re-read against the new text.
    if (r.support_method === 'fabricated') return { ...r, supported: false, contradicted: tri(r.contradicted), note_changed: null, note_status: 'fabricated' }
    const changed = r.note_hash ? (current_hash == null || current_hash !== r.note_hash) : null
    return {
      ...r,
      supported: tri(r.supported),
      contradicted: tri(r.contradicted),
      note_changed: changed,
      note_status: changed === true ? 'note changed since cited' : changed === false ? 'current' : 'unpinned'
    }
  })
}

// -----------------------------------------------------------------------------
// RELEVANCE JUDGEMENTS (ONE-BRAIN CX5, migration 027)
// -----------------------------------------------------------------------------

const JUDGEMENT_VERDICTS = ['relevant', 'irrelevant', 'should_abstain']

/** Record a judgement. Idempotent per (org, query, note, verdict): re-judging
 * returns the existing row with created:false. Throws Error with .code
 * 'bad_verdict' | 'bad_query' | 'note_required' | 'note_not_found'. A
 * relevant/irrelevant note must be visible to the caller (getNote scope rules). */
export function addRelevanceJudgement({ org_id, user_id = null, query, note_id = null, verdict, source = null }) {
  const fail = (code) => Object.assign(new Error(code), { code })
  if (!JUDGEMENT_VERDICTS.includes(verdict)) throw fail('bad_verdict')
  const q = typeof query === 'string' ? query.trim().slice(0, 1000) : ''
  if (!q) throw fail('bad_query')
  let nid = null
  if (verdict !== 'should_abstain') {
    if (typeof note_id !== 'string' || !note_id) throw fail('note_required')
    if (!getNote(org_id, user_id, note_id)) throw fail('note_not_found')
    nid = note_id
  }
  const db = getDatabase()
  const src = ['cli', 'agent', 'ui'].includes(source) ? source : null
  const find = () => db.prepare("SELECT * FROM relevance_judgements WHERE org_id = ? AND query = ? AND COALESCE(note_id, '') = ? AND verdict = ?").get(org_id, q, nid || '', verdict)
  const existing = find()
  if (existing) return { ...existing, created: false }
  db.prepare('INSERT INTO relevance_judgements (id, org_id, user_id, query, note_id, verdict, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ulid(), org_id, user_id, q, nid, verdict, src, now())
  return { ...find(), created: true }
}

/** Org-scoped list, newest first. userId, when given, narrows to that user's own rows. */
export function listRelevanceJudgements(orgId, { userId = null, limit = 200 } = {}) {
  const db = getDatabase()
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)
  const where = ['org_id = ?']
  const args = [orgId]
  if (userId) { where.push('user_id = ?'); args.push(userId) }
  return db.prepare(`SELECT id, user_id, query, note_id, verdict, source, created_at FROM relevance_judgements WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, cap)
}

/** Delete by id within the org; userId (when given) restricts to own rows. */
export function deleteRelevanceJudgement(orgId, id, { userId = null } = {}) {
  const db = getDatabase()
  const r = userId
    ? db.prepare('DELETE FROM relevance_judgements WHERE id = ? AND org_id = ? AND user_id = ?').run(id, orgId, userId)
    : db.prepare('DELETE FROM relevance_judgements WHERE id = ? AND org_id = ?').run(id, orgId)
  return r.changes > 0
}

/** Best-effort boot-time hygiene (called once from server.js alongside
 * cleanupOldUsageEvents) — deletes citation_events older than `days`
 * (default 90) so the ledger doesn't grow unbounded. Never throws. */
export function cleanupOldCitationEvents({ days = 90 } = {}) {
  try {
    const db = getDatabase()
    const info = db.prepare(`DELETE FROM citation_events WHERE created_at < datetime('now', ?)`).run(`-${days} days`)
    db.prepare(`DELETE FROM citation_records WHERE created_at < datetime('now', ?)`).run(`-${days} days`)
    return info.changes
  } catch (err) {
    console.warn('[Brain] citation-event cleanup failed (non-fatal):', err.message)
    return 0
  }
}

/**
 * The `citations` block of GET /brain/usage. `week` is the same rolling
 * 7-day window the usage ledger uses (not a calendar week); `total` is
 * lifetime. `answers` is every recorded answer, `grounded` only those that
 * cited at least one retrieved note — grounded/answers IS the citation rate,
 * derived at read time from the stored numerator+denominator rather than
 * from a precomputed number, so both windows stay honest.
 */
function getCitations(orgId, db = getDatabase()) {
  function summarize(sinceClause) {
    const row = db.prepare(`
      SELECT
        COUNT(*)                                        AS answers,
        SUM(CASE WHEN cited_count > 0 THEN 1 ELSE 0 END) AS grounded,
        SUM(retrieved_count)                            AS retrievedNotes,
        SUM(cited_count)                                AS citedNotes,
        SUM(CASE WHEN supported_count IS NOT NULL THEN 1 ELSE 0 END) AS supportMeasured,
        SUM(CASE WHEN supported_count > 0 THEN 1 ELSE 0 END)         AS supportedAnswers,
        SUM(COALESCE(supported_count, 0))               AS supportedNotes,
        SUM(CASE WHEN overlap_count > 0 THEN 1 ELSE 0 END)           AS overlapAnswers,
        SUM(COALESCE(overlap_count, 0))                 AS overlapNotes,
        SUM(CASE WHEN fabricated_count > 0 THEN 1 ELSE 0 END)        AS fabricatedAnswers,
        SUM(COALESCE(fabricated_count, 0))              AS fabricatedCitations
      FROM citation_events
      WHERE org_id = ? ${sinceClause}
    `).get(orgId)

    return {
      answers: row?.answers || 0,
      // Codex cycle 6: citing a note is not grounding. `cited` is the honest
      // name; `grounded` stays as its back-compat alias. Support is separate:
      // supportMeasured answers were checked, supportedAnswers passed (lexical,
      // contradicted refs never count), unchecked = cited but never checked.
      cited: row?.grounded || 0,
      grounded: row?.grounded || 0,
      unchecked: Math.max(0, (row?.grounded || 0) - (row?.supportMeasured || 0)),
      retrievedNotes: row?.retrievedNotes || 0,
      citedNotes: row?.citedNotes || 0,
      // Lexical support (not semantic proof); supportMeasured = answers the
      // check ran on (older collectors leave it NULL).
      supportMeasured: row?.supportMeasured || 0,
      supportedAnswers: row?.supportedAnswers || 0,
      supportedNotes: row?.supportedNotes || 0,
      // Lexical-only passes: the source shares the claim's words, not checked
      // for meaning. Never counted in supportedAnswers.
      overlapAnswers: row?.overlapAnswers || 0,
      overlapNotes: row?.overlapNotes || 0,
      // Cited handles that were never retrieved for the turn.
      fabricatedAnswers: row?.fabricatedAnswers || 0,
      fabricatedCitations: row?.fabricatedCitations || 0
    }
  }

  const lastGroundedRow = db.prepare(
    `SELECT MAX(created_at) AS ts FROM citation_events WHERE org_id = ? AND cited_count > 0`
  ).get(orgId)

  return {
    week: summarize(`AND created_at >= datetime('now', '-7 days')`),
    total: summarize(''),
    lastGroundedAt: lastGroundedRow?.ts || null
  }
}

// -----------------------------------------------------------------------------
// ACTIVITY FEED (GET /brain/activity, BRAIN2 visualiser) — recent autonomic
// activity within a caller-supplied window. Every field here is a real query
// result; nothing is synthesized or estimated. Mirrors the scoping/pattern of
// getBrainStatus/getDreamCoverage above rather than introducing a new shape.
// -----------------------------------------------------------------------------

/**
 * Notes created within [sinceIso, now), scoped the SAME way as every other
 * read (scopeClause union of org/user/shared). Returns the TRUE count
 * separately from the (possibly truncated) id list — the id list is capped
 * at `limit` for payload size, the count never is.
 */
/**
 * QUOXON E5: decision notes (tag `decision`, what `quox brain decide` writes) created at or after
 * sinceIso, newest first, scoped exactly like getRecentNotes. -> { count, items: [{ id, title, created_at }] }
 */
export function getDecisionsSince(orgId, userId, { sinceIso, limit = 50 } = {}) {
  const db = getDatabase()
  const scoped = scopeClause(orgId, userId, { alias: 'nc' })
  const where = `${scoped.sql} AND nc.created_at >= ? AND EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = nc.id AND lower(t.tag) = 'decision')`
  const items = db.prepare(`SELECT nc.id, nc.title, nc.created_at FROM notes nc WHERE ${where} ORDER BY nc.created_at DESC LIMIT ?`)
    .all(...scoped.params, sinceIso, Math.max(1, Math.min(200, Number(limit) || 50)))
  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM notes nc WHERE ${where}`).get(...scoped.params, sinceIso)
  return { count: countRow?.c || 0, items }
}

export function getRecentNotes(orgId, userId, { sinceIso, limit = 150 } = {}) {
  const db = getDatabase()
  const scoped = scopeClause(orgId, userId, { alias: 'nc' })
  const rows = db.prepare(`
    SELECT id FROM notes nc
    WHERE ${scoped.sql} AND nc.created_at >= ?
    ORDER BY nc.created_at DESC
    LIMIT ?
  `).all(...scoped.params, sinceIso, limit)
  const countRow = db.prepare(`
    SELECT COUNT(*) AS c FROM notes nc
    WHERE ${scoped.sql} AND nc.created_at >= ?
  `).get(...scoped.params, sinceIso)
  return { count: countRow?.c || 0, noteIds: rows.map((r) => r.id) }
}

/**
 * Individual dream_runs rows within [sinceIso, now) plus the true
 * notes-read sum over that same window. getDreamCoverage() above already
 * aggregates run counts/throughput over ITS OWN fixed window
 * (DREAM_THROUGHPUT_WINDOW_DAYS) and never returns individual run rows; the
 * activity feed needs the caller's window and the actual rows, so this reads
 * dream_runs directly (org-scoped only — dream runs are not user/shared
 * scoped, same as dream_runs' schema in migrations/005-dream.sql).
 */
export function getDreamActivity(orgId, sinceIso, limit = 10) {
  const db = getDatabase()
  const recentRuns = db.prepare(`
    SELECT started_at AS startedAt, finished_at AS finishedAt,
           notes_read AS notesRead, beliefs_written AS beliefsWritten
    FROM dream_runs
    WHERE org_id = ? AND started_at >= ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(orgId, sinceIso, limit)
  const sum = db.prepare(`
    SELECT COALESCE(SUM(notes_read), 0) AS notesRead
    FROM dream_runs WHERE org_id = ? AND started_at >= ?
  `).get(orgId, sinceIso)
  return { recentRuns, notesReadRecent: sum?.notesRead || 0 }
}

/**
 * Chunk-embedding recency proxy for the activity feed — count of
 * chunk_embeddings rows whose updated_at falls within the window. This is
 * NOT a discrete run event (embeddings are written by the backfill
 * scheduler independently of any single "run"), only a recency signal; the
 * route labels it honestly rather than implying a run happened.
 */
/** CORTEX-BENCH: which of these chunk ids have NO embedding yet (any model). */
export function unembeddedChunkIds(orgId, chunkIds) {
  const ids = [...new Set((chunkIds || []).filter(Boolean))]
  if (ids.length === 0) return new Set()
  const db = getDatabase()
  const have = new Set()
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400)
    const rows = db.prepare(_unembeddedSql(part.length)).all(...part, orgId)
    for (const r of rows) have.add(r.chunk_id)
  }
  return new Set(ids.filter((id) => !have.has(id)))
}

// ONE-BRAIN CX1: "org_id = ? AND chunk_id IN (...)" was driven from the org
// index (a walk over every embedding of the org, on every hybrid search). The
// VALUES CTE CROSS JOINed first forces one primary-key probe per id (same
// pattern as getChunkDetails); org is still enforced in WHERE.
export function _unembeddedSql(n) {
  return `${idsCte(Array.from({ length: n }))} SELECT ce.chunk_id FROM ids CROSS JOIN chunk_embeddings ce ON ce.chunk_id = ids.id WHERE ce.org_id = ?`
}

/**
 * CORTEX-BENCH (latency): snippet() in the ranked FTS query is evaluated for
 * EVERY matched row before ORDER BY/LIMIT (up to 500 rows, ~0.25-0.5s of
 * synchronous work). Callers that keep only a small pool search with
 * deferSnippets and fill snippets here for the survivors only. Mutates rows
 * (sets .snippet, drops .ftsRowid). Never throws.
 */
export function fillChunkSnippets(query, rows) {
  const pending = (rows || []).filter((r) => r && r.ftsRowid != null)
  if (pending.length === 0) return rows
  try {
    const matchQuery = buildOrMatchQuery(query)
    if (matchQuery) {
      const ids = pending.map((r) => r.ftsRowid)
      const got = getDatabase().prepare(
        `SELECT rowid AS r, snippet(note_chunks_fts, 0, '[', ']', '...', 64) AS sn FROM note_chunks_fts WHERE note_chunks_fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`
      ).all(matchQuery, ...ids)
      const byRow = new Map(got.map((g) => [g.r, g.sn]))
      for (const r of pending) r.snippet = byRow.get(r.ftsRowid) ?? r.snippet ?? null
    }
  } catch (err) {
    console.error('[Brain] fillChunkSnippets error:', err.message)
  }
  for (const r of pending) delete r.ftsRowid
  return rows
}

export function getRecentlyEmbeddedChunkCount(orgId, sinceIso) {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM chunk_embeddings WHERE org_id = ? AND updated_at >= ?
  `).get(orgId, sinceIso)
  return row?.c || 0
}

export default {
  createVault, getVault, listVaults, listKnownOrgIds, deleteVault, setVaultStatus, canWriteVault, scopeClause,
  createVaultRootGrant, listVaultRootGrants,
  noteId, upsertNote, setNoteProvenance, deleteNote, listNoteRelPaths,
  replaceNoteLinks, replaceNoteTags, resolveVaultLinks,
  chunkId, replaceNoteChunks, searchChunks, getChunkDetails, getChunkMeta, filterChunkIdsByFacets, getNotesMissingChunks,
  denseSearchChunks,
  denseSearchChunksAsync,
  listOrgEmbeddingModels,
  getGraph, getBrainGraph, getBrainSources, listNotes, getNote, getTags, searchNotes,
  getNotesSinceCursor, getDreamCursor, setDreamCursor, startDreamRun, finishDreamRun,
  getDreamCoverage,
  recordUsageEvent, cleanupOldUsageEvents, getUsage,
  recordCitationEvent, cleanupOldCitationEvents,
  getRecentNotes, getDreamActivity, getRecentlyEmbeddedChunkCount, getDecisionsSince
}
export function _denseCacheKeysForTest() { return [...denseVectorCache.keys()] }
