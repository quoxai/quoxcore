/**
 * ET-6C — org + scope secrets HTTP routes.
 *
 * Endpoints:
 *   GET    /orgs/:orgId/secrets?scope_id=...
 *   POST   /orgs/:orgId/secrets
 *   GET    /orgs/:orgId/secrets/:id
 *   POST   /orgs/:orgId/secrets/:id/reveal
 *   PATCH  /orgs/:orgId/secrets/:id
 *   DELETE /orgs/:orgId/secrets/:id
 *
 * Gated by: Team tier+ + ORG_MANAGE_SETTINGS.
 *
 * Reveal is a separate endpoint that emits its own org.secret.revealed
 * audit event so listing / editing never surfaces plaintext.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureSecretsSchema,
    createSecret,
    listSecrets,
    getSecretMeta,
    revealSecret,
    updateSecret,
    deleteSecret,
} from '../utils/secrets.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { requirePlan } from '../middleware/requirePlan.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';

const router = Router();

function db(req) { return req.db || getDb(); }

function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) return res.status(401).json({ error: 'unauthenticated' });
    next();
}

function requireManageSettings(req, res, next) {
    if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
        return res.status(403).json({ error: 'forbidden', required: Capabilities.ORG_MANAGE_SETTINGS });
    }
    next();
}

// ET-ENFORCE A — secrets cross-scope leak.
// For team-scoped secrets (scope_id non-null), ORG_MANAGE_SETTINGS alone is not
// sufficient — the caller must also have an active team_memberships row on the
// team whose scope matches. Org-wide secrets (scope_id IS NULL) keep the
// existing ORG_MANAGE_SETTINGS-only gate.
//
// Pure helper: returns { allowed, reason } so it can gate POST (where there's
// no secret row yet) as well as the per-id middleware below.
function checkScopeMembership(req, scopeId) {
    if (scopeId == null) return { allowed: true, reason: 'org_wide' };
    const scope = db(req).prepare(
        `SELECT scope_type, ref_id FROM scopes WHERE id = ? AND org_id = ?`,
    ).get(scopeId, req.org.id);
    if (!scope || scope.scope_type !== 'team') {
        return { allowed: false, reason: 'forbidden_scope_unknown' };
    }
    const member = db(req).prepare(
        `SELECT 1 FROM team_memberships
         WHERE team_id = ? AND user_id = ? AND status = 'active'`,
    ).get(scope.ref_id, req.user.id);
    return member
        ? { allowed: true, reason: 'team_member' }
        : { allowed: false, reason: 'forbidden_not_team_member' };
}

function requireScopeMembership(req, res, next) {
    lazyEnsure(req);
    const secretId = req.params.id;
    if (!secretId) return next();
    const meta = getSecretMeta(db(req), req.org.id, secretId);
    if (!meta) return res.status(404).json({ error: 'not_found' });
    const verdict = checkScopeMembership(req, meta.scope_id);
    if (!verdict.allowed) {
        // #323: surface verdict.reason so the FE can show the correct
        // copy for each case (scope unknown vs not a team member).
        return res.status(403).json({ error: verdict.reason });
    }
    req._secretMeta = meta;
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'secret', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[secrets] audit insert failed:', err.message);
    }
}

function lazyEnsure(req) {
    try { ensureSecretsSchema(db(req)); } catch { /* noop */ }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('team'), requireManageSettings];

// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/secrets', ...chain, (req, res) => {
    lazyEnsure(req);
    const q = req.query.scope_id;
    const filters = {};
    if (q !== undefined) {
        // 'org' is the explicit sentinel for org-wide (scope_id IS NULL).
        filters.scopeId = (q === 'org' || q === '') ? null : String(q);
    }
    res.json({ secrets: listSecrets(db(req), req.org.id, filters) });
});

router.post('/orgs/:orgId/secrets', ...chain, (req, res) => {
    lazyEnsure(req);
    const { name, value, description = null, scope_id = null, metadata = {} } = req.body || {};
    if (!name)  return res.status(400).json({ error: 'name_required' });
    if (!value) return res.status(400).json({ error: 'value_required' });

    // ET-ENFORCE round-3: same scope-membership rule as reveal/update/delete.
    // Without this, an admin can plant secrets in a team's scope namespace
    // without being a member — DoS via name collision and audit-attribution
    // pollution.
    const verdict = checkScopeMembership(req, scope_id || null);
    if (!verdict.allowed) {
        return res.status(403).json({ error: 'forbidden', required: 'team_membership' });
    }

    try {
        const secret = createSecret(db(req), req.org.id, {
            name, value, description, scopeId: scope_id, metadata,
            createdBy: req.user.id,
        });
        emitAudit(req, 'org.secret.created', secret.id, { name, scope_id });
        res.status(201).json({ secret });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE|already exists/i.test(msg)) {
            return res.status(409).json({ error: 'secret_exists', message: msg });
        }
        return res.status(400).json({ error: 'invalid_input', message: msg });
    }
});

router.get('/orgs/:orgId/secrets/:id', ...chain, (req, res) => {
    lazyEnsure(req);
    const meta = getSecretMeta(db(req), req.org.id, req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found' });
    res.json({ secret: meta });
});

router.post('/orgs/:orgId/secrets/:id/reveal', ...chain, requireScopeMembership, (req, res) => {
    lazyEnsure(req);
    const out = revealSecret(db(req), req.org.id, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found' });
    emitAudit(req, 'org.secret.revealed', out.id, { name: out.name });
    res.json({ id: out.id, name: out.name, value: out.value });
});

router.patch('/orgs/:orgId/secrets/:id', ...chain, requireScopeMembership, (req, res) => {
    lazyEnsure(req);
    try {
        const secret = updateSecret(db(req), req.org.id, req.params.id, req.body || {});
        if (!secret) return res.status(404).json({ error: 'not_found' });
        const rotated = 'value' in (req.body || {});
        emitAudit(req, rotated ? 'org.secret.rotated' : 'org.secret.updated', secret.id, {
            fields: Object.keys(req.body || {}).filter(k => k !== 'value'),
            rotated,
        });
        res.json({ secret });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/secrets/:id', ...chain, requireScopeMembership, (req, res) => {
    lazyEnsure(req);
    const existing = getSecretMeta(db(req), req.org.id, req.params.id);
    deleteSecret(db(req), req.org.id, req.params.id);
    if (existing) emitAudit(req, 'org.secret.deleted', req.params.id, { name: existing.name });
    res.status(204).end();
});

export default router;
