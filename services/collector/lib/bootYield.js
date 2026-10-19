/**
 * Boot-time job helpers that never freeze the event loop.
 *
 * 2026-10-11: the collector froze ~38 s on every boot (LoopWatchdog "event loop
 * blocked ~25846ms" then "~10355ms") because the MON-GOV baseline catch-up and
 * the AEE retention prune both ran as one synchronous better-sqlite3 call.
 * Both are now delayed, chunked, and yield between chunks.
 */

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Batched, yielding version of the AEE retention prune. Same two rules and the
 * same witnessed-exempt predicate as the old one-shot DELETEs; rows present in
 * ward_entries are never selected, so they are never deleted.
 * Returns { fleetDeleted, oldDeleted, batches }.
 */
async function pruneAeeBatched(aeeDb, { now = Date.now(), batchSize = 500, scanChunk = batchSize, yieldFn = yieldToEventLoop } = {}) {
  const chatCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const fleetCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const fleetStmt = aeeDb.prepare(`
    DELETE FROM envelopes WHERE rowid IN (
      SELECT rowid FROM envelopes WHERE intent = 'fleet.snapshot' AND ts < ?
        AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AEE' AND w.source_id = envelopes.id)
      LIMIT ${Number(batchSize) | 0})
  `);

  let batches = 0;
  const drain = async (stmt, cutoff) => {
    let total = 0;
    for (;;) {
      const changes = stmt.run(cutoff).changes;
      total += changes;
      batches += 1;
      if (changes < batchSize) break;
      await yieldFn();
    }
    return total;
  };

  const fleetDeleted = await drain(fleetStmt, fleetCutoff);
  await yieldFn();

  // 2026-10-16: witnessed envelopes are exempt forever, so the old (>90 d) backlog is mostly rows that
  // can never be deleted (241,877 on dev). oldStmt re-scanned ALL of them in one statement that cannot
  // yield (16 s loop block to delete 110 rows). Walk the backlog instead in bounded chunks on a
  // (ts, rowid) cursor and yield between chunks; each statement touches at most scanChunk rows.
  const chunkStmt = aeeDb.prepare(`
    SELECT rowid AS r, ts FROM envelopes WHERE ts < ? AND (ts > ? OR (ts = ? AND rowid > ?))
    ORDER BY ts, rowid LIMIT ${Number(scanChunk) | 0}
  `);
  const delChunk = aeeDb.prepare(`
    DELETE FROM envelopes WHERE rowid IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AEE'  AND w.source_id = envelopes.id)
      AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AOCL' AND w.source_id = envelopes.id)
  `);
  let oldDeleted = 0;
  let curTs = '', curRow = -1;
  for (;;) {
    const rows = chunkStmt.all(chatCutoff, curTs, curTs, curRow);
    if (!rows.length) break;
    oldDeleted += delChunk.run(JSON.stringify(rows.map((x) => x.r))).changes;
    batches += 1;
    const last = rows[rows.length - 1];
    curTs = last.ts; curRow = last.r;
    if (rows.length < scanChunk) break;
    await yieldFn();
  }
  return { fleetDeleted, oldDeleted, batches };
}

/**
 * Wait (bounded) until host load1 per core drops below `threshold` before a
 * heavy background pass (WORKER7 2026-10-16: the MON-GOV catch-up fires on
 * every collector start, often mid-deploy with load at 40-65 on 24 cores).
 * loadavg is host-wide inside a container. Gives up after maxWaitMs and lets
 * the caller run anyway, so the work is deferred, never starved.
 */
function hostLoadPerCore() {
  const os = require('os');
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return os.loadavg()[0] / Math.max(1, cores);
}

async function waitForQuietHost({
  loadFn = hostLoadPerCore,
  threshold = 1.0,
  checkMs = 60000,
  maxWaitMs = 30 * 60000,
  sleepFn = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
} = {}) {
  let waitedMs = 0;
  while (loadFn() >= threshold) {
    if (waitedMs >= maxWaitMs) return { waitedMs, quiet: false };
    await sleepFn(checkMs);
    waitedMs += checkMs;
  }
  return { waitedMs, quiet: true };
}

module.exports = { yieldToEventLoop, pruneAeeBatched, waitForQuietHost, hostLoadPerCore };
