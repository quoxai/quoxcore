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
async function pruneAeeBatched(aeeDb, { now = Date.now(), batchSize = 500, yieldFn = yieldToEventLoop } = {}) {
  const chatCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const fleetCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const fleetStmt = aeeDb.prepare(`
    DELETE FROM envelopes WHERE rowid IN (
      SELECT rowid FROM envelopes WHERE intent = 'fleet.snapshot' AND ts < ?
        AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AEE' AND w.source_id = envelopes.id)
      LIMIT ${Number(batchSize) | 0})
  `);
  const oldStmt = aeeDb.prepare(`
    DELETE FROM envelopes WHERE rowid IN (
      SELECT rowid FROM envelopes WHERE ts < ?
        AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AEE'  AND w.source_id = envelopes.id)
        AND NOT EXISTS (SELECT 1 FROM warddb.ward_entries w WHERE w.source_kind='AOCL' AND w.source_id = envelopes.id)
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
  const oldDeleted = await drain(oldStmt, chatCutoff);
  return { fleetDeleted, oldDeleted, batches };
}

module.exports = { yieldToEventLoop, pruneAeeBatched };
