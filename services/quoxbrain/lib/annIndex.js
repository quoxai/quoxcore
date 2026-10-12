// annIndex.js: qdrant ANN index for the dense leg (BRAIN2-V3 B1).
//
// Replaces the brute-force packed scan (denseLoader.js) when
// QUOXBRAIN_ANN=qdrant. One qdrant collection per embedding model (vectors of
// different models are mutually incomparable). SQLite stays the source of
// truth: every point can be rebuilt from chunk_embeddings, and visibility is
// enforced twice (qdrant filter here, scope-checked hydration downstream).
//
// Failure model: any qdrant failure makes callers fall back to the packed
// scan. A failed search opens a short cooldown so a dead qdrant costs one
// timeout, not one per query. State is visible via denseBackendStatus()
// (/brain/status `dense_backend`).

import { createHash } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 2500
const COOLDOWN_MS = 30_000
const PAYLOAD_KEYS = ['org_id', 'scope', 'owner_user_id', 'vault_id', 'kind', 'source_type']

export function annEnabled() {
  return process.env.QUOXBRAIN_ANN === 'qdrant'
}

export class AnnError extends Error {
  constructor(message, { status = null, network = false } = {}) {
    super(message)
    this.name = 'AnnError'
    this.status = status
    this.network = network
  }
}

/** Minimal qdrant REST client. fetchFn is injectable for tests. */
export function createQdrantClient({ url, apiKey, fetchFn = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(url || '').replace(/\/+$/, '')
  async function request(method, path, body) {
    if (!base) throw new AnnError('QDRANT_URL not configured', { network: true })
    let res
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      throw new AnnError(`qdrant unreachable: ${err.message}`, { network: true })
    }
    if (!res.ok) {
      let detail = ''
      try { detail = JSON.stringify((await res.json())?.status?.error ?? '') } catch { /* body unreadable */ }
      throw new AnnError(`qdrant ${method} ${path} -> ${res.status} ${detail}`, { status: res.status, network: res.status >= 500 || [401, 403, 408, 429].includes(res.status) })
    }
    return res.json()
  }
  return { request }
}

let client = null
const state = { lastError: null, lastErrorAt: null, lastOkAt: null, fallbacks: 0, cooldownUntil: 0 }
const knownCollections = new Set()
let collectionsListedAt = 0

function getClient() {
  if (!client) client = createQdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY })
  return client
}

/** Test hook: inject a client (or null to reset) and clear all module state. */
export function _setAnnClient(c) {
  client = c
  knownCollections.clear()
  collectionsListedAt = 0
  Object.assign(state, { lastError: null, lastErrorAt: null, lastOkAt: null, fallbacks: 0, cooldownUntil: 0 })
}

export function collectionName(model) {
  return `quoxbrain_${String(model).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)}`
}

/** Deterministic qdrant point id (UUID-shaped) for a chunk id. */
export function pointId(chunkId) {
  const h = createHash('sha1').update(String(chunkId)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export function inCooldown() {
  return Date.now() < state.cooldownUntil
}

export function noteFailure(err, where = 'search') {
  state.lastError = `${where}: ${err.message}`
  state.lastErrorAt = new Date().toISOString()
  if (where === 'search') {
    state.fallbacks += 1
    state.cooldownUntil = Date.now() + COOLDOWN_MS
  }
  console.error(`[Brain][ANN] qdrant ${where} FAILED, dense leg falling back to packed scan (cooldown ${COOLDOWN_MS / 1000}s): ${err.message}`)
}

function noteOk() {
  state.lastOkAt = new Date().toISOString()
}

/** Value for /brain/status `dense_backend`. */
export function denseBackendStatus() {
  if (!annEnabled()) return { dense_backend: 'packed_scan' }
  const degraded = inCooldown()
  return {
    dense_backend: degraded ? 'packed_scan' : 'qdrant',
    dense_backend_detail: {
      configured: 'qdrant',
      degraded,
      fallbacks: state.fallbacks,
      last_error: state.lastError,
      last_error_at: state.lastErrorAt,
      last_ok_at: state.lastOkAt
    }
  }
}

async function listCollections(force = false) {
  if (!force && collectionsListedAt && Date.now() - collectionsListedAt < 60_000) return knownCollections
  const out = await getClient().request('GET', '/collections')
  knownCollections.clear()
  for (const c of out?.result?.collections || []) knownCollections.add(c.name)
  collectionsListedAt = Date.now()
  return knownCollections
}

async function ensureCollection(model, dim) {
  const name = collectionName(model)
  if (knownCollections.has(name)) return name
  await listCollections(true)
  if (!knownCollections.has(name)) {
    await getClient().request('PUT', `/collections/${name}`, { vectors: { size: dim, distance: 'Cosine' } })
    for (const key of ['chunk_id', ...PAYLOAD_KEYS]) {
      await getClient().request('PUT', `/collections/${name}/index`, { field_name: key, field_schema: 'keyword' })
    }
    knownCollections.add(name)
  }
  return name
}

/**
 * Upserts rows { chunkId, model, vector:number[]|Float32Array, payload }
 * grouped by model. Throws AnnError on failure (callers decide retry policy).
 */
export async function upsertPoints(rows) {
  const byModel = new Map()
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, [])
    byModel.get(r.model).push(r)
  }
  for (const [model, group] of byModel) {
    const name = await ensureCollection(model, group[0].vector.length)
    await getClient().request('PUT', `/collections/${name}/points?wait=true`, {
      points: group.map((r) => ({ id: pointId(r.chunkId), vector: Array.from(r.vector), payload: { chunk_id: r.chunkId, ...r.payload } }))
    })
    // A chunk re-embedded under another model leaves a stale point in the
    // old model's collection; ids are deterministic so drop it everywhere else.
    const others = [...knownCollections].filter((c) => c.startsWith('quoxbrain_') && c !== name)
    for (const other of others) {
      await getClient().request('POST', `/collections/${other}/points/delete?wait=true`, { points: group.map((r) => pointId(r.chunkId)) })
    }
  }
  noteOk()
}

/** Deletes chunk points from every quoxbrain collection. Throws on failure. */
export async function deleteChunks(chunkIds) {
  if (!chunkIds || chunkIds.length === 0) return
  const cols = [...(await listCollections())].filter((c) => c.startsWith('quoxbrain_'))
  for (const name of cols) {
    await getClient().request('POST', `/collections/${name}/points/delete?wait=true`, { points: chunkIds.map(pointId) })
  }
  noteOk()
}

const OUTBOX_DRAIN_BATCH = 200

/**
 * Durable delete (astra2 087). With a db handle the ids are written to
 * ann_delete_outbox BEFORE the qdrant call and removed only once it succeeds,
 * so an outage leaves a retry record instead of an orphaned vector. Without a
 * db handle it is the old fire-and-forget. Failures are loud, never fatal.
 * Returns the in-flight promise (callers may ignore it).
 */
export function deleteChunksBestEffort(chunkIds, db = null) {
  if (!annEnabled() || !chunkIds || chunkIds.length === 0) return Promise.resolve()
  let queued = false
  if (db) {
    try {
      const ts = new Date().toISOString()
      const ins = db.prepare('INSERT OR IGNORE INTO ann_delete_outbox (chunk_id, queued_at) VALUES (?, ?)')
      db.transaction((ids) => { for (const id of ids) ins.run(id, ts) })(chunkIds)
      queued = true
    } catch (err) {
      console.error(`[Brain][ANN] could not queue durable delete for ${chunkIds.length} chunk(s): ${err.message}`)
    }
  }
  return deleteChunks(chunkIds).then(() => {
    if (queued) clearOutbox(db, chunkIds)
  }).catch((err) => {
    noteFailure(err, 'delete')
    if (queued) markOutboxAttempt(db, chunkIds, err.message)
  })
}

function clearOutbox(db, ids) {
  try {
    const del = db.prepare('DELETE FROM ann_delete_outbox WHERE chunk_id = ?')
    db.transaction((xs) => { for (const id of xs) del.run(id) })(ids)
  } catch (err) { console.error(`[Brain][ANN] outbox clear failed: ${err.message}`) }
}

function markOutboxAttempt(db, ids, message) {
  try {
    const upd = db.prepare('UPDATE ann_delete_outbox SET attempts = attempts + 1, last_error = ? WHERE chunk_id = ?')
    db.transaction((xs) => { for (const id of xs) upd.run(String(message).slice(0, 300), id) })(ids)
  } catch (err) { console.error(`[Brain][ANN] outbox attempt mark failed: ${err.message}`) }
}

/** Retries queued deletes. Returns { drained, pending, error }. */
export async function drainDeleteOutbox(db, { batch = OUTBOX_DRAIN_BATCH } = {}) {
  const out = { drained: 0, pending: 0, error: null }
  if (!annEnabled()) return out
  const rows = db.prepare('SELECT chunk_id FROM ann_delete_outbox ORDER BY queued_at LIMIT ?').all(batch)
  if (rows.length === 0) return out
  const queuedIds = rows.map((r) => r.chunk_id)
  // Chunk ids are deterministic (note + heading + ordinal): an edit deletes and
  // re-creates the same id. If the chunk exists again, its point is wanted and
  // the re-embed upsert overwrites the stale vector, so just drop the queue row.
  const live = new Set()
  for (let i = 0; i < queuedIds.length; i += 500) {
    const part = queuedIds.slice(i, i + 500)
    for (const r of db.prepare(`SELECT id FROM note_chunks WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) live.add(r.id)
  }
  if (live.size > 0) clearOutbox(db, [...live])
  const ids = queuedIds.filter((id) => !live.has(id))
  if (ids.length === 0) { out.pending = db.prepare('SELECT COUNT(*) AS c FROM ann_delete_outbox').get().c; return out }
  try {
    await deleteChunks(ids)
    clearOutbox(db, ids)
    out.drained = ids.length
  } catch (err) {
    noteFailure(err, 'delete')
    markOutboxAttempt(db, ids, err.message)
    out.error = err.message
  }
  out.pending = db.prepare('SELECT COUNT(*) AS c FROM ann_delete_outbox').get().c
  return out
}

/** Whether qdrant has a collection for this model (throws AnnError if qdrant fails). */
export async function hasCollection(model) {
  return (await listCollections()).has(collectionName(model))
}

function matchAny(key, values) {
  return { key, match: { any: values } }
}

/** Builds the qdrant filter: the scopeClause visibility union plus facets. */
export function buildFilter({ orgId, userId = null, scope = null, vaultIds, kinds, sourceTypes, scopes } = {}) {
  const visibility = [
    { must: [{ key: 'scope', match: { value: 'org' } }, { key: 'org_id', match: { value: orgId } }] },
    { key: 'scope', match: { value: 'shared' } }
  ]
  if (userId) visibility.push({ must: [{ key: 'scope', match: { value: 'user' } }, { key: 'owner_user_id', match: { value: userId } }] })
  const must = [{ should: visibility }]
  if (scope) must.push({ key: 'scope', match: { value: scope } })
  if (Array.isArray(vaultIds) && vaultIds.length) must.push(matchAny('vault_id', vaultIds))
  if (Array.isArray(kinds) && kinds.length) must.push(matchAny('kind', kinds))
  if (Array.isArray(sourceTypes) && sourceTypes.length) must.push(matchAny('source_type', sourceTypes))
  if (Array.isArray(scopes) && scopes.length) must.push(matchAny('scope', scopes))
  return { must }
}

/**
 * ANN search. Returns [{chunkId, score}] ranked desc (cosine). A model with no
 * collection yields []. Throws AnnError when qdrant fails.
 */
export async function search({ model, vector, limit = 30, ...filterOpts }) {
  const name = collectionName(model)
  const cols = await listCollections()
  if (!cols.has(name)) { noteOk(); return [] }
  const out = await getClient().request('POST', `/collections/${name}/points/search`, {
    vector: Array.from(vector),
    limit,
    filter: buildFilter(filterOpts),
    with_payload: ['chunk_id'],
    params: { hnsw_ef: Math.max(128, limit * 2) }
  })
  noteOk()
  return (out?.result || []).map((p) => ({ chunkId: p.payload?.chunk_id, score: p.score })).filter((p) => p.chunkId)
}

const ROW_SQL = `
  SELECT ce.rowid AS rid, ce.chunk_id AS chunkId, ce.model AS model, ce.vector AS vector,
         nc.org_id AS org_id, nc.scope AS scope, nc.owner_user_id AS owner_user_id, nc.vault_id AS vault_id,
         n.kind AS kind, n.source_type AS source_type
  FROM chunk_embeddings ce
  JOIN note_chunks nc ON nc.id = ce.chunk_id
  JOIN notes n ON n.id = nc.note_id`

function toPoint(r) {
  const buf = r.vector
  const vector = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const payload = {}
  for (const k of PAYLOAD_KEYS) payload[k] = r[k] ?? ''
  return { chunkId: r.chunkId, model: r.model, vector, payload }
}

/**
 * Live write hook: syncs just-written chunk_embeddings rows. Never throws; a
 * failure rewinds the backfill cursor so the job re-syncs these rows.
 */
export async function syncChunks(db, chunkIds) {
  if (!annEnabled() || !chunkIds || chunkIds.length === 0) return { synced: 0, failed: 0 }
  try {
    const ph = chunkIds.map(() => '?').join(',')
    const rows = db.prepare(`${ROW_SQL} WHERE ce.chunk_id IN (${ph}) AND ce.vector IS NOT NULL`).all(...chunkIds)
    if (rows.length > 0) await upsertPoints(rows.map(toPoint))
    return { synced: rows.length, failed: 0 }
  } catch (err) {
    noteFailure(err, 'upsert')
    try {
      const ph = chunkIds.map(() => '?').join(',')
      const min = db.prepare(`SELECT MIN(rowid) AS m FROM chunk_embeddings WHERE chunk_id IN (${ph})`).get(...chunkIds)?.m
      if (min) db.prepare('UPDATE ann_sync_state SET last_rowid = MIN(last_rowid, ?) WHERE id = 1').run(min - 1)
    } catch (e2) {
      console.error(`[Brain][ANN] could not rewind backfill cursor after failed upsert: ${e2.message}`)
    }
    return { synced: 0, failed: chunkIds.length }
  }
}

/**
 * One backfill tick: syncs chunk_embeddings past the durable cursor in
 * batches, yielding between batches. Resumable (cursor persisted per batch).
 * Failure accounting is distinct from emptiness:
 *   - synced: rows written to qdrant
 *   - failed: rows in batches that failed this tick (cursor NOT advanced for
 *     network/server errors, so they are retried next tick)
 *   - retired: rows qdrant permanently rejected (4xx, e.g. dim mismatch),
 *     recorded in ann_sync_retired and skipped forever
 *   - done: no rows left past the cursor
 */
export async function backfillTick(db, { batchSize = 500, maxBatches = 20, yieldFn = () => new Promise((r) => setImmediate(r)) } = {}) {
  const out = { synced: 0, failed: 0, retired: 0, done: false, error: null }
  // Apply queued vector deletes first (087); a failure here is reported but
  // does not block syncing new rows.
  const drained = await drainDeleteOutbox(db)
  if (drained.error) out.error = drained.error
  const upd = db.prepare('UPDATE ann_sync_state SET last_rowid = ?, synced = synced + ?, failed = failed + ?, updated_at = ? WHERE id = 1')
  const retire = db.prepare('INSERT OR REPLACE INTO ann_sync_retired (chunk_id, error, retired_at) VALUES (?, ?, ?)')
  for (let b = 0; b < maxBatches; b++) {
    const cursor = db.prepare('SELECT last_rowid FROM ann_sync_state WHERE id = 1').get().last_rowid
    const rows = db.prepare(`${ROW_SQL} WHERE ce.rowid > ? AND ce.vector IS NOT NULL ORDER BY ce.rowid LIMIT ?`).all(cursor, batchSize)
    if (rows.length === 0) {
      // Rows with NULL vectors (retired sentinels) sit past the cursor forever
      // otherwise; nothing to sync means done.
      out.done = true
      return out
    }
    const maxRid = rows[rows.length - 1].rid
    try {
      await upsertPoints(rows.map(toPoint))
      upd.run(maxRid, rows.length, 0, new Date().toISOString())
      out.synced += rows.length
    } catch (err) {
      if (err.network) {
        out.failed += rows.length
        out.error = err.message
        noteFailure(err, 'backfill')
        return out
      }
      // Permanent rejection of the batch: isolate per row, retire bad rows.
      let okRows = 0
      for (const r of rows) {
        try {
          await upsertPoints([toPoint(r)])
          okRows++
        } catch (e2) {
          if (e2.network) { out.failed += rows.length - okRows; out.error = e2.message; noteFailure(e2, 'backfill'); return out }
          retire.run(r.chunkId, e2.message.slice(0, 300), new Date().toISOString())
          out.retired++
        }
      }
      upd.run(maxRid, okRows, out.retired, new Date().toISOString())
      out.synced += okRows
    }
    await yieldFn()
  }
  return out
}

export function backfillProgress(db) {
  const s = db.prepare('SELECT last_rowid, synced, failed, updated_at FROM ann_sync_state WHERE id = 1').get()
  const total = db.prepare('SELECT COUNT(*) AS c FROM chunk_embeddings WHERE vector IS NOT NULL').get().c
  const retired = db.prepare('SELECT COUNT(*) AS c FROM ann_sync_retired').get().c
  return { ...s, total_embeddings: total, retired }
}

/**
 * BRAIN2-W7 C 088: how many SQLite embeddings the ANN backfill cursor has not
 * yet pushed to the vector index. 0 when ANN is off (nothing to be incomplete).
 */
export function annSyncPending(db) {
  if (!annEnabled()) return 0
  const s = db.prepare('SELECT last_rowid FROM ann_sync_state WHERE id = 1').get()
  return db.prepare('SELECT COUNT(*) AS c FROM chunk_embeddings WHERE vector IS NOT NULL AND rowid > ?').get(s?.last_rowid ?? 0).c
}
