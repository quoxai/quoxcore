/**
 * QuoxChat Daily Cap Store — QCL-SECURITY Phase 3 (P1-1, P1-5b)
 *
 * Generic in-process `key -> count-for-today` counter, used for:
 *   - P1-1: per-(widget, visitor) daily request sub-cap
 *   - P1-5b: per-widget daily volume cap on side-effecting tool calls
 *     (independent of session/conversation_id — the P1-6 partner: a caller
 *     that opens many conversations, or none at all, still shares this
 *     counter, so it can't be bypassed the way the old per-session cap was)
 *
 * Deliberately in-process, same tradeoff already accepted for the per-IP
 * rate limiter and quoxchatSessionStore: a multi-collector deployment gets
 * eventual consistency (each node has its own view) — acceptable for an
 * abuse-cap, worst case an attacker gets `N * collectorCount` calls before
 * the tightest-bound node rejects them. Callers namespace the key
 * (`widgetId`, or `${widgetId}:${visitorId}`) as needed.
 */

'use strict';

const DEFAULT_TTL_MS = 26 * 60 * 60 * 1000; // >24h so "today" entries always outlive the day they're for
const DEFAULT_MAX_ENTRIES = 50_000;

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function createDailyCapStore({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map(); // `${key}::${day}` -> { count, expiresAt }

  function sweep() {
    if (entries.size <= maxEntries) return;
    const overshoot = entries.size - maxEntries;
    let removed = 0;
    for (const k of entries.keys()) {
      entries.delete(k);
      if (++removed >= overshoot) break;
    }
  }

  function mapKey(key, day) {
    return `${key}::${day}`;
  }

  /** Current count for `key` on `day` (defaults to today), without incrementing. */
  function peek(key, day = todayKey()) {
    const entry = entries.get(mapKey(key, day));
    if (!entry || entry.expiresAt <= Date.now()) return 0;
    return entry.count;
  }

  /** Increment and return the new count for `key` on `day` (defaults to today). */
  function increment(key, day = todayKey()) {
    const now = Date.now();
    const mk = mapKey(key, day);
    let entry = entries.get(mk);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + ttlMs };
    } else {
      entries.delete(mk); // re-insert for LRU ordering
    }
    entry.count += 1;
    entries.set(mk, entry);
    sweep();
    return entry.count;
  }

  function reset(key, day = todayKey()) {
    entries.delete(mapKey(key, day));
  }

  function size() { return entries.size; }

  return { peek, increment, reset, size, todayKey, _entries: entries };
}

const defaultStore = createDailyCapStore();

module.exports = {
  createDailyCapStore,
  defaultStore,
  todayKey,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
};
