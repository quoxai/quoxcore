/**
 * db/sshKnownHosts.js — VAULT-AUDIT P4.A-auth
 *
 * Durable, org-scoped SSH known-hosts store with server-enforced TOFU
 * (trust-on-first-use) + drift detection (ssh_known_hosts, migrations/076).
 * Used by the collector SSH executor to verify a host's SSH server key
 * before connecting — a container-local known_hosts file dies on rebuild,
 * a ZERO-TOLERANCE server-side-persistence violation.
 *
 * SSH host public keys are NOT secret — no encryption here (contrast with
 * db/sessionState.js, which envelope-encrypts cookie values).
 */

import { generateId } from '../utils/crypto.js';

const DEFAULT_PORT = 22;

/**
 * TOFU decision for a host key, made server-side.
 *
 *  - no existing row       -> INSERT, { status: 'first_use' }
 *  - fingerprint MATCHES   -> UPDATE last_seen_at, { status: 'ok' }
 *  - fingerprint DIFFERS   -> DO NOT update, { status: 'drift', stored }
 *    (operator must explicitly rotate via deleteKnownHost — never
 *    auto-overwrite; this is the hard-fail MITM-signature case)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.host
 * @param {number} [params.port=22]
 * @param {string} params.fingerprint
 * @param {string} [params.keyType]
 * @returns {{ status: 'first_use' | 'ok' | 'drift', stored?: string }}
 */
export function verifyOrRecordHostKey(db, { orgId, host, port = DEFAULT_PORT, fingerprint, keyType = null }) {
    if (!orgId || !host || !fingerprint) throw new Error('orgId + host + fingerprint required');

    const existing = db.prepare(
        `SELECT host_key_fingerprint FROM ssh_known_hosts WHERE org_id = ? AND host = ? AND port = ?`
    ).get(orgId, host, port);

    if (!existing) {
        db.prepare(`
            INSERT INTO ssh_known_hosts (id, org_id, host, port, host_key_fingerprint, key_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(generateId(), orgId, host, port, fingerprint, keyType);
        return { status: 'first_use' };
    }

    if (existing.host_key_fingerprint === fingerprint) {
        db.prepare(`
            UPDATE ssh_known_hosts SET last_seen_at = datetime('now')
            WHERE org_id = ? AND host = ? AND port = ?
        `).run(orgId, host, port);
        return { status: 'ok' };
    }

    // Drift: fingerprint differs from the stored value. Do NOT update —
    // the possible MITM signature. Operator must explicitly rotate.
    return { status: 'drift', stored: existing.host_key_fingerprint };
}

/**
 * Fetch the stored known-host row for an org-scoped (host, port).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.host
 * @param {number} [params.port=22]
 * @returns {Object|null}
 */
export function getKnownHost(db, { orgId, host, port = DEFAULT_PORT }) {
    if (!orgId || !host) throw new Error('orgId + host required');
    const row = db.prepare(
        `SELECT * FROM ssh_known_hosts WHERE org_id = ? AND host = ? AND port = ?`
    ).get(orgId, host, port);
    return row || null;
}

/**
 * Delete the known-host row for an org-scoped (host, port). Explicit
 * operator-rotation escape hatch — the only sanctioned way to clear a
 * drifted fingerprint.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.host
 * @param {number} [params.port=22]
 * @returns {number} number of rows deleted
 */
export function deleteKnownHost(db, { orgId, host, port = DEFAULT_PORT }) {
    if (!orgId || !host) throw new Error('orgId + host required');
    const result = db.prepare(
        `DELETE FROM ssh_known_hosts WHERE org_id = ? AND host = ? AND port = ?`
    ).run(orgId, host, port);
    return result.changes;
}
