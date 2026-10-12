// Brain-level strict-noteId eval over the TUNABLE dev7 set (blind sets stay untouched).
// usage: INTERNAL_SERVICE_KEY=<key> node eval.mjs '<body overrides>' [limit] [--user=<id>] [--v]
// Default user is the org owner; user-scoped targets of any other user are correctly invisible.
import { readFileSync } from 'node:fs'
const F = new URL('./dev-org-set7.json', import.meta.url)
const fx = JSON.parse(readFileSync(F, 'utf8'))
const over = JSON.parse(process.argv[2] || '{}'); const L = Number(process.argv[3] || 8)
const H = { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY, 'X-Org-Id': fx.org_id, 'X-User-Id': (process.argv.find((a) => a.startsWith('--user=')) || '').slice(7) || '01KKNKG580E967VC6YKAFWRT27' }
async function search(q) {
  const body = { query: q, limit: L, kindPriors: { note: 1.2, memory: 1.2, code: 0.6, '*': 1 }, rerankTimeoutMs: 3500, embedTimeoutMs: 4000, ...over }
  for (let a = 0; a < 3; a++) { try { const r = await fetch('http://127.0.0.1:3106/brain/search', { method: 'POST', headers: H, body: JSON.stringify(body) }); if (r.ok) return await r.json() } catch {} await new Promise((r) => setTimeout(r, 2000)) }
  return null
}
const rows = []; const q = fx.paraphrases.map((p, i) => ({ ...p, i }))
await Promise.all([0, 1].map(async () => { while (q.length) { const p = q.shift(); const t = Date.now(); const d = await search(p.question); const ids = (d?.results || []).map((r) => r.noteId || r.note_id || r.id); const ok = new Set([p.noteId, ...(p.acceptable || [])]); rows.push({ i: p.i, kind: p.kind, rank: ids.findIndex((x) => ok.has(x)) + 1, err: !d, ms: Date.now() - t, rerank: d?.rerank, expand: d?.expand }) } }))
const nm = []; for (const m of fx.nearMisses) { const d = await search(m.query); nm.push(!!d?.insufficient) }
const n = rows.length, f = (p) => +(rows.filter(p).length / n).toFixed(3)
console.log(JSON.stringify({ over, L, n, err: rows.filter((r) => r.err).length, hit1: f((r) => r.rank === 1), hit3: f((r) => r.rank && r.rank <= 3), hitL: f((r) => r.rank > 0), mrr: +(rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n).toFixed(3), abstain: +(nm.filter(Boolean).length / nm.length).toFixed(3), p50: rows.map((r) => r.ms).sort((a, b) => a - b)[n >> 1] }))
if (process.argv.includes('--v')) console.log(JSON.stringify(rows.sort((a, b) => a.i - b.i).map((r) => [r.i, r.kind, r.rank])))
