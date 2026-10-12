/**
 * ET-3 Phase D — bulk invite HTTP routes.
 *
 * POST /orgs/:orgId/invites/bulk
 *   body:
 *     csv?:     string (CSV with an "email" header + optional role/team)
 *     rows?:    Array<{ email, role?, team? }>   (alternative to csv)
 *     dry_run?: boolean                          (validate only)
 *
 * Gated by: requirePlan('team') + ORG_MANAGE_MEMBERS.
 */

import { Router } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import { parseInviteCsv, runBulkInvite } from '../utils/bulkInvite.js';
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

function requireManageMembers(req, res, next) {
    const role = req.orgMembership?.role;
    if (!resolveCap(req, Capabilities.ORG_MANAGE_MEMBERS)) {
        return res.status(403).json({
            error:    'forbidden',
            required: Capabilities.ORG_MANAGE_MEMBERS,
        });
    }
    next();
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'org', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[bulk-invite] audit insert failed:', err.message);
    }
}

const chain = [ensureAuthedOrg, requireAuthedOrg, requirePlan('team'), requireManageMembers];

router.post('/orgs/:orgId/invites/bulk', ...chain, (req, res) => {
    const { csv, rows, dry_run: dryRun = false } = req.body || {};
    if (typeof csv !== 'string' && !Array.isArray(rows)) {
        return res.status(400).json({
            error: 'missing_input',
            message: 'provide either csv (string) or rows (array)',
        });
    }

    let parsedRows;
    try {
        parsedRows = Array.isArray(rows) ? rows : parseInviteCsv(csv);
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }

    try {
        const result = runBulkInvite(db(req), req.org.id, req.user.id, parsedRows, {
            dryRun: !!dryRun,
        });
        if (!dryRun) {
            emitAudit(req, 'org.invites.bulk_executed', req.org.id, {
                created: result.created,
                errors:  result.errors.length,
            });
        }
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: 'bulk_invite_failed', message: String(err?.message || err) });
    }
});

export default router;
