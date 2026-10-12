/**
 * ET-3 Phase C1 — SCIM bearer token store.
 *
 * One token per org, scoped to the org's directory. IdPs send
 * Authorization: Bearer <token> on every SCIM call. We store only
 * the SHA-256 of the token; plaintext is returned exactly once
 * on create.
 */

import { ulid } from './helpers.js';
import { randomBytes, createHash } from 'crypto';

function sha256Hex(s) {
    return createHash('sha256').update(s).digest('hex');
}

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export function ensureScimTokensSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS scim_tokens (
            id            TEXT PRIMARY KEY,
            org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            token_hash    TEXT NOT NULL UNIQUE,
            label         TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            created_by    TEXT,
            last_used_at  TEXT,
            revoked_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens(token_hash);
    `);
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function createScimToken(db, orgId, { label = null, createdBy = null } = {}) {
    const id    = ulid();
    const token = `quox_scim_${randomBytes(32).toString('base64url')}`;
    const hash  = sha256Hex(token);
    db.prepare(`
        INSERT INTO scim_tokens (id, org_id, token_hash, label, created_by)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, orgId, hash, label, createdBy);
    return { id, token };
}

export function listScimTokens(db, orgId) {
    return db.prepare(`
        SELECT id, org_id, label, created_at, created_by, last_used_at, revoked_at
        FROM scim_tokens WHERE org_id = ?
        ORDER BY created_at DESC
    `).all(orgId);
}

export function revokeScimToken(db, orgId, id) {
    db.prepare(
        `UPDATE scim_tokens SET revoked_at = datetime('now') WHERE id = ? AND org_id = ?`,
    ).run(id, orgId);
}

// ──────────────────────────────────────────────────────────────────────
// Bearer verification
// ──────────────────────────────────────────────────────────────────────

export function verifyScimBearer(db, authHeader) {
    if (typeof authHeader !== 'string') return null;
    const match = authHeader.match(/^Bearer\s+([A-Za-z0-9_.\-]+)$/i);
    if (!match) return null;
    const hash = sha256Hex(match[1]);
    const row = db.prepare(`
        SELECT id, org_id FROM scim_tokens
        WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hash);
    if (!row) return null;
    db.prepare(`UPDATE scim_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    return row;
}
