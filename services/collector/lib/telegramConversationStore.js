/**
 * Telegram Conversation Store
 *
 * LRU conversation history for Telegram webhook sessions, keyed by
 * Telegram chat_id. Same public API as before this store gained
 * persistence (getHistory/addTurn/clear/size), so telegramWebhook.js and
 * its tests are unaffected.
 *
 * CORECOMMS-PERSIST: write-through durability. The in-memory Map remains
 * the hot-path read/write cache (no per-message DB round trip on the
 * request path beyond the write-through itself), but channelConversationStore
 * (services/collector/lib/channelConversationStore.js, its own SQLite
 * file) is now the source of truth: every addTurn/clear also writes
 * through to the durable channel_conversations table, and a fresh
 * instance reseeds its in-memory cache from that table on construction so
 * conversation threading survives a collector restart instead of
 * resetting to empty.
 *
 * Fail-soft by design: every durable read/write is wrapped in try/catch.
 * A DB failure (disk full, permissions, corrupt file) never throws out of
 * addTurn/getHistory/clear, it just logs a warning and leaves the
 * in-memory Map, already updated, as the answer for this process. A live
 * Telegram bridge must never break because the durability layer had a bad
 * moment.
 *
 * Lazy TTL eviction on access (no timers).
 * LRU: oldest lastActivity evicted when at capacity.
 */

const channelConversationStore = require('./channelConversationStore');

const CHANNEL_TYPE = 'telegram';

class TelegramConversationStore {
  constructor({ maxConversations = 500, maxTurns = 10, ttlMs = 3600000 } = {}) {
    this.maxConversations = maxConversations;
    this.maxTurns = maxTurns;
    this.ttlMs = ttlMs;
    this._store = new Map(); // chatId -> { turns: [{role, content}], lastActivity: number }
    this._reseedFromDurableStore();
  }

  /**
   * Boot reseed: pull recent durable rows for this channel type back into
   * the in-memory cache, so a freshly-constructed store (e.g. after a
   * collector restart) does not start cold. Fail-soft: any error here just
   * leaves the cache empty, identical to the pre-persistence behavior.
   */
  _reseedFromDurableStore() {
    try {
      const rows = channelConversationStore.listByChannelType(CHANNEL_TYPE, { limit: this.maxConversations });
      for (const row of rows) {
        if (!row || !Array.isArray(row.turns) || row.turns.length === 0) continue;
        this._store.set(row.external_id, {
          turns: row.turns.slice(-this.maxTurns),
          lastActivity: row.last_activity,
        });
      }
    } catch (err) {
      console.warn('[TelegramConversationStore] boot reseed failed, starting with an empty cache:', err.message);
    }
  }

  /**
   * Get conversation history for a chat, formatted for /chat/claude.
   * Returns empty array if expired or not found.
   */
  getHistory(chatId) {
    const key = String(chatId);
    const entry = this._store.get(key);
    if (!entry) return [];

    // Lazy TTL check
    if (Date.now() - entry.lastActivity > this.ttlMs) {
      this._store.delete(key);
      this._persistClear(key);
      return [];
    }

    return [...entry.turns];
  }

  /**
   * Add a turn to the conversation history.
   * @param {string|number} chatId
   * @param {'user'|'assistant'} role
   * @param {string} content
   */
  addTurn(chatId, role, content) {
    const key = String(chatId);
    let entry = this._store.get(key);

    if (!entry || (Date.now() - entry.lastActivity > this.ttlMs)) {
      entry = { turns: [], lastActivity: Date.now() };
    }

    entry.turns.push({ role, content });

    // Trim oldest turns if over limit
    if (entry.turns.length > this.maxTurns) {
      entry.turns = entry.turns.slice(-this.maxTurns);
    }

    entry.lastActivity = Date.now();
    this._store.set(key, entry);

    // Evict LRU if over capacity
    if (this._store.size > this.maxConversations) {
      this._evictOldest();
    }

    this._persistUpsert(key, entry);
  }

  /**
   * Clear conversation history for a chat.
   */
  clear(chatId) {
    const key = String(chatId);
    this._store.delete(key);
    this._persistClear(key);
  }

  get size() {
    return this._store.size;
  }

  /**
   * Evict the entry with the oldest lastActivity.
   */
  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._store) {
      if (entry.lastActivity < oldestTime) {
        oldestTime = entry.lastActivity;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._store.delete(oldestKey);
      this._persistClear(oldestKey);
    }
  }

  /**
   * Write-through upsert. Never throws: a durable-store failure logs a
   * warning and leaves the already-updated in-memory Map as the answer for
   * this process, so a live reply is never blocked on persistence.
   */
  _persistUpsert(externalId, entry) {
    try {
      channelConversationStore.upsertConversation({
        channel_type: CHANNEL_TYPE,
        external_id: externalId,
        turns: entry.turns,
        last_activity: entry.lastActivity,
      });
    } catch (err) {
      console.warn(`[TelegramConversationStore] durable write failed for chat ${externalId}, continuing in-memory only:`, err.message);
    }
  }

  _persistClear(externalId) {
    try {
      channelConversationStore.clearConversation(CHANNEL_TYPE, externalId);
    } catch (err) {
      console.warn(`[TelegramConversationStore] durable clear failed for chat ${externalId}:`, err.message);
    }
  }
}

module.exports = { TelegramConversationStore };
