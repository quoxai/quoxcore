/**
 * ET-3 Phase A — domain verification HTTP routes.
 *
 * Endpoints (under /api):
 *   GET    /orgs/:orgId/domains
 *   POST   /orgs/:orgId/domains
 *   POST   /orgs/:orgId/domains/:domainId/verify
 *   DELETE /orgs/:orgId/domains/:domainId
 *
 * Gated by: requirePlan('team') + ORG_MANAGE_SETTINGS.
 * Tests inject req.db + req.user + req.org + req.orgMembership;
 * prod uses the real auth/org chain.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureDomainsSchema,
    startDomainVerification,
    verifyDomain,
    listOrgDomains,
    removeDomain,
} from '../utils/domainVerification.js';
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
    if (!req.user || !req.org) return res.status(401).json({ error: 'unauthenticated' });
    next();
}

function requireManageSettings(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_SETTINGS)) {
        return res.status(403).json({ error: 'forbidden', required: Capabilities.ORG_MANAGE_SETTINGS });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'verified_domain', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[domains] audit insert failed:', err.message);
    }
}

function lazyEnsure(req) {
    try { ensureDomainsSchema(db(req)); } catch { /* best-effort */ }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('team'), requireManageSettings];

function buildInstructions(domain, token) {
    return `Add this TXT record to the DNS for ${domain}:\n\n` +
           `  Name:  ${domain}\n` +
           `  Type:  TXT\n` +
           `  Value: ${token}\n\n` +
           `Once the record has propagated, click Verify. DNS changes can take up to 48 hours.`;
}

// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/domains', ...chain, (req, res) => {
    lazyEnsure(req);
    const domains = listOrgDomains(db(req), req.org.id);
    res.json({ domains });
});

router.post('/orgs/:orgId/domains', ...chain, (req, res) => {
    lazyEnsure(req);
    const domain = (req.body?.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'domain_required' });
    try {
        const row = startDomainVerification(db(req), req.org.id, domain);
        emitAudit(req, 'org.domain.verification_started', row.id, { domain: row.domain });
        res.status(201).json({
            domain:       row,
            instructions: buildInstructions(row.domain, row.verification_token),
        });
    } catch (err) {
        const msg = String(err?.message || err);
        const status = /already claimed/i.test(msg) ? 409 : 400;
        return res.status(status).json({ error: 'invalid_domain', message: msg });
    }
});

router.post('/orgs/:orgId/domains/:domainId/verify', ...chain, async (req, res) => {
    lazyEnsure(req);
    try {
        const result = await verifyDomain(db(req), req.org.id, req.params.domainId, {
            dnsImpl: req.app.locals?.dnsImpl,
        });
        if (result.reason === 'not_found') {
            return res.status(404).json({ error: 'not_found' });
        }
        if (result.verified) {
            emitAudit(req, 'org.domain.verified', req.params.domainId, {});
            return res.json({ verified: true });
        }
        // Domain exists but TXT missing/wrong → 202 Accepted (retryable).
        return res.status(202).json({
            verified:  false,
            reason:    result.reason,
            retryable: !!result.retryable,
        });
    } catch (err) {
        return res.status(500).json({ error: 'verify_failed', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/domains/:domainId', ...chain, (req, res) => {
    lazyEnsure(req);
    removeDomain(db(req), req.org.id, req.params.domainId);
    emitAudit(req, 'org.domain.removed', req.params.domainId, {});
    res.status(204).end();
});

export default router;
