/**
 * config/encryptedStores.js — single source of truth for every column in the
 * auth DB that is encrypted at rest with the master key (MASTER_ENCRYPTION_KEY).
 *
 * WHY THIS EXISTS (VAULT F2):
 *   Master-key rotation used to hardcode three tables (integration_credentials,
 *   instance_config, api_keys) and silently skipped the `secrets` KV store — so
 *   rotating the master key orphaned every KV secret. Rotation now iterates this
 *   registry instead of hardcoding table names, so a store is covered the moment
 *   it is registered here.
 *
 * THE SAFETY NET:
 *   tests/vault-encrypted-stores-completeness.test.js introspects sqlite_master
 *   on a fully migrated DB and FAILS if any column whose name matches
 *   /(ciphertext|_cipher|_encrypted)$/i (excluding the boolean `encrypted` flag
 *   column) is missing from ENCRYPTED_STORES. When a future migration adds an
 *   encrypted column, add it here or the test goes red — this is the single most
 *   important backstop against silently orphaning data on the next rotation.
 *
 * Entry fields:
 *   table    — SQLite table name
 *   column   — encrypted column. AES-256-GCM, `iv:authTag:ciphertext` base64
 *              (utils/encryption.js encrypt()/reencrypt()).
 *   idColumn — primary-key column used to target row UPDATEs during rotation.
 *   where    — optional extra SQL predicate (e.g. instance_config only encrypts
 *              rows flagged encrypted = 1; the `value` column itself is plain for
 *              non-encrypted rows).
 *   rotate   — whether master-key rotation re-encrypts this column with the new
 *              key. All master-key-encrypted stores set this true; a column that
 *              is registered only to satisfy the completeness test but is NOT
 *              master-key encrypted would set this false (none today).
 *   note     — human context.
 *
 * NOTE: instance_config.value is registered here (it holds master-key ciphertext
 * when encrypted = 1) even though its column name does NOT match the completeness
 * regex — it is discovered via the `encrypted` flag, not the column name. It is
 * kept in the registry so rotation covers it from the single source of truth.
 */

import { reencrypt, rewrapEnvelope, deriveKek } from '../utils/encryption.js';

export const ENCRYPTED_STORES = [
    {
        table: 'integration_credentials',
        column: 'ciphertext',
        idColumn: 'id',
        rotate: true,
        note: 'Vault integration credentials (API keys, tokens, JSON blobs).',
    },
    {
        table: 'secrets',
        column: 'ciphertext',
        idColumn: 'id',
        rotate: true,
        note: 'Org/scope-bound KV secrets store (utils/secrets.js). F2: was skipped by rotation.',
    },
    {
        table: 'api_keys',
        column: 'key_ciphertext',
        idColumn: 'id',
        rotate: true,
        note: 'Instance / scoped API keys.',
    },
    {
        table: 'instance_config',
        column: 'value',
        idColumn: 'key',
        where: 'encrypted = 1',
        rotate: true,
        note: 'instance_config rows flagged encrypted = 1 (value holds master-key ciphertext).',
    },
    {
        table: 'sso_providers',
        column: 'client_secret_cipher',
        idColumn: 'id',
        rotate: true,
        note: 'SSO/OIDC client secrets (AES-256-GCM, master key).',
    },
    {
        table: 'webhooks',
        column: 'secret_cipher',
        idColumn: 'id',
        rotate: true,
        note: 'Outbound webhook signing secrets (AES-256-GCM, master key).',
    },
    {
        table: 'credential_session_state',
        column: 'ciphertext',
        idColumn: 'id',
        rotate: true,
        note: 'Browser session cookies (F17 — was plaintext files on screencap disk).',
    },
    {
        table: 'org_crystal_signing_keys',
        column: 'private_key_encrypted',
        idColumn: 'id',
        rotate: true,
        note: 'REPLAY-ONLY .B1a — per-org Ed25519 Crystal Signing Key (CSK) private material, PKCS8 DER hex, master-key encrypted. Never leaves auth (lib/crystalSigningKey.js).',
    },
    {
        table: 'dev_capability_signing_keys',
        column: 'private_key_encrypted',
        idColumn: 'id',
        rotate: true,
        note: 'Dev Suite capability-profile signing keys (lib/devCapabilitySigningKey.js), same utils/encryption.js envelope as CSK. Shipped unregistered; caught by the completeness backstop 2026-09-06 (VAULT-INTEG).',
    },
    {
        table: 'widget_evidence_signing_keys',
        column: 'private_key_encrypted',
        idColumn: 'id',
        rotate: true,
        note: 'Wave 11 QuoxChat evidence-bundle Ed25519 signing keys (lib/widgetEvidenceSigningKey.js), same utils/encryption.js envelope as CSK.',
    },
    {
        table: 'approval_grant_signing_keys',
        column: 'private_key_encrypted',
        idColumn: 'id',
        rotate: true,
        note: 'Per-org Ed25519 approval-grant signing keys (lib/approvalGrantSigningKey.js), same utils/encryption.js envelope as CSK. Shipped unregistered, so a master-key rotation would have skipped and orphaned them; caught by the completeness backstop 2026-10-15 (WORKER2).',
    },
];

/**
 * Regex identifying an encrypted column by name. Kept next to the registry so
 * the completeness test and any future tooling share one definition.
 * Matches columns ending in `ciphertext`, `_cipher`, or `_encrypted`.
 */
export const ENCRYPTED_COLUMN_PATTERN = /(ciphertext|_cipher|_encrypted)$/i;

/**
 * Columns that match ENCRYPTED_COLUMN_PATTERN but are NOT encrypted payloads and
 * must be excluded from the completeness assertion. The boolean `encrypted` flag
 * on instance_config does not match the pattern (no leading underscore), but we
 * exclude any bare `encrypted` column defensively.
 */
export const NON_PAYLOAD_ENCRYPTED_COLUMNS = new Set(['encrypted']);

/**
 * Stores that master-key rotation should re-encrypt.
 * @returns {Array} entries with rotate === true
 */
export function getRotatableStores() {
    return ENCRYPTED_STORES.filter((s) => s.rotate);
}

/**
 * Re-encrypt every row of a single encrypted store from the old master to the
 * new master. Introspects the table so it works whether or not the table carries
 * an `updated_at` column (e.g. webhooks has none). Per-row failures are captured,
 * not thrown, so one malformed row does not abort the whole rotation.
 *
 * VAULT-AUDIT P1 — envelope-aware: a v2 envelope row is rotated by re-wrapping
 * its DEK under the new KEK (rewrapEnvelope — the secret iv/tag/ct are untouched
 * and its kekVer is bumped). A legacy 3-part row is re-encrypted the old way
 * (reencrypt). Both KEKs are derived from the master keys + the stable vault salt.
 *
 * @param {import('better-sqlite3').Database} db - open DB (inside the rotation txn)
 * @param {Object} store - an ENCRYPTED_STORES entry
 * @param {Object} keyCtx - rotation key context
 * @param {Buffer} keyCtx.oldKey - previous 32-byte master key (legacy path)
 * @param {Buffer} keyCtx.newKey - new 32-byte master key (legacy path)
 * @param {Buffer} keyCtx.salt - stable HKDF salt (vault_kek_salt)
 * @param {number} keyCtx.oldVersion - current vault KEK version (wraps existing v2 rows)
 * @param {number} keyCtx.newVersion - new vault KEK version to stamp on rotated v2 rows
 * @param {Buffer} [keyCtx.prevKey] - optional previous-previous master (dual-key window)
 * @returns {{ table: string, count: number, errors: Array<{ id: any, error: string }> }}
 */
export function reencryptStore(db, store, keyCtx) {
    const { table, column, idColumn = 'id', where } = store;
    const { oldKey, newKey, salt, oldVersion, newVersion, prevKey = null } = keyCtx;

    const oldKek = deriveKek(oldKey, salt);
    const newKek = deriveKek(newKey, salt);
    const prevKek = prevKey ? deriveKek(prevKey, salt) : null;
    const oldKekResolver = (kekVer) => {
        if (kekVer === oldVersion) return oldKek;
        if (prevKek && kekVer === oldVersion - 1) return prevKek;
        throw new Error(
            `No KEK for vault version ${kekVer} during rotation (current=${oldVersion})`
        );
    };

    const tableCols = db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
    const hasUpdatedAt = tableCols.includes('updated_at');

    const predicates = [`${column} IS NOT NULL`];
    if (where) predicates.push(where);

    const rows = db
        .prepare(`SELECT ${idColumn} AS __id, ${column} AS __cipher FROM ${table} WHERE ${predicates.join(' AND ')}`)
        .all();

    const setClause = hasUpdatedAt
        ? `${column} = ?, updated_at = datetime('now')`
        : `${column} = ?`;
    const upd = db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${idColumn} = ?`);

    const errors = [];
    let count = 0;
    for (const row of rows) {
        try {
            const cipher = row.__cipher;
            const next = (typeof cipher === 'string' && cipher.startsWith('v2:'))
                ? rewrapEnvelope(cipher, oldKekResolver, newKek, newVersion)
                : reencrypt(cipher, oldKey, newKey);
            upd.run(next, row.__id);
            count++;
        } catch (err) {
            errors.push({ id: row.__id, error: err.message });
        }
    }

    return { table, count, errors };
}

export default {
    ENCRYPTED_STORES,
    ENCRYPTED_COLUMN_PATTERN,
    NON_PAYLOAD_ENCRYPTED_COLUMNS,
    getRotatableStores,
    reencryptStore,
};
