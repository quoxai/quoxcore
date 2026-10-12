'use strict';

/**
 * devSupervisorTurnsStore.js — QP-DASH P1 (DEVSUITE-DEVMODE phase 16):
 * per-turn receipts for the headless resident supervisor.
 *
 * Why: the 2026-08-23 backlog churn (~$6 of stale re-answers on .131) was
 * invisible server-side; nothing could show turns happening or what they
 * cost. One row per ATTEMPTED turn, whatever the outcome. Receipts, not
 * conversation truth: the slot message cache and the Matrix room stay the
 * record of what was said, this table records what it cost.
 *
 * Same DI shape as devSlotMessagesStore.js: bound to a db handle via
 * createDevSupervisorTurnsStore so tests run against a throwaway
 * better-sqlite3 db (migration 021-dev-supervisor-turns.sql).
 */

const crypto = require('crypto');

const OUTCOMES = new Set(['replied', 'timeout', 'error', 'stale_skipped', 'rate_limited', 'silent_held_by_other']);

function newTurnId() {
  return `turn_${crypto.randomBytes(12).toString('hex')}`;
}

function createDevSupervisorTurnsStore({ getDb, now = () => new Date().toISOString() } = {}) {
  if (typeof getDb !== 'function') throw new Error('createDevSupervisorTurnsStore: getDb function is required');

  function db() {
    const handle = getDb();
    if (!handle) throw new Error('devSupervisorTurnsStore: db not available');
    return handle;
  }

  function recordTurn({
    orgId, hostId, slotName, messageId, messageFrom,
    outcome, replyChars, costUsd, durationMs, errorNote, sessionId,
  } = {}) {
    if (!orgId) throw new Error('recordTurn: orgId is required');
    if (!hostId) throw new Error('recordTurn: hostId is required');
    if (!outcome || !OUTCOMES.has(outcome)) {
      throw new Error(`recordTurn: outcome is required and must be one of ${[...OUTCOMES].join(', ')}`);
    }
    const id = newTurnId();
    db().prepare(`
      INSERT INTO dev_supervisor_turns
        (id, org_id, host_id, slot_name, message_id, message_from, outcome,
         reply_chars, cost_usd, duration_ms, error_note, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, hostId, slotName || null, messageId || null, messageFrom || null, outcome,
      Number.isFinite(replyChars) ? replyChars : null,
      Number.isFinite(costUsd) ? costUsd : null,
      Number.isFinite(durationMs) ? durationMs : null,
      errorNote || null, sessionId || null, now(),
    );
    return db().prepare('SELECT * FROM dev_supervisor_turns WHERE id = ?').get(id);
  }

  // Newest-first: the dashboard health panel and `turns` CLI both lead with
  // the most recent spend. `since` is an ISO-8601 created_at cutoff
  // (exclusive), `limit` caps the page (default 50, max 500).
  function listTurns({ orgId, hostId, since, limit } = {}) {
    if (!orgId || !hostId) throw new Error('listTurns: orgId and hostId are required');
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    const params = [orgId, hostId];
    let where = 'org_id = ? AND host_id = ?';
    if (since) {
      where += ' AND created_at > ?';
      params.push(since);
    }
    return db().prepare(`
      SELECT * FROM dev_supervisor_turns WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...params, cap);
  }

  function summarize({ orgId, hostId, since } = {}) {
    if (!orgId || !hostId) throw new Error('summarize: orgId and hostId are required');
    const params = [orgId, hostId];
    let where = 'org_id = ? AND host_id = ?';
    if (since) {
      where += ' AND created_at > ?';
      params.push(since);
    }
    const row = db().prepare(`
      SELECT COUNT(*) AS turns,
             SUM(CASE WHEN outcome = 'replied' THEN 1 ELSE 0 END) AS replied,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM dev_supervisor_turns WHERE ${where}
    `).get(...params);
    return { turns: row.turns, replied: row.replied || 0, total_cost_usd: row.total_cost_usd };
  }

  return { recordTurn, listTurns, summarize };
}

module.exports = { createDevSupervisorTurnsStore };
