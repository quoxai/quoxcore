'use strict';

const { randomUUID } = require('crypto');

/**
 * createPromiseStore({ db, ulid? })
 *
 * Factory that returns a promise store backed by the injected better-sqlite3 Database.
 * Does NOT open its own connection.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db  — better-sqlite3 Database instance
 * @param {function} [opts.ulid]                        — optional ID generator; falls back to crypto.randomUUID
 */
function createPromiseStore({ db, ulid }) {
  const generateId = typeof ulid === 'function' ? ulid : () => randomUUID();

  // quox#635: if the backing DB failed to open (e.g. volt.db on an unwritable
  // volume), every method here dereferences a null db. init() did so UNCAUGHT
  // at boot, killing the collector — the 2026-08-30 restart-storm class (fatal
  // boot check + Restart=always = CPU bomb). The sibling stores degrade
  // gracefully (their init is wrapped in try/catch at the call site; the AEE
  // chain walker is a `aeeDb ? create : null` guard). Match that: return a safe
  // no-op store so the collector boots with promise-chain guards disabled
  // instead of crash-looping. Every consumer already tolerates a disabled
  // chain-guard dep (aeeChainWalker is passed the same way and can be null).
  if (!db) {
    console.warn('[AGH-CHAIN] promise store disabled: no database handle (volt.db unavailable) — promise-chain guards off, collector still boots');
    return {
      init() {},
      persist() { return null; },
      getRecentForConversation() { return []; },
      getById() { return undefined; },
      markFulfilled() {},
      countOpenPromisesByAgentInWindow() { return 0; },
    };
  }

  function init() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chain_promises (
        promise_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT,
        agent_id TEXT,
        turn_id TEXT,
        promise_text TEXT NOT NULL,
        inferred_skill TEXT,
        inferred_target TEXT,
        inferred_when TEXT,
        language TEXT NOT NULL CHECK (language IN ('en','es')),
        created_at INTEGER NOT NULL,
        due_at INTEGER,
        fulfilled INTEGER,
        fulfilled_envelope_id TEXT,
        fulfilled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chain_promises_conv ON chain_promises(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chain_promises_org ON chain_promises(org_id);
    `);
  }

  /**
   * Persist a new promise row.
   *
   * @param {object} envelope
   * @param {string} envelope.conversation_id
   * @param {string} envelope.org_id
   * @param {string} [envelope.user_id]
   * @param {string} [envelope.agent_id]
   * @param {string} [envelope.turn_id]
   * @param {string} envelope.promise_text
   * @param {{ skill: string, target?: string|null, when?: string|null }} envelope.inferred_action
   * @param {string} envelope.language  — 'en' | 'es'
   * @param {number} [envelope.due_at]
   * @returns {string} promise_id
   */
  function persist(envelope) {
    const promise_id = generateId();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO chain_promises
        (promise_id, conversation_id, org_id, user_id, agent_id, turn_id,
         promise_text, inferred_skill, inferred_target, inferred_when,
         language, created_at, due_at, fulfilled, fulfilled_envelope_id, fulfilled_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `);
    stmt.run(
      promise_id,
      envelope.conversation_id,
      envelope.org_id,
      envelope.user_id || null,
      envelope.agent_id || null,
      envelope.turn_id || null,
      envelope.promise_text,
      envelope.inferred_action ? (envelope.inferred_action.skill || null) : null,
      envelope.inferred_action ? (envelope.inferred_action.target || null) : null,
      envelope.inferred_action ? (envelope.inferred_action.when || null) : null,
      envelope.language,
      now,
      envelope.due_at || null
    );
    return promise_id;
  }

  /**
   * Retrieve recent promises for a conversation.
   *
   * Multi-tenant invariant: always filters by conversation_id.
   *
   * @param {string} corrId
   * @param {{ limit?: number, windowMs?: number, onlyOpen?: boolean }} [opts]
   * @returns {object[]}
   */
  function getRecentForConversation(corrId, opts = {}) {
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const windowMs = opts.windowMs !== undefined ? opts.windowMs : 7 * 24 * 3600 * 1000;
    const onlyOpen = opts.onlyOpen !== undefined ? opts.onlyOpen : true;
    const since = Date.now() - windowMs;

    let sql = `
      SELECT * FROM chain_promises
      WHERE conversation_id = ?
        AND created_at >= ?
    `;
    const params = [corrId, since];

    if (onlyOpen) {
      sql += ` AND fulfilled IS NULL`;
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Get a single promise by ID.
   *
   * @param {string} promise_id
   * @returns {object|undefined}
   */
  function getById(promise_id) {
    return db.prepare(`SELECT * FROM chain_promises WHERE promise_id = ?`).get(promise_id);
  }

  /**
   * Mark a promise as fulfilled.
   *
   * @param {string} promise_id
   * @param {string} envelope_id
   * @param {number} ts  — Unix ms
   */
  function markFulfilled(promise_id, envelope_id, ts) {
    db.prepare(`
      UPDATE chain_promises
      SET fulfilled = 1,
          fulfilled_envelope_id = ?,
          fulfilled_at = ?
      WHERE promise_id = ?
    `).run(envelope_id, ts, promise_id);
  }

  /**
   * Count open (unfulfilled) promises for a specific agent within a time window.
   *
   * Multi-tenant invariant: filters by BOTH org_id AND agent_id.
   *
   * @param {string} orgId
   * @param {string} agentId
   * @param {number} sinceTs  — Unix ms (matches created_at INTEGER column)
   * @returns {number}
   */
  function countOpenPromisesByAgentInWindow(orgId, agentId, sinceTs) {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM chain_promises
      WHERE org_id = ?
        AND agent_id = ?
        AND created_at >= ?
        AND fulfilled IS NULL
    `).get(orgId, agentId, sinceTs);
    return row ? (row.n || 0) : 0;
  }

  return { init, persist, getRecentForConversation, getById, markFulfilled, countOpenPromisesByAgentInWindow };
}

module.exports = { createPromiseStore };
