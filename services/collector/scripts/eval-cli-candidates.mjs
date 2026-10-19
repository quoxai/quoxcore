#!/usr/bin/env node
// Held-out accuracy of the quox_cli candidate ranker (lib/quoxCli/candidates.js).
// Samples N asks from the vendored corpus (seeded, one per leaf), removes exactly those asks
// from the index, ranks each, and reports top-1 / top-5 leaf accuracy and ms per ask.
// Usage: node services/collector/scripts/eval-cli-candidates.mjs [--n 30] [--seed 7] [--verbose]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildIndex, rankWithIndex, terms, STRONG_SHARE, STRONG_MARGIN } = require('../lib/quoxCli/candidates.js');
const corpusFile = require.resolve('../config/cliUtterances.json');
const { classifyLeaf, loadTree, loadPolicy } = require('../lib/quoxCli/policy.js');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : dflt; };
const N = arg('--n', 30);
let seed = arg('--seed', 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const tree = loadTree(); const policy = loadPolicy();
const GROUP = (() => { const i = process.argv.indexOf('--group'); return i > -1 ? process.argv[i + 1] : null; })(); // e.g. --group workflow: only that surface's leaves
const rows = require(corpusFile).rows.filter((r) => tree.leaves[r.path] && classifyLeaf(r.path, { tree, policy }).class !== 'never' && r.asks.length > 1 && (!GROUP || r.path.split(' ')[0] === GROUP));
const picked = [];
const used = new Set();
while (picked.length < N && used.size < rows.length) {
  const r = rows[Math.floor(rnd() * rows.length)];
  if (used.has(r.path)) continue;
  used.add(r.path);
  picked.push({ leaf: r.path, ask: r.asks[Math.floor(rnd() * r.asks.length)] });
}
const t0 = process.hrtime.bigint();
const idx = buildIndex({ exclude: new Set(picked.map((p) => `${p.leaf}\u0000${p.ask}`)) });
const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
let top1 = 0; let top5 = 0; let total = 0; let strong = 0; let strongOk = 0;
for (const p of picked) {
  const s = process.hrtime.bigint();
  const r = rankWithIndex(idx, p.ask, { k: 5 });
  total += Number(process.hrtime.bigint() - s) / 1e6;
  const names = r.candidates.map((c) => c.leaf);
  // the same rule as strongCliMatch, against the held-out index
  const [a, b] = r.candidates;
  if (a && r.maxScore && a.score / r.maxScore >= STRONG_SHARE && !(b && a.score < b.score * STRONG_MARGIN) && terms(a.leaf.replace(/-/g, ' ')).some((t) => r.terms.includes(t))) { strong++; if (a.leaf === p.leaf) strongOk++; }
  if (names[0] === p.leaf) top1++;
  if (names.includes(p.leaf)) top5++;
  if (process.argv.includes('--verbose')) console.log(`${names[0] === p.leaf ? 'HIT ' : names.includes(p.leaf) ? 'TOP5' : 'MISS'} ${p.leaf.padEnd(30)} "${p.ask}" -> ${names.slice(0, 3).join(' | ')} (${r.candidates[0] ? r.candidates[0].score : '-'})`);
}
console.log(JSON.stringify({ source: idx.source, sampled: picked.length, held_out: true, top1, top5, top1_pct: Math.round((100 * top1) / picked.length), top5_pct: Math.round((100 * top5) / picked.length), index_build_ms: Math.round(buildMs), ms_per_ask: +(total / picked.length).toFixed(2), strong_matches: strong, strong_top1_correct: strongOk }));
