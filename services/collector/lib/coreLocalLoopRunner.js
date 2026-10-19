'use strict';

/**
 * coreLocalLoopRunner.js — QLoop CORE-LOCAL execution (QuoxPlan note #2873).
 *
 * QLoop is core, but a loop could only run on a governed FLEET host; a core
 * customer with no dev server hit an honest error and a dead end. This
 * runner executes the structured loop INSIDE the collector container (which
 * carries authenticated `claude` and `codex` CLIs), replacing only the
 * delivery leg of the spawn seam:
 *
 *   fleet:      collector -> Bastion -> quoxagent -> claude -p (stream-json)
 *               -> agent EventForwarder -> POST /:id/events
 *   core-local: collector -> child claude -p (stream-json)
 *               -> THIS runner -> POST /:id/events (self-fetch)
 *
 * The event leg deliberately goes back through the collector's OWN ingest
 * route with the session's real ingest token, exactly like the remote
 * agent: witnessing, WARD, VOLT and AOCL behave identically for both
 * backends because they run on the same code path. No parallel evidence
 * plumbing (the quoxplan-proxy precedent: the governed route is the only
 * place mutations are witnessed).
 *
 * "A halt with real teeth" (the headline claim this must honour as
 * convincingly as the fleet kill): kill() SIGTERMs the child and escalates
 * to SIGKILL after ESCALATE_MS if it is still alive. The registry maps both
 * the session ref and the agent-session id to the child, so the existing
 * /interrupt route reaches it with either handle.
 *
 * SECRET HYGIENE: the child gets a MINIMAL environment (PATH, HOME, TERM).
 * The collector's env carries INTERNAL_SERVICE_KEY and friends; a loop
 * child must never inherit them — the fleet child never had them, and
 * core-local must not be the weaker sibling.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ESCALATE_MS = 5000;
const BATCH_MAX_EVENTS = 20;
const BATCH_MAX_MS = 1000;

// Per-backend argv, fleet-identical (structured.go structuredBaseArgs) with
// ONE core-local divergence: codex gets --skip-git-repo-check because the
// core-local workdir is a fresh /tmp dir, never a git repo, and codex
// hard-refuses untrusted non-repo cwds before reading stdin (hit live
// 2026-08-20). Fleet loops run in the host checkout (a repo), so the
// fleet argv needs no flag.
// The collector is CJS and a separate container from services/tasks, so it
// cannot import tasks/lib/loopProviders.js; this table is its CLI-kind mirror.
// API-kind providers (openai) are deliberately absent: they get their own
// runner alongside this one, never a child process.
const CLI_BACKENDS = {
  claude: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
  codex: ['exec', '--json', '--skip-git-repo-check', '-'],
};

function argsForBackend(backend) {
  return Object.prototype.hasOwnProperty.call(CLI_BACKENDS, backend) ? CLI_BACKENDS[backend].slice() : null;
}

// The CLIs authenticate via files under $HOME (.claude/.credentials.json,
// .codex). The collector's pid-1 env often has NO HOME at all (found live:
// the fallback sent the child to /root and the loop answered "Not logged
// in" while /home/quox held valid credentials), so with HOME unset the
// candidates are PROBED for actual credentials before falling back.
function minimalChildEnv(base = process.env, io = { existsSync: fs.existsSync, homedir: os.homedir }) {
  let home = base.HOME;
  if (!home) {
    const candidates = [io.homedir(), '/home/quox', '/root'];
    home = candidates.find((c) => c && (
      io.existsSync(path.join(c, '.claude', '.credentials.json'))
      || io.existsSync(path.join(c, '.claude.json'))
      || io.existsSync(path.join(c, '.codex'))
    )) || io.homedir() || '/root';
  }
  return {
    PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TERM: 'dumb',
  };
}

// Live children by BOTH sessionRef and agentSessionId.
const registry = new Map();

function isAvailable(backend) {
  return Object.prototype.hasOwnProperty.call(CLI_BACKENDS, backend);
}

/**
 * Start a core-local structured loop. Returns { agentSessionId } once the
 * child has spawned (events flow asynchronously). Throws on spawn failure.
 */
function startCoreLocalLoop({
  sessionRef,
  ingestToken,
  backend,
  payload = '',
  args = [],
  maxDurationMs = 0,
  maxTurns = 0,
  collectorUrl,
  spawnFn = spawn,
  fetchFn = fetch,
  log = console,
}) {
  const baseArgs = argsForBackend(backend);
  if (!baseArgs) throw new Error(`core-local loops support ${Object.keys(CLI_BACKENDS).join('|')}, not "${backend}"`);
  if (!sessionRef || !ingestToken || !collectorUrl) {
    throw new Error('coreLocalLoopRunner: sessionRef, ingestToken and collectorUrl are required');
  }

  const workdir = path.join('/tmp/core-loops', sessionRef);
  try { fs.mkdirSync(workdir, { recursive: true }); } catch { /* spawn cwd fallback below */ }

  const child = spawnFn(backend, baseArgs.concat(Array.isArray(args) ? args : []), {
    cwd: fs.existsSync(workdir) ? workdir : undefined,
    env: minimalChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const agentSessionId = `core-local-${child.pid || Date.now()}`;

  const entry = {
    child,
    sessionRef,
    agentSessionId,
    killed: false,
    killReason: null,
    escalateTimer: null,
  };
  registry.set(sessionRef, entry);
  registry.set(agentSessionId, entry);

  // Payload rides stdin verbatim, exactly like the fleet agent writes
  // req.Payload; closing stdin lets the CLI's internal loop run to its end.
  try {
    if (payload) child.stdin.write(payload.endsWith('\n') ? payload : payload + '\n');
    child.stdin.end();
  } catch (err) {
    log.warn(`[CoreLoop] ${sessionRef}: stdin write failed: ${err.message}`);
  }

  let seq = 0;
  let turns = 0;
  let batch = [];
  let flushTimer = null;
  let sending = Promise.resolve();

  const ingestUrl = `${String(collectorUrl).replace(/\/+$/, '')}/api/v1/dev-sessions/${encodeURIComponent(sessionRef)}/events`;
  const postBatch = (events, done) => {
    // Serialised sends: batches must arrive in order, and the final
    // done:true must be the last write.
    sending = sending.then(async () => {
      try {
        const resp = await fetchFn(ingestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ingest_token: ingestToken, events, done }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) log.error(`[CoreLoop] ${sessionRef}: ingest returned ${resp.status}`);
      } catch (err) {
        log.error(`[CoreLoop] ${sessionRef}: ingest failed: ${err.message}`);
      }
    });
    return sending;
  };

  const flush = (done = false) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (batch.length === 0 && !done) return;
    const events = batch;
    batch = [];
    postBatch(events, done);
  };

  const doKill = (reason) => {
    if (entry.killed) return;
    entry.killed = true;
    entry.killReason = reason;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    entry.escalateTimer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* already gone */ }
    }, ESCALATE_MS);
    if (entry.escalateTimer.unref) entry.escalateTimer.unref();
  };
  entry.doKill = doKill;

  let durationTimer = null;
  if (maxDurationMs > 0) {
    durationTimer = setTimeout(() => doKill('max_duration'), maxDurationMs);
    if (durationTimer.unref) durationTimer.unref();
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let type = '';
    try { type = String(JSON.parse(line).type || ''); } catch { /* non-JSON line: stored raw with empty type */ }
    seq += 1;
    batch.push({ seq, type, raw: line });
    if (type === 'assistant') {
      turns += 1;
      if (maxTurns > 0 && turns >= maxTurns) doKill('max_turns');
    }
    if (batch.length >= BATCH_MAX_EVENTS) flush();
    else if (!flushTimer) {
      flushTimer = setTimeout(() => flush(), BATCH_MAX_MS);
      if (flushTimer.unref) flushTimer.unref();
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  child.on('close', (code, signal) => {
    if (durationTimer) clearTimeout(durationTimer);
    if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
    // The dying words matter when a loop produced nothing.
    if (code !== 0 && stderrTail) {
      log.warn(`[CoreLoop] ${sessionRef}: child exited code=${code} signal=${signal || ''} stderr tail: ${stderrTail.slice(-500)}`);
    }
    flush(true);
    registry.delete(sessionRef);
    registry.delete(agentSessionId);
  });

  return { agentSessionId };
}

/**
 * Kill a live core-local loop by session ref OR agent-session id. Returns
 * { killed: true } when a live child was signalled; an unknown id is an
 * error object, never a silent success (same honesty contract as the
 * agent's structured-kill).
 */
function killCoreLocalLoop(idOrRef, reason = 'interrupt') {
  const entry = registry.get(idOrRef);
  if (!entry) return { killed: false, error: `no live core-local session "${idOrRef}"` };
  entry.doKill(reason);
  return { killed: true };
}

/** True when idOrRef maps to a live core-local child. */
function hasCoreLocalLoop(idOrRef) {
  return registry.has(idOrRef);
}

module.exports = {
  isAvailable,
  startCoreLocalLoop,
  killCoreLocalLoop,
  hasCoreLocalLoop,
  minimalChildEnv,
  argsForBackend,
  CLI_BACKENDS,
};
