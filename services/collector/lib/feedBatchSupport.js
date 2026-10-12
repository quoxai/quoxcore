/**
 * feedBatchSupport.js, shared helpers for the BRAIN2-W5 feed completeness
 * fixes (memory / wisdom / notion / gdrive / git / quoxplan / docs / db).
 *
 * Three small, source-agnostic pieces, all built on the durable feed
 * watermark store (feedWatermark.js) and brainFeedClient.pushDeletions:
 *
 *  - resolveStateStore: the durable `{get,set}` store a source may use for
 *    manifests and retry counters. null when a test injected its own
 *    watermark fns without a dbPath (so nothing touches the real store).
 *  - reconcileDeletions: full-snapshot manifest diff -> explicit tombstones.
 *    Only ever called with a COMPLETE, error-free snapshot.
 *  - createFailureGuard: per-item retry budget so a held cursor (hold at the
 *    first failed item) cannot be pinned forever by one poison item.
 *  - readCapped: byte-limited response body read (cap applies while
 *    streaming, not after the whole body is in memory).
 */

'use strict';

const feedSweep = require('./feedSweep.js');
const brainFeedClient = require('./brainFeedClient.js');

const MAX_ITEM_ATTEMPTS = 5;

function resolveStateStore(deps = {}, hasInjectedWatermark = false) {
  if (deps.stateStore) return deps.stateStore;
  if (deps.dbPath || !hasInjectedWatermark) return feedSweep.defaultStore(deps.dbPath);
  return null;
}

async function readJson(store, orgId, key) {
  try {
    const raw = await store.get(orgId, key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Diffs the previous manifest against this tick's COMPLETE snapshot and
 * tombstones what disappeared. The manifest only advances once tombstones
 * were accepted, so a failed push retries next tick. First pass (no manifest)
 * sends nothing.
 *
 * @param {object} o
 * @param {{get:Function,set:Function}|null} o.store
 * @param {string} o.orgId
 * @param {string} o.key         manifest namespace (`<watermarkKey>`)
 * @param {string[]} o.seen      relPaths present at the source right now
 * @param {boolean} o.complete   snapshot covers the whole source with no errors
 * @param {Function} o.ensureVault  async () => vaultId|null
 * @param {Function} [o.pushDeletionsFn]
 * @param {object} [o.pushOpts]
 * @returns {Promise<{deleted:number, error:string|null}>}
 */
async function reconcileDeletions(o) {
  const res = { deleted: 0, error: null };
  const { store, orgId, key, seen, complete, ensureVault, pushDeletionsFn = brainFeedClient.pushDeletions, pushOpts = {} } = o;
  if (!store || !complete || !Array.isArray(seen)) return res;
  const manifestKey = `${key}:manifest`;
  const prev = await readJson(store, orgId, manifestKey);
  const seenSet = new Set(seen);
  if (Array.isArray(prev)) {
    const gone = prev.filter((p) => !seenSet.has(p));
    if (gone.length > 0) {
      const vaultId = await ensureVault();
      if (!vaultId) { res.error = 'ensurePushVault returned no vaultId (tombstones not sent)'; return res; }
      const r = await pushDeletionsFn(orgId, vaultId, gone, pushOpts);
      if (r?.error) { res.error = `tombstones failed, ${r.error}`; return res; }
      res.deleted = gone.length;
    }
  }
  try { await store.set(orgId, manifestKey, JSON.stringify([...seenSet].sort())); } catch { /* retried next tick */ }
  return res;
}

/**
 * Retry budget for hold-at-first-failure. record(id) counts a failed attempt;
 * shouldSkip(id) is true once an item failed MAX_ITEM_ATTEMPTS ticks in a
 * row (it is then passed over, loudly, so one poison item cannot starve the
 * whole source). clear(id) on success. Persisted so the budget survives
 * restarts; a null store degrades to "never skip, never persist".
 */
async function createFailureGuard(store, orgId, key, { maxAttempts = MAX_ITEM_ATTEMPTS } = {}) {
  const failKey = `${key}:fails`;
  const counts = store ? (await readJson(store, orgId, failKey)) || {} : {};
  let dirty = false;
  return {
    shouldSkip(id) { return (counts[id] || 0) >= maxAttempts; },
    record(id) { counts[id] = (counts[id] || 0) + 1; dirty = true; return counts[id]; },
    clear(id) { if (id in counts) { delete counts[id]; dirty = true; } },
    async flush() {
      if (!store || !dirty) return;
      try { await store.set(orgId, failKey, Object.keys(counts).length ? JSON.stringify(counts) : ''); } catch { /* best effort */ }
      dirty = false;
    },
  };
}

/**
 * Reads at most maxBytes of a fetch Response body. Streams when the body is a
 * web ReadableStream (cancelling the rest of the download), otherwise falls
 * back to text() for minimal mocks.
 * @returns {Promise<string>}
 */
async function readCapped(res, maxBytes) {
  const body = res?.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await res.text();
    return Buffer.byteLength(t, 'utf8') > maxBytes ? Buffer.from(t, 'utf8').subarray(0, maxBytes).toString('utf8') : t;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      const room = maxBytes - total;
      if (buf.length >= room) {
        chunks.push(buf.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { resolveStateStore, reconcileDeletions, createFailureGuard, readCapped, MAX_ITEM_ATTEMPTS };
