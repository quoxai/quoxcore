/**
 * Triggers Route — STUDY-REV-2 P8.A
 *
 * Read-only enumerator for all active trigger subscriptions across workflows.
 *
 * Routes:
 *   GET /api/triggers/webhooks   — registered webhook paths from WebhookRegistry
 *   GET /api/triggers/schedules  — active cron schedules (or tasks-owned note)
 *   GET /api/triggers/events     — EventBus subscriptions per workflow
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { WebhookRegistry } from './webhook-triggers.js';
import { EventBus } from '../../events/event-bus.js';
import { ScheduleExecutor } from '../../executors/schedule.executor.js';
import { resolveOrgScope } from '../middleware/org-scope.js';

interface TriggersRoutesConfig {
  webhookRegistry: WebhookRegistry;
  eventBus: EventBus;
  /** Required when quoxflowOwnScheduler is true. */
  scheduleExecutor?: ScheduleExecutor;
  /** True only when QUOXFLOW_OWN_SCHEDULER env var is set. */
  quoxflowOwnScheduler: boolean;
}

function success(c: Context<AppEnv>, data: unknown) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId') || 'unknown',
        timestamp: new Date().toISOString(),
      },
    },
    200
  );
}

export function createTriggersRoutes(config: TriggersRoutesConfig) {
  const app = new Hono<AppEnv>();

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  /**
   * GET /api/triggers/webhooks
   *
   * Lists all registered webhook trigger paths from WebhookRegistry.
   * The registry is in-memory and populated on workflow activate.
   *
   * fireCount / lastFiredAt are tracked in-memory on WebhookRegistry
   * (recordFire(), called from webhook-triggers.ts on every inbound hit).
   * Not durable — reset on process restart, same lifetime as the rest of
   * the registry.
   */
  app.get('/webhooks', c => {
    // QF-MT WP4: filter by caller scope — a tenant sees only its own org's
    // registered webhook paths; SYSTEM_SCOPE (service key, no X-Org-Id) sees
    // all. Was: unfiltered enumeration of every org's webhook paths (#50).
    const scope = resolveOrgScope(c);
    const all = config.webhookRegistry.getAll().filter(wh => scope.kind === 'system' || wh.orgId === scope.orgId);

    const webhooks = all.map(wh => ({
      workflowId: wh.workflowId,
      nodeId: wh.nodeId,
      path: wh.path,
      method: wh.method,
      lastFiredAt: wh.lastFiredAt,
      fireCount: wh.fireCount,
      orgId: wh.orgId,
    }));

    return success(c, { webhooks });
  });

  // ─── Schedules ────────────────────────────────────────────────────────────

  /**
   * GET /api/triggers/schedules
   *
   * When QUOXFLOW_OWN_SCHEDULER is false (the common QuoxCORE deployment),
   * schedules are owned by the tasks service. Return an empty list with a
   * note so the dashboard knows to fall back to /schedules (tasks side).
   *
   * When QUOXFLOW_OWN_SCHEDULER is true, enumerate active cron jobs from
   * ScheduleExecutor with next-fire estimates from croner.
   */
  app.get('/schedules', c => {
    if (!config.quoxflowOwnScheduler || !config.scheduleExecutor) {
      return success(c, {
        schedules: [],
        owned_by: 'tasks',
        note: 'Schedules are managed by the tasks service. View at /schedules in the dashboard.',
      });
    }

    // QF-MT WP4: filter by caller scope — see /webhooks above.
    const scope = resolveOrgScope(c);
    const active = config.scheduleExecutor.getActiveSchedules()
      .filter(s => scope.kind === 'system' || s.orgId === scope.orgId);
    const schedules = active.map(s => ({
      workflowId: s.workflowId,
      nodeId: s.nodeId,
      expression: s.expression,
      timezone: s.timezone,
      nextFireAt: s.nextRun?.toISOString() ?? null,
      active: s.active,
      orgId: s.orgId,
    }));

    return success(c, { schedules, owned_by: 'quoxflow' });
  });

  // ─── Events ───────────────────────────────────────────────────────────────

  /**
   * GET /api/triggers/events
   *
   * Lists all active EventBus subscriptions. The bus exposes them via
   * getSubscriptions() which returns pattern + workflowId + once flag.
   *
   * Last-match timestamps are NOT tracked by EventBus today.
   * Returned as null (surfaced in the dashboard column with "—").
   *
   * Note: the build doc calls for a list() method on EventBus; the existing
   * getSubscriptions() already returns the required shape. We expose it here
   * unchanged — no EventBus extension was needed.
   */
  app.get('/events', c => {
    // QF-MT WP4: filter by caller scope — see /webhooks above. Subscriptions
    // without an orgId (legacy/non-workflow-scoped internal pub/sub) are
    // visible to SYSTEM_SCOPE only, never leaked to a tenant.
    const scope = resolveOrgScope(c);
    const subs = config.eventBus.getSubscriptions()
      .filter(sub => scope.kind === 'system' || sub.orgId === scope.orgId);

    const subscriptions = subs.map(sub => ({
      id: sub.id,
      pattern: sub.pattern,
      workflowId: sub.workflowId ?? null,
      once: sub.once,
      orgId: sub.orgId ?? null,
      // EventBus does not track last-match timestamps.
      // TODO: add per-subscription last-match tracking to EventBus (P8.A follow-up).
      lastMatchAt: null as string | null,
    }));

    return success(c, { subscriptions });
  });

  return app;
}
