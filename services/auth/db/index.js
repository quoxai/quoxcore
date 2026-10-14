/**
 * Database connection and helpers for Quox Auth Service
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations, findMigrationsDir } from '../lib/runMigrations.js';
import { applyLegacyDataMigrations } from '../lib/legacyDataMigrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default to ./data/auth.db (relative to auth service root, i.e., services/auth/data/)
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

// Ensure directory exists
const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
}

// Initialize database with schema if needed
let db;

export function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');

        // Versioned schema migrations: schema_migrations tracking table +
        // ordered numbered .sql files in migrations/. Replaces the old
        // "exec db/schema.sql once on a fresh DB, then run a ~113-ALTER
        // ad-hoc applyMigrations() function" boot sequence. See
        // migrations/000-baseline.sql (current full schema, idempotent
        // CREATE ... IF NOT EXISTS — this is what a FRESH database builds
        // from) and migrations/001..070-*.sql (folded 1:1 from the old
        // flat ALTER/CREATE blocks in db/index.js's applyMigrations(),
        // preserving each block's original idempotent-guard grouping).
        runMigrations({ db, migrationsDir: findMigrationsDir(__dirname), log: console.log });

        // Legacy JS-level data migrations that can't be expressed as
        // declarative SQL (runtime introspection / per-row backfill /
        // conditional branching) — health_endpoint URL fix, default
        // share_policies seeding, backup_components CHECK-widening,
        // notification/integration CHECK-widening, and the
        // powers_credentials legacy-table drop. Runs after the SQL
        // migrations so every table it touches already exists. See
        // lib/legacyDataMigrations.js.
        applyLegacyDataMigrations(db);
    }
    return db;
}


// Close database gracefully
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

// Transaction helper
export function transaction(fn) {
    const database = getDb();
    return database.transaction(fn)();
}

// Prepared statement cache
const stmtCache = new Map();

export function prepare(sql) {
    if (!stmtCache.has(sql)) {
        stmtCache.set(sql, getDb().prepare(sql));
    }
    return stmtCache.get(sql);
}

// ============================================================================
// COLUMN ALLOWLISTS - Security fix for SQL injection via dynamic column names
// Issue #64: Validate column names against allowlist before using in queries
// ============================================================================

const ALLOWED_USER_COLUMNS = new Set([
    'primary_email', 'display_name', 'status', 'avatar_url', 'timezone',
    'mfa_enabled', 'mfa_secret', 'failed_login_count', 'lockout_until', 'last_failed_at'
]);

const ALLOWED_ORG_MEMBERSHIP_COLUMNS = new Set([
    'role', 'status', 'invited_by', 'invited_at', 'joined_at', 'accepted_at', 'custom_role_id'
]);

const ALLOWED_DIVISION_COLUMNS = new Set([
    'name', 'slug', 'description', 'settings_json'
]);

/**
 * Validate column names against an allowlist to prevent SQL injection
 * @param {Object} fields - Object with column names as keys
 * @param {Set} allowedColumns - Set of allowed column names
 * @returns {Object} - Object with only valid columns (invalid columns are filtered out)
 */
function validateColumns(fields, allowedColumns) {
    const validFields = {};
    const invalidColumns = [];
    for (const [key, value] of Object.entries(fields)) {
        if (allowedColumns.has(key)) {
            validFields[key] = value;
        } else {
            invalidColumns.push(key);
        }
    }
    if (invalidColumns.length > 0) {
        console.warn(`[SQL Validation] Blocked invalid column names: ${invalidColumns.join(', ')}`);
    }
    return validFields;
}

// Common query helpers
export const queries = {
    // Users
    getUserById: (id) => prepare('SELECT * FROM users WHERE id = ?').get(id),
    getUserByEmail: (email) => prepare('SELECT * FROM users WHERE primary_email = ?').get(email),

    createUser: (user) => prepare(`
        INSERT INTO users (id, primary_email, display_name, status)
        VALUES (?, ?, ?, ?)
    `).run(user.id, user.primary_email, user.display_name, user.status || 'pending_verification'),

    updateUser: (id, fields) => {
        // Validate column names against allowlist (Security Issue #64)
        const validFields = validateColumns(fields, ALLOWED_USER_COLUMNS);
        if (Object.keys(validFields).length === 0) {
            return { changes: 0 };
        }
        const updates = Object.keys(validFields).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(validFields), id];
        return getDb().prepare(`UPDATE users SET ${updates}, updated_at = datetime('now') WHERE id = ?`).run(...values);
    },

    // User emails
    createUserEmail: (userEmail) => prepare(`
        INSERT INTO user_emails (id, user_id, email, is_primary, verification_token, verification_expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userEmail.id, userEmail.user_id, userEmail.email, userEmail.is_primary ? 1 : 0,
           userEmail.verification_token, userEmail.verification_expires_at),

    getUserEmailByToken: (token) => prepare(`
        SELECT * FROM user_emails WHERE verification_token = ?
    `).get(token),

    verifyUserEmail: (id) => prepare(`
        UPDATE user_emails SET verified_at = datetime('now'), verification_token = NULL
        WHERE id = ?
    `).run(id),

    // Auth identities
    createAuthIdentity: (identity) => prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_sub, password_hash, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(identity.id, identity.user_id, identity.provider, identity.provider_sub,
           identity.password_hash, identity.metadata_json || '{}'),

    getPasswordIdentity: (userId) => prepare(`
        SELECT * FROM auth_identities WHERE user_id = ? AND provider = 'password'
    `).get(userId),

    updatePasswordHash: (userId, hash) => prepare(`
        UPDATE auth_identities SET password_hash = ?, updated_at = datetime('now')
        WHERE user_id = ? AND provider = 'password'
    `).run(hash, userId),

    // Sessions
    // AUTH-REMEMBER-ME: remember_me defaults to 0 (unset) for backward
    // compatibility with any caller not passing it.
    createSession: (session) => prepare(`
        INSERT INTO sessions (id, user_id, org_id, refresh_token_hash, device_fingerprint, ip_address, user_agent, expires_at, remember_me, client)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.user_id, session.org_id, session.refresh_token_hash,
           session.device_fingerprint, session.ip_address, session.user_agent, session.expires_at,
           session.remember_me ? 1 : 0, session.client === 'cli' ? 'cli' : 'web'),

    getSessionByTokenHash: (hash) => prepare(`
        SELECT * FROM sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL
    `).get(hash),

    // LAUNCH-SPINE: locate a session from a refresh token's `jti`.
    //
    // createRefreshToken() stores refresh_token_hash = sha256(token) and puts
    // jti = sha256(token).slice(0, 16) in the JWT, so the jti IS the first 16
    // characters of the stored hash. The refresh route used to call
    // getSessionByTokenHash(sha256(jti)), hashing the jti a second time, which
    // produced a value unrelated to anything stored — so no session was ever
    // found and every refresh returned 401. Sessions therefore died the moment
    // the one-hour access token expired.
    //
    // Scoped by user_id as well as the prefix: authenticity is already
    // established by the JWT signature check before this call, so the lookup
    // only has to find the row, and scoping to the subject means a 64-bit
    // prefix collision cannot hand one user another user's session.
    getSessionByRefreshJti: (jti, userId) => prepare(`
        SELECT * FROM sessions
        WHERE user_id = ?
          AND substr(refresh_token_hash, 1, 16) = ?
          AND revoked_at IS NULL
    `).get(userId, jti),

    revokeSession: (id) => prepare(`
        UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?
    `).run(id),

    revokeAllUserSessions: (userId) => prepare(`
        UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL
    `).run(userId),

    updateSessionMfa: (id) => prepare(`
        UPDATE sessions SET mfa_verified = 1 WHERE id = ?
    `).run(id),

    // ET-ENFORCE round-3 — accept an optional sessionId so switch-org only
    // affects the caller's current device. Without it (legacy callers) we
    // fall back to the broad "all of this user's live sessions" UPDATE,
    // which silently flips org_id on every device the user is logged in on.
    updateSessionOrg: (userId, orgId, sessionId = null) => {
        if (sessionId) {
            return prepare(`
                UPDATE sessions SET org_id = ?
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
            `).run(orgId, sessionId, userId);
        }
        return prepare(`
            UPDATE sessions SET org_id = ?
            WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        `).run(orgId, userId);
    },

    getLatestSessionOrg: (userId) => prepare(`
        SELECT org_id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') AND org_id IS NOT NULL ORDER BY created_at DESC LIMIT 1
    `).get(userId),

    touchSession: (id) => prepare(`
        UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?
    `).run(id),

    // Orgs
    getOrgById: (id) => prepare('SELECT * FROM orgs WHERE id = ? AND deleted_at IS NULL').get(id),
    getOrgBySlug: (slug) => prepare('SELECT * FROM orgs WHERE slug = ? AND deleted_at IS NULL').get(slug),

    createOrg: (org) => prepare(`
        INSERT INTO orgs (id, name, slug, description, owner_user_id, plan, mfa_policy, settings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(org.id, org.name, org.slug, org.description || null, org.owner_user_id, org.plan || 'free',
           org.mfa_policy || 'optional', org.settings_json || '{}'),

    getUserOrgs: (userId) => prepare(`
        SELECT o.*, om.role, om.status as membership_status, om.preferences_json as member_preferences_json
        FROM orgs o
        JOIN org_memberships om ON o.id = om.org_id
        WHERE om.user_id = ? AND om.status = 'active' AND o.deleted_at IS NULL
        ORDER BY om.created_at ASC
    `).all(userId),

    // Org memberships
    getOrgMembership: (orgId, userId) => prepare(`
        SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ?
    `).get(orgId, userId),

    createOrgMembership: (membership) => prepare(`
        INSERT INTO org_memberships (id, org_id, user_id, role, status, invited_by, invited_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(membership.id, membership.org_id, membership.user_id, membership.role,
           membership.status, membership.invited_by, membership.invited_at),

    updateOrgMembership: (id, fields) => {
        // Validate column names against allowlist (Security Issue #64)
        const validFields = validateColumns(fields, ALLOWED_ORG_MEMBERSHIP_COLUMNS);
        if (Object.keys(validFields).length === 0) {
            return { changes: 0 };
        }
        const updates = Object.keys(validFields).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(validFields), id];
        return getDb().prepare(`UPDATE org_memberships SET ${updates}, updated_at = datetime('now') WHERE id = ?`).run(...values);
    },

    getOrgMembers: (orgId) => prepare(`
        SELECT u.id, u.primary_email, u.display_name, u.status as user_status,
               om.role, om.status, om.created_at as joined_at,
               om.custom_role_id,
               cr.name as custom_role_name
        FROM users u
        JOIN org_memberships om ON u.id = om.user_id
        LEFT JOIN custom_roles cr
               ON cr.id = om.custom_role_id
              AND cr.org_id = om.org_id
              AND cr.deleted_at IS NULL
        WHERE om.org_id = ? AND om.status IN ('active', 'invited')
        ORDER BY om.role, u.display_name
    `).all(orgId),

    // Invites
    createInvite: (invite) => prepare(`
        INSERT INTO invites (id, org_id, team_id, email, role, invited_by, token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invite.id, invite.org_id, invite.team_id, invite.email, invite.role,
           invite.invited_by, invite.token, invite.expires_at),

    getInviteByToken: (token) => prepare(`
        SELECT i.*, o.name as org_name, o.slug as org_slug
        FROM invites i
        JOIN orgs o ON i.org_id = o.id
        WHERE i.token = ? AND i.status = 'pending'
    `).get(token),

    // #324: like getInviteByToken but no status filter — lets the
    // preview route distinguish "token never existed" (404) from
    // "invite exists but was accepted/expired" (410 invite_not_usable).
    getInviteByTokenAny: (token) => prepare(`
        SELECT i.*, o.name as org_name, o.slug as org_slug
        FROM invites i
        JOIN orgs o ON i.org_id = o.id
        WHERE i.token = ?
    `).get(token),

    updateInviteStatus: (id, status, acceptedBy) => prepare(`
        UPDATE invites SET status = ?, accepted_at = datetime('now'), accepted_by = ?
        WHERE id = ?
    `).run(status, acceptedBy, id),

    expireOldInvites: () => prepare(`
        UPDATE invites SET status = 'expired'
        WHERE status = 'pending' AND expires_at < datetime('now')
    `).run(),

    // Audit
    createAuditEvent: (event) => prepare(`
        INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, scope_id, status, ip_address, user_agent, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.org_id, event.actor_type, event.actor_id, event.action,
           event.target_type, event.target_id, event.scope_id, event.status || 'success',
           event.ip_address, event.user_agent, event.metadata_json || '{}'),

    getAuditEvents: (orgId, limit = 100, offset = 0) => prepare(`
        SELECT * FROM audit_events
        WHERE org_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `).all(orgId, limit, offset),

    // MFA
    setMfaSecret: (userId, secret) => prepare(`
        UPDATE users SET mfa_secret = ?, updated_at = datetime('now') WHERE id = ?
    `).run(secret, userId),

    enableMfa: (userId) => prepare(`
        UPDATE users SET mfa_enabled = 1, updated_at = datetime('now') WHERE id = ?
    `).run(userId),

    disableMfa: (userId) => prepare(`
        UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(userId),

    createBackupCodes: (codes) => {
        const stmt = prepare(`
            INSERT INTO mfa_backup_codes (id, user_id, code_hash)
            VALUES (?, ?, ?)
        `);
        const insert = getDb().transaction((codes) => {
            for (const code of codes) {
                stmt.run(code.id, code.user_id, code.code_hash);
            }
        });
        return insert(codes);
    },

    useBackupCode: (userId, codeHash) => prepare(`
        UPDATE mfa_backup_codes SET used_at = datetime('now')
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    `).run(userId, codeHash),

    getUnusedBackupCodes: (userId) => prepare(`
        SELECT * FROM mfa_backup_codes WHERE user_id = ? AND used_at IS NULL
    `).all(userId),

    deleteBackupCodes: (userId) => prepare(`
        DELETE FROM mfa_backup_codes WHERE user_id = ?
    `).run(userId),

    // Account lockout (Security Issue #47)
    incrementFailedLogin: (userId) => prepare(`
        UPDATE users
        SET failed_login_count = failed_login_count + 1,
            last_failed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
    `).run(userId),

    setAccountLockout: (userId, lockoutUntil) => prepare(`
        UPDATE users
        SET lockout_until = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(lockoutUntil, userId),

    resetFailedLogins: (userId) => prepare(`
        UPDATE users
        SET failed_login_count = 0,
            lockout_until = NULL,
            last_failed_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(userId),

    getLoginAttemptInfo: (userId) => prepare(`
        SELECT failed_login_count, lockout_until, last_failed_at
        FROM users WHERE id = ?
    `).get(userId),

    // Service accounts
    createServiceAccount: (sa) => prepare(`
        INSERT INTO service_accounts (id, org_id, name, description, role, api_key_hash, api_key_prefix, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sa.id, sa.org_id, sa.name, sa.description, sa.role, sa.api_key_hash,
           sa.api_key_prefix, sa.created_by, sa.expires_at),

    getServiceAccountByKeyPrefix: (prefix) => prepare(`
        SELECT * FROM service_accounts WHERE api_key_prefix = ? AND status = 'active'
    `).get(prefix),

    getOrgServiceAccounts: (orgId) => prepare(`
        SELECT id, name, description, role, api_key_prefix, last_used_at, status, created_at, expires_at
        FROM service_accounts WHERE org_id = ? AND status != 'revoked'
        ORDER BY name
    `).all(orgId),

    touchServiceAccount: (id) => prepare(`
        UPDATE service_accounts SET last_used_at = datetime('now') WHERE id = ?
    `).run(id),

    // Divisions
    getDivisionsByOrg: (orgId) => prepare(`
        SELECT d.*, COUNT(DISTINCT tm.user_id) as member_count
        FROM divisions d
        LEFT JOIN teams t ON t.org_id = d.org_id
        LEFT JOIN team_memberships tm ON tm.team_id = t.id AND tm.status = 'active'
        WHERE d.org_id = ? AND d.deleted_at IS NULL
        GROUP BY d.id
        ORDER BY d.name
    `).all(orgId),

    getDivisionById: (id) => prepare(`
        SELECT * FROM divisions WHERE id = ? AND deleted_at IS NULL
    `).get(id),

    getDivisionBySlug: (orgId, slug) => prepare(`
        SELECT * FROM divisions WHERE org_id = ? AND slug = ? AND deleted_at IS NULL
    `).get(orgId, slug),

    createDivision: (div) => prepare(`
        INSERT INTO divisions (id, org_id, name, slug, description, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(div.id, div.org_id, div.name, div.slug, div.description, div.created_by),

    updateDivision: (id, updates) => {
        // Validate column names against allowlist (Security Issue #64)
        const validUpdates = validateColumns(updates, ALLOWED_DIVISION_COLUMNS);
        const fields = Object.keys(validUpdates).filter(k => validUpdates[k] !== undefined);
        if (fields.length === 0) return { changes: 0 };
        const sql = `UPDATE divisions SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
        return prepare(sql).run(...fields.map(f => validUpdates[f]), id);
    },

    deleteDivision: (id) => prepare(`
        UPDATE divisions SET deleted_at = datetime('now') WHERE id = ?
    `).run(id),

    // MCP tokens (MCPB-HARDEN-P2)
    createMcpToken: (token) => prepare(`
        INSERT INTO mcp_tokens (id, user_id, org_id, token_hash, label, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(token.id, token.user_id, token.org_id, token.token_hash, token.label),

    listMcpTokensByUser: (user_id) => prepare(`
        SELECT id, label, created_at, last_used_at, revoked_at
        FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC
    `).all(user_id),

    getMcpTokenByHash: (token_hash) => prepare(`
        SELECT id, user_id, org_id, label, created_at, last_used_at, revoked_at
        FROM mcp_tokens WHERE token_hash = ?
    `).get(token_hash),

    revokeMcpToken: ({ id, user_id }) => prepare(`
        UPDATE mcp_tokens SET revoked_at = datetime('now')
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(id, user_id).changes,

    touchMcpTokenUsage: (id) => prepare(`
        UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE id = ?
    `).run(id),
};

// Export validation function for route handlers that build their own UPDATE queries
export { validateColumns, ALLOWED_USER_COLUMNS, ALLOWED_ORG_MEMBERSHIP_COLUMNS, ALLOWED_DIVISION_COLUMNS };

export default { getDb, closeDb, transaction, prepare, queries };
