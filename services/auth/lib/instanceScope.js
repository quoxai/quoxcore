/**
 * Instance scope for QuoxVault — EMAIL-UNIFY P2.
 *
 * QuoxVault stores credentials in `integration_credentials`, whose org_id is
 * `NOT NULL REFERENCES orgs(id)`. That org-only scoping is the single reason
 * instance-wide credentials (SMTP above all) had to live somewhere else, in
 * the `instance_config` key/value table, which is what split email
 * configuration across two stores in the first place.
 *
 * This module adds an INSTANCE scope without touching the vault's central
 * table. Two options were on the table:
 *
 *   (a) Make org_id nullable, NULL = instance scope. Rejected: relaxing NOT
 *       NULL needs a full rebuild of the vault's busiest table (7 indexes,
 *       inbound FKs) on a live production database, and every `org_id = ?`
 *       query and app-level guard (labelExists, unsetDefaults,
 *       listCredentials, getDefaultCredential, the resolver waterfall) would
 *       need an `IS NULL` branch — a lot of surface to get subtly wrong on a
 *       secrets store.
 *
 *   (b) A well-known sentinel org id backed by a real orgs row. Every index,
 *       constraint, FK and guard keeps working exactly as before, and the
 *       resolver waterfall shape is unchanged. Chosen.
 *
 * The backing row carries a tombstone `deleted_at`. That is deliberate and
 * load-bearing, not an accident: every org listing in the service filters
 * `deleted_at IS NULL`, so one field keeps the instance scope out of org
 * switchers, admin org counts, Matrix provisioning, retention sweeps and the
 * credential health scanner without editing a dozen queries. It also means
 * `queries.getOrgById()` refuses the id, so the org-scoped vault HTTP API
 * (which validates the org before listing) cannot address instance
 * credentials — instance secrets are reachable only through the server-side
 * resolvers in this repo. The handful of org loops that do NOT filter
 * deleted_at are excluded explicitly at their call sites.
 *
 * There is no purge job for soft-deleted orgs today. If one is ever added it
 * MUST skip INSTANCE_ORG_ID, or it will cascade-delete the instance
 * credentials. See tests/instance-scope-vault.test.js.
 */

import { getDb } from '../db/index.js';

/**
 * Sentinel org id for instance-wide credentials. Deliberately not a ULID so
 * it is obvious in a database dump that this is not a customer organization.
 */
export const INSTANCE_ORG_ID = '__instance__';

/** Tombstone written to orgs.deleted_at. Fixed, so the row is recognisable. */
const INSTANCE_ORG_TOMBSTONE = '1970-01-01T00:00:00.000Z';

const INSTANCE_ORG_NAME = 'Instance (system scope)';

/**
 * @param {string|null|undefined} orgId
 * @returns {boolean}
 */
export function isInstanceOrg(orgId) {
    return orgId === INSTANCE_ORG_ID;
}

/**
 * SQL fragment for the org loops that don't already filter deleted_at.
 * Used inline so the exclusion is greppable from this module.
 */
export const EXCLUDE_INSTANCE_ORG_SQL = `id != '${INSTANCE_ORG_ID}'`;

/**
 * Resolve a real user id to own the instance org row (orgs.owner_user_id is
 * `NOT NULL REFERENCES users(id)` and foreign keys are ON).
 *
 * Preference order: the caller's user, then the longest-standing active
 * instance admin, then any active user. Returns null when the instance has no
 * users yet — the caller should skip and retry later rather than invent one.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {string} [options.userId]
 * @returns {string|null}
 */
export function resolveInstanceOrgOwner({ db: dbArg, userId = null } = {}) {
    const db = dbArg || getDb();

    if (userId) {
        const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (row) return row.id;
    }

    const admin = db.prepare(`
        SELECT ia.user_id AS id
        FROM instance_admins ia
        JOIN users u ON u.id = ia.user_id
        WHERE ia.revoked_at IS NULL AND u.deleted_at IS NULL
        ORDER BY ia.granted_at ASC
        LIMIT 1
    `).get();
    if (admin) return admin.id;

    const anyUser = db.prepare(`
        SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
    `).get();
    return anyUser ? anyUser.id : null;
}

/**
 * The current owner of the instance org row, or null when it doesn't exist.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {string|null}
 */
export function getInstanceOrgOwner({ db: dbArg } = {}) {
    const db = dbArg || getDb();
    const row = db.prepare('SELECT owner_user_id FROM orgs WHERE id = ?').get(INSTANCE_ORG_ID);
    return row ? row.owner_user_id : null;
}

/**
 * Ensure the backing orgs row for the instance scope exists, and return the
 * sentinel id. Idempotent.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {string} [options.userId] Preferred owner (the admin performing the write)
 * @returns {string} INSTANCE_ORG_ID
 * @throws {Error} when the instance has no users to own the row
 */
export function ensureInstanceOrg({ db: dbArg, userId = null } = {}) {
    const db = dbArg || getDb();

    const existing = db.prepare('SELECT id FROM orgs WHERE id = ?').get(INSTANCE_ORG_ID);
    if (existing) return INSTANCE_ORG_ID;

    const owner = resolveInstanceOrgOwner({ db, userId });
    if (!owner) {
        throw new Error('instance_scope_no_owner: cannot create the instance vault scope before any user exists');
    }

    db.prepare(`
        INSERT INTO orgs (id, name, slug, description, plan, owner_user_id, deleted_at)
        VALUES (?, ?, ?, ?, 'enterprise', ?, ?)
    `).run(
        INSTANCE_ORG_ID,
        INSTANCE_ORG_NAME,
        INSTANCE_ORG_ID,
        'System scope for instance-wide QuoxVault credentials. Tombstoned on purpose so it never appears as a customer organization — see lib/instanceScope.js.',
        owner,
        INSTANCE_ORG_TOMBSTONE,
    );

    return INSTANCE_ORG_ID;
}

/**
 * Whether the instance scope has been created yet. Read-only: use this on hot
 * read paths so a lookup never writes.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {boolean}
 */
export function instanceOrgExists({ db: dbArg } = {}) {
    const db = dbArg || getDb();
    return !!db.prepare('SELECT 1 FROM orgs WHERE id = ?').get(INSTANCE_ORG_ID);
}
