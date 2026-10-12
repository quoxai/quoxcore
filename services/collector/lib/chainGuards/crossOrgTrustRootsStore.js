'use strict';

const { randomUUID } = require('crypto');

/**
 * createCrossOrgTrustRootsStore({ db, ulid? })
 *
 * AGH-CHAIN-3: Factory that returns a trust-roots store backed by the injected
 * better-sqlite3 Database. Stores admin-configured cross-org trust relationships.
 *
 * Multi-tenant: every query filters by org_id.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db  — better-sqlite3 Database instance
 * @param {function} [opts.ulid]                        — optional ID generator; falls back to crypto.randomUUID
 */
function createCrossOrgTrustRootsStore({ db, ulid }) {
  const generateId = typeof ulid === 'function' ? ulid : () => randomUUID();

  function init() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cross_org_trust_roots (
        row_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        counterparty_org_id TEXT NOT NULL,
        counterparty_name TEXT NOT NULL,
        pubkey TEXT,
        added_at INTEGER NOT NULL,
        removed_at INTEGER,
        UNIQUE (org_id, counterparty_org_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trust_roots_org ON cross_org_trust_roots(org_id);
      CREATE INDEX IF NOT EXISTS idx_trust_roots_name ON cross_org_trust_roots(org_id, counterparty_name);
    `);
  }

  /**
   * Upsert a trust root entry.
   *
   * @param {object} params
   * @param {string} params.orgId
   * @param {string} params.counterpartyOrgId
   * @param {string} params.counterpartyName
   * @param {string} [params.pubkey]
   * @returns {string} row_id
   */
  function upsertTrustRoot({ orgId, counterpartyOrgId, counterpartyName, pubkey }) {
    const row_id = generateId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO cross_org_trust_roots
        (row_id, org_id, counterparty_org_id, counterparty_name, pubkey, added_at, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (org_id, counterparty_org_id)
      DO UPDATE SET
        counterparty_name = excluded.counterparty_name,
        pubkey = excluded.pubkey,
        removed_at = NULL
    `).run(row_id, orgId, counterpartyOrgId, counterpartyName, pubkey || null, now);

    // Return the actual row_id (may differ on conflict/update path)
    const row = db.prepare(
      `SELECT row_id FROM cross_org_trust_roots WHERE org_id = ? AND counterparty_org_id = ?`
    ).get(orgId, counterpartyOrgId);
    return row ? row.row_id : row_id;
  }

  /**
   * Find a trust root by counterparty name (case-insensitive) within an org.
   * Returns null if not found or if removed.
   *
   * @param {string} orgId
   * @param {string} counterpartyName
   * @returns {object|null}
   */
  function findByCounterpartyName(orgId, counterpartyName) {
    const row = db.prepare(`
      SELECT * FROM cross_org_trust_roots
      WHERE org_id = ?
        AND lower(counterparty_name) = lower(?)
        AND removed_at IS NULL
      LIMIT 1
    `).get(orgId, counterpartyName);
    return row || null;
  }

  /**
   * Find a trust root by counterparty org_id within an org.
   * Returns null if not found or if removed.
   *
   * @param {string} orgId
   * @param {string} counterpartyOrgId
   * @returns {object|null}
   */
  function findByCounterpartyOrgId(orgId, counterpartyOrgId) {
    const row = db.prepare(`
      SELECT * FROM cross_org_trust_roots
      WHERE org_id = ?
        AND counterparty_org_id = ?
        AND removed_at IS NULL
      LIMIT 1
    `).get(orgId, counterpartyOrgId);
    return row || null;
  }

  /**
   * Soft-remove a trust root (sets removed_at timestamp).
   *
   * @param {string} orgId
   * @param {string} counterpartyOrgId
   */
  function removeTrustRoot(orgId, counterpartyOrgId) {
    db.prepare(`
      UPDATE cross_org_trust_roots
      SET removed_at = ?
      WHERE org_id = ? AND counterparty_org_id = ?
    `).run(Date.now(), orgId, counterpartyOrgId);
  }

  return { init, upsertTrustRoot, findByCounterpartyName, findByCounterpartyOrgId, removeTrustRoot };
}

module.exports = { createCrossOrgTrustRootsStore };
