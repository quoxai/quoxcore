// retrievalEval.mjs — BRAIN2-SEMANTIC retrieval eval harness.
//
// Measures, per ground-truth pair in eval/pairs.json, where the expected
// note ranks under four retrieval legs:
//
//   fts     — store.searchChunks (BM25/FTS5, what /brain/search serves today)
//   dense   — query embedding + store.denseSearchChunks (cosine over
//             chunk_embeddings, subject to DENSE_RAW_SCAN_CAP)
//   hybrid  — RRF fusion of the two rankings above (contextAssembler's
//             reciprocalRankFusion, k=60 — what /brain/context attempts)
//   served  — POST /brain/search on the live service (proves what the
//             deployed endpoint actually returns, vs the lib-level legs)
//
// Reports rank of expected note per pair per leg, plus recall@5, recall@10
// and MRR per leg. The number this exists to produce: FTS-only vs hybrid,
// side by side, on the real corpus (stream design: eval FIRST as the flip
// gate for any retrieval change).
//
// RUNS INSIDE the quox-brain container (imports /app/lib directly, reads
// the live DB read-only, calls the live collector for query embeddings):
//
//   docker cp services/quoxbrain/eval quox-brain:/tmp/brain-eval
//   docker exec quox-brain node /tmp/brain-eval/retrievalEval.mjs
//
// Read-only throughout: no writes to the DB, no usage events (lib calls
// bypass the HTTP layer; the one HTTP call per pair does record a usage
// event, same as any real search).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = '/app/lib'
const { default: Database } = await import('/app/node_modules/better-sqlite3/lib/index.js')
// vaultStore reads through lib/db.js's singleton — initialize it against the
// live DB (WAL, already-applied migrations are a no-op; same file the running
// service holds, safe for these read-only queries).
const { initDatabase } = await import(join(LIB, 'db.js'))
initDatabase(process.env.DB_PATH || '/var/lib/quox/quoxbrain.db')
const store = await import(join(LIB, 'vaultStore.js'))
const { embedTextsDetailed } = await import(join(LIB, 'embeddingClient.js'))
const { reciprocalRankFusion } = await import(join(LIB, 'contextAssembler.js'))

const here = dirname(fileURLToPath(import.meta.url))
const { org_id: ORG, user_id: USER = null, pairs } = JSON.parse(readFileSync(join(here, 'pairs.json'), 'utf8'))
const LIMIT = 30
const BRAIN_URL = process.env.BRAIN_URL || 'http://localhost:3106'
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

const db = new Database(process.env.DB_PATH || '/var/lib/quox/quoxbrain.db', { readonly: true })
const chunkNoteStmt = db.prepare('SELECT note_id FROM note_chunks WHERE id = ?')
const noteByTitle = db.prepare('SELECT id FROM notes WHERE org_id = ? AND title = ?')

function chunkToNote(chunkId) {
  return chunkNoteStmt.get(chunkId)?.note_id || null
}

/** Rank (1-based) of the first chunk belonging to expectedNoteId in a
 * best-first list of {chunkId} or {noteId} rows; null if absent. */
function rankOf(rows, expectedNoteId) {
  for (let i = 0; i < rows.length; i++) {
    const noteId = rows[i].noteId || chunkToNote(rows[i].chunkId)
    if (noteId === expectedNoteId) return i + 1
  }
  return null
}

async function servedSearch(query) {
  try {
    const res = await fetch(`${BRAIN_URL}/brain/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': SERVICE_KEY,
        'X-Org-Id': ORG,
        ...(USER ? { 'X-User-Id': USER } : {}),
      },
      body: JSON.stringify({ query, limit: LIMIT }),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const body = await res.json()
    return { rows: body.results || [] }
  } catch (err) {
    return { error: err.message }
  }
}

const legs = ['fts', 'dense', 'hybrid', 'served']
const results = []

for (const { query, expectedTitle } of pairs) {
  const note = noteByTitle.get(ORG, expectedTitle)
  if (!note) {
    results.push({ query, expectedTitle, missing: true })
    continue
  }
  const expected = note.id

  const ftsRows = store.searchChunks(ORG, USER, { query, limit: LIMIT })

  let denseRows = []
  let embedError = null
  // One retry — a transient collector connection blip shouldn't cost a pair
  // its dense leg (observed as sporadic 'fetch failed' under load).
  let { vectors, models } = await embedTextsDetailed([query], { orgId: ORG })
  if (!Array.isArray(vectors?.[0]) || vectors[0].length === 0) {
    await new Promise((r) => setTimeout(r, 1500))
    ;({ vectors, models } = await embedTextsDetailed([query], { orgId: ORG }))
  }
  const queryVector = vectors?.[0]
  if (Array.isArray(queryVector) && queryVector.length > 0) {
    denseRows = store.denseSearchChunks(ORG, queryVector, { limit: LIMIT, ownerUserId: USER, model: models?.[0] || null })
  } else {
    embedError = 'no query vector from /internal/embed'
  }

  const fused = reciprocalRankFusion([
    ftsRows.map((r) => r.chunkId),
    denseRows.map((r) => r.chunkId),
  ]).slice(0, LIMIT)

  const served = await servedSearch(query)

  results.push({
    query,
    expectedTitle,
    embedError,
    servedError: served.error || null,
    ranks: {
      fts: rankOf(ftsRows, expected),
      dense: rankOf(denseRows, expected),
      hybrid: rankOf(fused, expected),
      served: served.rows ? rankOf(served.rows, expected) : null,
    },
  })
}

// ---- report ---------------------------------------------------------------
const scored = results.filter((r) => !r.missing)
const missing = results.filter((r) => r.missing)

function metrics(leg) {
  const ranks = scored.map((r) => r.ranks[leg])
  const at = (k) => ranks.filter((x) => x !== null && x <= k).length
  const mrr = ranks.reduce((s, x) => s + (x ? 1 / x : 0), 0) / (ranks.length || 1)
  return { r5: at(5), r10: at(10), found: ranks.filter(Boolean).length, mrr }
}

const fmt = (r) => (r === null ? '  - ' : String(r).padStart(4))
console.log(`\nBRAIN2 retrieval eval — org ${ORG}, ${scored.length} pairs, limit ${LIMIT}\n`)
console.log('rank of expected note (1 = top hit, - = not in top ' + LIMIT + ')')
console.log('  fts dense hybr serv  query')
for (const r of scored) {
  const flag = r.embedError ? '  [embed: ' + r.embedError + ']' : ''
  console.log(`${fmt(r.ranks.fts)} ${fmt(r.ranks.dense)} ${fmt(r.ranks.hybrid)} ${fmt(r.ranks.served)}  ${r.query.slice(0, 70)}${flag}`)
}
console.log('\n            recall@5  recall@10  found@30   MRR')
for (const leg of legs) {
  const m = metrics(leg)
  console.log(`${leg.padEnd(8)}    ${String(m.r5).padStart(2)}/${scored.length}     ${String(m.r10).padStart(2)}/${scored.length}      ${String(m.found).padStart(2)}/${scored.length}    ${m.mrr.toFixed(3)}`)
}
if (missing.length) {
  console.log('\nMISSING ground-truth notes (title not found in org):')
  for (const r of missing) console.log('  ' + r.expectedTitle)
}
