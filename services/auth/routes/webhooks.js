/**
 * ET-3 Phase B — org webhook + team_events HTTP routes.
 *
 * Endpoints:
 *   GET    /orgs/:orgId/webhooks
 *   POST   /orgs/:orgId/webhooks               { url, events }
 *   POST   /orgs/:orgId/webhooks/:id/rotate
 *   DELETE /orgs/:orgId/webhooks/:id
 *   GET    /orgs/:orgId/team-events?since=ID&limit=N
 *
 * Gated: enterprise tier + ORG_MANAGE_SETTINGS.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensureWebhooksSchema,
    createWebhook,
    listWebhooks,
    deleteWebhook,
    rotateWebhookSecret,
} from '../utils/webhooks.js';
import {
    ensureTeamEventsSchema,
    listTeamEvents,
    listTeamEventsSince,
} from '../utils/teamEvents.js';
import {
    ensureScimTokensSchema,
    createScimToken,
    listScimTokens,
    revokeScimToken,
} from '../utils/scimTokens.js';
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
            VALUES (?, ?, 'user', ?, ?, 'webhook', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[webhooks] audit insert failed:', err.message);
    }
}

function lazyEnsure(req) {
    try { ensureWebhooksSchema(db(req)); } catch { /* noop */ }
    try { ensureTeamEventsSchema(db(req)); } catch { /* noop */ }
    try { ensureScimTokensSchema(db(req)); } catch { /* noop */ }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('enterprise'), requireManageSettings];

// ──────────────────────────────────────────────────────────────────────
// Webhook CRUD
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/webhooks', ...chain, (req, res) => {
    lazyEnsure(req);
    res.json({ webhooks: listWebhooks(db(req), req.org.id) });
});

router.post('/orgs/:orgId/webhooks', ...chain, (req, res) => {
    lazyEnsure(req);
    try {
        const webhook = createWebhook(db(req), req.org.id, {
            url:       req.body?.url,
            events:    req.body?.events,
            createdBy: req.user.id,
        });
        emitAudit(req, 'org.webhook.created', webhook.id, {
            url: webhook.url, events: webhook.events,
        });
        res.status(201).json({ webhook });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_webhook', message: String(err?.message || err) });
    }
});

router.post('/orgs/:orgId/webhooks/:id/rotate', ...chain, (req, res) => {
    lazyEnsure(req);
    const out = rotateWebhookSecret(db(req), req.org.id, req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found' });
    emitAudit(req, 'org.webhook.secret_rotated', req.params.id, {});
    res.json(out);
});

router.delete('/orgs/:orgId/webhooks/:id', ...chain, (req, res) => {
    lazyEnsure(req);
    deleteWebhook(db(req), req.org.id, req.params.id);
    emitAudit(req, 'org.webhook.deleted', req.params.id, {});
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// team_events read API — used by Matrix (Stream M) and auditors
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// SCIM token admin (Phase C) — generate/list/revoke bearer tokens
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/scim/tokens', ...chain, (req, res) => {
    lazyEnsure(req);
    res.json({ tokens: listScimTokens(db(req), req.org.id) });
});

router.post('/orgs/:orgId/scim/tokens', ...chain, (req, res) => {
    lazyEnsure(req);
    const out = createScimToken(db(req), req.org.id, {
        label:     req.body?.label || null,
        createdBy: req.user.id,
    });
    emitAudit(req, 'org.scim.token_created', out.id, { label: req.body?.label || null });
    res.status(201).json(out);
});

router.delete('/orgs/:orgId/scim/tokens/:tokenId', ...chain, (req, res) => {
    lazyEnsure(req);
    revokeScimToken(db(req), req.org.id, req.params.tokenId);
    emitAudit(req, 'org.scim.token_revoked', req.params.tokenId, {});
    res.status(204).end();
});

router.get('/orgs/:orgId/team-events', ...chain, (req, res) => {
    lazyEnsure(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    const rows = since
        ? listTeamEventsSince(db(req), req.org.id, since, { limit })
        : listTeamEvents(db(req), req.org.id, { limit });
    res.json({ events: rows });
});

export default router;
