/**
 * ET-4 Phase B — Custom roles HTTP routes.
 *
 * Mounted under /api. Paths:
 *   GET    /orgs/:orgId/custom-roles
 *   POST   /orgs/:orgId/custom-roles
 *   GET    /orgs/:orgId/custom-roles/:roleId
 *   DELETE /orgs/:orgId/custom-roles/:roleId
 *   POST   /orgs/:orgId/custom-roles/:roleId/capabilities
 *   DELETE /orgs/:orgId/custom-roles/:roleId/capabilities?capability=... [&scope_id=...]
 *
 * All routes gated by:
 *   authenticate() → requireOrg() → requirePlan('enterprise') → requireCapability(ORG_MANAGE_ROLES)
 *
 * Tests mount the router with a fake auth/org middleware and an
 * injected req.db. Production mounts go through the real auth stack.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    createCustomRole,
    listCustomRoles,
    getCustomRole,
    deleteCustomRole,
    grantRoleCapability,
    revokeRoleCapability,
    getCustomRoleCapabilities,
} from '../utils/customRoles.js';
import {
    ensureAgentRbacSchema,
    setAgentAccess,
    clearAgentAccess,
    listAgentAccess,
    setToolAccess,
    clearToolAccess,
    listToolAccess,
} from '../utils/agentRbac.js';
import { Capabilities, hasCapability } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requirePlan } from '../middleware/requirePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { humanGrantorOnly } from '../utils/principal.js';

const router = Router();

// In production req.db is undefined and we call getDb(). Tests inject
// req.db directly. This shim keeps both paths tidy.
function db(req) {
    return req.db || getDb();
}

// Prod auth: if req.user isn't already set (tests inject it), run the
// real auth + org-membership chain. Skips for tests that pre-populate.
function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) {
        return res.status(401).json({ error: 'unauthenticated' });
    }
    next();
}

function requireManageRoles(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_ROLES)) {
        return res.status(403).json({
            error:    'forbidden',
            required: Capabilities.ORG_MANAGE_ROLES,
        });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'custom_role', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        // Best-effort audit; do not fail the request if table is absent.
        console.error('[custom-roles] audit insert failed:', err.message);
    }
}

// Common middleware chain for every route. ensureAuthedOrg is a
// no-op when tests inject req.user/req.org directly; otherwise runs
// the real auth + org-membership middlewares.
const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('enterprise'), requireManageRoles];
// Grant/widen routes: agent principals refused BEFORE plan/cap checks.
const grantChain = [ensureAuthedOrg, requireAuthedOrg, humanGrantorOnly, requirePlan('enterprise'), requireManageRoles];

// ──────────────────────────────────────────────────────────────────────
// GET /orgs/:orgId/custom-roles
// ──────────────────────────────────────────────────────────────────────
router.get('/orgs/:orgId/custom-roles', ...chain, (req, res) => {
    const roles = listCustomRoles(db(req), req.org.id);
    res.json({ roles });
});

// ──────────────────────────────────────────────────────────────────────
// POST /orgs/:orgId/custom-roles
// ──────────────────────────────────────────────────────────────────────
router.post('/orgs/:orgId/custom-roles', ...chain, (req, res) => {
    const { slug, name, description } = req.body || {};
    try {
        const role = createCustomRole(db(req), req.org.id, {
            slug,
            name,
            description,
            createdBy: req.user.id,
        });
        emitAudit(req, 'org.custom_role.created', role.id, { slug, name });
        res.status(201).json({ role });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE|duplicate|constraint/i.test(msg)) {
            return res.status(409).json({ error: 'slug_in_use', message: 'A custom role with this slug already exists' });
        }
        if (/slug|name/i.test(msg)) {
            return res.status(400).json({ error: 'invalid_input', message: msg });
        }
        console.error('[custom-roles] create failed:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// ──────────────────────────────────────────────────────────────────────
// GET /orgs/:orgId/custom-roles/:roleId
// ──────────────────────────────────────────────────────────────────────
router.get('/orgs/:orgId/custom-roles/:roleId', ...chain, (req, res) => {
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'not_found' });
    const capabilities = getCustomRoleCapabilities(db(req), role.id);
    res.json({ role, capabilities });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /orgs/:orgId/custom-roles/:roleId
// ──────────────────────────────────────────────────────────────────────
router.delete('/orgs/:orgId/custom-roles/:roleId', ...chain, (req, res) => {
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    deleteCustomRole(db(req), req.org.id, req.params.roleId);
    if (role) emitAudit(req, 'org.custom_role.deleted', req.params.roleId, { slug: role.slug });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// POST /orgs/:orgId/custom-roles/:roleId/capabilities
// ──────────────────────────────────────────────────────────────────────
router.post('/orgs/:orgId/custom-roles/:roleId/capabilities', ...grantChain, (req, res) => {
    const { capability, scope_id = null } = req.body || {};
    if (!capability || typeof capability !== 'string') {
        return res.status(400).json({ error: 'capability_required' });
    }
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    // ET-ENFORCE round-3 — privilege-escalation guard at GRANT time. Only
    // applies to capabilities in the Capabilities enum (where there's a
    // role hierarchy that could be escalated). Free-form custom caps
    // ("tools.view", "tenant.X.flag", etc.) are org-defined extensions
    // and don't carry built-in semantics, so the assigner doesn't need
    // to "hold" them for the grant to be safe.
    const knownCap = Object.values(Capabilities).includes(capability);
    if (knownCap) {
        const assignerHasIt = hasCapability(
            {
                orgRole:      req.orgMembership?.role,
                customRoleId: req.orgMembership?.custom_role_id || null,
            },
            capability,
            { db: db(req), orgId: req.org.id, scopeId: scope_id || undefined },
        );
        if (!assignerHasIt) {
            return res.status(403).json({
                error:   'forbidden_escalation',
                message: `Cannot grant capability "${capability}" — you do not hold it yourself.`,
            });
        }
    }

    grantRoleCapability(db(req), role.id, capability, scope_id);
    emitAudit(req, 'org.custom_role.capability_granted', role.id, { capability, scope_id });
    res.status(201).json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /orgs/:orgId/custom-roles/:roleId/capabilities
// ──────────────────────────────────────────────────────────────────────
router.delete('/orgs/:orgId/custom-roles/:roleId/capabilities', ...chain, (req, res) => {
    const capability = req.query.capability || req.body?.capability;
    const scopeId    = req.query.scope_id   || req.body?.scope_id || null;
    if (!capability) {
        return res.status(400).json({ error: 'capability_required' });
    }
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    revokeRoleCapability(db(req), role.id, capability, scopeId);
    emitAudit(req, 'org.custom_role.capability_revoked', role.id, { capability, scope_id: scopeId });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// ET-6A — agent / tool permission rules on a custom role
// ──────────────────────────────────────────────────────────────────────

function lazyEnsureRbac(req) {
    try { ensureAgentRbacSchema(db(req)); } catch { /* noop */ }
}

router.get('/orgs/:orgId/custom-roles/:roleId/agents', ...chain, (req, res) => {
    lazyEnsureRbac(req);
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    res.json({ permissions: listAgentAccess(db(req), { roleId: role.id }) });
});

router.put('/orgs/:orgId/custom-roles/:roleId/agents', ...grantChain, (req, res) => {
    lazyEnsureRbac(req);
    const { agent_id, scope_id = null, allowed } = req.body || {};
    if (!agent_id || typeof agent_id !== 'string') {
        return res.status(400).json({ error: 'agent_id required' });
    }
    if (typeof allowed !== 'boolean') {
        return res.status(400).json({ error: 'allowed must be boolean' });
    }
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    setAgentAccess(db(req), { roleId: role.id, agentId: agent_id, scopeId: scope_id, allowed });
    emitAudit(req, 'org.custom_role.agent_permission_set', role.id, { agent_id, scope_id, allowed });
    res.json({ ok: true });
});

router.delete('/orgs/:orgId/custom-roles/:roleId/agents', ...chain, (req, res) => {
    lazyEnsureRbac(req);
    const agent_id = req.query.agent_id || req.body?.agent_id;
    const scope_id = req.query.scope_id || req.body?.scope_id || null;
    if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    clearAgentAccess(db(req), { roleId: role.id, agentId: agent_id, scopeId: scope_id });
    emitAudit(req, 'org.custom_role.agent_permission_cleared', role.id, { agent_id, scope_id });
    res.status(204).end();
});

router.get('/orgs/:orgId/custom-roles/:roleId/tools', ...chain, (req, res) => {
    lazyEnsureRbac(req);
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    res.json({ permissions: listToolAccess(db(req), { roleId: role.id }) });
});

router.put('/orgs/:orgId/custom-roles/:roleId/tools', ...grantChain, (req, res) => {
    lazyEnsureRbac(req);
    const { tool_id, allowed } = req.body || {};
    if (!tool_id || typeof tool_id !== 'string') {
        return res.status(400).json({ error: 'tool_id required' });
    }
    if (typeof allowed !== 'boolean') {
        return res.status(400).json({ error: 'allowed must be boolean' });
    }
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    setToolAccess(db(req), { roleId: role.id, toolId: tool_id, allowed });
    emitAudit(req, 'org.custom_role.tool_permission_set', role.id, { tool_id, allowed });
    res.json({ ok: true });
});

router.delete('/orgs/:orgId/custom-roles/:roleId/tools', ...chain, (req, res) => {
    lazyEnsureRbac(req);
    const tool_id = req.query.tool_id || req.body?.tool_id;
    if (!tool_id) return res.status(400).json({ error: 'tool_id required' });
    const role = getCustomRole(db(req), req.org.id, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });

    clearToolAccess(db(req), { roleId: role.id, toolId: tool_id });
    emitAudit(req, 'org.custom_role.tool_permission_cleared', role.id, { tool_id });
    res.status(204).end();
});

export default router;
