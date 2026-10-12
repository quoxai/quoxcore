#!/usr/bin/env node
/**
 * sync-quoxchat-corpus.js — QCFT #213 retrain ritual
 *
 * Syncs the QuoxChat support corpus into a widget's knowledge base via the
 * collector's service-key surface. Idempotent: a second run against an
 * unchanged corpus plans and performs zero changes.
 *
 * Usage:
 *   node scripts/sync-quoxchat-corpus.js \
 *     --widget <public_key_or_widget_id> \
 *     --collector http://localhost:9848 \
 *     [--corpus /path/to/corpus/quox-support] \
 *     --dry-run | --apply
 *
 * Auth: INTERNAL_SERVICE_KEY env var (same key the collector expects on
 * x-service-key). Never passed as a CLI arg so it cannot leak into ps/history.
 *
 * Corpus contract (written by the corpus agent in parallel):
 *   corpus/quox-support/faq.yaml     — list of {id, section, question, answer}
 *   corpus/quox-support/docs/*.md    — frontmatter {source, section} + body
 *
 * MARKER SCHEME (how corpus-managed sources are recognised forever after):
 *   QA entries   — ingested via POST /quoxchat/knowledge/qa with
 *                  category = "corpus:<corpus_id>". The QA route stores that
 *                  category in the widget_knowledge_sources config_json AND
 *                  in the Qdrant point payload (as `section`), so the corpus
 *                  id survives round-trips and the point set is exactly
 *                  removable on supersede. Note: the corpus `section` field
 *                  is NOT carried into the KB — category is repurposed as
 *                  the sync marker (small, additive; no route change).
 *   Doc files    — uploaded via POST /quoxchat/knowledge/upload under the
 *                  filename "corpus__<slug>__<hash8><ext>", where slug is
 *                  the sanitised corpus file basename and hash8 the first 8
 *                  hex chars of the sha256 of the file content. The name is
 *                  stored as the source row name AND as the Qdrant chunk
 *                  payload `source`, so changed docs are detected by hash
 *                  and superseded by exact filter.
 *   Anything NOT matching either marker (manual FAQ entries, teach-mode
 *   corrections — category "correction", hand-uploaded files, crawled URLs,
 *   connectors) is NEVER touched by this script.
 *
 * Plan semantics:
 *   create    — corpus entry with no managed counterpart
 *   update    — managed counterpart exists but content differs
 *               (executed as delete-old-source + re-add; the collector's
 *               DELETE /quoxchat/knowledge/sources/:id removes the Qdrant
 *               points too, which is the supersede QA ingestion never had)
 *   delete    — managed source whose corpus entry no longer exists, plus
 *               duplicate managed rows from historical double-ingestion
 *               (newest row wins)
 *
 * Rate limits: POST /knowledge/qa sits behind the collector's 10/min/IP
 * limiter, so applies pace QA creates at ~9/min and back off 61s on a 429.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sourceRoutes = require('../lib/quoxchatSourceRoutes');

// ── Marker helpers ──────────────────────────────────────────────────────────

const QA_MARKER_PREFIX = 'corpus:';
const DOC_MARKER_RE = /^corpus__(.+)__([0-9a-f]{8})(\.[A-Za-z0-9]+)?$/;

function qaCategoryForId(corpusId) {
  return `${QA_MARKER_PREFIX}${corpusId}`;
}

// Returns the corpus id when the category carries the marker, else null.
function corpusIdFromCategory(category) {
  if (typeof category !== 'string') return null;
  if (!category.startsWith(QA_MARKER_PREFIX)) return null;
  const id = category.slice(QA_MARKER_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

function corpusDocName(slug, hash8, ext) {
  return `corpus__${slug}__${hash8}${ext || ''}`;
}

// Returns {slug, hash, ext} when the name carries the doc marker, else null.
function parseCorpusDocName(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(DOC_MARKER_RE);
  if (!m) return null;
  return { slug: m[1], hash: m[2], ext: m[3] || '' };
}

function slugify(basename) {
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'doc';
}

function contentHash8(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

// ── Corpus loaders ──────────────────────────────────────────────────────────

function loadYamlModule() {
  try {
    // Resolves from repo-root node_modules (Node walks up from scripts/).
    // Not needed inside the collector container — this script runs on a
    // host/workstation against a collector URL.
    return require('js-yaml');
  } catch {
    throw new Error('js-yaml not found. Run this script from a checkout with root node_modules installed (npm install at repo root)');
  }
}

// opts.routeIndex (from sourceRoutes.loadRouteIndex): when given, each entry
// gets source_url ('' when its first "# source:" file maps to no public
// route). When absent, source_url stays undefined and is NOT compared by the
// differ, so a run without a website checkout never strips existing URLs.
function loadFaqYaml(faqPath, opts = {}) {
  if (!fs.existsSync(faqPath)) return [];
  const yaml = loadYamlModule();
  const faqText = fs.readFileSync(faqPath, 'utf8');
  const sourceHints = sourceRoutes.extractFaqSources(faqText);
  const parsed = yaml.load(faqText);
  if (!Array.isArray(parsed)) throw new Error(`${faqPath}: expected a top-level YAML list`);
  const seen = new Set();
  return parsed.map((raw, i) => {
    const entry = raw || {};
    for (const field of ['id', 'question', 'answer']) {
      if (!entry[field] || typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`${faqPath}: entry ${i} missing required field "${field}"`);
      }
    }
    const id = entry.id.trim();
    if (seen.has(id)) throw new Error(`${faqPath}: duplicate corpus id "${id}"`);
    seen.add(id);
    return {
      id,
      section: typeof entry.section === 'string' ? entry.section.trim() : '',
      question: entry.question.trim(),
      answer: entry.answer.trim(),
      source_url: opts.routeIndex ? (sourceRoutes.resolveSourceUrl(sourceHints.get(id), opts.routeIndex) || '') : undefined,
    };
  });
}

// Minimal frontmatter reader: leading "---\n...\n---" block parsed as YAML.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { attrs: {}, body: content };
  let attrs = {};
  try {
    const yaml = loadYamlModule();
    attrs = yaml.load(m[1]) || {};
  } catch { /* tolerate malformed frontmatter — treated as plain doc */ }
  return { attrs: typeof attrs === 'object' && attrs !== null ? attrs : {}, body: content.slice(m[0].length) };
}

function loadDocs(docsDir) {
  if (!fs.existsSync(docsDir)) return [];
  const docs = [];
  const seenSlugs = new Set();
  for (const file of fs.readdirSync(docsDir).sort()) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(docsDir, file);
    const content = fs.readFileSync(full, 'utf8');
    const { attrs } = parseFrontmatter(content);
    const ext = path.extname(file);
    const slug = slugify(path.basename(file, ext));
    if (seenSlugs.has(slug)) throw new Error(`${docsDir}: duplicate doc slug "${slug}" (from ${file})`);
    seenSlugs.add(slug);
    docs.push({
      slug,
      ext,
      file: full,
      content,
      hash: contentHash8(content),
      source: typeof attrs.source === 'string' ? attrs.source : '',
      section: typeof attrs.section === 'string' ? attrs.section : '',
    });
  }
  return docs;
}

// ── Differ (pure) ───────────────────────────────────────────────────────────
//
// Input:
//   corpusQa   — [{id, section, question, answer}]
//   corpusDocs — [{slug, ext, hash, content?, ...}]
//   existingSources — rows from GET /quoxchat/knowledge/sources:
//                     [{id, type, name, config, createdAt, ...}]
// Output buckets (each element carries enough to execute the action):
//   qaCreates  [{entry}]            qaUpdates  [{entry, existing}]
//   qaDeletes  [{existing, reason}] docCreates [{doc}]
//   docUpdates [{doc, existing}]    docDeletes [{existing, reason}]
//   unchanged  — count of managed sources already in sync
//   untouched  — count of non-corpus sources (never acted on)

function diffCorpus({ corpusQa = [], corpusDocs = [], existingSources = [] }) {
  const managedQa = [];
  const managedDocs = [];
  let untouched = 0;

  for (const src of existingSources) {
    if (src.type === 'qa') {
      const corpusId = corpusIdFromCategory(src.config?.category);
      if (corpusId) { managedQa.push({ src, corpusId }); continue; }
    } else if (src.type === 'file') {
      const marker = parseCorpusDocName(src.name);
      if (marker) { managedDocs.push({ src, marker }); continue; }
    }
    untouched++;
  }

  const byCreatedDesc = (a, b) => String(b.src.createdAt || '').localeCompare(String(a.src.createdAt || ''));

  const qaCreates = [];
  const qaUpdates = [];
  const qaDeletes = [];
  let unchanged = 0;

  const qaById = new Map();
  for (const m of managedQa) {
    if (!qaById.has(m.corpusId)) qaById.set(m.corpusId, []);
    qaById.get(m.corpusId).push(m);
  }

  for (const entry of corpusQa) {
    const matches = (qaById.get(entry.id) || []).sort(byCreatedDesc);
    if (matches.length === 0) {
      qaCreates.push({ entry });
      continue;
    }
    const keep = matches[0];
    for (const extra of matches.slice(1)) {
      qaDeletes.push({ existing: extra.src, reason: 'duplicate' });
    }
    const urlInSync = entry.source_url === undefined || (keep.src.config?.source_url || '') === entry.source_url;
    if (keep.src.config?.question === entry.question && keep.src.config?.answer === entry.answer && urlInSync) {
      unchanged++;
    } else {
      qaUpdates.push({ entry, existing: keep.src });
    }
  }

  const corpusQaIds = new Set(corpusQa.map(e => e.id));
  for (const m of managedQa) {
    if (!corpusQaIds.has(m.corpusId)) qaDeletes.push({ existing: m.src, reason: 'removed_from_corpus' });
  }

  const docCreates = [];
  const docUpdates = [];
  const docDeletes = [];

  const docsBySlug = new Map();
  for (const m of managedDocs) {
    if (!docsBySlug.has(m.marker.slug)) docsBySlug.set(m.marker.slug, []);
    docsBySlug.get(m.marker.slug).push(m);
  }

  for (const doc of corpusDocs) {
    const matches = (docsBySlug.get(doc.slug) || []).sort(byCreatedDesc);
    if (matches.length === 0) {
      docCreates.push({ doc });
      continue;
    }
    const keep = matches[0];
    for (const extra of matches.slice(1)) {
      docDeletes.push({ existing: extra.src, reason: 'duplicate' });
    }
    if (keep.marker.hash === doc.hash) {
      unchanged++;
    } else {
      docUpdates.push({ doc, existing: keep.src });
    }
  }

  const corpusDocSlugs = new Set(corpusDocs.map(d => d.slug));
  for (const m of managedDocs) {
    if (!corpusDocSlugs.has(m.marker.slug)) docDeletes.push({ existing: m.src, reason: 'removed_from_corpus' });
  }

  return { qaCreates, qaUpdates, qaDeletes, docCreates, docUpdates, docDeletes, unchanged, untouched };
}

function planTotals(plan) {
  return {
    creates: plan.qaCreates.length + plan.docCreates.length,
    updates: plan.qaUpdates.length + plan.docUpdates.length,
    deletes: plan.qaDeletes.length + plan.docDeletes.length,
    unchanged: plan.unchanged,
    untouched: plan.untouched,
  };
}

// ── Collector client ────────────────────────────────────────────────────────

const QA_CREATE_DELAY_MS = 6500;   // ~9/min against the 10/min/IP limiter
const UPLOAD_DELAY_MS = 1500;
const DELETE_DELAY_MS = 300;
const RATE_LIMIT_BACKOFF_MS = 61_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient({ collectorUrl, serviceKey, widget }) {
  const base = collectorUrl.replace(/\/+$/, '');
  const headers = { 'x-service-key': serviceKey };

  async function request(url, opts, { retryOn429 = true, transientLeft = 3 } = {}) {
    let resp;
    try {
      resp = await fetch(url, opts);
    } catch (netErr) {
      // A dropped connection (edge throttling, collector restart) never
      // produced a status: same transient rule as a 502 (prod sync 2026-10-09
      // died at 34/89 on 'fetch failed').
      if (transientLeft > 0) {
        process.stdout.write(`  network error (${netErr.message}), backing off 20s (${transientLeft} left)...\n`);
        await sleep(20000);
        return request(url, opts, { retryOn429, transientLeft: transientLeft - 1 });
      }
      throw netErr;
    }
    if (resp.status === 429 && retryOn429) {
      process.stdout.write(`  rate limited, backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s...\n`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      return request(url, opts, { retryOn429: false, transientLeft });
    }
    // QUOXCHAT-BRUTALOOP: a collector restart (502), an embedding timeout or a
    // licence check that could not run (503 LICENSE_CHECK_UNAVAILABLE) is
    // transient; three runs on 2026-10-09 died on exactly these. Back off and
    // retry instead of aborting. A possible duplicate from a retried create
    // is collapsed by the next run's dedupe and caught by verify.
    if ([502, 503, 504].includes(resp.status) && transientLeft > 0) {
      process.stdout.write(`  transient ${resp.status}, backing off 20s (${transientLeft} left)...\n`);
      await sleep(20000);
      return request(url, opts, { retryOn429, transientLeft: transientLeft - 1 });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`${opts?.method || 'GET'} ${url} -> ${resp.status} ${body.slice(0, 300)}`);
    }
    return resp.json().catch(() => ({}));
  }

  return {
    // QCX-SYNC-CAP: page through the listing — the server caps each page
    // (1000). Before pagination existed, a >1000-source widget silently
    // diffed against a truncated list and re-created the invisible tail
    // on every run (904 duplicate rows, 2026-09-04). Loop until a short
    // page OR total reached; a server without pagination support returns
    // no `total` and a single (possibly capped) page — detect that and
    // fail LOUDLY rather than diff against a maybe-truncated list.
    listSources: async () => {
      const pageSize = 1000;
      let offset = 0;
      let all = [];
      for (;;) {
        const page = await request(
          `${base}/quoxchat/knowledge/sources?widget_id=${encodeURIComponent(widget)}&limit=${pageSize}&offset=${offset}`,
          { headers }
        );
        const rows = Array.isArray(page.sources) ? page.sources : [];
        all = all.concat(rows);
        if (typeof page.total !== 'number') {
          if (rows.length >= pageSize) {
            throw new Error(
              `sources listing returned ${rows.length} rows with no total — server predates pagination and may be capped; refusing to diff against a possibly-truncated list`
            );
          }
          return { sources: all };
        }
        if (all.length >= page.total || rows.length === 0) return { sources: all };
        offset += rows.length;
      }
    },

    // QCX-SYNC-CAP: bulk dedupe runs fire hundreds of deletes; a transient
    // 429/5xx from the internal chain must back off and retry, not abort
    // the whole run (a 429-wrapped-502 killed a dedupe at 70/904).
    deleteSource: async (sourceId) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await request(`${base}/quoxchat/knowledge/sources/${encodeURIComponent(sourceId)}?widget_id=${encodeURIComponent(widget)}`, {
            method: 'DELETE',
            headers,
          });
        } catch (err) {
          // 402 joins the transient set: the licence lease re-verifies
          // shortly after a service restart and can fail CLOSED for a
          // window (observed 2026-09-05, killed a dedupe at 130/704). A
          // genuinely dead licence still aborts after the retries.
          const transient = /-> (429|402|5\d\d)/.test(String(err.message));
          if (!transient || attempt >= 4) throw err;
          process.stdout.write(`transient (${attempt}/3), backing off 60s... `);
          await sleep(60000);
        }
      }
    },

    // Index/corpus reconcile (dry-run unless apply). Never retried on 429:
    // a prune must be a deliberate single call.
    reconcile: ({ apply = false } = {}) =>
      request(`${base}/quoxchat/knowledge/reconcile`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ widget_id: widget, apply }),
      }),

    createQa: (entry) =>
      request(`${base}/quoxchat/knowledge/qa`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widget_id: widget,
          question: entry.question,
          answer: entry.answer,
          category: qaCategoryForId(entry.id),
          ...(entry.source_url ? { source_url: entry.source_url } : {}),
        }),
      }),

    uploadDoc: (doc) => {
      const form = new FormData();
      form.append('widget_id', widget);
      form.append('file', new Blob([doc.content], { type: 'text/markdown' }), corpusDocName(doc.slug, doc.hash, doc.ext));
      return request(`${base}/quoxchat/knowledge/upload`, { method: 'POST', headers, body: form });
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, reconcile: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--widget') args.widget = argv[++i];
    else if (a === '--collector') args.collector = argv[++i];
    else if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--website') args.website = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--reconcile') args.reconcile = true;
    else if (a === '--prune') args.prune = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printPlan(plan) {
  const totals = planTotals(plan);
  console.log('\nPlan:');
  console.log(`  creates:   ${totals.creates}  (qa ${plan.qaCreates.length}, docs ${plan.docCreates.length})`);
  console.log(`  updates:   ${totals.updates}  (qa ${plan.qaUpdates.length}, docs ${plan.docUpdates.length})`);
  console.log(`  deletes:   ${totals.deletes}  (qa ${plan.qaDeletes.length}, docs ${plan.docDeletes.length})`);
  console.log(`  unchanged: ${totals.unchanged}`);
  console.log(`  untouched (manual/teach/hand-added, never modified): ${totals.untouched}`);

  const sample = (label, items, fmt) => {
    if (items.length === 0) return;
    console.log(`  ${label}:`);
    for (const item of items.slice(0, 5)) console.log(`    - ${fmt(item)}`);
    if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
  };
  sample('qa creates', plan.qaCreates, i => `${i.entry.id}: "${i.entry.question.slice(0, 60)}"`);
  sample('qa updates', plan.qaUpdates, i => `${i.entry.id}: "${i.entry.question.slice(0, 60)}"`);
  sample('qa deletes', plan.qaDeletes, i => `${i.existing.id} (${i.reason}): "${String(i.existing.name).slice(0, 60)}"`);
  sample('doc creates', plan.docCreates, i => `${i.doc.slug} @ ${i.doc.hash}`);
  sample('doc updates', plan.docUpdates, i => `${i.doc.slug} -> ${i.doc.hash}`);
  sample('doc deletes', plan.docDeletes, i => `${i.existing.id} (${i.reason}): ${i.existing.name}`);
}

function printReconcile(report) {
  const c = report.counts || {};
  console.log(`\nIndex reconcile (${report.total} points in ${report.collection}):`);
  console.log(`  managed ${c.managed}, correction ${c.correction} (never deleted), orphan ${c.orphan}, unmanaged ${c.unmanaged}, duplicate ${c.duplicate}`);
  for (const g of (report.groups || []).filter(x => x.class !== 'managed').slice(0, 15)) {
    console.log(`  - ${g.class} x${g.count} source=${g.source || '-'} section=${g.section || '-'} type=${g.source_type || '-'}: "${g.sample_text.slice(0, 80)}"`);
  }
  if (report.apply_result) console.log(`  pruned: ${JSON.stringify(report.apply_result.deleted)}`);
}

async function applyPlan(client, plan) {
  // Deletes first (frees the way for re-adds), then updates (delete+create),
  // then creates. Everything sequential — the collector is single-instance
  // and the qa route is rate limited.
  for (const { existing, reason } of [...plan.qaDeletes, ...plan.docDeletes]) {
    process.stdout.write(`  delete ${existing.id} (${reason}) "${String(existing.name).slice(0, 50)}"... `);
    await client.deleteSource(existing.id);
    console.log('ok');
    await sleep(DELETE_DELAY_MS);
  }

  for (const { entry, existing } of plan.qaUpdates) {
    process.stdout.write(`  update qa ${entry.id} (supersede ${existing.id})... `);
    await client.deleteSource(existing.id);
    await sleep(DELETE_DELAY_MS);
    await client.createQa(entry);
    console.log('ok');
    await sleep(QA_CREATE_DELAY_MS);
  }

  for (const { doc, existing } of plan.docUpdates) {
    process.stdout.write(`  update doc ${doc.slug} (supersede ${existing.id})... `);
    await client.deleteSource(existing.id);
    await sleep(DELETE_DELAY_MS);
    const result = await client.uploadDoc(doc);
    console.log(`ok (${result.embedded ?? '?'} chunks)`);
    await sleep(UPLOAD_DELAY_MS);
  }

  for (const { entry } of plan.qaCreates) {
    process.stdout.write(`  create qa ${entry.id} "${entry.question.slice(0, 50)}"... `);
    await client.createQa(entry);
    console.log('ok');
    await sleep(QA_CREATE_DELAY_MS);
  }

  for (const { doc } of plan.docCreates) {
    process.stdout.write(`  create doc ${doc.slug} @ ${doc.hash}... `);
    const result = await client.uploadDoc(doc);
    console.log(`ok (${result.embedded ?? '?'} chunks)`);
    await sleep(UPLOAD_DELAY_MS);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.widget) throw new Error('--widget <public_key_or_widget_id> is required');
  if (args.prune && !args.apply) throw new Error('--prune requires --apply');
  if (args.dryRun === args.apply) throw new Error('exactly one of --dry-run or --apply is required');
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) throw new Error('INTERNAL_SERVICE_KEY env var not set');

  const collectorUrl = args.collector || 'http://localhost:9848';
  const corpusDir = args.corpus || path.resolve(__dirname, '../../..', 'corpus/quox-support');

  console.log(`Corpus:    ${corpusDir}`);
  console.log(`Collector: ${collectorUrl}`);
  console.log(`Widget:    ${args.widget}`);
  console.log(`Mode:      ${args.apply ? 'APPLY' : 'DRY RUN'}`);

  const websiteDir = args.website || path.resolve(__dirname, '../../../..', 'quox-website');
  const routeIndex = sourceRoutes.loadRouteIndex(websiteDir);
  console.log(routeIndex
    ? `Website:   ${websiteDir} (${routeIndex.size} routed page files, source_url citations on)`
    : `Website:   ${websiteDir} not found, skipping source_url citations (existing URLs left untouched)`);
  const corpusQa = loadFaqYaml(path.join(corpusDir, 'faq.yaml'), { routeIndex });
  const corpusDocs = loadDocs(path.join(corpusDir, 'docs'));
  console.log(`Loaded ${corpusQa.length} FAQ entries, ${corpusDocs.length} docs`);
  if (corpusQa.length === 0 && corpusDocs.length === 0) {
    throw new Error('Corpus is empty, refusing to plan (a wrong --corpus path would otherwise delete every managed source)');
  }

  const client = makeClient({ collectorUrl, serviceKey, widget: args.widget });
  const { sources } = await client.listSources();
  console.log(`Fetched ${sources.length} existing knowledge sources`);

  const plan = diffCorpus({ corpusQa, corpusDocs, existingSources: sources });
  printPlan(plan);

  const totals = planTotals(plan);
  if (args.reconcile || args.prune) printReconcile(await client.reconcile({ apply: false }));
  if (!args.apply) {
    console.log('\nDry run, nothing executed.');
    return;
  }
  const inSync = totals.creates + totals.updates + totals.deletes === 0;
  if (inSync && !args.prune) {
    console.log('\nAlready in sync, nothing to do.');
    return;
  }

  if (!inSync) {
    console.log('\nApplying...');
    await applyPlan(client, plan);
  }

  // Verify: re-list and re-diff; a clean sync plans zero changes.
  const { sources: after } = await client.listSources();
  const verify = diffCorpus({ corpusQa, corpusDocs, existingSources: after });
  const vt = planTotals(verify);
  console.log(`\nVerify: ${after.length} sources total, ${vt.unchanged} managed in sync, ${vt.untouched} untouched, pending changes: ${vt.creates + vt.updates + vt.deletes}`);
  if (vt.creates + vt.updates + vt.deletes > 0) {
    console.error('VERIFY FAILED: a second run would still make changes:');
    printPlan(verify);
    process.exitCode = 2;
    return;
  }
  console.log('Sync complete and verified idempotent.');
  if (args.prune) {
    console.log('\nPruning index (unmanaged + orphan + duplicate; corrections kept)...');
    printReconcile(await client.reconcile({ apply: true }));
  }
}

module.exports = {
  diffCorpus,
  makeClient,
  planTotals,
  qaCategoryForId,
  corpusIdFromCategory,
  corpusDocName,
  parseCorpusDocName,
  slugify,
  contentHash8,
  parseFrontmatter,
  loadFaqYaml,
  loadDocs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  });
}
