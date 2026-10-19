#!/usr/bin/env node
// Static HTTP-method scan of every invocable quox CLI leaf, used by scripts/matrix/leaf-policy.mjs
// so a leaf that POSTs/PATCHes/PUTs/DELETEs can never be classed `read` by its verb name.
// Reads each leaf's action handler source from the commander registry (nothing is parsed or run),
// plus the module-level helper functions it calls (transitively, same file), and records the
// mutating client calls found. Nothing here classifies; it only reports evidence.
//
// Writes docs/matrix/sources/cli-leaf-methods.json.
// Usage: node cli/scripts/export-leaf-methods.mjs [--check]
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'docs', 'matrix', 'sources', 'cli-leaf-methods.json');
const check = process.argv.includes('--check');

const sandboxHome = mkdtempSync(join(tmpdir(), 'qx-leafm-'));
for (const k of Object.keys(process.env)) if (/^QUOX_|TOKEN|SECRET|KEY/i.test(k)) delete process.env[k];
process.env.HOME = sandboxHome;
process.env.XDG_CONFIG_HOME = join(sandboxHome, 'cfg');
process.env.XDG_CACHE_HOME = join(sandboxHome, 'cache');
process.env.NO_COLOR = '1';

const MUT = /\b(?:client|c|api|http)\s*\.\s*(post|put|patch|delete|del)\s*\(/g;
const MUT_ANY = /\.\s*(post|put|patch|delete)\s*\(\s*(?:ep\.path|[`'"]\/)/g;

try {
  const { Command } = await import('commander');
  const { loadConfig } = await import('../lib/core/config.js');
  const { createAuth } = await import('../lib/core/auth.js');
  const { createClient } = await import('../lib/core/client.js');
  const { COMMAND_REGISTRARS, COMMAND_REGISTRARS_BASE } = await import('../lib/core/commandRegistrars.js');
  // commander wraps the handler; capture the original function as it is registered.
  const origAction = Command.prototype.action;
  Command.prototype.action = function (fn) { this.__fn = fn; return origAction.call(this, fn); };
  const program = new Command().name('quox');
  const config = loadConfig();
  const auth = createAuth(config);
  const client = createClient(config, auth);
  const ctx = { config, auth, client, program };
  const fileSrc = {};
  const leafFile = {};
  let curFile = null;
  for (const [path, name] of COMMAND_REGISTRARS) {
    const url = new URL(path, COMMAND_REGISTRARS_BASE);
    const mod = await import(url.href);
    fileSrc[url.pathname] = readFileSync(url, 'utf8');
    curFile = url.pathname;
    const before = new Set();
    const mark = (cmd, p) => { for (const s of cmd.commands) { const k = [...p, s.name()].join(' '); before.add(k); mark(s, [...p, s.name()]); } };
    mark(program, []);
    mod[name](program, ctx);
    const after = (cmd, p) => { for (const s of cmd.commands) { const k = [...p, s.name()].join(' '); if (!before.has(k)) leafFile[k] = curFile; after(s, [...p, s.name()]); } };
    after(program, []);
  }

  // Helper bodies: top-level `function name(` or `const name = (async)? (...) =>` in the same file, crude brace match.
  const helperIndex = (src) => {
    const idx = {};
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(|^const\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/gm;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1] || m[2];
      let i = src.indexOf('{', m.index);
      if (i < 0) continue;
      let depth = 0, j = i;
      for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
      idx[name] = src.slice(m.index, j + 1);
    }
    return idx;
  };
  const helpers = {};
  for (const [f, s] of Object.entries(fileSrc)) helpers[f] = helperIndex(s);

  const scan = (body, file, seen = new Set(), depth = 0) => {
    const found = new Set();
    for (const re of [MUT, MUT_ANY]) { re.lastIndex = 0; let m; while ((m = re.exec(body))) found.add(m[1] === 'del' ? 'delete' : m[1]); }
    if (depth < 4) {
      for (const [name, hb] of Object.entries(helpers[file] || {})) {
        if (seen.has(name) || hb === body) continue;
        if (new RegExp(`\\b${name}\\s*\\(`).test(body)) { seen.add(name); for (const x of scan(hb, file, seen, depth + 1)) found.add(x); }
      }
    }
    return found;
  };

  const leaves = {};
  const walk = (cmd, path) => {
    for (const sub of cmd.commands) {
      if (sub.name() === 'help') continue;
      const p = [...path, sub.name()];
      if (sub._actionHandler) {
        const k = p.join(' ');
        const file = leafFile[k];
        const methods = file ? [...scan(String(sub.__fn || ''), file)].sort() : [];
        if (methods.length) leaves[k] = methods;
      }
      walk(sub, p);
    }
  };
  walk(program, []);
  const sorted = Object.fromEntries(Object.keys(leaves).sort().map((k) => [k, leaves[k]]));
  const body = JSON.stringify({ generated_by: 'cli/scripts/export-leaf-methods.mjs', note: 'leaves whose handler (or same-file helper it calls) issues a mutating HTTP call', mutating: sorted }, null, 1) + '\n';
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== body) { console.error('cli-leaf-methods.json is stale; run: node cli/scripts/export-leaf-methods.mjs'); process.exitCode = 1; }
    else console.log(`cli-leaf-methods.json is current (${Object.keys(sorted).length} mutating leaves)`);
  } else { writeFileSync(OUT, body); console.log(`wrote ${Object.keys(sorted).length} mutating leaves`); }
} finally { rmSync(sandboxHome, { recursive: true, force: true }); }
process.exit(process.exitCode || 0);
