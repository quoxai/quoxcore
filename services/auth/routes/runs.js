/**
 * Workflow Run Routes for Quox Auth Service
 * Phase C.1: Workflow execution tracking
 *
 * Runs are instances of workflow executions.
 */

import { requireHumanDecider } from '../utils/principal.js';
import { Router } from 'express';
import { prepare, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { Capabilities } from '../utils/policy.js';
import { resolveCap } from '../utils/resolveCap.js';
import { createAuditEvent, ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';

const router = Router();

router.use(requireAuth);

// Run statuses
const RUN_STATUSES = ['pending', 'running', 'waiting_on_human', 'completed', 'failed', 'cancelled', 'expired'];

// Run event types
const EVENT_TYPES = [
    'run_started', 'run_completed', 'run_failed', 'run_cancelled',
    'step_started', 'step_completed', 'step_failed', 'step_skipped',
    'human_requested', 'human_responded', 'human_timeout',
    'retry_scheduled', 'retry_started'
];

// ============================================================================
// STALE RUN SWEEPER — fleet #376
//
// workflows.timeout_seconds (default 300) was written at create time and
// read by nothing, and the 'expired' status above was defined but never
// set by anything. A run could therefore sit in 'running' forever with a
// null finished_at and no error.
//
// Server-side interval, mirroring the stale-backup sweeper in
// routes/backups.js (~line 128) — deliberately NOT a browser timer, per
// the project's data-persistence rules.
//
// Scope note: this makes stuck runs honest (they expire and say why); it
// does NOT make them execute. On the workflow_steps model there is
// currently no executor at all — see fleet #378, which is an open
// architectural decision. When an executor is wired, this sweeper becomes
// a real timeout rather than a reaper for phantom runs. Run creation on
// this path now refuses with 422 (same issue), so the sweeper only matters
// for rows predating that guard.
// ============================================================================

const DEFAULT_RUN_TIMEOUT_SECONDS = 300;
const RUN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function markExpiredRuns() {
    try {
        // Per-workflow timeout via join; COALESCE covers rows predating the
        // column default. Uses started_at, falling back to created_at for
        // runs still 'pending' that never started.
        const result = prepare(`
            UPDATE runs SET
                status = 'expired',
                error_message = 'Exceeded timeout_seconds (' || CAST((
                    SELECT COALESCE(w.timeout_seconds, ?) FROM workflows w WHERE w.id = runs.workflow_id
                ) AS INTEGER) || ')',
                finished_at = datetime('now'),
                updated_at = datetime('now')
            WHERE status IN ('pending', 'running')
              AND datetime(COALESCE(started_at, created_at), '+' || (
                    SELECT COALESCE(w.timeout_seconds, ?) FROM workflows w WHERE w.id = runs.workflow_id
                  ) || ' seconds') < datetime('now')
        `).run(DEFAULT_RUN_TIMEOUT_SECONDS, DEFAULT_RUN_TIMEOUT_SECONDS);

        if (result.changes > 0) {
            console.log(`[Runs] Marked ${result.changes} run(s) as expired (exceeded timeout_seconds)`);
        }
        return result.changes;
    } catch (err) {
        console.error('[Runs] Failed to sweep expired runs:', err.message);
        return 0;
    }
}

// Sweep on startup and every 5 minutes, same cadence as the backup sweeper.
markExpiredRuns();
setInterval(markExpiredRuns, RUN_SWEEP_INTERVAL_MS).unref?.();

/**
 * GET /orgs/:orgId/runs
 * List workflow runs
 */
router.get('/orgs/:orgId/runs', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { workflow_id, status, initiated_by, page, limit } = req.query;
        const pagination = getPagination({ page, limit });

        let conditions = ['r.org_id = ?'];
        let params = [orgId];

        if (workflow_id) {
            conditions.push('r.workflow_id = ?');
            params.push(workflow_id);
        }

        if (status) {
            conditions.push('r.status = ?');
            params.push(status);
        }

        if (initiated_by) {
            conditions.push('r.initiated_by_id = ?');
            params.push(initiated_by);
        }

        // Count total
        const countResult = prepare(`
            SELECT COUNT(*) as total FROM runs r
            WHERE ${conditions.join(' AND ')}
        `).get(...params);

        // Get runs with workflow info
        const runs = prepare(`
            SELECT r.*,
                   w.name as workflow_name, w.slug as workflow_slug,
                   u.display_name as initiated_by_name
            FROM runs r
            LEFT JOIN workflows w ON r.workflow_id = w.id
            LEFT JOIN users u ON r.initiated_by_type = 'user' AND r.initiated_by_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, pagination.limit, pagination.offset);

        res.json(formatPaginatedResponse(runs, countResult.total, pagination));
    } catch (error) {
        console.error('Error listing runs:', error);
        res.status(500).json({ error: 'Failed to list runs' });
    }
});

/**
 * GET /orgs/:orgId/runs/stats
 * Get run statistics
 * NOTE: Must be before :runId route to avoid matching 'stats' as a runId
 */
router.get('/orgs/:orgId/runs/stats', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { workflow_id, days } = req.query;
        const daysBack = parseInt(days) || 7;

        let conditions = ['org_id = ?'];
        let params = [orgId];

        if (workflow_id) {
            conditions.push('workflow_id = ?');
            params.push(workflow_id);
        }

        conditions.push(`created_at >= datetime('now', '-${daysBack} days')`);

        const stats = prepare(`
            SELECT
                status,
                COUNT(*) as count
            FROM runs
            WHERE ${conditions.join(' AND ')}
            GROUP BY status
        `).all(...params);

        const avgDuration = prepare(`
            SELECT
                AVG(CAST((julianday(finished_at) - julianday(started_at)) * 24 * 60 * 60 AS INTEGER)) as avg_seconds
            FROM runs
            WHERE ${conditions.join(' AND ')} AND finished_at IS NOT NULL
        `).get(...params);

        res.json({
            by_status: stats.reduce((acc, s) => ({ ...acc, [s.status]: s.count }), {}),
            total: stats.reduce((sum, s) => sum + s.count, 0),
            avg_duration_seconds: Math.round(avgDuration?.avg_seconds || 0),
            period_days: daysBack
        });
    } catch (error) {
        console.error('Error getting run stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

/**
 * GET /orgs/:orgId/runs/:runId
 * Get a single run with events
 */
router.get('/orgs/:orgId/runs/:runId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, runId } = req.params;

        const run = prepare(`
            SELECT r.*,
                   w.name as workflow_name, w.slug as workflow_slug,
                   w.definition_json as workflow_definition,
                   u.display_name as initiated_by_name
            FROM runs r
            LEFT JOIN workflows w ON r.workflow_id = w.id
            LEFT JOIN users u ON r.initiated_by_type = 'user' AND r.initiated_by_id = u.id
            WHERE r.id = ? AND r.org_id = ?
        `).get(runId, orgId);

        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }

        // Get events
        const events = prepare(`
            SELECT * FROM run_events
            WHERE run_id = ?
            ORDER BY created_at ASC
        `).all(runId);

        // Get associated inbox items
        const inboxItems = prepare(`
            SELECT ii.id, ii.kind, ii.status, ii.title, ii.priority, ii.created_at, ii.resolved_at
            FROM inbox_items ii
            WHERE ii.run_id = ?
            ORDER BY ii.created_at DESC
        `).all(runId);

        res.json({
            run: {
                ...run,
                context: run.context_json ? JSON.parse(run.context_json) : {},
                result: run.result_json ? JSON.parse(run.result_json) : null,
                workflow_definition: run.workflow_definition ? JSON.parse(run.workflow_definition) : null
            },
            events: events.map(e => ({
                ...e,
                payload: e.payload_json ? JSON.parse(e.payload_json) : {}
            })),
            inbox_items: inboxItems
        });
    } catch (error) {
        console.error('Error getting run:', error);
        res.status(500).json({ error: 'Failed to get run' });
    }
});

/**
 * POST /orgs/:orgId/runs
 * Start a new workflow run
 */
router.post('/orgs/:orgId/runs', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { workflow_id, context } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.RUNTIME_RUN_WORKFLOW)) {
            return res.status(403).json({ error: 'Insufficient permissions to run workflows' });
        }

        // Verify workflow exists and is active
        const workflow = prepare(`
            SELECT * FROM workflows WHERE id = ? AND org_id = ? AND status = 'active'
        `).get(workflow_id, orgId);

        if (!workflow) {
            return res.status(404).json({ error: 'Workflow not found or not active' });
        }

        // fleet #378: nothing in the codebase consumes runs on this model. There is
        // no executor reading pending/running rows, quoxflow never reads this table,
        // and the only step-event emitter (BrowserQ's in-process EventEmitter) is
        // unrelated to this route. Creating a run here therefore manufactures a
        // 'running' state that nothing ever advances, and only the #376 expiry
        // sweeper ever touches it again, to mark it 'expired' once its timeout
        // passes. Refuse loudly instead of creating that phantom run.
        //
        // The insert/event/audit block below is left intact for when a real
        // executor is wired: it becomes unreachable dead code below this guard,
        // that is intentional, replace this guard with a real dispatch at that point.
        return res.status(422).json({
            error: 'Workflow has no execution engine attached',
            detail: 'Runs created on this endpoint are never executed: no engine consumes the workflow_steps model (fleet #378). Execute workflows through the quoxflow engine surface instead.'
        });

        const runId = ulid();
        const now = new Date().toISOString();

        // Create run
        prepare(`
            INSERT INTO runs (id, org_id, workflow_id, status, initiated_by_type, initiated_by_id, context_json, started_at)
            VALUES (?, ?, ?, 'running', 'user', ?, ?, ?)
        `).run(runId, orgId, workflow_id, userId, JSON.stringify(context || {}), now);

        // Create run_started event
        prepare(`
            INSERT INTO run_events (id, run_id, event_type, payload_json)
            VALUES (?, ?, 'run_started', ?)
        `).run(ulid(), runId, JSON.stringify({ workflow_name: workflow.name }));

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'run.started',
            targetType: 'workflow',
            targetId: workflow_id,
            metadata: { run_id: runId }
        });

        res.status(201).json({
            run: {
                id: runId,
                org_id: orgId,
                workflow_id,
                workflow_name: workflow.name,
                status: 'running',
                started_at: now,
                context: context || {}
            }
        });
    } catch (error) {
        console.error('Error starting run:', error);
        res.status(500).json({ error: 'Failed to start run' });
    }
});

/**
 * POST /orgs/:orgId/runs/:runId/events
 * Add an event to a run (for workflow engine)
 */
router.post('/orgs/:orgId/runs/:runId/events', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, runId } = req.params;
        const { event_type, step_idx, payload } = req.body;

        if (!EVENT_TYPES.includes(event_type)) {
            return res.status(400).json({ error: 'Invalid event type' });
        }

        // Verify run exists
        const run = prepare(`SELECT id, status FROM runs WHERE id = ? AND org_id = ?`).get(runId, orgId);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }

        // Create event
        const eventId = ulid();
        prepare(`
            INSERT INTO run_events (id, run_id, step_idx, event_type, payload_json)
            VALUES (?, ?, ?, ?, ?)
        `).run(eventId, runId, step_idx || null, event_type, JSON.stringify(payload || {}));

        // Update run status based on event
        if (event_type === 'run_completed') {
            prepare(`UPDATE runs SET status = 'completed', finished_at = datetime('now'), result_json = ? WHERE id = ?`)
                .run(JSON.stringify(payload?.result || {}), runId);
        } else if (event_type === 'run_failed') {
            prepare(`UPDATE runs SET status = 'failed', finished_at = datetime('now'), error_message = ? WHERE id = ?`)
                .run(payload?.error || 'Unknown error', runId);
        } else if (event_type === 'human_requested') {
            prepare(`UPDATE runs SET status = 'waiting_on_human' WHERE id = ?`).run(runId);
        } else if (event_type === 'human_responded') {
            prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId);
        }

        res.status(201).json({ event_id: eventId });
    } catch (error) {
        console.error('Error adding run event:', error);
        res.status(500).json({ error: 'Failed to add event' });
    }
});

/**
 * POST /orgs/:orgId/runs/:runId/cancel
 * Cancel a running workflow
 */
router.post('/orgs/:orgId/runs/:runId/cancel', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, runId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        // Check capability
        if (!resolveCap(req, Capabilities.RUNTIME_RUN_WORKFLOW)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        const run = prepare(`SELECT * FROM runs WHERE id = ? AND org_id = ?`).get(runId, orgId);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }

        if (!['pending', 'running', 'waiting_on_human'].includes(run.status)) {
            return res.status(400).json({ error: 'Run cannot be cancelled in current state' });
        }

        // Update run status
        prepare(`
            UPDATE runs SET status = 'cancelled', finished_at = datetime('now'), error_message = ?
            WHERE id = ?
        `).run(reason || 'Cancelled by user', runId);

        // Create event
        prepare(`
            INSERT INTO run_events (id, run_id, event_type, payload_json)
            VALUES (?, ?, 'run_cancelled', ?)
        `).run(ulid(), runId, JSON.stringify({ cancelled_by: userId, reason }));

        // Cancel pending inbox items
        prepare(`
            UPDATE inbox_items SET status = 'cancelled', resolved_at = datetime('now')
            WHERE run_id = ? AND status IN ('open', 'in_progress')
        `).run(runId);

        // Audit
        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'run.cancelled',
            targetType: 'run',
            targetId: runId,
            metadata: { reason }
        });

        res.json({ message: 'Run cancelled' });
    } catch (error) {
        console.error('Error cancelling run:', error);
        res.status(500).json({ error: 'Failed to cancel run' });
    }
});

/**
 * POST /orgs/:orgId/runs/:runId/resume
 * Resume a run that was waiting on human (called after HITL response)
 */
router.post('/orgs/:orgId/runs/:runId/resume', requireOrgMembership, async (req, res) => {
    try {
        if (!requireHumanDecider(req, res)) return;
        const { orgId, runId } = req.params;
        const { response } = req.body;

        const run = prepare(`SELECT * FROM runs WHERE id = ? AND org_id = ?`).get(runId, orgId);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }

        if (run.status !== 'waiting_on_human') {
            return res.status(400).json({ error: 'Run is not waiting on human response' });
        }

        // Update run status
        prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId);

        // Create event
        prepare(`
            INSERT INTO run_events (id, run_id, event_type, payload_json)
            VALUES (?, ?, 'human_responded', ?)
        `).run(ulid(), runId, JSON.stringify(response || {}));

        res.json({ message: 'Run resumed', status: 'running' });
    } catch (error) {
        console.error('Error resuming run:', error);
        res.status(500).json({ error: 'Failed to resume run' });
    }
});

export default router;
