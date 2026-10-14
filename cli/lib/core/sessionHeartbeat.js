/**
 * QUOXON J1: the `quox claude` wrapper's session heartbeat. The wrapper starts
 * ONE detached `quox sessions heartbeat <tmux-session> --loop` per tmux session
 * it launches; that child beats POST /api/v1/sessions/heartbeat every interval
 * while the tmux session exists, then calls /api/v1/sessions/end and exits.
 * The server expires a row after 3 missed beats, so a killed child or a
 * powered-off box drops out on its own.
 *
 * Loop hygiene (house rule: failure accounting, backoff, retirement):
 *  - a failed beat is counted and logged, never treated as success;
 *  - consecutive failures back off exponentially, capped at maxBackoffS;
 *  - the loop retires after maxFailures consecutive failures, when the tmux
 *    session ends, or when it never appears within the start grace;
 *  - a pidfile lock keeps one heartbeat per session across reattaches, and is
 *    released on every exit path.
 * Pure parts take injected tmux output / held slots / attach lookup.
 */
import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, appendFileSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slotsBySession, readAttachSafe, readHeldSlotsSafe } from './liveSessionsReport.js';

export const PROBE_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_pid}\t#{pane_current_command}';
export const DEFAULT_INTERVAL_S = 60;
const HB_DIR = () => join(homedir(), '.quox', 'heartbeat');
const LOG_CAP_BYTES = 256 * 1024;

const isoSec = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** One line of PROBE_FORMAT output -> probe record, or null. */
export function parseProbe(out) {
  const first = String(out || '').split('\n').find((l) => l.trim());
  if (!first) return null;
  const c = first.split('\t');
  if (c.length < 6 || !c[0]) return null;
  const pid = Number.parseInt(c[4], 10);
  return {
    name: c[0],
    started_at: isoSec(c[1]),
    attached: Number(c[2]) > 0,
    last_active: isoSec(c[3]),
    pid: Number.isInteger(pid) ? pid : null,
    command: c[5] || null,
  };
}

/** The wrapped tmux session's bare name, as the held-slots ledger records it. */
const bareOf = (name) => String(name).replace(/^quox-/, '');

export function buildBeat({ probe, backend = null, agent = null, slot = null, held = {}, attachLookup = readAttachSafe, intervalS = DEFAULT_INTERVAL_S }) {
  const by = slotsBySession(held);
  const bare = bareOf(probe.name);
  const hit = by[probe.name] || by[bare] || by[bare.replace(/^(codex-|gemini-|tui-)/, '')] || null;
  // The pane runs claude directly, so its pid IS the attach-kit pid; the slot entry's pid is the fallback.
  const att = (probe.pid != null && attachLookup(probe.pid)) || (hit && hit.pid != null && attachLookup(hit.pid)) || null;
  return {
    name: probe.name,
    program: backend || probe.command || null,
    pid: probe.pid,
    started_at: probe.started_at,
    last_active: probe.last_active,
    attached: probe.attached,
    slot: (hit && hit.slot) || slot || null,
    agent: (att && att.agent) || agent || null,
    interval_s: intervalS,
  };
}

/** Live probe of one tmux session (exact match). null when it does not exist. */
export function probeTmux(name, spawnSync = realSpawnSync) {
  const r = spawnSync('tmux', ['display-message', '-p', '-t', `=${name}`, PROBE_FORMAT], { encoding: 'utf8' });
  if (!r || r.error || r.status !== 0) return null;
  const p = parseProbe(r.stdout);
  return p && p.name === name ? p : null;
}

export async function runHeartbeatLoop({
  tmuxName, backend = null, agent = null, slot = null, intervalS = DEFAULT_INTERVAL_S,
  probe = (n) => probeTmux(n), post, end, held = () => readHeldSlotsSafe(), attachLookup = readAttachSafe,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
  maxFailures = 30, maxBackoffS = 600, graceMs = 30_000, gracePollMs = 2000, maxTicks = Infinity,
  lock = { acquire: () => true, release: () => {} },
}) {
  if (!lock.acquire()) {
    log(`another heartbeat already holds ${tmuxName}; exiting`);
    return { exit: 'duplicate', beats: 0, failures: 0 };
  }
  let beats = 0;
  let failures = 0;
  let consecutive = 0;
  let ticks = 0;
  let seen = false;
  let waited = 0;
  try {
    while (ticks < maxTicks) {
      const p = probe(tmuxName);
      if (!p) {
        if (!seen && waited < graceMs) { waited += gracePollMs; await sleep(gracePollMs); continue; }
        if (!seen) { log(`${tmuxName} never appeared; exiting`); return { exit: 'never_started', beats, failures }; }
        try { await end(); } catch (e) { log(`end failed: ${e && e.status ? `HTTP ${e.status} ` : ''}${e && e.message}`); }
        log(`${tmuxName} ended after ${beats} beats (${failures} failed)`);
        return { exit: 'ended', beats, failures };
      }
      seen = true;
      ticks += 1;
      let beat;
      try { beat = buildBeat({ probe: p, backend, agent, slot, held: held(), attachLookup, intervalS }); } catch (e) { beat = null; log(`beat build failed: ${e.message}`); }
      try {
        if (!beat) throw new Error('no beat');
        await post(beat);
        beats += 1;
        consecutive = 0;
      } catch (e) {
        failures += 1;
        consecutive += 1;
        log(`beat failed (${consecutive} in a row, ${failures} total): ${e && e.status ? `HTTP ${e.status} ` : ''}${e && e.message}`);
        if (consecutive >= maxFailures) {
          log(`retiring after ${consecutive} consecutive failures`);
          return { exit: 'retired', beats, failures };
        }
      }
      const delayS = consecutive ? Math.min(intervalS * 2 ** Math.min(consecutive, 10), maxBackoffS) : intervalS;
      await sleep(delayS * 1000);
    }
    return { exit: 'max_ticks', beats, failures };
  } finally {
    lock.release();
  }
}

const safeFile = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '_');

/** Pidfile lock under ~/.quox/heartbeat/<session>.pid; a dead holder's file is taken over. */
export function pidLock(name, { dir = HB_DIR(), pid = process.pid, alive = isAlive } = {}) {
  const file = join(dir, `${safeFile(name)}.pid`);
  return {
    acquire() {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (existsSync(file)) {
          const other = Number.parseInt(readFileSync(file, 'utf8'), 10);
          if (Number.isInteger(other) && other !== pid && alive(other)) return false;
        }
        writeFileSync(file, String(pid), { mode: 0o600 });
        return true;
      } catch { return false; }
    },
    release() {
      try {
        if (existsSync(file) && Number.parseInt(readFileSync(file, 'utf8'), 10) === pid) unlinkSync(file);
      } catch { /* best effort */ }
    },
  };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Append-only per-session log, truncated when it passes LOG_CAP_BYTES. */
export function fileLogger(name, dir = HB_DIR()) {
  const file = join(dir, `${safeFile(name)}.log`);
  return (msg) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > LOG_CAP_BYTES) truncateSync(file, 0);
      appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
    } catch { /* logging must never kill the loop */ }
  };
}

/**
 * Start the detached heartbeat child for a tmux session the wrapper launched.
 * The child is this same quox binary; it survives the wrapper exiting on detach.
 */
export function startHeartbeat({ tmuxSession, backend, agent, slot }, { spawn = realSpawn, argv = process.argv, execPath = process.execPath } = {}) {
  if (!argv[1]) return false;
  const args = [argv[1], 'sessions', 'heartbeat', tmuxSession, '--loop'];
  if (backend) args.push('--backend', backend);
  if (agent) args.push('--agent', agent);
  if (slot) args.push('--slot', slot);
  try {
    const child = spawn(execPath, args, { detached: true, stdio: 'ignore' });
    if (child && child.on) child.on('error', () => {});
    if (child && child.unref) child.unref();
    return true;
  } catch { return false; }
}
