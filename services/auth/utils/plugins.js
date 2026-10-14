/**
 * PD-1 — Plugin install registry.
 *
 * Org-scoped, durable plugin records. Each install stores the manifest, the
 * compiled ESM bundle as a BLOB, optional CSS, optional signature payload, and
 * a SHA-256 of the bundle for integrity. Storage lives inside auth.db so the
 * existing `comp_auth_db` backup component physically covers everything.
 *
 * UNIQUE(org_id, plugin_id) — a plugin id can be installed once per org;
 * upgrades go through `upgradeInstall` rather than a second insert.
 *
 * Schema bootstrap is idempotent (CREATE TABLE IF NOT EXISTS) and runs lazily
 * on first request. Same pattern as `secrets.js` — avoids needing a startup
 * migration block in db/index.js.
 */

import { ulid } from './helpers.js';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { encrypt, decrypt } from './encryption.js';
import { FORMAT_V2, canonicalJson, filesMap, v2Payload, v2Message } from './pluginSignatureV2.js';

export function ensurePluginsSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_installs (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            plugin_id       TEXT NOT NULL,
            version         TEXT NOT NULL,
            manifest_json   TEXT NOT NULL,
            bundle_blob     BLOB,
            bundle_sha256   TEXT NOT NULL,
            css_blob        BLOB,
            signature_json  TEXT,
            is_enabled      INTEGER NOT NULL DEFAULT 1,
            installed_by    TEXT NOT NULL,
            installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
            upgraded_at     TEXT,
            UNIQUE(org_id, plugin_id)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_installs_org ON plugin_installs(org_id);
    `);

    // PD-4: plugin-scoped encrypted secrets vault.
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_secrets (
            id          TEXT PRIMARY KEY,
            org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            plugin_id   TEXT NOT NULL,
            name        TEXT NOT NULL,
            ciphertext  TEXT NOT NULL,
            description TEXT,
            created_by  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            rotated_at  TEXT,
            UNIQUE(org_id, plugin_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_secrets_lookup
            ON plugin_secrets(org_id, plugin_id);
    `);

    // PD-8: per-org trusted public keys for plugin signature verification.
    db.exec(`
        CREATE TABLE IF NOT EXISTS org_trusted_keys (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            label           TEXT NOT NULL,
            public_key_hex  TEXT NOT NULL,                  -- raw 32-byte Ed25519 pubkey, hex-encoded
            added_by        TEXT NOT NULL,
            added_at        TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, public_key_hex)
        );
        CREATE INDEX IF NOT EXISTS idx_org_trusted_keys_org ON org_trusted_keys(org_id);
    `);

    // SDK-TEAM W5: org-scoped revocation of a signer key or one bundle digest.
    // Mirrors migrations/123-plugin-revocations.sql (both idempotent).
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_revocations (
            id          TEXT PRIMARY KEY,
            org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL CHECK (kind IN ('signer_key', 'bundle_digest')),
            value       TEXT NOT NULL,               -- lowercase 64-hex: raw Ed25519 pubkey or bundle sha256
            reason      TEXT,
            revoked_by  TEXT NOT NULL,
            revoked_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, kind, value)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_revocations_org ON plugin_revocations(org_id);
    `);

    // PD-7: admin-controlled assignment — gates which users see each install.
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_assignments (
            id            TEXT PRIMARY KEY,
            org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            plugin_id     TEXT NOT NULL,
            assignee_type TEXT NOT NULL,                  -- 'all_org_members' | 'user' | 'team'
            assignee_id   TEXT,                            -- NULL when assignee_type='all_org_members'
            assigned_by   TEXT NOT NULL,
            assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, plugin_id, assignee_type, assignee_id)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_assignments_lookup
            ON plugin_assignments(org_id, plugin_id);
    `);

    // PD-3: plugin-scoped durable KV.
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_data (
            id          TEXT PRIMARY KEY,
            org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            plugin_id   TEXT NOT NULL,
            scope       TEXT NOT NULL DEFAULT 'org',
            scope_id    TEXT,
            key         TEXT NOT NULL,
            value_json  TEXT NOT NULL,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(org_id, plugin_id, scope, scope_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_data_lookup
            ON plugin_data(org_id, plugin_id, scope, scope_id);
    `);

    // Informational backup_components row. Plugin tables live inside auth.db so
    // they're physically covered by `comp_auth_db`; this row gives the backup UI
    // a labelled line item for restore audits. default_enabled=0 prevents a
    // double-archive on every backup run.
    try {
        db.prepare(`
            INSERT OR IGNORE INTO backup_components
                (id, component_key, name, description, source_paths_json,
                 component_type, backup_method, priority, default_enabled, category, icon, estimated_size_bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            'comp_plugin_installs',
            'plugin_installs',
            'Plugin Installs',
            'Org-scoped third-party plugin install records and bundles. Stored inside auth.db; physically backed up by the Auth Database component. This entry is informational and disabled by default to avoid double-archive.',
            '["/opt/quoxcore/services/auth/data/auth.db"]',
            'database',
            'sqlite_backup',
            25,
            0,
            'data',
            'puzzle',
            5000000
        );
    } catch {
        // backup_components table may not exist yet on early-init paths.
    }
}

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// ──────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────

export function createInstall(db, orgId, { pluginId, version, manifestJson, bundleBuf, cssBuf, signatureJson, installedBy }) {
    if (!orgId)        throw new Error('orgId required');
    if (!pluginId)     throw new Error('pluginId required');
    if (!version)      throw new Error('version required');
    if (!manifestJson) throw new Error('manifestJson required');
    if (!installedBy)  throw new Error('installedBy required');
    if (!Buffer.isBuffer(bundleBuf) || bundleBuf.length === 0) {
        throw new Error('bundleBuf required (non-empty Buffer)');
    }

    const id = ulid();
    const bundleSha256 = sha256Hex(bundleBuf);
    db.prepare(`
        INSERT INTO plugin_installs
            (id, org_id, plugin_id, version, manifest_json, bundle_blob, bundle_sha256,
             css_blob, signature_json, installed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, orgId, pluginId, version, manifestJson, bundleBuf, bundleSha256,
        cssBuf || null, signatureJson || null, installedBy,
    );
    return getInstall(db, orgId, pluginId);
}

export function upgradeInstall(db, orgId, { pluginId, version, manifestJson, bundleBuf, cssBuf, signatureJson, installedBy }) {
    if (!Buffer.isBuffer(bundleBuf) || bundleBuf.length === 0) {
        throw new Error('bundleBuf required (non-empty Buffer)');
    }
    const existing = getInstall(db, orgId, pluginId);
    if (!existing) return null;
    const bundleSha256 = sha256Hex(bundleBuf);
    db.prepare(`
        UPDATE plugin_installs
           SET version = ?, manifest_json = ?, bundle_blob = ?, bundle_sha256 = ?, css_blob = ?,
               signature_json = ?, installed_by = ?, upgraded_at = datetime('now')
         WHERE org_id = ? AND plugin_id = ?
    `).run(
        version, manifestJson, bundleBuf, bundleSha256, cssBuf || null,
        signatureJson || null, installedBy, orgId, pluginId,
    );
    return getInstall(db, orgId, pluginId);
}

export function listInstalls(db, orgId) {
    return db.prepare(`
        SELECT id, org_id, plugin_id, version, manifest_json, bundle_sha256, signature_json, is_enabled,
               installed_by, installed_at, upgraded_at
          FROM plugin_installs
         WHERE org_id = ?
         ORDER BY installed_at DESC
    `).all(orgId);
}

export function getInstall(db, orgId, pluginId) {
    return db.prepare(`
        SELECT id, org_id, plugin_id, version, manifest_json, bundle_sha256, signature_json, is_enabled,
               installed_by, installed_at, upgraded_at
          FROM plugin_installs
         WHERE org_id = ? AND plugin_id = ?
    `).get(orgId, pluginId);
}

/**
 * Returns the bundle + css bytes plus the integrity hash. Separate query so the
 * list endpoint never has to materialise BLOBs into JSON.
 */
export function getBundle(db, orgId, pluginId) {
    return db.prepare(`
        SELECT bundle_blob, css_blob, bundle_sha256
          FROM plugin_installs
         WHERE org_id = ? AND plugin_id = ?
    `).get(orgId, pluginId);
}

/**
 * Remove an install row.
 *
 * LICENSE-LAUNCH LL-6b: `purgeData` also reaps that org+plugin's PD-3 durable
 * KV and PD-4 encrypted secrets. Those tables carry no FK to plugin_installs
 * (deliberately — see below), so before this option existed an explicit admin
 * uninstall orphaned them permanently: no route could list them, no route
 * could delete them, and the secret ciphertext stayed decryptable in auth.db
 * forever. LL-7i1 flagged the missing reaper; this is it.
 *
 * It is OPT-IN, and only the deliberate admin uninstall opts in. The
 * entitlement-lapse un-provision in utils/firstPartyProvision.js must keep the
 * default (false): that path revokes CODE and preserves DATA on purpose, so a
 * customer who re-licences finds their configuration intact.
 *
 * @param {{ purgeData?: boolean }} [options]
 * @returns {{ changes: number, purgedDataRows: number, purgedSecretRows: number }}
 */
export function deleteInstall(db, orgId, pluginId, { purgeData = false } = {}) {
    if (!purgeData) {
        const result = db.prepare(`
            DELETE FROM plugin_installs WHERE org_id = ? AND plugin_id = ?
        `).run(orgId, pluginId);
        return { ...result, purgedDataRows: 0, purgedSecretRows: 0 };
    }

    const run = db.transaction(() => {
        const install = db.prepare(
            `DELETE FROM plugin_installs WHERE org_id = ? AND plugin_id = ?`
        ).run(orgId, pluginId);
        const data = db.prepare(
            `DELETE FROM plugin_data WHERE org_id = ? AND plugin_id = ?`
        ).run(orgId, pluginId);
        const secrets = db.prepare(
            `DELETE FROM plugin_secrets WHERE org_id = ? AND plugin_id = ?`
        ).run(orgId, pluginId);
        return {
            ...install,
            purgedDataRows: data.changes,
            purgedSecretRows: secrets.changes,
        };
    });
    return run();
}

export function setEnabled(db, orgId, pluginId, enabled) {
    return db.prepare(`
        UPDATE plugin_installs SET is_enabled = ?
         WHERE org_id = ? AND plugin_id = ?
    `).run(enabled ? 1 : 0, orgId, pluginId);
}

// ──────────────────────────────────────────────────────────────────────
// PD-3: plugin-scoped durable KV
// ──────────────────────────────────────────────────────────────────────

function normalizeScope(scope, scopeId, userId) {
    if (scope === 'user') {
        if (!userId) throw new Error('user_id required for user-scoped data');
        return { scope: 'user', scope_id: userId };
    }
    return { scope: 'org', scope_id: scopeId || null };
}

export function setData(db, orgId, pluginId, key, value, { scope = 'org', userId = null } = {}) {
    if (!key) throw new Error('key required');
    const { scope: s, scope_id } = normalizeScope(scope, null, userId);
    const id = ulid();
    db.prepare(`
        INSERT INTO plugin_data (id, org_id, plugin_id, scope, scope_id, key, value_json)
             VALUES (?, ?, ?, ?, COALESCE(?, ''), ?, ?)
        ON CONFLICT(org_id, plugin_id, scope, scope_id, key) DO UPDATE
           SET value_json = excluded.value_json,
               updated_at = datetime('now')
    `).run(id, orgId, pluginId, s, scope_id, key, JSON.stringify(value));
    return getData(db, orgId, pluginId, key, { scope, userId });
}

export function getData(db, orgId, pluginId, key, { scope = 'org', userId = null } = {}) {
    const { scope: s, scope_id } = normalizeScope(scope, null, userId);
    const row = db.prepare(`
        SELECT key, value_json, updated_at FROM plugin_data
         WHERE org_id = ? AND plugin_id = ? AND scope = ? AND scope_id = COALESCE(?, '') AND key = ?
    `).get(orgId, pluginId, s, scope_id, key);
    if (!row) return null;
    return { key: row.key, value: safeParseJson(row.value_json), updated_at: row.updated_at };
}

export function listDataKeys(db, orgId, pluginId, { scope = 'org', userId = null } = {}) {
    const { scope: s, scope_id } = normalizeScope(scope, null, userId);
    return db.prepare(`
        SELECT key, updated_at FROM plugin_data
         WHERE org_id = ? AND plugin_id = ? AND scope = ? AND scope_id = COALESCE(?, '')
         ORDER BY key
    `).all(orgId, pluginId, s, scope_id);
}

/**
 * Row count for a given org+plugin+scope — used to enforce
 * MAX_PLUGIN_DATA_KEYS in routes/plugins.js (Bug #3, S2,
 * BUGS_POWERS_PLUGINS_CLI_2026_07_09.md) before inserting a new key.
 */
export function countDataKeys(db, orgId, pluginId, { scope = 'org', userId = null } = {}) {
    const { scope: s, scope_id } = normalizeScope(scope, null, userId);
    const row = db.prepare(`
        SELECT COUNT(*) AS n FROM plugin_data
         WHERE org_id = ? AND plugin_id = ? AND scope = ? AND scope_id = COALESCE(?, '')
    `).get(orgId, pluginId, s, scope_id);
    return row ? row.n : 0;
}

export function removeData(db, orgId, pluginId, key, { scope = 'org', userId = null } = {}) {
    const { scope: s, scope_id } = normalizeScope(scope, null, userId);
    return db.prepare(`
        DELETE FROM plugin_data
         WHERE org_id = ? AND plugin_id = ? AND scope = ? AND scope_id = COALESCE(?, '') AND key = ?
    `).run(orgId, pluginId, s, scope_id, key);
}

function safeParseJson(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────
// PD-4: plugin-scoped encrypted secrets
// ──────────────────────────────────────────────────────────────────────

export function setSecret(db, orgId, pluginId, name, plaintext, { createdBy, description = null } = {}) {
    if (!name) throw new Error('name required');
    if (typeof plaintext !== 'string' || !plaintext) throw new Error('value required');
    if (!createdBy) throw new Error('createdBy required');
    const cipher = encrypt(plaintext);

    const existing = db.prepare(
        `SELECT id FROM plugin_secrets WHERE org_id = ? AND plugin_id = ? AND name = ?`
    ).get(orgId, pluginId, name);

    if (existing) {
        db.prepare(`
            UPDATE plugin_secrets
               SET ciphertext = ?, description = COALESCE(?, description), rotated_at = datetime('now')
             WHERE id = ?
        `).run(cipher, description, existing.id);
        return getSecretMeta(db, orgId, pluginId, name);
    }

    db.prepare(`
        INSERT INTO plugin_secrets (id, org_id, plugin_id, name, ciphertext, description, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ulid(), orgId, pluginId, name, cipher, description, createdBy);
    return getSecretMeta(db, orgId, pluginId, name);
}

export function listSecretsMeta(db, orgId, pluginId) {
    return db.prepare(`
        SELECT id, name, description, created_by, created_at, rotated_at
          FROM plugin_secrets
         WHERE org_id = ? AND plugin_id = ?
         ORDER BY name
    `).all(orgId, pluginId);
}

export function getSecretMeta(db, orgId, pluginId, name) {
    return db.prepare(`
        SELECT id, name, description, created_by, created_at, rotated_at
          FROM plugin_secrets
         WHERE org_id = ? AND plugin_id = ? AND name = ?
    `).get(orgId, pluginId, name);
}

export function revealSecret(db, orgId, pluginId, name) {
    const row = db.prepare(`
        SELECT id, name, ciphertext FROM plugin_secrets
         WHERE org_id = ? AND plugin_id = ? AND name = ?
    `).get(orgId, pluginId, name);
    if (!row) return null;
    return { id: row.id, name: row.name, value: decrypt(row.ciphertext) };
}

export function deleteSecret(db, orgId, pluginId, name) {
    return db.prepare(`
        DELETE FROM plugin_secrets WHERE org_id = ? AND plugin_id = ? AND name = ?
    `).run(orgId, pluginId, name);
}

// ──────────────────────────────────────────────────────────────────────
// PD-7: admin-controlled plugin assignment
//
// Each install starts with a single 'all_org_members' assignment row so the
// plugin is visible to every member by default. Admins can replace the
// all_org_members row with explicit user/team rows to restrict visibility.
// ──────────────────────────────────────────────────────────────────────

const ASSIGNEE_TYPES = ['all_org_members', 'user', 'team'];

export function assignPlugin(db, orgId, pluginId, { assigneeType, assigneeId = null, assignedBy }) {
    if (!ASSIGNEE_TYPES.includes(assigneeType)) {
        throw new Error(`assigneeType must be one of ${ASSIGNEE_TYPES.join(',')}`);
    }
    if (assigneeType === 'all_org_members' && assigneeId) {
        throw new Error('all_org_members must have null assignee_id');
    }
    if (assigneeType !== 'all_org_members' && !assigneeId) {
        throw new Error('user/team assignment requires an assignee_id');
    }
    if (!assignedBy) throw new Error('assignedBy required');

    const id = ulid();
    db.prepare(`
        INSERT OR IGNORE INTO plugin_assignments
            (id, org_id, plugin_id, assignee_type, assignee_id, assigned_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, pluginId, assigneeType, assigneeId, assignedBy);
    return getAssignment(db, orgId, pluginId, assigneeType, assigneeId);
}

export function getAssignment(db, orgId, pluginId, assigneeType, assigneeId) {
    return db.prepare(`
        SELECT * FROM plugin_assignments
         WHERE org_id = ? AND plugin_id = ? AND assignee_type = ?
           AND ((assignee_id IS NULL AND ? IS NULL) OR assignee_id = ?)
    `).get(orgId, pluginId, assigneeType, assigneeId, assigneeId);
}

export function listAssignments(db, orgId, pluginId) {
    return db.prepare(`
        SELECT id, assignee_type, assignee_id, assigned_by, assigned_at
          FROM plugin_assignments
         WHERE org_id = ? AND plugin_id = ?
         ORDER BY assignee_type, assignee_id
    `).all(orgId, pluginId);
}

export function removeAssignment(db, orgId, pluginId, assigneeType, assigneeId) {
    return db.prepare(`
        DELETE FROM plugin_assignments
         WHERE org_id = ? AND plugin_id = ? AND assignee_type = ?
           AND ((assignee_id IS NULL AND ? IS NULL) OR assignee_id = ?)
    `).run(orgId, pluginId, assigneeType, assigneeId, assigneeId);
}

/**
 * Returns the list of plugin_ids visible to the given user in the org.
 *
 * Visibility rules: a plugin is visible if any of:
 *   - an `all_org_members` assignment exists for it
 *   - a `user` assignment matches the user
 *   - a `team` assignment matches a team the user belongs to (active membership)
 *
 * Hidden plugins (no assignment row at all) are not visible to anyone.
 */
// ──────────────────────────────────────────────────────────────────────
// PD-8: trusted Ed25519 public keys + signature verification
// ──────────────────────────────────────────────────────────────────────

export function addTrustedKey(db, orgId, { label, publicKeyHex, addedBy }) {
    if (!label) throw new Error('label required');
    if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex || '')) {
        throw new Error('public_key_hex must be 64 hex characters (32-byte Ed25519 pubkey)');
    }
    if (!addedBy) throw new Error('addedBy required');
    const id = ulid();
    db.prepare(`
        INSERT INTO org_trusted_keys (id, org_id, label, public_key_hex, added_by)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, orgId, label, publicKeyHex.toLowerCase(), addedBy);
    return getTrustedKey(db, orgId, id);
}

export function getTrustedKey(db, orgId, keyId) {
    return db.prepare(`
        SELECT id, label, public_key_hex, added_by, added_at
          FROM org_trusted_keys WHERE org_id = ? AND id = ?
    `).get(orgId, keyId);
}

export function listTrustedKeys(db, orgId) {
    return db.prepare(`
        SELECT id, label, public_key_hex, added_by, added_at
          FROM org_trusted_keys WHERE org_id = ? ORDER BY added_at DESC
    `).all(orgId);
}

export function deleteTrustedKey(db, orgId, keyId) {
    return db.prepare(`DELETE FROM org_trusted_keys WHERE org_id = ? AND id = ?`).run(orgId, keyId);
}

const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(pubHex, message, sigHex) {
    const pubKey = createPublicKey({
        key: Buffer.concat([ED25519_DER_PREFIX, Buffer.from(pubHex, 'hex')]),
        format: 'der',
        type: 'spki',
    });
    return cryptoVerify(null, message, pubKey, Buffer.from(sigHex, 'hex'));
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Verify a plugin signature against the org's trusted keys.
 *
 * Two formats (SDK-TEAM W5, 2026-10-13):
 *   v2 (quox-plugin-vite >= 0.3.0): `signature_v2` over canonicalJson of
 *      { files, format, manifest_sha256, plugin_id, plugin_version }; binds the
 *      manifest, the bundle and the css (see pluginSignatureV2.js). The host
 *      RECOMPUTES every bound value from what was posted and verifies against
 *      that, never against the claims inside the signature object.
 *   v1 (0.2.0): `signature` over the 32 raw bytes of the bundle sha256. Binds
 *      the bundle only; returned with binding 'v1_manifest_unbound' so the
 *      caller can apply its v1 manifest policy.
 * A v2 signature object also carries the v1 fields so pre-v2 hosts keep
 * installing it; a v2-aware host ignores them when v2 is present.
 *
 * @returns {{ valid: boolean, reason?: string, matchedKeyId?: string, binding?: 'v2'|'v1_manifest_unbound' }}
 *   reasons: unsigned, invalid_structure, manifest_required, digest_mismatch,
 *   manifest_mismatch, files_mismatch, no_matching_key, bad_signature, verify_error
 *
 * Policy is the caller's choice; this function only computes the verdict.
 */
export function verifyPluginSignature(db, orgId, { bundleSha256, cssSha256 = null, manifest = null, signature }) {
    if (!signature || typeof signature !== 'object') {
        return { valid: false, reason: 'unsigned' };
    }
    const isV2 = 'format' in signature || 'signature_v2' in signature;
    if (isV2) return verifyV2(db, orgId, { bundleSha256, cssSha256, manifest, signature });

    const { algorithm, digest, signature: sigHex, public_key_hex } = signature;
    if (algorithm !== 'Ed25519' || !digest || !sigHex || !public_key_hex) {
        return { valid: false, reason: 'invalid_structure' };
    }
    if (digest !== bundleSha256) {
        return { valid: false, reason: 'digest_mismatch' };
    }
    const pubHex = String(public_key_hex).toLowerCase();
    const trustedRow = db.prepare(
        `SELECT id FROM org_trusted_keys WHERE org_id = ? AND public_key_hex = ?`
    ).get(orgId, pubHex);
    if (!trustedRow) {
        return { valid: false, reason: 'no_matching_key' };
    }
    try {
        return ed25519Verify(pubHex, Buffer.from(digest, 'hex'), sigHex)
            ? { valid: true, matchedKeyId: trustedRow.id, binding: 'v1_manifest_unbound' }
            : { valid: false, reason: 'bad_signature' };
    } catch (err) {
        return { valid: false, reason: 'verify_error', error: err.message };
    }
}

function verifyV2(db, orgId, { bundleSha256, cssSha256, manifest, signature }) {
    const { algorithm, format, signature_v2: sigHex, public_key_hex } = signature;
    if (algorithm !== 'Ed25519' || format !== FORMAT_V2 || typeof sigHex !== 'string' || !HEX128.test(sigHex)
        || typeof public_key_hex !== 'string' || !HEX64.test(public_key_hex.toLowerCase())) {
        return { valid: false, reason: 'invalid_structure' };
    }
    if (!manifest || typeof manifest !== 'object') {
        return { valid: false, reason: 'manifest_required' };
    }
    if (!bundleSha256) return { valid: false, reason: 'digest_mismatch' };

    // Recompute everything the signature binds from the posted bytes.
    const payload = v2Payload({ manifest, bundleSha256, cssSha256 });
    if (signature.plugin_id !== payload.plugin_id || signature.plugin_version !== payload.plugin_version
        || signature.manifest_sha256 !== payload.manifest_sha256) {
        return { valid: false, reason: 'manifest_mismatch' };
    }
    if (canonicalJson(signature.files ?? null) !== canonicalJson(filesMap(bundleSha256, cssSha256))) {
        return { valid: false, reason: 'files_mismatch' };
    }
    const pubHex = public_key_hex.toLowerCase();
    const trustedRow = db.prepare(
        `SELECT id FROM org_trusted_keys WHERE org_id = ? AND public_key_hex = ?`
    ).get(orgId, pubHex);
    if (!trustedRow) {
        return { valid: false, reason: 'no_matching_key' };
    }
    try {
        return ed25519Verify(pubHex, v2Message(payload), sigHex)
            ? { valid: true, matchedKeyId: trustedRow.id, binding: 'v2' }
            : { valid: false, reason: 'bad_signature' };
    } catch (err) {
        return { valid: false, reason: 'verify_error', error: err.message };
    }
}

// ──────────────────────────────────────────────────────────────────────
// SDK-TEAM W5: v1 manifest policy
//
// A v1 signature vouches for the bundle bytes and nothing else, so in an org
// that requires signatures it must not be able to carry privileges that live
// in the manifest. A v1-signed plugin may ask only for what a sandboxed UI
// plugin needs with no reach beyond its own storage: sidebar, storage,
// notifications. network (fetch through the host), memory, aee and a backend
// image are refused until the author re-signs with v2.
// ──────────────────────────────────────────────────────────────────────

export const V1_ALLOWED_PERMISSIONS = new Set(['sidebar', 'storage', 'notifications']);

/** @returns {string[]} what a v1-signed manifest asks for beyond the v1 allowance (empty = ok) */
export function v1ManifestExcess(manifest) {
    const excess = [];
    const perms = manifest?.permissions;
    if (perms !== undefined && perms !== null && !Array.isArray(perms)) excess.push('permissions:not_an_array');
    if (Array.isArray(perms)) {
        for (const p of perms) if (!V1_ALLOWED_PERMISSIONS.has(p)) excess.push(`permission:${p}`);
    }
    if (manifest && manifest.backend) excess.push('backend');
    return excess;
}

// ──────────────────────────────────────────────────────────────────────
// SDK-TEAM W5: org-scoped revocation
// ──────────────────────────────────────────────────────────────────────

export const REVOCATION_KINDS = new Set(['signer_key', 'bundle_digest']);

export function addRevocation(db, orgId, { kind, value, reason = null, revokedBy }) {
    if (!REVOCATION_KINDS.has(kind)) throw new Error('kind must be signer_key or bundle_digest');
    const v = String(value || '').toLowerCase();
    if (!HEX64.test(v)) throw new Error('value must be 64 hex characters');
    if (!revokedBy) throw new Error('revokedBy required');
    const id = ulid();
    db.prepare(`
        INSERT INTO plugin_revocations (id, org_id, kind, value, reason, revoked_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, kind, v, reason ? String(reason).slice(0, 500) : null, revokedBy);
    return db.prepare(`SELECT * FROM plugin_revocations WHERE id = ?`).get(id);
}

export function listRevocations(db, orgId) {
    return db.prepare(`SELECT * FROM plugin_revocations WHERE org_id = ? ORDER BY revoked_at DESC`).all(orgId);
}

export function getRevocation(db, orgId, id) {
    return db.prepare(`SELECT * FROM plugin_revocations WHERE org_id = ? AND id = ?`).get(orgId, id);
}

export function deleteRevocation(db, orgId, id) {
    return db.prepare(`DELETE FROM plugin_revocations WHERE org_id = ? AND id = ?`).run(orgId, id);
}

/**
 * Is this bundle (or its signer) revoked for the org? Fails CLOSED: any error
 * reading the store is reported as revoked, so a broken lookup can never
 * serve bytes an admin tried to stop.
 *
 * @returns {{ revoked: false } | { revoked: true, kind: string, id?: string, reason?: string|null }}
 */
export function revocationFor(db, orgId, { bundleSha256, publicKeyHex }) {
    try {
        const stmt = db.prepare(`SELECT id, kind, reason FROM plugin_revocations WHERE org_id = ? AND kind = ? AND value = ?`);
        if (bundleSha256) {
            const r = stmt.get(orgId, 'bundle_digest', String(bundleSha256).toLowerCase());
            if (r) return { revoked: true, kind: r.kind, id: r.id, reason: r.reason };
        }
        if (publicKeyHex) {
            const r = stmt.get(orgId, 'signer_key', String(publicKeyHex).toLowerCase());
            if (r) return { revoked: true, kind: r.kind, id: r.id, reason: r.reason };
        }
        return { revoked: false };
    } catch (err) {
        return { revoked: true, kind: 'revocation_check_failed', reason: err.message };
    }
}

/** Revocation check for a stored install row (signature_json parsed for the signer key). */
export function installRevocation(db, orgId, row) {
    let pub = null;
    try { pub = row?.signature_json ? JSON.parse(row.signature_json)?.public_key_hex || null : null; } catch { pub = null; }
    return revocationFor(db, orgId, { bundleSha256: row?.bundle_sha256, publicKeyHex: pub });
}

export function listVisiblePluginIds(db, orgId, userId, { teamIds = null } = {}) {
    let teams = teamIds;
    if (!teams) {
        // Best effort — team_memberships is not part of every minimal test
        // schema, so we fall back to the empty set if the table is missing.
        try {
            teams = db.prepare(
                `SELECT team_id FROM team_memberships WHERE user_id = ? AND status = 'active'`
            ).all(userId).map(r => r.team_id);
        } catch {
            teams = [];
        }
    }
    const teamPlaceholders = teams.length ? teams.map(() => '?').join(',') : null;

    const sql = `
        SELECT DISTINCT i.plugin_id
          FROM plugin_installs i
         WHERE i.org_id = ? AND i.is_enabled = 1 AND EXISTS (
             SELECT 1 FROM plugin_assignments a
              WHERE a.org_id = i.org_id AND a.plugin_id = i.plugin_id AND (
                  a.assignee_type = 'all_org_members'
               OR (a.assignee_type = 'user' AND a.assignee_id = ?)
               ${teamPlaceholders ? `OR (a.assignee_type = 'team' AND a.assignee_id IN (${teamPlaceholders}))` : ''}
              )
         )
    `;
    const params = [orgId, userId, ...(teams || [])];
    return db.prepare(sql).all(...params).map(r => r.plugin_id);
}
