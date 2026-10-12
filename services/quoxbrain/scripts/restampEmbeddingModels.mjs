// restampEmbeddingModels.mjs — one-time BRAIN2-SEMANTIC corpus repair.
//
// The 2026-08-25 embedding-space-split incident left every chunk_embeddings
// row stamped 'gemini-embedding-001' regardless of which provider actually
// produced the vector (collector /internal/embed hardcoded the stamp). The
// two providers' vectors are distinguishable by L2 norm:
//
//   OpenAI text-embedding-3-small (dimensions=768): normalized, |v| ≈ 1.0
//   Gemini gemini-embedding-001 (outputDimensionality=768): |v| ≈ 0.55-0.65
//
// This script re-stamps each row from its vector's norm so the space-filtered
// dense search (vaultStore.denseSearchChunks {model}) and the backfill's
// healing pass have truthful stamps to work from. Rows whose norm matches
// neither fingerprint are stamped 'unknown-space' (healed on the next
// backfill visit, since they mismatch every current provider model).
//
// Usage (inside the quox-brain container, service may stay up — WAL):
//   docker cp services/quoxbrain/scripts/restampEmbeddingModels.mjs quox-brain:/tmp/restamp.mjs
//   docker exec quox-brain node /tmp/restamp.mjs [--dry-run]
//
// Idempotent: re-running re-derives the same stamps.

const { default: Database } = await import('/app/node_modules/better-sqlite3/lib/index.js')

const DRY = process.argv.includes('--dry-run')
const DB_PATH = process.env.DB_PATH || '/var/lib/quox/quoxbrain.db'
const OPENAI_MODEL = 'text-embedding-3-small'
const GEMINI_MODEL = 'gemini-embedding-001'

const db = new Database(DB_PATH)
db.pragma('busy_timeout = 10000')

function normOf(blob) {
  const f = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT)
  let s = 0
  for (let i = 0; i < f.length; i++) s += f[i] * f[i]
  return Math.sqrt(s)
}

function modelForNorm(n) {
  if (Math.abs(n - 1) < 0.02) return OPENAI_MODEL
  if (n > 0.4 && n < 0.8) return GEMINI_MODEL
  return 'unknown-space'
}

const rows = db.prepare('SELECT chunk_id, model, vector FROM chunk_embeddings WHERE vector IS NOT NULL').all()
const counts = { total: rows.length, unchanged: 0, restamped: {}, unknown: 0 }
const update = db.prepare('UPDATE chunk_embeddings SET model = ? WHERE chunk_id = ?')

const tx = db.transaction((batch) => {
  for (const [model, chunkId] of batch) update.run(model, chunkId)
})

const pending = []
for (const r of rows) {
  const actual = modelForNorm(normOf(r.vector))
  if (actual === r.model) {
    counts.unchanged += 1
    continue
  }
  if (actual === 'unknown-space') counts.unknown += 1
  counts.restamped[`${r.model} -> ${actual}`] = (counts.restamped[`${r.model} -> ${actual}`] || 0) + 1
  pending.push([actual, r.chunk_id])
}

if (!DRY && pending.length > 0) tx(pending)

console.log(`[restamp] ${DRY ? 'DRY RUN — ' : ''}${counts.total} rows scanned, ${counts.unchanged} already correct, ${pending.length} ${DRY ? 'would be ' : ''}re-stamped`)
for (const [k, v] of Object.entries(counts.restamped)) console.log(`[restamp]   ${k}: ${v}`)
if (counts.unknown) console.log(`[restamp]   (${counts.unknown} rows matched neither fingerprint -> 'unknown-space'; the backfill healer will re-embed them)`)
db.close()
