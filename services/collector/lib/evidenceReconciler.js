'use strict';
/**
 * QUOXTRUST WP4.2 — the bidirectional ANCHORED evidence reconciler.
 *
 * Two directions, because each catches what the other cannot:
 *
 *   DIRECTION 1 (completeness): execution intents + the evidence outbox →
 *   expected receipts → WARD entries. Candidate discovery is from the DURABLE
 *   ledger (evidence_obligations.delivered_envelope_id), never from the WARD
 *   tags under test — removing an unhashed tag cannot remove a record from
 *   scrutiny. Each receipt is proven by verifyReceipt (quox#622): a bounded
 *   inclusion proof up to a SIGNED tip, because an unauthenticated stored hash
 *   proves nothing alone. A settled effect whose receipt is missing, never
 *   witnessed, or broken raises a governance incident. A receipt still OWED
 *   past the grace window (the outbox failed to work it off) is an incident
 *   too — debt is visible, never quietly eternal.
 *
 *   DIRECTION 2 (integrity): WARD entries → source envelopes. Windowed
 *   verifyChain pages forward from a durable per-chain watermark (bounded
 *   synchronous work per tick — the 2026-09-26 collector-wedge lesson), and
 *   random BACK-SAMPLES re-verify behind the watermark each tick, so
 *   corruption introduced behind an already-passed watermark is eventually
 *   caught. Sampled AEE entries additionally recompute payload_hash from the
 *   DECRYPTED source envelope: the current payload-bound recipe, with the
 *   pre-binding legacy recipe (no payload_commit) accepted for pre-fix rows —
 *   those remain explicitly metadata-only, which is honest, not a mismatch.
 *
 * Health honesty: {disabled | failed | stale | incomplete | clean}, where
 * mismatches:0 with checked:0 is INCOMPLETE, never clean, and `failed` covers
 * both a failing tick (consecutive_failures) and OPEN qtrust incidents —
 * resolving the incident (a human call) is what returns the surface to clean.
 *
 * Triad by construction: failure is accounted distinctly from empty results
 * (consecutive_failures + last_error), the caller backs off on progress:false,
 * and the watermark IS the retirement — verified work is never re-walked
 * forever (back-samples are the deliberate, bounded exception).
 *
 * All dependencies are injected (ward verify fns, envelope fetch+decrypt,
 * incident creation) so the module is unit-testable without a ward db.
 */

const TERMINAL_INTENT_STATES = ['confirmed', 'failed', 'partial', 'outcome_unknown', 'rejected_before_dispatch'];

const DEFAULTS = {
  completenessBatch: 200,
  integrityPage: 5000,
  backSamples: 3,
  backSampleWindow: 16,
  owedGraceMs: 15 * 60 * 1000,
  sourceSample: 20,
  staleAfterMs: 30 * 60 * 1000,
  // Self-heal budget: how many times a delivered-but-unwitnessed receipt is
  // demoted to owed for re-emission before it becomes a hard incident. Bounds
  // the transient ward-init-race heal without masking a persistent gap.
  maxRewitness: 3,
  // QUOXTRUST D3 (2026-09-29): the fix epoch for the source-loss defects.
  // Two bugs (retention GC pruned WITNESSED source envelopes; /aee/sync
  // witnessed envelopes it skipped storing) left ~27K within-retention WARD
  // entries with irrecoverable sources. Both are fixed forward. A missing
  // source for an entry witnessed BEFORE this epoch is a KNOWN, root-caused,
  // remediated historical loss (documented in STATUS_AND_LIMITS + counted on
  // /health) — NOT an open incident and NOT silently ignored. A missing source
  // AFTER this epoch is a real regression and stays a hard incident (the fix
  // must drive post-epoch loss to zero). null = opt-out (behaviour unchanged:
  // any within-retention missing source is an incident).
  preFixLossEpochMs: null,
};

function initReconcilerState(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_reconciliation_state (
      key                  TEXT PRIMARY KEY,
      watermark            INTEGER NOT NULL DEFAULT 0,
      checked_total        INTEGER NOT NULL DEFAULT 0,
      incident_total       INTEGER NOT NULL DEFAULT 0,
      source_checked_total INTEGER NOT NULL DEFAULT 0,
      last_tick_ts         TEXT,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_ts           TEXT
    );
  `);
}

function createEvidenceReconciler({
  aeeDb = null,
  incidentDb = null,
  chainId = null,
  ward = null,
  getEnvelopeById = null,
  getRetentionFloorTs = null,
  createIncident = null,
  orgId = 'default',
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const enabled = !!(aeeDb && incidentDb && ward && chainId);
  const mkIncident = createIncident || require('./governanceIncidents.js').createIncident;
  // Live (since-boot) count of within-retention missing sources classified as
  // KNOWN pre-fix loss (see DEFAULTS.preFixLossEpochMs). Surfaced on /health so
  // the remediated historical gap is visible, never silent.
  let knownPreFixLossSinceBoot = 0;

  if (enabled) initReconcilerState(aeeDb);

  function stateRow(key) {
    const row = aeeDb.prepare(`SELECT * FROM evidence_reconciliation_state WHERE key=?`).get(key);
    if (row) return row;
    aeeDb.prepare(`INSERT INTO evidence_reconciliation_state (key, updated_ts) VALUES (?, ?)`)
      .run(key, new Date().toISOString());
    return aeeDb.prepare(`SELECT * FROM evidence_reconciliation_state WHERE key=?`).get(key);
  }

  function bumpState(key, { watermark = null, checked = 0, incidents = 0, sourceChecked = 0 } = {}) {
    aeeDb.prepare(
      `UPDATE evidence_reconciliation_state
          SET watermark = COALESCE(?, watermark),
              checked_total = checked_total + ?,
              incident_total = incident_total + ?,
              source_checked_total = source_checked_total + ?,
              updated_ts = ?
        WHERE key = ?`
    ).run(watermark, checked, incidents, sourceChecked, new Date().toISOString(), key);
  }

  function raiseIncident({ corr, title, severity = 'high', description = null, org = orgId }) {
    try {
      mkIncident(incidentDb, {
        org_id: org || 'default',
        corr,
        title,
        incident_type: 'evidence_mismatch',
        severity,
        ...(description ? { description } : {}),
      });
      return 1;
    } catch (e) {
      // An incident that cannot be recorded must still fail the tick loudly —
      // the caller's failure accounting picks it up.
      throw new Error(`incident write failed (${corr}): ${e.message}`);
    }
  }

  // ---- Direction 1: completeness -----------------------------------------
  function runCompleteness(nowMs) {
    const st = stateRow('completeness');
    const rows = aeeDb.prepare(
      `SELECT o.rowid AS rid, o.intent_id, o.org_id, o.tool, o.state AS ob_state,
              o.created_ts, o.delivered_envelope_id, o.attempts,
              i.state AS intent_state
         FROM evidence_obligations o
         JOIN execution_intents i ON i.id = o.intent_id
        WHERE o.rowid > ?
        ORDER BY o.rowid ASC
        LIMIT ?`
    ).all(st.watermark, cfg.completenessBatch);

    let checked = 0, incidents = 0, pending = 0, reheal = 0;
    let newWm = st.watermark;

    for (const row of rows) {
      if (row.ob_state === 'delivered' && row.delivered_envelope_id) {
        const r = ward.verifyReceipt({ sourceKind: 'AEE', sourceId: row.delivered_envelope_id, chainId });
        if (r && r.status === 'WITNESSED') {
          checked++; newWm = row.rid;
        } else if (r && r.status === 'UNTIPPED') {
          // Young entry not yet covered by a signed tip — re-check next tick.
          pending++; break;
        } else if ((row.attempts || 0) < cfg.maxRewitness) {
          // SELF-HEAL (2026-09-28): a receipt marked 'delivered' (AEE store
          // succeeded) but NOT_WITNESSED on the chain is the ward-hook-init
          // race — an envelope stored in the window after a collector restart
          // but before the async WARD hooks initialized (wardHookAEE no-ops
          // until init), so it never reached the chain. This is transient and
          // RE-HEALABLE: demote to 'owed' (dropping the dead envelope id) so
          // the outbox re-emits a FRESH receipt that witnesses now that ward
          // is up. attempts++ bounds it — no incident yet, re-checked next
          // tick (mirrors UNTIPPED). Only a PERSISTENT gap (below) alarms.
          try {
            aeeDb.prepare(
              `UPDATE evidence_obligations SET state='owed', delivered_envelope_id=NULL, attempts=attempts+1,
                 last_error='reconciler: delivered receipt NOT_WITNESSED (ward-init race?) — re-emitting for a witnessed receipt'
               WHERE intent_id=? AND state='delivered'`
            ).run(row.intent_id);
          } catch { /* if the demote can't write, next tick retries; never throw the tick */ }
          reheal++; pending++; break; // don't advance the watermark past a row still being healed
        } else {
          // PERSISTENT: re-emitted maxRewitness times and STILL not witnessed —
          // a real evidence gap a human must reconcile, not a transient race.
          incidents += raiseIncident({
            corr: `qtrust:completeness:${row.intent_id}`,
            title: `Execution receipt for ${row.tool} is ${r ? r.status : 'UNVERIFIABLE'} after ${row.attempts} re-emits (intent ${row.intent_id})`,
            severity: 'high',
            description: `verifyReceipt(${row.delivered_envelope_id}) → ${r ? `${r.status}${r.reason ? `:${r.reason}` : ''}` : 'no result'} — an external effect settled ${row.intent_state} and ${row.attempts} re-witness attempts did not land it on the chain (persistent, not the transient ward-init race)`,
            org: row.org_id,
          });
          checked++; newWm = row.rid;
        }
      } else if (row.ob_state === 'delivered') {
        // Delivered pre-join-key (no envelope id recorded): counted, retired —
        // there is nothing durable to verify against; direction 2 still covers
        // the chain those receipts live in.
        checked++; newWm = row.rid;
      } else {
        // owed
        if (!TERMINAL_INTENT_STATES.includes(row.intent_state)) { pending++; break; }
        const ageMs = nowMs - Date.parse(row.created_ts);
        if (ageMs > cfg.owedGraceMs) {
          incidents += raiseIncident({
            corr: `qtrust:completeness:${row.intent_id}`,
            title: `Receipt for ${row.tool} still OWED ${Math.round(ageMs / 60000)}min after the effect settled (intent ${row.intent_id})`,
            severity: 'high',
            description: `evidence obligation is 'owed' past the ${Math.round(cfg.owedGraceMs / 60000)}min grace — the outbox re-emit is not working it off (sink down or re-emit failing)`,
            org: row.org_id,
          });
          checked++; newWm = row.rid;
        } else { pending++; break; }
      }
    }

    bumpState('completeness', { watermark: newWm, checked, incidents });
    return { checked, incidents, pending, reheal };
  }

  // ---- Direction 2: integrity ---------------------------------------------
  function recomputeSourceHash(env, withCommit) {
    return ward.payloadHash({
      id: env.id, v: env.v || '1', ts: env.ts, type: env.type,
      from: env.from, to: env.to, intent: env.intent, corr: env.corr,
      reply_to: env.reply_to || null,
      ...(withCommit ? { payload_commit: env.payload != null ? ward.payloadHash(env.payload) : null } : {}),
    });
  }

  async function sourceCrossCheck(fromSeq, upToSeq) {
    let sourceChecked = 0, incidents = 0, outOfRetention = 0, knownPreFixLoss = 0;
    let entries = [];
    try { entries = ward.getEntriesRange(chainId, fromSeq, upToSeq) || []; }
    catch (e) { throw new Error(`getEntriesRange failed: ${e.message}`); }
    // 2026-09-28 live false-positive lesson: the AEE store PRUNES (retention),
    // while the WARD chain is append-only forever — so for entries witnessed
    // before the oldest surviving envelope, a missing source is EXPECTED, not
    // suspicious. The first live run raised 40+ 'cannot be read' incidents at
    // exact sampling intervals over months-old pruned envelopes and flipped
    // /health degraded. Missing-source is only an incident WITHIN retention;
    // beyond it the source cross-check honestly has no reach (chain-hash
    // integrity still covers those entries; documented limitation: a deletion
    // of an already-out-of-retention envelope is indistinguishable from
    // retention).
    let floorMs = null;
    try {
      const f = typeof getRetentionFloorTs === 'function' ? getRetentionFloorTs() : null;
      floorMs = f ? Date.parse(f) : null;
    } catch { floorMs = null; }
    const aee = entries.filter((e) => String(e.source_kind).toUpperCase() === 'AEE');
    // Evenly-spaced bounded sample so a big window cannot wedge the tick.
    const step = Math.max(1, Math.ceil(aee.length / cfg.sourceSample));
    for (let i = 0; i < aee.length; i += step) {
      const entry = aee[i];
      sourceChecked++;
      if (sourceChecked % 5 === 0) await yieldLoop(); // decrypt + rehash per envelope
      let env = null;
      try { env = typeof getEnvelopeById === 'function' ? getEnvelopeById(entry.source_id) : null; } catch { env = null; }
      if (!env) {
        const entryMs = Date.parse(entry.source_ts || entry.witnessed_at || '') || null;
        if (floorMs && entryMs && entryMs < floorMs) {
          outOfRetention++;
          continue;
        }
        // QUOXTRUST D3 (2026-09-29): a within-retention missing source witnessed
        // BEFORE the fix epoch is a KNOWN, root-caused, fixed-forward historical
        // loss (retention GC pruned witnessed sources / /aee/sync witnessed
        // without storing). Irrecoverable and DOCUMENTED — count it distinctly,
        // do NOT raise a fresh incident for a defect already remediated. A
        // missing source AFTER the epoch falls through to a hard incident below:
        // that is a real regression the fix must prevent.
        if (cfg.preFixLossEpochMs && entryMs && entryMs < cfg.preFixLossEpochMs) {
          knownPreFixLoss++;
          knownPreFixLossSinceBoot++;
          continue;
        }
        incidents += raiseIncident({
          corr: `qtrust:integrity:${chainId}:${entry.seq}`,
          title: `WARD entry seq ${entry.seq} references a source envelope that cannot be read (${entry.source_id})`,
          severity: 'medium',
          description: 'witnessed entry has no readable source envelope WITHIN the retention window AND after the source-loss fix epoch — a real post-fix regression (undecryptable, never stored, or deleted despite the witnessed-exempt retention guard)',
        });
        continue;
      }
      const current = recomputeSourceHash(env, true);
      if (current === entry.payload_hash) continue;
      const legacy = recomputeSourceHash(env, false);
      if (legacy === entry.payload_hash) continue; // pre-payload-binding receipt: metadata-only by documented history
      incidents += raiseIncident({
        corr: `qtrust:integrity:${chainId}:${entry.seq}`,
        title: `WARD payload_hash DIVERGES from the decrypted source envelope at seq ${entry.seq}`,
        severity: 'critical',
        description: `recompute (current AND legacy recipe) mismatches the witnessed hash for source ${entry.source_id} — source mutated after witnessing, or the entry was tampered`,
      });
    }
    return { sourceChecked, incidents, outOfRetention, knownPreFixLoss };
  }

  // CORTEX-BENCH (2026-10-08): the integrity pass ran as one synchronous block
  // (forward page + back-samples + source decrypt/rehash) and froze the whole
  // collector event loop for ~10-14s every reconciler tick (LoopWatchdog: 83
  // blocks / 251s in 2h), stalling every tool call and LLM rerank. Same work,
  // same results, but verified in sub-ranges with a yield between them.
  const INTEGRITY_SUBPAGE = 100;
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

  async function runIntegrity() {
    const st = stateRow('integrity');
    let verified = 0, incidents = 0, sourceChecked = 0, outOfRetention = 0, knownPreFixLoss = 0;
    let wm = st.watermark;

    const chain = ward.getChain(chainId);
    const head = chain && Number.isFinite(chain.head_seq) ? chain.head_seq : 0;

    if (head > wm) {
      const upTo = Math.min(wm + cfg.integrityPage, head);
      let r = null;
      for (let from = wm + 1; from <= upTo; from += INTEGRITY_SUBPAGE) {
        const to = Math.min(from + INTEGRITY_SUBPAGE - 1, upTo);
        r = ward.verifyChain(chainId, { fromSeq: from, upToSeq: to, maxEntries: INTEGRITY_SUBPAGE });
        if (r && r.status === 'BROKEN') break;
        await yieldLoop();
      }
      if (r && r.status === 'BROKEN') {
        incidents += raiseIncident({
          corr: `qtrust:integrity:${chainId}:${(r.details && r.details.seq) || wm + 1}`,
          title: `WARD chain ${chainId} BROKEN in [${wm + 1}..${upTo}]: ${r.reason || 'unknown'}`,
          severity: 'critical',
          description: JSON.stringify(r.details || {}).slice(0, 500),
        });
        // Watermark does NOT advance past a break — it stays pointed at the wound.
      } else {
        await yieldLoop();
        const sc = await sourceCrossCheck(wm + 1, upTo);
        sourceChecked += sc.sourceChecked;
        incidents += sc.incidents;
        outOfRetention += sc.outOfRetention;
        knownPreFixLoss += sc.knownPreFixLoss || 0;
        verified += upTo - wm;
        wm = upTo;
      }
    }

    // Random back-samples BEHIND the watermark: bounded re-verification so
    // corruption introduced behind an already-verified point is eventually
    // caught. `_backSample: true` is advisory (ignored by the real verifier;
    // lets tests distinguish the call).
    if (wm > 1 && cfg.backSamples > 0) {
      for (let k = 0; k < cfg.backSamples; k++) {
        await yieldLoop();
        const start = 1 + Math.floor(Math.random() * Math.max(1, wm - cfg.backSampleWindow));
        const end = Math.min(start + cfg.backSampleWindow - 1, wm);
        const r = ward.verifyChain(chainId, { fromSeq: start, upToSeq: end, maxEntries: cfg.backSampleWindow, _backSample: true });
        if (r && r.status === 'BROKEN') {
          incidents += raiseIncident({
            corr: `qtrust:integrity:${chainId}:${(r.details && r.details.seq) || start}`,
            title: `WARD chain ${chainId} BROKEN behind the watermark at [${start}..${end}]: ${r.reason || 'unknown'}`,
            severity: 'critical',
            description: JSON.stringify(r.details || {}).slice(0, 500),
          });
        }
      }
    }

    bumpState('integrity', { watermark: wm, checked: verified, incidents, sourceChecked });
    return { verified, incidents, source_checked: sourceChecked, out_of_retention: outOfRetention, known_pre_fix_loss: knownPreFixLoss, watermark: wm, head_seq: head };
  }

  // ---- tick + status --------------------------------------------------------
  async function tick() {
    if (!enabled) {
      return { disabled: true, progress: false, failed: false, completeness: { checked: 0, incidents: 0, pending: 0 }, integrity: { verified: 0, incidents: 0, source_checked: 0 } };
    }
    const nowMs = Date.now();
    let failed = false;
    let lastError = null;
    let completeness = { checked: 0, incidents: 0, pending: 0, reheal: 0 };
    let integrity = { verified: 0, incidents: 0, source_checked: 0, out_of_retention: 0, known_pre_fix_loss: 0 };

    try { completeness = runCompleteness(nowMs); }
    catch (e) { failed = true; lastError = `completeness: ${e.message}`; }
    try { integrity = await runIntegrity(); }
    catch (e) { failed = true; lastError = `${lastError ? lastError + '; ' : ''}integrity: ${e.message}`; }

    const tickSt = stateRow('tick');
    aeeDb.prepare(
      `UPDATE evidence_reconciliation_state
          SET last_tick_ts = ?, last_error = ?,
              consecutive_failures = ?,
              updated_ts = ?
        WHERE key = 'tick'`
    ).run(
      new Date(nowMs).toISOString(),
      lastError,
      failed ? (tickSt.consecutive_failures + 1) : 0,
      new Date().toISOString()
    );

    _statusCache = null; // a tick changes state: next status read is fresh
    const progress = (completeness.checked + completeness.incidents + (completeness.reheal || 0) + integrity.verified + integrity.source_checked + integrity.incidents) > 0;
    return { completeness, integrity, failed, progress, last_error: lastError };
  }

  // CORTEX-BENCH 2026-10-08: /health calls this on every poll and the open-
  // incident COUNT (LIKE 'qtrust:%') scans governance_incidents synchronously
  // (~2s of main-thread time per 90s in a live profile). Cached briefly; a
  // reconciler tick invalidates it so a new incident shows on the next poll.
  const STATUS_CACHE_MS = 30000;
  let _statusCache = null;
  function getStatus() {
    if (_statusCache && Date.now() - _statusCache.at < STATUS_CACHE_MS) return _statusCache.value;
    const value = computeStatus();
    _statusCache = { at: Date.now(), value };
    return value;
  }
  function computeStatus() {
    if (!enabled) return { state: 'disabled' };
    const comp = stateRow('completeness');
    const integ = stateRow('integrity');
    const tickSt = stateRow('tick');
    let openIncidents = 0;
    try {
      openIncidents = incidentDb.prepare(
        `SELECT COUNT(*) c FROM governance_incidents WHERE corr LIKE 'qtrust:%' AND status = 'open'`
      ).get().c;
    } catch { openIncidents = 0; }

    const checkedTotal = comp.checked_total + integ.checked_total + integ.source_checked_total;
    let state;
    if (tickSt.consecutive_failures > 0 || openIncidents > 0) state = 'failed';
    else if (tickSt.last_tick_ts && (Date.now() - Date.parse(tickSt.last_tick_ts)) > cfg.staleAfterMs) state = 'stale';
    else if (checkedTotal === 0) state = 'incomplete'; // mismatches:0 with checked:0 is NOT clean
    else state = 'clean';

    return {
      state,
      open_incidents: openIncidents,
      consecutive_failures: tickSt.consecutive_failures,
      last_tick_ts: tickSt.last_tick_ts,
      last_error: tickSt.last_error,
      completeness: { watermark: comp.watermark, checked_total: comp.checked_total, incident_total: comp.incident_total },
      integrity: { watermark: integ.watermark, checked_total: integ.checked_total, incident_total: integ.incident_total, source_checked_total: integ.source_checked_total },
      known_pre_fix_loss_since_boot: knownPreFixLossSinceBoot,
    };
  }

  return { tick, getStatus };
}

module.exports = { createEvidenceReconciler, initReconcilerState, TERMINAL_INTENT_STATES };
