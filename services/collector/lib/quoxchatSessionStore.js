/**
 * QuoxChat Session Store — CW-9.8
 *
 * Tracks per-tool invocation counters bound to a conversation_id so
 * rate_limit_per_session actually bounds a *session* — not just a single
 * chat round. Before CW-9.8 the counter lived on the stack, reset to zero
 * between messages, letting a determined caller burn through tool quota
 * message-by-message.
 *
 * Design:
 *   - In-process Map<conversation_id, { [toolId]: count, lastTouched }>.
 *   - TTL eviction on lookup (default 2h) so we don't leak memory.
 *   - Soft cap on total keys — evict oldest if we hit it.
 *   - Anonymous sessions (no conversation_id) fall back to per-round counting
 *     via a caller-supplied Map.
 *
 * This is deliberately in-process. A multi-collector deployment gets
 * eventual consistency (each node has its own view); that's acceptable for
 * a rate limit — worst case an attacker gets `N * collectorCount` calls
 * before the tightest-bound node rejects them.
 */

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_ENTRIES = 10_000;

function createSessionStore({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map(); // conversation_id -> { counts: Map<toolId, number>, expiresAt }

  function sweep() {
    if (entries.size <= maxEntries) return;
    // Evict in insertion order — Map preserves insertion order, and we touch
    // entries on each call, so the front of the map is the least-recently-used.
    const overshoot = entries.size - maxEntries;
    let removed = 0;
    for (const key of entries.keys()) {
      entries.delete(key);
      if (++removed >= overshoot) break;
    }
  }

  function touch(conversationId) {
    if (!conversationId) return null;
    const now = Date.now();
    let entry = entries.get(conversationId);
    if (entry && entry.expiresAt <= now) {
      entries.delete(conversationId);
      entry = null;
    }
    if (!entry) {
      entry = { counts: new Map(), expiresAt: now + ttlMs };
      entries.set(conversationId, entry);
    } else {
      // Move to tail (LRU) by re-inserting.
      entries.delete(conversationId);
      entry.expiresAt = now + ttlMs;
      entries.set(conversationId, entry);
    }
    sweep();
    return entry;
  }

  /**
   * Check whether invoking `toolId` in `conversationId` is permitted under
   * `limit`. Increments the counter only on `ok: true`. Returns { ok, used, limit }.
   */
  function checkAndIncrement(conversationId, toolId, limit) {
    if (!Number.isFinite(limit) || limit <= 0) return { ok: true, used: 0, limit: null };
    const entry = touch(conversationId);
    if (!entry) return { ok: true, used: 0, limit }; // no conversation — can't track cross-round
    const used = entry.counts.get(toolId) || 0;
    if (used >= limit) return { ok: false, used, limit };
    entry.counts.set(toolId, used + 1);
    return { ok: true, used: used + 1, limit };
  }

  function reset(conversationId) { if (conversationId) entries.delete(conversationId); }

  function size() { return entries.size; }

  return { checkAndIncrement, reset, size, _entries: entries };
}

// Singleton used by the chat pipeline. Tests construct their own via createSessionStore.
const defaultStore = createSessionStore();

module.exports = {
  createSessionStore,
  defaultStore,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
};
