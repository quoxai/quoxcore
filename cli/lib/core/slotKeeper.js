/**
 * Slot hold keeper (SLOTS-PERFECT, quox#662/B).
 *
 * Why: the collector frees a held slot 15 minutes after its last heartbeat,
 * and the only thing heartbeating was a `quox slot wait` the session had to
 * remember to re-arm. A session that forgot lost its hold silently. The
 * keeper is a detached background loop, spawned by `slot checkout`, that
 * heartbeats on a timer and dies with the Claude session it serves.
 *
 * Loop hygiene (house rule): failures are counted distinctly from successes,
 * back off exponentially (30s doubling, cap 5 min) and the keeper retires
 * after a bounded run of consecutive failures (24; 3 for 401). Everything
 * environmental (clock, sleep, probe, signals, fs dir) is injected.
 */

import {
  openSync, closeSync, writeSync, readFileSync, unlinkSync, appendFileSync,
  statSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { QuoxApiError } from './errors.js';

export const KEEP_INTERVAL_MS = 5 * 60 * 1000;
export const BACKOFF_BASE_MS = 30 * 1000;
export const BACKOFF_CAP_MS = 5 * 60 * 1000;
// 24 consecutive failures at the 5-min backoff cap rides out ~2h of
// collector/auth outage; each failure is one cheap HTTP call, so outlasting a
// long outage beats letting the hold lapse (the collector revives a stale
// slot for its own holder on the next successful heartbeat).
export const MAX_FAILS = 24;
export const MAX_AUTH_FAILS = 3;
export const LOG_MAX_BYTES = 256 * 1024;
// QUOX-CLAUDE-3: the control queue is polled far more often than the 5-min
// heartbeat so `!compact` feels immediate. Poll failures back off (doubling,
// capped at CONTROL_BACKOFF_CAP_TICKS skipped ticks) and are counted
// distinctly from heartbeat failures; they never retire the keeper (the
// heartbeat owns hold-loss).
export const CONTROL_POLL_MS = 20 * 1000;
export const CONTROL_BACKOFF_CAP_TICKS = 15;
export const BUSY_WINDOW_MS = 60 * 1000;
export const NO_TMUX_RESULT = 'session not under tmux; start it with quox claude';

export function keeperDir() {
  return join(homedir(), '.quox', 'keepers');
}

/** Real process probe: liveness via kill -0, start ticks via /proc. */
export function makeProcessProbe(procStartTime) {
  return {
    alive(pid) {
      try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
    },
    starttime: procStartTime,
  };
}

/** Is `pid` the same process it was (alive, and start ticks unchanged)? */
export function sameProcess(probe, pid, starttime) {
  if (!pid || !probe.alive(pid)) return false;
  return starttime == null || String(probe.starttime(pid)) === String(starttime);
}

function isHoldLost(err) {
  if (!(err instanceof QuoxApiError)) return false;
  // 409: held by someone else or freed. 404: the slot itself is gone.
  if (err.status === 409 || err.status === 404) return true;
  const said = [err.message, err.code, err.body?.error].filter(Boolean).join(' ');
  return err.status === 403 && /not (the current |slot )?holder/i.test(said);
}

const execFileP = promisify(execFileCb);
function defaultExecFile(file, args) {
  return execFileP(file, args, { timeout: 10000 });
}

export async function runKeeper(opts) {
  const {
    name, session, claude, heartbeat, release, forget, probe,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    rand = Math.random,
    dir = keeperDir(),
    // Remote control (all optional; absent pollControl = heartbeat-only keeper).
    pollControl, ackControl, tmuxPane = null,
    execFile = defaultExecFile,
    now = () => Date.now(),
    installSignals = (cleanup) => {
      const h = () => { cleanup(); process.exit(0); };
      process.once('SIGTERM', h);
      process.once('SIGINT', h);
    },
  } = opts;

  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `${name}.pid`);
  const logPath = join(dir, `${name}.log`);
  const log = (msg) => {
    try {
      let size = 0;
      try { size = statSync(logPath).size; } catch { /* no log yet */ }
      if (size > LOG_MAX_BYTES) writeFileSync(logPath, '');
      appendFileSync(logPath, `${new Date().toISOString()} [${name}] ${msg}\n`);
    } catch { /* logging must never kill the keeper */ }
  };

  // Single instance per slot: O_EXCL lockfile, taken over when its pid is dead.
  let locked = false;
  for (let attempt = 0; attempt < 2 && !locked; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      locked = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let other = NaN;
      try { other = parseInt(readFileSync(lockPath, 'utf-8'), 10); } catch { /* raced away */ }
      if (Number.isFinite(other) && other !== process.pid && probe.alive(other)) {
        log(`another keeper (pid ${other}) already running; exiting`);
        return { code: 0, reason: 'already-running' };
      }
      try { unlinkSync(lockPath); } catch { /* raced away */ }
    }
  }
  if (!locked) {
    log('could not acquire keeper lock; exiting');
    return { code: 1, reason: 'lock-failed' };
  }

  const cleanup = () => {
    try {
      if (parseInt(readFileSync(lockPath, 'utf-8'), 10) === process.pid) unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
  installSignals(cleanup);

  try {
    log(`keeper started session=${session} claude=${claude?.pid}:${claude?.starttime}`);
    let fails = 0;
    let delay = KEEP_INTERVAL_MS * (1 + rand() * 0.2);

    // Control queue state: ids already executed (never re-run if an ack failed,
    // only re-acked), and distinct failure accounting with tick-skip backoff.
    const handled = new Map();
    const startedAt = now();
    let lastHeartbeatAt = null;
    // Busy/idle: only a hash of the pane is kept (pane text can hold secrets
    // and the status result is posted to Discord). Armed by the first status
    // request, then refreshed on every control tick.
    let armed = false;
    let paneHash = null;
    let paneChangedAt = null;
    const samplePane = async () => {
      if (!tmuxPane) return false;
      try {
        const out = await execFile('tmux', ['capture-pane', '-p', '-t', tmuxPane]);
        const text = typeof out === 'string' ? out : String(out?.stdout ?? '');
        const h = createHash('sha256').update(text).digest('hex');
        if (paneHash !== null && h !== paneHash) paneChangedAt = now();
        paneHash = h;
        return true;
      } catch { return false; }
    };
    let ctlFails = 0;
    let ctlSkip = 0;
    const controlTick = async () => {
      if (ctlSkip > 0) { ctlSkip -= 1; return; }
      if (claude && !sameProcess(probe, claude.pid, claude.starttime)) return;
      try {
        if (armed) await samplePane();
        const rows = (await pollControl()) || [];
        for (const row of rows) {
          let outcome = handled.get(row.id);
          if (!outcome) {
            outcome = await runControlCommand(row);
            handled.set(row.id, outcome);
            log(`control ${row.command} ${row.id} from ${row.requested_via || '?'}: ${outcome.status} (${outcome.result})`);
          }
          await ackControl(row.id, outcome.status, outcome.result);
          handled.delete(row.id);
        }
        if (ctlFails > 0) log(`control poll recovered after ${ctlFails} failure(s)`);
        ctlFails = 0;
      } catch (err) {
        ctlFails += 1;
        ctlSkip = Math.min(2 ** (ctlFails - 1) - 1, CONTROL_BACKOFF_CAP_TICKS);
        log(`control poll FAILED (${ctlFails} consecutive, skipping ${ctlSkip} tick(s)): ${err.status || ''} ${err.message}`);
      }
    };
    const fmtDur = (sec) => {
      const s = Math.max(0, Math.floor(sec));
      const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
      return d ? `${d}d${String(h).padStart(2, '0')}h` : `${h}h${String(m).padStart(2, '0')}m`;
    };
    const statusResult = async () => {
      const parts = [`session=${session}`, `slot=${name}`];
      let claudeUp = null;
      if (claude) {
        const alive = sameProcess(probe, claude.pid, claude.starttime);
        if (alive) {
          try {
            const out = await execFile('ps', ['-o', 'etimes=', '-p', String(claude.pid)]);
            const n = parseInt(String(typeof out === 'string' ? out : out?.stdout).trim(), 10);
            if (Number.isFinite(n)) claudeUp = n;
          } catch { /* uptime unknown */ }
        }
        parts.push(`claude pid ${claude.pid} ${alive ? 'alive' : 'gone'}${alive && claudeUp != null ? ` up ${fmtDur(claudeUp)}` : ''}`);
      }
      if (!tmuxPane) {
        parts.push('not under tmux');
      } else {
        parts.push(`pane=${tmuxPane}`);
        const wasArmed = armed;
        armed = true;
        const ok = await samplePane();
        if (ok) {
          if (!wasArmed) parts.push('activity unknown (first check)');
          else parts.push(paneChangedAt !== null && now() - paneChangedAt <= BUSY_WINDOW_MS ? 'busy' : 'idle');
        }
      }
      parts.push(lastHeartbeatAt === null ? 'last heartbeat none yet' : `last heartbeat ${new Date(lastHeartbeatAt).toISOString()}`);
      parts.push(`keeper up ${fmtDur((now() - startedAt) / 1000)}`);
      return parts.join(', ').slice(0, 500);
    };
    const runControlCommand = async (row) => {
      if (row.command === 'status') return { status: 'done', result: await statusResult() };
      if (row.command !== 'compact') return { status: 'failed', result: `unsupported command ${row.command}` };
      if (!tmuxPane) return { status: 'failed', result: NO_TMUX_RESULT };
      try {
        await execFile('tmux', ['send-keys', '-t', tmuxPane, '/compact', 'Enter']);
        return { status: 'done', result: `sent /compact to ${tmuxPane}` };
      } catch (err) {
        return { status: 'failed', result: `tmux send-keys failed: ${err.message}` };
      }
    };

    for (;;) {
      let remaining = delay;
      while (pollControl && remaining > CONTROL_POLL_MS) {
        await sleep(CONTROL_POLL_MS);
        remaining -= CONTROL_POLL_MS;
        await controlTick();
      }
      await sleep(remaining);
      if (pollControl) await controlTick();

      if (claude && !sameProcess(probe, claude.pid, claude.starttime)) {
        log(`claude session gone (pid ${claude.pid}); releasing ${name} and exiting`);
        try { await release(); } catch (e) { log(`release failed: ${e.message}`); }
        return { code: 0, reason: 'session-gone' };
      }

      try {
        await heartbeat();
        lastHeartbeatAt = now();
        if (fails > 0) log(`heartbeat recovered after ${fails} failure(s)`);
        fails = 0;
        log('heartbeat ok');
        delay = KEEP_INTERVAL_MS * (1 + rand() * 0.2);
      } catch (err) {
        if (isHoldLost(err)) {
          log(`HOLD LOST: ${name} is no longer held by ${session}; keeper exiting`);
          try { forget(); } catch { /* best effort */ }
          return { code: 0, reason: 'hold-lost' };
        }
        fails += 1;
        const limit = err instanceof QuoxApiError && err.status === 401 ? MAX_AUTH_FAILS : MAX_FAILS;
        log(`heartbeat FAILED (${fails}/${limit}): ${err.status || ''} ${err.message}`);
        if (fails >= limit) {
          log(`RETIRED after ${fails} consecutive failures; hold will lapse`);
          return { code: 1, reason: 'retired' };
        }
        delay = Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_CAP_MS);
      }
    }
  } finally {
    cleanup();
  }
}
