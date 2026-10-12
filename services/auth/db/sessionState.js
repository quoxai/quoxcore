/**
 * db/sessionState.js — VAULT-AUDIT P3.B1 (F17)
 *
 * Server-side, envelope-encrypted store for browser session cookies
 * (credential_session_state, migrations/075). Replaces screencap writing
 * plaintext session-cookie JSON files to disk — a session-hijack risk and a
 * ZERO-TOLERANCE server-side-persistence violation.
 *
 * Reuses the existing v2 envelope via utils/encryption.js encrypt()/decrypt()
 * — no new crypto here. Cookie values are NEVER logged.
 */

import { generateId } from '../utils/crypto.js';
import { encrypt, decrypt } from '../utils/encryption.js';

const DEFAULT_TTL_HOURS = 12;

/**
 * Upsert the encrypted session state for an org-scoped session_key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.sessionKey - e.g. `${sessionId}__${domain}`
 * @param {string} [params.domain]
 * @param {string} [params.credentialId]
 * @param {Array} params.cookies
 * @param {number} [params.ttlHours=12] - staleness horizon
 * @returns {{ id: string, expires_at: string }}
 */
export function putSessionState(db, { orgId, sessionKey, domain = null, credentialId = null, cookies, ttlHours = DEFAULT_TTL_HOURS }) {
    if (!orgId || !sessionKey) throw new Error('orgId + sessionKey required');
    if (!Array.isArray(cookies)) throw new Error('cookies must be an array');

    const savedAt = new Date();
    const ciphertext = encrypt(JSON.stringify({ cookies, saved_at: savedAt.toISOString() }));
    const expiresAt = new Date(savedAt.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
    const savedAtIso = savedAt.toISOString();

    const existing = db.prepare(
        `SELECT id FROM credential_session_state WHERE org_id = ? AND session_key = ?`
    ).get(orgId, sessionKey);

    const id = existing?.id || generateId();

    db.prepare(`
        INSERT INTO credential_session_state (id, org_id, credential_id, session_key, domain, ciphertext, saved_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(org_id, session_key) DO UPDATE SET
            credential_id = excluded.credential_id,
            domain = excluded.domain,
            ciphertext = excluded.ciphertext,
            saved_at = excluded.saved_at,
            expires_at = excluded.expires_at,
            updated_at = datetime('now')
    `).run(id, orgId, credentialId, sessionKey, domain, ciphertext, savedAtIso, expiresAt);

    return { id, expires_at: expiresAt };
}

/**
 * Fetch + decrypt the session state for an org-scoped session_key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.sessionKey
 * @returns {{ cookies: Array, saved_at: string, stale: boolean } | null}
 */
export function getSessionState(db, { orgId, sessionKey }) {
    if (!orgId || !sessionKey) throw new Error('orgId + sessionKey required');

    const row = db.prepare(
        `SELECT ciphertext, saved_at, expires_at, credential_id FROM credential_session_state WHERE org_id = ? AND session_key = ?`
    ).get(orgId, sessionKey);
    if (!row) return null;

    const decrypted = JSON.parse(decrypt(row.ciphertext));
    const stale = row.expires_at ? new Date() > new Date(row.expires_at) : false;

    return {
        cookies: decrypted.cookies,
        saved_at: decrypted.saved_at || row.saved_at,
        stale,
        // VAULT-P5.G (F4): not secret material — lets the route gate a
        // lease_required credential's linked session on the same lease check
        // that gates the credential itself. Callers that don't care can
        // ignore it (already present on write via putSessionState's
        // credentialId param).
        credential_id: row.credential_id || null,
    };
}

/**
 * Delete the session state for an org-scoped session_key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.sessionKey
 * @returns {number} number of rows deleted
 */
export function deleteSessionState(db, { orgId, sessionKey }) {
    if (!orgId || !sessionKey) throw new Error('orgId + sessionKey required');
    const result = db.prepare(
        `DELETE FROM credential_session_state WHERE org_id = ? AND session_key = ?`
    ).run(orgId, sessionKey);
    return result.changes;
}

/**
 * Housekeeping: delete rows past their expiry horizon. Not wired to a cron
 * in this unit — exported for the caller (or a future scheduled job) to run.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [params]
 * @param {number} [params.olderThanHours=12] - kept for API symmetry; expiry
 *   is already stamped per-row at write time, so this prunes any row whose
 *   expires_at has passed (regardless of exactly how long ago).
 * @returns {number} number of rows deleted
 */
export function pruneExpiredSessionState(db, { olderThanHours = DEFAULT_TTL_HOURS } = {}) {
    const result = db.prepare(
        `DELETE FROM credential_session_state WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
    ).run();
    return result.changes;
}
