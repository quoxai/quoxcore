'use strict';

/**
 * Evernote .enex parser. Pure: bytes in, a parsed import model out (no
 * network, no writes). en-media hashes resolve to attachment placeholders
 * ({{quox-att:N}}) that run.js swaps for the uploaded file reference.
 *
 * Parsed model (shared with obsidian.js):
 *   { format, notes: [{ title, markdown, properties, tags, collection, ref,
 *       attachments: [{ sha, name, mime, size }] }],
 *     blobs: Map<sha256, Buffer>, warnings: [string] }
 */

const crypto = require('node:crypto');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const { MAX_ATTACHMENT_BYTES, extFromMime } = require('./attachments.js');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

// 20240102T030405Z -> 2024-01-02T03:04:05.000Z
function enexDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(String(s || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

function makeTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
  // Tables and underline have no markdown form: keep them as HTML.
  td.keep(['table', 'u']);
  td.addRule('strike', { filter: ['s', 'strike', 'del'], replacement: (c) => `~~${c}~~` });
  // Evernote code is a bare <pre> (turndown fences only <pre><code>).
  td.addRule('barePre', {
    filter: (n) => n.nodeName === 'PRE' && !(n.firstChild && n.firstChild.nodeName === 'CODE'),
    replacement: (_c, n) => `\n\n\`\`\`\n${n.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`,
  });
  return td;
}

// Evernote bodies are div soup: <div>text</div> per line, <div><br/></div> for blanks.
function enmlToMarkdown(enml, resources, warnings, title) {
  const $ = cheerio.load(`<root>${enml}</root>`, { xmlMode: true });
  const attachments = [];
  // <div><br/></div> is Evernote's blank line: paragraph spacing already covers it.
  $('div').each((_, el) => { if ($(el).html().trim().replace(/\s+/g, '') === '<br/>') $(el).remove(); });
  $('en-crypt').each((_, el) => {
    warnings.push(`encrypted block skipped in "${title}"`);
    $(el).remove();
  });
  $('en-todo').each((_, el) => {
    $(el).replaceWith($(el).attr('checked') === 'true' ? '{{todo:x}}' : '{{todo: }}');
  });
  $('en-media').each((_, el) => {
    const hash = String($(el).attr('hash') || '').toLowerCase();
    const r = resources.get(hash);
    if (!r) {
      warnings.push(`attachment missing for "${title}" (hash ${hash.slice(0, 8)})`);
      $(el).remove();
      return;
    }
    if (r.size > MAX_ATTACHMENT_BYTES) {
      warnings.push(`attachment "${r.name}" in "${title}" skipped (over 25 MB)`);
      $(el).remove();
      return;
    }
    attachments.push({ sha: r.sha, name: r.name, mime: r.mime, size: r.size });
    $(el).replaceWith(`{{quox-att:${attachments.length - 1}}}`);
  });
  // Serialise as HTML for turndown: explicit close tags for empties.
  const html = $('root').html().replace(/<(br|hr)\s*\/>/g, '<$1>');
  let md = makeTurndown().turndown(html);
  md = md
    .replace(/^(\s*(?:[-*+]|\d+\.)\s+)\{\{todo:(x| )\}\}\s*/gm, '$1[$2] ')
    .replace(/^\{\{todo:(x| )\}\}\s*/gm, '- [$1] ')
    .replace(/\{\{todo:(x| )\}\}\s*/g, '[$1] ')
    .replace(/^(- \[[ x]\] .*)\n\n(?=- \[[ x]\] )/gm, '$1\n');
  return { md: md.trim(), attachments };
}

/**
 * @param {Buffer|string} input .enex file bytes
 * @param {{filename?:string, collection?:string}} [opts]
 */
function parseEnex(input, opts = {}) {
  const xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const warnings = [];
  const $ = cheerio.load(xml, { xmlMode: true });
  if (!$('en-export').length) throw new Error('not an Evernote export (no en-export element)');
  const base = String(opts.filename || '').replace(/^.*[\\/]/, '').replace(/\.enex$/i, '').trim();
  const notebook = opts.collection || base || 'Evernote';
  const blobs = new Map();
  const notes = [];

  $('en-export > note').each((_, noteEl) => {
    const n = $(noteEl);
    const title = (n.children('title').text() || '').trim() || 'Untitled';
    const resources = new Map(); // md5 hex -> resource
    n.children('resource').each((__, rEl) => {
      const r = $(rEl);
      const bytes = Buffer.from((r.children('data').text() || '').replace(/\s+/g, ''), 'base64');
      if (!bytes.length) return;
      const mime = (r.children('mime').text() || '').trim() || 'application/octet-stream';
      const h = md5(bytes);
      const s = sha256(bytes);
      const name = (r.find('resource-attributes > file-name').first().text() || '').trim() || `attachment-${h.slice(0, 6)}.${extFromMime(mime)}`;
      resources.set(h, { sha: s, name, mime, size: bytes.length });
      if (bytes.length <= MAX_ATTACHMENT_BYTES && !blobs.has(s)) blobs.set(s, bytes);
    });
    const { md, attachments } = enmlToMarkdown(n.children('content').text() || '', resources, warnings, title);
    const created = enexDate(n.children('created').text());
    const updated = enexDate(n.children('updated').text());
    const tags = n.children('tag').map((__, t) => $(t).text().trim()).get().filter(Boolean);
    const props = { source: 'evernote', import_ref: sha1(`${notebook}\n${title}\n${created || ''}`), collection: notebook };
    if (created) props.created = created;
    if (updated) props.updated = updated;
    const srcUrl = (n.find('note-attributes > source-url').first().text() || '').trim();
    if (srcUrl) props.source_url = srcUrl;
    notes.push({
      title,
      markdown: `# ${title}\n\n${md}`.trimEnd() + '\n',
      properties: props,
      tags,
      collection: notebook,
      ref: props.import_ref,
      attachments,
    });
  });
  return { format: 'evernote', notes, blobs, warnings };
}

module.exports = { parseEnex, enmlToMarkdown, enexDate };
