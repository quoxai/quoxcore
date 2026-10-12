'use strict';

/** Import entry: format detection + dispatch to the right parser. */

const { parseEnex } = require('./enex.js');
const { parseObsidian } = require('./obsidian.js');

const { parseNotion, isNotionZip } = require('./notion.js');

const FORMATS = ['evernote', 'obsidian', 'markdown', 'notion', 'batch'];

/** One session-authored batch may create at most this many notes (a runaway loop cannot flood a notebook). */
const MAX_BATCH_NOTES = 200;

function detectFormat(filename) {
  const f = String(filename || '').toLowerCase();
  if (f.endsWith('.enex')) return 'evernote';
  if (f.endsWith('.zip')) return 'obsidian';
  if (f.endsWith('.md') || f.endsWith('.markdown')) return 'markdown';
  return null;
}

/** @returns parsed model {format, notes, blobs, warnings}; throws Error with .code 'unsupported_format' | 'parse_failed' */
async function parseImport(buffer, { filename, format, collection } = {}) {
  let fmt = format || detectFormat(filename);
  if (!format && fmt === 'obsidian' && (await isNotionZip(buffer))) fmt = 'notion';
  if (!fmt || !FORMATS.includes(fmt)) {
    const e = new Error('could not detect import format; pass format=evernote|obsidian|markdown|notion');
    e.code = 'unsupported_format';
    throw e;
  }
  if (fmt === 'batch') {
    let parsed;
    try {
      parsed = await parseObsidian(buffer, { filename, collection, source: 'batch', kind: /\.zip$/i.test(filename || '') ? 'zip' : 'md', batch: true });
    } catch (err) {
      const e = new Error(`could not read batch: ${err.message}`);
      e.code = 'parse_failed';
      throw e;
    }
    if (parsed.notes.length > MAX_BATCH_NOTES) {
      const e = new Error(`a batch may create at most ${MAX_BATCH_NOTES} notes (this one has ${parsed.notes.length}); split it into smaller batches`);
      e.code = 'batch_too_large';
      throw e;
    }
    return parsed;
  }
  try {
    if (fmt === 'evernote') return parseEnex(buffer, { filename, collection });
    if (fmt === 'notion') return await parseNotion(buffer, { filename, collection });
    const kind = /\.zip$/i.test(filename || '') ? 'zip' : 'md';
    return await parseObsidian(buffer, { filename, collection, source: fmt, kind });
  } catch (err) {
    const e = new Error(`could not read ${fmt} file: ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }
}

/** Dry-run summary of a parsed model (no writes). */
function summarise(parsed) {
  const collections = {};
  const tags = new Set();
  const shas = new Set();
  for (const n of parsed.notes) {
    collections[n.collection || '(none)'] = (collections[n.collection || '(none)'] || 0) + 1;
    for (const t of n.tags) tags.add(t);
    for (const a of n.attachments) shas.add(a.sha);
  }
  return {
    format: parsed.format,
    notes: parsed.notes.length,
    attachments: shas.size,
    collections,
    tags: [...tags].sort(),
    warnings: parsed.warnings,
    sample: parsed.notes.slice(0, 10).map((n) => n.title),
  };
}

module.exports = { parseImport, detectFormat, summarise, FORMATS, MAX_BATCH_NOTES };
