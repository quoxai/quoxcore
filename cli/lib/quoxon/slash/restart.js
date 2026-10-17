/**
 * /restart and the "newer build installed" notice.
 *
 * The installed quox is whatever `quox` on PATH runs: a symlink to cli/bin/quox.js, or a small wrapper
 * script that execs one (the dev box's ~/bin/quox). Its build is the git HEAD of that CLI tree, read
 * locally (no fetch, no network). The running build is that HEAD captured when this client started, so a
 * refresh of the tree under a running client shows up as "newer installed".
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

/** The CLI tree this code runs from (…/cli). */
export const RUNNING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NEWER_NOTICE = 'A newer quox is installed. /restart to use it.';
export const DIFFERENT_NOTICE = 'A different quox build is installed. /restart to use it.';

export function findOnPath(name = 'quox', env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const isCliRoot = (d) => existsSync(join(d, 'lib', 'core', 'version.js')) && existsSync(join(d, 'bin', 'quox.js'));

/** The CLI root a `quox` executable runs, or null. */
export function cliRootOf(bin) {
  if (!bin) return null;
  let real;
  try { real = realpathSync(bin); } catch { return null; }
  if (/[/\\]bin[/\\]quox(\.js)?$/.test(real)) { const d = resolve(dirname(real), '..'); if (isCliRoot(d)) return d; }
  try {
    if (statSync(real).size > 65536) return null;
    const m = /(\/[^\s"'$]+)\/bin\/quox\.js/.exec(readFileSync(real, 'utf8'));
    if (m && isCliRoot(m[1])) return m[1];
  } catch { /* unreadable */ }
  return null;
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
export function headOf(root) { try { return root ? git(root, ['rev-parse', '--short', 'HEAD']) || null : null; } catch { return null; } }
/** true / false, or null when it cannot be told. */
export function isAncestor(root, a, b) {
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore', timeout: 2000 }); return true; }
  catch (e) { return e?.status === 1 ? false : null; }
}

/**
 * Compare the running build with the installed one. -> notice text or null. `deps` lets tests stand in for
 * git and PATH.
 */
export function newerBuild({ startSha, runningRoot = RUNNING_ROOT, env = process.env, deps = {} } = {}) {
  const d = { findOnPath, cliRootOf, headOf, isAncestor, ...deps };
  if (!startSha) return null;
  const root = d.cliRootOf(d.findOnPath('quox', env)) || runningRoot;
  const head = d.headOf(root);
  if (!head || head === startSha || head.startsWith(startSha) || startSha.startsWith(head)) return null;
  if (d.isAncestor(root, startSha, head) === true) return NEWER_NOTICE;
  if (d.isAncestor(root, head, startSha) === true) return null; // the installed build is older than this one: nothing to gain
  return DIFFERENT_NOTICE; // unrelated or unknown history: say so, never claim "newer
}

/** Poll at most every `everyMs`; calls onNotice once. -> stop(). */
export function startBuildWatch({ onNotice, everyMs = 60000, check = newerBuild, ...opts } = {}) {
  let said = false;
  const id = setInterval(() => {
    if (said) return;
    let t = null;
    try { t = check(opts); } catch { t = null; }
    if (t) { said = true; onNotice(t); clearInterval(id); }
  }, everyMs);
  id.unref?.();
  return () => clearInterval(id);
}

/**
 * Same arguments, minus any earlier resume target, plus --resume <id> for this conversation. The profile and
 * session name this client is using are carried over when the original command line did not name them.
 */
export function restartArgs(argv = [], conversationId = null, { profile = null, name = null } = {}) {
  const out = [];
  const pin = Boolean(profile) && !argv.includes('--demo'); // the profile the session RESOLVED wins over whatever argv said
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (pin && (a === '-p' || a === '--profile')) { const n = argv[i + 1]; if (n !== undefined && !n.startsWith('-')) i++; continue; }
    if (pin && a.startsWith('--profile=')) continue;
    if (a === '--conversation') { i++; continue; }
    if (a === '--resume') { const n = argv[i + 1]; if (n !== undefined && !n.startsWith('-')) i++; continue; }
    if (/^--(resume|conversation)=/.test(a)) continue;
    out.push(a);
  }
  const has = (...f) => out.some(a => f.includes(a) || f.some(x => a.startsWith(`${x}=`)));
  if (pin) out.push('-p', profile);
  if (name && !has('-n', '--name')) out.push('-n', name);
  return conversationId ? [...out, '--resume', conversationId] : out;
}

/** The quox a restart would run: the one on PATH, else this client's own tree. -> [command, leading args]. */
export function restartTarget(env = process.env, bin = findOnPath('quox', env)) {
  return bin ? [bin, []] : [process.execPath, [join(RUNNING_ROOT, 'bin', 'quox.js')]];
}

/**
 * Before the client lets go of the terminal: can the installed quox start at all? Runs `quox --version`
 * (no network, no login). -> Promise<{ ok, bin (what runs), onPath (the PATH quox or null), version?, error? }>. A failure keeps the user in this client.
 */
export function checkRestart({ env = process.env, bin = findOnPath('quox', env), run = execFile, timeoutMs = 15000 } = {}) {
  const [cmd, lead] = restartTarget(env, bin);
  return new Promise((done) => {
    run(cmd, [...lead, '--version'], { env, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const why = err.code === 'ENOENT' || err.code === 'EACCES' ? `${err.code}: it cannot be run`
          : err.killed ? `no answer in ${Math.round(timeoutMs / 1000)} s`
            : String(stderr || err.message || 'failed').trim().split('\n')[0].slice(0, 160);
        return done({ ok: false, bin: cmd, onPath: bin || null, error: why });
      }
      done({ ok: true, bin: cmd, onPath: bin || null, version: String(stdout || '').trim().split('\n')[0] || null });
    });
  });
}

/** Terminal modes the client turns on (bracketed paste, focus reporting, hidden cursor): all off before the hand-over. */
export const TERMINAL_RESTORE = '\x1b[?2004l\x1b[?1004l\x1b[?25h';

/** Give the terminal back in a plain state: cooked mode, stdin paused, modes off. */
export function restoreTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  try { if (stdin?.isTTY) stdin.setRawMode?.(false); stdin?.pause?.(); } catch { /* not a tty */ }
  try { if (stdout?.isTTY) stdout.write(TERMINAL_RESTORE); } catch { /* closed */ }
}

// REL-423 (from main, fe50e4000): restartPlan carries these one-shot hand-over vars when a caller passes them.
// 4.2.x main.js does not pass slot/attach/org/mode, so they stay unset here; the launcher treats QUOX_RESTART_* as one-shots.
export const RESTART_SLOT_ENV = 'QUOX_RESTART_SLOT';
export const RESTART_ATTACH_ENV = 'QUOX_RESTART_ATTACH';
export const RESTART_ORG_ENV = 'QUOX_RESTART_ORG';
export const RESTART_MODE_ENV = 'QUOX_RESTART_MODE';

/**
 * What a restart runs: { cmd, args, env }. The installed quox (or this tree), the same arguments with --resume
 * for this conversation, and the one-shot hand-over env (held slot, attach, org, plan mode) for the successor.
 */
export function restartPlan({ argv, conversationId, profile = null, name = null, slot = null, attach = null, org = null, mode = null, env = process.env, bin = findOnPath('quox', env) }) {
  const args = restartArgs(argv, conversationId, { profile, name });
  let childEnv = profile && !argv.includes('--demo') ? { ...env, QUOX_PROFILE: profile } : env; // belt and braces: same profile even if -p were lost
  if (slot) childEnv = { ...childEnv, [RESTART_SLOT_ENV]: slot }; // the held slot rides along; the new client takes it over before this one is gone
  if (attach) childEnv = { ...childEnv, [RESTART_ATTACH_ENV]: attach }; // so does the attached agent or slot
  if (org) childEnv = { ...childEnv, [RESTART_ORG_ENV]: org }; // and the window's org (never the profile's file)
  if (mode === 'plan') childEnv = { ...childEnv, [RESTART_MODE_ENV]: 'plan' }; // and the window's /mode (never the profile)
  const [cmd, lead] = restartTarget(env, bin);
  return { cmd, args: [...lead, ...args], env: childEnv };
}

/**
 * Run the installed quox in this terminal, wait for it, and hand back { code } (its exit code), or
 * { error } when it could not be started (the caller stays in the current client and says so).
 * Only used when there is no launcher (QUOX_NO_LAUNCHER=1, or no handoff dir): it NESTS the successor under
 * this process, which stays resident until the successor exits. The launcher path (launcher.js) does not.
 */
export function execRestart({ argv, conversationId, profile = null, name = null, slot = null, attach = null, org = null, mode = null, env = process.env, spawn = spawnSync, bin = findOnPath('quox', env), restore = restoreTerminal }) {
  const plan = restartPlan({ argv, conversationId, profile, name, slot, attach, org, mode, env, bin });
  restore(); // the child owns the terminal now
  const r = spawn(plan.cmd, plan.args, { stdio: 'inherit', env: plan.env });
  if (r.error) return { error: `${r.error.code || 'failed'}: ${r.error.message}`, bin: plan.cmd };
  return { code: r.status ?? (r.signal ? 128 + (os.constants.signals[r.signal] || 0) : 1), bin: plan.cmd };
}
