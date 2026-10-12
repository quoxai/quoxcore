// served.mjs: BRAIN2-V3 B1 eval gate against a SERVED quoxbrain (what the
// deployed endpoints actually return, not lib-level legs).
//
//   node eval/served.mjs --build   discover real notes, write eval/served-golden.json
//   node eval/served.mjs           run the gate (exit 1 below thresholds)
//
// Env (values never printed):
//   BRAIN_URL             base URL of the instance (default http://localhost:3106). DEV ONLY.
//   INTERNAL_SERVICE_KEY  service key (X-Service-Key)
//   EVAL_ORG_ID           org to evaluate (default: golden file's org)
//   EVAL_USER_ID          user id sent as X-User-Id (default 'service')
//   EVAL_TENANT_ORG_ID / EVAL_TENANT_USER_ID  second tenant for the tenant check
//                         (defaults eval-tenant-probe-org / eval-tenant-probe-user). Pass the
//                         owner's own user id to probe user-scope notes following an owner
//                         into other orgs (by design per scopeClause, see report).
//   EVAL_MIN_RECALL5 (0.80) EVAL_MIN_NDCG10 (0.55) EVAL_MIN_ABSTAIN (0.80) EVAL_MIN_CTX_RECALL5 (0.60)
//   EVAL_SAMPLE (20)      notes sampled by --build
//
// Read-only: only POST /brain/search, POST /brain/context, GET /vaults and
// GET /vaults/:id/notes. Each query records a usage event, like any search.
// Pure scoring helpers are exported for unit tests; the CLI only runs when
// this file is the entrypoint.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(here, 'served-golden.json')

export const NONSENSE_QUERIES = [
  'zxqv blorptangle quillfeather nonexistent flumph',
  'purple elephants negotiate quarterly tax returns on mars',
  'asdkjh qweoiu zmxncb 99182736 plorf',
  'how many yaks fit inside a submarine kitchen cabinet',
  'xylophone mortgage ghostwriter turbine lemon'
]

/** nDCG@k with one relevant item at 1-based `rank` (null = absent). */
export function ndcgAt(rank, k = 10) {
  if (!rank || rank > k) return 0
  return 1 / Math.log2(rank + 1)
}

export function rankOf(noteIds, expected) {
  const i = noteIds.indexOf(expected)
  return i === -1 ? null : i + 1
}

export function summarize(ranks, abstentions, leaks, ctxRanks) {
  const n = ranks.length || 1
  return {
    // BRAIN2-W5 151: positive-query CONTEXT recall (passages an agent actually
    // receives) is a gated metric, not informational. Omitted when not measured.
    ...(Array.isArray(ctxRanks) ? { contextRecallAt5: ctxRanks.filter((r) => r && r <= 5).length / (ctxRanks.length || 1) } : {}),
    recallAt5: ranks.filter((r) => r && r <= 5).length / n,
    ndcgAt10: ranks.reduce((s, r) => s + ndcgAt(r, 10), 0) / n,
    abstentionAccuracy: abstentions.length ? abstentions.filter(Boolean).length / abstentions.length : 0,
    tenantLeaks: leaks
  }
}

export function verdict(m, th) {
  const failures = []
  if (m.recallAt5 < th.recall5) failures.push(`recall@5 ${m.recallAt5.toFixed(3)} < ${th.recall5}`)
  if (m.ndcgAt10 < th.ndcg10) failures.push(`nDCG@10 ${m.ndcgAt10.toFixed(3)} < ${th.ndcg10}`)
  if (m.abstentionAccuracy < th.abstain) failures.push(`abstention ${m.abstentionAccuracy.toFixed(3)} < ${th.abstain}`)
  if (Number.isFinite(m.contextRecallAt5) && Number.isFinite(th.ctxRecall5) && m.contextRecallAt5 < th.ctxRecall5) failures.push(`context recall@5 ${m.contextRecallAt5.toFixed(3)} < ${th.ctxRecall5}`)
  if (m.tenantLeaks > 0) failures.push(`tenant leaks ${m.tenantLeaks} > 0`)
  return failures
}

// BRAIN2-W5 152: every path the tenant probe exercises as a DIFFERENT org (and
// with no org header at all). Not covered here (needs write fixtures): citation
// events and same-org other-user visibility of user-scope notes.
export const TENANT_MATRIX_PATHS = ['search', 'context', 'read', 'suggestions', 'brief', 'no-org']

/** Count owned note ids that appear in any successful (2xx) probe body. Errors are never leaks. */
export function countTenantLeaks(owned, probes) {
  let leaks = 0
  for (const p of probes) {
    if (!(p.status >= 200 && p.status < 300)) continue
    const text = JSON.stringify(p.body ?? '')
    for (const id of owned) if (text.includes(id)) leaks++
  }
  return leaks
}

const STOP = new Set('the a an and or of to in on for with is are was were be by at as it this that from we our my i you your not no do does did how what why when which'.split(' '))

/** Deterministic question from a title and the first lines of its text. */
export function makeQuestion(title, excerpt) {
  const words = (s) => String(s || '').replace(/^#+\s*/gm, '').split(/[^A-Za-z0-9']+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
  const titleWords = words(String(title).replace(/[-_.]+/g, ' ')).slice(0, 5)
  const seen = new Set(titleWords.map((w) => w.toLowerCase()))
  const body = words(String(excerpt || '').split('\n').slice(0, 4).join(' ')).filter((w) => !seen.has(w.toLowerCase())).slice(0, 6)
  return `what do my notes say about ${titleWords.join(' ')}${body.length ? ` and ${body.join(' ')}` : ''}`.trim()
}

function cfg() {
  const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d }
  return {
    base: (process.env.BRAIN_URL || 'http://localhost:3106').replace(/\/+$/, ''),
    key: process.env.INTERNAL_SERVICE_KEY || '',
    userId: process.env.EVAL_USER_ID || 'service',
    tenantOrg: process.env.EVAL_TENANT_ORG_ID || 'eval-tenant-probe-org',
    tenantUser: process.env.EVAL_TENANT_USER_ID || 'eval-tenant-probe-user',
    sample: num('EVAL_SAMPLE', 20),
    th: { recall5: num('EVAL_MIN_RECALL5', 0.8), ndcg10: num('EVAL_MIN_NDCG10', 0.55), abstain: num('EVAL_MIN_ABSTAIN', 0.8), ctxRecall5: num('EVAL_MIN_CTX_RECALL5', 0.6) }
  }
}

function makeApi(c, orgId, userId = c.userId) {
  async function call(method, path, body) {
    const res = await send(method, path, body)
    // An error body is not data: fail loudly on non-2xx.
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`)
    return res.json()
  }
  function send(method, path, body) {
    return fetch(`${c.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'X-Service-Key': c.key, ...(orgId ? { 'X-Org-Id': orgId } : {}), 'X-User-Id': userId },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
  }
  /** Probe: never throws on an HTTP error status; returns { status, body } (a 4xx is the EXPECTED outcome for a foreign tenant). */
  async function probe(method, path, body) {
    const res = await send(method, path, body)
    let json = null
    try { json = await res.json() } catch { /* non-JSON body */ }
    return { status: res.status, body: json }
  }
  return {
    probe,
    vaults: () => call('GET', '/vaults'),
    notes: (id, offset, limit) => call('GET', `/vaults/${id}/notes?limit=${limit}&offset=${offset}`),
    search: (query, extra = {}) => call('POST', '/brain/search', { query, limit: 10, ...extra }),
    context: (query) => call('POST', '/brain/context', { query, tokenBudget: 800 })
  }
}

async function build(c) {
  const orgId = process.env.EVAL_ORG_ID
  if (!orgId) throw new Error('EVAL_ORG_ID is required for --build')
  const api = makeApi(c, orgId)
  const vaults = (await api.vaults()).filter((v) => v.scope === 'org' && (v.org_id === orgId || v.orgId === orgId || v.org_id === undefined))
  const pool = []
  for (const v of vaults) {
    for (let off = 0; off < 2000; off += 500) {
      const page = await api.notes(v.id, off, 500)
      for (const n of page) if (n.title && n.title.length > 3 && (n.word_count ?? 100) >= 60) pool.push({ vaultId: v.id, noteId: n.id, title: n.title })
      if (page.length < 500) break
    }
  }
  // Unique titles, deterministic ordering, evenly strided sample.
  const byTitle = new Map()
  for (const n of pool) if (!byTitle.has(n.title)) byTitle.set(n.title, n); else byTitle.set(n.title, null)
  const unique = [...byTitle.values()].filter(Boolean).sort((a, b) => a.noteId.localeCompare(b.noteId))
  const stride = Math.max(1, Math.floor(unique.length / c.sample))
  const pairs = []
  for (let i = 0; i < unique.length && pairs.length < c.sample; i += stride) {
    const n = unique[i]
    const hit = (await api.search(n.title, { vaultIds: [n.vaultId], limit: 10 })).results?.find((r) => r.noteId === n.noteId)
    pairs.push({ noteId: n.noteId, title: n.title, query: makeQuestion(n.title, hit?.text || hit?.snippet || '') })
  }
  const nonOrg = pool.length
  writeFileSync(GOLDEN_PATH, JSON.stringify({ description: 'Served-eval golden set: real notes discovered from the dev org by eval/served.mjs --build. Read-only discovery.', org_id: orgId, generatedAt: new Date().toISOString(), poolSize: nonOrg, pairs, nonsense: NONSENSE_QUERIES }, null, 2) + '\n')
  console.log(`served-eval: wrote ${pairs.length} pairs (pool ${nonOrg} notes) to eval/served-golden.json`)
}

async function run(c) {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
  const orgId = process.env.EVAL_ORG_ID || golden.org_id
  const api = makeApi(c, orgId)
  const ranks = []
  const ctxRanks = []
  for (const p of golden.pairs) {
    const s = await api.search(p.query)
    const r = rankOf((s.results || []).map((x) => x.noteId), p.noteId)
    ranks.push(r)
    const cx = await api.context(p.query)
    ctxRanks.push(rankOf((cx.passages || []).map((x) => x.noteId), p.noteId))
    console.log(`  ${r ? `rank ${String(r).padStart(2)}` : 'MISS   '} ${s.retrieval || '?'}  ${p.title}`)
  }
  const abst = []
  for (const q of golden.nonsense || NONSENSE_QUERIES) {
    const cx = await api.context(q)
    abst.push(cx.insufficient === true)
  }
  // Tenant check: a different org must never see this org's org-scope notes.
  // BRAIN2-W5 152: matrix = search, context, note read, suggestions, brief (as the
  // other tenant) plus search/read with NO org header. See TENANT_MATRIX_PATHS.
  const other = makeApi(c, c.tenantOrg, c.tenantUser)
  const noOrg = makeApi(c, null, c.tenantUser)
  const owned = new Set(golden.pairs.map((p) => p.noteId))
  const probes = []
  for (const p of golden.pairs) {
    probes.push({ path: 'search', ...(await other.probe('POST', '/brain/search', { query: p.query, limit: 10 })) })
    probes.push({ path: 'context', ...(await other.probe('POST', '/brain/context', { query: p.query, tokenBudget: 800 })) })
    probes.push({ path: 'read', ...(await other.probe('GET', `/notes/${encodeURIComponent(p.noteId)}`)) })
    probes.push({ path: 'no-org', ...(await noOrg.probe('POST', '/brain/search', { query: p.query, limit: 10 })) })
    probes.push({ path: 'no-org', ...(await noOrg.probe('GET', `/notes/${encodeURIComponent(p.noteId)}`)) })
  }
  probes.push({ path: 'suggestions', ...(await other.probe('GET', '/brain/suggestions?count=20')) })
  probes.push({ path: 'brief', ...(await other.probe('GET', '/brain/brief?since=30d')) })
  const leaks = countTenantLeaks(owned, probes)
  const m = summarize(ranks, abst, leaks, ctxRanks)
  const ctxRecall5 = m.contextRecallAt5
  console.log(`served-eval ${c.base} org=${orgId} pairs=${ranks.length}`)
  console.log(`  recall@5=${m.recallAt5.toFixed(3)} nDCG@10=${m.ndcgAt10.toFixed(3)} abstention=${m.abstentionAccuracy.toFixed(3)} (${abst.filter(Boolean).length}/${abst.length}) tenantLeaks=${m.tenantLeaks} context_recall@5=${ctxRecall5.toFixed(3)} tenantProbes=${probes.length}`)
  const failures = verdict(m, c.th)
  if (failures.length) { console.error(`served-eval FAIL: ${failures.join('; ')}`); process.exit(1) }
  console.log('served-eval PASS')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const c = cfg()
  if (!c.key) { console.error('INTERNAL_SERVICE_KEY is required'); process.exit(2) }
  ;(process.argv.includes('--build') ? build(c) : run(c)).catch((err) => { console.error(`served-eval ERROR: ${err.message}`); process.exit(2) })
}
