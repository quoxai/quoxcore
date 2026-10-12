/**
 * snapshotService.js — Terminal workspace snapshot persistence
 *
 * Stores workspace layout + buffered terminal output as shareable snapshots.
 * Snapshots are encrypted at rest and expire after a configurable TTL.
 *
 * Used by Phase 5.5b: Share Session Snapshot.
 */

const { randomBytes } = require('crypto');
const { encryptField, decryptField } = require('../utils/fieldEncryption');

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_SNAPSHOTS_PER_USER = 20;
const SHARE_ID_BYTES = 6; // 12 hex chars

class SnapshotService {
  /**
   * @param {import('better-sqlite3').Database} db - SQLite database instance
   */
  constructor(db) {
    this.db = db;
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        org_id TEXT DEFAULT 'default',
        title TEXT NOT NULL DEFAULT 'Shared',
        layout TEXT NOT NULL,
        panes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snap_user ON terminal_snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_snap_expires ON terminal_snapshots(expires_at);
    `);
  }

  _prepareStatements() {
    this._insert = this.db.prepare(`
      INSERT INTO terminal_snapshots (id, user_id, org_id, title, layout, panes, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getById = this.db.prepare(
      'SELECT * FROM terminal_snapshots WHERE id = ?'
    );

    this._deleteById = this.db.prepare(
      'DELETE FROM terminal_snapshots WHERE id = ? AND user_id = ?'
    );

    this._countByUser = this.db.prepare(
      'SELECT COUNT(*) as count FROM terminal_snapshots WHERE user_id = ?'
    );

    this._deleteExpired = this.db.prepare(
      'DELETE FROM terminal_snapshots WHERE expires_at < ?'
    );

    this._listByUser = this.db.prepare(
      'SELECT id, title, layout, created_at, expires_at FROM terminal_snapshots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50'
    );
  }

  /**
   * Generate a short share ID (12 hex chars)
   */
  _generateId() {
    return randomBytes(SHARE_ID_BYTES).toString('hex');
  }

  /**
   * Create a snapshot from workspace state + session buffers.
   *
   * @param {object} params
   * @param {string} params.userId - Authenticated user ID
   * @param {string} params.orgId - Org ID from JWT
   * @param {string} params.title - Workspace name
   * @param {string} params.layout - Layout ID (single, split-h, etc.)
   * @param {Array} params.panes - Pane configs with buffered output
   * @param {number} [params.ttlMs] - TTL in milliseconds
   * @returns {{ shareId: string, expiresAt: string } | { error: string }}
   */
  create({ userId, orgId, title, layout, panes, ttlMs }) {
    // Rate limit: max snapshots per user
    const { count } = this._countByUser.get(userId);
    if (count >= MAX_SNAPSHOTS_PER_USER) {
      return { error: 'snapshot_limit', message: `Max ${MAX_SNAPSHOTS_PER_USER} snapshots per user. Delete old ones first.` };
    }

    const shareId = this._generateId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (ttlMs || DEFAULT_TTL_MS)).toISOString();

    // Encrypt pane data (contains terminal output which may have secrets)
    const panesJson = JSON.stringify(panes);
    const encryptedPanes = encryptField(panesJson);

    this._insert.run(shareId, userId, orgId || 'default', title || 'Shared', layout, encryptedPanes, now, expiresAt);

    return { shareId, expiresAt };
  }

  /**
   * Get a snapshot by share ID. Returns null if not found or expired.
   * No auth required — share URLs are public read-only.
   *
   * @param {string} shareId
   * @returns {object|null}
   */
  get(shareId) {
    const row = this._getById.get(shareId);
    if (!row) return null;

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      // Expired — clean up and return null
      this._deleteById.run(shareId, row.user_id);
      return null;
    }

    // Decrypt panes
    const panesJson = decryptField(row.panes);
    if (!panesJson) return null;

    let panes;
    try {
      panes = JSON.parse(panesJson);
    } catch {
      return null;
    }

    return {
      shareId: row.id,
      title: row.title,
      layout: row.layout,
      panes,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Delete a snapshot. Only the owner can delete.
   *
   * @param {string} shareId
   * @param {string} userId
   * @returns {boolean} true if deleted
   */
  delete(shareId, userId) {
    const result = this._deleteById.run(shareId, userId);
    return result.changes > 0;
  }

  /**
   * List snapshots for a user (metadata only, no pane data).
   *
   * @param {string} userId
   * @returns {Array}
   */
  listByUser(userId) {
    return this._listByUser.all(userId);
  }

  /**
   * Clean up expired snapshots. Call periodically.
   * @returns {number} Number of deleted rows
   */
  cleanup() {
    const result = this._deleteExpired.run(new Date().toISOString());
    return result.changes;
  }
}

module.exports = SnapshotService;
