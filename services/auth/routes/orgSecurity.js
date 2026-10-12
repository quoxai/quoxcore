/**
 * ET-4 Phase C — Org security HTTP routes.
 *
 * Mounted under /api. Endpoints:
 *   GET/PUT    /orgs/:orgId/security/session-policy
 *   GET/POST   /orgs/:orgId/security/ip-allowlist
 *   DELETE     /orgs/:orgId/security/ip-allowlist/:entryId
 *   GET/PUT    /orgs/:orgId/security/mfa
 *
 * Gated by: authenticate() → requireOrg() → requirePlan('enterprise')
 *           → ORG_MANAGE_SETTINGS capability.
 *
 * Tests mount the router with a fake auth/org middleware and an
 * injected req.db. Production mounts go through the real auth stack.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureSessionPolicySchema,
    getSessionPolicy,
    setSessionPolicy,
} from '../utils/sessionPolicy.js';
import {
    ensureIpAllowlistSchema,
    listIpAllowlist,
    addIpAllowlistEntry,
    removeIpAllowlistEntry,
} from '../utils/ipAllowlist.js';
import { MFA_MODES } from '../utils/mfaPolicy.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requirePlan } from '../middleware/requirePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';

const router = Router();

function db(req) {
    return req.db || getDb();
}

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

function requireManageSettings(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
        return res.status(403).json({
            error:    'forbidden',
            required: Capabilities.ORG_MANAGE_SETTINGS,
        });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'org_security', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[org-security] audit insert failed:', err.message);
    }
}

function parseSecurityFlags(org) {
    if (!org?.security_flags_json) return {};
    try { return JSON.parse(org.security_flags_json); } catch { return {}; }
}

function writeSecurityFlags(database, orgId, flags) {
    database.prepare(`UPDATE orgs SET security_flags_json = ? WHERE id = ?`)
        .run(JSON.stringify(flags), orgId);
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('enterprise'), requireManageSettings];

// ──────────────────────────────────────────────────────────────────────
// Session policy
// ──────────────────────────────────────────────────────────────────────
router.get('/orgs/:orgId/security/session-policy', ...chain, (req, res) => {
    const policy = getSessionPolicy(db(req), req.org.id);
    res.json({ policy });
});

router.put('/orgs/:orgId/security/session-policy', ...chain, (req, res) => {
    try {
        const policy = setSessionPolicy(db(req), req.org.id, req.body || {});
        emitAudit(req, 'org.security.session_policy_updated', req.org.id, policy);
        res.json({ policy });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

// ──────────────────────────────────────────────────────────────────────
// IP allowlist
// ──────────────────────────────────────────────────────────────────────
router.get('/orgs/:orgId/security/ip-allowlist', ...chain, (req, res) => {
    const entries = listIpAllowlist(db(req), req.org.id);
    res.json({ entries });
});

router.post('/orgs/:orgId/security/ip-allowlist', ...chain, (req, res) => {
    const { cidr, label = null } = req.body || {};
    if (!cidr) return res.status(400).json({ error: 'cidr_required' });
    try {
        const entry = addIpAllowlistEntry(db(req), req.org.id, { cidr, label, createdBy: req.user.id });
        emitAudit(req, 'org.security.ip_allowlist_added', entry.id, { cidr, label });
        res.status(201).json({ entry });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_cidr', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/security/ip-allowlist/:entryId', ...chain, (req, res) => {
    removeIpAllowlistEntry(db(req), req.org.id, req.params.entryId);
    emitAudit(req, 'org.security.ip_allowlist_removed', req.params.entryId, {});
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// MFA policy (stored in orgs.security_flags_json.mfa)
// ──────────────────────────────────────────────────────────────────────
router.get('/orgs/:orgId/security/mfa', ...chain, (req, res) => {
    const flags = parseSecurityFlags(req.org);
    const mode  = flags.mfa?.mode || MFA_MODES.OPTIONAL;
    res.json({ mode });
});

router.put('/orgs/:orgId/security/mfa', ...chain, (req, res) => {
    const { mode } = req.body || {};
    const valid = Object.values(MFA_MODES);
    if (!valid.includes(mode)) {
        return res.status(400).json({ error: 'invalid_mode', message: `mode must be one of ${valid.join(', ')}` });
    }
    const flags = parseSecurityFlags(req.org);
    flags.mfa = { ...(flags.mfa || {}), mode };
    writeSecurityFlags(db(req), req.org.id, flags);
    emitAudit(req, 'org.security.mfa_policy_updated', req.org.id, { mode });
    res.json({ mode });
});

export default router;
