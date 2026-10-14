#!/usr/bin/env node
// Exports the real quox command tree (top-level verbs and their subcommands) to
// services/collector/config/cliCommandTree.json, from the CLI's own --help output.
// The collector's answer grounding guard (lib/answerGrounding.js, #817) flags an agent
// answer that names a `quox` command not in this tree.
//
// Safety: it only runs `quox [group] --help` (commander prints help and exits before any
// action runs), with an empty HOME and no QUOX_* or token variables, so it can neither
// read credentials nor reach a server.
//
// Usage: node cli/scripts/export-command-tree.mjs           (rewrite the snapshot)
//        node cli/scripts/export-command-tree.mjs --check   (exit 1 if the snapshot drifted)
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'quox.js');
const OUT = join(here, '..', '..', 'services', 'collector', 'config', 'cliCommandTree.json');
const check = process.argv.includes('--check');

const sandboxHome = mkdtempSync(join(tmpdir(), 'qx-tree-'));
const env = { PATH: process.env.PATH, HOME: sandboxHome, XDG_CONFIG_HOME: join(sandboxHome, 'cfg'), NO_COLOR: '1', CI: '1' };

async function commandsOf(path) {
  let stdout = '';
  try { ({ stdout } = await run(process.execPath, [BIN, ...path, '--help'], { env, timeout: 30000 })); } catch (e) { stdout = e.stdout || ''; }
  const out = [];
  let inCommands = false;
  for (const line of stdout.split('\n')) {
    if (/^Commands:/.test(line)) { inCommands = true; continue; }
    if (/^\S/.test(line)) inCommands = false;
    if (!inCommands) continue;
    const m = line.match(/^ {2}([a-z][a-z0-9-]*)(?:\|([a-z][a-z0-9-]*))?/);
    if (m && m[1] !== 'help') { out.push(m[1]); if (m[2]) out.push(m[2]); }
  }
  return [...new Set(out)].sort();
}

try {
  const top = await commandsOf([]);
  if (top.length < 10) throw new Error(`only ${top.length} top-level commands parsed; refusing to write a broken tree`);
  const tree = {};
  for (const verb of top) tree[verb] = await commandsOf([verb]);
  const body = `${JSON.stringify({ generated_by: 'cli/scripts/export-command-tree.mjs', commands: tree }, null, 2)}\n`;
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== body) { console.error(`cliCommandTree.json is stale; run: node cli/scripts/export-command-tree.mjs`); process.exitCode = 1; }
    else console.log('cliCommandTree.json is current');
  } else {
    writeFileSync(OUT, body);
    console.log(`wrote ${Object.keys(tree).length} top-level commands to ${OUT}`);
  }
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}
