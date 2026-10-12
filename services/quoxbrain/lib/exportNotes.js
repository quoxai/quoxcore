// exportNotes.js — BRAIN2-W8 portable export. Streams every note VISIBLE to
// (orgId, userId) using the SAME visibility rule as search (vaultStore
// scopeClause: org notes of the caller's org, the caller's own user-scope
// notes, shared vaults) minus vaults excluded by the org's exclusion list.
// Pages the DB with a keyset cursor (n.id), 200 notes per page, so memory is
// bounded by one page regardless of corpus size. org_id never appears in
// output. Two formats: JSONL (one note per line) and a ustar tar of .md files
// with YAML front matter (no zip dependency exists in this service).

import { getDatabase } from './db.js'
import { scopeClause } from './vaultStore.js'
import matter from 'gray-matter'

export const EXPORT_PAGE_SIZE = 200

function safeParse(s) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s || '{}') } catch { return {} }
}

/** Async generator of shaped note records, one page at a time. */
export async function* iterateVisibleNotes({ orgId, userId, excludedVaultIdSet = new Set(), scope, pageSize = EXPORT_PAGE_SIZE }) {
  const db = getDatabase()
  const sc = scopeClause(orgId, userId, { alias: 'n' })
  let where = sc.sql
  const base = [...sc.params]
  if (scope === 'org' || scope === 'user' || scope === 'shared') { where += ' AND n.scope = ?'; base.push(scope) }
  const pageStmt = db.prepare(`
    SELECT n.id, n.title, n.body, n.scope, n.kind, n.source_type, n.rel_path, n.frontmatter, n.occurred_at,
           n.origin_store, n.origin_id, n.created_at, n.updated_at, n.content_hash, n.vault_id, v.name AS vault_name, v.app AS vault_app
    FROM notes n JOIN vaults v ON v.id = n.vault_id
    WHERE ${where} AND n.id > ?
    ORDER BY n.id LIMIT ?`)
  let cursor = ''
  for (;;) {
    const rows = pageStmt.all(...base, cursor, pageSize)
    if (rows.length === 0) return
    cursor = rows[rows.length - 1].id
    const kept = rows.filter((r) => !excludedVaultIdSet.has(r.vault_id))
    if (kept.length) {
      const ids = kept.map((r) => r.id)
      const ph = ids.map(() => '?').join(',')
      const tags = new Map(); const links = new Map(); const revs = new Map()
      for (const t of db.prepare(`SELECT note_id, tag FROM note_tags WHERE note_id IN (${ph}) ORDER BY tag`).all(...ids)) {
        if (!tags.has(t.note_id)) tags.set(t.note_id, []); tags.get(t.note_id).push(t.tag)
      }
      for (const l of db.prepare(`SELECT source_note_id, target_note_id, target_raw, link_type, resolved FROM note_links WHERE source_note_id IN (${ph}) ORDER BY id`).all(...ids)) {
        if (!links.has(l.source_note_id)) links.set(l.source_note_id, [])
        links.get(l.source_note_id).push({ target: l.target_raw, type: l.link_type, target_note_id: l.resolved ? l.target_note_id : null })
      }
      for (const r of db.prepare(`SELECT note_id, COUNT(*) AS c FROM note_revisions WHERE note_id IN (${ph}) GROUP BY note_id`).all(...ids)) revs.set(r.note_id, r.c)
      for (const r of kept) {
        yield {
          id: r.id,
          title: r.title || null,
          body: r.body || '',
          scope: r.scope,
          source: {
            vault: r.vault_name, app: r.vault_app || null, kind: r.kind || null, source_type: r.source_type || null,
            path: r.rel_path, origin_store: r.origin_store || null, origin_id: r.origin_id || null, occurred_at: r.occurred_at || null,
          },
          created_at: r.created_at,
          updated_at: r.updated_at,
          content_hash: r.content_hash || null,
          frontmatter: safeParse(r.frontmatter),
          links: links.get(r.id) || [],
          tags: tags.get(r.id) || [],
          revision_count: revs.get(r.id) || 0,
        }
      }
    }
    if (rows.length < pageSize) return
    await new Promise((r) => setImmediate(r)) // yield the loop between pages
  }
}

export function toJsonlLine(rec) { return `${JSON.stringify(rec)}\n` }

const slug = (s) => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'untitled'

/** Markdown file (YAML front matter + body) and its tar-safe relative path. */
export function toMarkdownFile(rec) {
  const fm = {
    id: rec.id, title: rec.title, scope: rec.scope, source: rec.source,
    created_at: rec.created_at, updated_at: rec.updated_at, tags: rec.tags,
    links: rec.links, revision_count: rec.revision_count,
  }
  const text = matter.stringify(rec.body, JSON.parse(JSON.stringify(fm)))
  return { path: `${rec.scope}/${slug(rec.title)}-${String(rec.id).slice(0, 8)}.md`, content: Buffer.from(text, 'utf8') }
}

/** Minimal ustar entry (header + padded data). Path must be <= 100 bytes. */
export function tarEntry(path, data, mtimeSec = Math.floor(Date.now() / 1000)) {
  const h = Buffer.alloc(512)
  const put = (s, off, len) => h.write(s, off, len, 'utf8')
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`
  if (Buffer.byteLength(path) > 100) throw new Error('tar path too long')
  put(path, 0, 100); put(oct(0o644, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8)
  put(oct(data.length, 12), 124, 12); put(oct(mtimeSec, 12), 136, 12); put('        ', 148, 8)
  put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2)
  let sum = 0; for (const b of h) sum += b
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const pad = (512 - (data.length % 512)) % 512
  return Buffer.concat([h, data, Buffer.alloc(pad)])
}
export const TAR_END = Buffer.alloc(1024)

/** Stream an export to a writable (express res). Honours backpressure and client abort. */
export async function streamExport(res, opts, format = 'jsonl') {
  let aborted = false
  res.on('close', () => { aborted = true })
  const write = async (chunk) => { if (!res.write(chunk)) await new Promise((r) => { res.once('drain', r); res.once('close', r) }) }
  let count = 0
  for await (const rec of iterateVisibleNotes(opts)) {
    if (aborted) return count
    if (format === 'markdown') { const f = toMarkdownFile(rec); await write(tarEntry(f.path, f.content)) }
    else await write(toJsonlLine(rec))
    count++
  }
  if (format === 'markdown') await write(TAR_END)
  res.end()
  return count
}
