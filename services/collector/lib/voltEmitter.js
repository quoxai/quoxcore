/**
 * VOLT Emitter — Server-Side Event Recording
 *
 * CRP-BE-3: Manages VOLT run lifecycle and emits hash-chained events
 * to the server-side VOLT SQLite database.
 *
 * Follows VOLT SPEC v0.1:
 *   - SHA-256 hash chains (§4.1)
 *   - Canonical JSON for hashing (§3.2)
 *   - Genesis prev_hash = 64 hex zeros (§5)
 *   - Fire-and-forget, never blocks caller (§22.1)
 *
 * Usage:
 *   const emitter = createVoltEmitter(voltStatements, wardHookVOLT)
 *   const runId = emitter.startRun(corr, { org_id, user_id })
 *   emitter.emit(runId, 'tool.call.executed', { tool: 'ssh_exec', ... })
 *   emitter.completeRun(runId)
 */

const crypto = require('crypto');

const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Canonical JSON serialization (VOLT SPEC §3.2).
 * Sorted keys at every nesting level, no whitespace.
 */
function canonicalJSON(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj.normalize('NFC'));
  if (typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJSON).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys
    .filter(k => obj[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * SHA-256 hash of canonical JSON, returned as lowercase hex.
 */
function sha256(obj) {
  const canonical = canonicalJSON(obj);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Generate a unique event ID.
 */
function generateEventId() {
  return `VE_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generate a unique run ID.
 */
function generateRunId(corr) {
  return `VR_${corr || 'anon'}_${Date.now()}`;
}

/**
 * Create a VOLT emitter instance.
 *
 * @param {Object} voltStatements - Prepared SQLite statements (insertRun, insertEvent)
 * @param {Function|null} wardHookVOLT - WARD witness hook for VOLT events (fire-and-forget)
 * @returns {Object} Emitter with startRun, emit, completeRun, failRun methods
 */
function createVoltEmitter(voltStatements, wardHookVOLT, options = {}) {
  // EVD-4: Optional post-completion callback for auto-bundling.
  // Signature: onRunComplete(runId, state) — fire-and-forget, errors non-fatal.
  const onRunComplete = typeof options.onRunComplete === 'function' ? options.onRunComplete : null;
  if (!voltStatements) {
    // Return no-op emitter when VOLT DB is unavailable
    return {
      startRun: () => null,
      emit: () => null,
      completeRun: () => {},
      failRun: () => {},
      isAvailable: () => false
    };
  }

  // In-memory run state for hash chaining (keyed by run_id)
  // Evicted after run completes or 30 minutes of inactivity
  const activeRuns = new Map();
  const RUN_TTL = 30 * 60 * 1000; // 30 minutes

  function cleanStaleRuns() {
    const now = Date.now();
    for (const [runId, state] of activeRuns) {
      if (now - state.lastActivity > RUN_TTL) {
        activeRuns.delete(runId);
      }
    }
  }

  // Periodic cleanup every 5 minutes
  const cleanupInterval = setInterval(cleanStaleRuns, 5 * 60 * 1000);
  cleanupInterval.unref?.(); // Don't prevent process exit

  /**
   * Start a new VOLT run.
   *
   * @param {string} corr - AEE correlation ID
   * @param {Object} context - { org_id, user_id, agent_id }
   * @returns {string} run_id
   */
  function startRun(corr, context = {}) {
    try {
      const runId = generateRunId(corr);
      const ts = new Date().toISOString();

      voltStatements.insertRun.run(
        runId, corr, 'active', ts, null, 0, null, context.org_id ?? null
      );

      activeRuns.set(runId, {
        seq: 0,
        prevHash: GENESIS_PREV_HASH,
        corr,
        context,
        startedAt: ts, // quox#514: emit()'s run-head upsert must not wipe this
        lastActivity: Date.now()
      });

      // Emit run.started event
      emit(runId, 'run.started', {
        correlation_id: corr,
        ...context
      });

      return runId;
    } catch (err) {
      console.warn('[VOLT/Emitter] startRun failed (non-fatal):', err.message);
      return null;
    }
  }

  /**
   * quox#745: state for a run this process does not hold in memory (another
   * writer started it, the collector restarted, or the idle eviction dropped
   * it). Resume from the database: the last persisted seq + hash, and the run
   * row's corr / started_at / org. Starting again at seq 1 from genesis
   * forked a second chain inside the same run, and about 1 in 3 runs then
   * failed `quox volt verify` with SEQ_NOT_MONOTONIC.
   */
  function resumeState(runId) {
    const state = { seq: 0, prevHash: GENESIS_PREV_HASH, lastActivity: Date.now() };
    try {
      const last = voltStatements.getLastEvent ? voltStatements.getLastEvent.get(runId) : null;
      if (last) {
        const data = typeof last.data === 'string' ? JSON.parse(last.data) : last.data;
        if (!data || typeof data.hash !== 'string') {
          throw new Error(`last event of ${runId} has no hash; cannot continue its chain`);
        }
        state.seq = Number(last.seq) || 0;
        state.prevHash = data.hash;
      }
      const run = voltStatements.getRun ? voltStatements.getRun.get(runId) : null;
      if (run) {
        state.corr = run.corr || null;
        state.startedAt = run.started_at ?? null;
        if (run.org_id) state.context = { org_id: run.org_id };
      }
    } catch (err) {
      // Fail loud, not silent: a forked chain is worse than a missing event.
      console.warn(`[VOLT/Emitter] cannot resume run ${runId} from storage: ${err.message}`);
      throw err;
    }
    return state;
  }

  /**
   * Emit a VOLT event within a run.
   *
   * @param {string} runId - Run ID from startRun
   * @param {string} eventType - e.g. 'tool.call.executed', 'model.responded'
   * @param {Object} payload - Event-specific data
   * @param {Object} [opts] - { eventId } — caller-supplied event id (e.g. the
   *   source AEE envelope's own ULID) so a re-ingest of the same source event
   *   is a natural no-op against insertEvent's INSERT OR IGNORE, instead of
   *   minting a fresh random id and double-appending. Defaults to a random
   *   VE_ id when omitted (all existing callers).
   * @returns {Object|null} The event record, or null
   */
  function emit(runId, eventType, payload = {}, opts = {}) {
    if (!runId) return null;

    try {
      let state = activeRuns.get(runId);
      if (!state) {
        state = resumeState(runId);
        activeRuns.set(runId, state);
      }

      state.seq += 1;
      state.lastActivity = Date.now();

      const eventId = opts.eventId || generateEventId();
      const ts = new Date().toISOString();

      // Build event object for hashing (SPEC §5 — hash computed over event without hash field)
      const eventObj = {
        volt_version: '0.1',
        event_id: eventId,
        run_id: runId,
        ts,
        seq: state.seq,
        event_type: eventType,
        actor: payload.actor || { actor_type: 'system', actor_id: 'collector' },
        context: {
          correlation_id: state.corr || null,
          ...(state.context || {}),
          ...(payload.context || {})
        },
        payload: sanitizePayload(payload),
        prev_hash: state.prevHash
      };

      // Compute hash (SPEC §4.1 — SHA-256 of canonical JSON)
      const hash = sha256(eventObj);
      eventObj.hash = hash;

      // Update chain state
      state.prevHash = hash;

      // Persist to SQLite
      voltStatements.insertEvent.run(
        eventId, runId, eventType, ts, state.seq,
        JSON.stringify(eventObj)
      );

      // Update run head. quox#514: this upsert used to pass started_at =
      // null, silently wiping the run's start time on EVERY event (observed
      // live as a whole population of null-started_at rows, which also broke
      // getRunByCorr's started_at DESC ordering).
      voltStatements.insertRun.run(
        runId, state.corr || null, 'active', state.startedAt ?? null, null, state.seq, hash, state.context?.org_id ?? null
      );

      // WARD witness (fire-and-forget, SPEC §10.3)
      if (wardHookVOLT) {
        try {
          // ORG-VIEW-SCOPE: org_id already carried on the run's context
          // (set via startRun) — thread it through as a row attribute/tag.
          wardHookVOLT({ event_id: eventId, hash, run_id: runId, ts, event_type: eventType, org_id: state.context?.org_id ?? null });
        } catch (_) { /* WARD failures must not affect VOLT */ }
      }

      // LUCID: run lifecycle only (never tool.call.* / model.*). Never throws.
      if (eventType === 'run.started' || eventType === 'run.completed' || eventType === 'run.failed') {
        try { require('./lucid/emit.js').runEvent(eventType, runId, state.context, payload); } catch { /* LUCID must never break VOLT */ }
      }

      return eventObj;
    } catch (err) {
      console.warn(`[VOLT/Emitter] emit(${eventType}) failed (non-fatal):`, err.message);
      return null;
    }
  }

  /**
   * Complete a VOLT run successfully.
   */
  function completeRun(runId) {
    if (!runId) return;
    let stateSnapshot = null;
    try {
      emit(runId, 'run.completed', {});
      const state = activeRuns.get(runId);
      stateSnapshot = state ? { corr: state.corr, seq: state.seq, prevHash: state.prevHash } : null;
      // quox#514: INSERT OR REPLACE with a null started_at was WIPING the
      // run's original start time on completion; carry it through.
      const priorC = voltStatements.getRun ? voltStatements.getRun.get(runId) : null;
      voltStatements.insertRun.run(
        runId, state?.corr || priorC?.corr || null, 'completed',
        state?.startedAt ?? priorC?.started_at ?? null, new Date().toISOString(),
        state?.seq || priorC?.seq || 0, state?.prevHash || priorC?.head_hash || null,
        state?.context?.org_id ?? priorC?.org_id ?? null
      );
      activeRuns.delete(runId);
    } catch (err) {
      console.warn('[VOLT/Emitter] completeRun failed (non-fatal):', err.message);
    }
    // EVD-4: fire auto-bundle callback AFTER the DB writes complete.
    // Errors here must not affect the already-recorded run.
    if (onRunComplete) {
      try {
        onRunComplete(runId, stateSnapshot);
      } catch (cbErr) {
        console.warn('[VOLT/Emitter] onRunComplete callback error (non-fatal):', cbErr.message);
      }
    }
  }

  /**
   * Fail a VOLT run.
   */
  function failRun(runId, error) {
    if (!runId) return;
    let stateSnapshot = null;
    try {
      emit(runId, 'run.failed', { error: error?.message || String(error) });
      const state = activeRuns.get(runId);
      stateSnapshot = state ? { corr: state.corr, seq: state.seq, prevHash: state.prevHash } : null;
      const priorF = voltStatements.getRun ? voltStatements.getRun.get(runId) : null;
      voltStatements.insertRun.run(
        runId, state?.corr || priorF?.corr || null, 'failed',
        state?.startedAt ?? priorF?.started_at ?? null, new Date().toISOString(),
        state?.seq || priorF?.seq || 0, state?.prevHash || priorF?.head_hash || null,
        state?.context?.org_id ?? priorF?.org_id ?? null
      );
      activeRuns.delete(runId);
    } catch (err) {
      console.warn('[VOLT/Emitter] failRun failed (non-fatal):', err.message);
    }
    // quox#514: a FAILED run is exactly the evidence an auditor most needs
    // bundled and witnessed; only completeRun fired the auto-bundle callback,
    // so every failed/denied run silently skipped bundling + WARD. Mirror
    // completeRun's post-write callback here.
    if (onRunComplete) {
      try {
        onRunComplete(runId, stateSnapshot);
      } catch (cbErr) {
        console.warn('[VOLT/Emitter] onRunComplete callback error (non-fatal):', cbErr.message);
      }
    }
  }

  function isAvailable() { return true; }

  /**
   * EVD-1a: Flush all in-flight runs as failed. Called from SIGTERM handler.
   * Prevents VOLT runs from sitting in 'active' status forever after a
   * container restart.
   *
   * @param {string} reason - Reason string recorded on the failRun event
   * @returns {number} Number of runs flushed
   */
  function flushActiveRuns(reason = 'process_shutdown') {
    const runIds = Array.from(activeRuns.keys());
    let flushed = 0;
    for (const runId of runIds) {
      try {
        failRun(runId, new Error(reason));
        flushed++;
      } catch (err) {
        console.warn(`[VOLT/Emitter] flushActiveRuns failed for ${runId}:`, err.message);
      }
    }
    if (flushed > 0) {
      console.log(`[VOLT/Emitter] flushed ${flushed} active run(s) — reason: ${reason}`);
    }
    return flushed;
  }

  return { startRun, emit, completeRun, failRun, flushActiveRuns, isAvailable };
}

// Hard storage bounds for a single VOLT event.
//
// THE INCIDENT THAT PUT THESE HERE (2026-08-18, dev-host-01)
// The dev box's root filesystem hit 100% of 524GB and every build and most
// commands began failing. volt.db was 88GB. 19,906 `tool.call.executed` events
// accounted for 88.0GB of that, averaging 4.4MB each and peaking at 7.2MB,
// because /api/v1/tools/execute records `output: result` — the ENTIRE tool
// result — and nothing bounded it. The nightly backup then copied the whole
// file, so backups ran 34GB -> 68GB -> 83GB on successive nights.
//
// This is not a dev-box quirk. /api/v1/tools/execute is the gold path for every
// agent, MCP and CLI tool call, so any customer whose agents call tools that
// return large results (a file read, a fleet listing, a log tail, a query dump)
// fills their disk at a rate set by how chatty their agents are. An evidence
// ledger that grows without bound is a liability, not a feature.
//
// The old guard truncated exactly two NAMED fields, `prompt` and `response`.
// `output` was never on the list, so it went in whole. That is the denylist
// shape the house security rule already warns about for secrets, and it fails
// for size in precisely the same way: it only ever bounds the field names
// somebody thought to write down. These bounds apply to EVERY field instead.
//
// Evidence is not weakened by this. What VOLT must prove is that a specific
// result was produced and has not been altered since, and a SHA-256 of the full
// value proves exactly that: anyone holding the original can verify it against
// the chain. Storing the megabytes as well only means the ledger doubles as an
// unbounded object store, which is what filled the disk.
const MAX_STRING_BYTES = 2048;

// VOLT-RETENTION P1: make every bound VISIBLE. Counts since process start,
// surfaced on GET /volt/stats as `bounds`, plus a rate-limited warning, so a
// tool that starts returning megabytes is noticed the same day, not after the
// disk fills (the 2026-08-10..19 band went unseen for a week).
const boundCounters = { truncated_strings: 0, truncated_records: 0, sync_refused: 0, since: new Date().toISOString() };
function noteBound(kind) {
  boundCounters[kind] += 1;
  const n = boundCounters[kind];
  if (n === 1 || n % 1000 === 0) console.warn(`[VOLT/bounds] ${kind}=${n} since ${boundCounters.since} (oversized evidence is digested or refused, see VOLT-RETENTION)`);
}
function getBoundCounters() { return { ...boundCounters }; }
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

const SECRET_KEYS = new Set(['api_key', 'token', 'password', 'secret', 'authorization']);

/**
 * Replace an oversized string with a verifiable stand-in: a readable head, the
 * original byte length, and a SHA-256 of the full value so the chain still
 * proves what was there.
 */
function digestOversizedString(str) {
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes <= MAX_STRING_BYTES) return str;
  noteBound('truncated_strings');
  return {
    __volt_truncated: true,
    bytes,
    sha256: crypto.createHash('sha256').update(str, 'utf8').digest('hex'),
    preview: Buffer.from(str, 'utf8').subarray(0, MAX_STRING_BYTES).toString('utf8'),
  };
}

/**
 * Walk a payload and bound every value, whatever it is called and however
 * deeply it is nested. Depth and breadth are capped too: a deeply recursive or
 * enormous array is another way to write a large row.
 */
function boundValue(value, depth = 0) {
  if (typeof value === 'string') return digestOversizedString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) {
    return { __volt_truncated: true, reason: `depth>${MAX_DEPTH}` };
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 100).map((v) => boundValue(v, depth + 1));
    if (value.length > 100) head.push({ __volt_truncated: true, omitted: value.length - 100 });
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k.toLowerCase())) continue;
    out[k] = boundValue(v, depth + 1);
  }
  return out;
}

/**
 * Strip sensitive data from payloads before VOLT recording, and bound their
 * size so the evidence ledger cannot grow without limit (see the block above).
 * VOLT events MUST NOT contain secrets (SPEC §2.1).
 */
function sanitizePayload(payload) {
  const clean = { ...payload };
  // Remove fields that should never be in VOLT
  delete clean.actor;
  delete clean.context;
  delete clean.api_key;
  delete clean.token;
  delete clean.password;
  delete clean.secret;
  delete clean.authorization;

  const bounded = boundValue(clean);

  // Belt and braces: per-field bounds still permit a payload with thousands of
  // just-under-the-limit fields, so cap the whole event as well.
  const serialized = JSON.stringify(bounded);
  if (serialized && Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    noteBound('truncated_records');
    return {
      __volt_truncated: true,
      reason: 'payload_over_limit',
      bytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
      keys: Object.keys(bounded).slice(0, 50),
    };
  }
  return bounded;
}

/**
 * VOLT-RETENTION P1: the bound for UNCHAINED records written straight to
 * volt_events (connector bridge recorder, dispatcher legacy decision
 * fallback). Same per-field digest and whole-record cap as sanitizePayload,
 * but actor/context are KEPT: these records carry them deliberately.
 */
function boundRecord(record) {
  const bounded = boundValue(record);
  const serialized = JSON.stringify(bounded);
  if (serialized && Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    noteBound('truncated_records');
    return {
      __volt_truncated: true,
      reason: 'payload_over_limit',
      bytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
      keys: Object.keys(bounded).slice(0, 50),
      ...(bounded && bounded.type ? { type: bounded.type } : {}),
    };
  }
  return bounded;
}

// /volt/sync events arrive already hash-chained by the browser, so the server
// must never rewrite them (a trimmed copy would fail verification). Oversized
// ones are REFUSED and counted instead. Twice the emitter cap leaves room for
// the envelope fields around a maximal bounded payload.
const MAX_SYNC_EVENT_BYTES = 2 * MAX_PAYLOAD_BYTES;
/**
 * quox#745: /volt/sync must never insert an event that forks a run's chain.
 * True when another event already holds this (run_id, seq), or when the
 * stored event at seq-1 is not the one this event's prev_hash points to.
 * A re-send of the same event_id is not a fork (INSERT OR IGNORE handles it).
 * Needs statements.getEventAtSeq; without it nothing is refused.
 */
function syncForksChain(statements, evt) {
  if (!statements || !statements.getEventAtSeq || !evt || !evt.run_id) return false;
  const seq = Number(evt.seq) || 0;
  if (seq < 1) return false;
  const holder = statements.getEventAtSeq.get(evt.run_id, seq);
  if (holder) return holder.event_id !== evt.event_id;
  if (seq > 1 && typeof evt.prev_hash === 'string') {
    const before = statements.getEventAtSeq.get(evt.run_id, seq - 1);
    if (before) {
      let h = null;
      try { h = JSON.parse(before.data).hash; } catch (_) { h = null; }
      if (h && h !== evt.prev_hash) return true;
    }
  }
  return false;
}

function isOversizedSyncEvent(evt) {
  const s = typeof evt === 'object' ? JSON.stringify(evt) : String(evt);
  const over = Buffer.byteLength(s || '', 'utf8') > MAX_SYNC_EVENT_BYTES;
  if (over) noteBound('sync_refused');
  return over;
}

module.exports = {
  createVoltEmitter,
  boundRecord,
  isOversizedSyncEvent,
  syncForksChain,
  getBoundCounters,
  MAX_SYNC_EVENT_BYTES,
  canonicalJSON,
  sha256,
  sanitizePayload,
  MAX_STRING_BYTES,
  MAX_PAYLOAD_BYTES,
};
