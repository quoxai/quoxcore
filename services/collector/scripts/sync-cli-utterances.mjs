#!/usr/bin/env node
// Vendors SITE-CLI's plain-words asks per CLI leaf (docs/matrix/sources/cli-utterances.json)
// into services/collector/config/cliUtterances.json, which ships in the collector image and
// which lib/quoxCli/candidates.js indexes at boot to rank the quox_cli leaves for a turn.
//
// Usage: node services/collector/scripts/sync-cli-utterances.mjs           (rewrite the copy)
//        node services/collector/scripts/sync-cli-utterances.mjs --check   (exit 1 if it drifted)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'config', 'cliUtterances.json');
const CANONICAL = join(here, '..', '..', '..', 'docs', 'matrix', 'sources', 'cli-utterances.json');
const check = process.argv.includes('--check');
const fromIdx = process.argv.indexOf('--from');

const src = JSON.parse(readFileSync(fromIdx > -1 ? process.argv[fromIdx + 1] : CANONICAL, 'utf8'));
if (!Array.isArray(src.rows) || src.rows.length < 100) throw new Error('source utterances have no rows; refusing to vendor them');
const bad = src.rows.filter((r) => !r || typeof r.path !== 'string' || !Array.isArray(r.asks));
if (bad.length) throw new Error(`source utterances have ${bad.length} malformed rows (first: ${JSON.stringify(bad[0])})`);
const rows = [...src.rows].sort((a, b) => a.path.localeCompare(b.path))
  .map((r) => ({ path: r.path, asks: r.asks.filter((a) => typeof a === 'string' && a.trim()) }));
const header = { vendored_from: 'docs/matrix/sources/cli-utterances.json', cli: src.cli || null, built_at: src.built_at || null };
const body = `${JSON.stringify(header).slice(0, -1)}, "rows": [\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]}\n`;
if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== body) { console.error('cliUtterances.json drifted from docs/matrix/sources/cli-utterances.json; run: node services/collector/scripts/sync-cli-utterances.mjs'); process.exitCode = 1; }
  else console.log(`cliUtterances.json is current (${rows.length} leaves)`);
} else {
  writeFileSync(OUT, body);
  console.log(`vendored ${rows.length} leaves of asks to ${OUT}`);
}
