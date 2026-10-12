/**
 * Contactability persistence (COMMANDERQ P9 / C1+C3).
 *
 * Server-side source of truth (data-persistence ZERO TOLERANCE) for:
 *   - contactability_policy: per (org, recipient, channel) opt-in + quiet hours +
 *     frequency caps. opt_in defaults to 0 (deny-by-default); a signed P4 `consent`
 *     artifact is the immutable evidence that a grant happened, this row is the
 *     queryable state the policy engine reads.
 *   - contact_attempts: a log of contacts actually made (frequency accounting +
 *     evidence). No sender exists yet (P9 is rules-only, "minus audio"), so this
 *     stays empty in production until P10 wires real channels.
 *   - watch_briefs: standing-watch tripwires (C1). Registered propose-only; when a
 *     brief would fire, it must still clear the contactability engine before any
 *     contact — the store never sends.
 *
 * Pure — caller passes the voltDb handle. Reads ALWAYS filter by org_id.
 */

'use strict';

function initContactabilityStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contactability_policy (
      org_id               TEXT NOT NULL,
      recipient            TEXT NOT NULL,
      channel              TEXT NOT NULL,
      opt_in               INTEGER NOT NULL DEFAULT 0,
      basis                TEXT,
      quiet_start          TEXT,
      quiet_end            TEXT,
      tz_offset_minutes    INTEGER DEFAULT 0,
      min_interval_minutes INTEGER DEFAULT 0,
      max_per_day          INTEGER DEFAULT 0,
      consent_artifact_id  TEXT,
      updated_by           TEXT,
      updated_at           TEXT NOT NULL,
      PRIMARY KEY (org_id, recipient, channel)
    );
    CREATE TABLE IF NOT EXISTS contact_attempts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id    TEXT NOT NULL,
      recipient TEXT NOT NULL,
      channel   TEXT NOT NULL,
      ts        TEXT NOT NULL,
      purpose   TEXT,
      made_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_attempts ON contact_attempts (org_id, recipient, channel, ts);
    CREATE TABLE IF NOT EXISTS watch_briefs (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      condition   TEXT NOT NULL,
      channel     TEXT,
      recipient   TEXT,
      status      TEXT NOT NULL DEFAULT 'proposed',
      created_by  TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_briefs_org ON watch_briefs (org_id, status);
  `);
}

function setPolicy(db, p) {
  if (!p || !p.orgId || !p.recipient || !p.channel) return false;
  db.prepare(`
    INSERT INTO contactability_policy
      (org_id, recipient, channel, opt_in, basis, quiet_start, quiet_end, tz_offset_minutes, min_interval_minutes, max_per_day, consent_artifact_id, updated_by, updated_at)
    VALUES (@org_id, @recipient, @channel, @opt_in, @basis, @quiet_start, @quiet_end, @tz_offset_minutes, @min_interval_minutes, @max_per_day, @consent_artifact_id, @updated_by, @updated_at)
    ON CONFLICT(org_id, recipient, channel) DO UPDATE SET
      opt_in=@opt_in, basis=@basis, quiet_start=@quiet_start, quiet_end=@quiet_end,
      tz_offset_minutes=@tz_offset_minutes, min_interval_minutes=@min_interval_minutes,
      max_per_day=@max_per_day, consent_artifact_id=COALESCE(@consent_artifact_id, consent_artifact_id),
      updated_by=@updated_by, updated_at=@updated_at
  `).run({
    org_id: p.orgId, recipient: p.recipient, channel: p.channel,
    opt_in: p.opt_in ? 1 : 0,
    basis: p.basis || null,
    quiet_start: p.quiet_start || null,
    quiet_end: p.quiet_end || null,
    tz_offset_minutes: Number.isFinite(p.tz_offset_minutes) ? p.tz_offset_minutes : 0,
    min_interval_minutes: Number.isFinite(p.min_interval_minutes) ? p.min_interval_minutes : 0,
    max_per_day: Number.isFinite(p.max_per_day) ? p.max_per_day : 0,
    consent_artifact_id: p.consent_artifact_id || null,
    updated_by: p.updated_by || null,
    updated_at: p.updated_at || new Date().toISOString(),
  });
  return true;
}

/** @returns policy in the engine's shape (opt_in as boolean), or null. */
function getPolicy(db, orgId, recipient, channel) {
  if (!orgId || !recipient || !channel) return null;
  const row = db.prepare('SELECT * FROM contactability_policy WHERE org_id = ? AND recipient = ? AND channel = ?').get(orgId, recipient, channel);
  if (!row) return null;
  return { ...row, opt_in: row.opt_in === 1 };
}

function listPolicies(db, orgId) {
  if (!orgId) return [];
  return db.prepare('SELECT * FROM contactability_policy WHERE org_id = ? ORDER BY updated_at DESC').all(orgId)
    .map((r) => ({ ...r, opt_in: r.opt_in === 1 }));
}

function recordAttempt(db, a) {
  if (!a || !a.orgId || !a.recipient || !a.channel) return false;
  db.prepare('INSERT INTO contact_attempts (org_id, recipient, channel, ts, purpose, made_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(a.orgId, a.recipient, a.channel, a.ts || new Date().toISOString(), a.purpose || null, a.made_by || null);
  return true;
}

/** ISO timestamps of contacts to (recipient, channel) in the last 24h, org-scoped. */
function recentAttempts(db, orgId, recipient, channel, { sinceIso } = {}) {
  if (!orgId || !recipient || !channel) return [];
  const since = sinceIso || new Date(Date.now() - 86400000).toISOString();
  return db.prepare('SELECT ts FROM contact_attempts WHERE org_id = ? AND recipient = ? AND channel = ? AND ts >= ? ORDER BY ts ASC')
    .all(orgId, recipient, channel, since).map((r) => r.ts);
}

function registerWatch(db, w) {
  if (!w || !w.orgId || !w.id || !w.name || !w.condition) return false;
  db.prepare(`INSERT OR REPLACE INTO watch_briefs (id, org_id, name, condition, channel, recipient, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(w.id, w.orgId, w.name, w.condition, w.channel || null, w.recipient || null, w.status || 'proposed', w.created_by || null, w.created_at || new Date().toISOString());
  return true;
}

function listWatches(db, orgId) {
  if (!orgId) return [];
  return db.prepare('SELECT * FROM watch_briefs WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
}

module.exports = {
  initContactabilityStore,
  setPolicy, getPolicy, listPolicies,
  recordAttempt, recentAttempts,
  registerWatch, listWatches,
};
