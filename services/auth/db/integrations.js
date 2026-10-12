/**
 * Database queries for Integration Credentials
 * Handles CRUD operations for the integration_credentials table
 */

import { getDb, prepare } from './index.js';
import { generateId } from '../utils/crypto.js';
import { encrypt, decrypt, getKeyPreview, reencrypt } from '../utils/encryption.js';
import { getKind } from '../config/credentialKinds.js';
import { extractCertExpiry } from '../utils/certExpiry.js';
import { getType as getIntegrationType } from '../config/integrationTypeRegistry.js';

/**
 * LI-OVERHAUL P5: expiry stamp for integration types whose tokens have a
 * known fixed lifetime (declared as tokenLifetimeDays on the type registry
 * entry — linkedin's pasted OAuth tokens live exactly 60 days). Returns an
 * ISO timestamp, or null when the type has no declared lifetime.
 */
function lifetimeExpiryFor(integration_type) {
    const days = getIntegrationType(integration_type)?.tokenLifetimeDays;
    if (!days) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Create a new integration credential
 * @param {Object} data - Credential data
 * @returns {Object} Created credential (without ciphertext)
 */
export function createCredential(data) {
    const {
        org_id,
        scope_id = null,
        integration_type,
        label,
        credentials, // Plain object to encrypt
        endpoint_url = null,
        auth_type = 'api_key',
        headers_json = '{}',
        description = null,
        metadata_json = '{}',
        is_default = false,
        created_by,
        visibility = 'org',
        folder_id = null,
        lease_required = 0,
        lease_max_duration_minutes = null,
        lease_max_uses = null,
        credential_kind = 'service_api',
        release_policy,
        expires_at = null
    } = data;

    const id = generateId();
    const ciphertext = encrypt(JSON.stringify(credentials));
    const key_preview = generateKeyPreview(credentials);

    // VAULT-AUDIT P2: default release_policy from the kind's own default
    // when not explicitly passed (falls back to 'api' for an unrecognized
    // credential_kind — validation of credential_kind itself happens at the
    // route layer, not here).
    const resolved_release_policy = release_policy || getKind(credential_kind)?.defaultReleasePolicy || 'api';

    // VAULT-P7-FU: tls_cert credentials never had an expires_at input field,
    // so the P7 "Certificate Expiry" health card never fired. Derive it from
    // the certificate's own X.509 notAfter unless the caller explicitly
    // passed one (an explicit value always wins).
    let resolved_expires_at = expires_at;
    if (resolved_expires_at === null && credential_kind === 'tls_cert' && credentials?.certificate) {
        resolved_expires_at = extractCertExpiry(credentials.certificate);
    }
    // LI-OVERHAUL P5: same discipline for fixed-lifetime token types — an
    // explicit value always wins, otherwise stamp from the type's declared
    // lifetime so the expiry warning can actually fire.
    if (resolved_expires_at === null) {
        resolved_expires_at = lifetimeExpiryFor(integration_type);
    }

    // If setting as default, unset other defaults first
    if (is_default) {
        unsetDefaults(org_id, integration_type, scope_id);
    }

    prepare(`
        INSERT INTO integration_credentials (
            id, org_id, scope_id, integration_type, label, ciphertext, key_preview,
            endpoint_url, auth_type, headers_json, description, metadata_json,
            is_default, created_by, visibility, folder_id,
            lease_required, lease_max_duration_minutes, lease_max_uses,
            credential_kind, release_policy, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, org_id, scope_id, integration_type, label, ciphertext, key_preview,
        endpoint_url, auth_type, headers_json, description, metadata_json,
        is_default ? 1 : 0, created_by, visibility, folder_id,
        lease_required ? 1 : 0, lease_max_duration_minutes, lease_max_uses,
        credential_kind, resolved_release_policy, resolved_expires_at
    );

    return getCredentialById(id);
}

/**
 * List all credentials for an org (masked, no ciphertext)
 * @param {string} orgId - Organization ID
 * @param {Object} filters - Optional filters
 * @returns {Array} List of credentials
 */
export function listCredentials(orgId, filters = {}) {
    const { integration_type, scope_id, visibility, folder_id, user_id, role } = filters;

    let sql = `
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               endpoint_url, auth_type, headers_json, description, metadata_json,
               is_default, created_by, created_at, updated_at,
               last_used_at, last_tested_at, test_status, use_count,
               rotated_at, expires_at, visibility, folder_id,
               lease_required, lease_max_duration_minutes, lease_max_uses,
               credential_kind, release_policy
        FROM integration_credentials
        WHERE org_id = ?
    `;
    const params = [orgId];

    if (integration_type) {
        sql += ' AND integration_type = ?';
        params.push(integration_type);
    }

    if (scope_id !== undefined) {
        if (scope_id === null) {
            sql += ' AND scope_id IS NULL';
        } else {
            sql += ' AND (scope_id = ? OR scope_id IS NULL)';
            params.push(scope_id);
        }
    }

    // Visibility filtering based on role
    if (visibility) {
        sql += ' AND visibility = ?';
        params.push(visibility);
    } else if (role && role !== 'admin' && role !== 'owner' && user_id) {
        // Non-admin users: see org-wide + their own personal credentials
        sql += " AND (visibility = 'org' OR (visibility = 'personal' AND created_by = ?))";
        params.push(user_id);
    }

    // Folder filtering
    if (folder_id) {
        sql += ' AND folder_id = ?';
        params.push(folder_id);
    }

    sql += ' ORDER BY integration_type, is_default DESC, label';

    return getDb().prepare(sql).all(...params);
}

/**
 * Get a single credential by ID (masked, no ciphertext)
 * @param {string} id - Credential ID
 * @returns {Object|null} Credential or null
 */
export function getCredentialById(id) {
    return prepare(`
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               endpoint_url, auth_type, headers_json, description, metadata_json,
               is_default, created_by, created_at, updated_at,
               last_used_at, last_tested_at, test_status, use_count,
               rotated_at, expires_at, visibility, folder_id,
               lease_required, lease_max_duration_minutes, lease_max_uses,
               credential_kind, release_policy
        FROM integration_credentials
        WHERE id = ?
    `).get(id);
}

/**
 * Get credential with decrypted secrets (INTERNAL USE ONLY)
 * @param {string} id - Credential ID
 * @returns {Object|null} Credential with decrypted credentials
 */
export function getDecryptedCredential(id) {
    const row = prepare(`
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               ciphertext, endpoint_url, auth_type, headers_json,
               description, metadata_json, is_default, created_by,
               created_at, updated_at, last_used_at, use_count,
               visibility, folder_id, credential_kind, release_policy
        FROM integration_credentials WHERE id = ?
    `).get(id);

    if (!row) return null;

    try {
        row.credentials = JSON.parse(decrypt(row.ciphertext));
        delete row.ciphertext;
    } catch (err) {
        // Redact crypto internals from logs — only log that it failed, not why
        console.error(`[SECURITY] Credential decryption failed for id=${id}`);
        row.credentials = null;
    }

    return row;
}

/**
 * Update a credential
 * @param {string} id - Credential ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated credential
 */
export function updateCredential(id, updates) {
    const {
        label,
        credentials, // New credentials to encrypt (optional)
        endpoint_url,
        auth_type,
        headers_json,
        description,
        metadata_json,
        is_default,
        expires_at,
        visibility,
        folder_id,
        lease_required,
        lease_max_duration_minutes,
        lease_max_uses
    } = updates;

    // Get existing credential for org_id and integration_type
    const existing = prepare(`
        SELECT org_id, integration_type, scope_id, credential_kind FROM integration_credentials WHERE id = ?
    `).get(id);

    if (!existing) return null;

    const fields = [];
    const values = [];

    if (label !== undefined) {
        fields.push('label = ?');
        values.push(label);
    }

    if (credentials !== undefined) {
        const ciphertext = encrypt(JSON.stringify(credentials));
        const key_preview = generateKeyPreview(credentials);
        fields.push('ciphertext = ?', 'key_preview = ?');
        values.push(ciphertext, key_preview);

        // VAULT-P7-FU: re-derive expires_at from the new cert on a tls_cert
        // rotation via update, unless the caller explicitly passed expires_at
        // (handled separately below — an explicit value always wins).
        if (expires_at === undefined && existing.credential_kind === 'tls_cert' && credentials?.certificate) {
            const derived = extractCertExpiry(credentials.certificate);
            if (derived !== null) {
                fields.push('expires_at = ?');
                values.push(derived);
            }
        }
    }

    if (endpoint_url !== undefined) {
        fields.push('endpoint_url = ?');
        values.push(endpoint_url);
    }

    if (auth_type !== undefined) {
        fields.push('auth_type = ?');
        values.push(auth_type);
    }

    if (headers_json !== undefined) {
        fields.push('headers_json = ?');
        values.push(typeof headers_json === 'string' ? headers_json : JSON.stringify(headers_json));
    }

    if (description !== undefined) {
        fields.push('description = ?');
        values.push(description);
    }

    if (metadata_json !== undefined) {
        fields.push('metadata_json = ?');
        values.push(typeof metadata_json === 'string' ? metadata_json : JSON.stringify(metadata_json));
    }

    if (is_default !== undefined) {
        if (is_default) {
            unsetDefaults(existing.org_id, existing.integration_type, existing.scope_id);
        }
        fields.push('is_default = ?');
        values.push(is_default ? 1 : 0);
    }

    if (expires_at !== undefined) {
        fields.push('expires_at = ?');
        values.push(expires_at);
    }

    if (visibility !== undefined) {
        fields.push('visibility = ?');
        values.push(visibility);
    }

    if (folder_id !== undefined) {
        fields.push('folder_id = ?');
        values.push(folder_id);
    }

    if (lease_required !== undefined) {
        fields.push('lease_required = ?');
        values.push(lease_required ? 1 : 0);
    }

    if (lease_max_duration_minutes !== undefined) {
        fields.push('lease_max_duration_minutes = ?');
        values.push(lease_max_duration_minutes);
    }

    if (lease_max_uses !== undefined) {
        fields.push('lease_max_uses = ?');
        values.push(lease_max_uses);
    }

    if (updates.credential_kind !== undefined) {
        fields.push('credential_kind = ?');
        values.push(updates.credential_kind);
    }

    if (updates.release_policy !== undefined) {
        fields.push('release_policy = ?');
        values.push(updates.release_policy);
    }

    if (fields.length === 0) {
        return getCredentialById(id);
    }

    fields.push('updated_at = datetime(\'now\')');
    values.push(id);

    getDb().prepare(`
        UPDATE integration_credentials
        SET ${fields.join(', ')}
        WHERE id = ?
    `).run(...values);

    return getCredentialById(id);
}

/**
 * Delete a credential
 * @param {string} id - Credential ID
 * @returns {boolean} True if deleted
 */
export function deleteCredential(id) {
    const result = prepare(`
        DELETE FROM integration_credentials WHERE id = ?
    `).run(id);

    return result.changes > 0;
}

/**
 * Set a credential as the default for its type
 * @param {string} id - Credential ID
 * @returns {Object|null} Updated credential
 */
export function setDefault(id) {
    const cred = prepare(`
        SELECT org_id, integration_type, scope_id FROM integration_credentials WHERE id = ?
    `).get(id);

    if (!cred) return null;

    // Unset other defaults
    unsetDefaults(cred.org_id, cred.integration_type, cred.scope_id);

    // Set this one as default
    prepare(`
        UPDATE integration_credentials
        SET is_default = 1, updated_at = datetime('now')
        WHERE id = ?
    `).run(id);

    return getCredentialById(id);
}

/**
 * Update test status
 * @param {string} id - Credential ID
 * @param {string} status - 'success', 'failed', 'untested'
 * @returns {boolean} True if updated
 */
export function updateTestStatus(id, status) {
    const result = prepare(`
        UPDATE integration_credentials
        SET test_status = ?, last_tested_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
    `).run(status, id);

    return result.changes > 0;
}

/**
 * Update last used timestamp
 * @param {string} id - Credential ID
 * @returns {boolean} True if updated
 */
export function updateLastUsed(id) {
    const result = prepare(`
        UPDATE integration_credentials
        SET last_used_at = datetime('now'),
            use_count = use_count + 1
        WHERE id = ?
    `).run(id);

    return result.changes > 0;
}

/**
 * Get the default credential for a type
 * @param {string} orgId - Organization ID
 * @param {string} integrationType - Integration type
 * @param {string|null} scopeId - Optional scope ID
 * @returns {Object|null} Default credential or null
 */
export function getDefaultCredential(orgId, integrationType, scopeId = null) {
    // First try to find a scoped default
    if (scopeId) {
        const scoped = prepare(`
            SELECT id, org_id, scope_id, integration_type, label, key_preview,
                   endpoint_url, auth_type, headers_json, description, metadata_json,
                   is_default, created_by, created_at, updated_at,
                   last_used_at, last_tested_at, test_status, use_count,
                   rotated_at, expires_at
            FROM integration_credentials
            WHERE org_id = ? AND integration_type = ? AND scope_id = ? AND is_default = 1
        `).get(orgId, integrationType, scopeId);

        if (scoped) return scoped;
    }

    // Fall back to org-wide default
    return prepare(`
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               endpoint_url, auth_type, headers_json, description, metadata_json,
               is_default, created_by, created_at, updated_at,
               last_used_at, last_tested_at, test_status, use_count,
               rotated_at, expires_at
        FROM integration_credentials
        WHERE org_id = ? AND integration_type = ? AND scope_id IS NULL AND is_default = 1
    `).get(orgId, integrationType);
}

/**
 * Find credentials of a given type across every org the user belongs to.
 * Returns metadata only (no ciphertext, no key_preview) — designed for the
 * cross-org availability banner that helps users notice org-context drift.
 *
 * @param {string} userId - User ID
 * @param {string} integrationType - Integration type to look for
 * @returns {Array<{org_id, org_name, credential_id, label, is_default}>}
 */
export function findCredentialsAcrossUserOrgs(userId, integrationType) {
    return prepare(`
        SELECT ic.id            AS credential_id,
               ic.org_id         AS org_id,
               o.name            AS org_name,
               ic.label          AS label,
               ic.is_default     AS is_default,
               ic.test_status    AS test_status,
               ic.last_tested_at AS last_tested_at
        FROM integration_credentials ic
        JOIN org_memberships om ON om.org_id = ic.org_id AND om.user_id = ?
        JOIN orgs o            ON o.id      = ic.org_id
        WHERE ic.integration_type = ?
          AND ic.scope_id IS NULL
        ORDER BY ic.is_default DESC, ic.label
    `).all(userId, integrationType).map(row => ({
        credential_id: row.credential_id,
        org_id: row.org_id,
        org_name: row.org_name,
        label: row.label,
        is_default: !!row.is_default,
        test_status: row.test_status,
        last_tested_at: row.last_tested_at,
    }));
}

/**
 * Copy an existing credential into a different org, re-encrypting under the
 * same instance key. Used by the "copy here" action in the cross-org banner
 * when a user wants the same connector wired in a different organisation.
 *
 * The caller is responsible for verifying the user's membership and
 * SECRETS_WRITE on targetOrgId, and SECRETS_VIEW on the source org.
 *
 * @param {string} sourceCredentialId
 * @param {string} targetOrgId
 * @param {string} createdBy           User id of the copier (for audit)
 * @param {Object} [opts]
 * @param {string} [opts.label]        Override label (default: source label + ' (copy)')
 * @param {boolean}[opts.makeDefault]  Set as default in target org (default: only if no default exists)
 * @returns {Object} The newly created credential row (no ciphertext)
 */
export function copyCredential(sourceCredentialId, targetOrgId, createdBy, opts = {}) {
    const source = getDecryptedCredential(sourceCredentialId);
    if (!source) {
        const err = new Error('Source credential not found');
        err.code = 'source_not_found';
        throw err;
    }
    if (source.org_id === targetOrgId) {
        const err = new Error('Source and target orgs are the same');
        err.code = 'same_org';
        throw err;
    }

    const existingDefault = getDefaultCredential(targetOrgId, source.integration_type);
    const makeDefault = opts.makeDefault === true || (!existingDefault && opts.makeDefault !== false);

    let label = opts.label || `${source.label} (copy)`;
    // Disambiguate label collisions in the target org.
    let suffix = 2;
    while (labelExists(targetOrgId, source.integration_type, label)) {
        label = `${opts.label || source.label} (copy ${suffix++})`;
        if (suffix > 50) break; // give up rather than loop forever
    }

    return createCredential({
        org_id: targetOrgId,
        scope_id: null,
        integration_type: source.integration_type,
        label,
        credentials: source.credentials,
        endpoint_url: source.endpoint_url || null,
        auth_type: source.auth_type || 'api_key',
        headers_json: source.headers_json || '{}',
        description: source.description ? `${source.description}\n(copied from ${source.label})` : `Copied from ${source.label}`,
        metadata_json: source.metadata_json || '{}',
        is_default: makeDefault,
        created_by: createdBy,
        visibility: source.visibility || 'org',
        // VAULT-AUDIT P2 (FIX 5): preserve the source row's typed taxonomy —
        // without this, every copy silently re-typed to service_api/api.
        credential_kind: source.credential_kind,
        release_policy: source.release_policy,
    });
}

/**
 * Check if a label already exists for a type in an org
 * @param {string} orgId - Organization ID
 * @param {string} integrationType - Integration type
 * @param {string} label - Label to check
 * @param {string|null} scopeId - Scope ID
 * @param {string|null} excludeId - Credential ID to exclude (for updates)
 * @returns {boolean} True if label exists
 */
export function labelExists(orgId, integrationType, label, scopeId = null, excludeId = null) {
    let sql = `
        SELECT COUNT(*) as count
        FROM integration_credentials
        WHERE org_id = ? AND integration_type = ? AND label = ?
    `;
    const params = [orgId, integrationType, label];

    if (scopeId === null) {
        sql += ' AND scope_id IS NULL';
    } else {
        sql += ' AND scope_id = ?';
        params.push(scopeId);
    }

    if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
    }

    const result = getDb().prepare(sql).get(...params);
    return result.count > 0;
}

// Helper: Unset defaults for a type
function unsetDefaults(orgId, integrationType, scopeId) {
    if (scopeId === null) {
        prepare(`
            UPDATE integration_credentials
            SET is_default = 0, updated_at = datetime('now')
            WHERE org_id = ? AND integration_type = ? AND scope_id IS NULL AND is_default = 1
        `).run(orgId, integrationType);
    } else {
        prepare(`
            UPDATE integration_credentials
            SET is_default = 0, updated_at = datetime('now')
            WHERE org_id = ? AND integration_type = ? AND scope_id = ? AND is_default = 1
        `).run(orgId, integrationType, scopeId);
    }
}

// Helper: Generate key preview from credentials
function generateKeyPreview(credentials) {
    // Find the main key field
    const keyFields = ['api_key', 'token', 'bot_token', 'access_token', 'secret'];
    for (const field of keyFields) {
        if (credentials[field]) {
            return getKeyPreview(credentials[field]);
        }
    }
    return '****';
}

/**
 * Re-encrypt all credentials with a new key
 * Used during master key rotation
 * @param {Buffer} oldKey - Previous 32-byte encryption key
 * @param {Buffer} newKey - New 32-byte encryption key
 * @returns {{ count: number, errors: Array }} Re-encryption results
 */
export function reencryptAllCredentials(oldKey, newKey) {
    const db = getDb();

    // Get all credentials with ciphertext
    const credentials = db.prepare(`
        SELECT id, ciphertext FROM integration_credentials
    `).all();

    const errors = [];
    let count = 0;

    for (const cred of credentials) {
        try {
            const newCiphertext = reencrypt(cred.ciphertext, oldKey, newKey);
            db.prepare(`
                UPDATE integration_credentials
                SET ciphertext = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(newCiphertext, cred.id);
            count++;
        } catch (err) {
            errors.push({ id: cred.id, error: err.message });
        }
    }

    return { count, errors };
}

/**
 * Rotate a credential: re-encrypt with new credentials, set rotated_at
 * @param {string} id - Credential ID
 * @param {Object} newCredentials - New plain credentials to encrypt
 * @param {string|null} expiresAt - Optional new expiration timestamp
 * @returns {Object|null} Updated credential (masked)
 */
export function rotateCredential(id, newCredentials, expiresAt) {
    const existing = prepare(`
        SELECT id, org_id, key_preview, credential_kind, integration_type FROM integration_credentials WHERE id = ?
    `).get(id);

    if (!existing) return null;

    const ciphertext = encrypt(JSON.stringify(newCredentials));
    const key_preview = generateKeyPreview(newCredentials);
    const oldKeyPreview = existing.key_preview;

    const fields = [
        'ciphertext = ?',
        'key_preview = ?',
        'rotated_at = datetime(\'now\')',
        'updated_at = datetime(\'now\')'
    ];
    const values = [ciphertext, key_preview];

    // VAULT-P7-FU: an explicitly-passed expiresAt always wins; otherwise
    // derive it from the new certificate's notAfter for tls_cert rotations.
    let resolvedExpiresAt = expiresAt;
    if (resolvedExpiresAt === undefined && existing.credential_kind === 'tls_cert' && newCredentials?.certificate) {
        resolvedExpiresAt = extractCertExpiry(newCredentials.certificate);
    }
    // LI-OVERHAUL P5: a rotation is a fresh token, so fixed-lifetime types
    // (linkedin: 60 days) get a fresh expiry window unless the caller passed
    // one explicitly (including null to clear).
    if (resolvedExpiresAt === undefined) {
        resolvedExpiresAt = lifetimeExpiryFor(existing.integration_type) ?? resolvedExpiresAt;
    }

    if (resolvedExpiresAt !== undefined && resolvedExpiresAt !== null) {
        fields.push('expires_at = ?');
        values.push(resolvedExpiresAt);
    } else if (expiresAt !== undefined) {
        // Caller explicitly passed expiresAt (including null to clear it).
        fields.push('expires_at = ?');
        values.push(expiresAt);
    }

    values.push(id);

    getDb().prepare(`
        UPDATE integration_credentials
        SET ${fields.join(', ')}
        WHERE id = ?
    `).run(...values);

    const updated = getCredentialById(id);
    // Attach old key preview for audit forensics
    if (updated) updated._oldKeyPreview = oldKeyPreview;
    return updated;
}

/**
 * Get credentials expiring within N days
 * @param {string} orgId - Organization ID
 * @param {number} withinDays - Days ahead to check (default 7)
 * @returns {Array} Expiring credentials
 */
export function getExpiring(orgId, withinDays = 7) {
    return getDb().prepare(`
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               is_default, created_at, updated_at, rotated_at, expires_at,
               last_used_at, last_tested_at, test_status, use_count
        FROM integration_credentials
        WHERE org_id = ?
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now', '+' || ? || ' days')
        ORDER BY expires_at ASC
    `).all(orgId, withinDays);
}

/**
 * Get credentials overdue for rotation
 * @param {string} orgId - Organization ID
 * @param {number} maxAgeDays - Max age in days before rotation is overdue (default 90)
 * @returns {Array} Overdue credentials
 */
export function getRotationOverdue(orgId, maxAgeDays = 90) {
    return getDb().prepare(`
        SELECT id, org_id, scope_id, integration_type, label, key_preview,
               is_default, created_at, updated_at, rotated_at, expires_at,
               last_used_at, last_tested_at, test_status, use_count
        FROM integration_credentials
        WHERE org_id = ?
          AND (
            (rotated_at IS NULL AND created_at < datetime('now', '-' || ? || ' days'))
            OR (rotated_at IS NOT NULL AND rotated_at < datetime('now', '-' || ? || ' days'))
          )
        ORDER BY COALESCE(rotated_at, created_at) ASC
    `).all(orgId, maxAgeDays, maxAgeDays);
}

// ============================================================================
// Credential Folders CRUD
// ============================================================================

/**
 * List folders for an org
 */
export function listFolders(orgId) {
    return getDb().prepare(`
        SELECT f.*,
               (SELECT COUNT(*) FROM integration_credentials WHERE folder_id = f.id) AS credential_count
        FROM credential_folders f
        WHERE f.org_id = ?
        ORDER BY f.name
    `).all(orgId);
}

/**
 * Get a folder by ID
 */
export function getFolderById(id) {
    return getDb().prepare(`
        SELECT f.*,
               (SELECT COUNT(*) FROM integration_credentials WHERE folder_id = f.id) AS credential_count
        FROM credential_folders f
        WHERE f.id = ?
    `).get(id);
}

/**
 * Create a folder
 */
export function createFolder(data) {
    const { org_id, name, parent_id = null, color = '#6b7280', icon = 'folder', created_by } = data;
    const id = generateId();

    // Check nesting depth (max 3)
    if (parent_id) {
        let depth = 1;
        let current = parent_id;
        while (current) {
            const parent = getDb().prepare('SELECT parent_id FROM credential_folders WHERE id = ?').get(current);
            if (parent?.parent_id) {
                depth++;
                current = parent.parent_id;
            } else {
                break;
            }
        }
        if (depth >= 3) {
            throw new Error('Maximum folder nesting depth is 3');
        }
    }

    getDb().prepare(`
        INSERT INTO credential_folders (id, org_id, name, parent_id, color, icon, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, org_id, name, parent_id, color, icon, created_by);

    return getFolderById(id);
}

/**
 * Update a folder
 */
export function updateFolder(id, updates) {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
    }
    if (updates.color !== undefined) {
        fields.push('color = ?');
        values.push(updates.color);
    }
    if (updates.icon !== undefined) {
        fields.push('icon = ?');
        values.push(updates.icon);
    }
    if (updates.parent_id !== undefined) {
        fields.push('parent_id = ?');
        values.push(updates.parent_id);
    }

    if (fields.length === 0) return getFolderById(id);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    getDb().prepare(`
        UPDATE credential_folders SET ${fields.join(', ')} WHERE id = ?
    `).run(...values);

    return getFolderById(id);
}

/**
 * Delete a folder (moves credentials to no-folder)
 */
export function deleteFolder(id) {
    // Move credentials out of this folder
    getDb().prepare(`
        UPDATE integration_credentials SET folder_id = NULL WHERE folder_id = ?
    `).run(id);

    // Move child folders to parent (or root)
    const folder = getDb().prepare('SELECT parent_id FROM credential_folders WHERE id = ?').get(id);
    if (folder) {
        getDb().prepare(`
            UPDATE credential_folders SET parent_id = ? WHERE parent_id = ?
        `).run(folder.parent_id, id);
    }

    const result = getDb().prepare('DELETE FROM credential_folders WHERE id = ?').run(id);
    return result.changes > 0;
}

// ============================================================================
// Agent Credential Assignments
// ============================================================================

/**
 * Get credential assignments for an agent
 */
export function getAgentAssignments(orgId, agentId, toolType) {
    let sql = `
        SELECT a.*, c.integration_type, c.label, c.key_preview, c.test_status
        FROM agent_credential_assignments a
        JOIN integration_credentials c ON a.credential_id = c.id
        WHERE a.org_id = ?
    `;
    const params = [orgId];

    if (agentId) {
        sql += ' AND a.agent_id = ?';
        params.push(agentId);
    }
    if (toolType) {
        sql += ' AND a.tool_type = ?';
        params.push(toolType);
    }

    sql += ' ORDER BY a.priority DESC, a.created_at';

    return getDb().prepare(sql).all(...params);
}

/**
 * Assign a credential to an agent
 */
export function assignCredentialToAgent(data) {
    const { org_id, agent_id, credential_id, tool_type, priority = 0, created_by } = data;
    const id = generateId();

    getDb().prepare(`
        INSERT INTO agent_credential_assignments (id, org_id, agent_id, credential_id, tool_type, priority, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, org_id, agent_id, credential_id, tool_type, priority, created_by);

    return { id, org_id, agent_id, credential_id, tool_type, priority };
}

/**
 * Remove an agent credential assignment
 */
export function removeAgentAssignment(id) {
    const result = getDb().prepare('DELETE FROM agent_credential_assignments WHERE id = ?').run(id);
    return result.changes > 0;
}

/**
 * Get the best credential for an agent given a tool type
 * Returns the highest-priority assignment, or null
 */
export function getAgentCredential(orgId, agentId, toolType) {
    return getDb().prepare(`
        SELECT a.credential_id, c.integration_type, c.label
        FROM agent_credential_assignments a
        JOIN integration_credentials c ON a.credential_id = c.id
        WHERE a.org_id = ? AND a.agent_id = ? AND a.tool_type = ?
        ORDER BY a.priority DESC
        LIMIT 1
    `).get(orgId, agentId, toolType) || null;
}

// ============================================================================
// Credential Leases (JIT Agent Access)
// ============================================================================

/**
 * Create a lease request (status: pending)
 */
export function createLease(data) {
    const {
        org_id, credential_id, requested_by_agent_id,
        requested_by_task_id = null, justification = null,
        context_json = '{}', max_uses = null, inbox_item_id = null
    } = data;

    const id = generateId();

    getDb().prepare(`
        INSERT INTO credential_leases (
            id, org_id, credential_id, requested_by_agent_id,
            requested_by_task_id, justification, context_json,
            max_uses, inbox_item_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, org_id, credential_id, requested_by_agent_id,
        requested_by_task_id, justification, context_json,
        max_uses, inbox_item_id);

    return getLeaseById(id);
}

/**
 * Get a lease by ID
 */
export function getLeaseById(id) {
    return getDb().prepare(`
        SELECT l.*, c.integration_type, c.label as credential_label
        FROM credential_leases l
        JOIN integration_credentials c ON l.credential_id = c.id
        WHERE l.id = ?
    `).get(id) || null;
}

/**
 * Approve a lease (sets active, grants TTL)
 */
export function approveLease(id, approvedBy, durationMinutes) {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET status = 'active',
            approved_by = ?,
            granted_at = datetime('now'),
            expires_at = datetime('now', '+' || ? || ' minutes'),
            updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
    `).run(approvedBy, durationMinutes, id);

    if (result.changes === 0) return null;
    return getLeaseById(id);
}

/**
 * VAULT-P5.I — Link a lease to the HITL inbox_item created for it (F4's
 * stubbed inbox_item_id, always null until now). Populating this is what
 * exempts the lease from cancelStalePendingLeases()'s 15-min auto-cancel
 * (that query already filters `WHERE inbox_item_id IS NULL`).
 */
export function setLeaseInboxItem(id, inboxItemId) {
    const result = getDb().prepare(`
        UPDATE credential_leases SET inbox_item_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(inboxItemId, id);
    if (result.changes === 0) return null;
    return getLeaseById(id);
}

/**
 * Deny a lease
 */
export function denyLease(id, deniedBy) {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET status = 'denied', approved_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
    `).run(deniedBy, id);

    if (result.changes === 0) return null;
    return getLeaseById(id);
}

/**
 * Revoke an active lease immediately
 */
export function revokeLease(id) {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET status = 'revoked', revoked_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'active'
    `).run(id);

    return result.changes > 0;
}

/**
 * Expire overdue active leases (background job)
 * @returns {number} Number of leases expired
 */
export function expireOverdueLeases() {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET status = 'expired', updated_at = datetime('now')
        WHERE status = 'active' AND expires_at < datetime('now')
    `).run();

    return result.changes;
}

/**
 * Cancel stale pending leases (no inbox item after 15 min)
 */
export function cancelStalePendingLeases() {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE status = 'pending'
          AND inbox_item_id IS NULL
          AND requested_at < datetime('now', '-15 minutes')
    `).run();

    return result.changes;
}

/**
 * Increment use_count atomically (returns false if max_uses exceeded)
 */
export function incrementLeaseUse(id) {
    const result = getDb().prepare(`
        UPDATE credential_leases
        SET use_count = use_count + 1,
            last_used_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'active'
          AND expires_at > datetime('now')
          AND (max_uses IS NULL OR use_count < max_uses)
    `).run(id);

    return result.changes > 0;
}

/**
 * Check if an agent has an active lease for a credential
 */
export function getActiveLease(orgId, agentId, credentialId) {
    return getDb().prepare(`
        SELECT * FROM credential_leases
        WHERE org_id = ?
          AND requested_by_agent_id = ?
          AND credential_id = ?
          AND status = 'active'
          AND expires_at > datetime('now')
          AND (max_uses IS NULL OR use_count < max_uses)
        ORDER BY expires_at DESC
        LIMIT 1
    `).get(orgId, agentId, credentialId) || null;
}

/**
 * List leases with filters
 */
export function listLeases(orgId, filters = {}) {
    const { status, agent_id, credential_id, limit = 50 } = filters;

    let sql = `
        SELECT l.*, c.integration_type, c.label as credential_label
        FROM credential_leases l
        JOIN integration_credentials c ON l.credential_id = c.id
        WHERE l.org_id = ?
    `;
    const params = [orgId];

    if (status) {
        sql += ' AND l.status = ?';
        params.push(status);
    }
    if (agent_id) {
        sql += ' AND l.requested_by_agent_id = ?';
        params.push(agent_id);
    }
    if (credential_id) {
        sql += ' AND l.credential_id = ?';
        params.push(credential_id);
    }

    sql += ' ORDER BY l.created_at DESC LIMIT ?';
    params.push(limit);

    return getDb().prepare(sql).all(...params);
}

/**
 * Count pending lease requests per agent (rate limiting)
 */
export function countPendingLeases(orgId, agentId) {
    const result = getDb().prepare(`
        SELECT COUNT(*) as count FROM credential_leases
        WHERE org_id = ? AND requested_by_agent_id = ? AND status = 'pending'
          AND requested_at > datetime('now', '-1 hour')
    `).get(orgId, agentId);
    return result?.count || 0;
}

export default {
    createCredential,
    listCredentials,
    getCredentialById,
    getDecryptedCredential,
    updateCredential,
    deleteCredential,
    setDefault,
    updateTestStatus,
    updateLastUsed,
    getDefaultCredential,
    labelExists,
    reencryptAllCredentials,
    rotateCredential,
    getExpiring,
    getRotationOverdue,
    listFolders,
    getFolderById,
    createFolder,
    updateFolder,
    deleteFolder,
    getAgentAssignments,
    assignCredentialToAgent,
    removeAgentAssignment,
    getAgentCredential,
    createLease,
    getLeaseById,
    approveLease,
    setLeaseInboxItem,
    denyLease,
    revokeLease,
    expireOverdueLeases,
    cancelStalePendingLeases,
    incrementLeaseUse,
    getActiveLease,
    listLeases,
    countPendingLeases
};
