/**
 * QUOXON-RESTART-LEAK: the conversation client's top-level launcher.
 *
 * Before this, /restart (and /update, /restart auto, a profile switch that restarts) ran the successor with
 * spawnSync from INSIDE the old client and waited for it. The old client froze but stayed resident with its
 * whole heap, so every restart nested one more TUI under the last: the owner's terminal reached 98 nested
 * clients and 15 GB RSS (dev-host-01, 2026-10-17).
 *
 * Now the first interactive `quox` on a terminal becomes this launcher: no React, no Ink, no api, no timers,
 * never touches stdin. It runs the client as its child and waits. A client that wants a restart writes a
 * handoff file (what to run, the one-shot env it carries) and exits with RESTART_EXIT_CODE; the launcher
 * reads it, deletes it, and runs the successor. Any other exit is passed straight through. So after any
 * number of restarts there is exactly one client process per terminal (plus this launcher).
 *
 * Tiny on purpose: it must import nothing heavy (bin/quox.js loads it before React, Ink or any command).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, constants as osConstants } from 'node:os';
import { join } from 'node:path';

/** The client asks its launcher for a restart with this exit code AND a handoff file (both, never one alone). */
export const RESTART_EXIT_CODE = 75;
/** Env var naming the handoff file. Read and DELETED by the client at startup, so nothing it spawns inherits it. */
export const LAUNCHER_HANDOFF_ENV = 'QUOX_LAUNCHER_HANDOFF';
/** QUOX_NO_LAUNCHER=1 turns the launcher off (the client then restarts the old, nested way). */
export const NO_LAUNCHER_ENV = 'QUOX_NO_LAUNCHER';

const ONE_SHOT = /^QUOX_RESTART_/; // carried into ONE successor only, never re-applied by the launcher

let handoff; // undefined = not read yet; null = not launched; { path, base } = launched
/**
 * Client side, once at startup: am I running under a launcher? Reads and deletes the env var (a shell or
 * `quox` the client spawns must never think it is the launched client). -> { path, base } | null.
 */
export function takeLauncherHandoff(env = process.env) {
  if (env === process.env && handoff !== undefined) return handoff;
  const path = env[LAUNCHER_HANDOFF_ENV] || null;
  delete env[LAUNCHER_HANDOFF_ENV];
  const r = path ? { path, base: { ...env } } : null; // base: the env as launched, to send only what a restart changes
  if (env === process.env) handoff = r;
  return r;
}
/** Test hook: forget the cached handoff. */
export function resetLauncherHandoff() { handoff = undefined; }

/** Should this invocation become the launcher? Only an interactive client on a real terminal, never a launched child. */
export function shouldLaunch({ argv = [], env = process.env, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (!isTTY || env[LAUNCHER_HANDOFF_ENV] || env[NO_LAUNCHER_ENV] === '1') return false;
  const head = argv.indexOf('--') === -1 ? argv : argv.slice(0, argv.indexOf('--'));
  return !head.some(a => a === '--print' || a.startsWith('--print=') || a === '-h' || a === '--help');
}

/**
 * Client side: hand a restart to the launcher. `plan` is { cmd, args, env } (restartPlan in slash/restart.js);
 * only the env entries that differ from the launched env are written (the launcher adds them to its own).
 * -> true when the handoff file was written (the caller then exits with RESTART_EXIT_CODE).
 */
export function writeRestartHandoff(h, plan, { write = writeFileSync } = {}) {
  if (!h?.path || !plan?.cmd) return false;
  const env = {};
  for (const [k, v] of Object.entries(plan.env || {})) if (v !== undefined && (ONE_SHOT.test(k) || h.base[k] !== v)) env[k] = v; // a one-shot always rides: the launcher strips them between runs
  try { write(h.path, JSON.stringify({ cmd: plan.cmd, args: plan.args || [], env }), { mode: 0o600 }); return true; }
  catch { return false; }
}

/**
 * Launcher side: run the client, and again each time it asks for a restart. Resolves with the exit code to
 * leave with. `deps` lets tests stand in for spawn and the handoff directory.
 */
export async function runLauncher({ argv = [], execPath = process.execPath, script = process.argv[1], env = process.env, deps = {}, onSpawn = null } = {}) {
  const d = { spawn, mkdtemp: () => mkdtempSync(join(tmpdir(), 'quox-launch-')), read: (p) => readFileSync(p, 'utf8'), rm: (p) => rmSync(p, { force: true, recursive: true }), signals: process, ...deps };
  let dir;
  try { dir = d.mkdtemp(); } catch { return null; } // no handoff dir: the caller runs the client in-process (old behaviour)
  const file = join(dir, 'restart.json');
  const carry = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !ONE_SHOT.test(k) && k !== LAUNCHER_HANDOFF_ENV)); // later runs never re-apply a one-shot
  let child = null;
  const forward = (sig) => () => { try { child?.kill(sig); } catch { /* gone */ } };
  const handlers = { SIGINT: () => {}, SIGQUIT: () => {}, SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') }; // ^C belongs to the client (same process group)
  for (const [s, f] of Object.entries(handlers)) d.signals.on(s, f);
  let next = { cmd: execPath, args: [script, ...argv], env: { ...env } }; // the first run keeps any one-shot it was started with
  try {
    for (;;) {
      d.rm(file);
      const r = await new Promise((done) => {
        try { child = d.spawn(next.cmd, next.args, { stdio: 'inherit', env: { ...next.env, [LAUNCHER_HANDOFF_ENV]: file } }); }
        catch (e) { done({ error: e }); return; }
        onSpawn?.(child);
        child.once('error', (e) => done({ error: e }));
        child.once('exit', (code, signal) => done({ code, signal }));
      });
      child = null;
      if (r.error) { process.stderr.write(`quox: could not start ${next.cmd} (${r.error.code || r.error.message})\n`); return 1; }
      let ask = null;
      if (r.code === RESTART_EXIT_CODE) { try { ask = JSON.parse(d.read(file)); } catch { ask = null; } }
      if (!ask?.cmd) return r.signal ? 128 + (osConstants.signals[r.signal] || 0) : (r.code ?? 1);
      next = { cmd: ask.cmd, args: Array.isArray(ask.args) ? ask.args : [], env: { ...carry(next.env), ...(ask.env || {}) } }; // the env the client was launched with, plus what its restart changed
    }
  } finally {
    for (const [s, f] of Object.entries(handlers)) d.signals.off(s, f);
    d.rm(dir);
  }
}
