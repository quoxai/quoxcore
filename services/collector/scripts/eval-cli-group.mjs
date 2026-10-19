#!/usr/bin/env node
// Every corpus ask for one CLI surface, each held out on its own: how often its own leaf ranks
// first / in the top 5, and how often a different product family's leaf outranks every leaf of
// the asked surface (the quox#882 shape: "workflow" asks picking `quoxbox workflows`).
// Usage: node services/collector/scripts/eval-cli-group.mjs workflow
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildIndex, rankWithIndex } = require('../lib/quoxCli/candidates.js');
const { loadTree, loadPolicy, classifyLeaf } = require('../lib/quoxCli/policy.js');
const group = process.argv[2] || 'workflow';
const tree = loadTree(); const policy = loadPolicy();
const rows = require('../config/cliUtterances.json').rows.filter((r) => tree.leaves[r.path] && r.path.split(' ')[0] === group && classifyLeaf(r.path, { tree, policy }).class !== 'never');
let n = 0; let top1 = 0; let top5 = 0; let foreignFirst = 0;
for (const r of rows) for (const ask of r.asks) {
  const idx = buildIndex({ exclude: new Set([`${r.path}\u0000${ask}`]) });
  const names = rankWithIndex(idx, ask, { k: 5 }).candidates.map((c) => c.leaf);
  n += 1; if (names[0] === r.path) top1 += 1; if (names.includes(r.path)) top5 += 1;
  if (names[0] && names[0].split(' ')[0] !== group) foreignFirst += 1;
}
console.log(JSON.stringify({ group, asks: n, top1, top5, top1_pct: Math.round((100 * top1) / n), top5_pct: Math.round((100 * top5) / n), other_surface_first: foreignFirst }));
