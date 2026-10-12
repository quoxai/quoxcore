#!/usr/bin/env node
/**
 * QuoxChat eval harness runner (QCFT #213)
 *
 * Batches scenarios from corpus/quox-support/eval-scenarios.json through
 * POST /quoxchat/simulate, which runs each message through the REAL
 * /quoxchat/message pipeline (RAG, tools, guardrails) and scores it with
 * services/collector/lib/quoxchatSimulator.js rubrics (pass >= 80).
 *
 * Auth: the simulate route is service-key gated (x-service-key header,
 * INTERNAL_SERVICE_KEY). Key resolution order: --service-key flag, then the
 * INTERNAL_SERVICE_KEY env var, then the repo .env files.
 *
 * Usage:
 *   node services/collector/scripts/run-quoxchat-eval.js \
 *     --widget wid_01kpnyr1afay \
 *     --collector http://127.0.0.1:9848 \
 *     --scenarios corpus/quox-support/eval-scenarios.json \
 *     --category knowledge-pricing,action-routing \
 *     --json /tmp/quoxchat-eval-report.json
 *
 * Flags:
 *   --widget <id>        widget to run against (default: wid_01kpnyr1afay, dev)
 *   --collector <url>    collector base URL (default: http://127.0.0.1:9848)
 *   --scenarios <path>   scenarios JSON (default: corpus/quox-support/eval-scenarios.json)
 *   --category <list>    comma-separated category filter (default: all)
 *   --json <path>        JSON report output path (--out is an alias)
 *   --service-key <key>  override INTERNAL_SERVICE_KEY
 *   --batch-size <n>     scenarios per /simulate call (default 6, route max 60)
 *   --pace-ms <n>        pause between batches (default 2000)
 *
 * Exit code: 0 when every scenario passes, 1 when any scenario scores < 80,
 * 2 on runner/transport errors.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WIDGET_ID = args.widget || 'wid_01kpnyr1afay';
const COLLECTOR = String(args.collector || 'http://127.0.0.1:9848').replace(/\/+$/, '');
const SCENARIOS_PATH = path.resolve(REPO_ROOT, args.scenarios || 'corpus/quox-support/eval-scenarios.json');
const CATEGORY_FILTER = args.category
  ? String(args.category).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : null;
const OUT_PATH = args.json && args.json !== true ? String(args.json)
  : (args.out && args.out !== true ? String(args.out)
    : path.join(os.tmpdir(), `quoxchat-eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const BATCH_SIZE = Math.min(60, Math.max(1, parseInt(args['batch-size'], 10) || 6));
const PACE_MS = Math.max(0, parseInt(args['pace-ms'], 10) || 2000);

// ── Service key resolution ────────────────────────────────────────────────

function readEnvKey(file, name) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n\\r]+)"?\\s*$`, 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function resolveServiceKey() {
  if (args['service-key'] && args['service-key'] !== true) return String(args['service-key']);
  if (process.env.INTERNAL_SERVICE_KEY) return process.env.INTERNAL_SERVICE_KEY;
  const candidates = [
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, 'services', 'collector', '.env'),
  ];
  for (const file of candidates) {
    const key = readEnvKey(file, 'INTERNAL_SERVICE_KEY');
    if (key) return key;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pct(n, d) {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a';
}

function excerpt(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const serviceKey = resolveServiceKey();
  if (!serviceKey) {
    console.error('ERROR: no service key. Pass --service-key, set INTERNAL_SERVICE_KEY, or ensure the repo .env defines it.');
    process.exit(2);
  }

  let corpus;
  try {
    corpus = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: cannot read scenarios file ${SCENARIOS_PATH}: ${err.message}`);
    process.exit(2);
  }

  const allScenarios = Array.isArray(corpus.scenarios) ? corpus.scenarios : [];
  let selected = allScenarios;
  if (CATEGORY_FILTER) {
    selected = allScenarios.filter(s => CATEGORY_FILTER.includes(String(s.category || '').toLowerCase()));
  }
  if (selected.length === 0) {
    console.error(`ERROR: no scenarios selected (file has ${allScenarios.length}, filter: ${CATEGORY_FILTER ? CATEGORY_FILTER.join(',') : 'none'})`);
    process.exit(2);
  }

  // Map corpus shape -> simulator shape (message -> user_message).
  const simScenarios = selected.map((s, i) => ({
    id: s.id || `scenario_${i + 1}`,
    name: s.name || s.id || `scenario ${i + 1}`,
    category: s.category || 'general',
    severity: s.severity || 'low',
    user_message: s.message,
    rubric: s.rubric || {},
  }));

  console.log(`QuoxChat eval: ${simScenarios.length} scenarios, widget ${WIDGET_ID}, collector ${COLLECTOR}`);
  console.log(`Batch size ${BATCH_SIZE}, pace ${PACE_MS}ms between batches\n`);

  const batches = chunk(simScenarios, BATCH_SIZE);
  const results = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const label = `batch ${b + 1}/${batches.length} (${batch.length} scenarios)`;
    process.stdout.write(`  ${label} ... `);
    const timeoutMs = batch.length * 25000 + 15000;
    try {
      const resp = await fetch(`${COLLECTOR}/quoxchat/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
        body: JSON.stringify({ widget_id: WIDGET_ID, scenarios: batch, scope: 'eval-harness' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.log(`HTTP ${resp.status}`);
        console.error(`ERROR: /simulate returned ${resp.status}: ${excerpt(body, 300)}`);
        process.exit(2);
      }
      const data = await resp.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      results.push(...rows);
      const passed = rows.filter(r => r.passed).length;
      console.log(`done, ${passed}/${rows.length} passed`);
    } catch (err) {
      console.log('failed');
      console.error(`ERROR: batch request failed: ${err.message}`);
      process.exit(2);
    }
    if (b < batches.length - 1 && PACE_MS > 0) await sleep(PACE_MS);
  }

  const durationMs = Date.now() - t0;

  // ── Scoreboard ──────────────────────────────────────────────────────────

  const byCategory = new Map();
  for (const r of results) {
    const cat = r.category || 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(r);
  }

  const catSummaries = [];
  console.log('\n================ SCOREBOARD ================\n');
  const header = `${'category'.padEnd(24)} ${'pass'.padEnd(8)} ${'warn'.padEnd(6)} ${'fail'.padEnd(6)} ${'avg'.padEnd(6)} rate`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [cat, rows] of [...byCategory.entries()].sort()) {
    const pass = rows.filter(r => r.passed).length;
    const fail = rows.filter(r => !r.passed && r.score < 60).length;
    const warn = rows.length - pass - fail;
    const avg = rows.length ? Math.round(rows.reduce((a, r) => a + (r.score || 0), 0) / rows.length) : 0;
    catSummaries.push({ category: cat, total: rows.length, passed: pass, warned: warn, failed: fail, avg_score: avg });
    console.log(`${cat.padEnd(24)} ${`${pass}/${rows.length}`.padEnd(8)} ${String(warn).padEnd(6)} ${String(fail).padEnd(6)} ${String(avg).padEnd(6)} ${pct(pass, rows.length)}`);
  }

  const totalPass = results.filter(r => r.passed).length;
  const totalAvg = results.length ? Math.round(results.reduce((a, r) => a + (r.score || 0), 0) / results.length) : 0;
  console.log('-'.repeat(header.length));
  console.log(`${'TOTAL'.padEnd(24)} ${`${totalPass}/${results.length}`.padEnd(8)} ${''.padEnd(6)} ${''.padEnd(6)} ${String(totalAvg).padEnd(6)} ${pct(totalPass, results.length)}`);

  const worst = [...results].sort((a, b) => (a.score || 0) - (b.score || 0)).slice(0, 5);
  if (worst.length > 0 && worst[0].score < 100) {
    console.log('\n---------------- WORST 5 -------------------');
    for (const r of worst) {
      console.log(`\n[${r.score}] ${r.category} / ${r.name || r.scenario_id}`);
      if (Array.isArray(r.notes) && r.notes.length) console.log(`  notes: ${r.notes.join(' | ')}`);
      console.log(`  response: ${excerpt(r.response?.text)}`);
    }
  }

  // ── JSON report ─────────────────────────────────────────────────────────

  const report = {
    meta: {
      stream: 'QCFT-213',
      widget_id: WIDGET_ID,
      collector: COLLECTOR,
      scenarios_file: SCENARIOS_PATH,
      category_filter: CATEGORY_FILTER,
      started_at: startedAt,
      duration_ms: durationMs,
      batch_size: BATCH_SIZE,
      pace_ms: PACE_MS,
      total: results.length,
      passed: totalPass,
      avg_score: totalAvg,
    },
    categories: catSummaries,
    results,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${OUT_PATH}`);
  console.log(`Duration: ${Math.round(durationMs / 1000)}s`);

  process.exit(totalPass === results.length ? 0 : 1);
}

main().catch(err => {
  console.error(`ERROR: ${err.stack || err.message}`);
  process.exit(2);
});
