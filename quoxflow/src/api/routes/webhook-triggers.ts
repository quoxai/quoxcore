/**
 * Webhook Trigger Routes
 *
 * Dynamic webhook endpoint that looks up registered webhook paths
 * and triggers the corresponding workflow.
 *
 * Routes: POST /webhooks/:path
 * Namespaced under /webhooks/ to avoid collisions with /api/ routes.
 */

import { Hono } from 'hono';
import { ulid } from 'ulid';
import { AppEnv } from '../types.js';
import { WorkflowStore, WorkflowOrgScope } from '../stores/workflow-store.js';
import { ApiError, ErrorCodes } from '../middleware/error-handler.js';
import { SYSTEM_SCOPE } from '../middleware/org-scope.js';
import { ExecutionService } from '../services/execution-service.js';
import { webhookResponseChannel, WebhookResponseChannel, DEFAULT_RESPONSE_TIMEOUT_MS } from '../webhook-response-channel.js';

export interface WebhookRegistration {
  path: string;
  method: string;
  workflowId: string;
  nodeId: string;
  // QF-MT WP4: owning org, stamped at register() time from the workflow
  // row's authoritative org_id (stored.orgId ?? stored.metadata.orgId).
  // Used to filter GET /api/triggers/webhooks by caller scope and to reject
  // cross-org path collisions below.
  orgId: string;
  // Fire-count / last-fired-at — in-memory only, same lifetime/scope as the
  // rest of WebhookRegistry (reset on process restart, populated on
  // activate). Not durable — a full audit trail lives in the execution
  // store's triggeredBy field instead.
  fireCount: number;
  lastFiredAt: string | null;
}

/**
 * Registry for active webhook trigger paths.
 * Populated during bootstrap and updated on activate/deactivate.
 */
export class WebhookRegistry {
  private webhooks: Map<string, WebhookRegistration> = new Map();

  /**
   * QF-MT WP4: `orgId` is mandatory — every registration is stamped with the
   * owning workflow's org. If `path` is already registered to a DIFFERENT
   * org, registration is rejected loudly (workflow activation fails) rather
   * than silently last-write-winning across tenants. Same-org re-register
   * (e.g. re-activating the same workflow) keeps the existing behavior:
   * full overwrite, fireCount/lastFiredAt reset. Full per-org path
   * namespacing (`/webhooks/:org/:path`) is explicitly deferred — this only
   * closes the cross-org collision, it does not change the public URL shape.
   */
  register(path: string, workflowId: string, nodeId: string, orgId: string, method = 'POST'): void {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const existing = this.webhooks.get(normalizedPath);
    if (existing && existing.orgId !== orgId) {
      throw new ApiError(
        ErrorCodes.WEBHOOK_PATH_CONFLICT,
        `Webhook path "/${normalizedPath}" is already registered to a different organization — cross-org path collision rejected`,
        409
      );
    }
    this.webhooks.set(normalizedPath, {
      path: normalizedPath,
      method: method.toUpperCase(),
      workflowId,
      nodeId,
      orgId,
      fireCount: 0,
      lastFiredAt: null,
    });
  }

  unregisterWorkflow(workflowId: string): void {
    for (const [path, reg] of this.webhooks) {
      if (reg.workflowId === workflowId) {
        this.webhooks.delete(path);
      }
    }
  }

  lookup(path: string): WebhookRegistration | null {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return this.webhooks.get(normalizedPath) ?? null;
  }

  /** Record an inbound hit for a registered path — increments fireCount and stamps lastFiredAt. */
  recordFire(path: string): void {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const reg = this.webhooks.get(normalizedPath);
    if (!reg) return;
    reg.fireCount += 1;
    reg.lastFiredAt = new Date().toISOString();
  }

  getAll(): WebhookRegistration[] {
    return Array.from(this.webhooks.values());
  }

  clear(): void {
    this.webhooks.clear();
  }
}

/**
 * Mirrors workflow-store.ts's private LEGACY_ORG_ID sentinel ('default') —
 * the org value stamped on rows that haven't been through the operator-run
 * backfill script yet (STREAM_QUOXFLOW_MULTITENANCY_PLAN.md §5). The store
 * doesn't export the constant, so it's kept in sync deliberately here.
 *
 * orgMatches() in workflow-store.ts never matches LEGACY_ORG_ID by literal
 * equality (by design — legacy rows are visible to SYSTEM_SCOPE only, never
 * to a tenant even one literally named 'default'). A registration stamped
 * with the legacy sentinel therefore can't be looked up with that literal
 * string — it needs SYSTEM_SCOPE, or every not-yet-backfilled deployment's
 * webhooks/schedules would 404 the moment WP4 lands. See toWorkflowScope().
 */
const LEGACY_ORG_ID = 'default';

/** Translate a registration's stamped orgId into the WorkflowOrgScope needed
 * for a workflowStore call — see LEGACY_ORG_ID above. */
function toWorkflowScope(orgId: string): WorkflowOrgScope {
  return orgId === LEGACY_ORG_ID ? SYSTEM_SCOPE : orgId;
}

interface WebhookTriggerRoutesConfig {
  workflowStore: WorkflowStore;
  executionService: ExecutionService;
  webhookRegistry: WebhookRegistry;
  /** MACHINERY: sync-hold response channel. Defaults to the module singleton. */
  responseChannel?: WebhookResponseChannel;
  /** MACHINERY: how long to hold the request open awaiting a respondToWebhook node. Default 30s. */
  responseTimeoutMs?: number;
}

export function createWebhookTriggerRoutes(config: WebhookTriggerRoutesConfig) {
  const app = new Hono<AppEnv>();
  const responseChannel = config.responseChannel ?? webhookResponseChannel;
  const responseTimeoutMs = config.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

  // POST /:path+ — catch-all for webhook paths
  app.post('/:path{.+}', async c => {
    const path = c.req.param('path');
    const registration = config.webhookRegistry.lookup(path);

    if (!registration) {
      return c.json({
        success: false,
        error: {
          code: 'WEBHOOK_NOT_FOUND',
          message: `No active webhook registered for path: /${path}`,
        },
      }, 404);
    }

    // Fire-count / last-fired-at — record every inbound hit against a
    // registered path, regardless of whether the workflow turns out to be
    // active or execution succeeds. In-memory (see WebhookRegistry note).
    config.webhookRegistry.recordFire(path);

    // Get the workflow. QF-MT WP4: the registration now carries the owning
    // org (stamped at register() time) — use it directly instead of
    // SYSTEM_SCOPE. Public ingress stays unauthenticated (tenant is implied
    // by the registered path), but the lookup is now genuinely org-scoped.
    const stored = await config.workflowStore.get(registration.workflowId, toWorkflowScope(registration.orgId));
    if (!stored || !stored.active) {
      return c.json({
        success: false,
        error: {
          code: 'WORKFLOW_INACTIVE',
          message: `Workflow ${registration.workflowId} is not active`,
        },
      }, 404);
    }

    // Parse request body as trigger data
    let triggerData: unknown;
    try {
      const contentType = c.req.header('content-type') || '';
      if (contentType.includes('application/json')) {
        triggerData = await c.req.json();
      } else {
        triggerData = { body: await c.req.text() };
      }
    } catch {
      triggerData = {};
    }

    // MACHINERY: if the workflow contains a respondToWebhook node, hold this
    // request open and let that node's executor supply the real HTTP
    // response. Otherwise keep the exact existing fire-and-forget 202.
    const hasRespondNode = stored.definition.nodes.some(n => n.type === 'respondToWebhook');

    // Execute the workflow asynchronously
    try {
      // Pre-generate the executionId so the pending response slot can be
      // registered BEFORE executeAsync's background pipeline run starts —
      // otherwise the respond node could fire before we're listening.
      const executionId = hasRespondNode ? ulid() : undefined;
      const pending = hasRespondNode && executionId
        ? responseChannel.createPending(executionId, responseTimeoutMs)
        : undefined;

      const resultExecutionId = await config.executionService.executeAsync(
        stored.definition,
        {
          trigger: 'webhook',
          path: `/${path}`,
          method: c.req.method,
          headers: Object.fromEntries(c.req.raw.headers.entries()),
          data: triggerData,
          receivedAt: new Date().toISOString(),
        },
        {
          triggeredBy: `webhook:${registration.nodeId}`,
          // QF-MT WP4: attribute the fired execution to the registration's
          // org so downstream execution/envelope/evidence writes (WP5)
          // carry the correct tenant, even though this route is public.
          orgId: registration.orgId,
          ...(executionId ? { executionId } : {}),
          ...(hasRespondNode
            ? {
                onExecutionFailed: (error: { code: string; message: string }) => {
                  responseChannel.resolve(executionId as string, {
                    status: 500,
                    body: { success: false, error },
                  });
                },
              }
            : {}),
        }
      );

      if (pending) {
        const resolved = await pending;
        if (resolved) {
          return c.json(resolved.body as any, resolved.status as any, resolved.headers);
        }
        // Timeout — no respondToWebhook node fired in time. Fall back to
        // the standard fire-and-forget 202 behavior below.
      }

      return c.json({
        success: true,
        data: {
          executionId: resultExecutionId,
          workflowId: registration.workflowId,
          status: 'running',
          message: 'Webhook received, workflow execution started',
        },
      }, 202);
    } catch (err) {
      return c.json({
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      }, 500);
    }
  });

  return app;
}
