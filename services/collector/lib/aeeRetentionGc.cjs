'use strict';
/**
 * QUOXTRUST D3 (2026-09-29) — witnessed-source-EXEMPT AEE retention GC.
 *
 * The bug: runRetentionGc deleted envelopes purely by per-intent TTL
 * (`DELETE FROM envelopes WHERE intent=? AND ts<cutoff`) with NO check for
 * whether the envelope had been WITNESSED into the append-only WARD chain. With
 * TTLs as short as 1 day (heartbeats) / 3 days (ops-sync) / 7 days (aocl.layer),
 * witnessed source envelopes were deleted within days while their WARD receipts
 * lived forever — leaving ~27K within-retention WARD entries whose source the
 * evidence reconciler could no longer read. retentionPolicy.js's own doc said
 * witnessed envelopes "should be skipped by the caller regardless — retention is
 * a floor, not a ceiling." The caller never implemented it. This does.
 *
 * A witness is a promise the source can be reproduced. So: delete an expired
 * envelope ONLY IF it is not present in ward_entries (matched on the same
 * source_kind the witness fork uses: aocl.* → 'AOCL', else 'AEE' — index-seek
 * via idx_ward_entries_source(source_kind, source_id)).
 *
 * FAIL-SAFE: this must be called only with `wardAttached === true` (the ward.db
 * ATTACHed to the aee connection as `warddb`). If ward cannot be attached the
 * caller MUST NOT fall back to an unguarded delete — over-retain rather than
 * delete witnessed evidence blind.
 *
 * `resolveRetention` is injected (retentionPolicy.js) to keep this unit-testable
 * without the ESM policy module.
 */

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const DEFAULTS = {
  batchSize: 200,          // rows scanned per batch
  sliceMs: 50,             // max synchronous time before yielding to the event loop
  maxRows: 200000,         // max rows deleted per run (resume next run)
  maxWallMs: 10 * 60 * 1000,
};

/**
 * INCIDENT-700 (2026-10-06): incremental, cooperative GC. The old version ran one
 * unbounded synchronous DELETE per intent over a 3.4M row table and blocked the
 * event loop for minutes. Now: skip-scan the intent list over idx_intent, walk
 * each intent's expired range in small keyset-paged batches, yield between
 * slices, and stop at a row/wall cap (the next run resumes, expired rows that
 * were deleted are simply gone).
 *
 * @param {object}   opts
 * @param {import('better-sqlite3').Database} opts.aeeDb  connection with `warddb` ATTACHed
 * @param {(intent:string)=>{ttlMs:number,ruleName:string}} opts.resolveRetention
 * @param {boolean}  opts.wardAttached  MUST be true or the GC is skipped (fail-safe)
 * @param {number}   [opts.now]         epoch ms (default Date.now())
 * @param {Function} [opts.yieldFn]     async yield (default setImmediate)
 * @returns {Promise<{total_deleted?:number, by_intent?:Array, ran_at?:string, batches?:number,
 *   wall_ms?:number, max_slice_ms?:number, capped?:boolean, completed?:boolean, skipped?:string, error?:string}>}
 */
async function runWitnessedExemptGc({
  aeeDb, resolveRetention, wardAttached, now = Date.now(), yieldFn = yieldToLoop,
  batchSize = DEFAULTS.batchSize, sliceMs = DEFAULTS.sliceMs,
  maxRows = DEFAULTS.maxRows, maxWallMs = DEFAULTS.maxWallMs,
}) {
  if (!aeeDb) return { error: 'AEE storage not available' };
  if (!wardAttached) return { skipped: 'ward_unavailable' };

  const nextIntent = aeeDb.prepare('SELECT MIN(intent) AS intent FROM envelopes WHERE intent > ?');
  // Keyset page over (ts, rowid) within one intent: seeks on idx_envelopes_intent_ts.
  const page = aeeDb.prepare(
    `SELECT rowid AS rid, ts FROM envelopes
      WHERE intent = ? AND ts < ? AND (ts > ? OR (ts = ? AND rowid > ?))
      ORDER BY ts, rowid LIMIT ?`
  );
  // NOT EXISTS pins source_kind so the (source_kind, source_id) index seeks.
  const del = aeeDb.prepare(`
    DELETE FROM envelopes
     WHERE rowid IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (
         SELECT 1 FROM warddb.ward_entries w
          WHERE w.source_kind = ? AND w.source_id = envelopes.id
       )
  `);

  const started = Date.now();
  let sliceStart = started;
  let maxSlice = 0;
  let batches = 0;
  let totalDeleted = 0;
  let capped = false;
  const perIntent = [];

  const endSlice = () => { maxSlice = Math.max(maxSlice, Date.now() - sliceStart); };

  let intent = '';
  outer:
  for (;;) {
    const row = nextIntent.get(intent);
    if (!row || row.intent == null) break;
    intent = row.intent;
    if (!intent) continue;
    const { ttlMs, ruleName } = resolveRetention(intent);
    if (!Number.isFinite(ttlMs)) continue; // retained forever
    const cutoff = new Date(now - ttlMs).toISOString();
    const kind = intent.startsWith('aocl.') ? 'AOCL' : 'AEE';
    let deleted = 0;
    let curTs = '';
    let curRid = 0;
    try {
      for (;;) {
        const rows = page.all(intent, cutoff, curTs, curTs, curRid, batchSize);
        if (rows.length === 0) break;
        const last = rows[rows.length - 1];
        curTs = last.ts; curRid = last.rid;
        const r = del.run(JSON.stringify(rows.map((x) => x.rid)), kind);
        deleted += r.changes || 0;
        totalDeleted += r.changes || 0;
        batches++;
        if (totalDeleted >= maxRows || Date.now() - started >= maxWallMs) { capped = true; break; }
        if (Date.now() - sliceStart >= sliceMs) {
          endSlice();
          await yieldFn();
          sliceStart = Date.now();
        }
        if (rows.length < batchSize) break;
      }
    } catch (err) {
      // Surface per-intent, never abort the whole pass.
      perIntent.push({ intent, rule: ruleName, error: err.message });
    }
    if (deleted > 0) perIntent.push({ intent, rule: ruleName, deleted, ttl_days: Math.round(ttlMs / 86400000) });
    if (capped) break outer;
    // cooperative between intents too
    if (Date.now() - sliceStart >= sliceMs) {
      endSlice();
      await yieldFn();
      sliceStart = Date.now();
    }
  }
  endSlice();
  return {
    total_deleted: totalDeleted, by_intent: perIntent, ran_at: new Date(now).toISOString(),
    batches, wall_ms: Date.now() - started, max_slice_ms: maxSlice, capped, completed: !capped,
  };
}

// ---- scheduling (never because of a boot) -------------------------------------

const LAST_KEY = 'last_completed_ms';
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureState(db) {
  db.exec('CREATE TABLE IF NOT EXISTS aee_gc_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
function getLastCompletedMs(db) {
  ensureState(db);
  const r = db.prepare('SELECT value FROM aee_gc_state WHERE key = ?').get(LAST_KEY);
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : null;
}
function setLastCompletedMs(db, ms) {
  ensureState(db);
  db.prepare('INSERT INTO aee_gc_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(LAST_KEY, String(ms));
}

/** Parse "03:00-05:00" (UTC, may wrap midnight). Returns {start,end} minutes or null for invalid. */
function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(spec || '03:00-05:00').trim());
  if (!m) return parseWindow('03:00-05:00');
  return { start: (+m[1]) * 60 + (+m[2]), end: (+m[3]) * 60 + (+m[4]) };
}
function inWindowUtc(now, spec) {
  const { start, end } = parseWindow(spec);
  const d = new Date(now);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (start === end) return true;
  return start < end ? (mins >= start && mins < end) : (mins >= start || mins < end);
}

/**
 * Decide whether a periodic tick should run the GC. Pure aside from the state read.
 * Never true just because the process booted: requires >=24h since the last
 * COMPLETED run (persisted) and the quiet window.
 */
function shouldRunGc({ db, now = Date.now(), env = process.env }) {
  if (env.AEE_GC_ENABLED === '0') return { run: false, reason: 'disabled' };
  if (!inWindowUtc(now, env.AEE_GC_WINDOW_UTC)) return { run: false, reason: 'outside_window' };
  const last = getLastCompletedMs(db);
  if (last != null && now - last < DAY_MS) return { run: false, reason: 'ran_within_24h' };
  return { run: true, reason: last == null ? 'never_run' : 'due' };
}

module.exports = {
  runWitnessedExemptGc, shouldRunGc, getLastCompletedMs, setLastCompletedMs, inWindowUtc, DEFAULTS,
};
