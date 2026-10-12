// BRAIN2-V2 V2-9: CJK retrieval regression runner. Ingests fixture.json into a
// temp DB through the real store functions (createVault/upsertNote/
// replaceNoteChunks) and scores searchChunks ("fts" retrieval: sparse leg only).
//   node eval/multilingual/run.mjs
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { initDatabase, closeDatabase } from '../../lib/db.js'
import * as store from '../../lib/vaultStore.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'))
const ORG = 'mlEval'

export function ingestFixture(org = ORG, notes = fixture.notes) {
  const ids = new Map()
  const v = store.createVault({ org_id: org, name: `ml-${org}`, source_type: 'push', source_path: `push://${org}/ml` })
  for (const n of notes) {
    const nid = store.upsertNote({ vault_id: v.id, org_id: org, rel_path: n.id, title: n.id, frontmatter: '{}', body: n.text, occurred_at: new Date().toISOString(), scope: 'org', owner_user_id: null })
    store.replaceNoteChunks(nid, v.id, org, [{ ordinal: 0, headingPath: null, text: n.text, charStart: 0, charEnd: n.text.length, tokenCount: 10, contentHash: `h-${org}-${n.id}` }], n.id, { scope: 'org', owner_user_id: null })
    ids.set(nid, n.id)
  }
  return ids
}

export function scoreQueries(ids, org = ORG, queries = fixture.queries) {
  let pos = 0; let h1 = 0; let h3 = 0; let rr = 0; let absent = 0; let falseHits = 0
  const misses = []
  for (const q of queries) {
    const res = store.searchChunks(org, 'u', { query: q.q, limit: 10 })
    const seen = []
    for (const r of res) { const id = ids.get(r.noteId); if (id && !seen.includes(id)) seen.push(id) }
    if (q.kind === 'absent') {
      absent++
      if (seen.length > 0) { falseHits++; misses.push(`${q.id} FALSE-HIT ${seen.join(',')}`) }
      continue
    }
    pos++
    const rank = seen.findIndex((id) => q.targets.includes(id)) + 1
    if (rank === 1) h1++
    if (rank >= 1 && rank <= 3) h3++
    if (rank >= 1) rr += 1 / rank
    else misses.push(`${q.id} MISS "${q.q}" got [${seen.join(',')}]`)
    if (rank > 1) misses.push(`${q.id} rank ${rank}`)
  }
  return { positives: pos, absent, hitAt1: h1 / pos, hitAt3: h3 / pos, mrr: rr / pos, falseHits, misses }
}

export function runMultilingualEval() {
  const dir = mkdtempSync(join(tmpdir(), 'quoxbrain-mleval-'))
  initDatabase(join(dir, 'ml.db'))
  try {
    return scoreQueries(ingestFixture())
  } finally {
    closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runMultilingualEval()
  console.log(JSON.stringify({ ...r, misses: undefined }, null, 2))
  for (const m of r.misses) console.log(' ', m)
}
