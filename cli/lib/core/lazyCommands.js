/**
 * Lazy command-group registration (CORTEX-BENCH, CLI startup latency).
 *
 * Importing every command module cost ~1s on every `quox` invocation. Here a
 * cached map (top-level command name -> registrar indexes) lets a normal
 * invocation import only the module(s) that define or extend its command (a
 * group can be extended by several modules, e.g. `agent` by agent.js and
 * agentAttach.js). Correctness rules:
 *   - no map, stale map, unknown command, help/completion/bare invocation,
 *     or ANY error in the lazy path  ->  full load (the old behaviour);
 *   - after a lazy load, the command must actually exist, else full load;
 *   - every full load rebuilds the map, so it self-heals.
 * A wrong map can therefore only make a call slower, never break it.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAP_VERSION = 1;
// Global options that consume the next argv token (so it is not the command).
const VALUE_OPTS = new Set(['-o', '--output', '--org', '-p', '--profile']);
const FULL_LOAD_TOKENS = new Set(['help', 'completion', 'tui']);

/** First argv token that names a command, or null (help/bare/unknown shape). */
export function commandToken(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return null;
    if (a === '-h' || a === '--help' || a === '-V' || a === '--version') return null;
    if (a.startsWith('-')) {
      if (VALUE_OPTS.has(a)) i++;
      continue;
    }
    return a;
  }
  return null;
}

function mapPath() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'quox', 'cli-command-map.json');
}

/** Cache key: the command modules' file set and mtimes, plus the registrar list. */
export function mapKey(registrars, commandsDir) {
  let sig = registrars.map(([p, n]) => `${p}#${n}`).join('|');
  try {
    for (const f of readdirSync(commandsDir).sort()) {
      if (!f.endsWith('.js')) continue;
      sig += `|${f}:${statSync(join(commandsDir, f)).mtimeMs}`;
    }
  } catch { return null; }
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  return `v${MAP_VERSION}:${h}`;
}

// Size of a command subtree (every nested command and option), so a module
// that only extends a DEEP subcommand of an existing group is still recorded
// as touching that top-level group.
function subtreeSize(cmd) {
  return 1 + cmd.options.length + cmd.commands.reduce((n, c) => n + subtreeSize(c), 0);
}
function topLevelSnapshot(program) {
  return new Map(program.commands.map((c) => [c.name(), subtreeSize(c)]));
}

async function fullLoad(program, ctx, registrars, baseUrl, key) {
  const map = {};
  for (let i = 0; i < registrars.length; i++) {
    const [path, name] = registrars[i];
    const before = topLevelSnapshot(program);
    const mod = await import(new URL(path, baseUrl).href);
    mod[name](program, ctx);
    for (const [cmd, size] of topLevelSnapshot(program)) {
      if (before.get(cmd) !== size) (map[cmd] ||= []).push(i);
    }
  }
  if (key) {
    try {
      const file = mapPath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ key, map }));
    } catch { /* the cache is an optimisation only */ }
  }
}

/**
 * Register command groups lazily when safe, fully otherwise.
 * @param {import('commander').Command} program
 * @param {object} ctx
 * @param {Array<[string, string]>} registrars [modulePath relative to baseUrl, export name], in registration order
 * @param {string[]} argv process.argv.slice(2)
 * @param {string} baseUrl import.meta.url of the caller
 */
export async function registerCommandGroups(program, ctx, registrars, argv, baseUrl) {
  const commandsDir = join(dirname(fileURLToPath(baseUrl)), '..', 'lib', 'commands');
  const key = process.env.QUOX_CLI_EAGER === '1' ? null : mapKey(registrars, commandsDir);
  const token = commandToken(argv);
  if (key && token && !FULL_LOAD_TOKENS.has(token)) {
    try {
      const cached = JSON.parse(readFileSync(mapPath(), 'utf-8'));
      const idx = cached && cached.key === key ? cached.map[token] : null;
      if (Array.isArray(idx) && idx.length > 0) {
        for (const i of idx) {
          const [path, name] = registrars[i];
          const mod = await import(new URL(path, baseUrl).href);
          mod[name](program, ctx);
        }
        if (program.commands.some((c) => c.name() === token || c.aliases().includes(token))) return 'lazy';
      }
    } catch { /* fall through to a full load */ }
    // Partial registration (if any) must not double-register: start clean.
    program.commands.splice(0, program.commands.length);
  }
  await fullLoad(program, ctx, registrars, baseUrl, key);
  return 'full';
}
