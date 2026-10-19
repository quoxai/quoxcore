// capture.js — "capture everywhere" (BRAIN2-V3 A2).
//
// POST /brain/capture writes a note into the caller's NotesQ vault through the
// SAME createNote/updateNote path NotesQ uses (so it is editable in NotesQ,
// chunked + FTS-indexed synchronously by ingestDocuments; embeddings follow
// via the existing backfill). Idempotent on an exact-content hash (case-sensitive) plus
// title (a different explicit title is a new note, quox#963), and a
// near-identical existing note (word-shingle Jaccard) is flagged via
// possibleDuplicateOf, never overwritten (update needs an explicit update_note_id). A URL with no text is fetched server-side behind the SSRF egress
// guard and reduced to readable text (dependency-free heuristic). PDFs are
// extracted with pdf-parse (first 50 pages, 5MB cap); 501 pdf_unsupported if the
// parser cannot load.

import { redactSecrets } from './redact.js'
import { createHash } from 'crypto'
import matter from 'gray-matter'
import { getDatabase } from './db.js'
import * as store from './vaultStore.js'
import * as notesq from './notesq.js'
import { assertSafeEgressUrl, pinnedFetch } from './egressGuard.js'

export const NEAR_DUP_THRESHOLD = 0.9
// Auto-update (rewrite an existing note) needs a much tighter match than merely
// 'looks like a duplicate', and no changed identifiers/numbers.
export const AUTO_UPDATE_THRESHOLD = 0.97
export const MAX_FETCH_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15000
const MAX_REDIRECTS = 4
const SCAN_LIMIT = 300

export class CaptureError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra }
}

export function normalizeText(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()
}
// Exact-content hash: only line endings and trailing whitespace are normalised.
// Case is significant ('credential AbCd' != 'credential abcd').
export function exactText(t) {
  return String(t || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim()
}
export function contentHash(t) {
  return createHash('sha1').update(exactText(t)).digest('hex')
}

// Identifier-ish tokens: contain a digit or an uppercase letter past the first
// character (AbCd, v2, 4111, API_KEY). Case preserved.
export function sensitiveTokens(t) {
  const out = new Set()
  for (const w of exactText(t).split(/\s+/)) {
    const tok = w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '')
    if (tok && (/\d/.test(tok) || /.\p{Lu}/u.test(tok) || /^[\p{Lu}]{2,}/u.test(tok))) out.add(tok)
  }
  return out
}
// BRAIN2-W7 051: similarity() lower-cases and collapses whitespace, so a
// rewrite that only changes identifier case or indentation scored 1.0. Every
// case-sensitive word and every line's indentation of the old text must survive
// in the new text for an in-place update to be considered safe.
function caseWords(t) { return new Set(exactText(t).split(/\s+/).filter(Boolean)) }
function indentedLeads(t) {
  const out = new Set()
  for (const l of exactText(t).split('\n')) { if (l.trim()) out.add(l.match(/^[ \t]*/)[0] + l.trim().split(/\s+/)[0]) }
  return out
}
export function safeToAutoUpdate(oldText, newText) {
  if (similarity(oldText, newText) < AUTO_UPDATE_THRESHOLD) return false
  const nw = caseWords(newText)
  for (const w of caseWords(oldText)) if (!nw.has(w)) return false
  const nl = indentedLeads(newText)
  for (const l of indentedLeads(oldText)) if (!nl.has(l)) return false
  const a = sensitiveTokens(oldText), b = sensitiveTokens(newText)
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function shingles(text, n = 3) {
  const w = normalizeText(text).split(' ').filter(Boolean)
  const set = new Set()
  if (w.length <= n) { set.add(w.join(' ')); return set }
  for (let i = 0; i <= w.length - n; i++) set.add(w.slice(i, i + n).join(' '))
  return set
}
export function similarity(a, b) {
  const A = shingles(a), B = shingles(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const s of A) if (B.has(s)) inter++
  return inter / (A.size + B.size - inter)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&([a-z]+|#39);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
}

// Dependency-free readability heuristic: strip non-content blocks, prefer
// <article>/<main>, keep paragraph-ish structure, decode entities.
export function extractReadable(html) {
  let h = String(html || '')
  const t = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const og = h.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
  const title = decodeEntities((og?.[1] || t?.[1] || '').replace(/\s+/g, ' ').trim())
  h = h.replace(/<!--[\s\S]*?-->/g, ' ')
  h = h.replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
  const region = h.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
  if (region) h = region[1]
  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, c) => `\n\n${'#'.repeat(Math.min(Number(l), 3))} ${c}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|tr|ul|ol|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  h = decodeEntities(h)
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
  return { title, text: h }
}

export const MAX_PDF_PAGES = 50
export const MAX_PDF_BYTES = MAX_FETCH_BYTES

// BRAIN2-W5 058: byte/page caps do not bound parser CPU time or concurrency.
// A small pathological PDF (or a burst of captures) could pin the event loop /
// worker. Parses run through a counting semaphore with a bounded wait queue
// and a per-parse deadline. A timed-out parse keeps its slot until the
// underlying work really settles (it cannot be killed in-process), so a hung
// parser can never lead to unbounded concurrent parses.
export const PDF_PARSE_TIMEOUT_MS = 30000
export const PDF_MAX_CONCURRENT = 2
export const PDF_MAX_QUEUED = 8

const pdfSem = { active: 0, waiters: [] }

export async function boundedPdfWork(work, { timeoutMs = PDF_PARSE_TIMEOUT_MS, maxConcurrent = PDF_MAX_CONCURRENT, maxQueued = PDF_MAX_QUEUED, sem = pdfSem } = {}) {
  if (sem.active >= maxConcurrent) {
    if (sem.waiters.length >= maxQueued) throw new CaptureError(503, 'pdf_busy')
    await new Promise((resolve) => sem.waiters.push(resolve))
  } else {
    sem.active += 1
  }
  // (a waiter inherits the releasing parse's slot, so active stays constant)
  const release = () => {
    const next = sem.waiters.shift()
    if (next) next()
    else sem.active -= 1
  }
  let timer
  const work$ = (async () => work())()
  work$.then(release, release)
  try {
    return await Promise.race([
      work$,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new CaptureError(422, 'pdf_timeout')), timeoutMs) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function defaultPdfParse(buf) {
  if (buf.length > MAX_PDF_BYTES) throw new CaptureError(413, 'pdf_too_large')
  return boundedPdfWork(() => parsePdfUnbounded(buf))
}

async function parsePdfUnbounded(buf) {
  let mod
  try { mod = await import('pdf-parse') } catch { throw new CaptureError(501, 'pdf_unsupported') }
  if (typeof mod.PDFParse !== 'function') throw new CaptureError(501, 'pdf_unsupported')
  const p = new mod.PDFParse({ data: new Uint8Array(buf) })
  try {
    const r = await p.getText({ first: MAX_PDF_PAGES })
    let title = ''
    try { title = (await p.getInfo())?.info?.Title || '' } catch { /* title is optional */ }
    const text = String(r.text || '').replace(/^-- \d+ of \d+ --$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    return { text, title, pages: r.total, truncated: Number(r.total) > MAX_PDF_PAGES }
  } catch (e) {
    if (e instanceof CaptureError) throw e
    throw new CaptureError(422, 'pdf_unreadable')
  } finally {
    try { await p.destroy() } catch { /* best effort */ }
  }
}

function pdfMetaOf(r) {
  const total = Number(r?.pages)
  if (!Number.isFinite(total) || total <= MAX_PDF_PAGES) return null
  return { pagesTotal: total, pagesCaptured: MAX_PDF_PAGES }
}

function looksPdf(buf, ct, url) {
  return buf.slice(0, 5).toString('latin1') === '%PDF-' || /application\/pdf/i.test(ct || '') || /\.pdf(\?|#|$)/i.test(url || '')
}

async function readCapped(res, cap) {
  const chunks = []
  let total = 0
  for await (const c of res.body) {
    total += c.length
    if (total > cap) { try { res.body.destroy?.() } catch { /* best effort */ } throw new CaptureError(413, 'page_too_large') }
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks)
}

// Fetch with redirects re-validated hop by hop through the egress guard.
export async function fetchUrl(rawUrl, { fetchImpl, resolver } = {}) {
  let url = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let safe
    try { safe = await assertSafeEgressUrl(url, resolver ? { resolver } : undefined) } catch (e) {
      throw new CaptureError(400, 'blocked_egress', { detail: e.message })
    }
    let res
    try {
      const reqHeaders = { 'user-agent': 'QuoxBrain-Capture/1.0', accept: 'text/html,application/pdf;q=0.9,*/*;q=0.1' }
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      // BRAIN2-W5 056: connect to the exact addresses the guard validated (no
      // second DNS lookup to rebind). An injected fetchImpl (tests) receives
      // them as pinnedIps.
      res = fetchImpl
        ? await fetchImpl(url, { redirect: 'manual', signal, headers: reqHeaders, pinnedIps: safe.ips })
        : await pinnedFetch(url, safe.ips, { signal, headers: reqHeaders })
    } catch {
      throw new CaptureError(502, 'fetch_failed')
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString()
      continue
    }
    if (!res.ok) throw new CaptureError(502, 'fetch_failed', { upstream_status: res.status })
    const body = await readCapped(res, MAX_FETCH_BYTES)
    return { url, contentType: res.headers.get('content-type') || '', body }
  }
  throw new CaptureError(502, 'too_many_redirects')
}

function fmTitleBody(content) {
  let body = content
  try { body = matter(content).content } catch { /* ignore */ }
  return body.trimStart().replace(/^#\s+[^\n]*\n+/, '').replace(/\n+Source: \S+\s*$/, '')
}

const sameTitle = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

// quox#963: an exact-body match is only "the same note" when no title was given
// or the titles agree. Same text under a different explicit title is a new
// document (flagged possibleDuplicateOf), never a rename of the old one.
function findExisting(vault, hash, text, explicitTitle = '') {
  const db = getDatabase()
  const exacts = db.prepare(
    `SELECT id, content_hash, body, title FROM notes WHERE vault_id = ?
     AND (CASE WHEN json_valid(frontmatter) THEN json_extract(frontmatter, '$.capture_hash') END) = ? ORDER BY created_at, id LIMIT 50`
  ).all(vault.id, hash)
  if (exacts.length) {
    if (!explicitTitle) return { ...exacts[0], exact: true }
    const same = exacts.find((r) => sameTitle(r.title, explicitTitle))
    return same ? { ...same, exact: true } : { ...exacts[0], exactOtherTitle: true }
  }
  // BRAIN2-W7 055: scan the WHOLE vault (keyset-paged), not just the most
  // recent SCAN_LIMIT notes. Jaccard >= NEAR_DUP_THRESHOLD implies a similar word
  // count, so word_count prefilters candidates before any body is loaded (stored
  // body adds a heading + frontmatter, hence the slack).
  const n = normalizeText(text).split(' ').filter(Boolean).length
  const lo = Math.floor(n * 0.85) - 5, hi = Math.ceil(n * 1.2) + 100
  const page = db.prepare(`SELECT id, content_hash, body FROM notes WHERE vault_id = ? AND id > ? AND word_count BETWEEN ? AND ? ORDER BY id LIMIT ${SCAN_LIMIT}`)
  let best = null, bestSim = 0, after = ''
  for (;;) {
    const rows = page.all(vault.id, after, lo, hi)
    for (const r of rows) {
      const s = similarity(fmTitleBody(r.body || ''), text)
      if (s > bestSim) { best = r; bestSim = s }
    }
    if (rows.length < SCAN_LIMIT) break
    after = rows[rows.length - 1].id
  }
  if (!best || bestSim < NEAR_DUP_THRESHOLD) return null
  return { ...best, near: true, safe: safeToAutoUpdate(fmTitleBody(best.body || ''), text) }
}

// BRAIN2-W7 054: identical text recaptured with a changed title, extra tags or a
// source URL used to report success while persisting nothing. Explicitly
// supplied metadata is now applied (tags are unioned, never dropped) and the
// response reports the PERSISTED title.
async function applyMetadataToExact({ orgId, userId, authorKind, existing, explicitTitle, cleanTags, sourceUrl }) {
  const cur = notesq.getNote({ orgId, userId, id: existing.id })
  if (!cur) return { noteId: existing.id, status: 'unchanged', title: explicitTitle || existing.title }
  let data = {}, content = cur.body || ''
  try { const m = matter(cur.body || ''); data = m.data || {}; content = m.content } catch { return { noteId: existing.id, status: 'unchanged', title: cur.title } }
  const props = { ...data }
  const have = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : []
  const tags = [...new Set([...have, ...cleanTags])]
  if (tags.length) props.tags = tags
  if (sourceUrl) props.source_url = sourceUrl
  let markdown = content
  if (explicitTitle) {
    const t = explicitTitle.replace(/[\r\n]+/g, ' ').slice(0, 200)
    markdown = /^\s*#\s+[^\n]*/.test(content) ? content.replace(/^(\s*)#\s+[^\n]*/, `$1# ${t}`) : `# ${t}\n\n${content}`
  }
  let out
  try { out = await notesq.updateNote({ orgId, userId, id: existing.id, markdown, properties: props, baseHash: cur.content_hash, authorKind }) } catch (e) {
    if (e instanceof notesq.NotesqError && e.status === 409) return { noteId: existing.id, status: 'unchanged', title: cur.title }
    throw e
  }
  return { noteId: existing.id, status: out.unchanged ? 'unchanged' : 'updated', title: out.note?.title || cur.title }
}

/**
 * @returns {Promise<{noteId:string, status:'created'|'updated'|'unchanged', title:string, possibleDuplicateOf?:string}>}
 */
export async function captureNote({ orgId, userId, scope = 'user', text, title, url, tags, pdfBase64, authorKind = 'agent', updateNoteId }, deps = {}) {
  if (scope !== 'org' && scope !== 'user') throw new CaptureError(400, 'invalid_scope')
  if (title != null && typeof title !== 'string') throw new CaptureError(400, 'invalid_title')
  if (url != null && typeof url !== 'string') throw new CaptureError(400, 'invalid_url')
  if (tags != null && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) throw new CaptureError(400, 'invalid_tags')
  let body = typeof text === 'string' ? text.trim() : ''
  let noteTitle = (title || '').trim()
  let sourceUrl = url ? String(url).trim() : ''
  let pdfMeta = null // BRAIN2-W7 057

  if (!body && pdfBase64) {
    if (String(pdfBase64).length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 8) throw new CaptureError(413, 'pdf_too_large')
    const buf = Buffer.from(String(pdfBase64), 'base64')
    const r = await (deps.pdfParse || defaultPdfParse)(buf)
    pdfMeta = pdfMetaOf(r)
    body = (r.text || '').trim()
    if (!noteTitle) noteTitle = (r.title || '').trim()
    if (!body) throw new CaptureError(422, 'no_extractable_text')
  } else if (!body && sourceUrl) {
    const got = await fetchUrl(sourceUrl, deps)
    sourceUrl = got.url
    if (looksPdf(got.body, got.contentType, got.url)) {
      const r = await (deps.pdfParse || defaultPdfParse)(got.body)
      pdfMeta = pdfMetaOf(r)
      body = (r.text || '').trim()
      if (!noteTitle) noteTitle = (r.title || '').trim()
    } else if (/html|xml|text\/plain/i.test(got.contentType) || !got.contentType) {
      const r = /text\/plain/i.test(got.contentType) ? { title: '', text: got.body.toString('utf8') } : extractReadable(got.body.toString('utf8'))
      body = r.text.trim()
      if (!noteTitle) noteTitle = r.title
    } else {
      throw new CaptureError(415, 'unsupported_content_type', { content_type: got.contentType })
    }
    if (!body) throw new CaptureError(422, 'no_extractable_text')
  }
  if (!body) throw new CaptureError(400, 'text_or_url_required')
  // Secrets never enter the brain (or the embedding provider) on capture.
  body = redactSecrets(body)
  noteTitle = redactSecrets(noteTitle)

  if (!noteTitle) noteTitle = body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) || 'Captured note'
  noteTitle = noteTitle.replace(/[\r\n]+/g, ' ').slice(0, 200)

  const hash = contentHash(body)
  const properties = { captured_via: 'brain_capture', capture_hash: hash }
  if (sourceUrl) properties.source_url = sourceUrl
  if (pdfMeta) Object.assign(properties, { pdf_truncated: true, pdf_pages_total: pdfMeta.pagesTotal, pdf_pages_captured: pdfMeta.pagesCaptured })
  const cleanTags = [...new Set((tags || []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
  if (cleanTags.length) properties.tags = cleanTags
  const markdown = `# ${noteTitle}\n\n${body}${sourceUrl ? `\n\nSource: ${sourceUrl}` : ''}\n`

  const vault = notesq.ensureNotesVault({ orgId, userId, scope })
  // BRAIN2-W7 053: lookup + create are one critical section per vault, or two
  // identical in-flight captures both miss and both create.
  const result = await notesq.withLock(`capture:${vault.id}`, async () => {
    const existing = findExisting(vault, hash, body, (title || '').trim() ? noteTitle : '')
    // The title already matches (case-insensitively), so only tags/source merge.
    if (existing && existing.exact) return applyMetadataToExact({ orgId, userId, authorKind, existing, explicitTitle: '', cleanTags, sourceUrl: url ? sourceUrl : '' })
    // BRAIN2-W7 052: a near-match is never overwritten implicitly (an added "not"
    // or a swapped party is still a different document). Replacing an existing
    // note needs an explicit target.
    if (updateNoteId) {
      const cur = notesq.getNote({ orgId, userId, id: updateNoteId })
      if (!cur) throw new CaptureError(404, 'update_target_not_found')
      const out = await notesq.updateNote({ orgId, userId, id: updateNoteId, markdown, properties, baseHash: cur.content_hash, authorKind })
      return { noteId: updateNoteId, status: out.unchanged ? 'unchanged' : 'updated', title: noteTitle }
    }
    const out = await notesq.createNote({ orgId, userId, scope, markdown, properties, authorKind })
    return { noteId: out.note.id, status: 'created', title: noteTitle, ...(existing ? { possibleDuplicateOf: existing.id } : {}) }
  })
  return pdfMeta ? { ...result, truncated: true, ...pdfMeta } : result
}

export function registerCaptureRoutes(app, { authenticate, deps } = {}) {
  app.post('/brain/capture', authenticate, async (req, res) => {
    // JWT user (CLI / dashboard acting directly) or service key + X-Org-Id /
    // X-User-Id (collector agent tool). Org + user come from auth, never the body.
    if (!req.user_id) return res.status(401).json({ error: 'unauthenticated' })
    // BRAIN2-W7 063: a direct JWT caller (dashboard/CLI) is a human unless it says
    // otherwise; the service-key path (collector agent tool) defaults to agent.
    try {
      const { text, title, url, tags, scope, pdf_base64, author_kind, update_note_id } = req.body || {}
      const out = await captureNote({
        orgId: req.org_id, userId: req.user_id, scope: scope || 'user', text, title, url, tags,
        pdfBase64: pdf_base64, authorKind: author_kind === 'human' || author_kind === 'agent' ? author_kind : (req.service ? 'agent' : 'human'), updateNoteId: typeof update_note_id === 'string' ? update_note_id : undefined
      }, deps)
      res.status(out.status === 'created' ? 201 : 200).json({
        noteId: out.noteId, status: out.status, created: out.status === 'created', updated: out.status === 'updated', title: out.title,
        ...(out.possibleDuplicateOf ? { possibleDuplicateOf: out.possibleDuplicateOf } : {}),
        ...(out.truncated ? { truncated: true, pagesTotal: out.pagesTotal, pagesCaptured: out.pagesCaptured } : {})
      })
    } catch (err) {
      if (err instanceof CaptureError) return res.status(err.status).json({ error: err.code, ...err.extra })
      if (err instanceof notesq.NotesqError) return res.status(err.status).json({ error: err.code, ...err.extra })
      console.error('[Brain] capture error:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })
}
