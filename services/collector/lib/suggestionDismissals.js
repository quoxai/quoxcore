/**
 * suggestionDismissals.js
 *
 * SQLite persistence for Quox Brain suggestion dismissals.
 * Dismissals are per-org (not per-user) — all users in an org see the
 * same dismissal state (out-of-scope per spec: "per-org for now").
 *
 * Table: suggestion_dismissals
 *   id            TEXT PRIMARY KEY
 *   org_id        TEXT NOT NULL
 *   user_id       TEXT NOT NULL
 *   suggestion_id TEXT NOT NULL
 *   dismissed_at  TEXT (ISO)
 *   expires_at    TEXT (ISO)
 *
 * UNIQUE constraint on (org_id, suggestion_id) ensures upsert semantics.
 */

const { randomUUID } = require('crypto');

const DISMISSAL_TTL_DAYS = 7;

// ── Schema ─────────────────────────────────────────────────────────────────

function initSuggestionDismissals(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestion_dismissals (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      user_id       TEXT NOT NULL DEFAULT '',
      suggestion_id TEXT NOT NULL,
      dismissed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      UNIQUE(org_id, suggestion_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sd_org ON suggestion_dismissals(org_id);
    CREATE INDEX IF NOT EXISTS idx_sd_expires ON suggestion_dismissals(expires_at);
  `);
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Record a dismissal. Upserts on (org_id, suggestion_id) — re-dismissing
 * resets the 7-day clock.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ orgId: string, userId: string, suggestionId: string }} params
 */
function dismissSuggestion(db, { orgId, userId = '', suggestionId }) {
  const id = randomUUID();
  const now = new Date();
  const dismissedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + DISMISSAL_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  db.prepare(`
    INSERT INTO suggestion_dismissals (id, org_id, user_id, suggestion_id, dismissed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, suggestion_id) DO UPDATE SET
      user_id      = excluded.user_id,
      dismissed_at = excluded.dismissed_at,
      expires_at   = excluded.expires_at
  `).run(id, orgId, userId, suggestionId, dismissedAt, expiresAt);
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Check if there is an active (non-expired) dismissal for this suggestion.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} suggestionId
 * @returns {boolean}
 */
function isActiveDismissal(db, orgId, suggestionId) {
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT 1 FROM suggestion_dismissals
    WHERE org_id = ? AND suggestion_id = ? AND expires_at > ?
    LIMIT 1
  `).get(orgId, suggestionId, now);
  return !!row;
}

/**
 * Filter an array of suggestions, removing any with active dismissals.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {Array<{ id: string }>} suggestions
 * @returns {Array}
 */
function filterDismissed(db, orgId, suggestions) {
  if (!suggestions || suggestions.length === 0) return [];
  return suggestions.filter((s) => !isActiveDismissal(db, orgId, s.id));
}

module.exports = {
  initSuggestionDismissals,
  dismissSuggestion,
  isActiveDismissal,
  filterDismissed,
};
