/**
 * ET-2 Phase B — ephemeral OIDC auth-state store.
 *
 * Holds the PKCE verifier and state nonce between the /login redirect
 * and the /callback return. Single-use (consumed on callback) and
 * TTL-bounded (default 10 min). Never holds tokens.
 */

import { ulid } from './helpers.js';

export function ensureSsoAuthStateSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sso_auth_states (
            id             TEXT PRIMARY KEY,
            provider_id    TEXT NOT NULL,
            state          TEXT NOT NULL UNIQUE,
            code_verifier  TEXT NOT NULL,
            redirect_to    TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at_ms  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sso_auth_states_expires
            ON sso_auth_states(expires_at_ms);
    `);
}

export function createAuthState(db, { providerId, state, codeVerifier, redirectTo = null, ttlSec = 600 }) {
    if (!providerId || !state || !codeVerifier) {
        throw new Error('providerId, state, and codeVerifier are required');
    }
    const id = ulid();
    const expiresAtMs = Date.now() + ttlSec * 1000;
    db.prepare(`
        INSERT INTO sso_auth_states (id, provider_id, state, code_verifier, redirect_to, expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, providerId, state, codeVerifier, redirectTo, expiresAtMs);
    return { id, state };
}

export function consumeAuthState(db, state) {
    const row = db.prepare(
        `SELECT * FROM sso_auth_states WHERE state = ?`,
    ).get(state);
    if (!row) return null;
    // Always delete to prevent reuse, even if expired.
    db.prepare(`DELETE FROM sso_auth_states WHERE id = ?`).run(row.id);
    if (row.expires_at_ms < Date.now()) return null;
    return row;
}

export function pruneExpiredAuthStates(db) {
    const res = db.prepare(
        `DELETE FROM sso_auth_states WHERE expires_at_ms < ?`,
    ).run(Date.now());
    return res.changes;
}
