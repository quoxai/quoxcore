'use strict';

/**
 * Obsidian vault (.zip) and plain markdown (.md / .zip of .md) parser. Pure.
 * Same parsed model as enex.js. Wikilinks are kept as-is (Qortex resolves
 * them). Embeds that exist in the archive become attachment placeholders.
 */

const crypto = require('node:crypto');
const JSZip = require('jszip');
const { parseFrontmatter } = require('./frontmatter.js');
const { MAX_ATTACHMENT_BYTES, mimeFromName } = require('./attachments.js');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const baseName = (p) => p.replace(/^.*\//, '');
const isMd = (p) => /\.(md|markdown)$/i.test(p);

const hidden = (p) => p.split('/').some((seg) => seg.startsWith('.'));

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// Normalise a relative path against a directory; null if it escapes the vault.
function resolveRel(dir, rel) {
  const parts = (rel.startsWith('/') ? rel.slice(1) : (dir ? `${dir}/${rel}` : rel)).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

function normaliseTags(v) {
  const list = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  return list.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean);
}

/**
 * @param {Buffer} input zip or markdown bytes
 * @param {{filename?:string, collection?:string, source?:'obsidian'|'markdown', kind?:'zip'|'md'}} [opts]
 */
async function parseObsidian(input, opts = {}) {
  const source = opts.source || 'obsidian';
  const fname = String(opts.filename || '').replace(/^.*[\\/]/, '');
  const isZip = opts.kind ? opts.kind === 'zip' : /\.zip$/i.test(fname);
  const warnings = [];
  const files = new Map(); // vault-relative path -> () => Promise<Buffer>
  let rootName = fname.replace(/\.(zip|md|markdown)$/i, '').trim();

  if (opts.files) {
    // Pre-extracted archive (notion.js): path -> reader, already unwrapped.
    for (const [k, v] of opts.files) files.set(k, v);
    if (opts.rootName) rootName = opts.rootName;
  } else if (isZip) {
    const zip = await JSZip.loadAsync(input);
    const entries = Object.values(zip.files).filter((f) => !f.dir && !hidden(f.name) && !f.name.startsWith('__MACOSX/'));
    const tops = new Set(entries.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : null)));
    // A zipped vault folder wraps everything in one directory: peel it, use its name.
    let strip = '';
    if (tops.size === 1 && !tops.has(null)) { strip = [...tops][0] + '/'; rootName = strip.slice(0, -1); }
    for (const f of entries) files.set(f.name.slice(strip.length), () => f.async('nodebuffer'));
  } else {
    files.set(fname || 'note.md', async () => (Buffer.isBuffer(input) ? input : Buffer.from(String(input))));
  }
  if (!rootName) rootName = source === 'markdown' ? 'Markdown import' : 'Obsidian';

  // Attachment lookup: by full path, then by unique basename (Obsidian's rule).
  const byBase = new Map();
  for (const p of files.keys()) {
    if (isMd(p)) continue;
    const b = baseName(p).toLowerCase();
    byBase.set(b, byBase.has(b) ? null : p); // null = ambiguous
  }

  const blobs = new Map();
  const notes = [];
  const loadBlob = async (path) => {
    const buf = await files.get(path)();
    if (buf.length > MAX_ATTACHMENT_BYTES) return { tooBig: true, size: buf.length };
    const sha = sha256(buf);
    if (!blobs.has(sha)) blobs.set(sha, buf);
    return { sha, size: buf.length };
  };

  for (const [path, read] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isMd(path)) continue;
    const raw = (await read()).toString('utf8');
    // opts.pageMeta (notion.js) supplies body, props, tags, collection and ref itself.
    const meta = opts.pageMeta ? opts.pageMeta(path, raw) : null;
    const fm = meta ? { props: { ...meta.props, title: meta.title }, body: meta.body, warnings: [] } : parseFrontmatter(raw);
    for (const w of fm.warnings) warnings.push(`${path}: ${w}`);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const stem = baseName(path).replace(/\.(md|markdown)$/i, '');
    // Batch (session-authored) notes name their own collection in frontmatter; no folder-name fallback to the archive root.
    const fmCollection = opts.batch && typeof fm.props.collection === 'string' && fm.props.collection.trim() ? fm.props.collection.trim() : null;
    const collection = opts.collection || fmCollection || (meta && meta.collection) || (path.includes('/') ? path.split('/')[0] : (opts.batch ? null : rootName));

    const attachments = [];
    const embed = async (name, target) => {
      let hit = null;
      const direct = resolveRel(dir, target);
      if (direct && files.has(direct) && !isMd(direct)) hit = direct;
      else if (direct !== null && files.has(target) && !isMd(target)) hit = target;
      else if (!target.includes('/')) hit = byBase.get(target.toLowerCase()) || null;
      else hit = byBase.get(baseName(target).toLowerCase()) || null;
      if (!hit) return null;
      const b = await loadBlob(hit);
      if (b.tooBig) { warnings.push(`${path}: embed "${target}" skipped (over 25 MB)`); return undefined; }
      attachments.push({ sha: b.sha, name: name || baseName(hit), mime: mimeFromName(hit), size: b.size });
      return `{{quox-att:${attachments.length - 1}}}`;
    };

    // Resolve embeds sequentially (async replace).
    let body = fm.body;
    const replaceAsync = async (re, fn) => {
      const parts = []; let last = 0; let m;
      re.lastIndex = 0;
      while ((m = re.exec(body)) !== null) { parts.push(body.slice(last, m.index), fn(m)); last = m.index + m[0].length; }
      parts.push(body.slice(last));
      const out = [];
      for (const p of parts) out.push(typeof p === 'string' ? p : await p);
      body = out.join('');
    };
    // ![[file.png]] / ![[file.png|alias]]; note transclusions (no non-md extension) stay as-is.
    await replaceAsync(/!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, async (m) => {
      const target = m[1].trim();
      if (!/\.[A-Za-z0-9]+$/.test(target) || isMd(target)) return m[0];
      const r = await embed(null, target);
      if (r === null) { warnings.push(`${path}: embed "${target}" not found in archive`); return m[0]; }
      return r === undefined ? m[0] : r;
    });
    // ![alt](rel/path.png)
    await replaceAsync(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, async (m) => {
      const target = safeDecode(m[2]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('data:')) return m[0];
      const r = await embed(null, target);
      if (r === null) { warnings.push(`${path}: embed "${target}" not found in archive`); return m[0]; }
      return r === undefined ? m[0] : r;
    });

    const h1 = /^\s*#\s+(.+)$/m.exec(body.slice(0, 2000));
    const title = (fm.props.title && typeof fm.props.title === 'string' ? fm.props.title : (body.trimStart().startsWith('# ') && h1 ? h1[1] : stem)).trim() || stem;
    const hasLeadH1 = /^\s*#\s+\S/.test(body);
    const markdown = (hasLeadH1 ? body.trimStart() : `# ${title}\n\n${body.trimStart()}`).trimEnd() + '\n';

    const props = { ...fm.props };
    delete props.title;
    let tags = [];
    if (props.tags !== undefined) { tags = normaliseTags(props.tags); delete props.tags; }
    if (meta && meta.tags) tags = meta.tags;
    // Batch: frontmatter `key` names the note for re-runs; else archive-root/path, so two subjects' index.md never collide.
    let batchKey = null;
    if (opts.batch) { batchKey = typeof props.key === 'string' && props.key.trim() ? props.key.trim() : `${rootName}/${path}`; delete props.key; }
    const ref = (meta && meta.ref) || sha1(batchKey !== null ? `batch\n${batchKey}` : `${source}\n${path}`);
    Object.assign(props, { source, import_ref: ref });
    if (collection) props.collection = collection; else delete props.collection;
    notes.push({ title, markdown, properties: props, tags, collection, ref, attachments });
  }
  if (!notes.length) warnings.push('no markdown files found');
  return { format: opts.batch ? 'batch' : (source === 'markdown' ? 'markdown' : (source === 'notion' ? 'notion' : 'obsidian')), notes, blobs, warnings };
}

module.exports = { parseObsidian };
