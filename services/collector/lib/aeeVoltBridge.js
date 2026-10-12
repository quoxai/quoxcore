/**
 * AEE -> VOLT Bridge (quox#510)
 *
 * MATERIALIZES VOLT RUNS/EVENTS SERVER-SIDE FROM THE AEE ENVELOPE STREAM.
 *
 * Before this, the only VOLT writer was POST /volt/sync (a browser
 * IndexedDB batch flush) and no live surface ever called it, so
 * GET /volt/stats read runs:0 events:0 bundles:0 forever and every evidence
 * bundle (GET /aee/conversation/:corr/bundle) emitted
 * volt:{run:null,events:[],bundle:null} + ward:{witnessed:false} (WARD
 * resolve keys off the VOLT bundle_id — server.js ~15476). QuoxFlow's own
 * envelope forwarder (quoxflow/src/store/envelope-forwarder.ts) already
 * POSTs every workflow envelope to this collector's /aee/sync — this module
 * is what turns that existing traffic into VOLT rows, by hooking the two
 * AEE ingest points (server.js POST /aee/store, POST /aee/sync).
 *
 * SCOPE (binding, quox#510 design doc): workflow-run corrs only. A corr
 * starts being tracked ONLY on a `quox.flow.started` envelope whose corr
 * looks like a QuoxFlow execution id (`wf-<workflowId>-<last8ofExecutionId>`,
 * see quoxflow/src/core/execution.ts ExecutionContext constructor). That is
 * the entire gate: heartbeats (`quoxagent.heartbeat`, corr `FLEET_*`), chat,
 * and every other AEE traffic family are excluded structurally, not via an
 * intent denylist — nothing ever opens a run for them. Once a corr IS
 * tracked, every subsequent envelope on that corr (node execution, AOCL
 * layer, policy/approval) is appended as a VOLT event so the bundle carries
 * the full trace, not just the three flow-level markers. Not covered on
 * this pass: any other envelope family (chat, deploy, MCP tool calls) —
 * those already have their own direct voltEmitter call sites elsewhere in
 * server.js (search `voltEmitter.startRun` — OpenAI/Gemini/Perplexity chat,
 * POWERS invocations, /api/v1/tools/execute) and are out of scope here.
 *
 * `quox.flow.failed`'s payload carries `error_code` (see execution.ts
 * `fail()`), which is how APPROVAL_DENIED/POLICY_DENIED-style errors reach
 * flow level — there is no separate intent for those, so generic FAILED
 * handling below covers them without special-casing.
 *
 * Terminal envelopes (quox.flow.completed / .failed / .cancelled — the
 * latter added here as a terminal alongside the two the design doc names
 * explicitly, since AEE-FULL Gap 4 gave cancellation the same envelope
 * shape as failure and an un-evicted cancelled run would otherwise sit
 * 'active' forever) close the run via voltEmitter.completeRun/failRun —
 * completeRun is what fires the EXISTING onRunComplete -> autoBundleOnComplete
 * -> wardHookVOLT chain (server.js EVD-4 wiring, lib/voltContentStore.js).
 * That plumbing is reused unmodified; this module never touches WARD or
 * bundle assembly directly.
 *
 * Hash-chain semantics (seq, prev_hash, canonical-JSON SHA-256) are NOT
 * reimplemented here — every event goes through the existing
 * lib/voltEmitter.js::emit(), which already matches the read-side verifier
 * at src/lib/volt/volt-verifier.js exactly (genesis seq=1/event_type
 * 'run.started'/prev_hash chain/sha256(canonicalize(eventWithoutHash))).
 * See voltEmitter.js's own canonicalJSON — it additionally applies
 * String.prototype.normalize('NFC') to strings before hashing, which
 * src/lib/volt/volt-canonical.js's canonicalize() does NOT do; this is a
 * pre-existing discrepancy (predates quox#510, not introduced here) that
 * would only surface as a false EVENT_HASH_MISMATCH for non-NFC-normalized
 * unicode payloads — flagged in the quox#510 report, not fixed on this pass.
 */

const DEFAULT_MAX_EVENTS_PER_RUN = 2000;
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_TTL_MS = 60 * 60 * 1000; // no terminal envelope within 1h -> fail it, stop tracking

const WORKFLOW_TERMINAL_INTENTS = new Set([
  'quox.flow.completed',
  'quox.flow.failed',
  'quox.flow.cancelled',
]);

const CAP_MARKER_EVENT_TYPE = 'volt.run.capped';

function isWorkflowRunCorr(corr) {
  return typeof corr === 'string' && corr.startsWith('wf-');
}

/**
 * @param {object} deps
 * @param {object} deps.voltStatements - server.js's prepared VOLT statements
 *   (must expose getRunByCorr; markRunCapped optional — see migrations/volt/
 *   006-volt-runs-event-cap-column.sql)
 * @param {object} deps.voltEmitter - lib/voltEmitter.js instance (startRun/
 *   emit/completeRun/failRun/isAvailable)
 * @param {number|Function} [deps.maxEventsPerRun] - a number, or a function
 *   returning one (SETEC S3: lets a stored setting apply live; evaluated at
 *   each cap check, any throw or invalid result falls back to the default).
 *   Override for
 *   QUOX_VOLT_MAX_EVENTS_PER_RUN / DEFAULT_MAX_EVENTS_PER_RUN
 * @param {(msg: string) => void} [deps.log] - defaults to console.warn
 */
function createAeeVoltBridge({ voltStatements, voltEmitter, maxEventsPerRun, log } = {}) {
  const unavailable = {
    ingestEnvelope() {},
    ingestEnvelopes() {},
    isAvailable: () => false,
    _trackedCorrCount: () => 0,
  };
  if (!voltStatements || !voltStatements.getRunByCorr || !voltEmitter || typeof voltEmitter.isAvailable !== 'function' || !voltEmitter.isAvailable()) {
    return unavailable;
  }

  const staticCap = Number.isFinite(maxEventsPerRun) && maxEventsPerRun > 0
    ? maxEventsPerRun
    : DEFAULT_MAX_EVENTS_PER_RUN;
  function currentCap() {
    if (typeof maxEventsPerRun !== 'function') return staticCap;
    try {
      const n = Number(maxEventsPerRun());
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_EVENTS_PER_RUN;
    } catch (_) {
      return DEFAULT_MAX_EVENTS_PER_RUN;
    }
  }
  const warn = typeof log === 'function' ? log : (msg) => console.warn(msg);

  // corr -> { runId, eventCount, capped, lastActivity }. Bounded by
  // eviction on terminal envelope + the orphan sweep below — never grows
  // without bound the way the pre-quox#510 bug let volt.db grow (see
  // voltEmitter.js's MAX_STRING_BYTES incident comment for the sibling
  // per-event version of this lesson).
  const trackedRuns = new Map();

  function evict(corr) {
    trackedRuns.delete(corr);
  }

  function sweepOrphans() {
    const now = Date.now();
    for (const [corr, entry] of trackedRuns) {
      if (now - entry.lastActivity > ORPHAN_TTL_MS) {
        try {
          voltEmitter.failRun(entry.runId, new Error('volt_orphan_sweep_no_terminal_envelope'));
        } catch (err) {
          warn(`[VOLT/AeeBridge] orphan sweep failRun failed for run ${entry.runId} (non-fatal): ${err.message}`);
        }
        evict(corr);
      }
    }
  }

  const sweepInterval = setInterval(sweepOrphans, ORPHAN_SWEEP_INTERVAL_MS);
  sweepInterval.unref?.();

  function startTrackedRun(envelope, orgId) {
    // Idempotency: a re-ingest of the same quox.flow.started (client retry,
    // resent batch) must not open a second run for the same corr. Check the
    // in-memory map first (the common case), then the DB (covers a
    // collector restart between the original ingest and the retry) before
    // minting a new run.
    if (trackedRuns.has(envelope.corr)) return;

    const existing = voltStatements.getRunByCorr.get(envelope.corr);
    if (existing && existing.status === 'active') {
      trackedRuns.set(envelope.corr, {
        runId: existing.run_id,
        eventCount: existing.seq || 0,
        capped: !!existing.event_cap_hit,
        lastActivity: Date.now(),
      });
      return;
    }

    const runId = voltEmitter.startRun(envelope.corr, {
      org_id: orgId ?? null,
      workflow_id: envelope.payload?.workflowId ?? null,
      execution_id: envelope.payload?.executionId ?? null,
    });
    if (!runId) return; // voltEmitter unavailable/failed — nothing to track
    // startRun() already emitted seq=1 ('run.started') internally.
    trackedRuns.set(envelope.corr, { runId, eventCount: 1, capped: false, lastActivity: Date.now() });
  }

  // `force` bypasses the cap for the terminal envelope only — the run-ending
  // record (what finished it, error_code if any) is small, singular, and is
  // exactly the evidence a capped/truncated trace most needs to keep; the
  // cap exists to stop a HIGH-FREQUENCY flood (a loop node, a retry storm),
  // not to drop the one event that explains why the trace stops. The
  // durable idempotency check below still applies even when forced.
  function appendEvent(entry, envelope, orgId, { force = false } = {}) {
    if (entry.capped && !force) return; // already marked and terminal-marker emitted — drop until terminal envelope closes the run

    // Durable idempotency check (mission-binding: "insertEvent is INSERT OR
    // IGNORE, lean on idempotency keys"). voltEmitter.emit() advances its
    // in-memory seq/prev_hash chain state UNCONDITIONALLY, before finding
    // out whether insertEvent's INSERT OR IGNORE actually persisted a new
    // row — every existing voltEmitter caller only ever calls emit() once
    // per logical event, so that was never a problem before. AEE envelopes
    // CAN be resent (client retry, a resent /aee/sync batch), so without
    // this check a duplicate envelope would silently advance the run's
    // head_hash to a value with no corresponding persisted event row,
    // breaking the chain for every event after it. A DB check (not an
    // in-memory Set) so the guard survives a collector restart between the
    // original ingest and the retry.
    if (voltStatements.hasEvent && voltStatements.hasEvent.get(envelope.id)) return;

    const cap = currentCap();
    if (!force && entry.eventCount >= cap) {
      entry.capped = true;
      voltEmitter.emit(entry.runId, CAP_MARKER_EVENT_TYPE, { cap, reason: 'event_cap_reached' });
      entry.eventCount += 1;
      if (voltStatements.markRunCapped) {
        try { voltStatements.markRunCapped.run(entry.runId); }
        catch (err) { warn(`[VOLT/AeeBridge] markRunCapped failed for run ${entry.runId} (non-fatal): ${err.message}`); }
      }
      return;
    }
    voltEmitter.emit(
      entry.runId,
      envelope.intent,
      {
        ...envelope.payload,
        actor: { actor_type: 'agent', actor_id: envelope.from || null },
        context: { envelope_id: envelope.id, org_id: orgId ?? null, to: envelope.to || null, reply_to: envelope.reply_to || null },
      },
      { eventId: envelope.id }
    );
    entry.eventCount += 1;
  }

  function closeTrackedRun(entry, envelope) {
    if (envelope.intent === 'quox.flow.completed') {
      voltEmitter.completeRun(entry.runId);
    } else {
      voltEmitter.failRun(entry.runId, new Error(envelope.payload?.error_message || envelope.payload?.error_code || envelope.intent));
    }
  }

  /**
   * @param {object} envelope - a decoded AEE envelope (pre-encryption; the
   *   same in-memory object server.js is about to persist)
   * @param {string|null} [orgId] - resolved org (AEE-ORG-1 choke point)
   */
  function ingestEnvelope(envelope, orgId) {
    if (!envelope || !envelope.corr || !envelope.intent) return;

    try {
      if (envelope.intent === 'quox.flow.started') {
        if (!isWorkflowRunCorr(envelope.corr)) return; // scope guard (design doc §2)
        startTrackedRun(envelope, orgId);
        return;
      }

      const entry = trackedRuns.get(envelope.corr);
      if (!entry) return; // not a corr we're tracking (heartbeat/chat/unrelated/already-closed) — expected no-op, not a failure

      entry.lastActivity = Date.now();

      if (WORKFLOW_TERMINAL_INTENTS.has(envelope.intent)) {
        appendEvent(entry, envelope, orgId, { force: true });
        closeTrackedRun(entry, envelope);
        evict(envelope.corr);
        return;
      }

      appendEvent(entry, envelope, orgId);
    } catch (err) {
      // A bridge failure must never fail the AEE store/sync response — the
      // envelope is already durably persisted by the time this runs.
      warn(`[VOLT/AeeBridge] ingestEnvelope failed for corr=${envelope.corr} intent=${envelope.intent} (non-fatal): ${err.message}`);
    }
  }

  function ingestEnvelopes(envelopes) {
    if (!Array.isArray(envelopes)) return;
    for (const envelope of envelopes) {
      ingestEnvelope(envelope, envelope?.org_id ?? null);
    }
  }

  return {
    ingestEnvelope,
    ingestEnvelopes,
    isAvailable: () => true,
    _trackedCorrCount: () => trackedRuns.size, // test/introspection only
  };
}

module.exports = { createAeeVoltBridge, isWorkflowRunCorr, DEFAULT_MAX_EVENTS_PER_RUN, CAP_MARKER_EVENT_TYPE };
