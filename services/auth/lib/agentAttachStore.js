/**
 * lib/agentAttachStore.js — QUOXIDENTITY P1 (#487), territory A.
 *
 * DB layer for `quox agent attach <agentId>`: per-agent attach grants and
 * the single-active-lease-per-agent-per-org rule. See
 * docs/QUOXIDENTITY_P1_CONTRACT.md and migrations/103-agent-attach.sql.
 *
 * Staleness (a dead session whose lease was never released) is checked
 * lazily, in SQL, everywhere a lease is read or written — no new
 * scheduler in P1 (Loop Hygiene triad only binds once a recurring
 * scheduler exists). All expiry comparisons happen inside SQLite via
 * datetime(last_heartbeat_at, '+N seconds') <= datetime('now') rather than
 * parsing SQLite's 'YYYY-MM-DD HH:MM:SS' strings in JS, which Date()
 * would silently treat as local time instead of the UTC it actually is.
 */

import { generateId } from '../utils/crypto.js';

/**
 * Thrown by createLease when an active lease is already held by someone
 * else and takeover was not requested. Routes catch this and respond 409
 * with the current holder.
 */
export class LeaseConflictError extends Error {
    constructor(holderLease) {
        super('an active lease is already held for this agent');
        this.name = 'LeaseConflictError';
        this.holderLease = holderLease;
    }
}

/**
 * Thrown by createLease when the agent already has `max` active leases and
 * a same-holder splinter join was requested. Routes answer 409 splinter_cap.
 */
export class SplinterCapError extends Error {
    constructor({ max, active }) {
        super(`splinter cap reached (${active}/${max})`);
        this.name = 'SplinterCapError';
        this.max = max;
        this.active = active;
    }
}

export const DEFAULT_MAX_SPLINTERS = 4;

const getRow = (db, id) => db.prepare('SELECT * FROM agent_attach_leases WHERE id = ?').get(id);

/**
 * Root succession (QUOXIDENTITY P9). If (org, agent) has no active root but
 * has active children, the lowest-ordinal child becomes root
 * (parent_lease_id = NULL) and the remaining children are re-parented to it.
 * Ordinals never change. Idempotent. Returns the promoted row or null.
 * Callers run this inside their own transaction.
 */
function promoteIfRootGone(db, { orgId, agentId }) {
    const hasRoot = db.prepare(`
        SELECT 1 FROM agent_attach_leases
        WHERE org_id = ? AND agent_id = ? AND state = 'active' AND parent_lease_id IS NULL
    `).get(orgId, agentId);
    if (hasRoot) return null;
    const children = db.prepare(`
        SELECT * FROM agent_attach_leases
        WHERE org_id = ? AND agent_id = ? AND state = 'active'
        ORDER BY splinter_ordinal ASC
    `).all(orgId, agentId);
    if (children.length === 0) return null;
    const [next, ...rest] = children;
    db.prepare('UPDATE agent_attach_leases SET parent_lease_id = NULL WHERE id = ?').run(next.id);
    for (const c of rest) {
        db.prepare('UPDATE agent_attach_leases SET parent_lease_id = ? WHERE id = ?').run(next.id, c.id);
    }
    return getRow(db, next.id);
}

/**
 * Expire every stale active lease for (org, agent) (per lease, children
 * included), then run root succession if the root was among them.
 * @returns {{expiredAll: object[], expired: object|null, promoted: object|null}}
 *   `expired` is the first expired row (back-compat with single-lease callers).
 */
function expireStaleLeases(db, { orgId, agentId }) {
    return db.transaction(() => {
        const stale = db.prepare(`
            SELECT * FROM agent_attach_leases
            WHERE org_id = ? AND agent_id = ? AND state = 'active'
              AND datetime(last_heartbeat_at, '+' || ttl_seconds || ' seconds') <= datetime('now')
            ORDER BY splinter_ordinal ASC
        `).all(orgId, agentId);
        const expiredAll = [];
        for (const s of stale) {
            db.prepare(`UPDATE agent_attach_leases SET state = 'expired', ended_at = datetime('now') WHERE id = ?`).run(s.id);
            expiredAll.push(getRow(db, s.id));
        }
        const promoted = stale.length ? promoteIfRootGone(db, { orgId, agentId }) : null;
        return { expiredAll, expired: expiredAll[0] || null, promoted };
    })();
}

/** Every active lease for (org, agent): root first, then ordinals ascending. */
export function listActiveTree(db, { orgId, agentId }) {
    return db.prepare(`
        SELECT * FROM agent_attach_leases
        WHERE org_id = ? AND agent_id = ? AND state = 'active'
        ORDER BY (parent_lease_id IS NOT NULL) ASC, splinter_ordinal ASC
    `).all(orgId, agentId);
}

/**
 * Create a lease for (org, agent). Expires stale leases first (lazy expiry,
 * with root succession), then:
 *  - no active root: creates the root (ordinal 1);
 *  - root active + takeover: marks the WHOLE active tree taken_over and
 *    creates a fresh root;
 *  - root active, same holder, splinter !== false: creates a child splinter
 *    (lowest free ordinal >= 2), or throws SplinterCapError at the cap;
 *  - otherwise throws LeaseConflictError.
 *
 * @returns {{lease: object, expired: object|null, expiredAll: object[], promoted: object|null, takeoverOfLease: object|null}}
 */
export function createLease(db, {
    orgId, agentId, agentUserId, holderUserId,
    sessionLabel = null, ttlSeconds = 900, takeover = false,
    splinter = 'auto', maxSplinters = DEFAULT_MAX_SPLINTERS,
}) {
    const { expired, expiredAll, promoted } = expireStaleLeases(db, { orgId, agentId });

    const activeRoot = () => db.prepare(`
        SELECT * FROM agent_attach_leases
        WHERE org_id = ? AND agent_id = ? AND state = 'active' AND parent_lease_id IS NULL
    `).get(orgId, agentId);

    try {
        return db.transaction(() => {
            const existing = activeRoot();
            let takeoverOf = null;
            let parentId = null;
            let ordinal = 1;

            if (existing) {
                if (takeover) {
                    db.prepare(`
                        UPDATE agent_attach_leases SET state = 'taken_over', ended_at = datetime('now')
                        WHERE org_id = ? AND agent_id = ? AND state = 'active'
                    `).run(orgId, agentId);
                    takeoverOf = existing.id;
                } else if (splinter !== false && existing.holder_user_id === holderUserId) {
                    const tree = listActiveTree(db, { orgId, agentId });
                    if (tree.length >= maxSplinters) {
                        throw new SplinterCapError({ max: maxSplinters, active: tree.length });
                    }
                    const used = new Set(tree.map((l) => l.splinter_ordinal));
                    ordinal = 2;
                    while (used.has(ordinal)) ordinal += 1;
                    parentId = existing.id;
                } else {
                    throw new LeaseConflictError(existing);
                }
            }

            const id = generateId();
            db.prepare(`
                INSERT INTO agent_attach_leases
                    (id, org_id, agent_id, agent_user_id, holder_user_id, session_label,
                     state, ttl_seconds, created_at, last_heartbeat_at, takeover_of,
                     parent_lease_id, splinter_ordinal)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'), ?, ?, ?)
            `).run(id, orgId, agentId, agentUserId, holderUserId, sessionLabel, ttlSeconds, takeoverOf, parentId, ordinal);

            return {
                lease: getRow(db, id), expired, expiredAll, promoted,
                takeoverOfLease: takeoverOf ? existing : null,
            };
        })();
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new LeaseConflictError(activeRoot());
        }
        throw err;
    }
}

/**
 * Extend a held lease's heartbeat. Fails closed: not found, not the
 * holder, not active, or already stale (which lazily expires it) are all
 * distinct non-ok reasons the route can map to the right HTTP status.
 *
 * @returns {{ok: true, lease: object, nearExpiry: boolean} | {ok: false, reason: string, lease?: object}}
 */
export function heartbeatLease(db, { leaseId, holderUserId }) {
    const lease = db.prepare('SELECT * FROM agent_attach_leases WHERE id = ?').get(leaseId);
    if (!lease) return { ok: false, reason: 'not_found' };
    if (lease.holder_user_id !== holderUserId) return { ok: false, reason: 'not_holder', lease };
    if (lease.state !== 'active') return { ok: false, reason: 'not_active', lease };

    const staleRow = db.prepare(`
        SELECT 1 AS is_stale FROM agent_attach_leases
        WHERE id = ? AND datetime(last_heartbeat_at, '+' || ttl_seconds || ' seconds') <= datetime('now')
    `).get(leaseId);
    if (staleRow) {
        const { promoted } = expireStaleLeases(db, { orgId: lease.org_id, agentId: lease.agent_id });
        return { ok: false, reason: 'lease_expired', lease: getRow(db, leaseId), promoted };
    }

    // Within 20% of the current window's expiry -> caller should mint a
    // fresh token alongside the heartbeat, since the original attach JWT's
    // own exp is fixed at mint time and heartbeat only extends the lease
    // row's liveness window, not any already-issued token's exp claim.
    const remainingRow = db.prepare(`
        SELECT CAST(strftime('%s', datetime(last_heartbeat_at, '+' || ttl_seconds || ' seconds')) AS INTEGER)
                 - CAST(strftime('%s', 'now') AS INTEGER) AS seconds_remaining
        FROM agent_attach_leases WHERE id = ?
    `).get(leaseId);
    const nearExpiry = Boolean(remainingRow) && remainingRow.seconds_remaining <= Math.floor(lease.ttl_seconds * 0.2);

    db.prepare(`UPDATE agent_attach_leases SET last_heartbeat_at = datetime('now') WHERE id = ?`).run(leaseId);
    const updated = db.prepare('SELECT * FROM agent_attach_leases WHERE id = ?').get(leaseId);
    return { ok: true, lease: updated, nearExpiry };
}

/**
 * Release a held lease. Allowed for the holder or an org admin.
 *
 * @returns {{ok: true, lease: object} | {ok: false, reason: string, lease?: object}}
 */
export function releaseLease(db, { leaseId, actingUserId, isAdmin = false }) {
    const lease = db.prepare('SELECT * FROM agent_attach_leases WHERE id = ?').get(leaseId);
    if (!lease) return { ok: false, reason: 'not_found' };
    if (lease.state !== 'active') return { ok: false, reason: 'not_active', lease };
    if (lease.holder_user_id !== actingUserId && !isAdmin) return { ok: false, reason: 'forbidden', lease };

    const promoted = db.transaction(() => {
        db.prepare(`
            UPDATE agent_attach_leases SET state = 'released', ended_at = datetime('now') WHERE id = ?
        `).run(leaseId);
        return lease.parent_lease_id === null
            ? promoteIfRootGone(db, { orgId: lease.org_id, agentId: lease.agent_id })
            : null;
    })();
    return { ok: true, lease: getRow(db, leaseId), promoted };
}

/** Fetch a lease by id, lazily expiring it first if stale. */
export function getLease(db, leaseId) {
    const row = db.prepare('SELECT org_id, agent_id FROM agent_attach_leases WHERE id = ?').get(leaseId);
    if (row) expireStaleLeases(db, { orgId: row.org_id, agentId: row.agent_id });
    return db.prepare('SELECT * FROM agent_attach_leases WHERE id = ?').get(leaseId) || null;
}

/**
 * The current active ROOT lease for (org, agent), if any. Lazily expires a
 * stale one first, so a status check is also a liveness check.
 *
 * @returns {{lease: object|null, expired: object|null}}
 */
export function activeLeaseFor(db, { orgId, agentId }) {
    const { expired, expiredAll, promoted } = expireStaleLeases(db, { orgId, agentId });
    const lease = db.prepare(`
        SELECT * FROM agent_attach_leases
        WHERE org_id = ? AND agent_id = ? AND state = 'active' AND parent_lease_id IS NULL
    `).get(orgId, agentId) || null;
    return { lease, expired, expiredAll, promoted };
}

// ============================================================================
// Grants
// ============================================================================

/** Get-or-create the active grant row. Idempotent: re-granting an already
 * active grant is a no-op that returns the existing row. */
export function grantAttach(db, { orgId, agentId, granteeUserId, grantedBy }) {
    const existing = db.prepare(`
        SELECT * FROM agent_attach_grants
        WHERE org_id = ? AND agent_id = ? AND grantee_user_id = ? AND revoked_at IS NULL
    `).get(orgId, agentId, granteeUserId);
    if (existing) return existing;

    const id = generateId();
    db.prepare(`
        INSERT INTO agent_attach_grants (id, org_id, agent_id, grantee_user_id, granted_by, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, orgId, agentId, granteeUserId, grantedBy);
    return db.prepare('SELECT * FROM agent_attach_grants WHERE id = ?').get(id);
}

/** Revoke the active grant, if any. Returns true iff a row was revoked. */
export function revokeGrant(db, { orgId, agentId, granteeUserId, revokedBy }) {
    const info = db.prepare(`
        UPDATE agent_attach_grants SET revoked_at = datetime('now'), revoked_by = ?
        WHERE org_id = ? AND agent_id = ? AND grantee_user_id = ? AND revoked_at IS NULL
    `).run(revokedBy, orgId, agentId, granteeUserId);
    return info.changes > 0;
}

export function listGrants(db, { orgId, agentId }) {
    return db.prepare(`
        SELECT * FROM agent_attach_grants
        WHERE org_id = ? AND agent_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
    `).all(orgId, agentId);
}

// QUOXIDENTITY P10: sentinel agent_id for an "attach any agent in this org"
// grant. normalizeAgentId() (lib/agentIdentity.js) only ever yields
// [a-z0-9][a-z0-9-]* , so a real agent id can never equal '*' — no collision.
export const ATTACH_ANY = '*';

/** Grant a user attach rights to EVERY agent in the org (present and future). */
export function grantAttachAny(db, { orgId, granteeUserId, grantedBy }) {
    return grantAttach(db, { orgId, agentId: ATTACH_ANY, granteeUserId, grantedBy });
}

/** Revoke a user's roster-wide (wildcard) attach grant. Returns true iff revoked. */
export function revokeGrantAny(db, { orgId, granteeUserId, revokedBy }) {
    return revokeGrant(db, { orgId, agentId: ATTACH_ANY, granteeUserId, revokedBy });
}

/**
 * quox#576 flaw #3: resolve the org a CUSTOM/org assistant actually
 * belongs to, from a normalized agent_id (id or slug), independent of
 * whatever org the caller's own session happens to be scoped to.
 *
 * A core/registry agent (e.g. 'seer') has no `assistants` row at all and
 * returns null here — callers fall back to the caller's own active org,
 * exactly the pre-existing behaviour (org-null path, unaffected).
 *
 * `id` is the assistants table PRIMARY KEY (a ULID), globally unique, so an
 * id match is authoritative on its own. `slug` is only unique PER ORG
 * (idx_assistants_slug is (org_id, slug)) — two different orgs could in
 * principle register the same slug — so a slug match is only trusted when
 * it resolves to exactly one org; a genuine collision returns null (falls
 * back to the org-null/core-agent path) rather than guessing which org.
 *
 * @returns {{id: string, org_id: string, slug: string}|null}
 */
export function findAssistantOrg(db, agentId) {
    const byId = db.prepare('SELECT id, org_id, slug FROM assistants WHERE id = ?').get(agentId);
    if (byId) return byId;

    const bySlug = db.prepare('SELECT id, org_id, slug FROM assistants WHERE slug = ?').all(agentId);
    return bySlug.length === 1 ? bySlug[0] : null;
}

export function hasGrant(db, { orgId, agentId, userId }) {
    // True if the user holds a grant for THIS specific agent OR a roster-wide
    // (ATTACH_ANY) grant. The wildcard covers any agent, including ones added
    // after the grant was issued.
    const row = db.prepare(`
        SELECT 1 FROM agent_attach_grants
        WHERE org_id = ? AND grantee_user_id = ? AND revoked_at IS NULL
          AND (agent_id = ? OR agent_id = ?)
    `).get(orgId, userId, agentId, ATTACH_ANY);
    return !!row;
}

export default {
    LeaseConflictError,
    SplinterCapError,
    listActiveTree,
    createLease,
    heartbeatLease,
    releaseLease,
    getLease,
    activeLeaseFor,
    grantAttach,
    revokeGrant,
    listGrants,
    hasGrant,
    findAssistantOrg,
};
