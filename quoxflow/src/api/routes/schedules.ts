/**
 * Schedule Routes
 *
 * Exposes active cron schedules and their next run times.
 * Also provides pause/resume/update mutation endpoints.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AppEnv } from '../types.js';
import { ScheduleExecutor } from '../../executors/schedule.executor.js';
import { WorkflowStore, WorkflowOrgScope } from '../stores/workflow-store.js';
import { resolveOrgScope, SYSTEM_SCOPE } from '../middleware/org-scope.js';
import { ExecutionStore } from '../stores/execution-store.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';
import { EventBus } from '../../events/event-bus.js';
import { ExecutionService } from '../services/execution-service.js';
import { envelopes, Intents } from '../../core/envelope.js';

interface ScheduleRoutesConfig {
  scheduleExecutor: ScheduleExecutor;
  workflowStore?: WorkflowStore;
  executionStore?: ExecutionStore;
  envelopeStore?: EnvelopeStore;
  executors?: ExecutorRegistry;
  eventBus?: EventBus;
}

/**
 * Mirrors workflow-store.ts's private LEGACY_ORG_ID sentinel ('default') —
 * see the identical helper + explanation in webhook-triggers.ts. A schedule
 * registration stamped with the legacy sentinel (workflow row not yet
 * backfilled to a real org) needs SYSTEM_SCOPE for workflowStore calls, not
 * the literal string — orgMatches() never matches LEGACY_ORG_ID by equality.
 */
const LEGACY_ORG_ID = 'default';
function toWorkflowScope(orgId: string): WorkflowOrgScope {
  return orgId === LEGACY_ORG_ID ? SYSTEM_SCOPE : orgId;
}

// Validation schemas
const UpdateScheduleSchema = z.object({
  expression: z.string().optional(),
  timezone: z.string().optional(),
  paused: z.boolean().optional(),
});

function success(c: { json: (data: unknown, status?: number) => Response; get: (key: string) => unknown }, data: unknown, status = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

/**
 * Build an execution callback for a schedule trigger.
 * Needs ExecutionService deps to fire the workflow when cron ticks.
 *
 * QF-MT WP4: `orgId` is the schedule registration's owning org (resolved by
 * the route from ScheduleExecutor.getActiveSchedules() before calling this),
 * threaded into the workflowStore lookup instead of the WP3 SYSTEM_SCOPE
 * stopgap — real org threading, not cross-org.
 */
export function buildScheduleCallback(
  config: ScheduleRoutesConfig,
  workflowId: string,
  nodeId: string,
  expression: string,
  orgId: string
): (() => void) | null {
  if (!config.workflowStore || !config.executionStore || !config.envelopeStore || !config.executors || !config.eventBus) {
    return null;
  }

  const executionService = new ExecutionService({
    store: config.envelopeStore,
    executors: config.executors,
    executionStore: config.executionStore,
    eventBus: config.eventBus,
  });

  return () => {
    config.workflowStore!.get(workflowId, toWorkflowScope(orgId)).then(stored => {
      if (!stored) return;
      executionService.executeAsync(stored.definition, {
        trigger: 'schedule',
        firedAt: new Date().toISOString(),
        expression,
      }, {
        // FND_01M55X6TRMDS63SDZK3TDS63SD: a cron fire runs as a named system actor, never as a user.
        actor: { kind: 'system', id: `schedule:${nodeId}` },
        triggeredBy: `system:schedule:${nodeId}`,
        orgId,
      }).catch(err => {
        console.error(`[Schedule] Execution failed for ${workflowId}:`, err instanceof Error ? err.message : err);
      });
    }).catch(err => {
      console.error(`[Schedule] Failed to load workflow ${workflowId}:`, err instanceof Error ? err.message : err);
    });
  };
}

export function createScheduleRoutes(config: ScheduleRoutesConfig) {
  const app = new Hono<AppEnv>();

  // GET / - List all active and paused schedules
  app.get('/', (c) => {
    // QF-MT WP4: filter by caller scope — a tenant sees only its own org's
    // schedules; SYSTEM_SCOPE (service key, no X-Org-Id) sees all.
    const scope = resolveOrgScope(c);
    const schedules = config.scheduleExecutor.getActiveSchedules()
      .filter(s => scope.kind === 'system' || s.orgId === scope.orgId);
    return c.json({
      success: true,
      data: schedules.map(s => ({
        workflowId: s.workflowId,
        nodeId: s.nodeId,
        expression: s.expression,
        timezone: s.timezone,
        nextRun: s.nextRun?.toISOString() ?? null,
        active: s.active,
        orgId: s.orgId,
      })),
      meta: {
        count: schedules.length,
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    });
  });

  // PUT /:workflowId/:nodeId - Update schedule config
  app.put('/:workflowId/:nodeId', async (c) => {
    const { workflowId, nodeId } = c.req.param();

    // QF-MT WP4: resolve the target schedule's owning org BEFORE mutating.
    // Cross-org → 404 (hides existence, matches the by-id access rule for
    // every other resource in this stream).
    const scope = resolveOrgScope(c);
    const target = config.scheduleExecutor.getActiveSchedules()
      .find(s => s.workflowId === workflowId && s.nodeId === nodeId);
    if (!target || (scope.kind === 'org' && target.orgId !== scope.orgId)) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Schedule ${workflowId}:${nodeId} not found` },
      }, 404);
    }

    const body = await c.req.json();
    const parsed = UpdateScheduleSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid schedule update',
          details: parsed.error.flatten().fieldErrors,
        },
      }, 400);
    }

    const updates = parsed.data;
    const callback = buildScheduleCallback(config, workflowId, nodeId, updates.expression ?? '', target.orgId);

    if (!callback) {
      return c.json({
        success: false,
        error: { code: 'DEPS_MISSING', message: 'Execution dependencies not available for schedule update' },
      }, 500);
    }

    const ok = config.scheduleExecutor.updateSchedule(workflowId, nodeId, updates, callback);

    if (!ok) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Schedule ${workflowId}:${nodeId} not found` },
      }, 404);
    }

    // Persist the config change to the workflow definition
    if (config.workflowStore) {
      try {
        // QF-MT WP4: real org threading (target.orgId), replacing the WP3
        // SYSTEM_SCOPE stopgap — the schedule's owning org is now known.
        const stored = await config.workflowStore.get(workflowId, toWorkflowScope(target.orgId));
        if (stored) {
          const node = stored.definition.nodes.find(n => n.id === nodeId);
          if (node) {
            const rawConfig = node.config as Record<string, unknown>;
            if (updates.expression !== undefined) {
              rawConfig.expression = updates.expression;
              rawConfig.cron = updates.expression;
            }
            if (updates.timezone !== undefined) rawConfig.timezone = updates.timezone;
            if (updates.paused !== undefined) rawConfig.paused = updates.paused;
            await config.workflowStore.update(workflowId, toWorkflowScope(target.orgId), { nodes: stored.definition.nodes });
          }
        }
      } catch (err) {
        console.warn(`[Schedules] Failed to persist config for ${workflowId}:${nodeId}:`, err instanceof Error ? err.message : err);
      }
    }

    // AEE audit envelope
    try {
      if (config.envelopeStore) await config.envelopeStore.append(envelopes.event(Intents.SCHEDULE.UPDATED, c.get('correlationId'), { workflowId, nodeId, fields: Object.keys(updates) }));
    } catch { /* fire-and-forget */ }

    return success(c, { workflowId, nodeId, ...updates, updated: true });
  });

  // POST /:workflowId/:nodeId/pause - Pause schedule
  app.post('/:workflowId/:nodeId/pause', async (c) => {
    const { workflowId, nodeId } = c.req.param();

    // QF-MT WP4: resolve owning org BEFORE mutating — cross-org → 404.
    const scope = resolveOrgScope(c);
    const target = config.scheduleExecutor.getActiveSchedules()
      .find(s => s.workflowId === workflowId && s.nodeId === nodeId);
    if (!target || (scope.kind === 'org' && target.orgId !== scope.orgId)) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Active schedule ${workflowId}:${nodeId} not found` },
      }, 404);
    }

    const ok = config.scheduleExecutor.pauseSchedule(workflowId, nodeId);

    if (!ok) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Active schedule ${workflowId}:${nodeId} not found` },
      }, 404);
    }

    // Persist paused state
    if (config.workflowStore) {
      try {
        // QF-MT WP4: real org threading (target.orgId), replacing the WP3
        // SYSTEM_SCOPE stopgap.
        const stored = await config.workflowStore.get(workflowId, toWorkflowScope(target.orgId));
        if (stored) {
          const node = stored.definition.nodes.find(n => n.id === nodeId);
          if (node) {
            (node.config as Record<string, unknown>).paused = true;
            await config.workflowStore.update(workflowId, toWorkflowScope(target.orgId), { nodes: stored.definition.nodes });
          }
        }
      } catch (err) {
        console.warn(`[Schedules] Failed to persist pause for ${workflowId}:${nodeId}:`, err instanceof Error ? err.message : err);
      }
    }

    // AEE audit envelope
    try {
      if (config.envelopeStore) await config.envelopeStore.append(envelopes.event(Intents.SCHEDULE.PAUSED, c.get('correlationId'), { workflowId, nodeId }));
    } catch { /* fire-and-forget */ }

    return success(c, { workflowId, nodeId, active: false, paused: true });
  });

  // POST /:workflowId/:nodeId/resume - Resume paused schedule
  app.post('/:workflowId/:nodeId/resume', async (c) => {
    const { workflowId, nodeId } = c.req.param();

    // QF-MT WP4: resolve owning org BEFORE mutating — cross-org → 404.
    const scope = resolveOrgScope(c);

    // Build callback for resumed schedule
    const schedules = config.scheduleExecutor.getActiveSchedules();
    const paused = schedules.find(s => s.workflowId === workflowId && s.nodeId === nodeId && !s.active);

    if (!paused || (scope.kind === 'org' && paused.orgId !== scope.orgId)) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Paused schedule ${workflowId}:${nodeId} not found` },
      }, 404);
    }

    const callback = buildScheduleCallback(config, workflowId, nodeId, paused.expression, paused.orgId);

    if (!callback) {
      return c.json({
        success: false,
        error: { code: 'DEPS_MISSING', message: 'Execution dependencies not available for schedule resume' },
      }, 500);
    }

    const ok = config.scheduleExecutor.resumeSchedule(workflowId, nodeId, callback);

    if (!ok) {
      return c.json({
        success: false,
        error: { code: 'RESUME_FAILED', message: `Failed to resume schedule ${workflowId}:${nodeId}` },
      }, 500);
    }

    // Persist unpaused state
    if (config.workflowStore) {
      try {
        // QF-MT WP4: real org threading (paused.orgId), replacing the WP3
        // SYSTEM_SCOPE stopgap.
        const stored = await config.workflowStore.get(workflowId, toWorkflowScope(paused.orgId));
        if (stored) {
          const node = stored.definition.nodes.find(n => n.id === nodeId);
          if (node) {
            (node.config as Record<string, unknown>).paused = false;
            await config.workflowStore.update(workflowId, toWorkflowScope(paused.orgId), { nodes: stored.definition.nodes });
          }
        }
      } catch (err) {
        console.warn(`[Schedules] Failed to persist resume for ${workflowId}:${nodeId}:`, err instanceof Error ? err.message : err);
      }
    }

    // AEE audit envelope
    try {
      if (config.envelopeStore) await config.envelopeStore.append(envelopes.event(Intents.SCHEDULE.RESUMED, c.get('correlationId'), { workflowId, nodeId }));
    } catch { /* fire-and-forget */ }

    return success(c, { workflowId, nodeId, active: true, paused: false });
  });

  return app;
}
