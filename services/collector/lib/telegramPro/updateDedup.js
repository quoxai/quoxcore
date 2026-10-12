/**
 * Telegram Update Dedup, QTG-PRO P0.
 *
 * Telegram retries webhook delivery on any non-200 response, so replays of
 * the same update_id are a guaranteed part of normal operation, not an edge
 * case. This module records seen (bot_id, update_id) pairs durably so a
 * collector restart or multi-instance deployment does not re-process (and
 * therefore re-reply to) the same update twice.
 *
 * Fail-soft rule for THIS module only is the inverse of the usual idiom:
 * on a DB failure, seenBefore() returns false (process the update). Losing
 * dedup coverage for a few seconds is far cheaper than silently dropping a
 * real inbound message because the durable store hiccuped.
 */

'use strict';

const telegramProStore = require('./telegramProStore');

const PRUNE_EVERY_N_INSERTS = 1000;
const DEFAULT_MAX_AGE_MS = 48 * 3600 * 1000; // 48 hours

let _insertCount = 0;
const _warnedOnce = new Set();

function warnOnce(key, message) {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  console.error(message);
}

/**
 * Records (bot_id, update_id) if not already present, atomically.
 *
 * @returns {boolean} true if this update_id was already recorded for this
 *   bot (caller should drop the update as a replay), false if it is new
 *   (caller should process it) OR the durable store is unavailable
 *   (fail open: process it).
 */
function seenBefore({ botId, updateId, dbPath } = {}) {
  if (!botId) throw new Error('seenBefore requires botId');
  if (updateId === undefined || updateId === null) throw new Error('seenBefore requires updateId');

  const db = telegramProStore.getDb(dbPath);
  if (!db) {
    warnOnce(`open:${dbPath || 'default'}`, '[TelegramUpdateDedup] durable store unavailable, failing open (update will be processed)');
    return false;
  }

  try {
    const info = db.prepare(`
      INSERT OR IGNORE INTO telegram_updates_seen (bot_id, update_id, seen_at)
      VALUES (?, ?, ?)
    `).run(botId, updateId, Date.now());

    const alreadySeen = info.changes === 0;

    _insertCount += 1;
    if (!alreadySeen && _insertCount % PRUNE_EVERY_N_INSERTS === 0) {
      pruneOld({ dbPath });
    }

    return alreadySeen;
  } catch (err) {
    console.error(`[TelegramUpdateDedup] seenBefore failed for ${botId}:${updateId}, failing open, ${err.message}`);
    return false;
  }
}

/**
 * Deletes seen-update rows older than olderThanMs. Scoped to a single bot
 * when botId is provided, otherwise prunes across all bots in the store.
 *
 * @returns {boolean} true on a successful prune (or no-op), false if the
 *   store is unavailable or the prune failed.
 */
function pruneOld({ botId, olderThanMs = DEFAULT_MAX_AGE_MS, dbPath } = {}) {
  const db = telegramProStore.getDb(dbPath);
  if (!db) return false;

  const cutoff = Date.now() - olderThanMs;

  try {
    if (botId) {
      db.prepare('DELETE FROM telegram_updates_seen WHERE bot_id = ? AND seen_at < ?').run(botId, cutoff);
    } else {
      db.prepare('DELETE FROM telegram_updates_seen WHERE seen_at < ?').run(cutoff);
    }
    return true;
  } catch (err) {
    console.error(`[TelegramUpdateDedup] pruneOld failed, ${err.message}`);
    return false;
  }
}

/**
 * Test-only escape hatch: reset the opportunistic-prune insert counter so
 * tests exercising the "every N inserts" behavior do not depend on prior
 * test file state.
 */
function _resetInsertCounterForTest() {
  _insertCount = 0;
}

module.exports = {
  seenBefore,
  pruneOld,
  _resetInsertCounterForTest,
  PRUNE_EVERY_N_INSERTS,
  DEFAULT_MAX_AGE_MS,
};
