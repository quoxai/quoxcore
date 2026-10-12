/**
 * NotesQ split (AQ-9D P8), browser port of the pure helpers in
 * cli/lib/commands/notesBatch.js. Keep output identical to the CLI; the parity
 * test compares both on the same input.
 */
import JSZip from 'jszip'

// Mirrors MAX_BATCH_NOTES in services/collector/lib/notesq/import/index.js.
export const MAX_BATCH_NOTES = 200

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

/** Browser twin of the CLI buildBatchArchive for the `items` case. @returns {{blob: Blob, filename: string, notes: number}} */
export async function buildBatchArchive({ items, name }) {
  const zip = new JSZip()
  const root = name || 'batch'
  items.forEach((it, i) => { zip.file(`${root}/${String(i + 1).padStart(3, '0')}.md`, noteFile(it)) })
  const notes = items.length
  if (!notes) throw new Error('Nothing to write: the batch has no markdown notes.')
  if (notes > MAX_BATCH_NOTES) throw new Error(`A batch may create at most ${MAX_BATCH_NOTES} notes (this one has ${notes}). Split it into smaller batches.`)
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  return { blob, filename: `${root}.zip`, notes }
}

/** The same plan the CLI builds for `quox notes split --yes`. Returns null when there is nothing to split. */
export function planSplit(note, { level } = {}) {
  const plan = splitMarkdown(note.markdown, { level })
  if (plan.sections.length < 2) return null
  const id = note.id
  const title = plan.title || note.title || 'Untitled'
  const props = note.properties || {}
  const tags = (note.tags || props.tags || []).filter((t) => !/^batch-[0-9a-f]{8}$/.test(t))
  const items = plan.sections.map((sec, k) => ({
    title: sec.title,
    markdown: `# ${sec.title}\n\n${sec.body}\n`,
    collection: typeof props.collection === 'string' ? props.collection : undefined,
    tags,
    key: `split:${id}:${k}`,
  }))
  const parentMd = indexMarkdown({ title, preamble: plan.preamble, children: items.map((i) => i.title) })
  return { level: plan.level, title, items, parentMd, tooMany: items.length > MAX_BATCH_NOTES }
}
