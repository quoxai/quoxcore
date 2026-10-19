/**
 * The one CLI updater (owner 2026-10-16 "we need /update", "or quox --update"): shared by /update in the
 * conversation client and `quox update` / `quox --update` in the shell.
 *
 * It updates THIS quox the way it was installed, and never builds a second path where one already exists:
 *   npm         <root> is node_modules/quoxcli        -> npm install -g quoxcli@<latest>
 *   shared-git  the box's shared CLI tree             -> quox-cli-refresh (it refuses a dirty tree itself)
 *   git         any other git checkout                -> git -C <root> pull --ff-only (clean and on main only)
 *   server      a self-hosted install, at a v* tag    -> points at `quox server update` (that is its updater)
 *   bundle      a dev-server bundle (.bundle-sha)     -> points at the server's refresh
 * It never runs git stash, reset or checkout. Every external call is injectable (deps.run / spawn) for tests.
 *
 * Network: `npm view quoxcli ...` (the npm registry) and `git fetch origin main` (the tree's own remote), only
 * when the user asks for an update. Nothing is sent but those requests.
 */
import { spawnSync, execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { RUNNING_ROOT, findOnPath } from '../quoxon/slash/restart.js';
import { cmpSemver } from '../server/install.js';
import { askText } from '../quoxon/ask.js';

export const NPM_PACKAGE = 'quoxcli';
export const NOTES_MAX = 5;

function defaultRun(cmd, args, { timeout = 30000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  if (r.error) return { code: null, stdout: '', stderr: `${r.error.code || 'failed'}: ${r.error.message}` };
  return { code: r.status, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}

/** The same, without blocking: the check runs while the conversation client keeps painting. */
function asyncRun(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return done({ code: null, stdout: '', stderr: `${err.code || (err.killed ? 'timed out' : 'failed')}: ${String(stderr || err.message).trim()}` });
      done({ code: err ? err.code : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function withDeps(deps = {}, run = defaultRun) {
  return {
    run,
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
    findOnPath,
    home: os.homedir(),
    ...deps,
  };
}

const gitOut = (d, dir, args, timeout = 5000) => {
  const r = d.run('git', ['-C', dir, ...args], { timeout });
  return r.code === 0 ? String(r.stdout || '').trim() : null;
};
const gitOutA = async (d, dir, args, timeout = 5000) => {
  const r = await d.run('git', ['-C', dir, ...args], { timeout });
  return r.code === 0 ? String(r.stdout || '').trim() : null;
};
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

/** How this quox was installed. -> { kind, root, version, branch?, refresh?, tag? } */
export function detectInstall({ root = RUNNING_ROOT, env = process.env, deps = {} } = {}) {
  const d = withDeps(deps);
  const real = d.realpath(root);
  let version = null;
  try { version = JSON.parse(d.readFile(join(root, 'package.json'))).version || null; } catch { /* no package.json */ }
  if (/[/\\]node_modules[/\\]quoxcli$/.test(real)) return { kind: 'npm', root: real, version };
  if (d.exists(join(root, '.bundle-sha'))) return { kind: 'bundle', root: real, version };
  const top = gitOut(d, real, ['rev-parse', '--show-toplevel']);
  if (top) {
    const branch = gitOut(d, top, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const refresh = d.findOnPath('quox-cli-refresh', env);
    const shared = d.realpath(env.QUOX_CLI_DIR || join(d.home, 'quox-dashboard-cli'));
    if (refresh && d.realpath(top) === shared) return { kind: 'shared-git', root: top, refresh, branch, version };
    if (branch === 'HEAD') {
      const tag = gitOut(d, top, ['describe', '--tags', '--exact-match']);
      if (tag && /^v\d/.test(tag)) return { kind: 'server', root: top, tag, version };
    }
    return { kind: 'git', root: top, branch, version };
  }
  return { kind: 'unknown', root: real, version };
}

async function checkNpm(info, d) {
  const cur = info.version || '0.0.0';
  const v = await d.run('npm', ['view', NPM_PACKAGE, 'version'], { timeout: 20000 });
  if (v.code !== 0 || !v.stdout) return { ok: false, kind: 'npm', current: cur, error: `npm view ${NPM_PACKAGE} version failed: ${lastLine(v.stderr) || `exit ${v.code}`}` };
  const latest = lastLine(v.stdout);
  const cmd = `npm install -g ${NPM_PACKAGE}@${latest}`;
  const base = { ok: true, kind: 'npm', current: cur, latest, notes: [], manual: cmd };
  const c = cmpSemver(latest, cur);
  if (c !== null && c <= 0) return { ...base, upToDate: true, ahead: c < 0, count: 0 };
  let count = 1;
  const all = await d.run('npm', ['view', NPM_PACKAGE, 'versions', '--json'], { timeout: 20000 });
  try {
    const list = JSON.parse(all.stdout);
    const n = (Array.isArray(list) ? list : [list]).filter((x) => cmpSemver(x, cur) === 1 && cmpSemver(x, latest) <= 0).length;
    if (n > 0) count = n;
  } catch { /* keep 1 */ }
  return { ...base, upToDate: false, count, command: { cmd: 'npm', args: ['install', '-g', `${NPM_PACKAGE}@${latest}`], display: cmd } };
}

async function checkGit(info, d) {
  const { root, kind } = info;
  const f = await d.run('git', ['-C', root, 'fetch', 'origin', 'main', '--quiet'], { timeout: 30000 });
  if (f.code !== 0) return { ok: false, kind, error: `git -C ${root} fetch origin main failed: ${lastLine(f.stderr) || `exit ${f.code}`}` };
  const current = await gitOutA(d, root, ['rev-parse', '--short', 'HEAD']) || '?';
  const latest = await gitOutA(d, root, ['rev-parse', '--short', 'origin/main']) || '?';
  const count = Number(await gitOutA(d, root, ['rev-list', '--count', 'HEAD..origin/main']) || 0) || 0;
  const pull = `git -C ${root} pull --ff-only`;
  const shared = kind === 'shared-git';
  const manual = shared ? 'quox-cli-refresh' : pull;
  const base = { ok: true, kind, root, current, latest, count, manual };
  if (count === 0) return { ...base, upToDate: true, notes: [] };
  const notes = (await gitOutA(d, root, ['log', '--format=%s', '-n', String(NOTES_MAX), 'HEAD..origin/main']) || '').split('\n').filter(Boolean);
  if (shared) {
    return { ...base, upToDate: false, notes, scope: `This runs quox-cli-refresh, which updates quox for every session on this box (${root}).`, command: { cmd: info.refresh, args: [], display: 'quox-cli-refresh' } };
  }
  let refused = null;
  if (info.branch !== 'main') refused = `${root} is on branch ${info.branch || '(unknown)'}, not main. Switch to main yourself, then update again. Nothing was changed.`;
  else {
    const dirty = (await gitOutA(d, root, ['status', '--porcelain', '--untracked-files=no']) || '').split('\n').filter(Boolean);
    if (dirty.length) refused = `${root} has ${dirty.length} file${dirty.length === 1 ? '' : 's'} with uncommitted changes. Commit or move them, then update again. Nothing was changed.`;
  }
  return { ...base, upToDate: false, notes, refused, command: refused ? null : { cmd: 'git', args: ['-C', root, 'pull', '--ff-only'], display: pull } };
}

/**
 * What an update would do. -> { ok, kind, current, latest, count, notes[], upToDate, command?, manual, scope?, refused?, error? }
 * refused: this install has its own updater (or is not in a state to update): say why and the manual way.
 */
export async function checkUpdate(info, { deps = {} } = {}) {
  const d = withDeps(deps, asyncRun);
  switch (info?.kind) {
    case 'npm': return checkNpm(info, d);
    case 'git': case 'shared-git': return checkGit(info, d);
    case 'server': return { ok: true, kind: 'server', current: info.tag, manual: 'quox server update', refused: `This quox is part of your self-hosted Quox install (${info.tag} at ${info.root}), so it updates with the server: run quox server update (it shows the latest release and asks first).` };
    case 'bundle': return { ok: true, kind: 'bundle', manual: null, refused: `This quox is the dev-server bundle in ${info.root}; the Quox server refreshes it while dev mode is on. Ask your admin, or install your own copy with npm install -g ${NPM_PACKAGE}@latest.` };
    default: return { ok: true, kind: 'unknown', manual: `npm install -g ${NPM_PACKAGE}@latest`, refused: `Could not tell how this quox was installed (${info?.root || 'unknown path'}). To install the published one: npm install -g ${NPM_PACKAGE}@latest` };
  }
}

/** Run the update with the terminal handed over (prompts, sudo). -> { ok, code } or { ok:false, error } */
export function runUpdate(plan, { spawn = spawnSync, env = process.env } = {}) {
  const r = spawn(plan.command.cmd, plan.command.args, { stdio: 'inherit', env });
  if (r.error) return { ok: false, error: `${r.error.code || 'failed'}: ${r.error.message}` };
  const code = r.status ?? (r.signal ? 128 + (os.constants.signals[r.signal] || 0) : 1);
  return { ok: code === 0, code };
}

const isGit = (p) => p.kind === 'git' || p.kind === 'shared-git';

/** The lines shown before the ask (or the one line when there is nothing to do). */
export function updateLines(plan) {
  if (!plan.ok) return [`Could not check for updates: ${plan.error}`];
  if (plan.refused && plan.kind !== 'git') return [plan.refused];
  if (plan.upToDate) return [isGit(plan) ? `quox ${plan.current} is up to date with origin/main.` : plan.ahead ? `quox ${plan.current} is newer than the published ${plan.latest}. Nothing to update.` : `quox ${plan.current} is the latest.`];
  const out = [];
  const notes = plan.notes || [];
  if (notes.length) out.push(`What's new (${isGit(plan) ? 'commits on origin/main' : 'releases'}):`, ...notes.slice(0, NOTES_MAX).map((n) => `  · ${n}`));
  if (plan.count > notes.length && notes.length) out.push(`  · and ${plan.count - notes.length} more`);
  if (plan.kind === 'npm') out.push(`Runs: ${plan.command.display}. Release notes show after the restart (/whatsnew).`);
  if (plan.scope) out.push(plan.scope);
  if (plan.refused) out.push(`quox ${plan.current} -> ${plan.latest}: ${plan.count} change${plan.count === 1 ? '' : 's'}, not updated. ${plan.refused}`);
  return out;
}

/** "▶ quox <cur> -> <latest>: <n> changes. Update now and restart? y/N/c" (the shared ask shape). */
export function updateAsk(plan, { restart = true } = {}) {
  const n = plan.count;
  return askText(`Update now${restart ? ' and restart' : ''}?`, { reason: `quox ${plan.current} -> ${plan.latest}: ${n} change${n === 1 ? '' : 's'}.` });
}

/** `quox --update [...]` is `quox update [...]` when it comes before any subcommand. */
export function rewriteUpdateFlag(argv) {
  const VALUE = new Set(['-p', '--profile', '-o', '--output', '--org']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') return [...argv.slice(0, i), 'update', ...argv.slice(i + 1)];
    if (VALUE.has(a)) { i++; continue; }
    if (!a.startsWith('-')) return argv; // a subcommand came first: its own flags are its business
  }
  return argv;
}
