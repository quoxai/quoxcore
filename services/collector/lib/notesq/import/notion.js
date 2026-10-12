'use strict';

/**
 * Notion "Export -> Markdown & CSV" (.zip) parser. Pure.
 * Notion wraps the export in an outer zip holding Export-<uuid>-Part-N.zip, and
 * suffixes every page/folder name with a 32-hex id. This module unwraps nested
 * zips (one level), strips ids, turns database row property lines into note
 * properties, rewrites internal links to [[wikilinks]], and delegates body
 * handling and attachments to the obsidian parser so both behave identically.
 */

const crypto = require('node:crypto');
const JSZip = require('jszip');
const { parseObsidian } = require('./obsidian.js');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const baseName = (p) => p.replace(/^.*\//, '');
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isMd = (p) => /\.(md|markdown)$/i.test(p);
const ID_SEG = /\s+[0-9a-f]{32}(?=\.[A-Za-z0-9]+$|$)/i;
const ID_ANY = /[0-9a-f]{32}(?:\.(?:md|csv)|_all\.csv|\/|$)/i;
const idOf = (name) => (/([0-9a-f]{32})(?:_all)?\.[A-Za-z0-9]+$/i.exec(name) || [])[1] || null;

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
const stripId = (seg) => seg.replace(/_all(?=\.csv$)/i, '').replace(ID_SEG, '').trim();
const stripExt = (s) => s.replace(/\.[A-Za-z0-9]+$/, '');

const visible = (f) => !f.dir && !f.name.startsWith('__MACOSX/') && !f.name.split('/').some((s) => s.startsWith('.'));

/** True when a zip looks like a Notion export (nested Export-*.zip or id-suffixed md/csv). */
async function isNotionZip(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    if (names.some((n) => /(^|\/)Export-[^/]*\.zip$/i.test(n))) return true;
    return names.some((n) => ID_ANY.test(n) && !n.startsWith('__MACOSX/'));
  } catch {
    return false;
  }
}

async function loadFiles(input) {
  const files = new Map();
  const zip = await JSZip.loadAsync(input);
  const entries = Object.values(zip.files).filter(visible);
  for (const f of entries) {
    if (/\.zip$/i.test(f.name)) {
      const inner = await JSZip.loadAsync(await f.async('nodebuffer'));
      for (const g of Object.values(inner.files).filter(visible)) files.set(g.name, () => g.async('nodebuffer'));
    } else {
      files.set(f.name, () => f.async('nodebuffer'));
    }
  }
  return files;
}

const propKey = (k) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const RESERVED = new Set(['source', 'import_ref', 'collection', 'title']);

function splitProps(raw) {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const head = [];
  if (i < lines.length && /^#\s+\S/.test(lines[i])) { head.push(lines[i]); i++; }
  while (i < lines.length && lines[i].trim() === '') i++;
  const props = [];
  while (i < lines.length && /^[^:\n]{1,80}:(?:\s.*)?$/.test(lines[i]) && !/^\s*(https?|ftp):/i.test(lines[i])) {
    const m = /^([^:]+):\s*(.*)$/.exec(lines[i]);
    props.push([m[1], m[2].trim()]);
    i++;
  }
  return { head, props, rest: lines.slice(i).join('\n') };
}

function rewriteLinks(body) {
  return body.replace(/(^|[^!])\[([^\]]*)\]\(([^)\s]+)\)/g, (m, pre, text, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) return m;
    const dec = safeDecode(target.split('#')[0]);
    if (!isMd(dec)) return m;
    const title = stripId(baseName(dec).replace(/\.(md|markdown)$/i, ''));
    return title ? `${pre}[[${title}]]` : m;
  });
}

async function parseNotion(input, opts = {}) {
  const fname = String(opts.filename || '').replace(/^.*[\\/]/, '');
  const rootName = fname.replace(/\.zip$/i, '').replace(/^Export-/i, '').trim() || 'Notion';
  const files = await loadFiles(input);
  const warnings = [];

  // Databases: csv files; rows are the .md files in the matching folder.
  const dbDirs = new Set();
  const csvInfo = [];
  for (const p of files.keys()) {
    if (!/\.csv$/i.test(p)) continue;
    const parent = dirName(p);
    const stem = baseName(p).replace(/_all(?=\.csv$)/i, '').replace(/\.csv$/i, '');
    const folder = parent ? `${parent}/${stem}` : stem;
    csvInfo.push({ name: stripId(stem), folder });
  }
  const mdPaths = [...files.keys()].filter(isMd);
  for (const c of csvInfo) {
    const hasRows = mdPaths.some((p) => dirName(p) === c.folder || stripId(dirName(p)) === stripId(c.folder) || dirName(p).replace(/\/[^/]*$/, '') === c.folder);
    if (hasRows) {
      for (const p of mdPaths) if (dirName(p) === c.folder || (stripId(dirName(p)) === stripId(c.folder) && dirName(p).split('/').length === c.folder.split('/').length)) dbDirs.add(dirName(p));
      warnings.push(`database table ${c.name}: rows imported as notes`);
    } else {
      warnings.push(`database ${c.name} exported as CSV only: not imported`);
    }
  }

  const pageMeta = (path, raw) => {
    const stem = stripId(baseName(path).replace(/\.(md|markdown)$/i, ''));
    const segs = path.split('/');
    // A top-level page that has its own folder of child pages names the
    // collection those children land in, so the page sits with them.
    const ownFolder = baseName(path).replace(/\.(md|markdown)$/i, '') + '/';
    const hasChildren = segs.length === 1 && mdPaths.some((p) => p.startsWith(ownFolder));
    const collection = segs.length > 1 ? (stripId(segs[0]) || rootName) : (hasChildren ? (stem || rootName) : rootName);
    const id = idOf(baseName(path));
    const ref = id ? id.toLowerCase() : sha1(`notion\n${path}`);
    let text = raw;
    const props = {};
    let tags;
    if (dbDirs.has(dirName(path))) {
      const sp = splitProps(raw);
      if (sp.props.length) {
        for (const [k, v] of sp.props) {
          const key = propKey(k);
          if (!key || v === '') continue;
          if (key === 'tags' || key === 'multi_select') {
            tags = [...(tags || []), ...v.split(',').map((t) => t.trim()).filter(Boolean)];
          } else {
            props[RESERVED.has(key) ? `notion_${key}` : key] = v;
          }
        }
        text = [...sp.head, '', sp.rest].join('\n').replace(/\n{3,}/g, '\n\n');
      }
    }
    const h1 = /^\s*#\s+(.+)$/m.exec(text.slice(0, 2000));
    const title = (text.trimStart().startsWith('# ') && h1 ? h1[1].trim() : stem) || stem;
    return { body: rewriteLinks(text), props, tags, title, collection, ref };
  };

  const parsed = await parseObsidian(null, { filename: fname, collection: opts.collection, source: 'notion', kind: 'zip', files, rootName, pageMeta });
  parsed.warnings.unshift(...warnings);
  return parsed;
}

module.exports = { parseNotion, isNotionZip };
