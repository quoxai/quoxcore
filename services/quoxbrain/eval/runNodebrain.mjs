// runNodebrain.mjs — P1d retrieval eval harness (docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §5)
//
// Boots a throwaway QuoxBrain instance (temp SQLite DB + temp vault root)
// against a COPY of the real NodeBrain corpus, indexes it, then drives every
// golden query (eval/golden-nodebrain.json) through store.searchChunks
// (top-20) and reports recall@5, recall@20, nDCG@10, citation-integrity %,
// and the zero-hit query list (the corpus-gap/query-failure detector).
//
// Every later retrieval phase (P3 hybrid+rerank, P4 graph) must not regress
// recall@20 below RECALL_AT_20_FLOOR — this is a regression gate, not an
// aspiration. See eval/README.md for how to regrow the golden set and
// revise the floor.
//
// Usage: `npm run eval` (from services/quoxbrain) — exits 0 if recall@20 is
// at/above the floor, 1 otherwise.

import { mkdtempSync, rmSync, cpSync, readFileSync } from 'fs'
import { join, dirname, sep } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { initDatabase, closeDatabase } from '../lib/db.js'
import * as store from '../lib/vaultStore.js'
import { indexVault } from '../lib/ingest.js'
import { computeRelevance } from '../lib/relevance.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const NODEBRAIN_SOURCE = '/opt/quoxcore/obsidian/NodeBrain'
const ORG = 'eval-nodebrain'
const K_SMALL = 5
const K_LARGE = 20
const NDCG_K = 10

// Regression floor (docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §5: "every later
// phase gates on not regressing"). The P1d fixed baseline (OR-semantics
// searchChunks, see lib/vaultStore.js buildOrMatchQuery) achieves
// recall@20 = 100% (40/40) on this golden set — floor is set 10 points
// below that so incidental BM25/tokenizer noise or small golden-set growth
// doesn't false-positive the gate, while still catching a real regression.
// Revise only with a recorded eval run — see eval/README.md "How to regrow
// the golden set".
const RECALL_AT_20_FLOOR = 0.90

function loadGoldenSet() {
  const raw = readFileSync(join(__dirname, 'golden-nodebrain.json'), 'utf8')
  return JSON.parse(raw)
}

/** Copies only the real NodeBrain .md tree (skips .obsidian config/plugins/
 * themes — noise, never walked by ingest.js anyway) into a throwaway dir so
 * the real vault on disk is never touched or mutated by an eval run. */
function copyNodebrainCorpus(destDir) {
  cpSync(NODEBRAIN_SOURCE, destDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('.obsidian')
  })
}

function dcgAt(hitFlags, k) {
  let dcg = 0
  for (let i = 0; i < Math.min(hitFlags.length, k); i++) {
    if (hitFlags[i]) dcg += 1 / Math.log2(i + 2) // rank is 1-based: i=0 -> log2(2)
  }
  return dcg
}

function idealDcgAt(relevantCount, k) {
  let idcg = 0
  for (let i = 0; i < Math.min(relevantCount, k); i++) {
    idcg += 1 / Math.log2(i + 2)
  }
  return idcg
}

/**
 * Runs one golden query through store.searchChunks (top-20) and scores it.
 * Binary relevance: gain 1 per ranked result whose note's relPath is in
 * `relevantRelPaths` (repeats count independently — multiple good chunks
 * from the right note in the top-10 legitimately boost nDCG).
 */
function evaluateQuery(orgId, { query, relevantRelPaths }) {
  const results = store.searchChunks(orgId, null, { query, limit: K_LARGE })
  const relevantSet = new Set(relevantRelPaths)

  const hitFlags = results.map((r) => relevantSet.has(r.relPath))
  const hitAt5 = hitFlags.slice(0, K_SMALL).some(Boolean)
  const hitAt20 = hitFlags.some(Boolean)

  // idealCount: a relevant NOTE can legitimately back MULTIPLE chunks that
  // each independently earn gain=1 (chunks are the addressable unit, per
  // §2 — "returns ranked chunks, not notes"), so the true ceiling on
  // relevant items can exceed relevantRelPaths.length. Bound the ideal
  // count below by however many gains were actually observed in the nDCG
  // window so a well-covered note never scores nDCG > 1.0 by construction.
  const dcg = dcgAt(hitFlags, NDCG_K)
  const observedHitsInWindow = hitFlags.slice(0, NDCG_K).filter(Boolean).length
  const idealCount = Math.max(relevantRelPaths.length, observedHitsInWindow)
  const idcg = idealDcgAt(idealCount, NDCG_K)
  const ndcg = idcg > 0 ? dcg / idcg : 0

  // Citation-integrity: every returned result must resolve to a real
  // {chunkId, noteId} pair via getChunkDetails — the same lookup
  // lib/contextAssembler.js uses to build citations.
  let resolvable = 0
  if (results.length > 0) {
    const details = store.getChunkDetails(orgId, null, results.map((r) => r.chunkId))
    const detailsByChunkId = new Map(details.map((d) => [d.chunkId, d]))
    for (const r of results) {
      const d = detailsByChunkId.get(r.chunkId)
      if (d && d.noteId === r.noteId) resolvable += 1
    }
  }

  return { query, resultCount: results.length, hitAt5, hitAt20, ndcg, resolvable, total: results.length }
}

async function main() {
  const goldenSet = loadGoldenSet()

  const vaultRoot = mkdtempSync(join(tmpdir(), 'quoxbrain-eval-vaultroot-'))
  const dbDir = mkdtempSync(join(tmpdir(), 'quoxbrain-eval-db-'))
  const orgDir = join(vaultRoot, ORG)
  const originalRoot = process.env.QUOXBRAIN_VAULT_ROOT

  try {
    copyNodebrainCorpus(orgDir)
    process.env.QUOXBRAIN_VAULT_ROOT = vaultRoot
    initDatabase(join(dbDir, 'eval.db'))

    const vault = store.createVault({
      org_id: ORG, name: 'NodeBrain (eval)', source_type: 'local', source_path: orgDir
    })
    const indexed = await indexVault(vault)
    console.log(`[eval] indexed ${indexed.note_count} notes, ${indexed.edge_count} resolved links from ${NODEBRAIN_SOURCE}`)

    const perQuery = goldenSet.map((g) => evaluateQuery(ORG, g))
    const n = perQuery.length

    const recallAt5 = perQuery.filter((r) => r.hitAt5).length / n
    const recallAt20 = perQuery.filter((r) => r.hitAt20).length / n
    const avgNdcg10 = perQuery.reduce((sum, r) => sum + r.ndcg, 0) / n

    const totalResolvable = perQuery.reduce((sum, r) => sum + r.resolvable, 0)
    const totalResults = perQuery.reduce((sum, r) => sum + r.total, 0)
    const citationIntegrityPct = totalResults > 0 ? (totalResolvable / totalResults) * 100 : 100

    const zeroHits = perQuery.filter((r) => !r.hitAt20)

    console.log('')
    console.log('=== QuoxBrain P1d retrieval eval — NodeBrain golden set ===')
    console.log(`queries:             ${n}`)
    console.log(`recall@${K_SMALL}:              ${(recallAt5 * 100).toFixed(1)}%`)
    console.log(`recall@${K_LARGE}:             ${(recallAt20 * 100).toFixed(1)}%`)
    console.log(`nDCG@${NDCG_K}:              ${avgNdcg10.toFixed(4)}`)
    console.log(`citation-integrity:  ${citationIntegrityPct.toFixed(1)}% (${totalResolvable}/${totalResults} results resolved)`)
    console.log(`zero-hit queries:    ${zeroHits.length}/${n}`)
    if (zeroHits.length > 0) {
      for (const r of zeroHits) console.log(`  -> ${JSON.stringify(r.query)}`)
    }
    // Abstention calibration (BRAIN2-AUDIT): golden queries must NOT abstain
    // (FTS-only, no dense signal), nonsense queries must.
    const NONSENSE = ['giraffe banana recipe', 'quantum pancake tuba', 'zxqv blorf wibble', 'purple elephant marathon trophy']
    const abstains = (q) => computeRelevance(q, store.getChunkDetails(ORG, null, store.searchChunks(ORG, null, { query: q, limit: 5 }).map((r) => r.chunkId))).insufficient
    const goldenAbstain = goldenSet.filter((g) => abstains(g.query))
    const nonsenseAbstain = NONSENSE.filter(abstains)
    console.log(`abstention: golden falsely insufficient ${goldenAbstain.length}/${n}; nonsense correctly insufficient ${nonsenseAbstain.length}/${NONSENSE.length}`)
    for (const g of goldenAbstain) console.log(`  -> false abstain ${JSON.stringify(g.query)}`)
    console.log('')
    console.log(`regression floor recall@${K_LARGE}: ${(RECALL_AT_20_FLOOR * 100).toFixed(1)}%`)

    if (recallAt20 < RECALL_AT_20_FLOOR) {
      console.error(`[eval] FAIL — recall@${K_LARGE} ${(recallAt20 * 100).toFixed(1)}% is below the regression floor ${(RECALL_AT_20_FLOOR * 100).toFixed(1)}%`)
      process.exitCode = 1
    } else {
      console.log('[eval] PASS')
    }
  } finally {
    closeDatabase()
    if (originalRoot === undefined) delete process.env.QUOXBRAIN_VAULT_ROOT
    else process.env.QUOXBRAIN_VAULT_ROOT = originalRoot
    rmSync(vaultRoot, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[eval] crashed:', err)
  process.exitCode = 1
})
