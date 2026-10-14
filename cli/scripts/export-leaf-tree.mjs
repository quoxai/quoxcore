#!/usr/bin/env node
// Exports every invocable quox CLI command (each leaf, with its exact options and
// arguments) to services/collector/config/cliLeafTree.json, read from the CLI's own
// commander registry in-process. The collector's quox_cli tool validates every call
// against this file: an unknown leaf, option or argument count is refused before
// anything is spawned.
//
// Safety: nothing is parsed or run. The registrars only DEFINE commands; this script
// walks the definitions. It runs with an empty HOME, so no stored credential or
// profile can be read, and the config it builds is never saved.
//
// Usage: node cli/scripts/export-leaf-tree.mjs           (rewrite the snapshot)
//        node cli/scripts/export-leaf-tree.mjs --check   (exit 1 if the snapshot drifted)
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'services', 'collector', 'config', 'cliLeafTree.json');
const check = process.argv.includes('--check');

// Sandbox BEFORE any CLI module loads (config.js reads homedir() lazily, but be strict).
const sandboxHome = mkdtempSync(join(tmpdir(), 'qx-leaf-'));
for (const k of Object.keys(process.env)) if (/^QUOX_|TOKEN|SECRET|KEY/i.test(k)) delete process.env[k];
process.env.HOME = sandboxHome;
process.env.XDG_CONFIG_HOME = join(sandboxHome, 'cfg');
process.env.XDG_CACHE_HOME = join(sandboxHome, 'cache');
process.env.NO_COLOR = '1';

const DESC_MAX = 160;
const clip = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX - 1)}…` : t; };

function optionShape(o) {
  return {
    long: o.long || null,
    short: o.short || null,
    value: o.required ? 'required' : o.optional ? 'optional' : 'none',
    variadic: !!o.variadic,
    negate: !!o.negate,
    mandatory: !!o.mandatory,
  };
}

function argShape(a) {
  return { name: a.name(), required: !!a.required, variadic: !!a.variadic };
}

try {
  const { Command } = await import('commander');
  const { loadConfig } = await import('../lib/core/config.js');
  const { createAuth } = await import('../lib/core/auth.js');
  const { createClient } = await import('../lib/core/client.js');
  const { COMMAND_REGISTRARS, COMMAND_REGISTRARS_BASE } = await import('../lib/core/commandRegistrars.js');

  const program = new Command().name('quox');
  const config = loadConfig();
  const auth = createAuth(config);
  const client = createClient(config, auth);
  const ctx = { config, auth, client, program };
  for (const [path, name] of COMMAND_REGISTRARS) {
    const mod = await import(new URL(path, COMMAND_REGISTRARS_BASE).href);
    mod[name](program, ctx);
  }

  const leaves = {};
  const walk = (cmd, path) => {
    for (const sub of cmd.commands) {
      if (sub.name() === 'help') continue;
      const p = [...path, sub.name()];
      // Invocable = it has its own action. A group with subcommands AND an action
      // (e.g. `quox sitrep`) is invocable bare as well.
      if (sub._actionHandler) {
        leaves[p.join(' ')] = {
          path: p,
          aliases: sub.aliases(),
          description: clip(sub.description()),
          args: (sub.registeredArguments || []).map(argShape),
          options: sub.options.filter((o) => o.long !== '--help').map(optionShape),
          has_subcommands: sub.commands.length > 0,
          ...(sub._hidden ? { hidden: true } : {}),
        };
      }
      walk(sub, p);
    }
  };
  walk(program, []);

  const keys = Object.keys(leaves).sort();
  if (keys.length < 200) throw new Error(`only ${keys.length} leaves found; refusing to write a broken tree`);
  const sorted = {};
  for (const k of keys) sorted[k] = leaves[k];
  // One leaf per line: compact to load, still a readable diff when a command changes.
  const lines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(sorted[k])}`);
  const body = `{"generated_by": "cli/scripts/export-leaf-tree.mjs", "leaf_count": ${keys.length}, "leaves": {\n${lines.join(',\n')}\n}}\n`;
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== body) { console.error('cliLeafTree.json is stale; run: node cli/scripts/export-leaf-tree.mjs'); process.exitCode = 1; }
    else console.log(`cliLeafTree.json is current (${keys.length} leaves)`);
  } else {
    writeFileSync(OUT, body);
    console.log(`wrote ${keys.length} leaves to ${OUT}`);
  }
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
