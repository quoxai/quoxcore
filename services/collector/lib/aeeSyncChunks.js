'use strict';
/**
 * Chunked, event-loop-yielding batch insert for POST /aee/sync (quox#777).
 * One giant synchronous better-sqlite3 transaction blocked the loop ~4s.
 * Rows are applied in order, CHUNK_SIZE per transaction, yielding via
 * setImmediate between chunks. Earlier chunks stay committed if a later one
 * throws (each insert is idempotent-by-id upstream; the caller returns 500).
 */
const DEFAULT_CHUNK_SIZE = 200;

async function runChunked(db, items, applyOne, { chunkSize = DEFAULT_CHUNK_SIZE, yieldFn } = {}) {
  const doYield = yieldFn || (() => new Promise((r) => setImmediate(r)));
  const applyChunk = db.transaction((slice) => {
    for (const item of slice) applyOne(item);
  });
  for (let i = 0; i < items.length; i += chunkSize) {
    applyChunk(items.slice(i, i + chunkSize));
    if (i + chunkSize < items.length) await doYield();
  }
}

module.exports = { runChunked, DEFAULT_CHUNK_SIZE };
