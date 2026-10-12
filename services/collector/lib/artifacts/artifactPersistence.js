/**
 * Signed-artifact persistence (COMMANDERQ P5).
 *
 * A queryable, org-scoped store for signed artifacts, so a plan can be fetched,
 * re-verified, and diffed by id. This is the SERVER-SIDE SOURCE OF TRUTH for
 * retrieval (data-persistence ZERO TOLERANCE) — the WARD-witnessed
 * quox.artifact.created AEE envelope createArtifact emits remains the immutable
 * evidence trail; this table is the index/store you read back from.
 *
 * Inline init pattern, mirroring lib/policyStore.js initPolicyStore(db): the
 * caller passes the better-sqlite3 handle (voltDb). Pure — no server/ward
 * require. Reads ALWAYS filter by org_id.
 */

'use strict';

function initArtifactStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id   TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL,
      org_id        TEXT NOT NULL,
      created_by    TEXT,
      created_at    TEXT NOT NULL,
      corr          TEXT,
      signed_json   TEXT NOT NULL,
      sig_type      TEXT,
      key_id        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_org_type ON artifacts (org_id, artifact_type, created_at);
  `);
}

function insertArtifact(db, artifact) {
  const sig = artifact.signature || {};
  db.prepare(`
    INSERT OR REPLACE INTO artifacts
      (artifact_id, artifact_type, org_id, created_by, created_at, corr, signed_json, sig_type, key_id)
    VALUES (@artifact_id, @artifact_type, @org_id, @created_by, @created_at, @corr, @signed_json, @sig_type, @key_id)
  `).run({
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.artifact_type,
    org_id: artifact.org_id,
    created_by: artifact.created_by || null,
    created_at: artifact.created_at,
    corr: artifact.corr || null,
    signed_json: JSON.stringify(artifact),
    sig_type: sig.sig_type || null,
    key_id: sig.key_id || null,
  });
}

/**
 * Fetch one artifact by id, ALWAYS scoped to org (cross-org read returns null).
 * @returns {object|null} the parsed signed artifact.
 */
function getArtifact(db, artifactId, orgId) {
  if (!artifactId || !orgId) return null;
  const row = db.prepare(
    'SELECT signed_json FROM artifacts WHERE artifact_id = ? AND org_id = ?'
  ).get(artifactId, orgId);
  if (!row) return null;
  try {
    return JSON.parse(row.signed_json);
  } catch {
    return null;
  }
}

/**
 * List an org's artifacts (metadata only, newest first), optionally by type.
 */
function listArtifacts(db, orgId, { type, limit = 50 } = {}) {
  if (!orgId) return [];
  const cap = Math.min(Math.max(1, limit | 0), 200);
  const rows = type
    ? db.prepare('SELECT artifact_id, artifact_type, created_by, created_at, sig_type, key_id FROM artifacts WHERE org_id = ? AND artifact_type = ? ORDER BY created_at DESC LIMIT ?').all(orgId, type, cap)
    : db.prepare('SELECT artifact_id, artifact_type, created_by, created_at, sig_type, key_id FROM artifacts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, cap);
  return rows;
}

module.exports = {
  initArtifactStore,
  insertArtifact,
  getArtifact,
  listArtifacts,
};
