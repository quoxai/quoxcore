/**
 * routes/agent-attach.js — QUOXIDENTITY P1 (#487), territory A.
 * docs/QUOXIDENTITY_P1_CONTRACT.md is the binding contract for this file.
 *
 * `quox agent attach <agentId>` asks here for a short-TTL attach lease +
 * JWT bound to the registry agent (e.g. 'seer'). All routes are
 * human-user JWT auth (no service key path in P1) — see the contract's
 * "All human-user JWT auth" line. Mounted at /api/agent-attach, a prefix
 * dedicated to this router, so a router-level requireAuth here cannot
 * intercept any other /api/* route (the auth-mount-order gotcha only
 * bites a requireAuth router mounted broadly on '/api' ahead of
 * /api/internal/* — see routes/llm-routing-policies.js's comment for the
 * case that DOES bite, which this isn't).
 *
 * Authz for lease/grants: org owner/admin always allowed; any other
 * member needs an active agent_attach_grants row for (org, agentId).
 * Authz for heartbeat/release: the lease's holder_user_id, or an org
 * admin.
 *
 * The attach JWT claim shape (sub=agent_user_id, agent_id=<registry id>,
 * actor_type='agent', attach_lease_id, exp=now+ttl) was verified against
 * services/collector/lib/agentIdResolver.js (read-only, territory B):
 * isKnownAgent() checks AGENT_TOOLS top-level keys, which already includes
 * lowercase 'seer' — no resolver change needed, the CLAIM just has to be
 * the lowercase registry id, which lib/agentIdentity.js normalizeAgentId()
 * already enforces.
 */

import { Router } from 'express';
import { getDb, queries } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { createAccessToken } from '../utils/crypto.js';
import { createAuditEvent } from '../utils/helpers.js';
import { ensureAgentUser, normalizeAgentId } from '../lib/agentIdentity.js';
import {
    createLease, heartbeatLease, releaseLease, activeLeaseFor,
    grantAttach, revokeGrant, listGrants, hasGrant, LeaseConflictError,
    grantAttachAny, revokeGrantAny, findAssistantOrg,
    listActiveTree, SplinterCapError,
} from '../lib/agentAttachStore.js';

import { resolveMaxSplinters } from '../lib/splinterCap.js';
import { humanGrantorOnly } from '../utils/principal.js';

const router = Router();
router.use(requireAuth);

const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 24 * 60 * 60; // sanity ceiling; P1 has no long-lived attach

function isOrgAdmin(req) {
    return !!req.orgMembership && ['owner', 'admin'].includes(req.orgMembership.role);
}

/**
 * quox#576 flaw #3: is `userId` an owner/admin of `orgId`? Unlike
 * isOrgAdmin(req) (which only ever answers for the caller's OWN active JWT
 * org, req.orgMembership), this looks up membership directly so it can
 * answer for a DIFFERENT org — the org a target custom assistant actually
 * belongs to, which may not be the org the caller's session is scoped to.
 */
function isAdminOfOrg(db, { orgId, userId }) {
    const membership = queries.getOrgMembership(orgId, userId);
    return !!membership && membership.status === 'active'
        && ['owner', 'admin'].includes(membership.role);
}

function requireOrgContext(req, res) {
    if (!req.org || !req.orgMembership) {
        res.status(400).json({ error: 'org_required', message: 'An org-scoped session is required' });
        return null;
    }
    return req.org.id;
}

function parseAgentIdParam(req, res) {
    try {
        return normalizeAgentId(req.params.agentId);
    } catch (err) {
        res.status(400).json({ error: 'invalid_agent_id', message: err.message });
        return null;
    }
}

function leaseView(lease) {
    if (!lease) return null;
    return {
        id: lease.id,
        org_id: lease.org_id,
        agent_id: lease.agent_id,
        agent_user_id: lease.agent_user_id,
        holder_user_id: lease.holder_user_id,
        session_label: lease.session_label,
        state: lease.state,
        ttl_seconds: lease.ttl_seconds,
        created_at: lease.created_at,
        last_heartbeat_at: lease.last_heartbeat_at,
        ended_at: lease.ended_at,
        takeover_of: lease.takeover_of,
        parent_lease_id: lease.parent_lease_id ?? null,
        splinter_ordinal: lease.splinter_ordinal ?? 1,
        splinter: splinterId(lease),
    };
}

/** 'S<n>' forensic id for a lease (S1 = root). */
function splinterId(lease) {
    return `S${lease?.splinter_ordinal ?? 1}`;
}

function siblingView(l) {
    return { lease_id: l.id, id: splinterId(l), session_label: l.session_label, last_heartbeat_at: l.last_heartbeat_at };
}

function auditRootPromoted(orgId, agentId, promoted, actorType, actorId) {
    if (!promoted) return;
    createAuditEvent({
        orgId,
        actorType,
        actorId,
        action: 'agent_attach.root_promoted',
        targetType: 'agent_attach_lease',
        targetId: promoted.id,
        status: 'success',
        metadata: { agent_id: agentId, splinter: splinterId(promoted), root_lease_id: promoted.id },
    });
}

function auditExpiredLease(req, orgId, agentId, expiredLease) {
    if (!expiredLease) return;
    createAuditEvent({
        orgId,
        actorType: 'system',
        actorId: 'system',
        action: 'agent_attach.expired',
        targetType: 'agent_attach_lease',
        targetId: expiredLease.id,
        status: 'success',
        metadata: { agent_id: agentId, reason: 'ttl_elapsed_lazy_expiry' },
    });
}

// ============================================================================
// POST /:agentId/lease — mint an attach lease + JWT
// ============================================================================

router.post('/:agentId/lease', async (req, res) => {
    const callerOrgId = requireOrgContext(req, res);
    if (!callerOrgId) return;
    const agentId = parseAgentIdParam(req, res);
    if (!agentId) return;

    const { session_label = null, takeover = false } = req.body || {};
    const splinterOpt = req.body?.splinter;
    if (splinterOpt !== undefined && splinterOpt !== true && splinterOpt !== false && splinterOpt !== 'auto') {
        return res.status(400).json({ error: 'invalid_splinter', message: "splinter must be true, false or 'auto'" });
    }
    let ttlSeconds = req.body?.ttl_seconds;
    if (ttlSeconds === undefined || ttlSeconds === null) ttlSeconds = DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
        return res.status(400).json({ error: 'invalid_ttl_seconds', message: `ttl_seconds must be a positive integer <= ${MAX_TTL_SECONDS}` });
    }

    const db = getDb();

    // quox#576 flaw #3: a CUSTOM/org assistant (an `assistants` DB row) has
    // its OWN org, which may differ from the org the caller's session
    // happens to be scoped to. The lease must be stamped with the
    // ASSISTANT'S org — never the caller's own active org — or the
    // downstream org-scoped kit fetch (collector) 404s. A core/registry
    // agent (e.g. 'seer') has no `assistants` row: findAssistantOrg returns
    // null and this falls back to the caller's own active org, the
    // pre-existing org-null path, unchanged.
    const assistant = findAssistantOrg(db, agentId);
    const orgId = assistant ? assistant.org_id : callerOrgId;

    // Authorization is checked against the LEASE'S org (the assistant's own
    // org when it differs from the caller's active org), never against the
    // caller's own org membership alone — otherwise naming another org's
    // assistant id/slug would adopt it purely because the caller happens to
    // be an owner/admin or grantee of a DIFFERENT, unrelated org.
    const admin = orgId === callerOrgId ? isOrgAdmin(req) : isAdminOfOrg(db, { orgId, userId: req.user.id });
    if (!admin && !hasGrant(db, { orgId, agentId, userId: req.user.id })) {
        return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin or an active attach grant is required' });
    }

    // Get-or-create the agent user row for this registry agent id — reuses
    // lib/agentIdentity.js's helper rather than forking user-creation logic.
    let agentUser;
    try {
        ({ user: agentUser } = ensureAgentUser(db, {
            agentId,
            orgId,
            displayName: agentId,
            membershipRole: 'member',
        }));
    } catch (err) {
        return res.status(409).json({ error: 'agent_user_conflict', message: err.message });
    }

    const maxSplinters = await resolveMaxSplinters(orgId);
    let result;
    try {
        result = createLease(db, {
            orgId, agentId, agentUserId: agentUser.id, holderUserId: req.user.id,
            sessionLabel: session_label, ttlSeconds, takeover: takeover === true,
            splinter: splinterOpt === undefined ? 'auto' : splinterOpt, maxSplinters,
        });
    } catch (err) {
        if (err instanceof LeaseConflictError) {
            return res.status(409).json({
                error: 'lease_held',
                message: 'An active lease is already held for this agent; pass takeover:true to take it over',
                hint: 'held by another user; ask them or pass takeover:true',
                holder: leaseView(err.holderLease),
            });
        }
        if (err instanceof SplinterCapError) {
            return res.status(409).json({ error: 'splinter_cap', max: err.max, active: err.active });
        }
        throw err;
    }

    for (const e of result.expiredAll || []) auditExpiredLease(req, orgId, agentId, e);
    auditRootPromoted(orgId, agentId, result.promoted, 'system', 'system');

    const isChild = result.lease.parent_lease_id !== null;
    if (isChild) {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'agent_attach.splinter_joined',
            targetType: 'agent_attach_lease',
            targetId: result.lease.id,
            status: 'success',
            metadata: { agent_id: agentId, splinter: splinterId(result.lease), root_lease_id: result.lease.parent_lease_id },
        });
    }

    if (result.takeoverOfLease) {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'agent_attach.takeover',
            targetType: 'agent_attach_lease',
            targetId: result.lease.id,
            status: 'success',
            metadata: { agent_id: agentId, prior_lease_id: result.takeoverOfLease.id, prior_holder_user_id: result.takeoverOfLease.holder_user_id },
        });
    } else {
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: req.user.id,
            action: 'agent_attach.lease_granted',
            targetType: 'agent_attach_lease',
            targetId: result.lease.id,
            status: 'success',
            metadata: { agent_id: agentId, session_label },
        });
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const token = createAccessToken({
        sub: agentUser.id,
        org_id: orgId,
        actor_type: 'agent',
        agent_id: agentId,
        attach_lease_id: result.lease.id,
        splinter: splinterId(result.lease),
        // F2a (accountability): name the human who requested this lease
        // (already recorded as holder_user_id on the agent_attach_leases
        // row) directly on the token, so a downstream service can name the
        // responsible human from the JWT alone.
        holder_user_id: req.user.id,
        mfa_verified: false,
    }, { expiresIn: ttlSeconds });

    const tree = listActiveTree(db, { orgId, agentId });
    const rootLeaseId = result.lease.parent_lease_id ?? result.lease.id;
    return res.status(201).json({
        lease: leaseView(result.lease),
        token,
        expires_at: expiresAt,
        splinter: {
            id: splinterId(result.lease),
            ordinal: result.lease.splinter_ordinal,
            root_lease_id: rootLeaseId,
            siblings: tree.filter((l) => l.id !== result.lease.id).map(siblingView),
        },
    });
});

// ============================================================================
// POST /lease/:leaseId/heartbeat — holder only
// ============================================================================

router.post('/lease/:leaseId/heartbeat', async (req, res) => {
    const db = getDb();
    const result = heartbeatLease(db, { leaseId: req.params.leaseId, holderUserId: req.user.id });

    if (!result.ok) {
        if (result.reason === 'not_found') return res.status(404).json({ error: 'not_found' });
        if (result.reason === 'not_holder') return res.status(403).json({ error: 'not_holder' });
        if (result.reason === 'lease_expired') {
            auditExpiredLease(req, result.lease.org_id, result.lease.agent_id, result.lease);
            auditRootPromoted(result.lease.org_id, result.lease.agent_id, result.promoted, 'system', 'system');
            return res.status(409).json({ error: 'lease_expired', lease: leaseView(result.lease) });
        }
        return res.status(409).json({ error: result.reason, lease: leaseView(result.lease || null) });
    }

    // F-heartbeat-token-refresh: a heartbeat always re-mints the attach
    // token now, not only when nearExpiry. The lease row's liveness window
    // already advanced (last_heartbeat_at was just bumped to now), but the
    // ORIGINAL token's own exp claim is fixed at mint time and never moves
    // on its own — without an unconditional re-mint here the holder's
    // platform calls 401 against a token whose exp lags the still-live
    // lease. Same claim shape as the lease-mint path, including
    // holder_user_id for accountability.
    const lease = result.lease;
    const token = createAccessToken({
        sub: lease.agent_user_id,
        org_id: lease.org_id,
        actor_type: 'agent',
        agent_id: lease.agent_id,
        attach_lease_id: lease.id,
        splinter: splinterId(lease),
        holder_user_id: lease.holder_user_id,
        mfa_verified: false,
    }, { expiresIn: lease.ttl_seconds });
    const expiresAt = new Date(Date.now() + lease.ttl_seconds * 1000).toISOString();

    return res.status(200).json({ lease: leaseView(result.lease), token, expires_at: expiresAt });
});

// ============================================================================
// POST /lease/:leaseId/release — holder or org admin
// ============================================================================

router.post('/lease/:leaseId/release', async (req, res) => {
    const db = getDb();
    const result = releaseLease(db, { leaseId: req.params.leaseId, actingUserId: req.user.id, isAdmin: isOrgAdmin(req) });

    if (!result.ok) {
        if (result.reason === 'not_found') return res.status(404).json({ error: 'not_found' });
        if (result.reason === 'forbidden') return res.status(403).json({ error: 'not_authorized' });
        return res.status(409).json({ error: result.reason, lease: leaseView(result.lease || null) });
    }

    createAuditEvent({
        orgId: result.lease.org_id,
        actorType: 'user',
        actorId: req.user.id,
        action: 'agent_attach.released',
        targetType: 'agent_attach_lease',
        targetId: result.lease.id,
        status: 'success',
        metadata: { agent_id: result.lease.agent_id },
    });
    auditRootPromoted(result.lease.org_id, result.lease.agent_id, result.promoted, 'user', req.user.id);

    return res.status(200).json({ lease: leaseView(result.lease) });
});

// ============================================================================
// GET /:agentId/status
// ============================================================================

router.get('/:agentId/status', async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    const agentId = parseAgentIdParam(req, res);
    if (!agentId) return;

    const db = getDb();
    const { lease, expiredAll, promoted } = activeLeaseFor(db, { orgId, agentId });
    for (const e of expiredAll || []) auditExpiredLease(req, orgId, agentId, e);
    auditRootPromoted(orgId, agentId, promoted, 'system', 'system');

    const myGrant = isOrgAdmin(req) || hasGrant(db, { orgId, agentId, userId: req.user.id });

    const splinters = listActiveTree(db, { orgId, agentId }).map((l) => ({
        lease_id: l.id,
        id: splinterId(l),
        session_label: l.session_label,
        last_heartbeat_at: l.last_heartbeat_at,
        is_root: l.parent_lease_id === null,
    }));

    return res.status(200).json({ active_lease: leaseView(lease), my_grant: myGrant, splinters });
});

// ============================================================================
// Grants — org owner/admin only
// ============================================================================

// QUOXIDENTITY P10: roster-wide (attach-any) grant. Registered BEFORE the
// '/:agentId/grants' routes so the literal '/grants/all' path is never
// captured as agentId='grants'. Org owner/admin only, same as per-agent grants;
// this delegates attach rights for the WHOLE org roster (present and future
// agents) to a trusted non-admin operator without handing over org-admin.
router.post('/grants/all', humanGrantorOnly, async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    if (!isOrgAdmin(req)) return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin required', required_scope: 'org_admin' });

    const { user_id } = req.body || {};
    if (!user_id || typeof user_id !== 'string') {
        return res.status(400).json({ error: 'user_id_required' });
    }

    const grant = grantAttachAny(getDb(), { orgId, granteeUserId: user_id, grantedBy: req.user.id });

    createAuditEvent({
        orgId,
        actorType: 'user',
        actorId: req.user.id,
        action: 'agent_attach.grant_any_added',
        targetType: 'agent_attach_grant',
        targetId: grant.id,
        status: 'success',
        metadata: { agent_id: '*', grantee_user_id: user_id, scope: 'attach_any' },
    });

    return res.status(201).json({ grant });
});

router.delete('/grants/all/:granteeUserId', async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    if (!isOrgAdmin(req)) return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin required', required_scope: 'org_admin' });

    const revoked = revokeGrantAny(getDb(), { orgId, granteeUserId: req.params.granteeUserId, revokedBy: req.user.id });
    if (!revoked) return res.status(404).json({ error: 'grant_not_found' });

    createAuditEvent({
        orgId,
        actorType: 'user',
        actorId: req.user.id,
        action: 'agent_attach.grant_any_revoked',
        targetType: 'agent_attach_grant',
        targetId: null,
        status: 'success',
        metadata: { agent_id: '*', grantee_user_id: req.params.granteeUserId, scope: 'attach_any' },
    });

    return res.status(200).json({ revoked: true });
});

router.post('/:agentId/grants', humanGrantorOnly, async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    const agentId = parseAgentIdParam(req, res);
    if (!agentId) return;
    if (!isOrgAdmin(req)) return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin required', required_scope: 'org_admin' });

    const { user_id } = req.body || {};
    if (!user_id || typeof user_id !== 'string') {
        return res.status(400).json({ error: 'user_id_required' });
    }

    const db = getDb();
    const grant = grantAttach(db, { orgId, agentId, granteeUserId: user_id, grantedBy: req.user.id });

    createAuditEvent({
        orgId,
        actorType: 'user',
        actorId: req.user.id,
        action: 'agent_attach.grant_added',
        targetType: 'agent_attach_grant',
        targetId: grant.id,
        status: 'success',
        metadata: { agent_id: agentId, grantee_user_id: user_id },
    });

    return res.status(201).json({ grant });
});

router.get('/:agentId/grants', async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    const agentId = parseAgentIdParam(req, res);
    if (!agentId) return;
    if (!isOrgAdmin(req)) return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin required', required_scope: 'org_admin' });

    const grants = listGrants(getDb(), { orgId, agentId });
    return res.status(200).json({ grants });
});

router.delete('/:agentId/grants/:granteeUserId', async (req, res) => {
    const orgId = requireOrgContext(req, res);
    if (!orgId) return;
    const agentId = parseAgentIdParam(req, res);
    if (!agentId) return;
    if (!isOrgAdmin(req)) return res.status(403).json({ error: 'not_authorized', message: 'org owner/admin required', required_scope: 'org_admin' });

    const revoked = revokeGrant(getDb(), { orgId, agentId, granteeUserId: req.params.granteeUserId, revokedBy: req.user.id });
    if (!revoked) return res.status(404).json({ error: 'grant_not_found' });

    createAuditEvent({
        orgId,
        actorType: 'user',
        actorId: req.user.id,
        action: 'agent_attach.grant_revoked',
        targetType: 'agent_attach_grant',
        targetId: null,
        status: 'success',
        metadata: { agent_id: agentId, grantee_user_id: req.params.granteeUserId },
    });

    return res.status(200).json({ revoked: true });
});

export default router;
