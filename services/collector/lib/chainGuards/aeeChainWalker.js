'use strict';

/**
 * createAeeChainWalker({ db })
 *
 * AGH-CHAIN-2: Factory that returns a walker backed by the injected better-sqlite3
 * Database. Reads agent envelopes from the AEE envelopes table for a given corr
 * (conversation) within a bounded lookback window.
 *
 * Performance caps are BAKED IN and defensive — callers cannot accidentally
 * trigger a slow scan by passing large limits or wide windows.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 */
function createAeeChainWalker({ db }) {
  const MAX_LIMIT = 50;
  const MAX_WINDOW_MS = 2 * 3600 * 1000; // 2 hours

  /**
   * Find agent envelopes in a bounded lookback window.
   *
   * Returns envelopes where corr matches, from = 'agent.<agentIdLowercase>',
   * and ts >= effective sinceTs (clamped to at most 2h ago).
   *
   * Both limit and windowMs are clamped defensively regardless of caller values.
   *
   * @param {string} corrId           — conversation ID (org boundary)
   * @param {string} agentIdLowercase — agent id (e.g. 'sentinel') — "agent." prefix added internally
   * @param {string} sinceIsoTs       — caller's requested since timestamp (ISO 8601)
   * @param {{ limit?: number, windowMs?: number }} [opts]
   * @returns {{ id: string, ts: string, type: string, intent: string, from: string, to: string }[]}
   */
  function findAgentEnvelopesInWindow(corrId, agentIdLowercase, sinceIsoTs, opts = {}) {
    // Defensive cap: limit clamped to MAX_LIMIT
    const effectiveLimit = Math.min(
      opts.limit !== undefined ? opts.limit : MAX_LIMIT,
      MAX_LIMIT
    );

    // Defensive cap: window clamped to MAX_WINDOW_MS
    const effectiveWindowMs = Math.min(
      opts.windowMs !== undefined ? opts.windowMs : MAX_WINDOW_MS,
      MAX_WINDOW_MS
    );

    // The earliest ts we'll look back to — max(callerSince, now - 2h)
    const nowMinus2h = new Date(Date.now() - effectiveWindowMs).toISOString();
    const effectiveSinceTs = sinceIsoTs > nowMinus2h ? sinceIsoTs : nowMinus2h;

    const fromValue = 'agent.' + agentIdLowercase;

    const sql = `
      SELECT id, ts, type, intent, "from", "to"
      FROM envelopes
      WHERE corr = ?
        AND "from" = ?
        AND ts >= ?
      ORDER BY ts DESC
      LIMIT ?
    `;

    return db.prepare(sql).all(corrId, fromValue, effectiveSinceTs, effectiveLimit);
  }

  /**
   * Find cross-org envelopes in a bounded lookback window.
   *
   * AGH-CHAIN-3: Same defensive caps as findAgentEnvelopesInWindow.
   * Matches envelopes where corr matches and from = 'org.<counterpartyOrgId>'.
   *
   * @param {string} corrId               — conversation ID (org boundary)
   * @param {string} counterpartyOrgId    — counterparty org id — "org." prefix added internally
   * @param {string} sinceIsoTs           — caller's requested since timestamp (ISO 8601)
   * @param {{ limit?: number, windowMs?: number }} [opts]
   * @returns {{ id: string, ts: string, type: string, intent: string, from: string, to: string }[]}
   */
  function findOrgEnvelopesInWindow(corrId, counterpartyOrgId, sinceIsoTs, opts = {}) {
    // Defensive cap: limit clamped to MAX_LIMIT
    const effectiveLimit = Math.min(
      opts.limit !== undefined ? opts.limit : MAX_LIMIT,
      MAX_LIMIT
    );

    // Defensive cap: window clamped to MAX_WINDOW_MS
    const effectiveWindowMs = Math.min(
      opts.windowMs !== undefined ? opts.windowMs : MAX_WINDOW_MS,
      MAX_WINDOW_MS
    );

    // The earliest ts we'll look back to — max(callerSince, now - 2h)
    const nowMinus2h = new Date(Date.now() - effectiveWindowMs).toISOString();
    const effectiveSinceTs = sinceIsoTs > nowMinus2h ? sinceIsoTs : nowMinus2h;

    const fromValue = 'org.' + counterpartyOrgId;

    const sql = `
      SELECT id, ts, type, intent, "from", "to"
      FROM envelopes
      WHERE corr = ?
        AND "from" = ?
        AND ts >= ?
      ORDER BY ts DESC
      LIMIT ?
    `;

    return db.prepare(sql).all(corrId, fromValue, effectiveSinceTs, effectiveLimit);
  }

  return { findAgentEnvelopesInWindow, findOrgEnvelopesInWindow };
}

module.exports = { createAeeChainWalker };
