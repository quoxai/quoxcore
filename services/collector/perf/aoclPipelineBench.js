#!/usr/bin/env node
/**
 * AOCL pipeline benchmark harness — AOCL-FULL-3.
 *
 * Runs N simulated chat requests through runPipeline with representative
 * layer latencies and prints p50/p95/p99 per layer + the full pipeline.
 * Used as the baseline before any new layers land; re-run at the end of
 * each subsequent AOCL-FULL phase to check regression.
 *
 * Usage:
 *   node perf/aoclPipelineBench.js                # 100 iterations default
 *   node perf/aoclPipelineBench.js --n 500        # 500 iterations
 *   node perf/aoclPipelineBench.js --json         # machine-readable output
 *   node perf/aoclPipelineBench.js --budgets      # run with budgets enabled
 *
 * Output (default):
 *   layer  p50   p95   p99   max   samples
 *   L0     1.0   3.0   5.0   7.0   100
 *   L1     2.0   4.0   6.0   9.0   100
 *   ...
 *   TOTAL  22    48    76    120   100
 *
 * The simulated layer latencies emulate what the real layers will cost:
 *   L0 normalize  — ~1ms (pure object construction)
 *   L1 identity   — ~2ms (JWT validation)
 *   L2 smart route — ~5ms (regex pattern match)
 *   L3 policy     — ~12ms (per-org policy scan)
 *   L4 plan       — ~3ms (heuristic classifier, bypass default)
 *   L5 context    — ~60ms (memory preflight; NO real Qdrant/memory here)
 *   L6 shape      — ~8ms (prompt build, style adapt)
 *   L7 execute    — SKIPPED in bench (LLM-owned, not budgeted)
 *   L8 verify     — ~8ms (regex + pattern match)
 *   L9 assemble   — ~4ms (format detect + redact)
 *   L10 audit     — ~1ms (envelope emit)
 *
 * All latencies include deterministic jitter (random 0-30% added) so p95/p99
 * are meaningful over the run.
 */

const path = require('path');
const { runPipeline } = require('../lib/aoclPipeline.js');
const { buildAoclContext } = require('../lib/aoclContext.js');

function sleepJitter(baseMs) {
  // 0-30% jitter on top of base
  const jitter = baseMs * Math.random() * 0.3;
  return new Promise(r => setTimeout(r, baseMs + jitter));
}

// Simulated layer stack mirroring the post-AOCL-FULL target.
// Each layer runs a deterministic sleep to emulate its real cost.
function buildSimStack() {
  return {
    layers: [
      { id: 'L0', run: async () => { await sleepJitter(1); return { proceed: true }; } },
      { id: 'L1', run: async () => { await sleepJitter(2); return { proceed: true }; } },
      { id: 'L2', run: async () => { await sleepJitter(5); return { proceed: true }; } },
      { id: 'L3', run: async () => { await sleepJitter(12); return { proceed: true }; } },
      { id: 'L4', run: async () => { await sleepJitter(3); return { proceed: true, bypass: true, reason: 'single-turn' }; } },
      { id: 'L5', run: async () => { await sleepJitter(60); return { proceed: true }; } },
      { id: 'L6', run: async () => { await sleepJitter(8); return { proceed: true }; } },
      { id: 'L8', run: async () => { await sleepJitter(8); return { proceed: true }; } },
      { id: 'L9', run: async () => { await sleepJitter(4); return { proceed: true }; } },
      { id: 'L10', run: async () => { await sleepJitter(1); return { proceed: true }; } },
    ],
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runBench({ iterations = 100, useBudgets = false } = {}) {
  const layerDurations = {};  // { L0: [ms, ms, ...], ... }
  const totalDurations = [];

  for (let i = 0; i < iterations; i++) {
    const ctx = buildAoclContext({
      sessionId: `BENCH_${i}`,
      selectedAgent: 'quox',
      prompt: 'benchmark',
    });
    const startTotal = Date.now();
    await runPipeline(ctx, buildSimStack(), { budgets: useBudgets });
    totalDurations.push(Date.now() - startTotal);
    for (const [layerId, lr] of Object.entries(ctx.layerResults || {})) {
      (layerDurations[layerId] ||= []).push(lr.duration_ms || 0);
    }
  }

  const stats = {};
  for (const [layerId, durations] of Object.entries(layerDurations)) {
    const sorted = [...durations].sort((a, b) => a - b);
    stats[layerId] = {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] || 0,
      samples: durations.length,
    };
  }
  const totalSorted = [...totalDurations].sort((a, b) => a - b);
  const totalStats = {
    p50: percentile(totalSorted, 50),
    p95: percentile(totalSorted, 95),
    p99: percentile(totalSorted, 99),
    max: totalSorted[totalSorted.length - 1] || 0,
    samples: totalDurations.length,
  };

  return { perLayer: stats, total: totalStats, iterations, useBudgets };
}

function formatTable(results) {
  const rows = [['layer', 'p50', 'p95', 'p99', 'max', 'samples']];
  for (const id of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8', 'L9', 'L10']) {
    const s = results.perLayer[id];
    if (!s) continue;
    rows.push([id, s.p50, s.p95, s.p99, s.max, s.samples]);
  }
  const t = results.total;
  rows.push(['TOTAL', t.p50, t.p95, t.p99, t.max, t.samples]);

  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  return rows.map(r => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const iterations = args.includes('--n') ? parseInt(args[args.indexOf('--n') + 1], 10) : 100;
  const useBudgets = args.includes('--budgets');
  const asJson = args.includes('--json');

  console.error(`[bench] running ${iterations} iterations, budgets=${useBudgets}...`);
  const results = await runBench({ iterations, useBudgets });
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\nAOCL pipeline benchmark — ${iterations} iterations (budgets=${useBudgets})\n`);
    console.log(formatTable(results));
    console.log('');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[bench] failed:', err);
    process.exit(1);
  });
}

module.exports = { runBench, buildSimStack, percentile };
