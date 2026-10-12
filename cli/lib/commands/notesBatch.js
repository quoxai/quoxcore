/**
 * NotesQ session bulk authoring (AQ-9D P8): pure helpers behind
 * `quox notes batch` and `quox notes split`. A batch travels as a zip of
 * markdown files (frontmatter: title, collection, tags, key) and is parsed
 * server-side by the import pipeline's `batch` format.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative } from 'path';
import { QuoxError } from '../core/errors.js';

// Mirrors MAX_BATCH_NOTES in services/collector/lib/notesq/import/index.js.
export const MAX_BATCH_NOTES = 200;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

// The server's frontmatter reader strips one pair of quotes and does no escape
// processing, so pick the quote the value does not contain.
function yamlStr(v) {
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/"/g, "'")}"`;
}

/** One note as a markdown file with the frontmatter the batch parser reads. */
export function noteFile({ title, markdown, collection, tags, key }) {
  const fm = [];
  if (title) fm.push(`title: ${yamlStr(title)}`);
  if (collection) fm.push(`collection: ${yamlStr(collection)}`);
  if (key) fm.push(`key: ${yamlStr(key)}`);
  const list = (tags || []).map((t) => String(t).trim()).filter(Boolean);
  if (list.length) { fm.push('tags:'); for (const t of list) fm.push(`  - ${yamlStr(t)}`); }
  return `${fm.length ? `---\n${fm.join('\n')}\n---\n` : ''}${String(markdown || '')}`;
}

/** JSONL text -> items. Each line: {title, markdown|body, collection?, tags?, key?}. Key defaults to the title, so a re-run skips. */
export function parseJsonl(text) {
  const items = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch (e) { throw new QuoxError(`JSONL line ${i + 1} is not valid JSON: ${e.message}`, 2); }
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const markdown = typeof o.markdown === 'string' ? o.markdown : (typeof o.body === 'string' ? o.body : '');
    if (!title) throw new QuoxError(`JSONL line ${i + 1} has no title.`, 2);
    if (o.tags !== undefined && !Array.isArray(o.tags)) throw new QuoxError(`JSONL line ${i + 1}: tags must be an array.`, 2);
    items.push({ title, markdown, collection: typeof o.collection === 'string' ? o.collection : undefined, tags: o.tags || [], key: typeof o.key === 'string' && o.key ? o.key : title });
  });
  return items;
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else if (st.isFile()) out.push({ path: relative(root, p).split('\\').join('/'), size: st.size, read: () => readFileSync(p) });
  }
  return out;
}

/**
 * Build the zip for a batch. `source` is a folder (markdown + any embedded
 * files, sent as-is), a .jsonl file, or '-' with `stdinText` holding JSONL.
 * `items` (already-built notes, used by split) bypasses `source`.
 * @returns {{bytes: Buffer, filename: string, notes: number}}
 */
export async function buildBatchArchive({ source, stdinText, items, name }) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  let root;
  let notes = 0;
  const addItems = (list, rootName) => {
    root = rootName;
    list.forEach((it, i) => { zip.file(`${root}/${String(i + 1).padStart(3, '0')}.md`, noteFile(it)); });
    notes = list.length;
  };
  if (items) addItems(items, name || 'batch');
  else if (source === '-') addItems(parseJsonl(stdinText), name || 'stdin');
  else {
    let st;
    try { st = statSync(source); } catch (e) { throw new QuoxError(`Cannot read ${source}: ${e.message}`, 2); }
    if (st.isDirectory()) {
      root = name || basename(source.replace(/[\\/]+$/, '')) || 'batch';
      const files = walk(source, source, []);
      let total = 0;
      for (const f of files) {
        total += f.size;
        if (total > MAX_ARCHIVE_BYTES) throw new QuoxError(`${source} is over the 100 MB batch limit.`, 2);
        zip.file(`${root}/${f.path}`, f.read());
        if (/\.(md|markdown)$/i.test(f.path)) notes++;
      }
    } else if (/\.jsonl$/i.test(source)) {
      addItems(parseJsonl(readFileSync(source, 'utf8')), name || basename(source).replace(/\.jsonl$/i, ''));
    } else {
      throw new QuoxError(`${source} is not a folder or a .jsonl file (use - to read JSONL from stdin).`, 2);
    }
  }
  if (!notes) throw new QuoxError('Nothing to write: the batch has no markdown notes.', 2);
  if (notes > MAX_BATCH_NOTES) throw new QuoxError(`A batch may create at most ${MAX_BATCH_NOTES} notes (this one has ${notes}). Split it into smaller batches.`, 2);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { bytes, filename: `${root}.zip`, notes };
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
// Characters that would break a [[wikilink]] to the child.
const cleanTitle = (t) => t.replace(/[[\]|#^]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Cut a note at its headings. Level defaults to the shallowest heading below
 * the title H1. Headings inside code fences are ignored. Text before the first
 * cut stays with the parent; deeper headings inside a section are promoted so
 * the child reads as a note of its own.
 * @returns {{title:string|null, preamble:string, level:number|null, sections:{title:string, body:string}[]}}
 */
export function splitMarkdown(markdown, { level } = {}) {
  const lines = String(markdown || '').split('\n');
  const heads = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = HEADING.exec(line);
    if (m) heads.push({ i, level: m[1].length, text: m[2] });
  });
  let title = null;
  let start = 0;
  const first = heads[0];
  if (first && first.level === 1 && lines.slice(0, first.i).every((l) => !l.trim())) { title = first.text.trim(); start = first.i + 1; }
  const below = heads.filter((h) => h.i >= start && (title === null || h.level > 1));
  const lvl = level ? Number(level) : (below.length ? Math.min(...below.map((h) => h.level)) : null);
  const cuts = below.filter((h) => h.level === lvl);
  if (cuts.length < 2) return { title, preamble: '', level: lvl, sections: [] };
  const preamble = lines.slice(start, cuts[0].i).join('\n').trim();
  const seen = new Map();
  const sections = cuts.map((c, k) => {
    const end = k + 1 < cuts.length ? cuts[k + 1].i : lines.length;
    let fence = false;
    const body = lines.slice(c.i + 1, end).map((l) => {
      if (FENCE.test(l)) { fence = !fence; return l; }
      if (fence) return l;
      const m = HEADING.exec(l);
      return m && m[1].length > lvl ? `${'#'.repeat(Math.max(m[1].length - lvl + 1, 2))} ${m[2]}` : l;
    }).join('\n').trim();
    let t = cleanTitle(c.text) || `Part ${k + 1}`;
    const n = (seen.get(t) || 0) + 1;
    seen.set(t, n);
    if (n > 1) t = `${t} (${n})`;
    return { title: t, body };
  });
  return { title, preamble, level: lvl, sections };
}

/** The parent after a split: its own preamble, then links to every child. */
export function indexMarkdown({ title, preamble, children }) {
  const head = `# ${title}\n\n${preamble ? `${preamble}\n\n` : ''}`;
  return `${head}## Contents\n\n${children.map((c) => `- [[${c}]]`).join('\n')}\n`;
}
