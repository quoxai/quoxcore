#!/usr/bin/env node
// Vendors the canonical per-leaf policy (docs/matrix/sources/cli-leaf-policy.json, the
// QUOXON proof matrix in this repo) into services/collector/config/cliLeafPolicy.json,
// which ships in the collector image and which the quox_cli agent tool reads to
// class each CLI leaf as read | write | never. The collector's own never-floor
// (lib/quoxCli/policy.js) still wins over this file in the stricter direction only.
//
// Source: --from <file>, else docs/matrix/sources/cli-leaf-policy.json in this repo.
// scripts/matrix/test/matrix-drift.mjs (npm run test:matrix) fails when the two differ.
//
// Usage: node services/collector/scripts/sync-cli-leaf-policy.mjs           (rewrite the copy)
//        node services/collector/scripts/sync-cli-leaf-policy.mjs --check   (exit 1 if it drifted)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'config', 'cliLeafPolicy.json');
const CANONICAL = join(here, '..', '..', '..', 'docs', 'matrix', 'sources', 'cli-leaf-policy.json');
const check = process.argv.includes('--check');
const fromIdx = process.argv.indexOf('--from');

function readSource() {
  const file = fromIdx > -1 ? process.argv[fromIdx + 1] : CANONICAL;
  return readFileSync(file, 'utf8');
}

const src = JSON.parse(readSource());
if (!Array.isArray(src.rows) || src.rows.length < 100) throw new Error('source policy has no rows; refusing to vendor it');
const CLASSES = new Set(['read', 'write', 'never']);
const bad = src.rows.filter((r) => !r || typeof r.path !== 'string' || !CLASSES.has(r.class));
if (bad.length) throw new Error(`source policy has ${bad.length} malformed rows (first: ${JSON.stringify(bad[0])})`);
const rows = [...src.rows].sort((a, b) => a.path.localeCompare(b.path)).map((r) => ({ path: r.path, class: r.class, reason: String(r.reason || '') }));
const header = { vendored_from: 'docs/matrix/sources/cli-leaf-policy.json', cli: src.cli || null, built_at: src.built_at || null, counts: src.counts || null };
const body = `${JSON.stringify(header).slice(0, -1)}, "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]}\n`;
// The TUI's slash-to-CLI table (cli/lib/quoxon/slash/cliLeaves.json, path -> class) is a second
// vendored copy; sync it in the same pass so the two can never drift apart (2026-10-14: it fell 4 leaves behind).
const CLI_OUT = join(here, '..', '..', '..', 'cli', 'lib', 'quoxon', 'slash', 'cliLeaves.json');
const cliBody = JSON.stringify(Object.fromEntries(rows.map(r => [r.path, r.class]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 0).replace(/,"/g, ',\n"') + '\n';
if (check) {
  const cliCur = existsSync(CLI_OUT) ? readFileSync(CLI_OUT, 'utf8') : '';
  if (JSON.stringify(JSON.parse(cliCur || '{}')) !== JSON.stringify(JSON.parse(cliBody))) { console.error('cli/lib/quoxon/slash/cliLeaves.json drifted; run: node services/collector/scripts/sync-cli-leaf-policy.mjs'); process.exitCode = 1; }
} else {
  writeFileSync(CLI_OUT, cliBody);
  console.log(`vendored ${rows.length} leaf classes to ${CLI_OUT}`);
}
if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== body) { console.error('cliLeafPolicy.json drifted from docs/matrix/sources/cli-leaf-policy.json; run: node services/collector/scripts/sync-cli-leaf-policy.mjs'); process.exitCode = 1; }
  else console.log(`cliLeafPolicy.json is current (${rows.length} rows)`);
} else {
  writeFileSync(OUT, body);
  console.log(`vendored ${rows.length} policy rows to ${OUT}`);
}
