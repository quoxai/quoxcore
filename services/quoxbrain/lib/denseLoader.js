// denseLoader.js: pure dense-vector loading (id selection, blob fetch,
// normalise, pack). Takes an open better-sqlite3 handle so the SAME code runs
// in-process (sync fallback) and inside the denseLoadWorker thread, which
// opens its own read-only connection so the multi-second tier SELECTs never
// block the main event loop (BRAIN2-AUDIT 2026-10-05).

const DENSE_BLOB_BATCH = 1000
const DENSE_CROSS_ORG_USER_CAP = 10_000

/** Decodes a chunk_embeddings.vector BLOB (better-sqlite3 gives back a
 * Node Buffer) into the Float32Array it was encoded from
 * (lib/embeddingBackfill.js: `Buffer.from(new Float32Array(vec).buffer)`). */
export function decodeVectorBlob(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

/** Unit-length copy (never mutates the source buffer). A zero vector stays
 * zero, so its dot product is 0, matching the old zero-norm guard. */
export function normalizeVector(v) {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const out = new Float32Array(v.length)
  if (sum === 0) return out
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

function selectDenseIds(db, org_id, model, cfg) {
  const conditions = [`((nc.scope IN ('org','user') AND nc.org_id = ?) OR nc.scope = 'shared')`, 'ce.vector IS NOT NULL']
  const params = [org_id]
  // Embedding-space filter: vectors from different models are mutually
  // incomparable (cosine across the OpenAI/Gemini split is noise, the
  // 2026-08-25 incident) so a caller that knows its query vector's model
  // scans only that space.
  if (model) {
    conditions.push('ce.model = ?')
    params.push(model)
  }
  const where = conditions.join(' AND ')

  const low = cfg.low
  const lowPh = low.map(() => '?').join(',')
  const tierSql = (extra) => `
    SELECT ce.chunk_id AS chunkId, nc.scope AS scope, nc.owner_user_id AS ownerUserId
    FROM chunk_embeddings ce
    JOIN note_chunks nc ON nc.id = ce.chunk_id
    JOIN notes n ON n.id = nc.note_id
    WHERE ${where}${extra}
    ORDER BY ce.updated_at DESC
    LIMIT ?`

  const cap = cfg.cap
  let truncated = false
  let lowRows = []
  if (low.length > 0) {
    const lowCap = Math.min(cfg.lowCap, cap)
    if (lowCap > 0) {
      lowRows = db.prepare(tierSql(` AND n.source_type IN (${lowPh})`)).all(...params, ...low, lowCap)
      if (lowRows.length === lowCap) {
        truncated = true
        console.warn(`[Brain] dense low-signal tier truncated at ${lowCap} rows for org ${org_id} (sources: ${low.join(',')}); older machine-exhaust embeddings are invisible to dense search (QUOXBRAIN_DENSE_LOW_SIGNAL_CAP)`)
      }
    }
  }
  const curatedCap = cap - lowRows.length
  let curatedRows = []
  if (curatedCap > 0) {
    const extra = low.length > 0 ? ` AND n.source_type NOT IN (${lowPh})` : ''
    curatedRows = db.prepare(tierSql(extra)).all(...params, ...low, curatedCap)
    if (curatedRows.length === curatedCap) {
      truncated = true
      console.warn(`[Brain] dense curated tier truncated at ${curatedCap} rows (overall cap ${cap}) for org ${org_id}; older curated embeddings are invisible to dense search (raise QUOXBRAIN_DENSE_SCAN_CAP or move to ANN)`)
    }
  }

  // 072: user-scope rows follow the OWNER across orgs (vaultStore.scopeClause
  // keys them off owner_user_id, not org_id). They load in their OWN capped
  // tier so they cannot displace this org's rows; cross-user isolation is
  // enforced at score time (scoreTopK skips user rows whose owner is not the
  // caller).
  const crossWhere = ['nc.scope = ?', 'nc.org_id != ?', 'ce.vector IS NOT NULL'].concat(model ? ['ce.model = ?'] : [])
  const crossParams = ['user', org_id].concat(model ? [model] : [])
  const crossCap = DENSE_CROSS_ORG_USER_CAP
  const crossRows = db.prepare(`
    SELECT ce.chunk_id AS chunkId, nc.scope AS scope, nc.owner_user_id AS ownerUserId
    FROM chunk_embeddings ce
    JOIN note_chunks nc ON nc.id = ce.chunk_id
    WHERE ${crossWhere.join(' AND ')}
    ORDER BY ce.updated_at DESC
    LIMIT ?`).all(...crossParams, crossCap)
  if (crossRows.length === crossCap) truncated = true
  return { rows: [...curatedRows, ...lowRows, ...crossRows], truncated }
}

function fetchDenseBatch(db, rows, model) {
  const ph = rows.map(() => '?').join(',')
  const modelSql = model ? ' AND model = ?' : ''
  const params = rows.map((r) => r.chunkId)
  if (model) params.push(model)
  const blobs = new Map(
    db.prepare(`SELECT chunk_id AS chunkId, vector FROM chunk_embeddings WHERE chunk_id IN (${ph})${modelSql}`)
      .all(...params).map((b) => [b.chunkId, b.vector])
  )
  const out = []
  for (const r of rows) {
    const blob = blobs.get(r.chunkId)
    if (!blob) continue // row vanished between phases (deleted/re-embedded)
    out.push({ chunkId: r.chunkId, scope: r.scope, ownerUserId: r.ownerUserId, vec: normalizeVector(decodeVectorBlob(blob)) })
  }
  return out
}

/**
 * Packs row objects into ONE contiguous Float32Array (n * stride) plus
 * parallel arrays. A tight scoring loop over a flat matrix with no per-row
 * allocation is ~10x faster than iterating 60k objects (BRAIN2-AUDIT
 * 2026-10-05: dense leg 430ms). stride is the widest vector; shorter rows
 * are zero padded, so a dot product over stride equals the old
 * min(length) dot. `length` keeps the old array-like contract
 * (warmDenseCache counts it).
 */
export function packDenseRows(rows) {
  let stride = 0
  for (const r of rows) if (r.vec.length > stride) stride = r.vec.length
  const n = rows.length
  const mat = new Float32Array(n * stride)
  const chunkIds = new Array(n)
  const ownerUserIds = new Array(n)
  const scopeTable = []
  const scopeIdx = new Map()
  const scopeCodes = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    mat.set(r.vec, i * stride)
    chunkIds[i] = r.chunkId
    ownerUserIds[i] = r.ownerUserId
    let c = scopeIdx.get(r.scope)
    if (c === undefined) { c = scopeTable.length; scopeTable.push(r.scope); scopeIdx.set(r.scope, c) }
    scopeCodes[i] = c
  }
  return { length: n, stride, mat, chunkIds, ownerUserIds, scopeTable, scopeIdx, scopeCodes, userCode: scopeIdx.has('user') ? scopeIdx.get('user') : -1 }
}


/** Full load: ids by tier, blobs by batch, normalised and packed. */
export function loadDensePacked(db, org_id, model, cfg) {
  const { rows: ids, truncated } = selectDenseIds(db, org_id, model, cfg)
  const out = []
  for (let i = 0; i < ids.length; i += DENSE_BLOB_BATCH) {
    for (const v of fetchDenseBatch(db, ids.slice(i, i + DENSE_BLOB_BATCH), model)) out.push(v)
  }
  // 074: older vectors beyond the tier caps are invisible to dense search;
  // carried on the packed set so callers can say so instead of only logging.
  const packed = packDenseRows(out)
  packed.truncated = truncated
  return packed
}

// ---------------------------------------------------------------------------
// Uncapped tail scan (BRAIN2-W13 B). The packed cache is a speed window capped
// at DENSE_SCAN_CAP rows; it must never define coverage. When the cache was
// truncated, the vectors outside it are streamed from SQLite in bounded
// keyset pages (ids first, then blobs only for ids the cache does not hold),
// so memory is one page at a time and the caller keeps a top-k heap.
// ---------------------------------------------------------------------------

function tailWhere(org_id, model, { scope, ownerUserId }) {
  // Same visibility as selectDenseIds, with the caller's scope and cross-org
  // user-row ownership pushed down so unrelated rows are never read.
  const cond = [`((nc.scope IN ('org','user') AND nc.org_id = ?) OR nc.scope = 'shared' OR (nc.scope = 'user' AND nc.org_id != ? AND nc.owner_user_id = ?))`, 'ce.vector IS NOT NULL']
  const params = [org_id, org_id, ownerUserId ?? null]
  if (model) { cond.push('ce.model = ?'); params.push(model) }
  if (scope) { cond.push('nc.scope = ?'); params.push(scope) }
  // user-scope rows of this org owned by someone else are skipped at score time
  // anyway; skip them in SQL too.
  cond.push(`(nc.scope != 'user' OR nc.owner_user_id = ?)`)
  params.push(ownerUserId ?? null)
  return { where: cond.join(' AND '), params }
}

/** Number of rows visible to this query (cheap, no blobs). */
export function countDenseEligible(db, org_id, model, opts) {
  const { where, params } = tailWhere(org_id, model, opts)
  return db.prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings ce JOIN note_chunks nc ON nc.id = ce.chunk_id WHERE ${where}`).get(...params).n
}

/**
 * Generator of packed pages of eligible vectors NOT in `skipIds`, newest
 * first. Each yield is { page: packed|null, examined } where examined counts
 * every eligible row the cursor passed (including skipped ones), so the caller
 * can budget between pages.
 */
/** The tail page statements (exported for the query-plan guard test). The
 * CROSS JOIN pins chunk_embeddings as the outer loop, read in index order, so
 * a page stops after `LIMIT` rows instead of sorting the whole visible set. */
export function tailPageSql(org_id, model, { scope, ownerUserId }) {
  const { where, params } = tailWhere(org_id, model, { scope, ownerUserId })
  const head = `SELECT ce.chunk_id AS chunkId, ce.updated_at AS updatedAt, nc.scope AS scope, nc.owner_user_id AS ownerUserId
    FROM chunk_embeddings ce INDEXED BY idx_chunk_embeddings_updated CROSS JOIN note_chunks nc ON nc.id = ce.chunk_id`
  const order = 'ORDER BY ce.updated_at DESC, ce.chunk_id DESC LIMIT ?'
  return {
    first: `${head} WHERE ${where} ${order}`,
    next: `${head} WHERE ${where} AND (ce.updated_at < ? OR (ce.updated_at = ? AND ce.chunk_id < ?)) ${order}`,
    params,
  }
}

export function* denseTailPages(db, org_id, model, { scope, ownerUserId, skipIds, pageSize }) {
  const { first, next, params } = tailPageSql(org_id, model, { scope, ownerUserId })
  const stmtFirst = db.prepare(first)
  const stmtNext = db.prepare(next)
  let cursor = null
  for (;;) {
    const rows = cursor ? stmtNext.all(...params, cursor.updatedAt, cursor.updatedAt, cursor.chunkId, pageSize) : stmtFirst.all(...params, pageSize)
    if (rows.length === 0) return
    const last = rows[rows.length - 1]
    cursor = { updatedAt: last.updatedAt, chunkId: last.chunkId }
    const need = rows.filter((r) => !skipIds.has(r.chunkId))
    const vecs = []
    for (let i = 0; i < need.length; i += DENSE_BLOB_BATCH) for (const v of fetchDenseBatch(db, need.slice(i, i + DENSE_BLOB_BATCH), model)) vecs.push(v)
    yield { page: vecs.length ? packDenseRows(vecs) : null, examined: rows.length, scannedRows: vecs.length, last: rows.length < pageSize }
    if (rows.length < pageSize) return
  }
}
