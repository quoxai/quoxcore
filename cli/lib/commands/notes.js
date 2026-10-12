/**
 * NotesQ commands: governed markdown notes (Qortex notebook layer).
 * Proxied through the collector (/api/v1/notesq/*; org + user resolved
 * server-side from auth). Writes are revisioned; edits use optimistic
 * concurrency (base_hash) and a stale base is a 409, never retried silently.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { basename, dirname, join, resolve } from 'path';
import { Option } from 'commander';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { QuoxApiError, QuoxError } from '../core/errors.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import { buildBatchArchive, splitMarkdown, indexMarkdown, MAX_BATCH_NOTES } from './notesBatch.js';
import { emailToNote, extractTasks, promoteBody } from './notesBridges.js';
import { linkMention } from './notesLinks.js';

const SCOPES = ['org', 'user'];
const ARCHIVED = ['exclude', 'only', 'include'];
const IMPORT_FORMATS = ['evernote', 'obsidian', 'markdown', 'notion'];
const IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attachments: namespace + size cap mirror src/components/notesq/lib/attachments.js
// (NAMESPACE, SOURCE_PLUGIN, MAX_ATTACHMENT_BYTES). The editor and the CLI must
// write the same reference shape or notes stop rendering their files.
const ATTACH_NAMESPACE = 'notesq';
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const ATTACH_REF = /!?\[([^\]]*)\]\((\/api\/orgs\/[^/)\s]+\/files\/([^/?#)\s]+))\)/g;

// NotesQ platform settings (collector flags). Short names are the CLI spelling.
const SETTING_ALIASES = {
  'autosave-ms': 'NOTESQ_AUTOSAVE_MS',
  'default-collection': 'NOTESQ_DEFAULT_COLLECTION',
  'agent-edit-policy': 'NOTESQ_AGENT_EDIT_POLICY',
  'revision-retention': 'NOTESQ_REVISION_RETENTION',
};
const OUTPUT_FORMATS = ['table', 'json', 'csv', 'quiet'];

const noteLink = (id) => `/notes?note=${id}`;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const pad2 = (n) => String(n).padStart(2, '0');
function describeCadence(x) {
  const at = `${pad2(x.hour)}:${pad2(x.minute)} ${x.tz}`;
  return x.cadence === 'weekly' ? `weekly ${WEEKDAYS[x.weekday] || '?'} ${at}` : `daily ${at}`;
}

/** Same rule as duplicateMarkdown in src/components/notesq/NotesQRail.jsx (mirrored, not imported: the CLI ships without src). */
function duplicateMarkdown(md) {
  const text = String(md || '');
  const m = /^\s*#\s+(.+)$/m.exec(text);
  if (m && text.trimStart().startsWith('# ')) return text.replace(m[0], () => `# ${m[1].trim()} (copy)`);
  return `# Untitled (copy)\n\n${text}`;
}
// Bookkeeping that belongs to the original, not the copy (NOT_COPIED in NotesQRail.jsx).
const NOT_COPIED = new Set(['import_ref', 'source', 'pinned', 'batch_id', 'batch_session']);

function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '0 B';
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const t = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${t} ${units[i]}`;
}

const refLabel = (s) => String(s || 'file').replace(/[[\]\\]/g, '_').replace(/[\r\n]+/g, ' ').trim() || 'file';

const safeName = (s, fallback) => {
  const t = [...String(s || '')].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return t || fallback;
};

/** Where to write a file: --out, or a -o value that is not an output format (the root -o swallows it). */
function targetPath(program, options) {
  if (options.out) return options.out;
  const g = program.opts().output;
  return g && !OUTPUT_FORMATS.includes(g) ? g : undefined;
}

const collect = (v, prev) => (prev || []).concat(v);
const isJson = (program) => program.opts().output === 'json';
const printJson = (d) => console.log(JSON.stringify(d, null, 2));
const announce = (verb, result) => printEvent(glyphLine('brain2', verb, { result }));

function checkEnum(value, allowed, flag) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new QuoxError(`${flag} must be one of: ${allowed.join(', ')}`, 2);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function readContent(options) {
  if (options.file && options.stdin) throw new QuoxError('Use --file or --stdin, not both.', 2);
  if (options.file) return readFileSync(options.file, 'utf8');
  if (options.stdin) return readStdin();
  return null;
}

/** Map NotesQ-specific statuses to actionable errors; everything else passes through. */
async function call(fn, { forbidden } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof QuoxApiError) {
      if (e.status === 402) throw new QuoxError('NotesQ is not licensed for this org.', 1);
      if (e.status === 403 && forbidden) throw new QuoxError(forbidden, 1);
    }
    throw e;
  }
}

const shortId = (id) => String(id || '');
const when = (n) => n.updated_at || n.updatedAt || '';

export function registerNotesCommands(program, ctx) {
  const { client, auth } = ctx;
  const scorecardPath = ctx.scorecardPath
    || resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/notesq-scorecard.mjs');

  const getNote = async (id) => {
    const gep = resolveEndpoint('notesq.notes.get', { id });
    return (await call(() => client.get(gep.path, { service: gep.service }))).note || {};
  };

  /** PUT with optimistic concurrency. A stale base is a 409 and is never retried. */
  const putNote = async (id, body) => {
    const pep = resolveEndpoint('notesq.notes.update', { id });
    try {
      return await call(() => client.put(pep.path, { service: pep.service, body }));
    } catch (e) {
      if (e instanceof QuoxApiError && e.status === 409) {
        const h = e.body && e.body.current_hash;
        throw new QuoxError(`Edit conflict: note ${id} changed since you read it (current_hash ${h || 'unknown'}). Nothing was written. Re-run \`quox notes show ${id}\`, merge, and edit again.`, 1);
      }
      throw e;
    }
  };

  const notes = program
    .command('notes')
    .description('NotesQ: governed markdown notes (list, read, write, history, restore)');

  const list = async (options, textQuery) => {
    auth.requireAuth();
    checkEnum(options.scope, [...SCOPES, 'all'], '--scope');
    checkEnum(options.archived, ARCHIVED, '--archived');
    const query = {};
    if (options.scope) query.scope = options.scope;
    const q = textQuery ?? options.q;
    if (q) query.q = q;
    if (options.collection) query.collection = options.collection;
    if (options.tag) query.tag = options.tag;
    if (options.pinned) query.pinned = 'true';
    if (options.archived) query.archived = options.archived;
    if (options.limit !== undefined) query.limit = Number(options.limit);
    const ep = resolveEndpoint('notesq.notes.list');
    const data = await call(() => client.get(ep.path, { service: ep.service, query }));
    if (isJson(program)) return printJson(data);
    const propKeys = String(options.props || '').split(',').map((k) => k.trim()).filter(Boolean);
    const propText = (v) => {
      if (v === null || v === undefined) return '';
      if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === 'object' ? '...' : String(x))).join(',');
      return typeof v === 'object' ? '...' : String(v);
    };
    const rows = (data.notes || []).map((n) => ({
      ...Object.fromEntries(propKeys.map((k, i) => [`prop${i}`, propText(n.properties && n.properties[k])])),
      id: shortId(n.id),
      title: n.title || '',
      scope: n.scope || '',
      collection: (n.properties && n.properties.collection) || n.collection || '',
      tags: (n.tags || (n.properties && n.properties.tags) || []).join(','),
      updated: when(n),
    }));
    formatOutput({
      columns: ['id', 'title', 'scope', 'collection', 'tags', 'updated', ...propKeys.map((_, i) => `prop${i}`)],
      headers: ['ID', 'Title', 'Scope', 'Collection', 'Tags', 'Updated', ...propKeys],
      rows,
    }, { format: program.opts().output });
    announce('notes ls', `${rows.length} of ${data.total ?? rows.length}`);
  };

  const listOpts = (cmd) => cmd
    .option('--scope <scope>', 'org | user | all (default all)')
    .option('--collection <c>', 'filter by collection')
    .option('--tag <t>', 'filter by tag')
    .option('--pinned', 'only pinned notes')
    .option('--archived <mode>', 'exclude (default) | only | include')
    .option('--limit <n>', 'max notes (server caps at 200)')
    .option('--props <keys>', 'extra property columns for table output, comma separated (e.g. status,owner); JSON output is unchanged');

  listOpts(notes.command('ls').description('List notes'))
    .option('--q <text>', 'full-text filter')
    .action((options) => list(options));

  listOpts(notes.command('search').description('Search notes (same as ls --q)'))
    .argument('<text>', 'search text')
    .action((text, options) => list(options, text));

  notes
    .command('show')
    .description('Show a note: title, properties, markdown (--raw: full body incl. frontmatter)')
    .argument('<id>', 'note id (full id, see `quox notes ls --json`)')
    .option('--raw', 'print the full raw body including frontmatter')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.get', { id });
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson({ ...data, link: noteLink(id) });
      const n = data.note || {};
      if (options.raw) { console.log(n.body ?? ''); return; }
      formatDetail({ id: n.id, title: n.title, scope: n.scope, ...(n.properties || {}), link: noteLink(n.id || id) });
      console.log('');
      console.log(n.markdown ?? '');
    });

  notes
    .command('new')
    .description('Create a note. Markdown from --file or --stdin, else "# <title>"')
    .option('--scope <scope>', 'org | user (default org)', 'org')
    .option('--title <t>', 'title (seeds a heading when no --file/--stdin)')
    .option('--collection <c>', 'collection property')
    .option('--tag <t>', 'tag (repeatable)', collect)
    .option('--file <path>', 'read markdown from a file')
    .option('--stdin', 'read markdown from stdin')
    .option('--template <name>', 'start from a template (see `quox notes templates`); {{date}} etc. filled in your local time zone')
    .action(async (options) => {
      auth.requireAuth();
      checkEnum(options.scope, SCOPES, '--scope');
      if (options.template) {
        if (options.file || options.stdin) throw new QuoxError('Use --template or --file/--stdin, not both.', 2);
        const tep = resolveEndpoint('notesq.notes.fromTemplate');
        const body = { template: options.template, scope: options.scope, tz: localTz() };
        if (options.collection) body.collection = options.collection;
        if (options.title) body.title = options.title;
        const data = await call(() => client.post(tep.path, { service: tep.service, body }));
        if (isJson(program)) return printJson(data);
        const n = data.note || {};
        announce('new', `"${n.title || options.template}" from template ${options.template}`);
        return console.log(`link: ${noteLink(n.id)}`);
      }
      let markdown = await readContent(options);
      if (markdown === null) markdown = `# ${options.title || 'Untitled'}\n\n`;
      const properties = {};
      if (options.collection) properties.collection = options.collection;
      if (options.tag) properties.tags = options.tag;
      const ep = resolveEndpoint('notesq.notes.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { scope: options.scope, markdown, properties } }));
      if (isJson(program)) return printJson(data);
      const n = data.note || {};
      printSuccess(`Created note ${n.id} (${n.title || 'untitled'}).`);
    });

  notes
    .command('edit')
    .description('Replace a note\'s markdown (--file or --stdin). Fails with a conflict if the note changed since it was read.')
    .argument('<id>', 'note id')
    .option('--file <path>', 'read markdown from a file')
    .option('--stdin', 'read markdown from stdin')
    .option('--collection <c>', 'set collection property')
    .option('--tag <t>', 'set tags (repeatable; replaces existing tags)', collect)
    .action(async (id, options) => {
      auth.requireAuth();
      const markdown = await readContent(options);
      if (markdown === null) throw new QuoxError('edit needs --file <path> or --stdin.', 2);
      const cur = await getNote(id);
      const properties = { ...(cur.properties || {}) };
      if (options.collection) properties.collection = options.collection;
      if (options.tag) properties.tags = options.tag;
      const data = await putNote(id, { markdown, properties, base_hash: cur.content_hash });
      if (isJson(program)) return printJson(data);
      printSuccess(data.unchanged ? `Note ${id} unchanged.` : `Updated note ${id} (rev ${data.revision?.rev ?? '?'}).`);
    });

  notes
    .command('facets')
    .description('Collections and tags with counts')
    .option('--scope <scope>', 'org | user | all (default all)')
    .action(async (options) => {
      auth.requireAuth();
      checkEnum(options.scope, [...SCOPES, 'all'], '--scope');
      const ep = resolveEndpoint('notesq.facets');
      const query = options.scope ? { scope: options.scope } : {};
      const data = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (isJson(program)) return printJson(data);
      const rows = [
        ...(data.collections || []).map((c) => ({ kind: 'collection', name: c.name, count: c.count })),
        ...(data.tags || []).map((t) => ({ kind: 'tag', name: t.tag, count: t.count })),
      ];
      formatOutput({ columns: ['kind', 'name', 'count'], headers: ['Kind', 'Name', 'Count'], rows }, { format: program.opts().output });
      console.log(`total ${data.total ?? 0} | pinned ${data.pinned ?? 0} | archived ${data.archived ?? 0}`);
    });

  notes
    .command('history')
    .description('Revision history of a note')
    .argument('<id>', 'note id')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.revisions', { id });
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      formatOutput({
        columns: ['rev', 'action', 'author_kind', 'content_hash', 'created_at'],
        headers: ['Rev', 'Action', 'Author', 'Hash', 'When'],
        rows: data.revisions || [],
      }, { format: program.opts().output });
    });

  notes
    .command('restore')
    .description('Restore a note to an earlier revision (writes a new revision)')
    .argument('<id>', 'note id')
    .requiredOption('--rev <n>', 'revision number to restore')
    .action(async (id, options) => {
      auth.requireAuth();
      const rev = Number(options.rev);
      if (!Number.isInteger(rev) || rev < 1) throw new QuoxError('--rev must be a positive integer.', 2);
      const ep = resolveEndpoint('notesq.notes.restore', { id });
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { rev } }), { forbidden: 'You do not have write access to this note.' });
      if (isJson(program)) return printJson(data);
      printSuccess(data.unchanged ? `Note ${id} already matches rev ${rev}.` : `Restored note ${id} to rev ${rev} (new rev ${data.revision?.rev ?? '?'}).`);
    });

  notes
    .command('rm')
    .description('Delete a note (author or org admin only). Requires --yes. --purge permanently erases the note and every revision (human only, irreversible).')
    .argument('<id>', 'note id')
    .option('--yes', 'confirm deletion')
    .option('--purge', 'permanently erase the note and every revision; human sessions only, cannot be undone, requires --yes')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError(`Refusing to ${options.purge ? 'purge' : 'delete'} ${id} without --yes.`, 2);
      const ep = resolveEndpoint('notesq.notes.delete', { id });
      const opts = { service: ep.service };
      if (options.purge) opts.query = { purge: 'true' };
      const forbidden = options.purge
        ? 'Purge refused: only the author or an org admin can purge a note, and only from a human session.'
        : 'Only the author or an org admin can delete this note.';
      const data = await call(() => client.delete(ep.path, opts), { forbidden });
      if (isJson(program)) return printJson(data);
      printSuccess(options.purge ? `Purged note ${id} and all its revisions.` : `Deleted note ${id}.`);
    });

  notes
    .command('related')
    .description('Notes related to this one (lexical until embeddings are backfilled, then hybrid)')
    .argument('<id>', 'note id')
    .option('--limit <n>', 'max results')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.related', { id });
      const query = options.limit !== undefined ? { limit: Number(options.limit) } : {};
      const data = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (isJson(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'title', 'score'],
        headers: ['ID', 'Title', 'Score'],
        rows: (data.related || []).map((r) => ({ id: r.id, title: r.title || '', score: r.score ?? '' })),
      }, { format: program.opts().output });
      console.log(`mode: ${data.mode || 'lexical'}`);
    });

  notes
    .command('suggest')
    .description('Link suggestions for a note: other notes whose title appears as plain text, then related notes. --link <targetId> turns the first mention into a [[wikilink]]')
    .argument('<id>', 'note id')
    .option('--link <targetId>', 'rewrite the first plain mention of that note\'s title into a [[wikilink]]')
    .option('--limit <n>', 'max results per list (1-20)')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.suggestions', { id });
      const query = options.limit !== undefined ? { limit: Number(options.limit) } : {};
      const data = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (options.link) {
        const mention = (data.mentions || []).find((m) => m.id === options.link);
        if (!mention) throw new QuoxError(`${options.link} is not a current mention in this note. Run \`quox notes suggest ${id}\` to see them.`, 2);
        const target = await getNote(options.link);
        const cur = await getNote(id);
        const r = linkMention(cur.markdown ?? '', target.title || mention.title);
        if (!r.changed) throw new QuoxError(`No plain-text mention of "${target.title || mention.title}" left to link.`, 2);
        const out = await putNote(id, { markdown: r.markdown, properties: { ...(cur.properties || {}) }, base_hash: cur.content_hash });
        if (isJson(program)) return printJson(out);
        announce('suggest', `linked [[${target.title || mention.title}]]`);
        return;
      }
      if (isJson(program)) return printJson(data);
      const mentions = data.mentions || [];
      const related = data.related || [];
      console.log(`Mentions (${mentions.length}): titles that appear as plain text`);
      formatOutput({
        columns: ['id', 'title', 'count', 'snippet'],
        headers: ['ID', 'Title', 'Count', 'Snippet'],
        rows: mentions.map((m) => ({ id: m.id, title: m.title || '', count: m.count, snippet: m.snippet || '' })),
      }, { format: program.opts().output });
      console.log(`Related (${related.length}), mode: ${data.mode || 'lexical'}`);
      formatOutput({
        columns: ['id', 'title', 'score'],
        headers: ['ID', 'Title', 'Score'],
        rows: related.map((r) => ({ id: r.id, title: r.title || '', score: r.score ?? '' })),
      }, { format: program.opts().output });
    });

  notes
    .command('health')
    .description('Notebook health: duplicate groups, stale notes others rely on, and broken [[links]]')
    .option('--scope <scope>', 'org|user (default org)')
    .option('--stale-days <n>', 'age in days before a linked-to note counts as stale (30-3650, default 180)')
    .action(async (options) => {
      auth.requireAuth();
      checkEnum(options.scope, SCOPES, '--scope');
      const ep = resolveEndpoint('notesq.health');
      const query = {};
      if (options.scope) query.scope = options.scope;
      if (options.staleDays !== undefined) query.stale_days = Number(options.staleDays);
      const data = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (isJson(program)) return printJson(data);
      const fmt = program.opts().output;
      const dups = data.duplicates || [];
      const stale = data.stale || [];
      const broken = data.broken_links || [];
      console.log(`Scanned ${data.scanned} note(s) in ${data.scope} scope${data.truncated ? ' (truncated)' : ''}`);
      console.log(`Duplicates (${dups.length})`);
      formatOutput({
        columns: ['kind', 'similarity', 'notes'],
        headers: ['Kind', 'Similarity', 'Notes'],
        rows: dups.map((g) => ({ kind: g.kind, similarity: g.similarity ?? '', notes: g.notes.map((n) => `${n.title} (${n.id})`).join('; ') })),
      }, { format: fmt });
      console.log(`Stale but linked to (${stale.length})`);
      formatOutput({
        columns: ['id', 'title', 'updated_at', 'backlinks'],
        headers: ['ID', 'Title', 'Updated', 'Backlinks'],
        rows: stale.map((s) => ({ id: s.id, title: s.title || '', updated_at: s.updated_at || '', backlinks: s.backlinks })),
      }, { format: fmt });
      console.log(`Broken links (${broken.length})`);
      formatOutput({
        columns: ['source', 'target', 'count'],
        headers: ['Source', 'Target', 'Count'],
        rows: broken.map((b) => ({ source: `${b.source.title} (${b.source.id})`, target: b.target_raw, count: b.count })),
      }, { format: fmt });
    });

  notes
    .command('import')
    .description('Import notes from an Evernote export (.enex), an Obsidian vault (.zip) or markdown (.md/.zip)')
    .argument('<file>', 'file to import (max 100 MB)')
    .option('--format <format>', `source format: ${IMPORT_FORMATS.join('|')} (default: detect from extension)`)
    .option('--scope <scope>', 'org|user (default org)')
    .option('--collection <name>', 'put every imported note in this collection')
    .option('--dry-run', 'parse only and print what would be imported; writes nothing')
    .addOption(new Option('--poll-ms <n>', 'job poll interval').default('2000').hideHelp())
    .action(async (file, options) => {
      auth.requireAuth();
      checkEnum(options.format, IMPORT_FORMATS, '--format');
      checkEnum(options.scope, SCOPES, '--scope');
      let bytes;
      try { bytes = readFileSync(file); } catch (e) { throw new QuoxError(`Cannot read ${file}: ${e.message}`, 2); }
      if (bytes.length > IMPORT_MAX_BYTES) throw new QuoxError(`${file} is over the 100 MB import limit.`, 2);
      const query = {};
      if (options.format) query.format = options.format;
      if (options.scope) query.scope = options.scope;
      if (options.collection) query.collection = options.collection;
      if (options.dryRun) query.dry_run = 'true';
      const form = new FormData();
      form.append('file', new Blob([bytes]), basename(file));
      const ep = resolveEndpoint('notesq.import');
      // retries: 0, a retried multipart upload would start a second job.
      const data = await call(() => client.post(ep.path, { service: ep.service, body: form, query, timeout: 300000, retries: 0 }));

      if (options.dryRun) {
        if (isJson(program)) return printJson(data);
        console.log(`Dry run (${data.format}): ${data.notes} notes, ${data.attachments} attachments. Nothing written.`);
        formatOutput({
          columns: ['collection', 'notes'],
          headers: ['Collection', 'Notes'],
          rows: Object.entries(data.collections || {}).map(([collection, n]) => ({ collection, notes: n })),
        }, { format: program.opts().output });
        if ((data.tags || []).length) console.log(`tags: ${data.tags.join(', ')}`);
        if ((data.sample || []).length) console.log(`sample: ${data.sample.join(' | ')}`);
        for (const w of data.warnings || []) console.log(`warning: ${w}`);
        return;
      }

      if (!data.job_id) throw new QuoxError('Import did not return a job id.', 1);
      const sp = resolveEndpoint('notesq.import.status', { jobId: data.job_id });
      const pollMs = Math.max(Number(options.pollMs) || 2000, 0);
      const json = isJson(program);
      // Say the job id up front: the import keeps running server-side if this terminal goes away.
      if (!json) console.log(`import job ${data.job_id} started (check any time: quox notes import-status ${data.job_id})`);
      let st;
      let last = '';
      for (;;) {
        st = await call(() => client.get(sp.path, { service: sp.service }));
        const progress = `${st.created + st.skipped + st.failed}/${st.total} (created ${st.created}, skipped ${st.skipped}, failed ${st.failed})`;
        if (!json && st.status === 'running' && progress !== last) { console.log(`importing ${progress}`); last = progress; }
        if (st.status !== 'running') break;
        await sleep(pollMs);
      }
      if (json) printJson({ job_id: data.job_id, ...st });
      else {
        announce('import', `${st.created} created, ${st.skipped} skipped, ${st.failed} failed`);
        for (const e of st.errors || []) console.log(`failed: ${e.title}: ${e.error}`);
      }
      if (st.status === 'failed') throw new QuoxError(`Import failed: ${st.error || 'unknown error'}`, 1);
      if (st.failed > 0) throw new QuoxError(`${st.failed} note(s) failed to import.`, 1);
      if (!json) printSuccess(`Imported ${st.created} notes (${st.skipped} already present).`);
    });

  notes
    .command('tag')
    .description('Change a note\'s tags, collection, pinned or archived state without touching its text')
    .argument('<id>', 'note id')
    .option('--add <tag>', 'add a tag (repeatable)', collect)
    .option('--remove <tag>', 'remove a tag (repeatable)', collect)
    .option('--collection <c>', 'set the collection')
    .option('--no-collection', 'clear the collection')
    .option('--pin', 'pin the note')
    .option('--unpin', 'unpin the note')
    .option('--archive', 'archive the note')
    .option('--unarchive', 'restore the note from the archive')
    .action(async (id, options) => {
      auth.requireAuth();
      if (options.pin && options.unpin) throw new QuoxError('Use --pin or --unpin, not both.', 2);
      if (options.archive && options.unarchive) throw new QuoxError('Use --archive or --unarchive, not both.', 2);
      const changes = [options.add, options.remove, options.collection !== undefined, options.pin, options.unpin, options.archive, options.unarchive];
      if (!changes.some(Boolean)) throw new QuoxError('Nothing to change: pass --add, --remove, --collection, --no-collection, --pin, --unpin, --archive or --unarchive.', 2);
      const cur = await getNote(id);
      const properties = { ...(cur.properties || {}) };
      if (options.add || options.remove) {
        const drop = new Set(options.remove || []);
        const tags = [...(properties.tags || []), ...(options.add || [])].filter((t) => !drop.has(t));
        properties.tags = [...new Set(tags)];
      }
      if (options.collection === false) delete properties.collection;
      else if (options.collection) properties.collection = options.collection;
      if (options.pin) properties.pinned = true;
      if (options.unpin) properties.pinned = false;
      if (options.archive) properties.archived = true;
      if (options.unarchive) properties.archived = false;
      const data = await putNote(id, { markdown: cur.markdown ?? '', properties, base_hash: cur.content_hash });
      if (isJson(program)) return printJson(data);
      console.log(`tags: ${(properties.tags || []).join(', ') || '(none)'}`);
      console.log(`collection: ${properties.collection || '(none)'}`);
      console.log(`pinned: ${properties.pinned ? 'yes' : 'no'} | archived: ${properties.archived ? 'yes' : 'no'}`);
      announce('notes tag', data.unchanged ? 'unchanged' : `rev ${data.revision?.rev ?? '?'}`);
    });

  notes
    .command('append')
    .description('Append text to the end of a note (blank line between). Text from the argument, --stdin or --file.')
    .argument('<id>', 'note id')
    .argument('[text]', 'text to append')
    .option('--stdin', 'read the text from stdin')
    .option('--file <path>', 'read the text from a file')
    .action(async (id, text, options) => {
      auth.requireAuth();
      const fromFlags = await readContent(options);
      if (text !== undefined && fromFlags !== null) throw new QuoxError('Give the text as an argument or use --stdin/--file, not both.', 2);
      const addition = text !== undefined ? text : fromFlags;
      if (addition === null || addition === undefined) throw new QuoxError('append needs text, --stdin or --file <path>.', 2);
      if (!String(addition).trim()) throw new QuoxError('Nothing to append: the text is empty.', 2);
      const cur = await getNote(id);
      const markdown = `${String(cur.markdown ?? '').replace(/\s+$/, '')}\n\n${String(addition).replace(/\s+$/, '')}`;
      const data = await putNote(id, { markdown, properties: { ...(cur.properties || {}) }, base_hash: cur.content_hash });
      if (isJson(program)) return printJson(data);
      printSuccess(`Appended to note ${id} (rev ${data.revision?.rev ?? '?'}).`);
    });

  notes
    .command('duplicate')
    .description('Copy a note in the same scope as "<title> (copy)" (pinned, source and import_ref are not copied)')
    .argument('<id>', 'note id')
    .action(async (id) => {
      auth.requireAuth();
      const cur = await getNote(id);
      const properties = Object.fromEntries(Object.entries(cur.properties || {}).filter(([k]) => !NOT_COPIED.has(k)));
      const ep = resolveEndpoint('notesq.notes.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { scope: cur.scope, markdown: duplicateMarkdown(cur.markdown), properties } }));
      const n = data.note || {};
      if (isJson(program)) return printJson({ ...data, link: noteLink(n.id) });
      printSuccess(`Duplicated note ${id} as ${n.id}.`);
      console.log(`link: ${noteLink(n.id)}`);
    });

  notes
    .command('attach')
    .description('Upload a file (max 25 MB) to the org file store and append a reference to the note')
    .argument('<id>', 'note id')
    .argument('<file>', 'file to attach')
    .action(async (id, file) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const name = basename(file);
      let size;
      let bytes;
      try { size = statSync(file).size; } catch (e) { throw new QuoxError(`Cannot read ${file}: ${e.message}`, 2); }
      if (size === 0) throw new QuoxError(`${name} is empty.`, 2);
      if (size > ATTACH_MAX_BYTES) throw new QuoxError(`${name} is ${formatBytes(size)}, over the ${formatBytes(ATTACH_MAX_BYTES)} attachment limit.`, 2);
      try { bytes = readFileSync(file); } catch (e) { throw new QuoxError(`Cannot read ${file}: ${e.message}`, 2); }
      await getNote(id); // fail on a missing or forbidden note before uploading anything
      const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1]?.toLowerCase() || '';
      const mime = IMAGE_MIME[ext] || 'application/octet-stream';
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), name);
      form.append('namespace', ATTACH_NAMESPACE);
      form.append('source_plugin', ATTACH_NAMESPACE);
      form.append('source_ref', id);
      const uep = resolveEndpoint('notesq.files.upload', { orgId });
      // retries: 0, a retried multipart upload would store a second file row.
      const up = await call(() => client.post(uep.path, { service: uep.service, body: form, timeout: 300000, retries: 0 }));
      if (!up || !up.id) throw new QuoxError('Upload failed: the server returned no file id.', 1);
      const url = `/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(up.id)}`;
      const ref = IMAGE_MIME[ext] ? `![${refLabel(name)}](${url})` : `[${refLabel(name)} (${formatBytes(size)})](${url})`;
      // Re-read after the upload so a slow transfer does not turn into a stale base_hash.
      const cur = await getNote(id);
      const markdown = `${String(cur.markdown ?? '').replace(/\s+$/, '')}\n\n${ref}`;
      const data = await putNote(id, { markdown, properties: { ...(cur.properties || {}) }, base_hash: cur.content_hash });
      if (isJson(program)) return printJson({ file: up, reference: ref, note: data.note });
      printSuccess(`Attached ${name} to note ${id} (file ${up.id}).`);
    });

  notes
    .command('attachments')
    .description('List the org files a note references (name, file id, url)')
    .argument('<id>', 'note id')
    .action(async (id) => {
      auth.requireAuth();
      const cur = await getNote(id);
      const attachments = [];
      for (const m of String(cur.markdown ?? '').matchAll(ATTACH_REF)) {
        attachments.push({ name: m[1], file_id: decodeURIComponent(m[3]), url: m[2] });
      }
      if (isJson(program)) return printJson({ attachments });
      formatOutput({
        columns: ['name', 'file_id', 'url'],
        headers: ['Name', 'File ID', 'URL'],
        rows: attachments,
        emptyMessage: 'No attachments.',
      }, { format: program.opts().output });
    });

  notes
    .command('download')
    .description('Download an org file (by file id, see `quox notes attachments`). Never overwrites without --force.')
    .argument('<fileId>', 'file id')
    .option('--out <path>', 'write to this path (-o <path> also works); default: the original filename in the current directory')
    .option('--force', 'overwrite an existing file')
    .action(async (fileId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      let target = targetPath(program, options);
      if (!target) {
        const mep = resolveEndpoint('notesq.files.meta', { orgId, fileId });
        const meta = await call(() => client.get(mep.path, { service: mep.service }));
        target = [...basename(String(meta.filename || fileId))].map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch)).join('') || fileId;
      }
      target = resolve(ctx.cwd || process.cwd(), target);
      if (existsSync(target) && !options.force) throw new QuoxError(`${target} already exists. Use --force to overwrite.`, 1);
      const gep = resolveEndpoint('notesq.files.get', { orgId, fileId });
      const res = await call(() => client.get(gep.path, { service: gep.service, raw: true, timeout: 300000 }));
      if (!res.ok) throw new QuoxError(`Download failed: HTTP ${res.status} for file ${fileId}.`, 1);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(target, buf);
      if (isJson(program)) return printJson({ file_id: fileId, path: target, bytes: buf.length });
      printSuccess(`Saved ${target} (${formatBytes(buf.length)}).`);
    });

  notes
    .command('export')
    .description('Export notes as a zip of <collection or Unfiled>/<title> <id8>.md with frontmatter intact (archived notes included)')
    .option('--scope <scope>', 'org | user | all (default all)')
    .option('--collection <c>', 'only this collection')
    .option('--tag <t>', 'only this tag')
    .option('--out <path>', 'destination .zip (-o <path> also works)')
    .option('--force', 'overwrite an existing destination')
    .option('--with-attachments', 'also save every attached file into the export and point the notes at those copies (a complete offline copy)')
    .action(async (options) => {
      auth.requireAuth();
      checkEnum(options.scope, [...SCOPES, 'all'], '--scope');
      const out = targetPath(program, options);
      if (!out) throw new QuoxError('export needs --out <file.zip>.', 2);
      const target = resolve(out);
      if (existsSync(target) && !options.force) throw new QuoxError(`${target} already exists. Use --force to overwrite.`, 1);

      const PAGE = 200;
      const lep = resolveEndpoint('notesq.notes.list');
      const all = [];
      for (let offset = 0; ; offset += PAGE) {
        const query = { limit: PAGE, offset, archived: 'include' };
        if (options.scope) query.scope = options.scope;
        if (options.collection) query.collection = options.collection;
        if (options.tag) query.tag = options.tag;
        const page = await call(() => client.get(lep.path, { service: lep.service, query }));
        const rows = page.notes || [];
        all.push(...rows);
        if (rows.length === 0 || all.length >= (page.total ?? all.length)) break;
      }

      // Fetch the raw body (frontmatter included), a few at a time.
      const entries = [];
      for (let i = 0; i < all.length; i += 8) {
        const batch = await Promise.all(all.slice(i, i + 8).map(async (n) => {
          const gep = resolveEndpoint('notesq.notes.get', { id: n.id });
          const full = (await call(() => client.get(gep.path, { service: gep.service }))).note || {};
          return { n, body: full.body ?? full.markdown ?? '' };
        }));
        entries.push(...batch);
      }

      const used = new Set();
      const files = entries.map(({ n, body }) => {
        const dir = safeName((n.properties && n.properties.collection) || n.collection, 'Unfiled');
        const base = `${dir}/${safeName(n.title, 'Untitled')} ${String(n.id).slice(0, 8)}`;
        const path = used.has(`${base}.md`) ? `${base} ${n.id}.md` : `${base}.md`;
        used.add(path);
        return { path, body };
      });

      // --with-attachments: fetch each referenced file once (same org files route as
      // `download`), store it under _attachments/, and rewrite the note's link to the
      // relative copy, so the export reads offline. Without it, links still point at
      // the server (they keep working while you can sign in).
      let attachments = 0;
      if (options.withAttachments) {
        const orgId = resolveOrgId(auth, program);
        const fetched = new Map();
        for (const f of [...files]) {  // snapshot: attachment files are appended as we go
          const depth = f.path.split('/').length - 1;
          const up = '../'.repeat(depth);
          let body = f.body;
          for (const m of [...String(body).matchAll(ATTACH_REF)]) {
            const [whole, name, url, fileId] = m;
            if (!fetched.has(fileId)) {
              const gep = resolveEndpoint('notesq.files.get', { orgId, fileId });
              const res = await call(() => client.get(gep.path, { service: gep.service, raw: true, timeout: 300000 }));
              const local = `_attachments/${fileId}-${safeName(name, 'file')}`;
              files.push({ path: local, body: Buffer.from(await res.arrayBuffer()), binary: true });
              fetched.set(fileId, local);
              attachments++;
            }
            body = body.split(whole).join(whole.replace(url, `${up}${fetched.get(fileId)}`));
          }
          f.body = body;
        }
      }

      let jszip = null;
      try { jszip = (await import('jszip')).default; } catch { /* no zip library: fall back to a directory */ }
      let written;
      if (jszip) {
        const zip = new jszip();
        for (const f of files) zip.file(f.path, f.body, { createFolders: false });
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
        written = target;
      } else {
        written = target.replace(/\.zip$/i, '');
        for (const f of files) {
          const p = join(written, f.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.body);
        }
        console.log(`No zip library is installed, so a directory was written instead: ${written}`);
      }
      const noteCount = files.filter((f) => !f.binary).length;
      if (isJson(program)) return printJson({ notes: noteCount, attachments, path: written });
      announce('notes export', `${noteCount} notes${attachments ? `, ${attachments} attachments` : ''}`);
      printSuccess(`Exported ${noteCount} notes${attachments ? ` and ${attachments} attachments` : ''} to ${written}.`);
    });

  notes
    .command('import-status')
    .description('Show an import job: status, counts and errors. Exits non-zero if the job or any note failed.')
    .argument('<jobId>', 'job id printed by `quox notes import`')
    .action(async (jobId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.import.status', { jobId });
      const st = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) printJson(st);
      else {
        console.log(`status: ${st.status}`);
        console.log(`${st.created} created, ${st.skipped} skipped, ${st.failed} failed of ${st.total}`);
        for (const e of st.errors || []) console.log(`failed: ${e.title}: ${e.error}`);
      }
      if (st.status === 'failed') throw new QuoxError(`Import failed: ${st.error || 'unknown error'}`, 1);
      if (st.failed > 0) throw new QuoxError(`${st.failed} note(s) failed to import.`, 1);
    });

  // ---- templates + scheduled notes (AQ-9D P4) -----------------------------
  notes
    .command('templates')
    .description('List note templates: built-ins (daily, weekly, meeting, decision) and your notes marked as templates (property template: true)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.templates.list');
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      formatOutput({
        columns: ['name', 'source', 'id'],
        headers: ['Template', 'Source', 'Note'],
        rows: (data.templates || []).map((t) => ({ name: t.name, source: t.source, id: t.id || '' })),
      }, { format: program.opts().output });
      console.log('Make your own: any note with the property template: true (title = template name; {{date}} {{weekday}} {{time}} {{week}} {{year}} {{title}} are filled in).');
    });

  const schedule = notes
    .command('schedule')
    .description('Scheduled notes: create a note from a template every day or week (runs server-side, your time zone)');

  schedule
    .command('ls', { isDefault: true })
    .description('List your note schedules')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.schedules.list');
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      formatOutput({
        columns: ['id', 'template', 'when', 'scope', 'state', 'next', 'last'],
        headers: ['ID', 'Template', 'When', 'Scope', 'State', 'Next run (UTC)', 'Last period'],
        rows: (data.schedules || []).map((x) => ({
          id: x.id,
          template: x.template,
          when: describeCadence(x),
          scope: x.scope,
          state: x.enabled ? (x.failures ? `on, ${x.failures} failure(s)` : 'on') : `paused${x.disabled_reason ? `: ${x.disabled_reason}` : ''}`,
          next: x.enabled ? x.next_run_at : '',
          last: x.last_period || '',
        })),
      }, { format: program.opts().output });
    });

  schedule
    .command('add')
    .description('Schedule a note from a template, e.g. `quox notes schedule add --template daily --at 07:30`')
    .requiredOption('--template <name>', 'template name (see `quox notes templates`)')
    .requiredOption('--at <HH:MM>', 'local time of day, 24h')
    .option('--weekly <day>', 'weekly on this day (mon..sun) instead of daily')
    .option('--tz <zone>', 'IANA time zone (default: this machine\'s)')
    .option('--scope <scope>', 'user|org (default user)')
    .option('--collection <name>', 'collection for the created notes')
    .option('--title <pattern>', 'title pattern, e.g. "Standup {{date}}" (default: the template\'s)')
    .action(async (options) => {
      auth.requireAuth();
      checkEnum(options.scope, SCOPES, '--scope');
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(options.at);
      if (!m) throw new QuoxError('--at must be HH:MM in 24h time, e.g. 07:30.', 2);
      const body = { template: options.template, cadence: 'daily', hour: Number(m[1]), minute: Number(m[2]), tz: options.tz || localTz(), scope: options.scope || 'user' };
      if (options.weekly) {
        const d = WEEKDAYS.indexOf(String(options.weekly).slice(0, 3).toLowerCase());
        if (d < 0) throw new QuoxError('--weekly takes a day: mon, tue, wed, thu, fri, sat or sun.', 2);
        body.cadence = 'weekly';
        body.weekday = d;
      }
      if (options.collection) body.collection = options.collection;
      if (options.title) body.title_pattern = options.title;
      const ep = resolveEndpoint('notesq.schedules.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const x = data.schedule || {};
      announce('schedule', `${describeCadence(x)}, template ${x.template}`);
      console.log(`id: ${x.id}`);
      console.log(`first run: ${x.next_run_at} UTC`);
    });

  for (const [verb, enabled, desc] of [['pause', false, 'Pause a schedule'], ['resume', true, 'Resume a schedule (clears its failure count)']]) {
    schedule
      .command(verb)
      .description(desc)
      .argument('<id>', 'schedule id (nqs_...)')
      .action(async (id) => {
        auth.requireAuth();
        const ep = resolveEndpoint('notesq.schedules.update', { id });
        const data = await call(() => client.patch(ep.path, { service: ep.service, body: { enabled } }));
        if (isJson(program)) return printJson(data);
        announce(`schedule ${verb}`, id);
      });
  }

  schedule
    .command('rm')
    .description('Delete a schedule (notes it already made are kept)')
    .argument('<id>', 'schedule id (nqs_...)')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.schedules.delete', { id });
      const data = await call(() => client.delete(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      announce('schedule rm', id);
    });

  // ---- AssistantQ wires (AQ-9D P4): compose at the edge -----------------
  // Reads go through the other plugin's own governed route; writes through NotesQ's.

  notes
    .command('from-email')
    .description('Save an InboxQ email as a note (subject as title, sender and date, body quoted). Defaults to your personal notes')
    .argument('<messageId>', 'InboxQ message id (inbmsg_...), from `quox mail list -o json`')
    .option('--scope <scope>', 'org|user (default user)')
    .option('--collection <name>', 'collection for the note')
    .option('--tag <tag>', 'tag (repeatable)', (v, a) => [...(a || []), v])
    .action(async (messageId, options) => {
      auth.requireAuth();
      checkEnum(options.scope, SCOPES, '--scope');
      const gep = resolveEndpoint('inboxq.messages.get', { id: messageId });
      let msg = (await call(() => client.get(gep.path, { service: gep.service }))).message;
      if (!msg) throw new QuoxError(`InboxQ message ${messageId} not found.`, 1);
      if (!msg.bodyText && !msg.bodyHtml) {
        // Same on-demand fetch the InboxQ reader uses; on failure the snippet is saved and said so.
        try {
          const fep = resolveEndpoint('inboxq.messages.fetchBody', { id: messageId });
          const f = await client.post(fep.path, { service: fep.service, body: {} });
          if (f && f.message) msg = f.message;
          else if (f && (f.bodyText || f.bodyHtml)) msg = { ...msg, bodyText: f.bodyText, bodyHtml: f.bodyHtml };
        } catch { /* fall through to snippet */ }
      }
      const n = emailToNote(msg);
      const properties = { ...n.properties };
      if (options.collection) properties.collection = options.collection;
      if (options.tag) properties.tags = options.tag;
      const ep = resolveEndpoint('notesq.notes.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { scope: options.scope || 'user', markdown: n.markdown, properties } }));
      const id = data.note && data.note.id;
      if (isJson(program)) return printJson({ ...data, body_source: n.bodySource });
      announce('from-email', `"${n.title}"`);
      if (n.bodySource === 'snippet') console.log('warning: the full body could not be fetched; only the preview snippet was saved.');
      console.log(`link: ${noteLink(id)}`);
    });

  notes
    .command('actions')
    .description('Send a note\'s unchecked tasks (- [ ] ...) to Action-Q, each linking back to the note. Shows them unless --yes; tasks already sent are skipped')
    .argument('<id>', 'note id')
    .option('--priority <p>', 'priority for the new actions (low|medium|high|urgent)')
    .option('--yes', 'create the actions; without it nothing is created')
    .action(async (id, options) => {
      auth.requireAuth();
      const note = await getNote(id);
      const props = note.properties || {};
      const sent = new Set(Array.isArray(props.actions_extracted) ? props.actions_extracted : []);
      const tasks = extractTasks(note.markdown);
      const fresh = tasks.filter((t) => !sent.has(t.hash));
      if (!options.yes) {
        if (isJson(program)) return printJson({ dry_run: true, id, tasks: fresh, already_sent: tasks.length - fresh.length });
        if (!fresh.length) return console.log(tasks.length ? `All ${tasks.length} open task(s) in this note were already sent to Action-Q.` : 'No unchecked tasks (- [ ] ...) in this note.');
        for (const t of fresh) console.log(`would add: ${t.text}`);
        if (tasks.length > fresh.length) console.log(`(${tasks.length - fresh.length} already sent, skipped)`);
        return console.log(`Re-run with --yes to add these ${fresh.length} action(s) to Action-Q.`);
      }
      const orgId = resolveOrgId(auth, program);
      const aep = resolveEndpoint('notesq.actionq.create', { orgId });
      const created = [];
      for (const t of fresh) {
        const body = { title: t.text, tags: ['notesq'], notes: `From note "${note.title || 'Untitled'}": ${noteLink(id)}` };
        if (options.priority) body.priority = options.priority;
        const r = await call(() => client.post(aep.path, { service: aep.service, body }));
        created.push({ ...t, action_id: (r.item && r.item.id) || null });
      }
      // Bookkeeping so a re-run skips these; the note body itself is untouched.
      let recorded = true;
      if (created.length) {
        try {
          await putNote(id, { markdown: note.markdown, properties: { ...props, actions_extracted: [...sent, ...created.map((c) => c.hash)] }, base_hash: note.content_hash });
        } catch (e) { recorded = false; console.log(`warning: actions created, but recording them on the note failed (${e.message}); a re-run would add them again.`); }
      }
      if (isJson(program)) return printJson({ id, created, recorded });
      announce('actions', `${created.length} added to Action-Q`);
      for (const c of created) console.log(`added: ${c.text}`);
    });

  notes
    .command('promote')
    .description('Promote a note to a QuoxPlan stream: appends a stream note with the title, link and an excerpt')
    .argument('<id>', 'note id')
    .requiredOption('--stream <streamId>', 'QuoxPlan stream id (e.g. AQ-9D)')
    .action(async (id, options) => {
      auth.requireAuth();
      const note = await getNote(id);
      const pep = resolveEndpoint('quoxplan.stream.notes.create', { id: options.stream });
      const data = await call(() => client.post(pep.path, { service: pep.service, body: { body: promoteBody(note, noteLink(id)), actor: 'quox-cli' } }));
      const props = note.properties || {};
      const to = [...new Set([...(Array.isArray(props.promoted_to) ? props.promoted_to : []), options.stream])];
      let recorded = true;
      try { await putNote(id, { markdown: note.markdown, properties: { ...props, promoted_to: to }, base_hash: note.content_hash }); } catch { recorded = false; }
      if (isJson(program)) return printJson({ id, stream: options.stream, plan: data, recorded });
      announce('promote', `"${note.title || id}" -> ${options.stream}`);
      if (!recorded) console.log('warning: promoted, but recording promoted_to on the note failed (it changed meanwhile).');
    });

  // ---- session bulk authoring (AQ-9D P8) --------------------------------
  const batchTag = (batchId) => `batch-${String(batchId).slice(0, 8)}`;
  const sessionLabel = (v) => {
    const s = v || process.env.QUOX_SESSION_ID || '';
    return /^[\w.:@-]{1,80}$/.test(s) ? s : undefined;
  };

  /** POST a batch archive (dry run or real); a real run is polled to the end. */
  const sendBatch = async ({ archive, scope, collection, session, dryRun, pollMs }) => {
    const query = { format: 'batch' };
    if (scope) query.scope = scope;
    if (collection) query.collection = collection;
    if (session) query.session = session;
    if (dryRun) query.dry_run = 'true';
    const form = new FormData();
    form.append('file', new Blob([archive.bytes]), archive.filename);
    const ep = resolveEndpoint('notesq.import');
    // retries: 0, a retried upload would start a second batch.
    const data = await call(() => client.post(ep.path, { service: ep.service, body: form, query, timeout: 300000, retries: 0 }));
    if (dryRun) return { dry: data };
    if (!data.batch_id) throw new QuoxError('Batch did not return a batch id.', 1);
    if (!isJson(program)) console.log(`batch ${data.batch_id} started (check: quox notes import-status ${data.batch_id})`);
    const sp = resolveEndpoint('notesq.import.status', { jobId: data.batch_id });
    let st;
    for (;;) {
      st = await call(() => client.get(sp.path, { service: sp.service }));
      if (st.status !== 'running') break;
      await sleep(Math.max(Number(pollMs) || 2000, 0));
    }
    return { batchId: data.batch_id, st };
  };

  const printDry = (d, what) => {
    console.log(`Dry run: ${d.notes} notes, ${d.attachments} attachments. Nothing written.`);
    formatOutput({
      columns: ['collection', 'notes'],
      headers: ['Collection', 'Notes'],
      rows: Object.entries(d.collections || {}).map(([collection, n]) => ({ collection, notes: n })),
    }, { format: program.opts().output });
    if ((d.tags || []).length) console.log(`tags: ${d.tags.join(', ')}`);
    if ((d.sample || []).length) console.log(`sample: ${d.sample.join(' | ')}`);
    for (const w of d.warnings || []) console.log(`warning: ${w}`);
    console.log(`Re-run with --yes to ${what}.`);
  };

  notes
    .command('batch')
    .description(`Create many notes in one governed job (max ${MAX_BATCH_NOTES}) from a folder of markdown, a .jsonl file, or JSONL on stdin. Dry run unless --yes. Every note is tagged with the batch, so \`quox notes batch-undo\` removes the lot`)
    .argument('<source>', 'folder of .md (frontmatter: title, collection, tags, key) | file.jsonl | - (stdin); JSONL lines are {title, markdown, collection?, tags?, key?}')
    .option('--scope <scope>', 'org|user (default org)')
    .option('--collection <name>', 'put every note in this collection (overrides frontmatter)')
    .option('--session <label>', 'authoring session stored on each note as batch_session (default $QUOX_SESSION_ID)')
    .option('--yes', 'write the notes; without it nothing is written')
    .addOption(new Option('--poll-ms <n>', 'job poll interval').default('2000').hideHelp())
    .action(async (source, options) => {
      auth.requireAuth();
      checkEnum(options.scope, SCOPES, '--scope');
      const archive = await buildBatchArchive({ source, stdinText: source === '-' ? await readStdin() : undefined });
      const out = await sendBatch({ archive, scope: options.scope, collection: options.collection, session: sessionLabel(options.session), dryRun: !options.yes, pollMs: options.pollMs });
      if (out.dry) {
        if (isJson(program)) return printJson({ dry_run: true, ...out.dry });
        return printDry(out.dry, `write these ${out.dry.notes} notes`);
      }
      const { batchId, st } = out;
      if (isJson(program)) printJson({ batch_id: batchId, tag: batchTag(batchId), ...st });
      else {
        announce('batch', `${st.created} created, ${st.skipped} skipped, ${st.failed} failed`);
        for (const e of st.errors || []) console.log(`failed: ${e.title}: ${e.error}`);
        console.log(`tag: ${batchTag(batchId)}  (quox notes ls --scope all --tag ${batchTag(batchId)})`);
        console.log(`undo: quox notes batch-undo ${batchId} --yes`);
      }
      if (st.status === 'failed') throw new QuoxError(`Batch failed: ${st.error || 'unknown error'}`, 1);
      if (st.failed > 0) throw new QuoxError(`${st.failed} note(s) failed. The rest were written; undo the whole batch with quox notes batch-undo ${batchId} --yes`, 1);
    });

  notes
    .command('batch-undo')
    .description('Soft-delete every note one batch created (revisions kept, each note restorable). Shows what it would remove unless --yes')
    .argument('<batchId>', 'batch id printed by `quox notes batch` or `quox notes split`')
    .option('--yes', 'delete them; without it nothing is deleted')
    .action(async (batchId, options) => {
      auth.requireAuth();
      if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new QuoxError('Pass the full batch id (36 characters), as printed by quox notes batch.', 2);
      if (!options.yes) {
        const ep = resolveEndpoint('notesq.notes.list');
        const data = await call(() => client.get(ep.path, { service: ep.service, query: { scope: 'all', tag: batchTag(batchId), archived: 'include', limit: 200 } }));
        const hits = (data.notes || []).filter((n) => n.properties && n.properties.batch_id === batchId.toLowerCase());
        if (isJson(program)) return printJson({ dry_run: true, batch_id: batchId, notes: hits.map((n) => ({ id: n.id, title: n.title })) });
        if (!hits.length) return console.log(`No live notes belong to batch ${batchId} (already undone, or not visible to you).`);
        for (const n of hits) console.log(`would delete: ${n.title}  ${noteLink(n.id)}`);
        return console.log(`Re-run with --yes to delete these ${hits.length} notes.`);
      }
      const ep = resolveEndpoint('notesq.batch.undo', { batchId });
      const r = await call(() => client.post(ep.path, { service: ep.service, body: {} }));
      if (isJson(program)) printJson(r);
      else {
        announce('batch-undo', `${r.deleted} deleted, ${r.failed} failed of ${r.found}`);
        for (const e of r.errors || []) console.log(`failed: ${e.id}: ${e.error}`);
        if (!r.found) console.log('Nothing to undo: no live notes carry that batch id.');
      }
      if (r.failed > 0) throw new QuoxError(`${r.failed} note(s) could not be deleted (author or org admin only).`, 1);
    });

  notes
    .command('propose-skill')
    .description('Propose a note (an SOP) as a skill. It always lands pending human review, never runs until approved. Shows the derived skill unless --yes')
    .argument('<id>', 'note id')
    .option('--name <name>', 'skill name (default: slug of the note title)')
    .option('--category <category>', 'skill category (default procedure)')
    .option('--yes', 'create the pending skill; without it nothing is written')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.proposeSkill', { id });
      const body = { ...(options.name ? { name: options.name } : {}), ...(options.category ? { category: options.category } : {}) };
      if (!options.yes) {
        const r = await call(() => client.post(ep.path, { service: ep.service, body: { ...body, dry_run: true } }));
        if (isJson(program)) return printJson(r);
        const p = r.payload || {};
        console.log(`name: ${p.name}`);
        console.log(`category: ${p.category}`);
        console.log(`description: ${p.description}`);
        console.log(String(p.bodyMd || '').split('\n').slice(0, 8).join('\n'));
        return console.log('Re-run with --yes to propose it. It lands as an experimental skill, outside the stable library; an automated safety check reviews it and anything flagged goes to the human review queue (quox skills review).');
      }
      const r = await call(() => client.post(ep.path, { service: ep.service, body, retries: 0 }));
      if (isJson(program)) return printJson(r);
      announce('propose-skill', `${r.skill.name} (${r.skill.id}) experimental`);
      if (!r.note_updated) console.log('Note: the skill was created but the note could not be updated with the link (it changed meanwhile).');
      console.log('Review it with: quox skills review');
    });

  notes
    .command('split')
    .description('Split a note at its headings into child notes (one batch), and turn the original into an index linking to them. Dry run unless --yes')
    .argument('<id>', 'note id')
    .option('--level <n>', 'heading level to cut at (default: the shallowest heading under the title)')
    .option('--yes', 'write the children and rewrite the parent; without it nothing is written')
    .addOption(new Option('--poll-ms <n>', 'job poll interval').default('2000').hideHelp())
    .action(async (id, options) => {
      auth.requireAuth();
      if (options.level !== undefined && !/^[1-6]$/.test(String(options.level))) throw new QuoxError('--level must be 1 to 6.', 2);
      const note = await getNote(id);
      const plan = splitMarkdown(note.markdown, { level: options.level });
      if (plan.sections.length < 2) throw new QuoxError(`Nothing to split: note ${id} has fewer than two headings at ${plan.level ? `level ${plan.level}` : 'any level'} under its title.`, 2);
      if (plan.sections.length > MAX_BATCH_NOTES) throw new QuoxError(`That would make ${plan.sections.length} notes; a batch may create at most ${MAX_BATCH_NOTES}.`, 2);
      const title = plan.title || note.title || 'Untitled';
      const props = note.properties || {};
      const tags = (note.tags || props.tags || []).filter((t) => !/^batch-[0-9a-f]{8}$/.test(t));
      const items = plan.sections.map((sec, k) => ({
        title: sec.title,
        markdown: `# ${sec.title}\n\n${sec.body}\n`,
        collection: typeof props.collection === 'string' ? props.collection : undefined,
        tags,
        key: `split:${id}:${k}`,
      }));
      const parentMd = indexMarkdown({ title, preamble: plan.preamble, children: items.map((i) => i.title) });
      if (!options.yes) {
        if (isJson(program)) return printJson({ dry_run: true, id, level: plan.level, children: items.map((i) => ({ title: i.title, chars: i.markdown.length })), parent_markdown: parentMd });
        console.log(`Split "${title}" at level ${plan.level} into ${items.length} notes:`);
        for (const i of items) console.log(`  - ${i.title} (${i.markdown.length} chars)`);
        console.log('\nThe original would become:\n');
        console.log(parentMd);
        return console.log('Re-run with --yes to write the children and rewrite the original (both undoable).');
      }
      const archive = await buildBatchArchive({ items, name: `split-${String(id).slice(0, 8)}` });
      const { batchId, st } = await sendBatch({ archive, scope: note.scope, session: sessionLabel(), pollMs: options.pollMs });
      const undoChildren = `quox notes batch-undo ${batchId} --yes`;
      if (st.status === 'failed' || st.failed > 0 || st.created + st.skipped !== items.length) {
        throw new QuoxError(`Split stopped: ${st.created} of ${items.length} children written (${st.failed} failed${st.error ? `, ${st.error}` : ''}). The original was NOT changed. Remove the partial children with: ${undoChildren}`, 1);
      }
      const rep = resolveEndpoint('notesq.notes.revisions', { id });
      const revs = await call(() => client.get(rep.path, { service: rep.service }));
      const prevRev = Math.max(0, ...((revs.revisions || []).map((r) => Number(r.rev) || 0)));
      try {
        await putNote(id, { markdown: parentMd, properties: props, base_hash: note.content_hash });
      } catch (e) {
        throw new QuoxError(`${e.message}\nThe ${st.created} children were written as batch ${batchId}; remove them with: ${undoChildren}`, 1);
      }
      if (isJson(program)) return printJson({ id, batch_id: batchId, children: st.created + st.skipped, previous_rev: prevRev });
      announce('split', `${items.length} notes from "${title}"`);
      console.log(`index: ${noteLink(id)}`);
      console.log(`children tag: ${batchTag(batchId)}`);
      console.log(`undo: ${undoChildren} && quox notes restore ${id} --rev ${prevRev}`);
    });

  const settings = notes
    .command('settings')
    .description('NotesQ platform settings (alias over `quox settings`, NOTESQ_ keys only). Changing one needs a human org admin.');

  settings
    .command('list', { isDefault: true })
    .description('List NotesQ settings for the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.settings.list');
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      const flags = (data.flags || []).filter((f) => String(f.key).startsWith('NOTESQ_'));
      if (isJson(program)) return printJson({ flags });
      formatOutput({
        columns: ['key', 'value', 'source'],
        headers: ['KEY', 'VALUE', 'SOURCE'],
        rows: flags.map((f) => ({ key: f.key, value: f.value, source: f.source })),
        emptyMessage: 'No NotesQ settings.',
      }, { format: program.opts().output });
    });

  settings
    .command('set')
    .description(`Change a NotesQ setting (${Object.keys(SETTING_ALIASES).join('|')} or the full NOTESQ_ key). Needs a human org admin.`)
    .argument('<key>', 'short name or full key')
    .argument('<value>', 'new value')
    .action(async (name, value) => {
      auth.requireAuth();
      const key = SETTING_ALIASES[name] || (Object.values(SETTING_ALIASES).includes(name) ? name : null);
      if (!key) throw new QuoxError(`Unknown NotesQ setting "${name}". Use one of: ${Object.keys(SETTING_ALIASES).join(', ')} (or the full key, e.g. ${SETTING_ALIASES['autosave-ms']}).`, 2);
      const ep = resolveEndpoint('v1.settings.set', { key });
      const data = await call(() => client.patch(ep.path, { service: ep.service, body: { value } }), { forbidden: 'Changing settings needs a human org admin.' });
      if (isJson(program)) return printJson(data);
      announce(`setting ${key}`, `${data.old_value ?? '(unset)'} -> ${data.new_value}`);
    });

  notes
    .command('scorecard')
    .description('Run the NotesQ scorecard (scripts/notesq-scorecard.mjs in the dashboard repo), streaming its output')
    .option('--keep', 'keep the scorecard\'s test data')
    .action(async (options) => {
      if (!existsSync(scorecardPath)) {
        console.log('The NotesQ scorecard ships with the dashboard repo (scripts/notesq-scorecard.mjs); run it from a dashboard checkout.');
        return;
      }
      const args = [scorecardPath];
      if (options.keep) args.push('--keep');
      const code = await new Promise((done, fail) => {
        const child = spawn(process.execPath, args, { cwd: resolve(dirname(scorecardPath), '..'), stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.on('data', (c) => process.stdout.write(c));
        child.stderr.on('data', (c) => process.stderr.write(c));
        child.on('error', fail);
        child.on('close', (c) => done(c ?? 1));
      });
      if (code !== 0) throw new QuoxError(`Scorecard exited with code ${code}.`, code);
    });
}
