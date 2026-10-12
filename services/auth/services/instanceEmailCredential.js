/**
 * Instance email credential — EMAIL-UNIFY P2.
 *
 * The instance-wide SMTP transport, stored in QuoxVault instead of the
 * `instance_config` key/value table. This is the whole point of P2: one
 * encrypted, audited, rotatable store for every email credential, so
 * "configure email" means exactly one place.
 *
 * Shape on disk: an `email_account` credential of integration_type 'smtp',
 * at the instance scope (see lib/instanceScope.js), flagged is_default so the
 * existing getDefaultCredential() lookup finds it with no new query shape.
 * Field names follow the email_account kind so the same credential is
 * legible to the vault UI and to the per-org notification resolver:
 *
 *   { smtp_host, smtp_port, smtp_secure, username, password, from }
 *
 * Reads are intentionally cheap and never write: an instance with no email
 * configured must not create an orgs row just because something asked.
 */

import { getDb } from '../db/index.js';
import {
    createCredential,
    getDecryptedCredential,
    updateCredential,
    deleteCredential,
} from '../db/integrations.js';
import { INSTANCE_ORG_ID, ensureInstanceOrg, instanceOrgExists } from '../lib/instanceScope.js';

/** Vault integration_type. Matches PROVIDER_TYPE_MAP.smtp in credentialResolver.js. */
export const INSTANCE_SMTP_TYPE = 'smtp';

/** Stable label — the panel owns this row, so it must be findable by more than is_default. */
export const INSTANCE_SMTP_LABEL = 'Instance email (SMTP)';

/**
 * The instance SMTP credential row (masked, no ciphertext), or null.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {object|null}
 */
export function getInstanceSmtpCredential({ db: dbArg } = {}) {
    const db = dbArg || getDb();
    if (!instanceOrgExists({ db })) return null;

    // Own SELECT rather than getDefaultCredential(): that helper returns a
    // fixed column list without credential_kind, and a credential that lost
    // its is_default flag (hand-edited, restored backup) is still ours if it
    // carries our label — prefer repairing over silently going dark.
    const row = db.prepare(`
        SELECT * FROM integration_credentials
        WHERE org_id = ? AND integration_type = ? AND scope_id IS NULL
        ORDER BY is_default DESC, (label = ?) DESC, created_at ASC
        LIMIT 1
    `).get(INSTANCE_ORG_ID, INSTANCE_SMTP_TYPE, INSTANCE_SMTP_LABEL);
    return row || null;
}

/**
 * The instance SMTP transport, decrypted, or null when unconfigured.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {{host: string, port: number, secure: boolean, user: string, pass: string, from: string}|null}
 */
export function readInstanceSmtp({ db: dbArg } = {}) {
    const cred = getInstanceSmtpCredential({ db: dbArg });
    if (!cred) return null;

    let fields;
    try {
        fields = getDecryptedCredential(cred.id)?.credentials;
    } catch (err) {
        console.error('[InstanceEmail] Failed to decrypt the instance SMTP credential:', err.message);
        return null;
    }
    if (!fields?.smtp_host || !fields?.from) return null;

    return {
        host: fields.smtp_host,
        port: fields.smtp_port ? Number(fields.smtp_port) : 587,
        secure: fields.smtp_secure === true || fields.smtp_secure === 'true',
        user: fields.username || '',
        pass: fields.password || '',
        from: fields.from,
    };
}

/**
 * Create or update the instance SMTP credential.
 *
 * A blank/omitted `pass` keeps the stored password (the panel never echoes it
 * back, so a save that only changes the host must not wipe the secret).
 *
 * @param {object} fields { host, port, user, pass, from, secure }
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {string} [options.userId] The admin performing the write (created_by)
 * @returns {{ id: string, created: boolean }}
 */
export function writeInstanceSmtp(fields, { db: dbArg, userId = null } = {}) {
    const db = dbArg || getDb();
    const { host, port, user, pass, from, secure } = fields || {};

    const existing = getInstanceSmtpCredential({ db });

    let password = pass ? String(pass) : '';
    if (!password && existing) {
        // Keep whatever is already stored.
        try {
            password = getDecryptedCredential(existing.id)?.credentials?.password || '';
        } catch {
            password = '';
        }
    }

    const credentials = {
        smtp_host: String(host).trim(),
        smtp_port: String(Number(port)),
        smtp_secure: secure ? 'true' : 'false',
        username: (user || '').trim(),
        password,
        from: String(from).trim(),
    };

    if (existing) {
        updateCredential(existing.id, { credentials, label: INSTANCE_SMTP_LABEL, is_default: true });
        return { id: existing.id, created: false };
    }

    const ownerId = ensureInstanceOrg({ db, userId });
    const createdBy = userId || db.prepare('SELECT owner_user_id AS id FROM orgs WHERE id = ?').get(ownerId)?.id;
    if (!createdBy) {
        throw new Error('instance_smtp_no_actor: cannot attribute the credential to a user');
    }

    const cred = createCredential({
        org_id: INSTANCE_ORG_ID,
        integration_type: INSTANCE_SMTP_TYPE,
        label: INSTANCE_SMTP_LABEL,
        credentials,
        credential_kind: 'email_account',
        auth_type: 'basic',
        is_default: true,
        created_by: createdBy,
        visibility: 'org',
        description: 'Instance-wide email transport. Powers transactional mail, QuoxChat transcripts and HITL notifications.',
    });

    return { id: cred.id, created: true };
}

/**
 * Delete the instance SMTP credential. Used by tests and by an explicit
 * "disconnect email" action; never called implicitly on a failed send.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {boolean} whether a credential was removed
 */
export function clearInstanceSmtp({ db: dbArg } = {}) {
    const cred = getInstanceSmtpCredential({ db: dbArg });
    if (!cred) return false;
    deleteCredential(cred.id);
    return true;
}
