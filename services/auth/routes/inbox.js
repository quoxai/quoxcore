/**
 * Inbox Routes for Quox Auth Service
 * Phase C.1: Human-in-the-Loop (HITL) inbox system
 *
 * Inboxes are work queues for human attention - approvals, questions, tasks, etc.
 */

import { buildStatusFilter, HISTORY_ORDER } from '../utils/inboxStatusFilter.js';
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { prepare, transaction, getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { subscribeClient, emitItemCreated, emitItemResponded, emitItemUpdated, emitStatsUpdate } from '../utils/inboxEvents.js';
import { routeAndNotify } from '../services/notificationRouter.js';
import { getLeaseById, approveLease, denyLease, getCredentialById } from '../db/integrations.js';
import { clearCache as clearResolverCache } from '../services/credentialResolver.js';
import { resolveChannelOrigin } from '../lib/channelOrigin.js';
import { emitApprovalVoltWitness } from '../jobs/volt-witness-reaper.js';
import { isDenyAction, isApproveAction } from '../lib/inboxResponseClassifier.js';
import { findItemByIdOrApprovalId, alreadyResolvedBody, notFoundBody } from '../lib/alreadyResolved.js';
import { dispatchApprovalCallback } from '../lib/approvalCallback.js';
import { requireHumanDecider, sandboxApproverLeaseActive, userRowIsNonHuman } from '../utils/principal.js';
import { forwardCheckpointDecision } from '../lib/checkpointDecision.js';
import { signWithApprovalKey } from '../lib/approvalEvents.js';
import { requireStepUpForApprove, stepUpRequiredFor, checkStepUpToken, getPinStatus, stepUpEnforced } from '../lib/stepUp.js';
import { openApprovals, visibilityClause as sharedVisibility, isDecisionRow, expireDueDecisions } from '../lib/openApprovals.js';
import { toRepoRelative } from '../lib/repoPath.js';
import { buildDecision, resolveDecisionResponse, decisionView } from '../lib/decisions.js';
import { bulkHeldReason } from '../lib/bulkGuard.js';
import { computeInboxStats } from '../lib/inboxStats.js';
import { queryInboxQueue, parseQueueFilters, groupInboxByTitle, getInboxItemDetail, closeItem, snoozeItem, assignItem, bulkDismissInfo, HousekeepingError, activeMembership as triageActiveMembership } from '../lib/inboxQueue.js';
import { describedApprovalPayload } from '../lib/approvalWhat.js';
import { isDisposableTestInstance, getTestApproverLeaseUntil } from '../lib/quoxperticusInstance.js';

// VAULT-P5.I (F4) — default lease duration granted when a credential lease
// is approved via the GENERIC inbox respond endpoint (which has no
// duration_minutes input, unlike the dedicated
// POST /orgs/:orgId/integrations/leases/:id/approve endpoint). Falls back
// to the credential's own lease_max_duration_minutes when set.
const DEFAULT_INBOX_APPROVED_LEASE_MINUTES = 60;

const router = Router();

// Item kinds
const ITEM_KINDS = ['approval', 'question', 'task', 'incident', 'info', 'override_required'];

// ========================================================================
// Internal router — no auth, no CSRF (service-to-service within Docker)
// Mounted separately in server.js at /api/internal
// ========================================================================

export const internalRouter = Router();

// P0a (QUOXPERTICUS HARD INVARIANT #1) gated /resolve; P0b step 6a widened it
// ROUTER-WIDE: every internal inbox route requires the internal service key,
// matching every other /api/internal router in this service. Constant-time
// compare. The caller audit (2026-08-14) found every legitimate caller is a
// key-holding service (the keyless collector connector libs were fixed in the
// same increment); the one frontend caller (serviceAlertBridge auto-resolve)
// was already dead in prod (nginx's /api/ catch-all 404s /api/internal) and
// moved to the authenticated POST /api/orgs/:orgId/inbox/auto-resolve below.
function requireInternalAuth(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying internal inbox resolve');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const provided = req.headers['x-service-key'];
  if (typeof provided === 'string') {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
  }
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

internalRouter.use(requireInternalAuth);

/**
 * POST /orgs/:orgId/inbox
 * Create an inbox item from an internal service (e.g., QuoxFlow scheduled workflow).
 */
internalRouter.post('/orgs/:orgId/inbox', async (req, res) => {
    try {
        const { orgId } = req.params;
        const { kind, priority, title, body_md, assignee_user_id, created_by_user_id, aee_correlation_id, quoxflow_execution_id, tasks_objective_id } = req.body;
        let { payload } = req.body;

        if (!kind || !ITEM_KINDS.includes(kind)) {
            return res.status(400).json({ error: `Invalid kind. Must be one of: ${ITEM_KINDS.join(', ')}` });
        }
        if (!title) {
            return res.status(400).json({ error: 'title is required' });
        }
        // A priority outside the schema's set hit the CHECK constraint and 500'd, so an agent's queued approval was
        // silently lost (story-a onboarding journey, 2026-10-17); refuse it with the allowed values, like the org route.
        if (priority != null && !PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: `Invalid priority ${JSON.stringify(priority)}. Must be one of: ${PRIORITIES.join(', ')}` });
        }
        // APPROVAL-WHAT: an approval must say what will happen and to what, or it is refused (422).
        payload = describedApprovalPayload(req, res, { kind, payload, quoxflow_execution_id });
        if (payload === null) return;

        // Server-side dedup: skip if identical title+kind was created in last 30 min
        // QC-BRUTALOOP-W13: items that carry a conversation_id dedup per
        // conversation only. Otherwise two different visitors' handoffs with the
        // same generic title ("Live chat handoff requested") within 30 minutes
        // collapsed into the first one and the second never reached the inbox.
        const dedupConv = (payload && typeof payload.conversation_id === 'string' && payload.conversation_id) ? payload.conversation_id : null;
        // quox#1033: an approval card binds to ONE quoxflow execution. A gate's title is the same for every run of a
        // workflow, so title+kind alone folded run 3's card into run 1's: approving it resumed run 1 only.
        const dedupExec = (typeof quoxflow_execution_id === 'string' && quoxflow_execution_id) ? quoxflow_execution_id : null;
        const dedup = prepare(`
            SELECT id, created_at FROM inbox_items
            WHERE org_id = ? AND title = ? AND kind = ?
              AND status IN ('open', 'in_progress', 'waiting')
              AND created_at > datetime('now', '-30 minutes')
              AND deleted_at IS NULL
              AND (? IS NULL OR json_extract(payload_json, '$.conversation_id') = ?)
              AND (? IS NULL OR quoxflow_execution_id = ?)
            ORDER BY created_at DESC LIMIT 1
        `).get(orgId, title, kind, dedupConv, dedupConv, dedupExec, dedupExec);

        if (dedup) {
            return res.status(200).json({
                deduplicated: true,
                existing_item_id: dedup.id,
                message: `Duplicate suppressed — identical "${title}" (${kind}) created at ${dedup.created_at}`
            });
        }

        // Find target users: use specific assignee, or ALL org owners/admins.
        // The assignee_user_id is untrusted — agents pass arbitrary strings
        // here ("operator", an email, etc.). Validate the user exists AND
        // is a member of this org before trusting it; otherwise the
        // downstream ensurePersonalInbox FK-fails on inboxes.owner_id →
        // users.id and the route 500s. Reject with 400 so the caller
        // (LLM, workflow) can correct rather than dump a generic error.
        let targetUserIds = [];
        if (assignee_user_id) {
            const member = prepare(`
                SELECT u.id FROM users u
                JOIN org_memberships m ON m.user_id = u.id
                WHERE u.id = ? AND m.org_id = ? AND m.status = 'active'
            `).get(assignee_user_id, orgId);
            if (!member) {
                return res.status(400).json({
                    error: 'invalid_assignee_user_id',
                    message: `assignee_user_id ${JSON.stringify(assignee_user_id)} is not an active member of this org`,
                });
            }
            targetUserIds = [member.id];
        } else {
            const owners = prepare(`
                SELECT user_id FROM org_memberships WHERE org_id = ? AND role IN ('owner', 'admin')
            `).all(orgId);
            targetUserIds = owners.map(o => o.user_id);
        }
        if (targetUserIds.length === 0) {
            return res.status(400).json({ error: 'No assignee found for this org' });
        }

        // quox#638: record the user who caused this item to be filed (e.g. the
        // agent identity running x_post / HERALD), so that identity can later
        // resolve the inbox_item_id it was handed back via `quox inbox get` and
        // see the card in its list — VISIBILITY only, never approval authority
        // (respond still gates on admin/owner or assignee). created_by is a FK
        // to users.id, so validate org membership before trusting it (same
        // untrusted-input posture as assignee_user_id above); an invalid value
        // is dropped to NULL rather than 500ing on the FK — the card is still
        // filed correctly for the owner/admin approvers.
        let createdBy = null;
        if (created_by_user_id) {
            const creator = prepare(`
                SELECT u.id FROM users u
                JOIN org_memberships m ON m.user_id = u.id
                WHERE u.id = ? AND m.org_id = ? AND m.status = 'active'
            `).get(created_by_user_id, orgId);
            if (creator) createdBy = creator.id;
        }

        // Use the first owner's inbox for the item record
        const primaryUserId = targetUserIds[0];
        const targetInboxId = ensurePersonalInbox(orgId, primaryUserId);
        const itemId = ulid();

        prepare(`
            INSERT INTO inbox_items (
                id, org_id, inbox_id, kind, priority, title, body_md,
                payload_json, created_by, aee_correlation_id, quoxflow_execution_id, tasks_objective_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            itemId, orgId, targetInboxId,
            kind, priority || 'normal', title, body_md || null,
            JSON.stringify(payload || {}), createdBy,  // quox#638: filing user (visibility), or NULL if system-generated/unresolvable
            aee_correlation_id || null,
            quoxflow_execution_id || null,
            tasks_objective_id || null
        );

        // Assign to ALL target users so every owner/admin sees it
        for (const userId of targetUserIds) {
            prepare(`
                INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
                VALUES (?, ?, 'user', ?, 'anyone')
            `).run(ulid(), itemId, userId);
        }

        const createdItem = {
            id: itemId,
            org_id: orgId,
            inbox_id: targetInboxId,
            kind,
            status: 'open',
            priority: priority || 'normal',
            title
        };

        emitItemCreated(orgId, createdItem);
        emitStatsUpdate(orgId);

        // Fire-and-forget: evaluate routing rules and dispatch notifications
        routeAndNotify(orgId, {
            id: itemId,
            kind,
            priority: priority || 'normal',
            title,
            body_md: body_md || null,
            payload_json: JSON.stringify(payload || {})
        }).catch(err => {
            console.error('[Inbox] routeAndNotify error:', err.message);
        });

        createAuditEvent({
            orgId,
            actorType: 'system',
            actorId: 'quoxflow',
            action: 'hitl.item_created',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: { kind, title, source: 'quoxflow-schedule' }
        });

        res.status(201).json({ item: createdItem });
    } catch (error) {
        console.error('[Inbox/Internal] Error creating inbox item:', error);
        res.status(500).json({ error: 'Failed to create inbox item' });
    }
});

/**
 * GET /orgs/:orgId/inbox/items
 * List inbox items with optional filters (for workflow watchers).
 * Query params: kind, status, source (matched against payload_json).
 * Docker-internal only — no auth.
 */
internalRouter.get('/orgs/:orgId/inbox/items', async (req, res) => {
    try {
        const { orgId } = req.params;
        const { kind, status, source, limit: qLimit } = req.query;

        const db = getDb();
        let sql = 'SELECT * FROM inbox_items WHERE org_id = ?';
        const params = [orgId];

        if (kind) {
            sql += ' AND kind = ?';
            params.push(kind);
        }
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        // #864: the total of every match, so a reader never mistakes a page for the count.
        const total = source ? null : (db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) AS n')).get(...params)?.n ?? 0);

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(parseInt(qLimit) || 50);

        let items = db.prepare(sql).all(...params);

        // Filter by source in payload_json if requested
        if (source) {
            items = items.filter(item => {
                try {
                    const payload = JSON.parse(item.payload_json || '{}');
                    return payload.source === source;
                } catch { return false; }
            });
        }

        // With a source filter the match is post-filtered in JS, so only the page is known.
        res.json({ items, total: total === null ? items.length : total, total_exact: total !== null });
    } catch (error) {
        console.error('[Inbox/Internal] Error listing inbox items:', error);
        res.status(500).json({ error: 'Failed to list inbox items' });
    }
});

/**
 * GET /api/internal/orgs/:orgId/inbox/stats?user_id=U  (QUOXON-PROOF #864)
 * The SAME counts U's own GET /orgs/:orgId/inbox/stats returns (lib/inboxStats.js), for the
 * collector's inbox_stats agent tool, which acts as the user driving the turn. Service-key
 * auth (router-wide). U must be an active, unexpired member of the org: a non-member gets
 * 403, never org-wide counts.
 */
internalRouter.get('/orgs/:orgId/inbox/stats', (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
        if (!userId) return res.status(400).json({ error: 'user_id is required' });
        const membership = prepare('SELECT role, status, expires_at FROM org_memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
        const expired = membership?.expires_at && !Number.isNaN(Date.parse(membership.expires_at)) && Date.parse(membership.expires_at) <= Date.now();
        if (!membership || membership.status !== 'active' || expired) {
            return res.status(403).json({ error: 'not_org_member', message: 'That user is not an active member of this organization' });
        }
        const isOrgAdmin = ['owner', 'admin'].includes(membership.role);
        const personalInboxId = ensurePersonalInbox(orgId, userId);
        res.json(computeInboxStats({ orgId, userId, isOrgAdmin, personalInboxId }));
    } catch (error) {
        console.error('[Inbox/Internal] Error getting inbox stats:', error);
        res.status(500).json({ error: 'Failed to get inbox stats' });
    }
});

/**
 * TRIAGE-TOOLS (2026-10-16): the triage read side + safe housekeeping for the collector's
 * hitl_queue / hitl_item / hitl_groups / hitl_item_* / hitl_bulk_dismiss tools.
 * All act as ?user_id= (or body.user_id), who must be an active member; reads use that
 * user's visibility. Housekeeping refuses approval, override_required and question items
 * (lib/inboxQueue.js). Bulk dismiss from an agent needs the id of an APPROVED
 * hitl_bulk_dismiss approval in this org: an agent cannot mass-dismiss on its own say-so.
 */
function triageUser(req, res) {
    const raw = req.method === 'GET' ? req.query.user_id : (req.body?.user_id ?? req.query.user_id);
    const userId = typeof raw === 'string' ? raw.trim() : '';
    if (!userId) { res.status(400).json({ error: 'user_id is required' }); return null; }
    const m = triageActiveMembership(req.params.orgId, userId);
    if (!m) { res.status(403).json({ error: 'not_org_member', message: 'That user is not an active member of this organization' }); return null; }
    return { userId, isOrgAdmin: m.isOrgAdmin, personalInboxId: ensurePersonalInbox(req.params.orgId, userId) };
}
function triageActor(req) {
    const type = String(req.headers['x-actor-type'] || '').toLowerCase();
    return { type: ['human', 'service', 'agent'].includes(type) ? type : 'service', id: String(req.headers['x-actor-id'] || '').slice(0, 80) };
}
function sendHousekeepingError(res, err, label) {
    if (err instanceof HousekeepingError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error(`[Inbox/Internal] ${label}:`, err);
    return res.status(500).json({ error: `Failed: ${label}` });
}

internalRouter.get('/orgs/:orgId/inbox/queue', (req, res) => {
    try {
        const u = triageUser(req, res); if (!u) return;
        const parsed = parseQueueFilters(req.query);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        res.json(queryInboxQueue({ orgId: req.params.orgId, ...u, filters: parsed.filters }));
    } catch (error) { sendHousekeepingError(res, error, 'inbox queue read'); }
});

internalRouter.get('/orgs/:orgId/inbox/queue/groups', (req, res) => {
    try {
        const u = triageUser(req, res); if (!u) return;
        const parsed = parseQueueFilters(req.query);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        res.json(groupInboxByTitle({ orgId: req.params.orgId, ...u, filters: parsed.filters, minCount: req.query.min_count, limit: req.query.limit }));
    } catch (error) { sendHousekeepingError(res, error, 'inbox groups read'); }
});

internalRouter.get('/orgs/:orgId/inbox/queue/items/:itemId', (req, res) => {
    try {
        const u = triageUser(req, res); if (!u) return;
        const item = getInboxItemDetail({ orgId: req.params.orgId, ...u, itemId: req.params.itemId });
        if (!item) return res.status(404).json({ error: 'Inbox item not found' });
        res.json({ item });
    } catch (error) { sendHousekeepingError(res, error, 'inbox item detail'); }
});

internalRouter.post('/orgs/:orgId/inbox/queue/items/:itemId/housekeep', (req, res) => {
    try {
        const u = triageUser(req, res); if (!u) return;
        const { orgId, itemId } = req.params;
        const { action, reason, until, assignee_user_id: assigneeUserId } = req.body || {};
        const actor = triageActor(req);
        let result;
        if (action === 'dismiss' || action === 'resolve') result = closeItem({ orgId, itemId, ...u, mode: action, reason, actor });
        else if (action === 'snooze') result = snoozeItem({ orgId, itemId, ...u, until });
        else if (action === 'assign') result = assignItem({ orgId, itemId, ...u, assigneeUserId });
        else return res.status(400).json({ error: 'action must be dismiss, resolve, snooze or assign' });
        if (result.changed) {
            emitItemUpdated(orgId, itemId, { housekeeping: action, updated_by: u.userId });
            emitStatsUpdate(orgId);
            createAuditEvent({ orgId, actorType: actor.type === 'agent' ? 'agent' : 'user', actorId: actor.id || u.userId, action: `hitl.item_${action}`, targetType: 'inbox_item', targetId: itemId, metadata: { on_behalf_of: u.userId, reason: reason || null, until: until || null, assignee_user_id: assigneeUserId || null, housekeeping: true } });
        }
        res.json({ item_id: itemId, action, ...result });
    } catch (error) { sendHousekeepingError(res, error, 'inbox housekeeping'); }
});

internalRouter.post('/orgs/:orgId/inbox/queue/bulk-dismiss', (req, res) => {
    try {
        const u = triageUser(req, res); if (!u) return;
        const { orgId } = req.params;
        const actor = triageActor(req);
        const { item_ids: itemIds, title, reason, approval_id: approvalId } = req.body || {};
        if (actor.type === 'agent') {
            const appr = approvalId ? prepare(`SELECT status, response_json, payload_json FROM inbox_items WHERE org_id = ? AND kind = 'approval' AND deleted_at IS NULL
                AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END, '$.approval_id') = ?`).get(orgId, String(approvalId)) : null;
            let ok = false;
            if (appr && appr.status === 'resolved') {
                try {
                    const p = JSON.parse(appr.payload_json || '{}');
                    const r = JSON.parse(appr.response_json || '{}');
                    ok = p.toolName === 'hitl_bulk_dismiss' && isApproveAction(r.action);
                } catch { ok = false; }
            }
            if (!ok) return res.status(403).json({ error: 'approval_required', message: 'An agent bulk dismiss needs an approved hitl_bulk_dismiss approval in this organization; file the proposal and let a human confirm it' });
        }
        const result = bulkDismissInfo({ orgId, ...u, itemIds, title, reason, actor });
        if (result.dismissed_count) {
            emitStatsUpdate(orgId);
            createAuditEvent({ orgId, actorType: actor.type === 'agent' ? 'agent' : 'user', actorId: actor.id || u.userId, action: 'hitl.items_bulk_dismissed', targetType: 'inbox_item', targetId: result.dismissed[0], metadata: { on_behalf_of: u.userId, count: result.dismissed_count, title: title || null, approval_id: approvalId || null, ids: result.dismissed.slice(0, 50) } });
        }
        res.json(result);
    } catch (error) { sendHousekeepingError(res, error, 'inbox bulk dismiss'); }
});

/**
 * GET /api/internal/orgs/:orgId/approvals/open
 * Org-wide open approvals for service callers (LUCID). Service-key auth (router-wide).
 */
internalRouter.get('/orgs/:orgId/approvals/open', (req, res) => {
    try {
        res.json(openApprovals({ orgId: req.params.orgId, isOrgAdmin: true }));
    } catch (error) {
        console.error('[Inbox/Internal] Error listing open approvals:', error);
        res.status(500).json({ error: 'Failed to list open approvals' });
    }
});

/**
 * GET /api/internal/orgs/:orgId/inbox/items/:itemId
 * Single-item read, service-key auth — mirrors the internal POST above.
 *
 * X-PLUGIN P2 (adversarial review, finding 5 — approval authenticity): the
 * collector's X decide handler (services/collector/lib/xTools.js) trusted
 * its request body entirely, so any service-key holder could fabricate an
 * approval with fictional action_params and have it executed. This endpoint
 * lets the collector fetch the REAL, stored inbox item back by id and
 * cross-check kind/payload/status before executing — the body is no longer
 * the only source of truth for what was actually approved.
 */
internalRouter.get('/orgs/:orgId/inbox/items/:itemId', async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const db = getDb();
        const item = db.prepare(`
            SELECT * FROM inbox_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL
        `).get(itemId, orgId);

        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        let payload = {};
        try { payload = JSON.parse(item.payload_json || '{}'); } catch { /* leave payload {} */ }
        let response = null;
        try { response = item.response_json ? JSON.parse(item.response_json) : null; } catch { /* leave response null */ }

        res.json({
            item: {
                id: item.id,
                org_id: item.org_id,
                kind: item.kind,
                status: item.status,
                title: item.title,
                payload,
                response,
                created_at: item.created_at,
                resolved_at: item.resolved_at,
            },
        });
    } catch (error) {
        console.error('[Inbox/Internal] Error fetching inbox item:', error);
        res.status(500).json({ error: 'Failed to fetch inbox item' });
    }
});

/**
 * POST /orgs/:orgId/inbox/auto-resolve
 * Auto-resolve open service_monitor alerts for recovered services.
 * Body: { service_keys: ["auth", "collector", ...] }
 * Docker-internal only — no auth.
 */
/**
 * Shared by the internal route below and the authenticated
 * POST /api/orgs/:orgId/inbox/auto-resolve. Deliberately narrow: only
 * service_monitor incident alerts matching the given service keys are
 * touched, never approvals or any human-decision item.
 */
function autoResolveServiceAlerts(db, orgId, serviceKeys) {
    const now = new Date().toISOString();
    let resolvedCount = 0;

    // Find open service_monitor alerts for the given service keys
    const openAlerts = db.prepare(`
        SELECT id, payload_json FROM inbox_items
        WHERE org_id = ? AND status IN ('open', 'in_progress')
          AND kind = 'incident'
    `).all(orgId);

    for (const item of openAlerts) {
        try {
            const payload = JSON.parse(item.payload_json || '{}');
            if (payload.source === 'service_monitor' && serviceKeys.includes(payload.service_key)) {
                db.prepare(`
                    UPDATE inbox_items
                    SET status = 'resolved', resolved_at = ?, resolved_by = NULL
                    WHERE id = ? AND org_id = ?
                `).run(now, item.id, orgId);
                resolvedCount++;
            }
        } catch { /* skip unparseable payloads */ }
    }

    if (resolvedCount > 0) {
        emitStatsUpdate(orgId);
    }
    return resolvedCount;
}

internalRouter.post('/orgs/:orgId/inbox/auto-resolve', async (req, res) => {
    try {
        const { orgId } = req.params;
        const { service_keys } = req.body;

        if (!Array.isArray(service_keys) || service_keys.length === 0) {
            return res.status(400).json({ error: 'service_keys array is required' });
        }

        res.json({ resolved: autoResolveServiceAlerts(getDb(), orgId, service_keys) });
    } catch (error) {
        console.error('[Inbox/Internal] Auto-resolve error:', error);
        res.status(500).json({ error: 'Failed to auto-resolve alerts' });
    }
});

/**
 * POST /api/internal/orgs/:orgId/inbox/cancel-by-execution
 * Cancel the auth-side inbox mirror(s) linked to a QuoxFlow execution (or a
 * specific approval) when the underlying approval is cancelled (workflow
 * deactivated) or expired. Without this the mirror stays 'open' as a dead link
 * that can never be actioned. System-driven (no human actor is recorded),
 * idempotent (only active items are transitioned, so a resolved/cancelled item
 * is never reopened or overwritten), and org-scoped (matches on this org only).
 */
internalRouter.post('/orgs/:orgId/inbox/cancel-by-execution', async (req, res) => {
    try {
        const { orgId } = req.params;
        const { execution_id, approval_id, reason } = req.body;
        if (!execution_id && !approval_id) {
            return res.status(400).json({ error: 'execution_id or approval_id is required' });
        }

        const db = getDb();
        const responseJson = JSON.stringify({
            action: 'cancelled',
            reason: reason || 'source approval cancelled or expired',
            responded_by: 'system:quoxflow',
            responded_at: new Date().toISOString(),
        });

        // Only ACTIVE items transition; resolved/cancelled/expired are left as-is
        // so a decision is never reopened or overwritten (idempotent).
        let info;
        if (execution_id) {
            info = db.prepare(`
                UPDATE inbox_items
                SET status = 'cancelled', response_json = ?, resolved_at = datetime('now')
                WHERE org_id = ? AND quoxflow_execution_id = ?
                  AND status IN ('open', 'in_progress', 'waiting') AND deleted_at IS NULL
            `).run(responseJson, orgId, execution_id);
        } else {
            info = db.prepare(`
                UPDATE inbox_items
                SET status = 'cancelled', response_json = ?, resolved_at = datetime('now')
                WHERE org_id = ?
                  AND (json_extract(payload_json, '$.approval_id') = ? OR aee_correlation_id = ?)
                  AND status IN ('open', 'in_progress', 'waiting') AND deleted_at IS NULL
            `).run(responseJson, orgId, approval_id, approval_id);
            // APPROVAL-SPAM 3/6 (2026-10-03): native tool-approval cards carry the
            // approval id as aee_correlation_id (collector approvalGate mint), not
            // payload.approval_id, so the expiry sweep could never close them.
        }

        if (info.changes > 0) {
            emitStatsUpdate(orgId);
        }
        res.json({ cancelled: info.changes });
    } catch (error) {
        console.error('[Inbox/Internal] cancel-by-execution error:', error);
        res.status(500).json({ error: 'Failed to cancel inbox mirror' });
    }
});


/**
 * POST /api/internal/orgs/:orgId/inbox/:itemId/resolve
 * QUOXPLAN-HITLFIX: best-effort, idempotent resolve for a decide callback
 * (e.g. the collector's /api/internal/quoxplan/approvals/decide handler)
 * that ran outside the normal /respond flow — that callback already executed
 * the deferred action itself, so this just marks the card resolved without
 * re-running any of the resume bridges in POST .../respond. No-ops (returns
 * already_resolved: true) if the item isn't open, so calling it after the
 * normal /respond path already resolved the item is always safe.
 */
internalRouter.post('/orgs/:orgId/inbox/:itemId/resolve', async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { action, reason } = req.body;

        // P0b step 6b (DEC-2/DEC-3 at this sink): the recorded identity comes
        // from x-actor-type / x-actor-id headers the CALLING SERVICE derives
        // server-side (collector deriveActorType), never from the request
        // body — the body-supplied `approver` used to be recorded verbatim,
        // letting any key holder stamp any human's name on a resolution.
        // Agents are 403d by default, independent of any flag; the one
        // exception is a disposable_test instance holding an unexpired
        // test-approver lease, where the resolution is recorded as the
        // synthetic test-approver with the AGENT-DRIVEN-TEST-APPROVAL stamp
        // (DEC-4: no agent-chosen identity ever sits on an approval record).
        // Honest limit: header claims are only as strong as the shared
        // service key until per-service identity (#447) lands; this puts the
        // default-deny at the endpoint so that fix slots in without another
        // redesign.
        const actorType = String(req.headers['x-actor-type'] || '').toLowerCase();
        const actorId = String(req.headers['x-actor-id'] || '');
        if (!['human', 'service', 'agent'].includes(actorType)) {
            return res.status(400).json({ error: 'x-actor-type header required (human|service|agent); the body approver field is not trusted' });
        }

        let respondedBy;
        let comment = reason || '';
        if (actorType === 'agent') {
            const cfgDb = getDb();
            const leaseUntil = getTestApproverLeaseUntil(cfgDb);
            const leaseExpiry = leaseUntil ? Date.parse(leaseUntil) : NaN;
            const sandboxGrant = isDisposableTestInstance(cfgDb)
                && Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
            if (!sandboxGrant) {
                return res.status(403).json({ error: 'Agents cannot resolve HITL inbox items (HARD INVARIANT #1); file a proposal for a human instead' });
            }
            respondedBy = 'synthetic:test-approver';
            comment = `[AGENT-DRIVEN-TEST-APPROVAL driven_by=${actorId || 'agent'}]${comment ? ' ' + comment : ''}`;
        } else {
            respondedBy = actorId || 'system';
        }

        const db = getDb();
        const item = db.prepare(`SELECT id, status, kind FROM inbox_items WHERE id = ? AND org_id = ?`).get(itemId, orgId);
        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }
        if (!['open', 'in_progress', 'waiting'].includes(item.status)) {
            return res.json({ resolved: false, already_resolved: true });
        }

        const response = {
            action: action || 'approved',
            comment,
            responded_by: respondedBy,
            responded_at: new Date().toISOString()
        };
        db.prepare(`
            UPDATE inbox_items
            SET status = 'resolved', response_json = ?, resolved_by = NULL, resolved_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify(response), itemId);

        emitItemResponded(orgId, itemId, action || 'approved', null);
        emitStatsUpdate(orgId);

        // P2: witness the resolution in VOLT, same discipline as the
        // authenticated /respond route (approval-kind items only). A sandbox
        // synthetic resolution is witnessed as agent_driven_test with the
        // synthetic principal, never as a human decision; the stamp in the
        // comment carries which agent drove it.
        if (item.kind === 'approval') {
            try {
                await emitApprovalVoltWitness({
                    orgId,
                    itemId,
                    decision: isDenyAction(action) ? 'denied' : 'granted',
                    actor: respondedBy,
                    actorType: actorType === 'agent' ? 'agent_driven_test' : actorType,
                    comment,
                });
            } catch (err) {
                // Never throws (queues on failure); defense-in-depth only.
                console.error('[Inbox/Internal] unexpected witness error (non-fatal):', err.message);
            }
        }

        res.json({ resolved: true });
    } catch (error) {
        console.error('[Inbox/Internal] Resolve error:', error);
        res.status(500).json({ error: 'Failed to resolve inbox item' });
    }
});

/**
 * POST /api/internal/voice/approval/resolve  (QUOXHAT MISSION D2)
 *
 * The phone half of on-the-fly approvals. A PIN-verified owner on a QuoxVoice
 * call resolves a pending native-tool approval by voice/DTMF. The voice worker
 * (quox-voice) sets caller_verified:true ONLY after a DTMF PIN match and passes
 * caller_ref (e.g. { call_sid, pin_event_id }) for the audit trail.
 *
 * It routes through the SAME governed chain as the authenticated dashboard route
 * POST /orgs/:orgId/inbox/:itemId/respond — the #546 declared-approver check and
 * applyResponseSideEffects (VOLT witness + native-tool resume, the real effect).
 * It deliberately does NOT use the thinner internal /resolve above (which skips
 * applyResponseSideEffects, so the governed action never actually runs) and does
 * NOT POST /api/internal/tools/resume directly (which trusts a body `approver`
 * string — the #546 hole). The responding identity is DERIVED server-side from
 * the org owner (the PIN-verified phone owner), never from the request body, and
 * is still put through the #546 authority check rather than assumed.
 *
 * Contract (confirmed with QUOX-VOICE-AGENTS, 2026-10-02):
 *   body  { approval_id, action:'approve'|'deny', org_id, caller_verified:true, caller_ref? }
 *   reply { success, action, resolved, result?, error? }
 * Fail-closed: caller_verified !== true DENIES. Idempotent: a second resolve of
 * the same approval returns success WITHOUT re-running the effect (no
 * double-execute). Deny carries no result; an approve's tool output completes
 * asynchronously through the governed resume (same as the dashboard route — the
 * effect is witnessed, not returned inline).
 */
internalRouter.post('/voice/approval/resolve', async (req, res) => {
    try {
        const { approval_id, action, org_id, caller_verified, caller_ref } = req.body || {};

        // Fail-closed authentication of the phone caller. A missing/false
        // caller_verified is a denial, never a pass.
        if (caller_verified !== true) {
            return res.status(403).json({ success: false, error: 'caller_not_verified' });
        }
        if (!approval_id || !org_id) {
            return res.status(400).json({ success: false, error: 'approval_id and org_id are required' });
        }
        if (!['approve', 'deny'].includes(action)) {
            return res.status(400).json({ success: false, error: "action must be 'approve' or 'deny'" });
        }

        const db = getDb();
        // Locate the approval by its correlation id (what needs_approval surfaced
        // as approval_id = the approval-store id = the item's aee_correlation_id),
        // scoped to the org; fall back to the inbox item id for tolerance. Join
        // the run for the shared side-effect chain.
        let item = db.prepare(`
            SELECT ii.*, r.id as run_id
            FROM inbox_items ii
            LEFT JOIN runs r ON ii.run_id = r.id
            WHERE ii.aee_correlation_id = ? AND ii.org_id = ? AND ii.kind = 'approval'
        `).get(approval_id, org_id);
        if (!item) {
            item = db.prepare(`
                SELECT ii.*, r.id as run_id
                FROM inbox_items ii
                LEFT JOIN runs r ON ii.run_id = r.id
                WHERE ii.id = ? AND ii.org_id = ? AND ii.kind = 'approval'
            `).get(approval_id, org_id);
        }
        if (!item) {
            return res.status(404).json({ success: false, error: 'approval_not_found' });
        }

        // IDEMPOTENT: a second resolve of the same approval must NEVER re-run the
        // effect. If the item is already resolved, report the prior decision; a
        // CONFLICTING second action is flagged, still without re-executing.
        if (!['open', 'in_progress', 'waiting'].includes(item.status)) {
            let prior = null;
            try { prior = item.response_json ? JSON.parse(item.response_json) : null; } catch { /* ignore */ }
            const priorAction = (prior?.action || '').toLowerCase();
            const normalizedPrior = isApproveAction(priorAction) ? 'approve' : (isDenyAction(priorAction) ? 'deny' : null);
            return res.json({
                success: true,
                resolved: true,
                idempotent: true,
                action: normalizedPrior || action,
                ...(normalizedPrior && normalizedPrior !== action ? { conflict: true } : {}),
            });
        }

        // Derive the responding identity: the org OWNER (the PIN-verified phone
        // owner). The #546 declared-approver check is then RUN against that
        // identity's real membership, not skipped — an owner passes
        // isOrgAdminOrOwner. Body never supplies the approver (DEC-2/DEC-3).
        const org = db.prepare('SELECT id, owner_user_id FROM orgs WHERE id = ?').get(org_id);
        const ownerUserId = org?.owner_user_id || null;
        const ownerUser = ownerUserId
            ? db.prepare('SELECT id, primary_email, display_name FROM users WHERE id = ?').get(ownerUserId)
            : null;
        const membership = ownerUserId
            ? db.prepare(`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = 'active'`).get(org_id, ownerUserId)
            : null;
        if (!ownerUser || !membership) {
            return res.status(403).json({ success: false, error: 'no_resolvable_approver' });
        }
        if (!isOrgAdminOrOwner(membership) && !isApprovalAssignee(item.id, ownerUserId)) {
            return res.status(403).json({ success: false, error: 'not_authorized_approver' });
        }

        const callerRefStr = caller_ref
            ? (typeof caller_ref === 'string' ? caller_ref : JSON.stringify(caller_ref))
            : null;
        const comment = `[VOICE-PIN-RESOLVE${callerRefStr ? ' ' + callerRefStr : ''}]`;
        const response = {
            action,
            comment,
            responded_by: ownerUserId,
            responded_at: new Date().toISOString(),
            channel: 'voice',
            caller_ref: caller_ref || null,
        };
        db.prepare(`
            UPDATE inbox_items
            SET status = 'resolved', response_json = ?, resolved_by = ?, resolved_at = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify(response), ownerUserId, item.id);

        // Synthetic req for the shared governed chain. applyResponseSideEffects
        // reads only req.user.{id,primary_email,display_name}, req.ip and
        // req.get('user-agent'); nothing else.
        const syntheticReq = {
            user: { id: ownerUserId, primary_email: ownerUser.primary_email, display_name: ownerUser.display_name },
            ip: null,
            get: () => 'quox-voice/approval-resolve',
        };
        // The real effect: VOLT witness + native-tool resume. For action='deny'
        // the resume runs with action='deny' → the collector does NOT execute.
        await applyResponseSideEffects(item, { action, comment }, syntheticReq);

        // Audit the voice resolution with the caller_ref that justified trusting
        // caller_verified (corr = approval_id). The DECISION is VOLT-witnessed
        // inside applyResponseSideEffects; this records the voice channel + proof.
        createAuditEvent({
            orgId: org_id,
            actorType: 'user',
            actorId: ownerUserId,
            action: 'voice.approval.resolve',
            targetType: 'inbox_item',
            targetId: item.id,
            metadata: { approval_id, action, caller_ref: caller_ref || null, channel: 'voice' },
        });

        emitStatsUpdate(org_id);

        // Deny carries no result. An approve's tool output completes
        // asynchronously through the governed resume (not returned inline, same
        // as the dashboard respond route); resolved:true is the synchronous ack.
        return res.json({ success: true, resolved: true, action });
    } catch (error) {
        console.error('[Inbox/Voice] approval resolve error:', error);
        return res.status(500).json({ success: false, error: 'resolve_failed' });
    }
});

/**
 * GET /api/internal/telegram-user-lookup?chat_id=12345[&org_id=X]
 * Resolve a Telegram chat_id to a Quox user via notification_channels table.
 * Optional org_id disambiguates when a user has channels in multiple orgs.
 * Returns { user: { user_id, org_id, display_name } } or { user: null }
 */
internalRouter.get('/telegram-user-lookup', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        const orgId = req.query.org_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id query parameter is required' });
        }

        const db = getDb();
        let sql = `
            SELECT nc.user_id, u.display_name, COALESCE(nc.org_id, om.org_id) as org_id, om.role
            FROM notification_channels nc
            JOIN users u ON nc.user_id = u.id
            JOIN org_memberships om ON om.user_id = u.id AND om.status = 'active'
            WHERE nc.channel_type = 'telegram'
              AND nc.enabled = 1
              AND (json_extract(nc.config_json, '$.chatId') = ? OR json_extract(nc.config_json, '$.chat_id') = ?)
        `;
        const params = [String(chatId), String(chatId)];

        if (orgId) {
            sql += ` AND (nc.org_id = ? OR om.org_id = ?)`;
            params.push(orgId, orgId);
        }

        sql += ` LIMIT 1`;
        const row = db.prepare(sql).get(...params);

        if (row) {
            res.json({
                user: {
                    user_id: row.user_id,
                    org_id: row.org_id,
                    display_name: row.display_name
                }
            });
        } else {
            res.json({ user: null });
        }
    } catch (error) {
        console.error('[Inbox/Internal] Telegram user lookup error:', error);
        res.status(500).json({ error: 'Failed to look up Telegram user' });
    }
});

/**
 * GET /api/internal/telegram-webhook-config[?org_id=X][&bot_id=Y]
 * Returns all config needed by the collector webhook handler.
 * Resolves from vault (integration_credentials) and instance_config.
 * No env vars needed on the collector side.
 *
 * Optional org_id scopes credential lookup to a specific org.
 * Optional bot_id resolves config for a specific bot credential.
 *
 * Response: {
 *   bot_token, webhook_secret, bot_username, default_org_id,
 *   default_agent, webhook_url, webhook_active
 * }
 */
internalRouter.get('/telegram-webhook-config', async (req, res) => {
    try {
        const db = getDb();
        const requestedOrgId = req.query.org_id;
        const requestedBotId = req.query.bot_id;

        // 1. Resolve bot token from vault
        let botToken = null;
        let defaultOrgId = null;

        try {
            let credSql = `
                SELECT ic.id, ic.org_id, ic.ciphertext
                FROM integration_credentials ic
                WHERE ic.integration_type = 'telegram'
            `;
            const credParams = [];

            if (requestedBotId) {
                // Look up by specific credential ID
                credSql += ` AND ic.id = ?`;
                credParams.push(requestedBotId);
            } else if (requestedOrgId) {
                // Look up by org + default
                credSql += ` AND ic.org_id = ? AND ic.is_default = 1`;
                credParams.push(requestedOrgId);
            } else {
                // Legacy: first default credential across all orgs
                credSql += ` AND ic.is_default = 1`;
            }

            credSql += ` ORDER BY ic.created_at ASC LIMIT 1`;
            const credRow = db.prepare(credSql).get(...credParams);

            if (credRow) {
                const { decrypt } = await import('../utils/encryption.js');
                const creds = JSON.parse(decrypt(credRow.ciphertext));
                botToken = creds.bot_token || creds.token || null;
                defaultOrgId = credRow.org_id;

                // Update last_used_at
                db.prepare('UPDATE integration_credentials SET last_used_at = datetime(\'now\') WHERE id = ?')
                    .run(credRow.id);
            }
        } catch (err) {
            console.warn('[Telegram Config] Vault lookup failed:', err.message);
        }

        // Env fallback for bot token
        if (!botToken) {
            botToken = process.env.NOTIFICATION_TELEGRAM_TOKEN || null;
        }

        // 2. Resolve instance_config keys
        const getInstanceKey = (key) => {
            try {
                const row = db.prepare('SELECT value, encrypted FROM instance_config WHERE key = ?').get(key);
                if (!row?.value) return null;
                if (row.encrypted) {
                    const { decrypt } = require('../utils/encryption.js');
                    return decrypt(row.value);
                }
                return row.value;
            } catch { return null; }
        };

        const webhookSecret = getInstanceKey('telegram_webhook_secret') || process.env.TELEGRAM_WEBHOOK_SECRET || '';
        const botUsername = getInstanceKey('telegram_bot_username') || '';
        const defaultAgent = getInstanceKey('telegram_default_agent') || 'quox';
        const webhookUrl = getInstanceKey('telegram_webhook_url') || '';
        const webhookActive = getInstanceKey('telegram_webhook_active') === 'true';

        // Fallback: if no vault org, try env
        if (!defaultOrgId) {
            defaultOrgId = process.env.DEFAULT_ORG_ID || '';
            // Last resort: first org in the system
            if (!defaultOrgId) {
                const firstOrg = db.prepare('SELECT id FROM orgs WHERE deleted_at IS NULL LIMIT 1').get();
                defaultOrgId = firstOrg?.id || '';
            }
        }

        res.json({
            bot_token: botToken,
            webhook_secret: webhookSecret,
            bot_username: botUsername,
            default_org_id: defaultOrgId,
            default_agent: defaultAgent,
            webhook_url: webhookUrl,
            webhook_active: webhookActive,
            has_token: !!botToken
        });
    } catch (error) {
        console.error('[Inbox/Internal] Telegram webhook config error:', error);
        res.status(500).json({ error: 'Failed to load telegram webhook config' });
    }
});

/**
 * PUT /api/internal/telegram-webhook-config
 * Store webhook registration state after successful Telegram setWebhook.
 * Called by collector's /webhook/telegram/setup endpoint.
 */
internalRouter.put('/telegram-webhook-config', async (req, res) => {
    try {
        const { webhook_url, webhook_secret, bot_username, webhook_active } = req.body;
        const db = getDb();

        const upsert = (key, value) => {
            if (value === undefined) return;
            const existing = db.prepare('SELECT key FROM instance_config WHERE key = ?').get(key);
            if (existing) {
                db.prepare('UPDATE instance_config SET value = ?, updated_at = datetime(\'now\') WHERE key = ?')
                    .run(String(value), key);
            } else {
                db.prepare('INSERT INTO instance_config (key, value, value_type, description) VALUES (?, ?, ?, ?)')
                    .run(key, String(value), 'string', `Telegram webhook config: ${key}`);
            }
        };

        upsert('telegram_webhook_url', webhook_url);
        upsert('telegram_webhook_active', webhook_active ? 'true' : 'false');
        if (bot_username) upsert('telegram_bot_username', bot_username);
        if (webhook_secret) {
            // Store encrypted
            const existing = db.prepare('SELECT key FROM instance_config WHERE key = ?').get('telegram_webhook_secret');
            if (existing) {
                const { encrypt } = await import('../utils/encryption.js');
                db.prepare('UPDATE instance_config SET value = ?, encrypted = 1, updated_at = datetime(\'now\') WHERE key = ?')
                    .run(encrypt(webhook_secret), 'telegram_webhook_secret');
            } else {
                const { encrypt } = await import('../utils/encryption.js');
                db.prepare('INSERT INTO instance_config (key, value, value_type, encrypted, description) VALUES (?, ?, ?, 1, ?)')
                    .run('telegram_webhook_secret', encrypt(webhook_secret), 'string', 'Telegram webhook secret token');
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Inbox/Internal] Telegram webhook config save error:', error);
        res.status(500).json({ error: 'Failed to save telegram webhook config' });
    }
});

// ========================================================================
// Slack Internal Endpoints (Stream D — Events API)
// ========================================================================

/**
 * GET /api/internal/slack-user-lookup?user_id=U12345[&org_id=X]
 * Resolve Slack user to Quox user via notification_channels table.
 */
internalRouter.get('/slack-user-lookup', async (req, res) => {
    try {
        const { user_id, org_id } = req.query;
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const db = getDb();
        let sql = `
            SELECT nc.user_id, nc.org_id, u.display_name, u.email
            FROM notification_channels nc
            JOIN users u ON u.id = nc.user_id
            WHERE nc.channel_type = 'slack'
              AND json_extract(nc.config_json, '$.slackUserId') = ?
        `;
        const params = [user_id];

        if (org_id) {
            sql += ` AND nc.org_id = ?`;
            params.push(org_id);
        }
        sql += ` LIMIT 1`;

        const row = db.prepare(sql).get(...params);
        if (row) {
            res.json({ user: { user_id: row.user_id, org_id: row.org_id, display_name: row.display_name } });
        } else {
            res.json({ user: null });
        }
    } catch (error) {
        console.error('[Inbox/Internal] Slack user lookup error:', error);
        res.status(500).json({ error: 'Failed to look up Slack user' });
    }
});

/**
 * GET /api/internal/slack-webhook-config
 * Returns config needed by the collector Slack webhook handler.
 * Resolves from vault (integration_credentials) and instance_config.
 */
internalRouter.get('/slack-webhook-config', async (req, res) => {
    try {
        const db = getDb();

        // 1. Resolve bot token from vault
        let botToken = null;
        let signingSecret = null;
        let defaultOrgId = null;

        try {
            const credRow = db.prepare(`
                SELECT ic.id, ic.org_id, ic.ciphertext
                FROM integration_credentials ic
                WHERE ic.integration_type = 'slack'
                  AND ic.is_default = 1
                ORDER BY ic.created_at ASC LIMIT 1
            `).get();

            if (credRow) {
                const { decrypt } = await import('../utils/encryption.js');
                const creds = JSON.parse(decrypt(credRow.ciphertext));
                botToken = creds.bot_token || null;
                signingSecret = creds.signing_secret || null;
                defaultOrgId = credRow.org_id;

                db.prepare('UPDATE integration_credentials SET last_used_at = datetime(\'now\') WHERE id = ?')
                    .run(credRow.id);
            }
        } catch (err) {
            console.warn('[Slack Config] Vault lookup failed:', err.message);
        }

        if (!botToken) botToken = process.env.SLACK_BOT_TOKEN || null;
        if (!signingSecret) signingSecret = process.env.SLACK_SIGNING_SECRET || null;

        // 2. Instance config keys
        const getInstanceKey = (key) => {
            try {
                const row = db.prepare('SELECT value, encrypted FROM instance_config WHERE key = ?').get(key);
                if (!row?.value) return null;
                if (row.encrypted) {
                    const { decrypt } = require('../utils/encryption.js');
                    return decrypt(row.value);
                }
                return row.value;
            } catch { return null; }
        };

        const botUsername = getInstanceKey('slack_bot_username') || '';
        const defaultAgent = getInstanceKey('slack_default_agent') || 'quox';
        const webhookUrl = getInstanceKey('slack_webhook_url') || '';
        const webhookActive = getInstanceKey('slack_webhook_active') === 'true';
        const team = getInstanceKey('slack_team') || '';

        if (!defaultOrgId) {
            defaultOrgId = process.env.DEFAULT_ORG_ID || '';
            if (!defaultOrgId) {
                const firstOrg = db.prepare('SELECT id FROM orgs WHERE deleted_at IS NULL LIMIT 1').get();
                defaultOrgId = firstOrg?.id || '';
            }
        }

        res.json({
            bot_token: botToken,
            signing_secret: signingSecret,
            bot_username: botUsername,
            default_org_id: defaultOrgId,
            default_agent: defaultAgent,
            webhook_url: webhookUrl,
            webhook_active: webhookActive,
            team,
            has_token: !!botToken
        });
    } catch (error) {
        console.error('[Inbox/Internal] Slack webhook config error:', error);
        res.status(500).json({ error: 'Failed to load slack webhook config' });
    }
});

/**
 * PUT /api/internal/slack-webhook-config
 * Store webhook registration state.
 */
internalRouter.put('/slack-webhook-config', async (req, res) => {
    try {
        const { webhook_url, bot_username, webhook_active, team } = req.body;
        const db = getDb();

        const upsert = (key, value) => {
            if (value === undefined) return;
            const existing = db.prepare('SELECT key FROM instance_config WHERE key = ?').get(key);
            if (existing) {
                db.prepare('UPDATE instance_config SET value = ?, updated_at = datetime(\'now\') WHERE key = ?')
                    .run(String(value), key);
            } else {
                db.prepare('INSERT INTO instance_config (key, value, value_type, description) VALUES (?, ?, ?, ?)')
                    .run(key, String(value), 'string', `Slack webhook config: ${key}`);
            }
        };

        upsert('slack_webhook_url', webhook_url);
        upsert('slack_webhook_active', webhook_active ? 'true' : 'false');
        if (bot_username) upsert('slack_bot_username', bot_username);
        if (team) upsert('slack_team', team);

        res.json({ success: true });
    } catch (error) {
        console.error('[Inbox/Internal] Slack webhook config save error:', error);
        res.status(500).json({ error: 'Failed to save slack webhook config' });
    }
});

// ========================================================================
// Discord internal endpoints
// ========================================================================

/**
 * GET /api/internal/discord-user-lookup?user_id=123456[&org_id=X]
 * Resolve Discord user to Quox user via notification_channels table.
 */
internalRouter.get('/discord-user-lookup', async (req, res) => {
    try {
        const { user_id, org_id } = req.query;
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const db = getDb();
        let sql = `
            SELECT nc.user_id, nc.org_id, u.display_name, u.email
            FROM notification_channels nc
            JOIN users u ON u.id = nc.user_id
            WHERE nc.channel_type = 'discord'
              AND json_extract(nc.config_json, '$.discordUserId') = ?
        `;
        const params = [user_id];

        if (org_id) {
            sql += ` AND nc.org_id = ?`;
            params.push(org_id);
        }
        sql += ` LIMIT 1`;

        const row = db.prepare(sql).get(...params);
        if (row) {
            res.json({ user: { user_id: row.user_id, org_id: row.org_id, display_name: row.display_name } });
        } else {
            res.json({ user: null });
        }
    } catch (error) {
        console.error('[Inbox/Internal] Discord user lookup error:', error);
        res.status(500).json({ error: 'Failed to look up Discord user' });
    }
});

/**
 * GET /api/internal/discord-webhook-config
 * Returns config needed by the collector Discord webhook handler.
 * Resolves from vault (integration_credentials) and instance_config.
 */
internalRouter.get('/discord-webhook-config', async (req, res) => {
    try {
        const db = getDb();

        let botToken = null;
        let publicKey = null;
        let applicationId = null;
        let defaultOrgId = null;

        try {
            const credRow = db.prepare(`
                SELECT ic.id, ic.org_id, ic.ciphertext
                FROM integration_credentials ic
                WHERE ic.integration_type = 'discord'
                  AND ic.is_default = 1
                ORDER BY ic.created_at ASC LIMIT 1
            `).get();

            if (credRow) {
                const { decrypt } = await import('../utils/encryption.js');
                const creds = JSON.parse(decrypt(credRow.ciphertext));
                botToken = creds.bot_token || null;
                publicKey = creds.public_key || null;
                applicationId = creds.application_id || null;
                defaultOrgId = credRow.org_id;

                db.prepare('UPDATE integration_credentials SET last_used_at = datetime(\'now\') WHERE id = ?')
                    .run(credRow.id);
            }
        } catch (err) {
            console.warn('[Discord Config] Vault lookup failed:', err.message);
        }

        if (!botToken) botToken = process.env.DISCORD_BOT_TOKEN || null;
        if (!publicKey) publicKey = process.env.DISCORD_PUBLIC_KEY || null;
        if (!applicationId) applicationId = process.env.DISCORD_APPLICATION_ID || null;

        const getInstanceKey = (key) => {
            try {
                const row = db.prepare('SELECT value, encrypted FROM instance_config WHERE key = ?').get(key);
                if (!row?.value) return null;
                if (row.encrypted) {
                    const { decrypt } = require('../utils/encryption.js');
                    return decrypt(row.value);
                }
                return row.value;
            } catch { return null; }
        };

        const botUsername = getInstanceKey('discord_bot_username') || '';
        const defaultAgent = getInstanceKey('discord_default_agent') || 'quox';
        const webhookActive = getInstanceKey('discord_webhook_active') === 'true';

        if (!defaultOrgId) {
            defaultOrgId = process.env.DEFAULT_ORG_ID || '';
            if (!defaultOrgId) {
                const firstOrg = db.prepare('SELECT id FROM orgs WHERE deleted_at IS NULL LIMIT 1').get();
                defaultOrgId = firstOrg?.id || '';
            }
        }

        res.json({
            bot_token: botToken,
            public_key: publicKey,
            application_id: applicationId,
            bot_username: botUsername,
            default_org_id: defaultOrgId,
            default_agent: defaultAgent,
            webhook_active: webhookActive,
            has_token: !!botToken
        });
    } catch (error) {
        console.error('[Inbox/Internal] Discord webhook config error:', error);
        res.status(500).json({ error: 'Failed to load discord webhook config' });
    }
});

/**
 * PUT /api/internal/discord-webhook-config
 * Store Discord webhook registration state.
 */
internalRouter.put('/discord-webhook-config', async (req, res) => {
    try {
        const { bot_username, webhook_active, application_id } = req.body;
        const db = getDb();

        const upsert = (key, value) => {
            if (value === undefined) return;
            const existing = db.prepare('SELECT key FROM instance_config WHERE key = ?').get(key);
            if (existing) {
                db.prepare('UPDATE instance_config SET value = ?, updated_at = datetime(\'now\') WHERE key = ?')
                    .run(String(value), key);
            } else {
                db.prepare('INSERT INTO instance_config (key, value, value_type, description) VALUES (?, ?, ?, ?)')
                    .run(key, String(value), 'string', `Discord webhook config: ${key}`);
            }
        };

        upsert('discord_webhook_active', webhook_active ? 'true' : 'false');
        if (bot_username) upsert('discord_bot_username', bot_username);
        if (application_id) upsert('discord_application_id', application_id);

        res.json({ success: true });
    } catch (error) {
        console.error('[Inbox/Internal] Discord webhook config save error:', error);
        res.status(500).json({ error: 'Failed to save discord webhook config' });
    }
});

// ========================================================================
// Generic webhook internal endpoints
// ========================================================================

/**
 * GET /api/internal/webhook-endpoint-config?endpoint_id=xyz
 * Returns config for a generic webhook endpoint.
 * Stored in webhook_endpoints table.
 */
internalRouter.get('/webhook-endpoint-config', async (req, res) => {
    try {
        const { endpoint_id } = req.query;
        if (!endpoint_id) {
            return res.status(400).json({ error: 'endpoint_id is required' });
        }

        const db = getDb();

        // Ensure table exists
        db.exec(`
            CREATE TABLE IF NOT EXISTS webhook_endpoints (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT 'Untitled',
                secret TEXT,
                payload_mapping_json TEXT DEFAULT '{}',
                default_org_id TEXT,
                default_agent TEXT DEFAULT 'quox',
                response_template_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        const row = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(endpoint_id);
        if (!row) {
            return res.status(404).json({ error: 'Endpoint not found' });
        }

        let payloadMapping = {};
        try { payloadMapping = JSON.parse(row.payload_mapping_json || '{}'); } catch {}

        let responseTemplate = null;
        try { if (row.response_template_json) responseTemplate = JSON.parse(row.response_template_json); } catch {}

        // Decrypt secret if it exists
        let secret = row.secret || null;
        if (secret) {
            try {
                const { decrypt } = await import('../utils/encryption.js');
                secret = decrypt(secret);
            } catch {
                // If decryption fails, use as-is (may be plaintext in dev)
            }
        }

        res.json({
            id: row.id,
            name: row.name,
            org_id: row.org_id,
            secret,
            payload_mapping: payloadMapping,
            default_org_id: row.default_org_id || row.org_id,
            default_agent: row.default_agent || 'quox',
            response_template: responseTemplate,
            enabled: !!row.enabled
        });
    } catch (error) {
        console.error('[Inbox/Internal] Webhook endpoint config error:', error);
        res.status(500).json({ error: 'Failed to load webhook endpoint config' });
    }
});

/**
 * GET /api/internal/generic-user-lookup?user_id=X&endpoint_id=Y
 * Resolve an external user ID from a webhook to a Quox user.
 * Looks up notification_channels where channel_type='webhook' and config has matching external ID.
 */
internalRouter.get('/generic-user-lookup', async (req, res) => {
    try {
        const { user_id, endpoint_id } = req.query;
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const db = getDb();
        const row = db.prepare(`
            SELECT nc.user_id, nc.org_id, u.display_name
            FROM notification_channels nc
            JOIN users u ON u.id = nc.user_id
            WHERE nc.channel_type = 'webhook'
              AND json_extract(nc.config_json, '$.externalUserId') = ?
            LIMIT 1
        `).get(user_id);

        if (row) {
            res.json({ user: { user_id: row.user_id, org_id: row.org_id, display_name: row.display_name } });
        } else {
            res.json({ user: null });
        }
    } catch (error) {
        console.error('[Inbox/Internal] Generic user lookup error:', error);
        res.status(500).json({ error: 'Failed to look up generic user' });
    }
});

// ========================================================================
// Authenticated routes below
// ========================================================================

router.use(requireAuth);

/**
 * POST /api/orgs/:orgId/inbox/auto-resolve (authenticated)
 * P0b step 6a: the frontend health check (serviceAlertBridge) used to call
 * the INTERNAL auto-resolve route, which was already dead in prod (nginx's
 * /api/ catch-all 404s /api/internal) and is now service-key gated. This is
 * its real home: same narrow semantics (service_monitor incidents only,
 * never approvals), org membership required, reachable through nginx's
 * /api/orgs location.
 */
router.post('/orgs/:orgId/inbox/auto-resolve', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { service_keys } = req.body;

        if (!Array.isArray(service_keys) || service_keys.length === 0) {
            return res.status(400).json({ error: 'service_keys array is required' });
        }

        res.json({ resolved: autoResolveServiceAlerts(getDb(), orgId, service_keys) });
    } catch (error) {
        console.error('[Inbox] Auto-resolve error:', error);
        res.status(500).json({ error: 'Failed to auto-resolve alerts' });
    }
});

// Item statuses
const ITEM_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'cancelled', 'expired'];

// Priorities
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * Ensure user has a personal inbox in the org
 */
function ensurePersonalInbox(orgId, userId) {
    const existing = prepare(`
        SELECT id FROM inboxes
        WHERE org_id = ? AND owner_id = ? AND inbox_type = 'personal'
    `).get(orgId, userId);

    if (existing) {
        return existing.id;
    }

    const inboxId = ulid();
    prepare(`
        INSERT INTO inboxes (id, org_id, inbox_type, name, owner_id)
        VALUES (?, ?, 'personal', 'Personal Inbox', ?)
    `).run(inboxId, orgId, userId);

    return inboxId;
}

/**
 * Blocker 2 (route-authz): being a member of an org is not authority over a
 * specific inbox item. A user may read or act on an item only when they can
 * SEE it, using the SAME visibility rule as the list route: org owners/admins
 * see every item; everyone else only items in their own personal inbox or
 * items assigned to them. Centralised here so every decision, state-change and
 * detail path enforces one identical predicate rather than trusting membership
 * alone. `membership` is req.orgMembership (set by requireOrgMembership).
 */
function userCanAccessItem(item, orgId, userId, membership) {
    if (!item) return false;
    if (membership && ['owner', 'admin'].includes(membership.role)) return true;
    // quox#638: the user who filed the item (e.g. the agent that ran x_post)
    // can always READ what it created, so the inbox_item_id it was handed back
    // is resolvable. This is visibility only — approval authority is enforced
    // separately (isApprovalAssignee || isOrgAdminOrOwner) on the respond path.
    if (item.created_by && item.created_by === userId) return true;
    if (item.inbox_id && item.inbox_id === ensurePersonalInbox(orgId, userId)) return true;
    const assigned = prepare(`
        SELECT 1 FROM inbox_item_assignees
        WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        LIMIT 1
    `).get(item.id, userId);
    return !!assigned;
}

/**
 * TASK-546 (declared-approver enforcement): kind === 'approval' items carry
 * no persisted "declared approvers" list — the collector's approvalGate.js
 * mint writes only type/toolName/action/targetId onto payload_json, never a
 * roster of who may decide it. So approval authority is enforced by ROLE,
 * not a literal list: an assignee of the item, or an org admin/owner.
 * userCanAccessItem() above is intentionally BROADER (visibility, not
 * authority) — it also grants the personal-inbox OWNER even when they are
 * no longer an assignee (e.g. after /reassign moved the item to someone
 * else, the original inbox owner keeps visibility but must not keep
 * approval authority). Both the single respond handler and the bulk
 * approve/deny path must pass this check IN ADDITION to userCanAccessItem
 * for kind === 'approval' items.
 */
function isApprovalAssignee(itemId, userId) {
    return !!prepare(`
        SELECT 1 FROM inbox_item_assignees
        WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        LIMIT 1
    `).get(itemId, userId);
}

function isOrgAdminOrOwner(membership) {
    return !!(membership && ['owner', 'admin'].includes(membership.role));
}

/**
 * A tool approval answered after its lifetime: the collector refused to run it.
 * Flip the card from resolved to expired, recording why, so the approver (and
 * the respond response) see the truth instead of a silent "approved".
 */
const APPROVAL_EXPIRED_MESSAGE = 'This approval had expired, so nothing ran. Ask the agent again to get a fresh one.';
function markToolApprovalExpired(itemId, out = {}) {
    try {
        getDb().prepare(`
            UPDATE inbox_items
            SET status = 'expired',
                response_json = json_set(COALESCE(response_json, '{}'), '$.outcome', 'expired', '$.outcome_message', ?, '$.age_ms', ?, '$.max_age_ms', ?)
            WHERE id = ?
        `).run(APPROVAL_EXPIRED_MESSAGE, Number(out.ageMs) || null, Number(out.maxAgeMs) || null, itemId);
    } catch (err) {
        console.error('[Inbox/ToolApproval] could not mark expired card:', err.message);
    }
}

/**
 * applyResponseSideEffects — the FULL post-resolve side-effect chain for an
 * inbox response (approve/deny/request_changes/etc.), extracted from the
 * single-item POST .../respond handler so BOTH that handler and the bulk
 * POST .../bulk approve/deny loop run IDENTICAL side effects per item
 * (TASK bulk-full-parity). Previously bulk only ran VOLT witness + QuoxFlow
 * resume (lib/approvalSideEffects.js resolveApprovalSideEffects) and
 * silently skipped every other bridge below — a bulk "approve" could hide
 * the card from the inbox while the governed action never actually ran and
 * was never witnessed.
 *
 * Call this AFTER the item's `inbox_items.status` row is already committed
 * 'resolved' — the resolve UPDATE itself stays in the caller (transactional
 * there); everything here is fire-and-forget / best-effort per item and
 * never throws back to the caller. A bridge that can silently fail to
 * deliver a governed decision (the generic callback_url dispatch) mints an
 * incident item rather than letting the approval look successful while
 * nothing downstream ran.
 *
 * @param {object} item - an inbox_items row: needs id, org_id, kind, run_id,
 *   payload_json, quoxflow_execution_id, tasks_objective_id, aee_correlation_id
 * @param {{action:string, comment?:string, data?:object}} response
 * @param {import('express').Request} req - for req.user (actor identity)
 */
async function applyResponseSideEffects(item, { action, comment, data } = {}, req) {
    const orgId = item.org_id;
    const itemId = item.id;
    const userId = req.user.id;
    const isRequestChanges = action === 'request_changes';
    const approver = req.user.primary_email || req.user.display_name || userId;

    // Update assignee record (mark responded) if the caller is an assignee.
    try {
        const assignee = prepare(`
            SELECT * FROM inbox_item_assignees
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).get(itemId, userId);
        if (assignee) {
            prepare(`
                UPDATE inbox_item_assignees
                SET status = 'responded', responded_at = datetime('now'), response_json = ?
                WHERE id = ?
            `).run(JSON.stringify({ action, comment }), assignee.id);
        }
    } catch (err) {
        console.error('[Inbox/SideEffects] assignee update error (non-fatal):', err.message);
    }

    // If linked to a run, create human_responded event
    if (item.run_id) {
        try {
            prepare(`
                INSERT INTO run_events (id, run_id, event_type, payload_json)
                VALUES (?, ?, 'human_responded', ?)
            `).run(ulid(), item.run_id, JSON.stringify({
                inbox_item_id: itemId,
                action,
                data
            }));
        } catch (err) {
            console.error('[Inbox/SideEffects] run_events insert error (non-fatal):', err.message);
        }
    }

    // HITL-VOLT-WITNESS (QuoxPlan #2202): witness the approval decision in
    // VOLT, reliably (queued + retried on failure — jobs/volt-witness-reaper.js).
    if (item.kind === 'approval' && !isRequestChanges) {
        try {
            await emitApprovalVoltWitness({
                orgId,
                itemId,
                decision: isApproveAction(action) ? 'granted' : 'denied',
                actor: approver,
                comment,
            });
        } catch (err) {
            console.error('[Inbox/VOLT] unexpected witness error (non-fatal):', err.message);
        }
    }

    // Parse payload once — reused by every branch below.
    let payload = null;
    try {
        payload = item.payload_json ? JSON.parse(item.payload_json) : null;
    } catch { /* malformed payload — ignore, treated as no special payload */ }

    // AGENT-STANDING: correction/override event source. Only autonomy
    // escalations carry this shape (payload.source === 'autonomy_escalation').
    if (item.kind === 'approval' && payload?.source === 'autonomy_escalation' && payload.agent_id) {
        const standingEventType = isRequestChanges ? 'correction' : (isDenyAction(action) ? 'override' : null);
        if (standingEventType) {
            const tasksUrl = process.env.TASKS_SERVICE_URL || 'http://tasks:3104';
            (async () => {
                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10000);
                    const standingRes = await fetch(`${tasksUrl}/api/internal/agent-standing/event`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                        },
                        body: JSON.stringify({
                            org_id: orgId,
                            agent_id: payload.agent_id,
                            task_class: payload.task_class,
                            event_type: standingEventType,
                            task_id: payload.task_id,
                            objective_id: payload.objective_id,
                            actor: approver,
                            reason: comment || `${standingEventType} via HITL inbox item ${itemId}`,
                        }),
                        signal: controller.signal
                    });
                    clearTimeout(timeout);
                    if (!standingRes.ok) {
                        const errBody = await standingRes.text().catch(() => '');
                        console.error(`[Inbox/AgentStanding] Event write failed (${standingRes.status}):`, errBody);
                    } else {
                        console.log(`[Inbox/AgentStanding] Recorded ${standingEventType} for agent=${payload.agent_id} item=${itemId}`);
                    }
                } catch (err) {
                    console.error('[Inbox/AgentStanding] Event write error:', err.message);
                }
            })();
        }
    }

    // HV2-1/HV2-2: If linked to a QuoxFlow execution, resume the paused workflow
    if (item.quoxflow_execution_id && /^[A-Z0-9]{26}$/i.test(item.quoxflow_execution_id)) {
        const quoxflowUrl = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
        const approved = !isRequestChanges && isApproveAction(action);
        const resumePayload = {
            approved,
            approver,
            reason: comment || undefined,
            ...(isRequestChanges ? { requestChanges: true } : {}),
            ...(data ? { data } : {})
        };

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const resumeRes = await fetch(`${quoxflowUrl}/api/executions/${item.quoxflow_execution_id}/resume`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify(resumePayload),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!resumeRes.ok) {
                const errBody = await resumeRes.text();
                console.error(`[Inbox/HV2] QuoxFlow resume failed (${resumeRes.status}):`, errBody);
                // F09 (GOVERNANCE, mirrors quox#529): the human's decision already
                // resolved this item, but the paused workflow was never actually
                // resumed. Mint an incident so that failure is surfaced durably
                // instead of living only in a console.error line.
                mintIncidentItem(orgId, {
                    title: `QuoxFlow resume FAILED to deliver: ${item.title || itemId}`,
                    body_md: `This inbox item was **${approved ? 'approved' : 'denied'}**, but resuming the linked QuoxFlow execution failed, so the paused workflow is still paused.\n\n` +
                        `- Execution: \`${item.quoxflow_execution_id}\`\n` +
                        `- Status: ${resumeRes.status}\n` +
                        `- Error: ${String(errBody || 'unknown').slice(0, 500)}\n\n` +
                        `Re-check the workflow execution and resume it manually if it did not take effect.`,
                    payload: {
                        source: 'quoxflow_resume_failure',
                        original_item_id: itemId,
                        quoxflow_execution_id: item.quoxflow_execution_id,
                        status: resumeRes.status,
                        error: errBody ? String(errBody).slice(0, 500) : null,
                    },
                });
            } else {
                const action_label = isRequestChanges ? 'request_changes' : (approved ? 'approved' : 'denied');
                console.log(`[Inbox/HV2] QuoxFlow execution ${item.quoxflow_execution_id} resumed (action=${action_label})`);
            }
        } catch (err) {
            console.error('[Inbox/HV2] QuoxFlow resume error:', err.message);
            // F09: network error / timeout reaching QuoxFlow is just as much a
            // failed delivery as a non-2xx response — surface it the same way.
            mintIncidentItem(orgId, {
                title: `QuoxFlow resume FAILED to deliver: ${item.title || itemId}`,
                body_md: `This inbox item was **${approved ? 'approved' : 'denied'}**, but resuming the linked QuoxFlow execution errored, so the paused workflow is still paused.\n\n` +
                    `- Execution: \`${item.quoxflow_execution_id}\`\n` +
                    `- Error: ${String(err.message || err).slice(0, 500)}\n\n` +
                    `Re-check the workflow execution and resume it manually if it did not take effect.`,
                payload: {
                    source: 'quoxflow_resume_failure',
                    original_item_id: itemId,
                    quoxflow_execution_id: item.quoxflow_execution_id,
                    status: null,
                    error: err?.message ? String(err.message).slice(0, 500) : null,
                },
            });
        }
    }

    // VAULT-P5.I (F4) — HITL inbox wiring for credential leases.
    if (payload?.type === 'credential_lease' && payload.lease_id) {
        const lease = getLeaseById(payload.lease_id);
        if (lease && lease.org_id === orgId && lease.inbox_item_id === itemId && lease.status === 'pending') {
            if (isApproveAction(action)) {
                const cred = getCredentialById(lease.credential_id);
                const durationMinutes = cred?.lease_max_duration_minutes || DEFAULT_INBOX_APPROVED_LEASE_MINUTES;
                approveLease(lease.id, userId, durationMinutes);
                clearResolverCache();
            } else if (isDenyAction(action) || isRequestChanges) {
                denyLease(lease.id, userId);
            }
            // else: unrecognised action, leave the lease pending
        }
    }

    // HV2-3 Phase 4b: If linked to a tasks service objective, resume/abort it
    if (item.tasks_objective_id) {
        const tasksUrl = process.env.TASKS_SERVICE_URL || 'http://tasks:3104';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const resumeRes = await fetch(`${tasksUrl}/api/internal/objectives/${item.tasks_objective_id}/resume`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify({ action, comment: comment || '' }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!resumeRes.ok) {
                const errBody = await resumeRes.text();
                console.error(`[Inbox/HITL] Tasks resume failed (${resumeRes.status}):`, errBody);
            } else {
                console.log(`[Inbox/HITL] Objective ${item.tasks_objective_id} ${action} via inbox`);
            }
        } catch (err) {
            console.error('[Inbox/HITL] Tasks resume error:', err.message);
        }
    }

    // QLUSTER-LOOP-B Phase 6: delegated qluster chat resume
    const isQlusterDelegation = payload?.type === 'qluster_delegation'
        || /^QDEL_/.test(item.aee_correlation_id || '');
    if (isQlusterDelegation && item.aee_correlation_id) {
        const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const resumeRes = await fetch(`${collectorUrl}/api/internal/qluster/delegate/resume`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify({
                    corr: item.aee_correlation_id,
                    inbox_item_id: itemId,
                    action,
                    approver: userId,
                    org_id: orgId
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!resumeRes.ok) {
                const errBody = await resumeRes.text();
                console.error(`[Inbox/Qluster] Delegate resume failed (${resumeRes.status}):`, errBody);
            } else {
                console.log(`[Inbox/Qluster] Delegation ${item.aee_correlation_id} resumed (action=${action})`);
            }
        } catch (err) {
            console.error('[Inbox/Qluster] Delegate resume error:', err.message);
        }
    }

    // HITL approve→execute bridge: native-tool approval gate resume.
    const isNativeToolApproval = payload?.type === 'native_tool_approval';
    if (isNativeToolApproval && item.aee_correlation_id) {
        const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const resumeRes = await fetch(`${collectorUrl}/api/internal/tools/resume`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify({
                    approvalId: item.aee_correlation_id,
                    action,
                    approver: userId,
                    // The responder's org role, verified by requireOrgMembership. The collector
                    // uses it only to NARROW what an approved executor lends (never to authorise).
                    approver_role: req?.orgMembership?.role || null,
                    org_id: orgId,
                    // TRUST-PROOF HITL E2E fix: the collector threads this onto
                    // ctx.hitlApprovedItemId to mint the X-Bastion-Approval-Grant
                    // bound to the item the human just approved.
                    inbox_item_id: itemId
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!resumeRes.ok) {
                const errBody = await resumeRes.text();
                console.error(`[Inbox/ToolApproval] Resume failed (${resumeRes.status}):`, errBody);
            } else {
                const out = await resumeRes.json().catch(() => ({}));
                if (out && out.status === 'expired') {
                    // The collector refused a stale approval (toolResume.js T-AUTH expiry), so
                    // NOTHING ran. Never leave the card saying approved (live 2026-10-10: a
                    // NotesQ save approved at 84 min looked done and was not).
                    markToolApprovalExpired(itemId, out);
                    console.warn(`[Inbox/ToolApproval] Approval ${item.aee_correlation_id} EXPIRED before it was approved; not executed`);
                } else {
                    console.log(`[Inbox/ToolApproval] Approval ${item.aee_correlation_id} resumed (action=${action})`);
                }
            }
        } catch (err) {
            console.error('[Inbox/ToolApproval] Resume error:', err.message);
        }
    }

    // QUOXHAT P5: agent-proposed hat switch (hat_propose_switch). The human
    // clicking approve IN THE INBOX is the explicit confirmation the hat's
    // transitions.confirm requires — the switch applies HERE, in-process
    // (same service that owns quoxhat_bindings), never by the agent. Deny or
    // any non-approve action leaves the binding untouched. The bind itself
    // is audited (quoxhat.binding.selected) with the approver as actor; a
    // switch resets progressive-disclosure state (P4).
    const isQuoxhatSwitch = payload?.type === 'quoxhat_switch_proposal' && payload?.target_hat && payload?.conversation_id;
    if (isQuoxhatSwitch && isApproveAction(action)) {
        try {
            const { listHats, bindConversationHat } = await import('./quoxhatStore.js');
            const hats = listHats(orgId, userId);
            const target = hats.find(h => h.key === payload.target_hat);
            if (!target) {
                console.warn(`[Inbox/QuoxHat] approved switch to unknown hat '${payload.target_hat}' (org=${orgId}) — not applied`);
            } else {
                const bound = bindConversationHat({
                    orgId,
                    userId,
                    conversationId: payload.conversation_id,
                    hatId: target.id,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
                if (bound.ok) {
                    console.log(`[Inbox/QuoxHat] switch applied: conversation=${payload.conversation_id} -> hat=${payload.target_hat} rev=${bound.binding.revision} (approver=${userId})`);
                } else {
                    console.warn(`[Inbox/QuoxHat] switch apply failed: ${bound.errors?.join('; ')}`);
                }
            }
        } catch (err) {
            console.error('[Inbox/QuoxHat] switch apply error:', err.message);
        }
    }

    // QUOXPLAN-HITLFIX: fire the collector's decide callback for QuoxPlan items.
    const isQuoxplanCallback = payload?.source === 'quoxplan' && typeof payload?.callback_url === 'string';
    if (isQuoxplanCallback) {
        const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
        const quoxplanAction = isApproveAction(action) ? 'approve' : 'deny';
        // TRULY fire-and-forget: the inbox item is already resolved, so the
        // approve click must return immediately.
        (async () => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);
                const decideRes = await fetch(`${collectorUrl}${payload.callback_url}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                    },
                    body: JSON.stringify({
                        inbox_item_id: itemId,
                        action: quoxplanAction,
                        approver,
                        reason: comment,
                        action_params: payload.action_params
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (!decideRes.ok) {
                    const errBody = await decideRes.text().catch(() => '');
                    console.error(`[Inbox/QuoxPlan] Decide callback failed (${decideRes.status}):`, errBody);
                    // F09 (GOVERNANCE, mirrors quox#529): this branch is truly
                    // fire-and-forget by design so the approve click returns
                    // immediately, but a failed delivery must still be surfaced
                    // durably, not confined to a console.error line nobody reads.
                    mintIncidentItem(orgId, {
                        title: `QuoxPlan decide callback FAILED to deliver: ${item.title || itemId}`,
                        body_md: `This inbox item was **${quoxplanAction === 'deny' ? 'denied' : 'approved'}**, but delivering that decision to QuoxPlan failed, so the governed action may not have run.\n\n` +
                            `- Callback: \`${payload.callback_url}\`\n` +
                            `- Status: ${decideRes.status}\n` +
                            `- Error: ${String(errBody || 'unknown').slice(0, 500)}\n\n` +
                            `Re-check the original item in QuoxPlan and re-run the action if it did not take effect.`,
                        payload: {
                            source: 'quoxplan_decide_callback_failure',
                            original_item_id: itemId,
                            callback_url: payload.callback_url,
                            dispatch_action: quoxplanAction,
                            status: decideRes.status,
                            error: errBody ? String(errBody).slice(0, 500) : null,
                        },
                    });
                } else {
                    console.log(`[Inbox/QuoxPlan] Decide callback dispatched for item ${itemId} (action=${quoxplanAction})`);
                }
            } catch (err) {
                console.error('[Inbox/QuoxPlan] Decide callback error:', err.message);
                mintIncidentItem(orgId, {
                    title: `QuoxPlan decide callback FAILED to deliver: ${item.title || itemId}`,
                    body_md: `This inbox item was **${quoxplanAction === 'deny' ? 'denied' : 'approved'}**, but delivering that decision to QuoxPlan errored, so the governed action may not have run.\n\n` +
                        `- Callback: \`${payload.callback_url}\`\n` +
                        `- Error: ${String(err.message || err).slice(0, 500)}\n\n` +
                        `Re-check the original item in QuoxPlan and re-run the action if it did not take effect.`,
                    payload: {
                        source: 'quoxplan_decide_callback_failure',
                        original_item_id: itemId,
                        callback_url: payload.callback_url,
                        dispatch_action: quoxplanAction,
                        status: null,
                        error: err?.message ? String(err.message).slice(0, 500) : null,
                    },
                });
            }
        })();
    }

    // STREAM WAZ v2 GAP 1: generic approve->execute bridge via callback_url.
    if (item.kind === 'approval' && !isRequestChanges && payload?.source !== 'quoxplan' && typeof payload?.callback_url === 'string') {
        const isExplicitDeny = isDenyAction(action);
        const dispatchAction = isExplicitDeny ? 'deny' : 'approve';
        const dispatchCallbackUrl = payload.callback_url;
        dispatchApprovalCallback(item, dispatchCallbackUrl, dispatchAction, {
            approver,
            reason: comment,
            actionParams: payload.action_params,
        }).then((result) => {
            // GOVERNANCE FIX (quox#529): dispatchApprovalCallback RESOLVES
            // {ok:false,...} on failure/timeout, it never rejects — a human
            // must not see "resolved" while the governed plugin action never
            // ran. Mint an incident so the failure is surfaced.
            if (!result || !result.ok) {
                mintIncidentItem(orgId, {
                    title: `Approval callback FAILED to deliver: ${item.title || itemId}`,
                    body_md: `This inbox item was **${dispatchAction === 'deny' ? 'denied' : 'approved'}**, but delivering that decision to the plugin callback failed, so the governed action may not have run.\n\n` +
                        `- Callback: \`${dispatchCallbackUrl}\`\n` +
                        `- Status: ${result?.status ?? 'n/a'}\n` +
                        `- Error: ${result?.error ? String(result.error).slice(0, 500) : 'unknown'}\n\n` +
                        `Re-check the original item and re-run the action if it did not take effect.`,
                    payload: {
                        source: 'approval_callback_failure',
                        original_item_id: itemId,
                        callback_url: dispatchCallbackUrl,
                        dispatch_action: dispatchAction,
                        status: result?.status ?? null,
                        error: result?.error ?? null,
                    },
                });
            }
        }).catch((err) => {
            console.error('[Inbox/ApprovalCallback] unexpected dispatch error (non-fatal):', err.message);
        });
    }

    // CORECOMMS-LOOP: fan a human's reply text back through the origin channel.
    const channelOrigin = resolveChannelOrigin(payload);
    const channelReplyText = typeof comment === 'string' ? comment.trim() : '';
    if (channelOrigin && channelReplyText) {
        const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const replyRes = await fetch(`${collectorUrl}/api/internal/channels/reply`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
                },
                body: JSON.stringify({
                    item_id: itemId,
                    org_id: orgId,
                    channel_type: channelOrigin.channelType,
                    external_id: channelOrigin.externalId,
                    text: channelReplyText
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!replyRes.ok) {
                const errBody = await replyRes.text();
                console.error(`[Inbox/ChannelReply] Dispatch failed (${replyRes.status}):`, errBody);
            } else {
                console.log(`[Inbox/ChannelReply] Dispatched reply for item ${itemId} to ${channelOrigin.channelType}:${channelOrigin.externalId}`);
            }
        } catch (err) {
            console.error('[Inbox/ChannelReply] Dispatch error:', err.message);
        }
    }

    // Emit real-time event for SSE clients
    emitItemResponded(orgId, itemId, action, userId);
}

/**
 * mintIncidentItem — GOVERNANCE FIX (quox#529): the generic approval-callback
 * bridge (STREAM WAZ v2 GAP 1, below) fires a plugin's decide callback
 * fire-and-forget. dispatchApprovalCallback() RESOLVES {ok:false,...} on
 * failure/timeout rather than throwing, so a bare .catch() on that call never
 * saw a failed dispatch — a human saw the item "resolved" while the governed
 * action (Wazuh deploy/remove, QuoxPlan-shaped future consumers, any plugin
 * that carries a callback_url) may never have run. This mints an
 * `incident`-kind item so the failure is surfaced, mirroring the already-shipped
 * native-tool approve->execute bridge's notifyResumeFailure()
 * (services/collector/lib/toolResume.js). Assigns to every org owner/admin,
 * the same targeting as the internal POST /orgs/:orgId/inbox route above.
 * Returns null (no-op, logged) if the org has no owner/admin to notify.
 */
function mintIncidentItem(orgId, { title, body_md, payload }) {
    const owners = prepare(`
        SELECT user_id FROM org_memberships WHERE org_id = ? AND role IN ('owner', 'admin')
    `).all(orgId);
    const targetUserIds = owners.map(o => o.user_id);
    if (targetUserIds.length === 0) {
        console.error(`[Inbox/Incident] No owner/admin to notify for org ${orgId}: ${title}`);
        return null;
    }

    const primaryUserId = targetUserIds[0];
    const targetInboxId = ensurePersonalInbox(orgId, primaryUserId);
    const itemId = ulid();

    prepare(`
        INSERT INTO inbox_items (
            id, org_id, inbox_id, kind, priority, title, body_md,
            payload_json, created_by
        ) VALUES (?, ?, ?, 'incident', 'high', ?, ?, ?, NULL)
    `).run(itemId, orgId, targetInboxId, title, body_md || null, JSON.stringify(payload || {}));

    for (const userId of targetUserIds) {
        prepare(`
            INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
            VALUES (?, ?, 'user', ?, 'anyone')
        `).run(ulid(), itemId, userId);
    }

    const createdItem = {
        id: itemId,
        org_id: orgId,
        inbox_id: targetInboxId,
        kind: 'incident',
        status: 'open',
        priority: 'high',
        title
    };

    emitItemCreated(orgId, createdItem);
    emitStatsUpdate(orgId);

    return createdItem;
}

/**
 * GET /orgs/:orgId/inbox
 * Get user's inbox items (from personal inbox and assigned items)
 */
router.get('/orgs/:orgId/inbox', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { status, kind, priority, page, limit } = req.query;
        const userId = req.user.id;
        const pagination = getPagination({ page, limit });

        // Ensure personal inbox exists
        const personalInboxId = ensurePersonalInbox(orgId, userId);

        // Check if user is org owner/admin — they see ALL org items
        const membership = req.orgMembership;
        const isOrgAdmin = membership && ['owner', 'admin'].includes(membership.role);

        // Org-wide "waiting for a human" view (?awaiting_human=true): any member
        // may SEE that approvals are pending — a minimal, content-redacted list
        // for non-admins — without gaining authority to act (respond is
        // unchanged). This is the list companion to the stats `awaiting_human`
        // count. When set, personal visibility scoping is intentionally bypassed
        // and the query is pinned to active approval items.
        const awaitingHumanMode = req.query.awaiting_human === 'true';

        let conditions = ['ii.org_id = ?', 'ii.deleted_at IS NULL'];
        let params = [orgId];

        if (awaitingHumanMode) {
            conditions.push("ii.kind = 'approval'");
            // status defaults to active via the shared status block below.
        } else if (!isOrgAdmin) {
            // Regular members: only items in personal inbox OR assigned to them
            // OR filed by them (quox#638). One shared definition (lib/openApprovals.js)
            // so the list, stats and openApprovals() cannot drift (quox#827).
            const vis = sharedVisibility({ isOrgAdmin: false, personalInboxId, userId });
            conditions.push(vis.sql.replace(/^AND /, ''));
            params.push(...vis.params);
        }
        // Org owners/admins see all org items (no additional filter)

        // status: absent = active only (legacy default); single value, comma
        // list, or `all` = history. decision=approved|rejected narrows resolved.
        const sf = buildStatusFilter(status, req.query.decision);
        if (sf.error) return res.status(400).json({ error: sf.error });
        if (sf.sql) {
            conditions.push(sf.sql);
            params.push(...sf.params);
        }

        if (kind) {
            conditions.push('ii.kind = ?');
            params.push(kind);
        }

        if (priority) {
            conditions.push('ii.priority = ?');
            params.push(priority);
        }

        // Exclude snoozed items unless explicitly requested
        if (req.query.include_snoozed !== 'true') {
            conditions.push(`NOT EXISTS (
                SELECT 1 FROM inbox_item_assignees iia_snz
                WHERE iia_snz.inbox_item_id = ii.id
                AND iia_snz.assignee_type = 'user'
                AND iia_snz.assignee_id = ?
                AND iia_snz.snoozed_until IS NOT NULL
                AND iia_snz.snoozed_until > datetime('now')
            )`);
            params.push(userId);
        }

        // Count total
        const countResult = prepare(`
            SELECT COUNT(*) as total FROM inbox_items ii
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        // Get items
        const items = prepare(`
            SELECT ii.*,
                   ib.name as inbox_name, ib.inbox_type,
                   u.display_name as created_by_name,
                   r.workflow_id, w.name as workflow_name
            FROM inbox_items ii
            LEFT JOIN inboxes ib ON ii.inbox_id = ib.id
            LEFT JOIN users u ON ii.created_by = u.id
            LEFT JOIN runs r ON ii.run_id = r.id
            LEFT JOIN workflows w ON r.workflow_id = w.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY ${sf.explicit ? HISTORY_ORDER : 'ii.created_at DESC'}
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        // Enrich with assignees + per-user read/flag/archive/snooze state.
        // Batch-fetch assignees for ALL items in a single IN(...) query instead
        // of one query per item (was N+1 — up to `limit` sequential queries
        // per page load, the dominant cost of the inbox list endpoint).
        const itemIds = items.map(item => item.id);
        const assigneesByItemId = new Map();
        if (itemIds.length > 0) {
            const placeholders = itemIds.map(() => '?').join(',');
            const allAssignees = prepare(`
                SELECT iia.*, u.display_name as user_name, u.primary_email as user_email
                FROM inbox_item_assignees iia
                LEFT JOIN users u ON iia.assignee_type = 'user' AND iia.assignee_id = u.id
                WHERE iia.inbox_item_id IN (${placeholders})
            `).all(...itemIds);
            for (const assignee of allAssignees) {
                if (!assigneesByItemId.has(assignee.inbox_item_id)) {
                    assigneesByItemId.set(assignee.inbox_item_id, []);
                }
                assigneesByItemId.get(assignee.inbox_item_id).push(assignee);
            }
        }

        const enrichedItems = items.map(item => {
            const assignees = assigneesByItemId.get(item.id) || [];

            // awaiting_human view for a NON-admin: return only non-content
            // metadata so an agent learns work is waiting without one user's
            // approval content (title, payload, response, body) leaking to
            // another. Admins fall through to the full enrichment below.
            if (awaitingHumanMode && !isOrgAdmin) {
                return {
                    id: item.id,
                    kind: item.kind,
                    priority: item.priority,
                    status: item.status,
                    created_at: item.created_at,
                    created_by_name: item.created_by_name || null,
                    inbox_type: item.inbox_type || null,
                    awaiting_human: true,
                };
            }

            // Get current user's assignee record for per-user state
            const myAssignee = assignees.find(a => a.assignee_type === 'user' && a.assignee_id === userId);

            return {
                ...item,
                payload: item.payload_json ? JSON.parse(item.payload_json) : {},
                response: item.response_json ? JSON.parse(item.response_json) : null,
                assignees,
                is_read: myAssignee?.is_read ?? 0,
                is_flagged: myAssignee?.is_flagged ?? 0,
                archived_at: myAssignee?.archived_at ?? null,
                snoozed_until: myAssignee?.snoozed_until ?? null
            };
        });

        res.json(formatPaginatedResponse(enrichedItems, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing inbox items:', error);
        res.status(500).json({ error: 'Failed to list inbox items' });
    }
});

/**
 * GET /orgs/:orgId/approvals/open
 * The approvals this user can act on right now (quox#827): the same function that backs
 * stats.pending_approvals, the CLI and LUCID. -> { approvals:[{id,source,title,privileged,
 * conversationId?,createdAt,status,approvalId,item}], count, failed_sources }
 */
router.get('/orgs/:orgId/approvals/open', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const personalInboxId = ensurePersonalInbox(orgId, userId);
        const isOrgAdmin = !!(req.orgMembership && ['owner', 'admin'].includes(req.orgMembership.role));
        res.json(openApprovals({ orgId, userId, isOrgAdmin, personalInboxId }));
    } catch (error) {
        console.error('Error listing open approvals:', error);
        res.status(500).json({ error: 'Failed to list open approvals' });
    }
});

/**
 * GET /orgs/:orgId/inbox/stats
 * Get inbox statistics for the user
 */
router.get('/orgs/:orgId/inbox/stats', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const personalInboxId = ensurePersonalInbox(orgId, userId);
        // Org owners/admins see all org items
        const membership = req.orgMembership;
        const isOrgAdmin = membership && ['owner', 'admin'].includes(membership.role);
        // #864: one shared computation (lib/inboxStats.js), also served to the collector's
        // inbox_stats tool over the internal router, so chat and the CLI cannot drift.
        res.json(computeInboxStats({ orgId, userId, isOrgAdmin, personalInboxId }));
    } catch (error) {
        console.error('Error getting inbox stats:', error);
        res.status(500).json({ error: 'Failed to get inbox stats' });
    }
});

/**
 * GET /orgs/:orgId/inbox/stream
 * Server-Sent Events (SSE) stream for real-time inbox updates
 */
router.get('/orgs/:orgId/inbox/stream', requireOrgMembership, async (req, res) => {
    const { orgId } = req.params;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ orgId, timestamp: new Date().toISOString() })}\n\n`);

    // Subscribe to inbox events
    subscribeClient(orgId, res);

    // Keep-alive every 25 seconds. The `:ping` comment keeps proxies open but is
    // invisible to EventSource listeners; the named `event: ping` is what the
    // client watchdog observes to detect half-dead streams.
    const keepAlive = setInterval(() => {
        try {
            res.write(`:ping\n\nevent: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
        } catch {
            clearInterval(keepAlive);
        }
    }, 25000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(keepAlive);
    });
});

/**
 * GET /orgs/:orgId/inbox/:itemId
 * Get a single inbox item with full details
 */
/**
 * GET /inbox/items/:itemId
 * Cross-org item lookup. Resolves an inbox item by ID across every org the
 * user is an active member of — used when the detail view is opened via a
 * direct URL with no org context in the path or navigation state.
 *
 * Same response shape as /orgs/:orgId/inbox/:itemId.
 */
/** LOOSEN-GUARD: is the resolver's users row a person (not an agent / agent_ops account)? null when unresolved. */
function resolverIsHuman(resolvedBy) {
    if (!resolvedBy) return null;
    const u = prepare(`SELECT actor_type, metadata_json FROM users WHERE id = ?`).get(resolvedBy);
    return u ? !userRowIsNonHuman(u) : false;
}

/**
 * LOOSEN-GUARD: a signed statement that a PERSON approved this item (resolved + approved, decided with a
 * live step-up PIN, by a human users row), listing the repo paths its text names. CI verifies it offline
 * with the committed public key (scripts/guards/loosening-attestation-key.json). null for anything else.
 */
const LOOSEN_APPROVE_OPTIONS = new Set(['y', 'yes', 'approve', 'approved']);
function looseningAttestation(item) {
    try {
        if (!item || item.status !== 'resolved') return null;
        const r = item.response_json ? JSON.parse(item.response_json) : {};
        const act = String(r.action || '').toLowerCase();
        const approved = act === 'approve' || act === 'approved' || (act === 'answer' && LOOSEN_APPROVE_OPTIONS.has(String(r.option || '').toLowerCase()));
        if (!approved || r.step_up_verified !== true || resolverIsHuman(item.resolved_by) !== true) return null;
        const text = [item.title, item.body_md, item.payload_json].filter(Boolean).join('\n');
        const named = [...new Set((text.match(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@[\]-]+)+\.[A-Za-z0-9]+/g) || []).map(toRepoRelative))].slice(0, 50).sort();
        if (!named.length) return null;
        const payload = {
            approved: true, item_id: item.id, named_paths: named, org_id: item.org_id, resolved_at: item.resolved_at || null,
            resolved_by: item.resolved_by, resolved_by_is_human: true, step_up_verified: true, type: 'quox.loosening-approval', v: 1,
        };
        const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const { signature } = signWithApprovalKey(b64);
        return `${b64}.${signature}`;
    } catch (e) {
        console.warn('[Inbox] loosening attestation unavailable:', e.message);
        return null;
    }
}

router.get('/inbox/items/:itemId', async (req, res) => {
    try {
        const { itemId } = req.params;
        const userId = req.user.id;

        const item = prepare(`
            SELECT ii.*,
                   ib.name as inbox_name, ib.inbox_type,
                   u.display_name as created_by_name,
                   ru.display_name as resolved_by_name,
                   r.id as run_id, r.status as run_status, r.workflow_id,
                   w.name as workflow_name
            FROM inbox_items ii
            JOIN org_memberships om
              ON om.org_id = ii.org_id
             AND om.user_id = ?
             AND om.status = 'active'
            LEFT JOIN inboxes ib ON ii.inbox_id = ib.id
            LEFT JOIN users u ON ii.created_by = u.id
            LEFT JOIN users ru ON ii.resolved_by = ru.id
            LEFT JOIN runs r ON ii.run_id = r.id
            LEFT JOIN workflows w ON r.workflow_id = w.id
            WHERE ii.id = ?
            LIMIT 1
        `).get(userId, itemId);

        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        const orgId = item.org_id;

        const assignees = prepare(`
            SELECT iia.*, u.display_name as user_name, u.primary_email as user_email
            FROM inbox_item_assignees iia
            LEFT JOIN users u ON iia.assignee_type = 'user' AND iia.assignee_id = u.id
            WHERE iia.inbox_item_id = ?
        `).all(itemId);

        const escalations = prepare(`
            SELECT * FROM escalation_stages WHERE inbox_item_id = ? ORDER BY stage_num
        `).all(itemId);

        prepare(`
            UPDATE inbox_item_assignees
            SET viewed_at = COALESCE(viewed_at, datetime('now')),
                is_read = 1,
                status = CASE WHEN status = 'pending' THEN 'viewed' ELSE status END
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(itemId, userId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_viewed',
            targetType: 'inbox_item',
            targetId: itemId
        });

        res.json({
            item: {
                ...item,
                payload: item.payload_json ? JSON.parse(item.payload_json) : {},
                response: item.response_json ? JSON.parse(item.response_json) : null,
                sla_stages: item.sla_stages_json ? JSON.parse(item.sla_stages_json) : null,
                resolved_by_is_human: resolverIsHuman(item.resolved_by),
                loosening_attestation: looseningAttestation(item)
            },
            assignees,
            escalations: escalations.map(e => ({
                ...e,
                target: e.target_json ? JSON.parse(e.target_json) : {}
            }))
        });
    } catch (error) {
        console.error('Error getting inbox item (cross-org):', error);
        res.status(500).json({ error: 'Failed to get inbox item' });
    }
});

router.get('/orgs/:orgId/inbox/:itemId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        // CLI-ERRORS: a tool approvalId (aee_correlation_id) finds its card too, whatever its status.
        const itemId = findItemByIdOrApprovalId(getDb(), orgId, req.params.itemId)?.id || req.params.itemId;
        const userId = req.user.id;

        const item = prepare(`
            SELECT ii.*,
                   ib.name as inbox_name, ib.inbox_type,
                   u.display_name as created_by_name,
                   ru.display_name as resolved_by_name,
                   r.id as run_id, r.status as run_status, r.workflow_id,
                   w.name as workflow_name
            FROM inbox_items ii
            LEFT JOIN inboxes ib ON ii.inbox_id = ib.id
            LEFT JOIN users u ON ii.created_by = u.id
            LEFT JOIN users ru ON ii.resolved_by = ru.id
            LEFT JOIN runs r ON ii.run_id = r.id
            LEFT JOIN workflows w ON r.workflow_id = w.id
            WHERE ii.id = ? AND ii.org_id = ?
        `).get(itemId, orgId);

        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Route-authz: only owners/admins, the personal-inbox owner, or an
        // assignee may read this item. 404 (not 403) so a member cannot probe
        // which item ids exist in inboxes they cannot see.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Get assignees
        const assignees = prepare(`
            SELECT iia.*, u.display_name as user_name, u.primary_email as user_email
            FROM inbox_item_assignees iia
            LEFT JOIN users u ON iia.assignee_type = 'user' AND iia.assignee_id = u.id
            WHERE iia.inbox_item_id = ?
        `).all(itemId);

        // Get escalation stages
        const escalations = prepare(`
            SELECT * FROM escalation_stages WHERE inbox_item_id = ? ORDER BY stage_num
        `).all(itemId);

        // Mark as viewed and read
        prepare(`
            UPDATE inbox_item_assignees
            SET viewed_at = COALESCE(viewed_at, datetime('now')),
                is_read = 1,
                status = CASE WHEN status = 'pending' THEN 'viewed' ELSE status END
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(itemId, userId);

        // Audit view
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_viewed',
            targetType: 'inbox_item',
            targetId: itemId
        });

        res.json({
            item: {
                ...item,
                payload: item.payload_json ? JSON.parse(item.payload_json) : {},
                response: item.response_json ? JSON.parse(item.response_json) : null,
                sla_stages: item.sla_stages_json ? JSON.parse(item.sla_stages_json) : null,
                resolved_by_is_human: resolverIsHuman(item.resolved_by),
                loosening_attestation: looseningAttestation(item)
            },
            assignees,
            escalations: escalations.map(e => ({
                ...e,
                target: e.target_json ? JSON.parse(e.target_json) : {}
            }))
        });
    } catch (error) {
        console.error('Error getting inbox item:', error);
        res.status(500).json({ error: 'Failed to get inbox item' });
    }
});

/**
 * POST /orgs/:orgId/inbox
 * Create a new inbox item (usually from workflow, but can be manual)
 */
router.post('/orgs/:orgId/inbox', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const {
            inbox_id,
            run_id,
            kind,
            priority,
            title,
            body_md,
            payload,
            due_at,
            assignees,
            sla_stages,
            aee_correlation_id
        } = req.body;
        const userId = req.user.id;

        // Validate kind
        if (!ITEM_KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Invalid item kind' });
        }
        // APPROVAL-WHAT: an approval must say what will happen and to what, or it is refused (422).
        const describedPayload = describedApprovalPayload(req, res, { kind, payload });
        if (describedPayload === null) return;

        // Validate priority
        if (priority && !PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        // Use provided inbox or user's personal inbox
        const targetInboxId = inbox_id || ensurePersonalInbox(orgId, userId);

        // Verify inbox exists and belongs to org
        const inbox = prepare(`SELECT id FROM inboxes WHERE id = ? AND org_id = ?`).get(targetInboxId, orgId);
        if (!inbox) {
            return res.status(404).json({ error: 'Inbox not found' });
        }

        const itemId = ulid();

        // Create item
        prepare(`
            INSERT INTO inbox_items (
                id, org_id, inbox_id, run_id, kind, priority, title, body_md,
                payload_json, due_at, sla_stages_json, created_by, aee_correlation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            itemId, orgId, targetInboxId, run_id || null,
            kind, priority || 'normal', title, body_md || null,
            JSON.stringify(describedPayload || {}), due_at || null,
            sla_stages ? JSON.stringify(sla_stages) : null, userId,
            aee_correlation_id || null
        );

        // Add assignees
        if (assignees && assignees.length > 0) {
            const insertAssignee = prepare(`
                INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const assignee of assignees) {
                insertAssignee.run(
                    ulid(), itemId,
                    assignee.type || 'user',
                    assignee.id,
                    assignee.mode || 'anyone'
                );
            }
        } else {
            // Default: assign to creator
            prepare(`
                INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
                VALUES (?, ?, 'user', ?, 'anyone')
            `).run(ulid(), itemId, userId);
        }

        // Create escalation stages if provided
        if (sla_stages && sla_stages.length > 0) {
            const insertEscalation = prepare(`
                INSERT INTO escalation_stages (id, inbox_item_id, stage_num, trigger_after_minutes, action, target_json, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (let i = 0; i < sla_stages.length; i++) {
                const stage = sla_stages[i];
                const scheduledAt = new Date(Date.now() + stage.trigger_after_minutes * 60000).toISOString();
                insertEscalation.run(
                    ulid(), itemId, i + 1,
                    stage.trigger_after_minutes,
                    stage.action || 'notify',
                    JSON.stringify(stage.target || {}),
                    scheduledAt
                );
            }
        }

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_created',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: { kind, title, run_id }
        });

        const createdItem = {
            id: itemId,
            org_id: orgId,
            inbox_id: targetInboxId,
            kind,
            status: 'open',
            priority: priority || 'normal',
            title
        };

        // Emit real-time event for SSE clients
        emitItemCreated(orgId, createdItem);
        emitStatsUpdate(orgId);

        res.status(201).json({ item: createdItem });
    } catch (error) {
        console.error('Error creating inbox item:', error);
        res.status(500).json({ error: 'Failed to create inbox item' });
    }
});

/**
 * POST /orgs/:orgId/decisions   (quox ask)
 * A session or agent files ONE decision request for a human: who (session + profile/agent), what, why, the
 * options, the recommendation and the expiry. Same inbox, same visibility as approvals; counted with them.
 * Body: { session, title, why?, options:[{key,label}], default?, recommend?, expires_in_seconds?, high_risk?, slot?, profile?, agent? }
 */
router.post('/orgs/:orgId/decisions', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const built = buildDecision(req.body || {});
        if (!built.ok) return res.status(400).json({ error: 'invalid_decision', message: built.error });
        const inboxId = ensurePersonalInbox(orgId, userId);
        const itemId = ulid();
        prepare(`
            INSERT INTO inbox_items (id, org_id, inbox_id, kind, priority, title, body_md, payload_json, due_at, created_by)
            VALUES (?, ?, ?, 'question', ?, ?, ?, ?, ?, ?)
        `).run(itemId, orgId, inboxId, built.payload.high_risk ? 'high' : 'normal', built.title, built.why || null,
            JSON.stringify(built.payload), built.dueAt, userId);
        prepare(`INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode) VALUES (?, ?, 'user', ?, 'anyone')`)
            .run(ulid(), itemId, userId);
        createAuditEvent({
            orgId, actorType: 'user', actorId: userId, action: 'hitl.decision_asked',
            targetType: 'inbox_item', targetId: itemId,
            metadata: { session: built.payload.session, title: built.title, options: built.payload.options.map((o) => o.key), high_risk: built.payload.high_risk, expires_at: built.dueAt },
        });
        const createdItem = { id: itemId, org_id: orgId, inbox_id: inboxId, kind: 'question', status: 'open', priority: built.payload.high_risk ? 'high' : 'normal', title: built.title };
        emitItemCreated(orgId, createdItem);
        emitStatsUpdate(orgId);
        const row = prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(itemId);
        res.status(201).json({ decision: decisionView(row) });
    } catch (error) {
        console.error('Error creating decision:', error);
        res.status(500).json({ error: 'Failed to create decision' });
    }
});

/**
 * GET /orgs/:orgId/decisions/:id?wait=SECONDS
 * The asker's view: state pending|answered|denied|expired|cancelled plus the answer (option, note, who, when).
 * wait (max 25) long-polls while it is still pending, so `quox ask wait` needs no tight loop.
 */
router.get('/orgs/:orgId/decisions/:id', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        const load = () => { expireDueDecisions(orgId); return prepare(`SELECT * FROM inbox_items WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).get(id, orgId); };
        let row = load();
        if (!row || !isDecisionRow(row)) return res.status(404).json({ error: 'not_found', message: 'No such decision' });
        if (!userCanAccessItem(row, orgId, req.user.id, req.orgMembership)) return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this decision' });
        const waitMs = Math.min(Math.max(Number(req.query.wait) || 0, 0), 25) * 1000;
        const until = Date.now() + waitMs;
        let aborted = false;
        req.on('close', () => { aborted = true; });
        while (decisionView(row).state === 'pending' && Date.now() < until && !aborted) {
            await new Promise((r) => setTimeout(r, 1000));
            row = load() || row;
        }
        res.json({ decision: decisionView(row) });
    } catch (error) {
        console.error('Error reading decision:', error);
        res.status(500).json({ error: 'Failed to read decision' });
    }
});

/**
 * POST /orgs/:orgId/inbox/:itemId/respond
 * Respond to an inbox item (approve, deny, answer, etc.)
 */
router.post('/orgs/:orgId/inbox/:itemId/respond', requireOrgMembership, async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const { orgId } = req.params;
        const { action, comment, data } = req.body;
        const userId = req.user.id;
        console.log(`[Inbox/Respond] itemId=${req.params.itemId} action="${action}" userId=${userId}`);

        // CLI-ERRORS: the item id, or the tool approvalId an agent handed back (any status, this org only).
        const item = findItemByIdOrApprovalId(getDb(), orgId, req.params.itemId, { withRun: true });

        if (!item) {
            return res.status(404).json(notFoundBody(req.params.itemId));
        }
        const itemId = item.id;

        // Route-authz: membership is not authority over this item. Only
        // owners/admins, the personal-inbox owner, or an assignee may decide it.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have authority over this inbox item' });
        }

        // TASK-546 (declared-approver enforcement): userCanAccessItem above is
        // visibility, not approval authority — it also grants the personal-inbox
        // OWNER even when they are no longer an assignee (e.g. after /reassign).
        // For kind === 'approval' specifically, require an actual assignee or
        // an org admin/owner before a governed decision can be recorded.
        if (item.kind === 'approval' && !isOrgAdminOrOwner(req.orgMembership) && !isApprovalAssignee(itemId, userId)) {
            return res.status(403).json({
                error: 'not_authorized_approver',
                message: 'Only an assigned approver or an org admin/owner may respond to this approval'
            });
        }

        if (!['open', 'in_progress', 'waiting', 'in_progress'].includes(item.status)) {
            // CLI-ERRORS: say who closed it, when, and how; `code: already_resolved` + `resolution` are additive.
            return res.status(400).json(alreadyResolvedBody(getDb(), item, action));
        }

        // quox ask: a decision request takes an option (or a decline), never an approve of an action.
        let decisionOutcome = null;
        if (isDecisionRow(item)) {
            expireDueDecisions(orgId);
            const fresh = prepare(`SELECT status FROM inbox_items WHERE id = ?`).get(itemId);
            if (fresh && fresh.status !== item.status) item.status = fresh.status;
            if (!['open', 'in_progress', 'waiting'].includes(item.status)) return res.status(400).json(alreadyResolvedBody(getDb(), { ...item, ...prepare(`SELECT status, resolved_at, resolved_by, response_json FROM inbox_items WHERE id = ?`).get(itemId) }, action));
            const dp = JSON.parse(item.payload_json || '{}');
            decisionOutcome = resolveDecisionResponse(dp, { action, option: req.body.option, data });
            if (!decisionOutcome.ok) return res.status(400).json({ error: 'invalid_decision_response', message: decisionOutcome.error });
            // APPROVALS-AUDIT: a client-marked bulk yes never covers a risky ask; it is answered one at a time.
            if (req.body.bulk === true && decisionOutcome.action === 'answer' && decisionOutcome.option !== 'n') {
                const why = bulkHeldReason(item.title, dp);
                if (why) return res.status(400).json({ error: 'bulk_not_allowed', reason: why, message: `This decision (${why}) cannot be answered as part of a bulk yes. Answer it on its own.` });
            }
            // Only a high-risk ask needs a person-proof; the asker answering their own plain ask is the normal case.
            // QUOXON-1191: a YES-class answer (anything but an explicit "n") to a high-risk ask needs the PIN even when
            // QUOX_STEP_UP_ENFORCE is off (dev ran with it off and three high-risk yeses resolved with no person-proof).
            if (dp.high_risk === true && decisionOutcome.action === 'answer' && (stepUpEnforced() || decisionOutcome.option !== 'n') && !sandboxApproverLeaseActive(getDb())) {
                const chk = checkStepUpToken(req, 'approve', orgId);
                if (!chk.ok) return res.status(403).json({ error: 'step_up_required', reason: chk.reason, scope: 'approve', pin_set: getPinStatus(req.user?.id, getDb()).set, message: 'This decision was marked high risk: confirm with your step-up PIN' });
            }
        }


        // QUOXON-STEPUP: a human JWT proves a login, not a person. Approving an agent/automation-raised
        // (or high-risk) approval needs a live step-up token; requester can never approve their own item.
        if (item.kind === 'approval' && isApproveAction(action) && !requireStepUpForApprove(req, res, item, { orgId })) return;

        // Build response
        const response = {
            action: decisionOutcome ? decisionOutcome.action : action,
            comment,
            data,
            ...(decisionOutcome ? { option: decisionOutcome.option } : {}),
            responded_by: userId,
            responded_by_name: req.user.display_name || req.user.primary_email || prepare(`SELECT COALESCE(display_name, primary_email) AS n FROM users WHERE id = ?`).get(userId)?.n || userId,
            responded_at: new Date().toISOString(),
            // LOOSEN-GUARD: person-proof for this decision (a live step-up PIN token), recorded whether or
            // not step-up is enforced, so a reader (the test-loosening guard) can tell a person from a login.
            step_up_verified: checkStepUpToken(req, 'approve', orgId).ok === true
        };

        // All actions resolve the item. For request_changes, QuoxFlow handles
        // the iteration loop by creating a NEW inbox item for the next review.
        const isRequestChanges = action === 'request_changes';

        // quox#896: a card mirroring an objective checkpoint decides the
        // checkpoint first; if tasks refuses, the card stays open.
        const cpDecision = await forwardCheckpointDecision({
            item, action, comment, userId, orgId, role: req.orgMembership?.role,
            sessionId: req.user?.sessionId || null, stepUpToken: req.headers['x-step-up-token'] || null,
        });
        if (!cpDecision.ok) {
            return res.status(cpDecision.status || 502).json({ error: cpDecision.error, message: cpDecision.message });
        }

        {
            // Normal resolve
            prepare(`
                UPDATE inbox_items
                SET status = 'resolved', response_json = ?, resolved_by = ?, resolved_at = datetime('now')
                WHERE id = ?
            `).run(JSON.stringify(response), userId, itemId);
        }

        // Full post-resolve side-effect chain (VOLT witness, agent-standing,
        // run_events, QuoxFlow/tasks/qluster/native-tool resume, credential
        // lease, QuoxPlan + generic callback_url dispatch, channel reply,
        // SSE emit) is shared with the bulk approve/deny path — see
        // applyResponseSideEffects above.
        await applyResponseSideEffects(item, { action: decisionOutcome ? decisionOutcome.action : action, comment, data }, req);

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: decisionOutcome ? 'hitl.decision_answered' : 'hitl.item_responded',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: decisionOutcome ? { action: decisionOutcome.action, option: decisionOutcome.option, kind: item.kind } : { action, kind: item.kind }
        });

        emitStatsUpdate(orgId);

        // A side effect can change the outcome (a stale tool approval is refused and
        // flips the card to expired); report the card's real status, not a guess.
        const after = getDb().prepare('SELECT status FROM inbox_items WHERE id = ?').get(itemId);
        const expired = after?.status === 'expired';
        res.json({
            ...(decisionOutcome ? { decision: decisionView(prepare(`SELECT * FROM inbox_items WHERE id = ?`).get(itemId)) } : {}),
            message: expired ? APPROVAL_EXPIRED_MESSAGE : (isRequestChanges ? 'Changes requested — awaiting revision' : 'Response recorded'),
            item: {
                id: itemId,
                status: expired ? 'expired' : 'resolved',
                response
            }
        });
    } catch (error) {
        console.error('Error responding to inbox item:', error);
        res.status(500).json({ error: 'Failed to respond' });
    }
});

/**
 * POST /orgs/:orgId/inbox/:itemId/reassign
 * Reassign an inbox item to different users/teams
 */
router.post('/orgs/:orgId/inbox/:itemId/reassign', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { assignees, comment } = req.body;
        const userId = req.user.id;

        if (!assignees || assignees.length === 0) {
            return res.status(400).json({ error: 'At least one assignee required' });
        }

        const item = prepare(`SELECT * FROM inbox_items WHERE id = ? AND org_id = ?`).get(itemId, orgId);
        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Route-authz: only owners/admins, the personal-inbox owner, or an
        // assignee may reassign this item.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have authority over this inbox item' });
        }

        if (item.status === 'resolved' || item.status === 'cancelled') {
            return res.status(400).json({ error: 'Cannot reassign resolved or cancelled items' });
        }

        // Remove old assignees
        prepare(`DELETE FROM inbox_item_assignees WHERE inbox_item_id = ?`).run(itemId);

        // Add new assignees
        const insertAssignee = prepare(`
            INSERT INTO inbox_item_assignees (id, inbox_item_id, assignee_type, assignee_id, mode)
            VALUES (?, ?, ?, ?, ?)
        `);

        for (const assignee of assignees) {
            insertAssignee.run(
                ulid(), itemId,
                assignee.type || 'user',
                assignee.id,
                assignee.mode || 'anyone'
            );
        }

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_reassigned',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: { assignees, comment }
        });

        res.json({ message: 'Item reassigned' });
    } catch (error) {
        console.error('Error reassigning inbox item:', error);
        res.status(500).json({ error: 'Failed to reassign' });
    }
});

/**
 * POST /orgs/:orgId/inbox/:itemId/escalate
 * Manually escalate an inbox item
 */
router.post('/orgs/:orgId/inbox/:itemId/escalate', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { reason, target } = req.body;
        const userId = req.user.id;

        const item = prepare(`SELECT * FROM inbox_items WHERE id = ? AND org_id = ?`).get(itemId, orgId);
        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Route-authz: only owners/admins, the personal-inbox owner, or an
        // assignee may escalate this item.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have authority over this inbox item' });
        }

        // Update priority to urgent
        prepare(`UPDATE inbox_items SET priority = 'urgent' WHERE id = ?`).run(itemId);

        // Add escalation record
        const stageNum = prepare(`
            SELECT COALESCE(MAX(stage_num), 0) + 1 as next FROM escalation_stages WHERE inbox_item_id = ?
        `).get(itemId);

        prepare(`
            INSERT INTO escalation_stages (id, inbox_item_id, stage_num, trigger_after_minutes, action, target_json, triggered_at)
            VALUES (?, ?, ?, 0, 'escalate', ?, datetime('now'))
        `).run(ulid(), itemId, stageNum.next, JSON.stringify({ reason, ...(target || {}) }));

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_escalated',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: { reason }
        });

        res.json({ message: 'Item escalated', priority: 'urgent' });
    } catch (error) {
        console.error('Error escalating inbox item:', error);
        res.status(500).json({ error: 'Failed to escalate' });
    }
});

/**
 * PATCH /orgs/:orgId/inbox/:itemId/read
 * Mark an inbox item as read or unread for the current user
 */
router.patch('/orgs/:orgId/inbox/:itemId/read', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { is_read } = req.body;
        const userId = req.user.id;

        if (typeof is_read !== 'boolean' && is_read !== 0 && is_read !== 1) {
            return res.status(400).json({ error: 'is_read must be a boolean' });
        }

        const readValue = is_read ? 1 : 0;

        const result = prepare(`
            UPDATE inbox_item_assignees
            SET is_read = ?
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(readValue, itemId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Assignee record not found' });
        }

        emitItemUpdated(orgId, itemId, { is_read: readValue, updated_by: userId });
        emitStatsUpdate(orgId);

        res.json({ message: 'Read state updated', is_read: readValue });
    } catch (error) {
        console.error('Error updating read state:', error);
        res.status(500).json({ error: 'Failed to update read state' });
    }
});

/**
 * PATCH /orgs/:orgId/inbox/:itemId/flag
 * Toggle flag on an inbox item for the current user
 */
router.patch('/orgs/:orgId/inbox/:itemId/flag', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { is_flagged } = req.body;
        const userId = req.user.id;

        if (typeof is_flagged !== 'boolean' && is_flagged !== 0 && is_flagged !== 1) {
            return res.status(400).json({ error: 'is_flagged must be a boolean' });
        }

        const flagValue = is_flagged ? 1 : 0;

        const result = prepare(`
            UPDATE inbox_item_assignees
            SET is_flagged = ?
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(flagValue, itemId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Assignee record not found' });
        }

        emitItemUpdated(orgId, itemId, { is_flagged: flagValue, updated_by: userId });
        emitStatsUpdate(orgId);

        res.json({ message: 'Flag state updated', is_flagged: flagValue });
    } catch (error) {
        console.error('Error updating flag state:', error);
        res.status(500).json({ error: 'Failed to update flag state' });
    }
});

/**
 * PATCH /orgs/:orgId/inbox/:itemId/snooze
 * Snooze an inbox item until a given time for the current user
 */
router.patch('/orgs/:orgId/inbox/:itemId/snooze', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { snoozed_until } = req.body;
        const userId = req.user.id;

        // null to un-snooze, ISO8601 string to snooze
        let snoozeValue = null;
        if (snoozed_until !== null && snoozed_until !== undefined && snoozed_until !== '') {
            const parsed = new Date(snoozed_until);
            if (isNaN(parsed.getTime())) {
                return res.status(400).json({ error: 'snoozed_until must be a valid ISO 8601 date' });
            }
            if (parsed <= new Date()) {
                return res.status(400).json({ error: 'snoozed_until must be in the future' });
            }
            snoozeValue = parsed.toISOString();
        }

        const result = prepare(`
            UPDATE inbox_item_assignees
            SET snoozed_until = ?
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(snoozeValue, itemId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Assignee record not found' });
        }

        emitItemUpdated(orgId, itemId, { snoozed_until: snoozeValue, updated_by: userId });
        emitStatsUpdate(orgId);

        res.json({ message: 'Snooze state updated', snoozed_until: snoozeValue });
    } catch (error) {
        console.error('Error updating snooze state:', error);
        res.status(500).json({ error: 'Failed to update snooze state' });
    }
});

/**
 * PATCH /orgs/:orgId/inbox/:itemId/archive
 * Archive or unarchive an inbox item for the current user
 */
router.patch('/orgs/:orgId/inbox/:itemId/archive', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { archived } = req.body;
        const userId = req.user.id;

        const archiveValue = archived ? new Date().toISOString() : null;

        const result = prepare(`
            UPDATE inbox_item_assignees
            SET archived_at = ?
            WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?
        `).run(archiveValue, itemId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Assignee record not found' });
        }

        emitItemUpdated(orgId, itemId, { archived_at: archiveValue, updated_by: userId });
        emitStatsUpdate(orgId);

        res.json({ message: archived ? 'Item archived' : 'Item unarchived', archived_at: archiveValue });
    } catch (error) {
        console.error('Error updating archive state:', error);
        res.status(500).json({ error: 'Failed to update archive state' });
    }
});

/**
 * POST /orgs/:orgId/inbox/bulk
 * Bulk action on multiple inbox items
 */
router.post('/orgs/:orgId/inbox/bulk', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { item_ids, action, comment } = req.body;
        const userId = req.user.id;

        const validActions = ['mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'unarchive', 'delete', 'approve', 'deny'];
        if (!validActions.includes(action)) {
            return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
        }
        // F13: bulk approve/deny is a decision sink; agents file proposals, humans decide.
        if ((action === 'approve' || action === 'deny') && !requireHumanDecider(req, res)) return;
        if (!Array.isArray(item_ids) || item_ids.length === 0) {
            return res.status(400).json({ error: 'item_ids must be a non-empty array' });
        }
        if (item_ids.length > 100) {
            return res.status(400).json({ error: 'Maximum 100 items per bulk action' });
        }

        const results = { success: 0, failed: 0, side_effect_failures: 0 };
        let requiresIndividual = [];
        const bulkComment = comment || '';

        const db = getDb();

        // Route-authz: for state-changing actions (delete/approve/deny) a user
        // may act only on items they can access (owner/admin, personal-inbox
        // owner, or assignee). Personal-state actions (read/flag/archive) are
        // already self-scoped by assignee_id, so they need no extra filter.
        const STATE_CHANGING = new Set(['delete', 'approve', 'deny']);
        let idsToProcess = item_ids;
        if (STATE_CHANGING.has(action)) {
            const rows = prepare(
                `SELECT * FROM inbox_items WHERE id IN (${item_ids.map(() => '?').join(',')}) AND org_id = ?`
            ).all(...item_ids, orgId);
            const byId = new Map(rows.map((r) => [r.id, r]));
            idsToProcess = item_ids.filter((id) => {
                const it = byId.get(id);
                return it && userCanAccessItem(it, orgId, userId, req.orgMembership);
            });
            results.failed += item_ids.length - idsToProcess.length;

            // bulk-parity (quox#523): even though bulk now runs the FULL shared
            // side-effect chain (applyResponseSideEffects), items whose approval
            // needs to be individually confirmed/reviewed by a human before an
            // irreversible execution — credential leases, native-tool approvals,
            // callback_url plugin bridges, QuoxPlan callbacks — are still routed
            // to individual review rather than swept up in a bulk action.
            // Exclude them and report them as requiring individual review, where
            // POST /respond handles them one at a time.
            if (action === 'approve') {
                // QUOXON-STEPUP: same rule as single /respond. Own items are dropped; any
                // agent-raised / high-risk approval needs a live step-up token for the whole batch.
                const before = idsToProcess.length;
                const sandbox = sandboxApproverLeaseActive(db);
                if (!sandbox && stepUpEnforced()) {
                    idsToProcess = idsToProcess.filter((id) => { const it = byId.get(id); return !(it && it.kind === 'approval' && it.created_by === userId); });
                    results.failed += before - idsToProcess.length;
                }
                const gated = sandbox ? [] : idsToProcess.filter((id) => stepUpRequiredFor(byId.get(id)));
                if (gated.length > 0) {
                    const chk = checkStepUpToken(req, 'approve', orgId);
                    if (!chk.ok && !stepUpEnforced()) console.warn(`[StepUp] would require step-up (not enforced): bulk approve, reason=${chk.reason}`);
                    else if (!chk.ok) {
                        return res.status(403).json({ error: 'step_up_required', reason: chk.reason, scope: 'approve', pin_set: getPinStatus(userId).set, item_ids: gated });
                    }
                }
            }
            if (action === 'approve' || action === 'deny') {
                // TASK-546 (declared-approver enforcement): visibility (above)
                // is not approval authority. For kind === 'approval' items,
                // require the caller be an actual assignee or an org
                // admin/owner — same rule as the single /respond handler.
                // Other kinds bulk-approve/deny under the visibility rule
                // only, unchanged.
                if (!isOrgAdminOrOwner(req.orgMembership)) {
                    const before = idsToProcess.length;
                    idsToProcess = idsToProcess.filter((id) => {
                        const it = byId.get(id);
                        if (!it || it.kind !== 'approval') return true;
                        return isApprovalAssignee(id, userId);
                    });
                    results.failed += before - idsToProcess.length;
                }

                const needsIndividual = (row) => {
                    let p = null;
                    try { p = row.payload_json ? JSON.parse(row.payload_json) : null; }
                    catch { return true; } // unparseable payload — exclude to be safe
                    if (!p) return false;
                    return p.type === 'credential_lease'
                        || p.type === 'native_tool_approval'
                        || typeof p.callback_url === 'string'
                        || p.source === 'quoxplan'
                        // quox#896: a checkpoint is decided one at a time
                        || p.source === 'objective_checkpoint';
                };
                const safe = [];
                for (const id of idsToProcess) {
                    const row = byId.get(id);
                    if (row && needsIndividual(row)) requiresIndividual.push(id);
                    else safe.push(id);
                }
                idsToProcess = safe;
                results.failed += requiresIndividual.length;
            }
        }

        // Approvals-Q gap #1 / bulk-full-parity: for approve/deny, capture each
        // item's full side-effect shape BEFORE the transaction resolves it, so
        // the SAME full side-effect chain the single /respond does
        // (applyResponseSideEffects) also fires for bulk — previously bulk ran
        // only VOLT-witness + QuoxFlow-resume and silently skipped every other
        // bridge (agent-standing, run_events, tasks-objective resume, qluster
        // resume, channel reply, SSE emit) for items that pass the
        // needsIndividual exclusion above.
        let approvalTargets = [];
        if ((action === 'approve' || action === 'deny') && idsToProcess.length > 0) {
            approvalTargets = prepare(
                `SELECT id, org_id, kind, run_id, payload_json, quoxflow_execution_id,
                        tasks_objective_id, aee_correlation_id
                 FROM inbox_items
                 WHERE id IN (${idsToProcess.map(() => '?').join(',')}) AND org_id = ?
                   AND status IN ('open', 'in_progress', 'waiting')`
            ).all(...idsToProcess, orgId);
        }
        const bulkTransaction = db.transaction(() => {
            for (const itemId of idsToProcess) {
                try {
                    // bulk-parity (quox#523): count success only when the operation
                    // actually changed a row. The approve/deny/delete UPDATEs are
                    // guarded (status IN open/in_progress/waiting; deleted_at IS NULL),
                    // so an already-terminal item changes 0 rows — it must NOT be
                    // reported as a fresh success.
                    let changed = true;
                    switch (action) {
                        case 'mark_read':
                            prepare(`UPDATE inbox_item_assignees SET is_read = 1 WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'mark_unread':
                            prepare(`UPDATE inbox_item_assignees SET is_read = 0 WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'flag':
                            prepare(`UPDATE inbox_item_assignees SET is_flagged = 1 WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'unflag':
                            prepare(`UPDATE inbox_item_assignees SET is_flagged = 0 WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'archive':
                            prepare(`UPDATE inbox_item_assignees SET archived_at = datetime('now') WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'unarchive':
                            prepare(`UPDATE inbox_item_assignees SET archived_at = NULL WHERE inbox_item_id = ? AND assignee_type = 'user' AND assignee_id = ?`).run(itemId, userId);
                            break;
                        case 'delete': {
                            const info = prepare(`UPDATE inbox_items SET status = 'cancelled', deleted_at = datetime('now') WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).run(itemId, orgId);
                            changed = info.changes > 0;
                            break;
                        }
                        case 'approve': {
                            const info = prepare(`UPDATE inbox_items SET status = 'resolved', response_json = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND org_id = ? AND status IN ('open', 'in_progress', 'waiting')`).run(
                                JSON.stringify({ action: 'approved', comment: bulkComment, responded_by: userId, responded_at: new Date().toISOString() }),
                                userId, itemId, orgId
                            );
                            changed = info.changes > 0;
                            break;
                        }
                        case 'deny': {
                            const info = prepare(`UPDATE inbox_items SET status = 'resolved', response_json = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND org_id = ? AND status IN ('open', 'in_progress', 'waiting')`).run(
                                JSON.stringify({ action: 'denied', comment: bulkComment, responded_by: userId, responded_at: new Date().toISOString() }),
                                userId, itemId, orgId
                            );
                            changed = info.changes > 0;
                            break;
                        }
                    }
                    if (changed) results.success++;
                    else results.failed++;
                } catch (err) {
                    console.error(`Bulk ${action} failed for item ${itemId}:`, err.message);
                    results.failed++;
                }
            }
        });

        bulkTransaction();

        // Approvals-Q gap #1 / bulk-full-parity: run the SAME post-resolve
        // side-effect chain per item as the single /respond path
        // (applyResponseSideEffects — VOLT witness, agent-standing, run_events,
        // QuoxFlow/tasks/qluster resume, channel reply, SSE emit; lease/
        // native-tool/callback_url/quoxplan items never reach here — they were
        // excluded above into requires_individual_review).
        if (approvalTargets.length > 0) {
            const approved = action === 'approve';
            for (const item of approvalTargets) {
                try {
                    await applyResponseSideEffects(item, { action, comment: bulkComment }, req);
                } catch (err) {
                    console.error(`[Inbox/bulk] side-effects failed for ${item.id}:`, err.message);
                    // bulk-parity (quox#523): the item was already resolved above, but
                    // executing its governed side-effect failed. Surface it as an
                    // incident instead of a silent success, mirroring the single
                    // /respond callback path (quox#529).
                    results.side_effect_failures++;
                    mintIncidentItem(orgId, {
                        title: `Bulk ${action} side-effect FAILED: ${item.id}`,
                        body_md: `Item ${item.id} was **${approved ? 'approved' : 'denied'}** in a bulk action, but executing its governed side-effect failed, so the action may not have taken effect.\n\n- Error: ${String(err.message).slice(0, 500)}\n\nRe-check the item and re-run if needed.`,
                        payload: { source: 'bulk_side_effect_failure', original_item_id: item.id, bulk_action: action, error: err.message },
                    });
                }
            }
        }

        emitStatsUpdate(orgId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: `hitl.bulk_${action}`,
            targetType: 'inbox_item',
            targetId: item_ids[0],
            metadata: { action, count: item_ids.length, results }
        });

        res.json({ message: 'Bulk action completed', ...results, requires_individual_review: requiresIndividual });
    } catch (error) {
        console.error('Error performing bulk action:', error);
        res.status(500).json({ error: 'Failed to perform bulk action' });
    }
});

/**
 * POST /orgs/:orgId/inbox/:itemId/restore
 * Restore a soft-deleted inbox item
 */
router.post('/orgs/:orgId/inbox/:itemId/restore', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const userId = req.user.id;

        const item = prepare(`SELECT * FROM inbox_items WHERE id = ? AND org_id = ?`).get(itemId, orgId);
        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Route-authz: only owners/admins, the personal-inbox owner, or an
        // assignee may restore this item.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have authority over this inbox item' });
        }

        prepare(`
            UPDATE inbox_items SET status = 'open', deleted_at = NULL WHERE id = ?
        `).run(itemId);

        emitStatsUpdate(orgId);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_restored',
            targetType: 'inbox_item',
            targetId: itemId
        });

        res.json({ message: 'Item restored' });
    } catch (error) {
        console.error('Error restoring inbox item:', error);
        res.status(500).json({ error: 'Failed to restore item' });
    }
});

/**
 * DELETE /orgs/:orgId/inbox/:itemId
 * Cancel/delete an inbox item
 */
router.delete('/orgs/:orgId/inbox/:itemId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, itemId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        const item = prepare(`SELECT * FROM inbox_items WHERE id = ? AND org_id = ?`).get(itemId, orgId);
        if (!item) {
            return res.status(404).json({ error: 'Inbox item not found' });
        }

        // Route-authz: only owners/admins, the personal-inbox owner, or an
        // assignee may cancel/delete this item.
        if (!userCanAccessItem(item, orgId, userId, req.orgMembership)) {
            return res.status(403).json({ error: 'forbidden', message: 'You do not have authority over this inbox item' });
        }

        // Soft delete (mark as cancelled)
        prepare(`
            UPDATE inbox_items
            SET status = 'cancelled', deleted_at = datetime('now')
            WHERE id = ?
        `).run(itemId);

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'hitl.item_cancelled',
            targetType: 'inbox_item',
            targetId: itemId,
            metadata: { reason }
        });

        // HITL-VOLT-WITNESS (QuoxPlan #2202): only approval-kind items carry a
        // decision worth witnessing in VOLT.
        if (item.kind === 'approval') {
            try {
                await emitApprovalVoltWitness({
                    orgId,
                    itemId,
                    decision: 'cancelled',
                    actor: req.user.primary_email || req.user.display_name || userId,
                    comment: reason,
                });
            } catch (err) {
                console.error('[Inbox/VOLT] unexpected witness error (non-fatal):', err.message);
            }
        }

        res.json({ message: 'Item cancelled' });
    } catch (error) {
        console.error('Error deleting inbox item:', error);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ========================================================================
// Webhook Endpoints CRUD (authenticated)
// ========================================================================

/**
 * GET /orgs/:orgId/webhook-endpoints
 * List webhook endpoints for the org.
 */
router.get('/orgs/:orgId/webhook-endpoints', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const db = getDb();

        db.exec(`
            CREATE TABLE IF NOT EXISTS webhook_endpoints (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT 'Untitled',
                secret TEXT,
                payload_mapping_json TEXT DEFAULT '{}',
                default_org_id TEXT,
                default_agent TEXT DEFAULT 'quox',
                response_template_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        const rows = db.prepare(`
            SELECT id, name, enabled, payload_mapping_json, default_agent, created_at, updated_at
            FROM webhook_endpoints
            WHERE org_id = ?
            ORDER BY created_at DESC
        `).all(orgId);

        const endpoints = rows.map(r => ({
            id: r.id,
            name: r.name,
            enabled: !!r.enabled,
            payload_mapping: JSON.parse(r.payload_mapping_json || '{}'),
            default_agent: r.default_agent,
            webhook_url: `/webhook/inbound/${r.id}`,
            created_at: r.created_at,
            updated_at: r.updated_at
        }));

        res.json({ endpoints });
    } catch (error) {
        console.error('Error listing webhook endpoints:', error);
        res.status(500).json({ error: 'Failed to list endpoints' });
    }
});

/**
 * POST /orgs/:orgId/webhook-endpoints
 * Create a new webhook endpoint.
 */
router.post('/orgs/:orgId/webhook-endpoints', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { name, secret, payload_mapping, default_agent, response_template } = req.body;
        const db = getDb();

        db.exec(`
            CREATE TABLE IF NOT EXISTS webhook_endpoints (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT 'Untitled',
                secret TEXT,
                payload_mapping_json TEXT DEFAULT '{}',
                default_org_id TEXT,
                default_agent TEXT DEFAULT 'quox',
                response_template_json TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);

        const id = ulid();
        let encryptedSecret = null;
        if (secret) {
            try {
                const { encrypt } = await import('../utils/encryption.js');
                encryptedSecret = encrypt(secret);
            } catch {
                encryptedSecret = secret;
            }
        }

        db.prepare(`
            INSERT INTO webhook_endpoints (id, org_id, name, secret, payload_mapping_json, default_org_id, default_agent, response_template_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            orgId,
            name || 'Untitled',
            encryptedSecret,
            JSON.stringify(payload_mapping || {}),
            orgId,
            default_agent || 'quox',
            response_template ? JSON.stringify(response_template) : null
        );

        res.json({
            id,
            name: name || 'Untitled',
            webhook_url: `/webhook/inbound/${id}`,
            enabled: true
        });
    } catch (error) {
        console.error('Error creating webhook endpoint:', error);
        res.status(500).json({ error: 'Failed to create endpoint' });
    }
});

/**
 * PUT /orgs/:orgId/webhook-endpoints/:endpointId
 * Update a webhook endpoint.
 */
router.put('/orgs/:orgId/webhook-endpoints/:endpointId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, endpointId } = req.params;
        const { name, secret, payload_mapping, default_agent, response_template, enabled } = req.body;
        const db = getDb();

        const existing = db.prepare('SELECT id FROM webhook_endpoints WHERE id = ? AND org_id = ?').get(endpointId, orgId);
        if (!existing) {
            return res.status(404).json({ error: 'Endpoint not found' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (payload_mapping !== undefined) { updates.push('payload_mapping_json = ?'); params.push(JSON.stringify(payload_mapping)); }
        if (default_agent !== undefined) { updates.push('default_agent = ?'); params.push(default_agent); }
        if (response_template !== undefined) { updates.push('response_template_json = ?'); params.push(JSON.stringify(response_template)); }
        if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
        if (secret !== undefined) {
            let encryptedSecret = null;
            if (secret) {
                try {
                    const { encrypt } = await import('../utils/encryption.js');
                    encryptedSecret = encrypt(secret);
                } catch {
                    encryptedSecret = secret;
                }
            }
            updates.push('secret = ?');
            params.push(encryptedSecret);
        }

        if (updates.length > 0) {
            updates.push("updated_at = datetime('now')");
            params.push(endpointId, orgId);
            db.prepare(`UPDATE webhook_endpoints SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...params);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating webhook endpoint:', error);
        res.status(500).json({ error: 'Failed to update endpoint' });
    }
});

/**
 * DELETE /orgs/:orgId/webhook-endpoints/:endpointId
 * Delete a webhook endpoint.
 */
router.delete('/orgs/:orgId/webhook-endpoints/:endpointId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, endpointId } = req.params;
        const db = getDb();

        const result = db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND org_id = ?').run(endpointId, orgId);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Endpoint not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting webhook endpoint:', error);
        res.status(500).json({ error: 'Failed to delete endpoint' });
    }
});

export default router;
