'use strict';
/**
 * QuoxChat knowledge ingestion helpers (wave 5 product audit).
 *
 * Pure functions, no network. The upload and crawl routes compose them:
 *  - htmlToText / csvToText keep table structure ("Header: value | ...")
 *    so a column can never be swapped for its neighbour.
 *  - scanForInjection / scanChunks flag planted instructions at ingest.
 *  - inCrawlScope keeps a crawl inside the start URL's path prefix.
 */

const ROW_MARK = '\u0001';
const INDENT_MARK = '\u0002';

function cellText($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

// Serialise one <table> as header-labelled lines, one per data row.
function tableToLines($, table) {
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).children('th,td').toArray();
    if (cells.length === 0) return;
    rows.push({ cells: cells.map((c) => cellText($, c)), allTh: cells.every((c) => c.tagName === 'th') });
  });
  if (rows.length === 0) return [];
  let headers = null;
  let start = 0;
  if (rows[0].allTh) { headers = rows[0].cells; start = 1; }
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const parts = rows[i].cells
      .map((v, c) => ({ v, h: headers && headers[c] ? headers[c] : '' }))
      .filter((x) => x.v !== '')
      .map((x) => (x.h ? `${x.h}: ${x.v}` : x.v));
    if (parts.length) out.push(parts.join(' | '));
  }
  return out;
}

const DEFAULT_REMOVE = 'script, style, nav, footer, header';

/**
 * Visible body text of an HTML document with tables serialised as
 * "Header: value | Header: value" lines. `$` may be a loaded cheerio root or
 * an HTML string.
 */
function htmlToText(htmlOrRoot, opts = {}) {
  const cheerio = require('cheerio');
  const $ = typeof htmlOrRoot === 'string' ? cheerio.load(htmlOrRoot) : htmlOrRoot;
  $(opts.remove || DEFAULT_REMOVE).remove();
  $('table').each((_, t) => {
    const lines = tableToLines($, t);
    $(t).replaceWith(`${ROW_MARK}${lines.join(ROW_MARK)}${ROW_MARK}`);
  });
  // Wave 7: list items are their own lines ("- item"), nested lists indented
  // (\u0002 per level), and block elements are separated, so "£27.90" and the
  // next item can never fuse into "£27.90Band 1 can include:".
  $('li').each((_, li) => {
    const depth = Math.max(0, $(li).parents('ul,ol').length - 1);
    $(li).before(`${ROW_MARK}${INDENT_MARK.repeat(depth)}- `).after(ROW_MARK);
  });
  $('br').replaceWith(ROW_MARK);
  $('p, div, h1, h2, h3, h4, h5, h6, ul, ol, section, article, blockquote, dt, dd, pre, hr, figure, main').each((_, el) => {
    $(el).before(ROW_MARK).after(ROW_MARK);
  });
  return $('body').text().replace(/\s+/g, ' ').replace(/\s*\u0001\s*(?:\u0001\s*)*/g, '\n').replace(/\u0002/g, '  ').trim();
}

/**
 * Same labelled item stated with different figures by different sources
 * (docs: [{ id, text }]). Returns [{ label, values: [{ source, figures }] }]
 * for the admin; it never changes an answer.
 */
function findFigureConflicts(docs) {
  const byLabel = new Map(); // label -> Map(source -> Set(figure))
  const money = /[£$€]\s?\d[\d,]*(?:\.\d+)?/g;
  for (const d of Array.isArray(docs) ? docs : []) {
    for (const line of String(d.text || '').split('\n')) {
      const cells = line.split(/\s\|\s/);
      const head = cells.length > 1 ? cells[0].replace(/^[^:]*:\s*/, '').trim().toLowerCase() : '';
      for (const cell of cells) {
        const m = cell.match(/^\s*(?:-\s*)?([^:£$€]{2,70}?):\s*(.*)$/);
        if (!m) continue;
        const figs = (m[2].match(money) || []).map((f) => f.replace(/\s|,/g, ''));
        if (!figs.length) continue;
        const label = `${head ? `${head} / ` : ''}${m[1].trim().toLowerCase()}`;
        if (!byLabel.has(label)) byLabel.set(label, new Map());
        const per = byLabel.get(label);
        if (!per.has(d.id)) per.set(d.id, new Set());
        for (const f of figs) per.get(d.id).add(f);
      }
    }
  }
  const out = [];
  for (const [label, per] of byLabel) {
    if (per.size < 2) continue;
    const sets = [...per.values()].map((st) => [...st].sort().join(','));
    if (new Set(sets).size < 2) continue;
    out.push({ label, values: [...per].map(([source, st]) => ({ source, figures: [...st] })) });
  }
  return out.slice(0, 50);
}

// Minimal RFC 4180 parser: quoted cells, escaped quotes, commas and newlines in quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const CURRENCY_HEADER = [[/(^|[^a-z])gbp([^a-z]|$)/i, '£'], [/(^|[^a-z])usd([^a-z]|$)/i, '$'], [/(^|[^a-z])eur([^a-z]|$)/i, '€']];

/** CSV as "header: value | header: value" lines. Empty cells are dropped. */
function csvToText(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return String(csv || '');
  const headers = rows[0].map((h) => h.trim());
  const syms = headers.map((h) => { const m = CURRENCY_HEADER.find(([re]) => re.test(h)); return m ? m[1] : ''; });
  return rows.slice(1).map((r) => r
    .map((v, c) => ({ v: v.trim(), h: headers[c] || '', sym: syms[c] || '' }))
    .filter((x) => x.v !== '')
    .map((x) => {
      const val = x.sym && /^\d[\d,]*(?:\.\d+)?$/.test(x.v) ? `${x.sym}${x.v}` : x.v;
      return x.h ? `${x.h}: ${val}` : val;
    })
    .join(' | ')).filter(Boolean).join('\n');
}

// Strong: an instruction aimed at the assistant, planted in a document. Such a
// chunk is excluded from the prompt. Weak: phrases that legitimately appear in
// docs about prompts; counted on the source, never excluded.
const STRONG_PATTERNS = [
  /\b(?:system|admin(?:istrator)?|developer|operator|security)\s+(?:notice|message|override|instruction|directive|update|alert)s?\b[^.\n]{0,25}\b(?:to|for)\s+(?:the\s+)?(?:assistant|ai|bot|chatbot|model|agent|llm)\b/i,
  /\b(?:note|message|instruction)s?\s+(?:to|for)\s+(?:the\s+)?(?:assistant|ai|chatbot|model|llm)\b/i,
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)/i,
  /reveal\s+(?:your|the)\s+(?:instructions|prompt|system)/i,
  /repeat\s+(?:everything|all)\s+(?:above|before)/i,
  /\b(?:ask|tell|require|request)\s+(?:the\s+)?(?:visitor|customer|user)s?\s+(?:for|to\s+(?:provide|send|share|enter|email))\b[^.\n]{0,40}\b(?:card|password|cvv|pin|otp)\b/i,
  /\b(?:email|send|forward)\b[^.\n]{0,40}\b(?:card number|password|cvv)\b/i,
];
// Wave 6: imperative notices addressed to the AI that a boundary split hid.
STRONG_PATTERNS.push(
  /\b(?:important|urgent|attention|notice|warning|attn)\b[^.\n]{0,40}\b(?:for|to)\s+(?:the\s+)?(?:ai|assistant|bot|chatbot|llm|model)\b/i,
  /\b(?:attention|hey|hello|dear)[,:]?\s+(?:ai|assistant|chatbot|bot|llm)\b/i,
  /\b(?:always\s+)?tell\s+(?:every|each|all|any)\s+(?:visitor|customer|user)s?\b/i,
);
const WEAK_PATTERNS = [
  /\bDAN\b.*\b(?:do|anything|now)\b/,
  /you\s+are\s+now\s+/i,
  /system\s*prompt/i,
];

/** { level: 'none'|'low'|'high', flags: string[] } for one piece of text. */
function scanForInjection(text) {
  const s = String(text || '');
  const flags = [];
  let level = 'none';
  for (const p of STRONG_PATTERNS) if (p.test(s)) { flags.push(p.source.slice(0, 30)); level = 'high'; }
  for (const p of WEAK_PATTERNS) if (p.test(s)) { flags.push(p.source.slice(0, 30)); if (level === 'none') level = 'low'; }
  return { level, flags };
}

/**
 * Scan chunks ({text,index}). Returns chunks with `injection: 'high'|'low'`
 * set where flagged, and counts for the source row.
 *
 * Wave 6: each chunk is also scanned joined to the tail of the previous one
 * (a planted instruction split over a boundary), and `opts.fullText` (the
 * whole document before chunking) is scanned too. When ANY of those scores
 * high the whole source is quarantined: every chunk becomes 'high' (the
 * retrieval filters already exclude 'high') and `quarantined` is true.
 */
function scanChunks(chunks, opts = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const TAIL = 240;
  let flagged = 0;
  let high = 0;
  let anyHigh = false;
  if (opts.fullText && scanForInjection(opts.fullText).level === 'high') anyHigh = true;
  const out = list.map((c, i) => {
    let r = scanForInjection(c && c.text);
    if (i > 0) {
      const prev = String((list[i - 1] && list[i - 1].text) || '');
      const joined = scanForInjection(`${prev.slice(-TAIL)} ${(c && c.text) || ''}`);
      if (joined.level === 'high') r = joined;
      else if (joined.level === 'low' && r.level === 'none') r = joined;
    }
    if (r.level === 'high') anyHigh = true;
    if (r.level === 'none') return c;
    return { ...c, injection: r.level };
  });
  if (anyHigh) {
    const all = out.map((c) => ({ ...c, injection: 'high' }));
    return { chunks: all, flagged: all.length, high: all.length, quarantined: all.length > 0 };
  }
  for (const c of out) if (c && c.injection) { flagged++; if (c.injection === 'high') high++; }
  return { chunks: out, flagged, high, quarantined: false };
}

/**
 * Sentence-aware chunker. A chunk never starts mid-word: after the overlap
 * step the start snaps forward to a sentence start (or at least a word start).
 */
function chunkText(text, { size = 1000, overlap = 200, maxChunks = Infinity } = {}) {
  const t = String(text || '');
  const chunks = [];
  let pos = 0;
  let idx = 0;
  while (pos < t.length && chunks.length < maxChunks) {
    let end = Math.min(pos + size, t.length);
    if (end < t.length) {
      for (let i = end; i >= Math.max(pos + size * 0.7, pos); i--) {
        if ('.!?'.includes(t[i]) && (i + 1 >= t.length || /\s/.test(t[i + 1]))) { end = i + 1; break; }
      }
    }
    const piece = t.slice(pos, end).trim();
    if (piece) chunks.push({ text: piece, index: idx++ });
    if (end >= t.length) break;
    let next = Math.max(end - overlap, pos + Math.floor(size * 0.3));
    if (next > 0 && !/\s/.test(t[next - 1]) && !/\s/.test(t[next] || ' ')) {
      // mid-word: prefer the next sentence start within reach, else the next word start
      const win = t.slice(next, Math.min(next + overlap, end));
      const sm = win.match(/[.!?]\s+(?=\S)/);
      const wm = win.match(/\s+(?=\S)/);
      if (sm) next += sm.index + sm[0].length;
      else if (wm) next += wm.index + wm[0].length;
      // no whitespace anywhere in reach (a blob): keep the cut rather than lose text
    }
    if (next <= pos) next = end;
    pos = next;
  }
  return chunks;
}

/**
 * Parse robots.txt for one user agent. The most specific matching group wins
 * (our agent token, else *). Longest matching rule wins; Allow beats Disallow
 * on a tie. Empty Disallow allows everything.
 */
function parseRobots(body, agent) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if (k === 'allow' || k === 'disallow') {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: k === 'allow', path: v });
    } else lastWasAgent = false;
  }
  const a = String(agent || '').toLowerCase();
  const token = a.split('/')[0];
  const own = groups.filter((g) => g.agents.some((x) => x !== '*' && (token.includes(x) || x.includes(token))));
  const star = groups.filter((g) => g.agents.includes('*'));
  const rules = (own.length ? own : star).flatMap((g) => g.rules);
  return {
    allowed(pathAndQuery) {
      const p = String(pathAndQuery || '/') || '/';
      let best = null;
      for (const r of rules) {
        if (r.path === '') continue;
        const pat = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
        let re;
        try { re = new RegExp(`^${pat}`); } catch { continue; }
        if (!re.test(p)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

/**
 * Crawl scope. With `stay` (default on) a link is followed only when it is on
 * the start URL's host and at or under its path prefix, so a depth-1 crawl of
 * /bank-holidays does not ingest /cookies.
 */
function inCrawlScope(startUrl, candidateUrl, stay = true) {
  try {
    const a = new URL(startUrl);
    const b = new URL(candidateUrl);
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    if (!stay) return true;
    const base = a.pathname.replace(/\/+$/, '');
    if (!base) return true;
    const p = b.pathname.replace(/\/+$/, '');
    return p === base || p.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

// ── Binary formats ──────────────────────────────────────────────────────────
const JSZip = require('jszip');

class UnsupportedBinaryError extends Error {
  constructor(msg) { super(msg); this.name = 'UnsupportedBinaryError'; this.code = 'unsupported_binary'; }
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function wordRunText(xml) {
  return decodeXml(String(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, '$1\u0000')
    .replace(/<[^>]+>/g, '')
    .replace(/\u0000/g, ''));
}

/** DOCX body text: paragraphs on their own lines, tables as "cell | cell" rows. */
async function docxToText(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new UnsupportedBinaryError(`not a readable DOCX: ${e.message}`); }
  const f = zip.file('word/document.xml');
  if (!f) throw new UnsupportedBinaryError('not a DOCX (word/document.xml missing)');
  const xml = await f.async('string');
  const out = [];
  const body = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((m) => {
      const cells = [...m[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
        [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => wordRunText(p[0]).trim()).filter(Boolean).join(' '));
      return cells.join(' | ');
    }).filter((r) => r.replace(/\|/g, '').trim());
    return `<w:p><w:r><w:t>\u0002${rows.join('\u0002')}\u0002</w:t></w:r></w:p>`;
  });
  for (const m of body.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const t = wordRunText(m[0]);
    if (t.includes('\u0002')) { t.split('\u0002').map((x) => x.trim()).filter(Boolean).forEach((x) => out.push(x)); continue; }
    if (t.trim()) out.push(t.trim());
  }
  return out.join('\n');
}

function colIndex(ref) {
  const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

/** XLSX sheets as "Sheet: name" + header-keyed rows ("Header: value | ..."). */
async function xlsxToText(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new UnsupportedBinaryError(`not a readable XLSX: ${e.message}`); }
  const wb = zip.file('xl/workbook.xml');
  if (!wb) throw new UnsupportedBinaryError('not an XLSX (xl/workbook.xml missing)');
  const shared = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) {
    const sx = await ss.async('string');
    for (const m of sx.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
      shared.push(decodeXml([...m[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    }
  }
  const wbXml = await wb.async('string');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  const relMap = {};
  if (rels) for (const m of (await rels.async('string')).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]); const tg = /Target="([^"]+)"/.exec(m[0]);
    if (id && tg) relMap[id[1]] = tg[1].replace(/^\/?(xl\/)?/, '');
  }
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => {
    const name = /name="([^"]*)"/.exec(m[0]);
    const rid = /r:id="([^"]+)"/.exec(m[0]);
    return { name: decodeXml(name ? name[1] : `Sheet${i + 1}`), path: (rid && relMap[rid[1]]) ? `xl/${relMap[rid[1]]}` : `xl/worksheets/sheet${i + 1}.xml` };
  });
  const blocks = [];
  for (const sh of sheets) {
    const f = zip.file(sh.path);
    if (!f) continue;
    const sx = await f.async('string');
    const rows = [];
    for (const rm of sx.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      const cells = [];
      for (const cm of rm[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]; const inner = cm[2] || '';
        const ref = /r="([^"]+)"/.exec(attrs);
        const type = /t="([^"]+)"/.exec(attrs);
        let val = '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (type && type[1] === 's' && v) val = shared[Number(v[1])] || '';
        else if (type && type[1] === 'inlineStr') val = decodeXml([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
        else if (v) val = decodeXml(v[1]);
        cells[ref ? colIndex(ref[1]) : cells.length] = String(val).trim();
      }
      if (cells.some((c) => c)) rows.push(Array.from(cells, (c) => c || ''));
    }
    if (rows.length === 0) continue;
    const headers = rows[0];
    const lines = rows.length === 1 ? [headers.filter(Boolean).join(' | ')] : rows.slice(1).map((r) =>
      r.map((v, c) => (v ? (headers[c] ? `${headers[c]}: ${v}` : v) : '')).filter(Boolean).join(' | ')).filter(Boolean);
    blocks.push(`Sheet: ${sh.name}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** True when a buffer starts with a zip local-file header. */
function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** True when decoded text is mostly non-printable (binary read as UTF-8). */
function mostlyNonPrintable(text) {
  const s = String(text || '').slice(0, 20000);
  if (!s) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) bad++;
  }
  return bad / s.length > 0.1;
}

/**
 * Text from a non-PDF upload buffer. DOCX/XLSX are parsed; any other zip or
 * binary-looking content throws UnsupportedBinaryError (route answers 422).
 */
async function extractUploadText(buffer, fileName, mimeType) {
  const name = String(fileName || '');
  const mime = String(mimeType || '');
  const isDocx = /\.docx$/i.test(name) || /wordprocessingml/.test(mime);
  const isXlsx = /\.xlsx$/i.test(name) || /spreadsheetml/.test(mime);
  if (isDocx || (isZip(buffer) && !isXlsx && !isDocx && (await JSZip.loadAsync(buffer).then((z) => !!z.file('word/document.xml')).catch(() => false)))) {
    return docxToText(buffer);
  }
  if (isXlsx || (isZip(buffer) && (await JSZip.loadAsync(buffer).then((z) => !!z.file('xl/workbook.xml')).catch(() => false)))) {
    return xlsxToText(buffer);
  }
  if (isZip(buffer)) throw new UnsupportedBinaryError('unsupported archive format; upload DOCX, XLSX, PDF, HTML, CSV or plain text');
  const text = buffer.toString('utf-8');
  if (mostlyNonPrintable(text)) throw new UnsupportedBinaryError('binary file content is not supported; upload DOCX, XLSX, PDF, HTML, CSV or plain text');
  if (mime === 'text/html' || /\.html?$/i.test(name)) return htmlToText(text);
  if (mime === 'text/csv' || /\.csv$/i.test(name)) return csvToText(text);
  return text;
}

/** "Columns: a, b, c" line for a CSV, or '' when it has no header row. */
function csvHeaderLine(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return '';
  const h = rows[0].map((x) => x.trim()).filter(Boolean);
  return h.length ? `Columns: ${h.join(', ')}` : '';
}

/**
 * Chunk line-oriented text on line boundaries (never mid-row); every chunk
 * starts with `prefix` so a chunk of rows always carries its header context.
 */
function chunkLines(text, { prefix = '', size = 1000 } = {}) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  const chunks = [];
  let cur = [];
  let len = prefix.length;
  const flush = () => {
    if (cur.length) { chunks.push({ text: (prefix ? `${prefix}\n` : '') + cur.join('\n'), index: chunks.length }); }
    cur = []; len = prefix.length;
  };
  for (const l of lines) {
    if (cur.length && len + l.length + 1 > size) flush();
    cur.push(l); len += l.length + 1;
  }
  flush();
  return chunks;
}

module.exports = {
  htmlToText, findFigureConflicts, csvToText, parseCsv, scanForInjection, scanChunks, chunkText, parseRobots, inCrawlScope,
  docxToText, xlsxToText, extractUploadText, UnsupportedBinaryError, isZip, mostlyNonPrintable, csvHeaderLine, chunkLines,
};
