// ingest.js — vault indexing engine (P0.3, roadmap QUOXBRAIN #163)
//
// Walks a vault's source_path for markdown files, incrementally parses
// changed/new notes (content-hash skip for unchanged files), removes notes
// for deleted files, then resolves all links against the full note set.
//
// P0 runs this SYNCHRONOUSLY inside the request that triggers it (register
// or POST /reindex). Acceptable for P0: NodeBrain's 203 files index in
// under a second. A background job queue is explicitly out of scope for P0
// — do not build one here.

import { redactSecrets } from './redact.js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { createHash } from 'crypto'
import { parseNote } from './vaultParser.js'
import { resolveSafeVaultPath } from './vaultRoot.js'
import { getDatabase } from './db.js'
import * as store from './vaultStore.js'
import { chunkNote } from './chunker.js'

// Obsidian's own config/trash dirs, plus any other dotdir (.git, etc) — never
// walked, even if they happen to contain .md files underneath.
const SKIP_DIR_NAMES = new Set(['.obsidian', '.trash'])

// 069: the direct filesystem path had none of the feed readers' bounds.
// Oversize files are skipped (not read), the walk stops at a file-count cap, and
// directory depth is bounded. All overridable; the defaults are generous for
// real vaults and hostile for a runaway tree.
function envInt(name, dflt) {
  const n = Number(process.env[name])
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n > 0 ? n : dflt
}
const maxFileBytes = () => envInt('QUOXBRAIN_INGEST_MAX_FILE_BYTES', 2 * 1024 * 1024)
const maxFiles = () => envInt('QUOXBRAIN_INGEST_MAX_FILES', 20000)
const maxDepth = () => envInt('QUOXBRAIN_INGEST_MAX_DEPTH', 32)

function walkMarkdownFiles(root) {
  const files = []
  const fileCap = maxFiles()
  const depthCap = maxDepth()
  let truncated = false

  function walk(dir, depth) {
    if (depth > depthCap) { truncated = true; return }
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= fileCap) { truncated = true; return }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const abs = join(dir, entry.name)
        const relPath = relative(root, abs).split(sep).join('/')
        files.push({ relPath, absPath: abs })
      }
    }
  }

  walk(root, 0)
  if (truncated) console.warn(`[Brain] filesystem ingest of ${root} truncated at ${fileCap} files / depth ${depthCap}`)
  return files
}

function sha1(content) {
  return createHash('sha1').update(content).digest('hex')
}

// Cooperative-ingest default (BRAIN2-V2-2). Parse+chunk+write is CPU-heavy and
// better-sqlite3 is synchronous, so a single giant transaction over hundreds of
// docs pins Node's one thread for seconds and starves every other request —
// including docker's /health probe. We instead process in small batches, each
// its own SHORT transaction (BEGIN…COMMIT fully before yielding — better-sqlite3
// forbids awaiting inside a transaction, and a COMMITted batch is durable), then
// release the event loop between batches so /health and other requests get
// serviced in the gaps.
const DEFAULT_BATCH_SIZE = 25

// A real macrotask yield: setImmediate fires after I/O callbacks, so any pending
// request (the /health probe) runs before the next batch.
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

function batchArray(items, size) {
  const batches = []
  const n = size > 0 ? size : DEFAULT_BATCH_SIZE
  for (let i = 0; i < items.length; i += n) {
    batches.push(items.slice(i, i + n))
  }
  return batches
}

function firstNonEmptyLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim())
  return line ? line.trim() : null
}

/**
 * Indexes (or re-indexes) a vault end to end. Never leaves the vault's
 * status stuck at 'indexing' — any throw during the walk/parse/resolve is
 * caught, recorded via setVaultStatus('error', ...) and re-thrown so the
 * caller (route handler) can surface it.
 *
 * Push vaults (source_type='push', P2b-1) have no filesystem source — all
 * their content arrives via ingestDocuments() below — so this is a no-op for
 * them: just report the vault ready with whatever counts already exist from
 * prior document pushes. Never walks a filesystem for a push vault.
 *
 * @param {{id: string, org_id: string, source_type?: string, source_path: string}} vault
 * @returns {object} the updated vault row (status 'ready', note_count, edge_count, last_indexed_at)
 */
export async function indexVault(vault, { batchSize = DEFAULT_BATCH_SIZE, onBatchYield = null } = {}) {
  const db = getDatabase()

  if (vault.source_type === 'push') {
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE vault_id = ?').get(vault.id).c
    store.setVaultStatus(vault.id, 'ready', { note_count: noteCount, last_indexed_at: new Date().toISOString(), error: null })
    return store.getVault(vault.org_id, vault.owner_user_id, vault.id)
  }

  try {
    const safeRoot = resolveSafeVaultPath(vault.source_path, vault.org_id)
    store.setVaultStatus(vault.id, 'indexing', { error: null })

    const files = walkMarkdownFiles(safeRoot)

    const existingRows = db.prepare('SELECT id, rel_path, content_hash, title, language, kind, source_type, occurred_at, origin_store, origin_id FROM notes WHERE vault_id = ?').all(vault.id)
    const existingByRelPath = new Map(existingRows.map((r) => [r.rel_path, r]))
    const seenRelPaths = new Set()
    const changedNoteIds = new Set() // 068: notes added/edited/deleted this pass

    // Pass 1: upsert changed/new notes + their links/tags. Batched + yielded
    // (BRAIN2-V2-2): each batch is ONE short transaction (durable on commit),
    // and the event loop is released between batches so a big vault can't
    // freeze /health. Semantics are identical to the old single-transaction
    // pass — only the scheduling changed.
    const batches = batchArray(files, batchSize)
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b]
      const tx = db.transaction(() => {
        for (const file of batch) {
          seenRelPaths.add(file.relPath)

          const stat = statSync(file.absPath)
          if (stat.size > maxFileBytes()) {
            console.warn(`[Brain] skipping ${file.relPath}: ${stat.size} bytes exceeds the ${maxFileBytes()}-byte ingest cap`)
            continue // seenRelPaths already has it, so an existing note is kept, not deleted
          }
          const content = readFileSync(file.absPath, 'utf8')
          const contentHash = sha1(content)
          const existing = existingByRelPath.get(file.relPath)

          if (existing && existing.content_hash === contentHash) {
            continue // incremental skip — content unchanged since last index
          }

          const parsed = parseNote({ relPath: file.relPath, content })

          // language (P2.5b-1, migrations/004-language.sql): frontmatter wins
          // (a note author's explicit `language:` field), falling back to the
          // vault's own `language` if one is ever set, else NULL/unspecified —
          // NOT stamped per-vault by default the way scope is, since a
          // filesystem vault can legitimately mix languages across files.
          const language = (typeof parsed.frontmatter?.language === 'string' && parsed.frontmatter.language.trim())
            ? parsed.frontmatter.language.trim()
            : (vault.language || null)

          const noteId = store.upsertNote({
            vault_id: vault.id,
            org_id: vault.org_id,
            rel_path: file.relPath,
            title: parsed.title,
            frontmatter: JSON.stringify(parsed.frontmatter || {}),
            body: parsed.body,
            word_count: parsed.wordCount,
            mtime: stat.mtime.toISOString(),
            content_hash: contentHash,
            scope: vault.scope,
            owner_user_id: vault.owner_user_id,
            language
          })

          changedNoteIds.add(noteId)
          store.replaceNoteLinks(noteId, vault.id, vault.org_id, parsed.links || [])
          store.replaceNoteTags(noteId, vault.id, vault.org_id, parsed.tags || [])

          // Chunk only the changed/new note (P1a) — incremental, mirrors the
          // content-hash skip above. Unchanged notes keep their existing chunks.
          const chunks = chunkNote({ noteId, title: parsed.title, body: parsed.body })
          store.replaceNoteChunks(noteId, vault.id, vault.org_id, chunks, parsed.title, { scope: vault.scope, owner_user_id: vault.owner_user_id, language })
        }
      })
      tx()

      if (typeof onBatchYield === 'function') onBatchYield(b)
      await yieldToEventLoop()
    }

    // Delete detection: any previously-indexed note whose file is gone. Needs
    // the FULL seenRelPaths set, so it runs once after all batches, in its own
    // short transaction (final DB state is identical to the old inline delete).
    const deleteTx = db.transaction(() => {
      for (const [relPath, row] of existingByRelPath) {
        if (!seenRelPaths.has(relPath)) {
          store.deleteNote(row.id)
          changedNoteIds.add(row.id)
        }
      }
    })
    deleteTx()

    // Pass 2: resolve links. The note index covers the FULL note set, but only
    // links that can have changed are re-resolved (068).
    const edgeCount = store.resolveVaultLinks(vault.id, { changedNoteIds })

    // Deploy-gap fix (P2b-1): Pass 1's content-hash skip means an unchanged
    // note is never re-chunked either, so a vault indexed before chunking
    // existed (or any note that otherwise ended up with zero chunk rows)
    // never gets chunks on a plain reindex — only a full content change
    // would trigger it. backfillChunks() is itself incremental
    // (getNotesMissingChunks is a no-op once every note has chunks), so it
    // is safe and cheap to call on every indexVault() pass, not just once.
    backfillChunks(vault.id)

    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE vault_id = ?').get(vault.id).c

    store.setVaultStatus(vault.id, 'ready', {
      note_count: noteCount,
      edge_count: edgeCount,
      last_indexed_at: new Date().toISOString(),
      error: null
    })

    return store.getVault(vault.org_id, vault.owner_user_id, vault.id)
  } catch (err) {
    store.setVaultStatus(vault.id, 'error', { error: err.message })
    throw err
  }
}

/**
 * Chunks any note that has zero chunk rows — the one-time backfill for
 * notes that were indexed before migrations/001-chunks.sql landed (e.g.
 * NodeBrain's 203 pre-existing notes). Incremental indexVault() runs never
 * need this (they chunk on every changed/new upsert); this exists purely to
 * catch up notes whose content_hash never changed since this feature shipped.
 *
 * Also backfills `occurred_at` from the note's existing `mtime` where it is
 * still null (pre-migration rows default to occurred_at = NULL).
 *
 * @param {string} [vault_id] - restrict to one vault; omit to backfill every org's notes
 * @returns {{notesChunked: number, chunksWritten: number}}
 */
export function backfillChunks(vault_id) {
  const notes = store.getNotesMissingChunks(vault_id)

  let chunksWritten = 0
  for (const note of notes) {
    if (!note.occurred_at && note.mtime) {
      store.setNoteProvenance(note.id, { occurred_at: note.mtime })
    }
    const chunks = chunkNote({ noteId: note.id, title: note.title, body: note.body })
    store.replaceNoteChunks(note.id, note.vault_id, note.org_id, chunks, note.title, { scope: note.scope, owner_user_id: note.owner_user_id, language: note.language })
    chunksWritten += chunks.length
  }

  return { notesChunked: notes.length, chunksWritten }
}

const MAX_DOCUMENTS_PER_CALL = 500

function mergeTags(parsed = [], supplied) {
  const out = [...parsed]
  const seen = new Set(out.map((t) => t.tag))
  for (const raw of Array.isArray(supplied) ? supplied : []) {
    const tag = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : ''
    if (!tag || seen.has(tag)) continue
    seen.add(tag); out.push({ tag, source: 'reader' })
  }
  return out
}
function mergeLinks(parsed = [], supplied) {
  const out = [...parsed]
  const seen = new Set(out.map((l) => `${l.type}\u0000${l.targetRaw}`))
  for (const l of Array.isArray(supplied) ? supplied : []) {
    if (!l || typeof l.targetRaw !== 'string' || !l.targetRaw.trim() || typeof l.type !== 'string') continue
    const k = `${l.type}\u0000${l.targetRaw}`
    if (seen.has(k)) continue
    seen.add(k); out.push({ targetRaw: l.targetRaw, type: l.type })
  }
  return out
}

function suppliedTagsLinksChanged(db, noteId, doc) {
  const tagsSupplied = Array.isArray(doc.tags)
  const hasLinks = Array.isArray(doc.links) && doc.links.length > 0
  if (!tagsSupplied && !hasLinks) return false
  if (tagsSupplied) {
    const rows = db.prepare('SELECT tag, source FROM note_tags WHERE note_id = ?').all(noteId)
    const have = new Set(rows.map((r) => r.tag))
    const supplied = new Set()
    for (const raw of doc.tags) { const t = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : ''; if (t) supplied.add(t) }
    // Added: a supplied tag the note does not carry yet.
    for (const t of supplied) if (!have.has(t)) return true
    // Removed (R04): a tag a reader previously supplied that is no longer supplied.
    for (const r of rows) if (r.source === 'reader' && !supplied.has(r.tag)) return true
  }
  if (hasLinks) {
    const have = new Set(db.prepare('SELECT link_type, target_raw FROM note_links WHERE source_note_id = ?').all(noteId).map((r) => `${r.link_type}\u0000${r.target_raw}`))
    for (const l of doc.links) if (l && typeof l.targetRaw === 'string' && l.targetRaw.trim() && !have.has(`${l.type}\u0000${l.targetRaw}`)) return true
  }
  return false
}

// Only fields the caller actually supplied are compared (absent = "no opinion").
function metadataChanged(existing, doc) {
  const differs = (supplied, current) => supplied !== undefined && supplied !== null && supplied !== (current ?? null)
  return differs(doc.title, existing.title) || differs(doc.language, existing.language) || differs(doc.kind, existing.kind) ||
    differs(doc.sourceType, existing.source_type) || differs(doc.occurredAt, existing.occurred_at) ||
    differs(doc.originStore, existing.origin_store) || differs(doc.originId, existing.origin_id) ||
    // R04: an explicit null originId CLEARS provenance (undefined stays "no opinion").
    (doc.originId === null && (existing.origin_id ?? null) !== null)
}

/**
 * Bulk push-ingest for non-filesystem sources (P2b-1, the foundation the
 * P2b readers call — chat DB, git commits, auth.db, etc). Unlike
 * indexVault() (which walks a real filesystem), documents arrive as
 * {relPath, content} pairs the caller already has in memory; relPath is
 * just a logical, vault-unique key (a chat turn id, a commit sha, ...), not
 * necessarily a real file path.
 *
 * Idempotent per document: a document whose raw content is byte-identical
 * (sha1) to the existing note at (vault_id, relPath) is skipped entirely —
 * safe for a reader to re-push the same window on every poll. A changed
 * relPath is re-parsed, re-chunked, and its links/tags replaced.
 *
 * Note body is stored as the RAW content (not parsed.body) — push sources
 * (chat transcripts, commit messages) generally have no frontmatter to
 * strip, and full fidelity matters more than the frontmatter-stripping
 * convention lib/ingest.js's own filesystem walk uses. parseNote() is still
 * run over the same content to extract title/links/tags (best-effort,
 * never throws — vaultParser.js degrades gracefully on non-markdown input).
 *
 * @param {{id:string, org_id:string, source_type?:string, language?:string|null}} vault
 * @param {Array<{relPath:string, content:string, title?:string, kind?:string, sourceType?:string, occurredAt?:string, language?:string}>} documents
 * @param {{deleteAbsent?: boolean}} [opts]
 * @returns {{added:number, updated:number, skipped:number, chunks:number}}
 */
export async function ingestDocuments(vault, documents, { deleteAbsent = false, deletions = null, batchSize = DEFAULT_BATCH_SIZE, onBatchYield = null } = {}) {
  if (!Array.isArray(documents)) {
    throw new Error('documents must be an array')
  }
  if (documents.length > MAX_DOCUMENTS_PER_CALL) {
    throw new Error(`documents exceeds the ${MAX_DOCUMENTS_PER_CALL}-per-call limit`)
  }

  const db = getDatabase()

  try {
    const existingRows = db.prepare('SELECT id, rel_path, content_hash, title, language, kind, source_type, occurred_at, origin_store, origin_id FROM notes WHERE vault_id = ?').all(vault.id)
    const existingByRelPath = new Map(existingRows.map((r) => [r.rel_path, r]))
    const seenRelPaths = new Set()
    const changedNoteIds = new Set() // 068

    let added = 0
    let updated = 0
    let skipped = 0
    let chunks = 0

    // Batched + yielded (BRAIN2-V2-2): each batch is ONE short transaction
    // (durable on commit), and the event loop is released between batches so a
    // large push can't freeze /health. The per-document parse/chunk/write logic
    // and the running counters are identical to the old single-transaction
    // pass — only the scheduling changed.
    const rejected = []
    const docIndex = new Map(documents.map((d, i) => [d, i]))
    const batches = batchArray(documents, batchSize)
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b]
      const tx = db.transaction(() => {
        for (const doc of batch) {
          const relPath = doc?.relPath
          // BRAIN2-W7 067: a malformed document is a per-document rejection in the
          // result, never a silent skip behind a successful batch response.
          if (!relPath || typeof relPath !== 'string') { rejected.push({ index: docIndex.get(doc) ?? -1, relPath: typeof relPath === 'string' ? relPath : null, reason: 'relPath_required' }); continue }
          if (typeof doc.content !== 'string') { seenRelPaths.add(relPath); rejected.push({ index: docIndex.get(doc), relPath, reason: 'content_must_be_string' }); continue }

          seenRelPaths.add(relPath)

          // Redacted here so every feed and capture path is covered, not just
          // the feeds that redact client-side (ONE-BRAIN CX1).
          const content = redactSecrets(typeof doc?.content === 'string' ? doc.content : '')
          const contentHash = sha1(content)
          const existing = existingByRelPath.get(relPath)

          // BRAIN2-W7 064: identical content only short-circuits when the
          // reader-supplied metadata is also unchanged; a corrected title,
          // language, kind, date or origin goes through the normal update path.
          if (existing && existing.content_hash === contentHash && !metadataChanged(existing, doc) && !suppliedTagsLinksChanged(db, existing.id, doc)) {
            skipped += 1
            continue // idempotent re-push — identical content already indexed
          }

          const parsed = parseNote({ relPath, content })
          const title = doc.title || parsed.title || firstNonEmptyLine(content) || relPath.split('/').pop()
          const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0

          // language (P2.5b-1, migrations/004-language.sql): per-DOCUMENT, not
          // per-vault — a push vault (chat DB, translation reader, etc) can
          // legitimately mix languages across documents in the same call, so
          // each doc's own `language` wins; falls back to the vault's own
          // `language` (if ever set) else NULL/unspecified.
          const language = doc.language || vault.language || null

          // origin_store/origin_id (ONE-BRAIN A1, migrations/009-origin-provenance.sql):
          // a push-ingest caller that knows this doc's canonical source row
          // (feedMemorySource.js's memories -> 'memory'+id,
          // feedWisdomSource.js's execution_wisdom -> 'wisdom'+id, or a
          // file-corpus reader's own stable key -> 'files'+relPath) passes
          // originStore/originId on the doc; absent entirely for callers that
          // don't know (left NULL, never guessed here).
          const noteId = store.upsertNote({
            vault_id: vault.id,
            org_id: vault.org_id,
            rel_path: relPath,
            title,
            frontmatter: JSON.stringify(parsed.frontmatter || {}),
            body: content,
            word_count: wordCount,
            mtime: null,
            content_hash: contentHash,
            source_type: doc.sourceType || vault.source_type,
            kind: doc.kind || 'note',
            occurred_at: doc.occurredAt || new Date().toISOString(),
            scope: vault.scope,
            owner_user_id: vault.owner_user_id,
            language,
            origin_store: doc.originStore || null,
            origin_id: doc.originId || null
          })

          changedNoteIds.add(noteId)
          // BRAIN2-W7 065: reader-supplied structured tags/links are merged with
          // (never replaced by) the markdown-derived ones.
          store.replaceNoteLinks(noteId, vault.id, vault.org_id, mergeLinks(parsed.links, doc.links))
          store.replaceNoteTags(noteId, vault.id, vault.org_id, mergeTags(parsed.tags, doc.tags))

          const noteChunks = chunkNote({ noteId, title, body: content })
          store.replaceNoteChunks(noteId, vault.id, vault.org_id, noteChunks, title, { scope: vault.scope, owner_user_id: vault.owner_user_id, language })
          chunks += noteChunks.length

          if (existing) updated += 1
          else added += 1
        }
      })
      tx()

      if (typeof onBatchYield === 'function') onBatchYield(b)
      await yieldToEventLoop()
    }

    // Full-resync support (optional, default off): remove notes this push
    // didn't mention. Only meaningful for a caller doing a complete snapshot
    // resync, not incremental append/upsert polling. Needs the FULL
    // seenRelPaths set, so it runs once after all batches, in its own short
    // transaction (final DB state is identical to the old inline delete).
    if (deleteAbsent) {
      const deleteTx = db.transaction(() => {
        for (const [relPath, row] of existingByRelPath) {
          if (!seenRelPaths.has(relPath)) {
            store.deleteNote(row.id)
            changedNoteIds.add(row.id)
          }
        }
      })
      deleteTx()
    }

    // Explicit tombstones (BRAIN2-W2 4): the caller names exact rel_paths that
    // disappeared at the source (after a COMPLETE walk). Scoped to this vault;
    // a path also present in this call's documents is never deleted.
    let deleted = 0
    if (Array.isArray(deletions) && deletions.length > 0) {
      const delTx = db.transaction(() => {
        for (const relPath of deletions) {
          if (typeof relPath !== 'string' || seenRelPaths.has(relPath)) continue
          const row = existingByRelPath.get(relPath)
          if (row) { store.deleteNote(row.id); changedNoteIds.add(row.id); deleted += 1 }
        }
      })
      delTx()
    }

    // Link resolution needs the FULL note set (a doc may link to another doc
    // pushed in this same batch) — run after the transaction commits, same
    // Pass 1/Pass 2 split indexVault() uses.
    const edgeCount = store.resolveVaultLinks(vault.id, { changedNoteIds })
    const noteCount = db.prepare('SELECT COUNT(*) AS c FROM notes WHERE vault_id = ?').get(vault.id).c
    store.setVaultStatus(vault.id, 'ready', {
      note_count: noteCount,
      edge_count: edgeCount,
      last_indexed_at: new Date().toISOString(),
      error: null
    })

    const base = Array.isArray(deletions) ? { added, updated, skipped, chunks, deleted } : { added, updated, skipped, chunks }
    return rejected.length ? { ...base, rejected } : base
  } catch (err) {
    store.setVaultStatus(vault.id, 'error', { error: err.message })
    throw err
  }
}

export default { indexVault, backfillChunks, ingestDocuments }

export { suppliedTagsLinksChanged, metadataChanged }
