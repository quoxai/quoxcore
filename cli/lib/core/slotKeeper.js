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

import { decideWake, wakeText, draftLines, promptBoxState, isWakeLine, wakeQueued, WAKE_SETTLE_MS } from './slotWake.js';
import {
  openSync, closeSync, writeSync, readFileSync, unlinkSync, appendFileSync,
  statSync, writeFileSync, mkdirSync, chmodSync,
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
// #893: consecutive re-leases allowed without a good heartbeat in between.
export const MAX_REACQUIRES = 3;
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
// FORCE-WAKE: only a wake the server accepted from a human (an org admin via the CLI, or an allowlisted
// Discord user) carries this provenance; anything else keeps the old refusal at a draft.
const HUMAN_VIA = new Set(['cli', 'discord']);
export const FORCE_STEP_MS = 400; // between a key and the capture that checks it landed
export const FORCE_SUBMIT_WAIT_STEPS = 15; // ~6s for the wake line to leave the box before the draft goes back
// WAKE-REAL (owner 2026-10-17 "wake just pipes text to the prompt but doesnt wake anyone"): Claude Code drops an
// Enter that reaches it in the same read as the typed line (a loaded session reads both bursts as one paste), so
// the line sits in the box unsent. Proven live: QUOXON's 00:36:41 wake stayed unsent 3.5 min. The keeper lets
// the line land before Enter, then re-presses Enter only while the box still holds exactly its own line.
export const WAKE_LAND_STEPS = 10; // ~4s for the typed line to show in the box
export const WAKE_ENTER_TRIES = 4; // Enters sent at most (each only while the box holds only the wake line)
export const WAKE_ENTER_WAIT_STEPS = 6; // ~2.4s for the box to clear after each Enter

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
    // #893: optional. Re-lease after the hold LAPSED (expired, not taken over).
    // Must never take over; a refusal (409) means someone else holds it.
    reacquire = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    rand = Math.random,
    dir = keeperDir(),
    // Remote control (all optional; absent pollControl = heartbeat-only keeper).
    pollControl, ackControl, tmuxPane = null,
    execFile = defaultExecFile,
    // POKE-WAKE: the gap between the two pane samples a wake compares.
    settle = (ms) => new Promise((r) => setTimeout(r, ms)),
    // KEEPER-REEXEC: the installed build (null = unknown), how to start a successor on the new
    // build, and how to stop a keeper on an older one. All optional; absent = old behaviour.
    buildId = () => null,
    reexec = null,
    kill = (pid, sig) => process.kill(pid, sig),
    now = () => Date.now(),
    installSignals = (cleanup) => {
      const h = () => { cleanup(); process.exit(0); };
      process.once('SIGTERM', h);
      process.once('SIGINT', h);
    },
  } = opts;

  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `${name}.pid`);
  const buildPath = join(dir, `${name}.build`);
  const startBuild = buildId();
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
        // KEEPER-REEXEC: a keeper on an older (or unrecorded) build is replaced, so checkout always
        // leaves the slot kept by the installed code. SIGTERM drops only its lock: the hold is kept.
        const otherBuild = (() => { try { return readFileSync(buildPath, 'utf-8').trim() || null; } catch { return null; } })();
        if (startBuild && otherBuild !== startBuild && attempt === 0) {
          log(`replacing keeper pid ${other} (build ${otherBuild || 'unrecorded'}) with build ${startBuild}`);
          try { kill(other, 'SIGTERM'); } catch { /* already gone */ }
          for (let w = 0; w < 20 && probe.alive(other); w += 1) await settle(250);
          if (probe.alive(other)) {
            log(`keeper pid ${other} did not exit; leaving it`);
            return { code: 0, reason: 'already-running' };
          }
        } else {
          log(`another keeper (pid ${other}) already running; exiting`);
          return { code: 0, reason: 'already-running' };
        }
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
  if (startBuild) { try { writeFileSync(buildPath, startBuild); } catch { /* informational */ } }
  // KEEPER-REEXEC: checked on every control poll. Lock is removed BEFORE the successor starts so it
  // can take it; the hold is never released (the successor heartbeats the same slot).
  let reexecFailedFor = null;
  const staleBuild = () => {
    if (!startBuild || typeof reexec !== 'function') return false;
    const nowBuild = buildId();
    if (!nowBuild || nowBuild === startBuild) return false;
    if (reexecFailedFor === nowBuild) return false;
    log(`installed build ${startBuild} -> ${nowBuild}: re-exec`);
    cleanup();
    try { reexec(); } catch (e) {
      // No successor: take the lock back and keep heartbeating on the old code rather than drop the hold.
      reexecFailedFor = nowBuild;
      try { writeFileSync(lockPath, String(process.pid)); } catch { /* best effort */ }
      log(`re-exec failed (${e.message}); staying on build ${startBuild}`);
      return false;
    }
    return true;
  };

  try {
    log(`keeper started session=${session} claude=${claude?.pid}:${claude?.starttime}`);
    let fails = 0;
    let reacquires = 0;
    let delay = KEEP_INTERVAL_MS * (1 + rand() * 0.2);

    // Control queue state: ids already executed (never re-run if an ack failed,
    // only re-acked), and distinct failure accounting with tick-skip backoff.
    const handled = new Map();
    const received = new Set();
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
            if (!received.has(row.id)) { received.add(row.id); log(`control ${row.command} ${row.id} received from ${row.requested_via || '?'}`); }
            outcome = await runControlCommand(row);
            // POKE-WAKE: a wake on a busy pane stays pending server-side and is retried next tick.
            if (outcome === null) continue;
            handled.set(row.id, outcome);
            received.delete(row.id);
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
    // POKE-WAKE: wake an idle session so it reads its slot page now. Types ONE fixed line (wakeText),
    // literally (-l, no key-name parsing), only when the pane is still and the prompt box empty.
    const wakeSeen = new Map();
    const waitLogged = new Map();
    let lastWokeAt = null;
    const capture = async () => {
      try {
        // -e: escape-aware, so the faint empty-box placeholder is not mistaken for a draft (FORCE-WAKE).
        const out = await execFile('tmux', ['capture-pane', '-p', '-e', '-t', tmuxPane]);
        return typeof out === 'string' ? out : String(out?.stdout ?? '');
      } catch { return null; }
    };
    const runWake = async (row) => {
      if (!tmuxPane) return { status: 'failed', result: NO_TMUX_RESULT };
      // The 10m budget runs from the REQUEST (server created_at), not from this keeper's first sight of
      // it: a re-exec'd keeper continues the same budget, and an old request is not mistaken for a new one.
      if (!wakeSeen.has(row.id)) {
        const created = Date.parse(row.created_at || '');
        wakeSeen.set(row.id, Number.isFinite(created) && created <= now() ? created : now());
      }
      const before = await capture();
      await settle(WAKE_SETTLE_MS);
      const after = await capture();
      const force = HUMAN_VIA.has(row.requested_via);
      const d = decideWake({ slot: name, before, after, firstSeenAt: wakeSeen.get(row.id), nowMs: now(), lastWokeAt, force });
      if (d.action === 'wait') {
        if (waitLogged.get(row.id) !== d.reason) { waitLogged.set(row.id, d.reason); log(`wake ${row.id} waiting: ${d.reason} (retrying each poll for up to 10m)`); }
        return null;
      }
      wakeSeen.delete(row.id);
      waitLogged.delete(row.id);
      if (d.action === 'force') return forceWake(row, after);
      if (d.action !== 'type' && d.action !== 'submit') return { status: d.action === 'done' ? 'done' : 'failed', result: d.result };
      try {
        if (d.action === 'submit') log(`wake ${row.id}: an earlier wake line is still unsent in the box; submitting it`);
        const r = await submitWakeLine(row.id, { typed: d.action === 'submit' });
        if (!r.ok) return { status: 'failed', result: `not woken: ${r.why}; the page shows at its next prompt` };
        lastWokeAt = now();
        return { status: 'done', result: wokeResult(r) };
      } catch (err) {
        return { status: 'failed', result: `tmux send-keys failed: ${err.message}` };
      }
    };
    // WAKE-REAL: the two outcomes a waker is told apart: a turn started, or Claude Code queued the line mid-turn.
    const wokeResult = (r, extra = '') => (r.queued
      ? `queued in ${tmuxPane}${extra}: the session is mid-turn, so Claude Code holds the wake line and sends it when the turn ends; it reads slot ${name} then`
      : `woke ${tmuxPane}${extra}: the wake line was submitted and a turn started; it is reading slot ${name} now`);
    // WAKE-REAL: type the fixed line (unless it is already in the box), let it land, Enter, and verify it left the
    // box. Enter is re-pressed only while the box holds exactly this slot's wake line, so nothing else is ever sent.
    // -> { ok: true, queued } | { ok: false, why }
    const submitWakeLine = async (id, { typed = false, clearOnFail = true } = {}) => {
      if (!typed) {
        await keys('-l', wakeText(name));
        for (let k = 0; k < WAKE_LAND_STEPS; k += 1) {
          await settle(FORCE_STEP_MS);
          const b = draftLines(await capture());
          if (isWakeLine(b, name) || (Array.isArray(b) && b.length)) break;
        }
      }
      for (let t = 0; t < WAKE_ENTER_TRIES; t += 1) {
        const b = draftLines(await capture());
        if (Array.isArray(b) && b.length && !isWakeLine(b, name)) {
          log(`wake ${id}: the box holds something other than the wake line; no Enter sent`);
          return { ok: false, why: 'the prompt box changed while waking (someone is typing), so nothing was sent' };
        }
        if (t > 0 && !(Array.isArray(b) && b.length)) return { ok: true, queued: wakeQueued(await capture()) };
        await keys('Enter');
        if (t > 0) log(`wake ${id}: Enter was not taken; pressed it again (${t + 1} of ${WAKE_ENTER_TRIES})`);
        for (let k = 0; k < WAKE_ENTER_WAIT_STEPS; k += 1) {
          const screen = await capture();
          const after = draftLines(screen);
          if (Array.isArray(after) && !after.length) { log(`wake ${id}: wake line submitted (${t + 1} Enter${t ? 's' : ''})`); return { ok: true, queued: wakeQueued(screen) }; }
          if (!isWakeLine(after, name)) break;
          await settle(FORCE_STEP_MS);
        }
      }
      // Still ours in the box after every try: take it back out, so it never sits there as a fake draft (not on a
      // force: C-u would overwrite the kill ring that holds the human's draft; the next wake submits it instead).
      if (!clearOnFail) return { ok: false, why: `Claude Code did not take Enter (${WAKE_ENTER_TRIES} tries)` };
      for (let k = 0; k < 12 && isWakeLine(draftLines(await capture()), name); k += 1) { await keys('C-u'); await settle(FORCE_STEP_MS); }
      log(`wake ${id}: Claude Code did not take Enter after ${WAKE_ENTER_TRIES} tries; wake line cleared`);
      return { ok: false, why: `Claude Code did not take Enter (${WAKE_ENTER_TRIES} tries), so the wake line was cleared from the box` };
    };
    // FORCE-WAKE (owner 2026-10-16: "wake needs to wake"): a human wake at a draft sets the draft aside and
    // puts it back UNSENT. Proven live on Claude Code v2.1.288: C-u kills one visual line (consecutive kills
    // accumulate in its kill ring), the ring survives a submit, and C-y yanks it back. Every step is checked
    // by a capture; nothing of the user's is ever followed by Enter. The draft text never goes in the log;
    // a private copy sits in <slot>.draft until it is verified back in the box.
    const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join('\n') === b.join('\n');
    const tag = (lines) => `${lines.length} line(s), ${lines.join('\n').length} chars, sha ${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 8)}`;
    const keys = (...k) => execFile('tmux', ['send-keys', '-t', tmuxPane, ...k]);
    const forceWake = async (row, screen) => {
      const draft = draftLines(screen);
      const draftPath = join(dir, `${name}.draft`);
      const NOT = 'not woken: ';
      try {
        writeFileSync(draftPath, `${draft.join('\n')}\n`, { mode: 0o600 });
        chmodSync(draftPath, 0o600);
      } catch (e) {
        log(`force ${row.id}: could not save a safety copy of the draft (${e.message}); refusing`);
        return { status: 'failed', result: `${NOT}could not save a safety copy of the draft first, so it was left untouched; the page shows at its next prompt` };
      }
      log(`force ${row.id}: captured draft (${tag(draft)}); safety copy ${draftPath}`);
      // A human may be typing: the box must still hold exactly what was captured.
      if (!same(draftLines(await capture()), draft)) {
        log(`force ${row.id}: draft changed before clearing; refusing`);
        try { unlinkSync(draftPath); } catch { /* best effort */ }
        return { status: 'failed', result: `${NOT}the draft changed while setting it aside (someone is typing); left untouched` };
      }
      try {
        let box = draft;
        for (let k = 0; k < draft.length + 3 && box && box.length; k += 1) {
          await keys('C-u');
          await settle(FORCE_STEP_MS);
          box = draftLines(await capture());
        }
        if (!box || box.length) {
          log(`force ${row.id}: box did not clear (${box ? 'text left' : 'no box'}); yanking the draft back, nothing sent`);
          if (box && box.length) await keys('C-u'); // finish the kill run so the yank puts back the whole draft
          await keys('C-y');
          await settle(FORCE_STEP_MS);
          const back = same(draftLines(await capture()), draft);
          log(`force ${row.id}: draft ${back ? 'restored' : `NOT verified back; safety copy kept at ${draftPath}`}`);
          if (back) { try { unlinkSync(draftPath); } catch { /* best effort */ } }
          return { status: 'failed', result: `${NOT}could not clear the draft safely, so it was ${back ? 'put back as it was' : `left in place (a copy is saved at ${draftPath})`}; nothing was sent` };
        }
        log(`force ${row.id}: cleared the prompt box (${draft.length} C-u)`);
        const sub = await submitWakeLine(row.id, { clearOnFail: false });
        log(`force ${row.id}: typed wake line + Enter${sub.ok ? '' : ` (${sub.why})`}`);
        let st = sub.ok ? 'empty' : null;
        for (let k = 0; sub.ok && k < FORCE_SUBMIT_WAIT_STEPS && st !== 'empty'; k += 1) {
          await settle(FORCE_STEP_MS);
          st = promptBoxState(await capture());
        }
        if (st !== 'empty') {
          log(`force ${row.id}: box not free after the wake line (${st}); draft NOT restored, safety copy kept at ${draftPath}`);
          return { status: 'failed', result: `${NOT}the wake line did not leave the prompt box; your draft is saved at ${draftPath} on that host (in the box kill ring too: Ctrl+Y)` };
        }
        lastWokeAt = now();
        await keys('C-y');
        await settle(FORCE_STEP_MS);
        let back = draftLines(await capture());
        if (!same(back, draft) && Array.isArray(back) && !back.length && draft.length === 1) {
          log(`force ${row.id}: yank did not restore; typing the single-line draft back literally (no Enter)`);
          await keys('-l', draft[0]);
          await settle(FORCE_STEP_MS);
          back = draftLines(await capture());
        }
        if (!same(back, draft)) {
          log(`force ${row.id}: woke, but the draft is NOT verified back; safety copy kept at ${draftPath}`);
          return { status: 'done', result: `${wokeResult(sub)}; but its draft could not be verified back in the box, a copy is saved at ${draftPath} on that host` };
        }
        try { unlinkSync(draftPath); } catch { /* best effort */ }
        log(`force ${row.id}: restored draft (verified, not sent)`);
        return { status: 'done', result: wokeResult(sub, ' (its draft was set aside and put back unsent)') };
      } catch (err) {
        log(`force ${row.id}: tmux failed (${err.message}); safety copy kept at ${draftPath}`);
        return { status: 'failed', result: `tmux send-keys failed mid-wake: ${err.message}; the draft is saved at ${draftPath} on that host` };
      }
    };
    const runControlCommand = async (row) => {
      if (row.command === 'status') return { status: 'done', result: await statusResult() };
      if (row.command === 'wake') return runWake(row);
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
        if (staleBuild()) return { code: 0, reason: 'reexec' };
      }
      await sleep(remaining);
      if (pollControl) await controlTick();
      if (staleBuild()) return { code: 0, reason: 'reexec' };

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
        reacquires = 0;
        log('heartbeat ok');
        delay = KEEP_INTERVAL_MS * (1 + rand() * 0.2);
      } catch (err) {
        if (isHoldLost(err)) {
          // #893: a lease that merely EXPIRED (e.g. auth stalled past the TTL)
          // also answers 409. Try one non-takeover re-lease per lapse, at most
          // MAX_REACQUIRES in a row without a good heartbeat in between.
          if (reacquire && reacquires < MAX_REACQUIRES) {
            reacquires += 1;
            try {
              await reacquire();
              log(`hold lapsed (${err.status || ''} ${err.message}); re-acquired (${reacquires}/${MAX_REACQUIRES})`);
              fails = 0;
              delay = 0;
              continue;
            } catch (re) {
              log(`re-acquire refused: ${re.status || ''} ${re.message}`);
            }
          }
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
