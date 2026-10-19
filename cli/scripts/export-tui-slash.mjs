#!/usr/bin/env node
// Exports the TUI slash-command registry (cli/lib/quoxon/commands.js REGISTRY, the single
// registry behind /help and dispatch) to services/collector/config/tuiSlashRegistry.json.
// The collector's grounding contract (lib/groundingContract.js) and quox_command_lookup
// read it, the TUI twin of cliCommandTree.json (export-command-tree.mjs).
//
// Usage: node cli/scripts/export-tui-slash.mjs           (rewrite the snapshot)
//        node cli/scripts/export-tui-slash.mjs --check   (exit 1 if the snapshot drifted)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY } from '../lib/quoxon/commands.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'services', 'collector', 'config', 'tuiSlashRegistry.json');

export function snapshot() {
  const commands = REGISTRY
    .filter((e) => e.kind === 'command')
    .map((e) => ({
      id: e.id, usage: e.usage || `/${e.id}`, desc: e.desc || '', status: e.status || 'active',
      ...(e.aliases && e.aliases.length ? { aliases: e.aliases } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { generated_by: 'cli/scripts/export-tui-slash.mjs', commands };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const body = `${JSON.stringify(snapshot(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== body) { console.error('tuiSlashRegistry.json drifted: run node cli/scripts/export-tui-slash.mjs'); process.exit(1); }
    console.log('tuiSlashRegistry.json up to date');
  } else {
    writeFileSync(OUT, body);
    console.log(`wrote ${OUT} (${snapshot().commands.length} commands)`);
  }
}
