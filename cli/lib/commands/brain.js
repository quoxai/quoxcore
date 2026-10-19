/**
 * Brain commands: search, status, vaults, notes (Quox Qortex)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Option } from 'commander';
import { buildBatchArchive } from './notesBatch.js';
import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { QuoxApiError, QuoxError } from '../core/errors.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { line as glyphLine, brandName } from '../core/quoxglyph.js';
import { resolveOrgId } from './helpers.js';

// Which surface a hit came from, in words a person recognises.
function recallSource(r) {
  if (r.kind === 'transcript_session') return 'past session';
  if (r.kind === 'quoxplan_note' || r.kind === 'quoxplan_stream') return 'QuoxPlan';
  if (r.kind === 'commit') return 'git history';
  if (r.kind === 'code') return 'codebase';
  if (r.kind === 'memory') return 'QuoxMemory';
  if (r.kind === 'tasks_execution_wisdom') return 'execution wisdom';
  if ((r.relPath || '').startsWith('memory/')) return 'saved memory';
  return r.kind === 'note' ? 'knowledge brain' : (r.kind || 'knowledge brain');
}

// A readable one-line snippet: strip FTS highlight brackets, YAML
// frontmatter scaffolding, and a leading echo of the title.
function recallSnippet(r) {
  let s = (r.snippet || '').replace(/\[([^\]]*)\]/g, '$1');
  const desc = s.match(/description:\s*(.+)/);
  if (desc) s = desc[1];
  else {
    s = s.replace(/^---$|^name:.*$/gm, ' ');
    if (r.title && s.startsWith(r.title)) s = s.slice(r.title.length);
  }
  s = s.replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  return s.length > 110 ? `${s.slice(0, 107)}...` : (s || r.title || '');
}

const slug = (t) => String(t || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'untitled';

const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
/** Share of the smaller word set found in the other (0..1); the decide dedupe score. */
export function titleOverlap(a, b) {
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size);
}
const NEGATIVE_WORDS = new Set(['disable', 'disabled', 'disabling', 'off', 'deny', 'denied', 'block', 'blocked', 'stop', 'stopped', 'remove', 'removed', 'drop', 'dropped', 'abandon', 'abandoned', 'reject', 'rejected', 'exclude', 'excluded', 'not', 'never', 'no', 'dont', 'cannot', 'cant', 'wont', 'without', 'revoke', 'revoked']);
/** Odd count of negating words = negative polarity ("not", "stop", "disable", "reject", ...). */
function negativeParity(t) {
  const toks = String(t || '').toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  let n = 0;
  for (const w of toks) if (NEGATIVE_WORDS.has(w)) n++;
  return n % 2;
}
/** True when two decision titles read as opposites (enable/disable, on/off, stop X, no longer X...). */
export function oppositePolarity(a, b) {
  return negativeParity(a) !== negativeParity(b);
}
export const DECIDE_DUPE_THRESHOLD = 0.6;
export const DISTILL_CAP = 50;

function gitOut(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

/** Where and when a decision was made: time, repo + commit, stream, held slot. */
export function decisionProvenance(now = new Date()) {
  const prov = { at: now.toISOString() };
  const top = gitOut(['rev-parse', '--show-toplevel']);
  if (top) {
    prov.repo = top.split('/').pop();
    const sha = gitOut(['rev-parse', '--short', 'HEAD']);
    if (sha) prov.commit = sha;
  }
  if (process.env.QUOX_STREAM) prov.stream = process.env.QUOX_STREAM;
  try {
    const f = join(homedir(), '.quox', 'held-slots.json');
    if (existsSync(f)) {
      const held = JSON.parse(readFileSync(f, 'utf8'));
      const sess = process.env.QUOX_SESSION_ID;
      const me = Object.keys(held).find((k) => sess && held[k]?.session === sess);
      if (me) prov.slot = me;
    }
  } catch { /* no slot file: leave it out */ }
  return prov;
}

export function decisionMarkdown({ what, why, rejected = [], prov }) {
  const lines = [`# Decision: ${what}`, '', 'Kind: decision', '', '## What', what, '', '## Why', why || 'Not recorded.', '', '## Rejected alternatives'];
  if (rejected.length) for (const r of rejected) lines.push(`- ${r}`); else lines.push('None recorded.');
  lines.push('', '## Provenance');
  for (const [k, v] of Object.entries(prov)) lines.push(`- ${k}: ${v}`);
  return `${lines.join('\n')}\n`;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const OUTPUT_HELP = 'Output: add -o json (global flag) for machine-readable output; note ids from search are full ids usable with quox brain note <id>.';

/**
 * ONE-BRAIN CX5: score judgements against search responses (pure, unit-tested).
 * judgements: [{query, note_id, verdict}]; searches: {query: searchResponse};
 * a search response abstains when insufficient is true (top-level or in relevance).
 * Rank = position of the first relevant note in the top k (1-based); MRR uses
 * that rank. A query abstaining counts as a miss for relevant-judged queries.
 */
export function scoreRetrievalEval(judgements, searches, k = 8) {
  const idOf = (r) => r.noteId || r.note_id || r.id;
  const byQuery = new Map();
  for (const j of judgements) {
    if (!byQuery.has(j.query)) byQuery.set(j.query, { relevant: new Set(), irrelevant: new Set(), abstain: false });
    const e = byQuery.get(j.query);
    if (j.verdict === 'relevant') e.relevant.add(j.note_id);
    else if (j.verdict === 'irrelevant') e.irrelevant.add(j.note_id);
    else if (j.verdict === 'should_abstain') e.abstain = true;
  }
  let relQ = 0, h1 = 0, h3 = 0, hk = 0, rr = 0, irrTop3 = 0, absQ = 0, absOk = 0;
  for (const [q, e] of byQuery) {
    const data = searches[q] || {};
    const insufficient = data.insufficient === true || data.relevance?.insufficient === true;
    const ids = (data.results || []).slice(0, k).map(idOf);
    if (e.relevant.size) {
      relQ++;
      const idx = insufficient ? -1 : ids.findIndex((id) => e.relevant.has(id));
      if (idx >= 0) { const rank = idx + 1; if (rank <= 1) h1++; if (rank <= 3) h3++; hk++; rr += 1 / rank; }
    }
    if (e.irrelevant.size && !insufficient) irrTop3 += ids.slice(0, 3).filter((id) => e.irrelevant.has(id)).length;
    if (e.abstain) { absQ++; if (insufficient) absOk++; }
  }
  const frac = (n) => (relQ ? n / relQ : null);
  return {
    k,
    queries: byQuery.size,
    judgements: judgements.length,
    relevant: { queries: relQ, hitAt1: frac(h1), hitAt3: frac(h3), hitAtK: frac(hk), mrr: relQ ? rr / relQ : null },
    irrelevantInTop3: irrTop3,
    abstain: { queries: absQ, abstained: absOk, rate: absQ ? absOk / absQ : null },
  };
}

export function registerBrainCommands(program, ctx) {
  const { client, auth } = ctx;

  // quox#934: read/history/related go through the NotesQ API, which only knows
  // editable NotesQ notes. A feed note (git_commit, email, ...) that `brain note`
  // resolves came back as a bare 404. On a NotesQ 404, ask the brain itself;
  // rethrow the original error when the brain does not know the note either.
  const brainNoteOn404 = async (noteId, err) => {
    if (!(err instanceof QuoxApiError) || err.status !== 404) throw err;
    let note;
    try {
      const ep = resolveEndpoint('brain.note.get', { id: noteId });
      note = await client.get(ep.path, { service: ep.service });
    } catch {
      throw err;
    }
    if (!note || !note.id) throw err;
    return note;
  };
  const feedReason = (n, what) => `${n.id} is a ${n.kind || 'feed'} note${n.source_type ? ` from the ${n.source_type} source` : ''}, not an editable NotesQ note, so it has no ${what}.`;

  const brain = program
    .command('brain')
    .description('Query Quox Qortex (vaults, notes, semantic search)')
    .addHelpText('after', `\n${OUTPUT_HELP}`);

  brain
    .command('search')
    .description('Search the brain')
    .addHelpText('after', `\n${OUTPUT_HELP}`)
    .argument('<query>', 'search query')
    .option('--limit <n>', 'max results', '10')
    .option('--since <date>', 'only notes dated on or after this ISO date/datetime (e.g. 2026-10-05)')
    .option('--until <date>', 'only notes dated on or before this ISO date/datetime (a date alone means the whole day)')
    .option('--brief', 'announce + one recall line per hit (what was found, from where); for sessions')
    .action(async (query, options) => {
      auth.requireAuth();
      const body = { query, limit: Number(options.limit) };
      if (options.since) body.since = options.since;
      if (options.until) body.until = options.until;
      const data = await client.post(resolveEndpoint('brain.search.list').path, { service: resolveEndpoint('brain.search.list').service, body });
      // BRAIN2-W5 141: Qortex flags weak matches `insufficient` (top-level or in
      // `relevance`). Never present them as successful recall.
      const insufficient = data.insufficient === true || data.relevance?.insufficient === true;
      if (program.opts().output === 'json') {
        // Keep the full relevance envelope; scripts must be able to see the abstention.
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      // quox#853: a keyword-only fallback fooled both the product and a
      // verifier ("0 hits" read as "does not exist"). Say it in words.
      const degradedNote = data.retrieval === 'fts' && data.degraded
        ? '⚠ Semantic search was unavailable for this query, so this is keyword-only: a missing or zero result does not prove the note is absent. Retry shortly.'
        : '';
      if (insufficient) {
        const legLabel = data.retrieval ? ` · ${data.retrieval}` : '';
        console.log(glyphLine('brain2', `search "${query.slice(0, 40)}"`, { result: `0 relevant hits${legLabel}`, ms: data.tookMs ?? '?' }));
        console.log('⚠ Qortex judged the matches for this query insufficient (no relevant notes). The weak hits are withheld; use -o json to see them with the relevance details.');
        if (degradedNote) console.log(degradedNote);
        return;
      }
      // BRAIN2-AUDIT: sessions must SEE what Qortex recalled, not just a hit
      // count, in a few cheap lines they can cite (note id prefix included).
      if (options.brief && program.opts().output !== 'json') {
        const results = data.results || [];
        const legLabel = data.retrieval ? ` · ${data.retrieval}` : '';
        console.log(glyphLine('brain2', `search "${query.slice(0, 40)}"`, { result: `${results.length} hits${legLabel}`, ms: data.tookMs ?? '?' }));
        if (degradedNote) console.log(degradedNote);
        if (results.length === 0) {
          console.log(glyphLine('brain2', 'recall', { result: 'nothing on record for this query' }));
          return;
        }
        for (const r of results) {
          const miss = Array.isArray(r.missingEntities) && r.missingEntities.length ? ` · does not mention ${r.missingEntities.join(', ')}` : '';
          console.log(`${brandName('🌌 QORTEX')} recall │ "${recallSnippet(r)}" · ${recallSource(r)} · ${r.title || 'untitled'} · note ${r.noteId || '?'}${miss}`);
        }
        return;
      }
      // BRAIN2-SEMANTIC: the endpoint reports which retrieval path actually
      // served (hybrid = dense+sparse fused, fts = keyword-only fallback) —
      // announce it so a degraded search is visible, never silent.
      if (program.opts().output !== 'json') {
        const legLabel = data.retrieval ? ` · ${data.retrieval}` : '';
        console.log(glyphLine('brain2', `search "${query.slice(0, 40)}"`, { result: `${(data.results || []).length} hits${legLabel}`, ms: data.tookMs ?? '?' }));
        if (degradedNote) console.log(degradedNote);
      }
      formatOutput({
        columns: ['title', 'kind', 'snippet', 'score'],
        headers: ['Title', 'Kind', 'Snippet', 'Score'],
        rows: (data.results || []).map(r => ({
          ...r,
          snippet: (r.snippet || '').slice(0, 80),
          score: r.score != null ? r.score.toFixed(2) : '-',
        })),
      }, { format: program.opts().output });
    });

  // BRAIN2-AUDIT: "I can never think of anything to ask it." Questions are
  // generated server-side from the org's own corpus (no LLM), so each line is
  // something the brain can actually answer.
  brain
    .command('suggest')
    .description('Suggest questions to ask the brain, generated from your own notes')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.suggestions.list');
      const data = await client.get(ep.path, { service: ep.service });
      const suggestions = data.suggestions || [];
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(glyphLine('brain2', 'suggest', { result: `${suggestions.length} questions` }));
      if (suggestions.length === 0) {
        console.log(data.message || 'Nothing in your brain to suggest from yet.');
        return;
      }
      for (const s of suggestions) {
        console.log(`  ${s.question}  (${s.source})`);
      }
    });

  // BRAIN2-V3 B3: what entered the brain since T. Deterministic, scoped like search.
  brain
    .command('brief')
    .description('What is new in your brain (counts by source, top new notes, open questions)')
    .option('--since <window>', 'time window, e.g. 24h, 7d, 90m', '24h')
    .option('--stream <id>', 'narrow to one roadmap stream (QuoxPlan stream id, e.g. AQ-9F)')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.brief.get');
      const qs = `since=${encodeURIComponent(options.since)}${options.stream ? `&stream=${encodeURIComponent(options.stream)}` : ''}`;
      const data = await client.get(`${ep.path}?${qs}`, { service: ep.service });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(glyphLine('brain2', `brief${options.stream ? ` ${options.stream}` : ''} since ${options.since}`, { result: `${data.total || 0} new` }));
      console.log(data.summary || 'Nothing new entered your brain in this window.');
      for (const n of data.topNotes || []) console.log(`  ${n.title}  (${n.source})`);
      if ((data.openQuestions || []).length) {
        console.log('Open questions:');
        for (const q of data.openQuestions) console.log(`  ${q.question}`);
      }
    });

  // BRAIN2-V3 A2: capture everywhere. Text, or a URL to clip (HTML/PDF), lands
  // as an editable NotesQ note, searchable immediately.
  brain
    .command('add')
    .description('Save text (or clip a URL) into your brain as a note')
    .argument('[text]', 'text to save (omit with --url to clip the page)')
    .option('--title <title>', 'note title')
    .option('--url <url>', 'source URL (clipped server-side if no text is given)')
    .option('--tag <tag>', 'tag (repeatable)', (v, acc) => acc.concat(v), [])
    .action(async (text, options) => {
      auth.requireAuth();
      if (!text && !options.url) {
        console.error('Give some text, or --url <url> to clip a page.');
        process.exitCode = 1;
        return;
      }
      const body = {};
      if (text) body.text = text;
      if (options.title) body.title = options.title;
      if (options.url) body.url = options.url;
      if (options.tag && options.tag.length) body.tags = options.tag;
      const ep = resolveEndpoint('brain.capture.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const verb = data.status === 'created' ? 'saved' : data.status === 'unchanged' ? 'already saved' : 'updated';
      console.log(glyphLine('brain2', 'capture', { result: `${verb} · note ${String(data.noteId || '?').slice(0, 8)}` }));
    });

  // ONE-BRAIN CX3: session-native verbs. `decide` reuses /brain/capture;
  // `distill` reuses the NotesQ batch import (keys = idempotency, batch id = undo).
  brain
    .command('decide')
    .description('Record a decision (what, why, rejected alternatives, provenance). Checks the brain for an existing match first')
    .argument('<what>', 'what was decided')
    .requiredOption('--why <reason>', 'why it was decided')
    .option('--rejected <alt>', 'alternative considered and rejected (repeatable)', (v, acc) => acc.concat(v), [])
    .option('--scope <scope>', 'private (default) or org', 'private')
    .option('--tags <a,b>', 'comma-separated extra tags')
    .option('--force', 'save even when a strong existing match is found')
    .option('--dry-run', 'print the decision note and save nothing')
    .action(async (what, options) => {
      auth.requireAuth();
      if (!['private', 'org'].includes(options.scope)) throw new QuoxError('--scope must be private or org.', 2);
      const prov = decisionProvenance();
      const title = `Decision: ${what}`.slice(0, 200);
      let markdown = decisionMarkdown({ what, why: options.why, rejected: options.rejected, prov });
      const tags = ['decision', ...String(options.tags || '').split(',').map((t) => t.trim()).filter(Boolean)];
      const json = program.opts().output === 'json';
      if (options.dryRun) {
        if (json) console.log(JSON.stringify({ dry_run: true, title, scope: options.scope, tags, markdown }, null, 2));
        else { console.log(markdown); console.log(glyphLine('brain2', 'decide', { result: 'dry run, nothing saved' })); }
        return;
      }
      const sp = resolveEndpoint('brain.search.list');
      const found = await client.post(sp.path, { service: sp.service, body: { query: what, limit: 5 } });
      const insufficient = found.insufficient === true || found.relevance?.insufficient === true;
      const bare = (r) => String(r.title || '').replace(/^Decision:\s*/i, '');
      const matches = insufficient ? [] : (found.results || []).filter((r) => titleOverlap(what, bare(r)) >= DECIDE_DUPE_THRESHOLD);
      // An opposite-polarity match is a reversal of the earlier decision, never a duplicate of it.
      const dupe = matches.find((r) => !oppositePolarity(what, bare(r)));
      const reversed = dupe ? null : matches[0];
      if (reversed) {
        const ref = reversed.noteId || reversed.title;
        if (ref) markdown = decisionMarkdown({ what, why: options.why, rejected: options.rejected, prov: { ...prov, supersedes: ref } });
      }
      if (dupe && !options.force) {
        if (json) console.log(JSON.stringify({ saved: false, reason: 'existing_match', match: { noteId: dupe.noteId, title: dupe.title, kind: dupe.kind } }, null, 2));
        else {
          console.log(glyphLine('brain2', 'decide', { result: 'existing match, not saved' }));
          console.log(`  ${dupe.title || 'untitled'}  (${dupe.kind || 'note'}) note ${dupe.noteId || '?'}`);
          console.log('Re-run with --force to record it anyway.');
        }
        process.exitCode = 1;
        return;
      }
      const ep = resolveEndpoint('brain.capture.create');
      const data = await client.post(ep.path, { service: ep.service, body: { title, text: markdown.replace(/^# .*\n\n/, ''), tags, scope: options.scope === 'org' ? 'org' : 'user' } });
      if (json) { console.log(JSON.stringify(reversed ? { ...data, reverses: { noteId: reversed.noteId, title: reversed.title } } : data, null, 2)); return; }
      const verb = data.status === 'created' ? 'saved' : data.status === 'unchanged' ? 'already saved' : 'updated';
      console.log(glyphLine('brain2', 'decide', { result: `${verb} · note ${String(data.noteId || '?').slice(0, 8)}` }));
      if (reversed) console.log(`  reverses ${reversed.title || 'untitled'}  (note ${reversed.noteId || '?'})`);
    });

  brain
    .command('distill')
    .description(`Write session learnings as notes from JSONL ({key,title,text,tags?} per line, max ${DISTILL_CAP}). Re-running skips existing keys; --undo removes a batch`)
    .argument('[file]', 'JSONL file, or - for stdin')
    .option('--undo <batchId>', 'soft-delete every note a previous distill batch created')
    .option('--dry-run', 'validate and count; write nothing')
    .option('--scope <scope>', 'org|user (default user, i.e. private)', 'user')
    .addOption(new Option('--poll-ms <n>', 'job poll interval').default('1000').hideHelp())
    .action(async (file, options) => {
      auth.requireAuth();
      const json = program.opts().output === 'json';
      if (options.undo) {
        if (!/^[0-9a-f-]{36}$/i.test(options.undo)) throw new QuoxError('Pass the full batch id (36 characters) printed by quox brain distill.', 2);
        const ep = resolveEndpoint('notesq.batch.undo', { batchId: options.undo });
        const r = await client.post(ep.path, { service: ep.service, body: {} });
        if (json) { console.log(JSON.stringify(r, null, 2)); return; }
        console.log(glyphLine('brain2', 'distill undo', { result: `${r.deleted} deleted, ${r.failed} failed of ${r.found}` }));
        if (r.failed > 0) process.exitCode = 1;
        return;
      }
      if (!file) throw new QuoxError('Give a JSONL file (or - for stdin), or --undo <batchId>.', 2);
      if (!['org', 'user'].includes(options.scope)) throw new QuoxError('--scope must be org or user.', 2);
      let text;
      if (file === '-') { const chunks = []; for await (const c of process.stdin) chunks.push(c); text = Buffer.concat(chunks).toString('utf8'); }
      else { try { text = readFileSync(file, 'utf8'); } catch (e) { throw new QuoxError(`Cannot read ${file}: ${e.message}`, 2); } }
      const items = [];
      text.split(/\r?\n/).forEach((l, i) => {
        if (!l.trim()) return;
        let o;
        try { o = JSON.parse(l); } catch (e) { throw new QuoxError(`Line ${i + 1} is not valid JSON: ${e.message}`, 2); }
        for (const f of ['key', 'title', 'text']) if (typeof o[f] !== 'string' || !o[f].trim()) throw new QuoxError(`Line ${i + 1} needs a non-empty "${f}".`, 2);
        if (o.tags !== undefined && !Array.isArray(o.tags)) throw new QuoxError(`Line ${i + 1}: tags must be an array.`, 2);
        items.push({ key: `distill:${o.key.trim()}`, title: o.title.trim(), markdown: `# ${o.title.trim()}\n\n${o.text.trim()}\n`, tags: ['distilled', ...o.tags || []] });
      });
      if (!items.length) throw new QuoxError('No learnings in the input.', 2);
      if (items.length > DISTILL_CAP) throw new QuoxError(`distill takes at most ${DISTILL_CAP} learnings per call (got ${items.length}). Split the file.`, 2);
      if (new Set(items.map((i) => i.key)).size !== items.length) throw new QuoxError('Duplicate keys in the input; each learning needs a unique key.', 2);
      const archive = await buildBatchArchive({ items, name: 'distill' });
      const query = { format: 'batch', scope: options.scope };
      const session = process.env.QUOX_SESSION_ID;
      if (session && /^[\w.:@-]{1,80}$/.test(session)) query.session = session;
      if (options.dryRun) query.dry_run = 'true';
      const form = new FormData();
      form.append('file', new Blob([archive.bytes]), archive.filename);
      const ep = resolveEndpoint('notesq.import');
      const data = await client.post(ep.path, { service: ep.service, body: form, query, timeout: 300000, retries: 0 });
      if (options.dryRun) {
        if (json) { console.log(JSON.stringify({ dry_run: true, ...data }, null, 2)); return; }
        console.log(glyphLine('brain2', 'distill', { result: `dry run, ${data.notes ?? items.length} learnings, nothing written` }));
        return;
      }
      if (!data.batch_id) throw new QuoxError('Distill did not return a batch id.', 1);
      const sp = resolveEndpoint('notesq.import.status', { jobId: data.batch_id });
      let st;
      for (;;) {
        st = await client.get(sp.path, { service: sp.service });
        if (st.status !== 'running') break;
        await sleepMs(Math.max(Number(options.pollMs) || 1000, 0));
      }
      if (json) console.log(JSON.stringify({ batch_id: data.batch_id, ...st }, null, 2));
      else {
        console.log(glyphLine('brain2', 'distill', { result: `${st.created} created, ${st.skipped} skipped, ${st.failed} failed` }));
        console.log(`batch: ${data.batch_id}`);
        console.log(`undo: quox brain distill --undo ${data.batch_id}`);
      }
      if (st.status === 'failed' || st.failed > 0) process.exitCode = 1;
    });

  brain
    .command('status')
    .description('Show brain status (note count + milestone)')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('brain.status.list').path, { service: resolveEndpoint('brain.status.list').service });
      // BRAIN2-SEMANTIC: surface the semantic-search state (ready | indexing
      // | no_provider | unknown) + pending count alongside the base stats.
      const emb = data.embeddings;
      const detail = {
        ...(data.stats || data),
        ...(emb && !emb.byOrg ? {
          semantic_search: emb.state || 'unknown',
          semantic_provider: emb.provider || 'none',
          embedded_chunks: `${emb.embedded ?? '?'} / ${emb.total ?? '?'}`,
          ...(emb.pending ? { embedding_pending: emb.pending } : {}),
        } : {}),
      };
      formatDetail(detail, {
        format: program.opts().output,
        title: 'Brain Status',
      });
    });

  // BRAIN2-AUDIT: the usage ledger, so "is the brain actually being used?"
  // is a number in the terminal rather than a guess. Counts are org-scoped
  // server-side; surfaces are fixed (search/context/note_read/graph) so a
  // zero row still prints instead of silently vanishing.
  // BRAIN2-W13 A 118: what did the agent cite, and was it supported? Rows are
  // persisted server-side per finalized turn (org+user scoped).
  brain
    .command('citations')
    .description('Show persisted agent citations (what was cited, and whether it was supported)')
    .option('--session <id>', 'only this session / turn id')
    .option('--limit <n>', 'max rows (default 50, cap 200)', '50')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.citations.list');
      const query = { limit: Number(options.limit) };
      if (options.session) query.session = options.session;
      const data = await client.get(ep.path, { service: ep.service, query });
      const format = program.opts().output;
      if (format === 'json') {
        formatDetail(data, { format });
        return;
      }
      const verdict = (r) => (r.fabricated || r.support_method === 'fabricated' ? 'fabricated' : r.support_method === 'unchecked' ? 'unchecked' : r.contradicted ? 'contradicted' : r.supported === true ? 'supported' : r.support_method === 'overlap' ? 'overlap' : r.supported === false ? 'unsupported' : 'not measured');
      formatOutput({
        columns: ['session', 'handle', 'note', 'span', 'rev', 'verdict', 'at'],
        headers: ['Session', 'Handle', 'Note', 'Span', 'Rev', 'Verdict', 'At'],
        rows: (data.records || []).map((r) => ({
          session: r.session || '-',
          handle: r.handle || '-',
          note: r.note_id || '-',
          span: r.char_start != null && r.char_end != null ? `${r.char_start}-${r.char_end}` : '-',
          rev: r.note_hash ? String(r.note_hash).slice(0, 8) : '-',
          verdict: verdict(r),
          at: r.created_at,
        })),
      }, { format, emptyMessage: 'No citations recorded yet.' });
    });

  brain
    .command('usage')
    .description('Show brain usage (queries per surface, this week and total)')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('brain.usage.list').path, { service: resolveEndpoint('brain.usage.list').service });
      const format = program.opts().output;
      // Scripts want the ledger's own shape in one blob, not the three
      // human tables below.
      if (format === 'json') {
        formatDetail(data, { format });
        return;
      }

      const week = data.week || {};
      const total = data.total || {};
      const SURFACES = ['search', 'context', 'note_read', 'graph'];
      formatOutput({
        columns: ['surface', 'week', 'total'],
        headers: ['Surface', 'Week', 'Total'],
        rows: SURFACES.map(s => ({ surface: s, week: week[s] ?? 0, total: total[s] ?? 0 })),
      }, { format });

      const weekSources = week.byExternalSource || {};
      const totalSources = total.byExternalSource || {};
      const sources = [...new Set([...Object.keys(weekSources), ...Object.keys(totalSources)])].sort();
      formatOutput({
        columns: ['source', 'week', 'total'],
        headers: ['Source', 'Week', 'Total'],
        rows: sources.map(s => ({ source: s, week: weekSources[s] ?? 0, total: totalSources[s] ?? 0 })),
      }, { format, emptyMessage: 'No usage recorded yet.' });

      // BRAIN2-V2-1: agent grounding — answers that followed a brain search,
      // and how many actually cited a retrieved note. Absent-tolerant: older
      // servers without the citations aggregate just skip the block.
      const cites = data.citations;
      if (cites && (cites.week || cites.total)) {
        const cw = cites.week || {};
        const ct = cites.total || {};
        if ((ct.answers ?? 0) === 0) {
          formatDetail({ grounding: 'No brain-grounded answers recorded yet.' }, { format, title: 'Agent grounding' });
        } else {
          const pct = (g, a) => (a > 0 ? `${Math.round((g / a) * 100)}%` : '-');
          formatOutput({
            columns: ['metric', 'week', 'total'],
            headers: ['Grounding', 'Week', 'Total'],
            rows: [
              { metric: 'answers after brain search', week: cw.answers ?? 0, total: ct.answers ?? 0 },
              { metric: 'answers citing a note', week: `${cw.grounded ?? 0} (${pct(cw.grounded ?? 0, cw.answers ?? 0)})`, total: `${ct.grounded ?? 0} (${pct(ct.grounded ?? 0, ct.answers ?? 0)})` },
              ...((cw.supportMeasured ?? 0) + (ct.supportMeasured ?? 0) > 0
                ? [{ metric: 'answers with supported citations (entailment)', week: `${cw.supportedAnswers ?? 0} (${pct(cw.supportedAnswers ?? 0, cw.supportMeasured ?? 0)})`, total: `${ct.supportedAnswers ?? 0} (${pct(ct.supportedAnswers ?? 0, ct.supportMeasured ?? 0)})` },
                   { metric: 'answers with overlap only (not checked for meaning)', week: `${cw.overlapAnswers ?? 0}`, total: `${ct.overlapAnswers ?? 0}` }]
                : []),
              { metric: 'notes cited / retrieved', week: `${cw.citedNotes ?? 0}/${cw.retrievedNotes ?? 0}`, total: `${ct.citedNotes ?? 0}/${ct.retrievedNotes ?? 0}` },
            ],
          }, { format });
        }
      }

      formatDetail({
        last_agent_query: data.lastAgentQueryAt || 'never',
        last_search: data.lastSearchAt || 'never',
        last_grounded: cites?.lastGroundedAt || 'never',
      }, { format, title: 'Recency' });
    });

  brain
    .command('vaults')
    .description('List brain vaults')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('brain.vaults.list').path, { service: resolveEndpoint('brain.vaults.list').service });
      formatOutput({
        columns: ['id', 'name', 'source_type', 'status', 'note_count'],
        headers: ['ID', 'Name', 'Source', 'Status', 'Notes'],
        rows: (data.vaults || data),
      }, { format: program.opts().output });
    });

  brain
    .command('note')
    .description('Get note details')
    .argument('<id>', 'note ID')
    .action(async (id) => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('brain.note.get', { id }).path, { service: resolveEndpoint('brain.note.get', { id }).service });
      formatDetail(data.note || data, { format: program.opts().output });
    });

  // BRAIN2-W8: external-agent / portability contract, same routes the Cortex
  // brain_read / brain_update / brain_delete tools use (collector /api/v1/notesq
  // -> quoxbrain /notesq/notes/:id). Edits honour base_hash: a stale hash is a
  // 409 and nothing is written.
  brain
    .command('read')
    .description('Read one note in full (markdown + content hash for a later update)')
    .argument('<noteId>', 'note id (full id)')
    .option('--raw', 'print only the markdown body')
    .action(async (noteId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.get', { id: noteId });
      let data;
      try {
        data = await client.get(ep.path, { service: ep.service });
      } catch (e) {
        const bn = await brainNoteOn404(noteId, e);
        data = { note: bn, source: 'brain', editable: false };
      }
      const n = data.note || data;
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      if (options.raw) { console.log(n.body ?? n.markdown ?? ''); return; }
      formatDetail({ id: n.id, title: n.title, scope: n.scope, content_hash: n.content_hash, updated_at: n.updated_at }, { format: program.opts().output });
      console.log('');
      console.log(n.markdown ?? n.body ?? '');
    });

  brain
    .command('update')
    .description('Replace a note\'s markdown from a file. A stale --base-hash is a conflict (409), nothing is written.')
    .argument('<noteId>', 'note id')
    .requiredOption('--file <path>', 'file holding the full new markdown')
    .option('--base-hash <hash>', 'content_hash you read (see `quox brain read`); omit to use the current one')
    .action(async (noteId, options) => {
      auth.requireAuth();
      const markdown = readFileSync(options.file, 'utf8');
      let baseHash = options.baseHash;
      if (!baseHash) {
        const gep = resolveEndpoint('notesq.notes.get', { id: noteId });
        baseHash = ((await client.get(gep.path, { service: gep.service })).note || {}).content_hash;
      }
      const ep = resolveEndpoint('notesq.notes.update', { id: noteId });
      let data;
      try {
        data = await client.put(ep.path, { service: ep.service, body: { markdown, base_hash: baseHash } });
      } catch (e) {
        if (e instanceof QuoxApiError && e.status === 409) {
          const h = e.body && e.body.current_hash;
          throw new QuoxError(`Conflict (409): note ${noteId} changed since hash ${baseHash} (current_hash ${h || 'unknown'}). Nothing was written. Re-run \`quox brain read ${noteId}\`, merge, and update again.`, 1);
        }
        throw e;
      }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(data.unchanged ? `Note ${noteId} unchanged.` : `Updated note ${noteId} (rev ${data.revision?.rev ?? '?'}).`);
    });

  brain
    .command('delete')
    .description('Delete a note (recorded as a revision, restorable in NotesQ). Requires --yes.')
    .argument('<noteId>', 'note id')
    .option('--yes', 'confirm deletion')
    .option('--expected-hash <hash>', "the note's content_hash you read (see `quox brain read`); a stale value is a conflict (409) and nothing is deleted")
    .action(async (noteId, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError(`Refusing to delete ${noteId} without --yes.`, 2);
      if (!options.expectedHash) throw new QuoxError(`Refusing to delete ${noteId} without --expected-hash (the content_hash from \`quox brain read ${noteId}\`), so a concurrent edit is never deleted.`, 2);
      const ep = resolveEndpoint('notesq.notes.delete', { id: noteId });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service, query: { expected_hash: options.expectedHash } });
      } catch (e) {
        if (e instanceof QuoxApiError && e.status === 409) {
          const h = e.body && (e.body.currentHash || e.body.current_hash);
          throw new QuoxError(`Conflict (409): note ${noteId} changed since hash ${options.expectedHash} (current_hash ${h || 'unknown'}). Nothing was deleted. Re-run \`quox brain read ${noteId}\` and retry.`, 1);
        }
        throw e;
      }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Deleted note ${noteId}.`);
    });

  // ONE-BRAIN CX2: same routes the Cortex brain_related / brain_history /
  // brain_restore tools use.
  brain
    .command('related')
    .description('Notes related to one note (by similarity)')
    .argument('<noteId>', 'note id (full id)')
    .option('--limit <n>', 'how many (default 8, max 20)', '8')
    .action(async (noteId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('notesq.notes.related', { id: noteId });
      let data;
      try {
        data = await client.get(ep.path, { service: ep.service, query: { limit: Math.min(Math.max(parseInt(options.limit, 10) || 8, 1), 20) } });
      } catch (e) {
        const bn = await brainNoteOn404(noteId, e);
        data = { related: [], editable: false, reason: `${feedReason(bn, 'similarity links')} Use \`quox brain neighbours ${noteId}\` for its graph links.` };
        if (program.opts().output !== 'json') console.log(data.reason);
      }
      const related = data.related || [];
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(glyphLine('brain2', `related ${noteId.slice(0, 8)}`, { result: `${related.length} notes` }));
      formatOutput({ columns: ['id', 'title', 'scope', 'score'], headers: ['ID', 'Title', 'Scope', 'Score'], rows: related }, { format: program.opts().output });
    });

  // ONE-BRAIN CX2: same data the Cortex brain_neighbours tool returns
  // (quoxbrain GET /notes/:id outlinks + backlinks, scope-checked server-side).
  brain
    .command('neighbours')
    .alias('neighbors')
    .description('Notes this note links to and notes that link to it (graph neighbours)')
    .argument('<noteId>', 'note id (full id)')
    .action(async (noteId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.note.get', { id: noteId });
      const data = await client.get(ep.path, { service: ep.service });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const outlinks = Array.isArray(data.outlinks) ? data.outlinks : [];
      const backlinks = Array.isArray(data.backlinks) ? data.backlinks : [];
      const rows = [
        ...outlinks.map((l) => (l.resolved && l.id
          ? { direction: 'out', id: l.id, title: l.title || '' }
          : { direction: 'out (dangling)', id: '', title: l.targetRaw || '' })),
        ...backlinks.map((l) => ({ direction: 'in', id: l.id, title: l.title || '' })),
      ];
      console.log(glyphLine('brain2', `neighbours ${noteId.slice(0, 8)}`, { result: `${outlinks.length} out, ${backlinks.length} in` }));
      formatOutput({ columns: ['direction', 'id', 'title'], headers: ['Direction', 'ID', 'Title'], rows }, { format: program.opts().output });
    });

  brain
    .command('context')
    .description('Token-budgeted pack of the most relevant cited passages on a topic (what the Cortex brain_context tool returns)')
    .argument('<query>', 'topic or task')
    .option('--budget <n>', 'approximate token budget (200-4000)', '1200')
    .option('--since <date>', 'only notes dated on or after this ISO date/datetime (e.g. 2026-10-05)')
    .option('--until <date>', 'only notes dated on or before this ISO date/datetime (a date alone means the whole day)')
    .action(async (query, options) => {
      auth.requireAuth();
      const tokenBudget = Math.min(Math.max(parseInt(options.budget, 10) || 1200, 200), 4000);
      const ep = resolveEndpoint('brain.context.pack');
      const data = await client.post(ep.path, { service: ep.service, body: { query, tokenBudget, ...(options.since ? { since: options.since } : {}), ...(options.until ? { until: options.until } : {}) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const passages = data.passages || [];
      const insufficient = data.insufficient === true || data.relevance?.insufficient === true || passages.length === 0;
      if (insufficient) {
        console.log(glyphLine('brain2', `context "${query.slice(0, 40)}"`, { result: '0 relevant passages' }));
        console.log('Nothing relevant was found in the brain for this topic.');
        return;
      }
      console.log(glyphLine('brain2', `context "${query.slice(0, 40)}"`, { result: `${passages.length} passages · ${data.tokensUsed ?? '?'} tokens` }));
      passages.forEach((p, i) => {
        const c = p.citation || {};
        console.log(`${i + 1}. ${c.title || 'Untitled'}  (${p.noteId || c.noteId}${Number.isFinite(c.charStart) ? `, chars ${c.charStart}-${c.charEnd}` : ''})`);
        console.log(`   ${String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`);
      });
    });

  // ONE-BRAIN CX4: the Cortex brain_check tool, via the governed tool endpoint
  // (same path as `quox linkedin`): verdict + evidence for a claim.
  brain
    .command('check')
    .description('Check whether the knowledge brain supports, contradicts or says nothing about a claim (what the Cortex brain_check tool returns)')
    .argument('<claim>', 'the statement to check (max 500 characters)')
    .action(async (claim) => {
      auth.requireAuth();
      if (claim.length > 500) throw new QuoxError(`The claim is ${claim.length} characters; the limit is 500.`, 2);
      const ep = resolveEndpoint('v1.tools.execute');
      const data = await client.post(ep.path, { service: ep.service, body: { tool_name: 'brain_check', input: { claim }, org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data || data.success === false) {
        throw new QuoxError(`brain_check failed: ${(data && (data.error || data.output)) || 'unknown error'}`, 1);
      }
      const mark = { supported: '✔', contradicted: '✖', overlap: '◐', unknown: '◐' }[data.verdict] || '';
      console.log(glyphLine('brain2', `check "${claim.slice(0, 40)}"`, { result: `${data.verdict} ${mark}`.trim() }));
      const ev = data.evidence || [];
      for (const e of ev) {
        console.log(`  ${e.verdict.padEnd(12)} ${e.title || 'Untitled'}  (${e.noteId || ''}${e.relPath ? `, ${e.relPath}` : ''})${e.conditionDropped ? '  [condition dropped]' : ''}`);
      }
      if (data.output) console.log(data.output);
    });

  // ONE-BRAIN CX6: the Cortex brain_why tool, via the governed tool endpoint:
  // why a note ranked where it did for a query, or why it is missing.
  brain
    .command('why')
    .description('Two modes. `why <target>`: the commits, dev sessions and decisions behind a commit sha or file path. `why "<query>" <noteId>`: why a note ranked where it did, or why it is missing (Cortex brain_why tool)')
    .argument('<queryOrTarget>', 'a commit sha / file path (one argument), or the search query (with <noteId>)')
    .argument('[noteId]', 'the full note id to explain (ranking mode)')
    .action(async (first, noteId) => {
      auth.requireAuth();
      const provenance = noteId === undefined;
      const input = provenance ? { target: first } : { query: first, noteId };
      const ep = resolveEndpoint('v1.tools.execute');
      const data = await client.post(ep.path, { service: ep.service, body: { tool_name: 'brain_why', input, org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      if (!data || data.success === false) {
        throw new QuoxError(`brain_why failed: ${(data && (data.error || data.output)) || 'unknown error'}`, 1);
      }
      if (provenance) {
        const n = (data.commits || []).length + (data.sessions || []).length + (data.decisions || []).length;
        console.log(glyphLine('brain2', `why ${first.slice(0, 40)}`, { result: `${n} sources` }));
        if (data.output) console.log(data.output);
        return;
      }
      const inResults = data.target?.status === 'in_results';
      console.log(glyphLine('brain2', `why ${noteId.slice(0, 8)} for "${first.slice(0, 40)}"`, { result: inResults ? `rank ${data.target.rank} ✔` : 'not returned ⚠' }));
      if (data.output) console.log(data.output);
    });

  brain
    .command('history')
    .description("A note's revision history, or with --rev the text of that revision")
    .argument('<noteId>', 'note id (full id)')
    .option('--rev <n>', "show this revision's markdown")
    .action(async (noteId, options) => {
      auth.requireAuth();
      if (options.rev !== undefined) {
        const rev = Number(options.rev);
        if (!Number.isInteger(rev) || rev < 1) throw new QuoxError('--rev must be a positive whole number.', 2);
        const ep = resolveEndpoint('notesq.notes.revision', { id: noteId, rev });
        const data = await client.get(ep.path, { service: ep.service });
        if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
        formatDetail({ rev: data.rev, action: data.action, author_kind: data.author_kind, created_at: data.created_at }, { format: program.opts().output });
        console.log('');
        console.log(data.markdown ?? '');
        return;
      }
      const ep = resolveEndpoint('notesq.notes.revisions', { id: noteId });
      let data;
      try {
        data = await client.get(ep.path, { service: ep.service });
      } catch (e) {
        const bn = await brainNoteOn404(noteId, e);
        data = { revisions: [], editable: false, reason: feedReason(bn, 'revision history') };
        if (program.opts().output !== 'json') { console.log(data.reason); return; }
      }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      formatOutput({ columns: ['rev', 'action', 'author_kind', 'created_at', 'content_hash'], headers: ['Rev', 'Action', 'Author', 'When', 'Hash'], rows: data.revisions || [] }, { format: program.opts().output });
    });

  brain
    .command('restore')
    .description("Restore a note to an earlier revision (recorded as a new revision). --expected-hash must be the note's current content_hash (see `quox brain read`).")
    .argument('<noteId>', 'note id')
    .argument('<rev>', 'revision number to restore (see `quox brain history`)')
    .requiredOption('--expected-hash <hash>', 'content_hash you read; a stale value is a conflict and nothing is restored')
    .action(async (noteId, revArg, options) => {
      auth.requireAuth();
      const rev = Number(revArg);
      if (!Number.isInteger(rev) || rev < 1) throw new QuoxError('<rev> must be a positive whole number.', 2);
      const gep = resolveEndpoint('notesq.notes.get', { id: noteId });
      const current = ((await client.get(gep.path, { service: gep.service })).note || {}).content_hash;
      if (current !== options.expectedHash) {
        throw new QuoxError(`Conflict: note ${noteId} changed since hash ${options.expectedHash} (current_hash ${current || 'unknown'}). Nothing was restored. Re-run \`quox brain read ${noteId}\` and try again.`, 1);
      }
      const ep = resolveEndpoint('notesq.notes.restore', { id: noteId });
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: { rev, expected_hash: options.expectedHash } });
      } catch (e) {
        if (e instanceof QuoxApiError && e.status === 409) {
          const h = e.body && (e.body.currentHash || e.body.current_hash);
          throw new QuoxError(`Conflict (409): note ${noteId} changed since hash ${options.expectedHash} (current_hash ${h || 'unknown'}). Nothing was restored. Re-run \`quox brain read ${noteId}\` and try again.`, 1);
        }
        throw e;
      }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(data.unchanged ? `Note ${noteId} already matches revision ${rev}.` : `Restored note ${noteId} to revision ${rev} (new rev ${data.revision?.rev ?? '?'}).`);
    });

  // ONE-BRAIN CX5: turn real usage into a labelled retrieval eval set.
  brain
    .command('judge')
    .description('Label a query: a note is relevant/irrelevant for it, or the query should abstain')
    .argument('<query>', 'the search query being judged')
    .argument('[noteId]', 'the note being judged (not needed with --should-abstain)')
    .option('--relevant', 'this note is a correct answer for the query')
    .option('--irrelevant', 'this note should not surface for the query')
    .option('--should-abstain', 'nothing in the brain should answer this query')
    .action(async (query, noteId, options) => {
      auth.requireAuth();
      const picked = ['relevant', 'irrelevant', 'shouldAbstain'].filter((k) => options[k]);
      if (picked.length !== 1) throw new QuoxError('Pick exactly one of --relevant, --irrelevant, --should-abstain.', 2);
      const verdict = options.shouldAbstain ? 'should_abstain' : options.relevant ? 'relevant' : 'irrelevant';
      if (verdict === 'should_abstain' && noteId) throw new QuoxError('--should-abstain judges the query, drop the note id.', 2);
      if (verdict !== 'should_abstain' && !noteId) throw new QuoxError(`--${verdict} needs a <noteId>.`, 2);
      const ep = resolveEndpoint('brain.judgements.create');
      const body = { query, verdict, source: 'cli' };
      if (noteId) body.noteId = noteId;
      const data = await client.post(ep.path, { service: ep.service, body });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(glyphLine('brain2', `judge "${query.slice(0, 40)}"`, { result: `${verdict}${noteId ? ` · note ${noteId}` : ''}${data.created === false ? ' · already recorded' : ''}` }));
    });

  brain
    .command('judgements')
    .description('List your relevance judgements (the eval set)')
    .option('--limit <n>', 'max rows (default 200, cap 1000)', '200')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.judgements.list');
      const data = await client.get(ep.path, { service: ep.service, query: { limit: Number(options.limit) } });
      const format = program.opts().output;
      if (format === 'json') { formatDetail(data, { format }); return; }
      formatOutput({
        columns: ['verdict', 'query', 'note', 'at'],
        headers: ['Verdict', 'Query', 'Note', 'At'],
        rows: (data.judgements || []).map((j) => ({ verdict: j.verdict, query: j.query, note: j.note_id || '-', at: j.created_at })),
      }, { format, emptyMessage: 'No judgements yet. Label some with `quox brain judge`.' });
    });

  // ONE-BRAIN CX6: topic subscriptions. A scheduler on the collector searches
  // each topic as you and posts new notes to your slot.
  brain
    .command('subscribe')
    .description('Tell a slot when new notes about a topic land in your brain')
    .argument('<topic>', 'the topic (a search query)')
    .requiredOption('--slot <name>', 'slot to notify')
    .action(async (topic, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.subscriptions.create');
      const data = await client.post(ep.path, { service: ep.service, body: { query: topic, slot: options.slot } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const sub = data.subscription || {};
      console.log(glyphLine('brain2', `subscribe "${topic.slice(0, 40)}"`, { result: `slot ${options.slot} · ${data.created === false ? (data.revived ? 'revived' : 'already subscribed') : 'subscribed'} · id ${sub.id || '?'}` }));
    });

  brain
    .command('subscriptions')
    .description('List your topic subscriptions')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.subscriptions.list');
      const data = await client.get(ep.path, { service: ep.service });
      const format = program.opts().output;
      if (format === 'json') { formatDetail(data, { format }); return; }
      formatOutput({
        columns: ['id', 'topic', 'slot', 'state', 'checked'],
        headers: ['ID', 'Topic', 'Slot', 'State', 'Last checked'],
        rows: (data.subscriptions || []).map((s) => ({
          id: s.id, topic: s.query, slot: s.slot,
          state: s.disabledAt ? `disabled: ${s.disabledReason || 'unknown'}` : (s.consecutiveFailures ? `failing (${s.consecutiveFailures})` : 'active'),
          checked: s.lastCheckedAt || 'not yet',
        })),
      }, { format, emptyMessage: 'No subscriptions. Add one with `quox brain subscribe "<topic>" --slot <name>`.' });
    });

  brain
    .command('unsubscribe')
    .description('Remove a topic subscription')
    .argument('<id>', 'subscription id from `quox brain subscriptions`')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.subscriptions.delete', { id });
      const data = await client.delete(ep.path, { service: ep.service });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      console.log(glyphLine('brain2', 'unsubscribe', { result: `removed ${id}` }));
    });

  brain
    .command('sources')
    .description('List the Feed sources that fill your brain (state and last sync)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('brain.sources.list');
      const data = await client.get(ep.path, { service: ep.service });
      const format = program.opts().output;
      if (format === 'json') { formatDetail(data, { format }); return; }
      formatOutput({
        columns: ['type', 'state', 'scope', 'last'],
        headers: ['Type', 'State', 'Scope', 'Last sync'],
        rows: (data.sources || []).map((s) => ({
          type: s.sourceType,
          state: !s.connected ? s.status : (s.enabled ? 'on' : 'off'),
          scope: s.scope || '',
          last: s.last_status ? `${s.last_status}${s.last_count ? ` (${s.last_count})` : ''}` : 'never',
        })),
      }, { format, emptyMessage: 'No sources.' });
    });

  brain
    .command('source')
    .description('Turn a Feed source on or off and set its config (host paths need an org admin and the instance allow-list)')
    .argument('<type>', 'source type from `quox brain sources`, e.g. git, folder, transcript')
    .option('--enable', 'turn the source on')
    .option('--disable', 'turn the source off')
    .option('--scope <scope>', 'org or user')
    .option('--path <path>', 'set config.path')
    .option('--roots <paths>', 'set config.roots (comma-separated absolute paths)')
    .option('--config <json>', 'merge a JSON object into the config')
    .action(async (type, options) => {
      auth.requireAuth();
      if (options.enable && options.disable) throw new Error('Pass --enable or --disable, not both');
      let config;
      if (options.config !== undefined) {
        let parsed;
        try { parsed = JSON.parse(options.config); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--config must be a JSON object');
        config = { ...parsed };
      }
      if (options.path) config = { ...(config || {}), path: options.path };
      if (options.roots) config = { ...(config || {}), roots: options.roots.split(',').map((r) => r.trim()).filter(Boolean) };
      const body = {};
      if (options.enable) body.enabled = true;
      if (options.disable) body.enabled = false;
      if (options.scope) body.scope = options.scope;
      if (config) body.config = config;
      if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --enable, --disable, --scope, --path, --roots or --config');
      const ep = resolveEndpoint('brain.sources.update', { type });
      const data = await client.put(ep.path, { service: ep.service, body });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const src = data.source || {};
      console.log(glyphLine('brain2', `source ${type}`, { result: `${src.enabled ? 'on' : 'off'}${src.config ? ` · config ${JSON.stringify(src.config).slice(0, 80)}` : ''}` }));
    });

  brain
    .command('eval')
    .description('Replay your judged queries against live search and score retrieval (hit@1/3/k, MRR, abstention)')
    .option('--limit <n>', 'max judgements to load', '1000')
    .option('--k <n>', 'results fetched per query', '8')
    .action(async (options) => {
      auth.requireAuth();
      const k = Math.min(Math.max(parseInt(options.k, 10) || 8, 1), 50);
      const jep = resolveEndpoint('brain.judgements.list');
      const jdata = await client.get(jep.path, { service: jep.service, query: { limit: Number(options.limit) } });
      const judgements = jdata.judgements || [];
      const sep = resolveEndpoint('brain.search.list');
      const searches = {};
      for (const q of [...new Set(judgements.map((j) => j.query))]) {
        searches[q] = await client.post(sep.path, { service: sep.service, body: { query: q, limit: k } });
      }
      const report = scoreRetrievalEval(judgements, searches, k);
      if (program.opts().output === 'json') { console.log(JSON.stringify(report, null, 2)); return; }
      console.log(glyphLine('brain2', 'eval', { result: `${report.queries} queries · ${report.judgements} judgements` }));
      const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
      formatOutput({
        columns: ['metric', 'value'],
        headers: ['Metric', 'Value'],
        rows: [
          { metric: `relevant-judged queries`, value: String(report.relevant.queries) },
          { metric: 'hit@1', value: pct(report.relevant.hitAt1) },
          { metric: 'hit@3', value: pct(report.relevant.hitAt3) },
          { metric: `hit@${k}`, value: pct(report.relevant.hitAtK) },
          { metric: 'MRR', value: report.relevant.mrr == null ? 'n/a' : report.relevant.mrr.toFixed(3) },
          { metric: 'irrelevant notes in top 3 (precision problems)', value: String(report.irrelevantInTop3) },
          { metric: 'should-abstain queries', value: String(report.abstain.queries) },
          { metric: 'abstained correctly', value: pct(report.abstain.rate) },
        ],
      }, { format: 'table' });
    });

  // BRAIN2-W8: portable export. Server streams every note visible to you (same
  // scope rule as search, vault exclusions respected). jsonl: one note per line
  // to stdout or --out <file> (-o is the global --output flag). markdown:
  // one .md file with YAML front matter per note, written under --out <dir>.
  brain
    .command('export')
    .description('Export your visible notes (jsonl to stdout/--out file, or markdown files into --out dir)')
    .option('--out <path>', 'file (jsonl) or directory (markdown); default stdout for jsonl')
    .option('--format <fmt>', 'jsonl or markdown', 'jsonl')
    .option('--scope <scope>', 'org | user | shared (default: all visible)')
    .action(async (options) => {
      auth.requireAuth();
      if (!['jsonl', 'markdown'].includes(options.format)) throw new QuoxError('--format must be jsonl or markdown.', 2);
      if (options.format === 'markdown' && !options.out) throw new QuoxError('--format markdown needs --out <directory>.', 2);
      const ep = resolveEndpoint('brain.export.get');
      const query = { format: 'jsonl' };
      if (options.scope) query.scope = options.scope;
      const data = await client.get(ep.path, { service: ep.service, query });
      const text = typeof data.text === 'string' ? data.text : '';
      const recs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (options.format === 'jsonl') {
        if (options.out) writeFileSync(options.out, text);
        else process.stdout.write(text);
      } else {
        for (const r of recs) {
          const fm = { id: r.id, title: r.title, scope: r.scope, source: r.source, created_at: r.created_at, updated_at: r.updated_at, tags: r.tags, links: r.links, revision_count: r.revision_count };
          const file = join(options.out, r.scope || 'note', `${slug(r.title)}-${String(r.id).slice(0, 8)}.md`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n${r.body || ''}\n`);
        }
      }
      if (options.out || program.opts().output !== 'json') {
        console.error(glyphLine('brain2', 'export', { result: `${recs.length} notes${options.out ? ` -> ${options.out}` : ''}` }));
      }
    });
}
