/**
 * Quoxflow API Application
 *
 * Hono app factory with middleware and route configuration.
 */

import { Hono } from 'hono';
import { AppEnv } from './types.js';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { correlationMiddleware } from './middleware/correlation.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimiter } from './middleware/rate-limit.js';
import { handleError, ErrorCodes } from './middleware/error-handler.js';
import { bodyLimit } from 'hono/body-limit';
import { createWorkflowRoutes } from './routes/workflows.js';
import { createExecutionRoutes, createWorkflowExecuteRoute } from './routes/executions.js';
import { createEnvelopeRoutes } from './routes/envelopes.js';
import { policyRoutes } from './routes/policies.js';
import { approvalRoutes } from './routes/approvals.js';
import { evidenceRoutes } from './routes/evidence.js';
import { createScheduleRoutes } from './routes/schedules.js';
import { createWorkflowLifecycleRoutes } from './routes/workflows-lifecycle.js';
import { createWebhookTriggerRoutes, WebhookRegistry } from './routes/webhook-triggers.js';
import { createSkillsRoutes } from './routes/skills.js';
import { createQuoxSkillsRoutes, createInternalSkillsRoutes, type SkillScoreboardReader } from './routes/quox-skills.js';
import { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { SkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../store/skill-firewall-log-store.js';
import type { LineageAnalyzerLlmClient } from '../pipeline/lineage-analyzer.js';
import { QuoxSkillPatchesStore } from '../store/quox-skill-patches-store.js';
import { QuoxSkillInvocationsStore } from '../store/quox-skill-invocations-store.js';
import type { SkillTestExecuteContext } from '../agentic/skill-test-runner.js';
import type { ToolsmithAdapter } from '../agentic/toolsmith-adapter.js';
import type { SkillDecayCron } from '../agentic/skill-decay-cron.js';
import type { SkillJudgeJob } from '../agentic/skill-judge-job.js';
import type { SkillSafetyJudgeJob } from '../agentic/skill-safety-judge-job.js';
import type { SkillReviewQueueStore } from '../store/skill-review-queue-store.js';
import type { SkillOverridesStore } from '../store/skill-overrides-store.js';
import { observationRoutes } from './routes/observations.js';
import { createTriggersRoutes } from './routes/triggers.js';
import { createBudgetsRoutes } from './routes/budgets.js';
import { createBudgetUsageRoutes } from './routes/budget-usage.js';
import { createApprovalTemplatesRoutes } from './routes/approval-templates.js';
import { createValidationRoutes } from './routes/validation.js';
import { createSessionSearchRoutes } from './routes/session-search.js';
import { createAgenticSkillActionsRoutes } from './routes/agentic-skill-actions.js';

import { WorkflowStore } from './stores/workflow-store.js';
import { ExecutionStore } from './stores/execution-store.js';
import { EnvelopeStore } from '../store/envelope-store.js';
import { SkillLibraryStore } from '../store/skill-library-store.js';
import type { SessionSearchStore } from '../agentic/session-search-actions.js';
import { InMemorySessionSearchStore } from '../store/session-search-store.js';
import type { PatchRateLimiter } from '../agentic/skill-patch-rate-limiter.js';
import { ExecutionHistoryStore } from '../store/execution-history-store.js';
import { ObservationStore } from '../store/observation-store.js';
import { PolicyStore, ApprovalTemplateStore } from '../policy/types.js';
import { ApprovalEngine } from '../approval/index.js';
import type { ApprovalStore } from '../approval/types.js';
import { EvidenceStore } from '../evidence/index.js';
import { ExecutorRegistry } from '../executors/executor.interface.js';
import { ScheduleExecutor } from '../executors/schedule.executor.js';
import { EventBus } from '../events/event-bus.js';
import { BudgetStore, BudgetScopeKind } from '../budget/budget-store.js';
import { BudgetEvaluator } from '../budget/budget-evaluator.js';
import { PolicyEvaluator } from '../policy/evaluator.js';
import { BudgetScopeContext } from '../pipeline/control-pipeline.js';
import { WorkflowService } from './services/workflow-service.js';
import { ExecutionService } from './services/execution-service.js';
import type { ReplayOnlyFlagsStore, ReplayOnlyResolveParams } from '../store/replay-only-flags-store.js';
import { createReplayOnlyFlagsRoutes } from './routes/replay-only-flags.js';
import type { SkillPackStore } from '../store/skill-pack-store.js';
import { createSkillPackRoutes } from './routes/skill-packs.js';

export interface AppConfig {
  workflowStore: WorkflowStore;
  executionStore: ExecutionStore;
  envelopeStore: EnvelopeStore;
  /** STUDY-REV W4: Skill Library persistence (Crystalliser output). */
  skillLibraryStore?: SkillLibraryStore;
  /** QSKL-1: QuoxSkills procedural-knowledge store. */
  quoxSkillsStore?: QuoxSkillsStore;
  /** QSKL-4.A: Skill patch audit log store. Defaults to new in-memory instance if not provided. */
  quoxSkillPatchesStore?: QuoxSkillPatchesStore;
  /** QSKL-7.8: Per-invocation telemetry store. Best-effort — writes skipped when absent. */
  quoxSkillInvocationsStore?: QuoxSkillInvocationsStore;
  /** STUDY-REV W4: Execution history feed for the Crystalliser. */
  executionHistoryStore?: ExecutionHistoryStore;
  /** STUDY-REV W2: per-step observation store (durable hooks input). */
  observationStore?: ObservationStore;
  policyStore?: PolicyStore;
  approvalEngine?: ApprovalEngine;
  /** R5.high-2: When provided, pending approvals are cancelled on workflow deactivate. */
  approvalStore?: ApprovalStore;
  evidenceStore?: EvidenceStore;
  scheduleExecutor?: ScheduleExecutor;
  eventBus?: EventBus;
  webhookRegistry?: WebhookRegistry;
  /** P8.B: Budget store for CRUD + usage ingestion routes. */
  budgetStore?: BudgetStore;
  /** P8.B: Budget evaluator — threaded into ControlPipeline so pre-exec budget checks fire. */
  budgetEvaluator?: BudgetEvaluator;
  /** P8.B: Resolves budget scope for a given workflowId + orgId. */
  budgetScopeResolver?: (workflowId: string, orgId?: string) => BudgetScopeContext | null;
  /** P8.C: Policy evaluator — threaded into ControlPipeline so per-node policy gates fire. */
  policyEvaluator?: PolicyEvaluator;
  /** REPLAY-ONLY .A-1a: flag store for the internal replay-only-flags CRUD route. */
  replayOnlyFlagsStore?: ReplayOnlyFlagsStore;
  /** REPLAY-ONLY .A-1a: resolves the effective replay_only flag for a run — threaded into
   * ControlPipeline (via ExecutionService) so context.effectiveReplayOnly actually fires. */
  replayOnlyResolver?: (params: ReplayOnlyResolveParams) => Promise<boolean>;
  /** P8.C: Approval template store for reusable approval rosters. */
  approvalTemplateStore?: ApprovalTemplateStore;
  executors: ExecutorRegistry;
  /** Enable JWT/service-key auth on all routes except /health. Default: false */
  authEnabled?: boolean;
  /** CORS origins. Default: '*' */
  corsOrigins?: string[];
  /** QSKL-5.E: Optional skill test execution context. When present, POST /:id/run-tests is functional. */
  executeSkillContext?: SkillTestExecuteContext;
  /** QSKL-6.6: Optional Toolsmith adapter. When present, POST /api/internal/tool-published is functional. */
  toolsmithAdapter?: ToolsmithAdapter;
  /** QSKL-7.7a: Optional scoreboard reader. When present, GET /api/quox-skills/:id/scoreboard and /scoreboards are functional. */
  skillScoreboardReader?: SkillScoreboardReader;
  /** QSKL-11a: Optional skill-decay cron. When present, POST /api/internal/skill-decay/run is functional. */
  skillDecayCron?: SkillDecayCron;
  /** QSKL-11b: Optional skill-judge job. When present, POST /api/internal/skill-judge/run is functional. */
  skillJudgeJob?: SkillJudgeJob;
  /** QSKL-13: Session FTS search store. Enables session_search agentic action. */
  sessionSearchStore?: SessionSearchStore;
  /** QSKL-14a: Per-agent patch rate-limiter. When provided, agent patches are rate-limited. */
  patchRateLimiter?: PatchRateLimiter;
  /** QSKL-SAFETY.B: Firewall instance. Injected into agenticExecutor via setSkillFirewall(). */
  skillFirewall?: SkillFirewall;
  /** QSKL-SAFETY.B: Firewall log store. Injected into agenticExecutor via setSkillFirewallLogStore(). */
  skillFirewallLogStore?: SkillFirewallLogStore;
  /** QSKL-SAFETY.E: Safety judge job. When present, POST /api/internal/skill-safety-judge/run is functional. */
  skillSafetyJudgeJob?: SkillSafetyJudgeJob;
  /** QSKL-SAFETY.E: Review queue store. Injected into agenticExecutor + quox-skills routes for promotion gate. */
  skillReviewQueueStore?: SkillReviewQueueStore;
  /** QSKL-HARDEN HRD-1: Skill overrides store. Injected into quox-skills routes for read-path merge + override CRUD. */
  skillOverridesStore?: SkillOverridesStore;
  /** MEM-DECAY MD.3: lineage graph LLM client, forwarded to ExecutionService ->
   * durable-hooks.ts. Optional; absent means parent pointers are still
   * recorded but no failure lesson is ever generated. */
  lineageLlmClient?: LineageAnalyzerLlmClient;
  /** DEVSUITE-SKILLS Phase 2 gap-fix: Skill Pack store. When present,
   * GET /api/skill-packs/:id/verify is functional. */
  skillPackStore?: SkillPackStore;
}

export function createApp(config: AppConfig) {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', logger());
  app.use('*', cors({
    origin: config.corsOrigins ?? ['http://localhost:3000'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Service-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Correlation-ID'],
  }));
  app.use('*', correlationMiddleware);

  // Authentication (optional, enabled via config)
  if (config.authEnabled) {
    app.use('*', authMiddleware);
  } else {
    console.warn('[QuoxFlow] WARNING: Authentication is DISABLED. All API endpoints are publicly accessible. Set authEnabled: true for production.');
  }

  // Rate limiting: 30 requests/sec for API, 10 requests/sec for webhooks
  app.use('/api/*', rateLimiter({ maxRequests: 30, windowMs: 1000 }));
  // QUOXTRUST F15 (engagement c4): the /webhooks route is public and was
  // UNLIMITED — the comment above claimed "10 requests/sec for webhooks" but it
  // was never wired (DoS surface + claim-vs-code gap). Same per-IP-per-path
  // middleware as /api (internal service-key callers bypass), at the documented
  // 10/s. Applied here so it covers the /webhooks route mounted below.
  app.use('/webhooks/*', rateLimiter({ maxRequests: 10, windowMs: 1000 }));

  // Body size limits: 10MB for workflow import, 1MB for everything else
  app.use('/api/workflows/import-n8n', bodyLimit({ maxSize: 10 * 1024 * 1024 }));
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }));

  // Global error handler
  app.onError((err, c) => {
    return handleError(c, err);
  });

  // Health check
  app.get('/health', c =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      activeSchedules: config.scheduleExecutor?.activeCount ?? 0,
    })
  );

  // Create services
  const workflowService = new WorkflowService(config.executors);
  const executionService = new ExecutionService({
    store: config.envelopeStore,
    executors: config.executors,
    executionStore: config.executionStore,
    eventBus: config.eventBus,
    // STUDY-REV W2 + AOCL wire (Sprint 1 SC#3): forward the durable-hooks
    // stores so the production pipeline writes observations + AOCL evidence
    // and auto-promotes proven workflows to the Skill Library. Each is
    // optional in AppConfig; ExecutionService only builds the hooks block
    // if all three of (observation / history / skill) are present.
    observationStore: config.observationStore,
    executionHistoryStore: config.executionHistoryStore,
    skillLibraryStore: config.skillLibraryStore,
    evidenceStore: config.evidenceStore,
    // P8.B + P8.C: thread evaluators so the ControlPipeline guards actually fire.
    // Without these, budgetEvaluator and policyEvaluator are always undefined
    // inside ControlPipeline and the if-guards are permanently false.
    budgetEvaluator: config.budgetEvaluator,
    budgetScopeResolver: config.budgetScopeResolver,
    policyEvaluator: config.policyEvaluator,
    // REPLAY-ONLY .A-1a: wire the resolver so context.effectiveReplayOnly fires in production
    replayOnlyResolver: config.replayOnlyResolver,
    approvalEngine: config.approvalEngine,
    // MACHINERY: same firewall + log store instances wired into agenticExecutor,
    // so the run-completion task-time promotion sweep uses the identical gate.
    skillFirewall: config.skillFirewall,
    skillFirewallLogStore: config.skillFirewallLogStore,
    // MEM-DECAY MD.3: lineage graph — forwarded to durable-hooks.ts.
    lineageLlmClient: config.lineageLlmClient,
  });

  // Create route handlers
  const workflowRoutes = createWorkflowRoutes({
    workflowStore: config.workflowStore,
    workflowService,
    executionStore: config.executionStore,
    envelopeStore: config.envelopeStore,
    executors: config.executors,
    scheduleExecutor: config.scheduleExecutor,
    eventBus: config.eventBus,
    // Delete unregisters the workflow's webhook paths too (a stale path blocked reuse, 2026-10-17).
    webhookRegistry: config.webhookRegistry,
    // R5.high-2: pass evaluators so auto-activate on create/import-objective gates triggers.
    budgetEvaluator: config.budgetEvaluator,
    budgetScopeResolver: config.budgetScopeResolver,
    policyEvaluator: config.policyEvaluator,
    // REPLAY-ONLY .A-1a: same wiring for auto-activate trigger callbacks.
    replayOnlyResolver: config.replayOnlyResolver,
    approvalEngine: config.approvalEngine,
  });

  const workflowExecuteRoutes = createWorkflowExecuteRoute({
    workflowStore: config.workflowStore,
    executionService,
  });

  const executionRoutes = createExecutionRoutes({
    workflowStore: config.workflowStore,
    executionStore: config.executionStore,
    executionService,
    envelopeStore: config.envelopeStore,
  });

  const envelopeRoutes = createEnvelopeRoutes({
    envelopeStore: config.envelopeStore,
  });

  // Mount routes
  app.route('/api/workflows', workflowRoutes);
  app.route('/api/workflows', workflowExecuteRoutes);
  app.route('/api/executions', executionRoutes);
  app.route('/api/envelopes', envelopeRoutes);

  // STUDY-REV W4: Skill Library routes
  if (config.skillLibraryStore && config.executionHistoryStore) {
    const skillsRoutes = createSkillsRoutes({
      skillLibraryStore: config.skillLibraryStore,
      executionHistoryStore: config.executionHistoryStore,
      // Crystal Count Fix: pass canonical stores for legacy backfill union-read.
      executionStore: config.executionStore,
      workflowStore: config.workflowStore,
    });
    app.route('/api/skills', skillsRoutes);
    app.route('/api/crystals', skillsRoutes); // P1.G forward-compat alias
  }

  // QSKL-1: QuoxSkills procedural-knowledge routes
  {
    const quoxSkillsStore = config.quoxSkillsStore ?? new QuoxSkillsStore();
    const quoxSkillPatchesStore = config.quoxSkillPatchesStore ?? new QuoxSkillPatchesStore();
    const quoxSkillsRoutes = createQuoxSkillsRoutes({ store: quoxSkillsStore, patchesStore: quoxSkillPatchesStore, skillLibraryStore: config.skillLibraryStore, evidenceStore: config.evidenceStore, approvalEngine: config.approvalEngine, executeSkillContext: config.executeSkillContext, scoreboardReader: config.skillScoreboardReader, firewall: config.skillFirewall, firewallLogStore: config.skillFirewallLogStore, reviewQueueStore: config.skillReviewQueueStore, envelopeStore: config.envelopeStore, overridesStore: config.skillOverridesStore });
    app.route('/api/quox-skills', quoxSkillsRoutes);
  }

  // QSKL-7-CHAT-FIX: Agentic skill actions — POST routes that dispatch into
  // skillViewHandler so invocation rows are written to quox_skill_invocations.
  // Mounted unconditionally; invocationsStore is optional (best-effort telemetry).
  {
    const quoxSkillsStore = config.quoxSkillsStore ?? new QuoxSkillsStore();
    const quoxSkillPatchesStore = config.quoxSkillPatchesStore ?? new QuoxSkillPatchesStore();
    const agenticSkillActionsRoutes = createAgenticSkillActionsRoutes({
      store: quoxSkillsStore,
      patchesStore: quoxSkillPatchesStore,
      invocationsStore: config.quoxSkillInvocationsStore,
      reviewQueueStore: config.skillReviewQueueStore,
    });
    app.route('/api/agentic/skill-actions', agenticSkillActionsRoutes);
  }

  // QSKL-6.6: Internal webhook routes (Toolsmith → QuoxFlow)
  {
    const internalSkillsRoutes = createInternalSkillsRoutes({
      toolsmithAdapter: config.toolsmithAdapter,
      envelopeStore: config.envelopeStore,
    });
    app.route('/api/internal', internalSkillsRoutes);
  }

  // QSKL-11a: Ops manual trigger for skill-decay cron.
  // No auth — intended for internal ops use only.
  // Returns 503 when skillDecayCron is not configured; 200 with result body otherwise.
  app.post('/api/internal/skill-decay/run', async (c) => {
    if (!config.skillDecayCron) {
      return c.json({ error: 'skill-decay cron not configured' }, 503);
    }
    const result = await config.skillDecayCron.run();
    return c.json(result);
  });

  // QSKL-11b: Ops manual trigger for skill-judge job.
  // No auth — intended for internal ops use only.
  // Accepts ?force=true to bypass the weekly cadence gate.
  // Returns 503 when skillJudgeJob is not configured; 200 with result body otherwise.
  app.post('/api/internal/skill-judge/run', async (c) => {
    if (!config.skillJudgeJob) {
      return c.json({ error: 'skill-judge job not configured' }, 503);
    }
    const force = c.req.query('force') === 'true';
    const result = await config.skillJudgeJob.run({ force });
    return c.json(result);
  });

  // QSKL-SAFETY.E: Ops manual trigger for skill safety-judge job.
  // No auth — intended for internal ops use only.
  // Returns 503 when skillSafetyJudgeJob is not configured; 200 with result body otherwise.
  app.post('/api/internal/skill-safety-judge/run', async (c) => {
    if (!config.skillSafetyJudgeJob) {
      return c.json({ error: 'skill-safety-judge job not configured' }, 503);
    }
    const result = await config.skillSafetyJudgeJob.run();
    return c.json(result);
  });

  // Mount policy routes if policyStore is provided
  if (config.policyStore) {
    const policyStore = config.policyStore;
    app.use('/api/policies/*', async (c, next) => {
      c.set('policyStore', policyStore);
      c.set('envelopeStore', config.envelopeStore);
      await next();
    });
    app.route('/api/policies', policyRoutes);
  }

  // Mount approval routes if approvalEngine is provided
  if (config.approvalEngine) {
    const approvalEngine = config.approvalEngine;
    app.use('/api/approvals/*', async (c, next) => {
      c.set('approvalEngine', approvalEngine);
      c.set('envelopeStore', config.envelopeStore);
      await next();
    });
    app.route('/api/approvals', approvalRoutes);
  }

  // Mount evidence routes if evidenceStore is provided
  if (config.evidenceStore) {
    const evidenceStore = config.evidenceStore;
    app.use('/api/evidence/*', async (c, next) => {
      c.set('evidenceStore', evidenceStore);
      c.set('envelopeStore', config.envelopeStore);
      await next();
    });
    app.route('/api/evidence', evidenceRoutes);
  }

  // Mount observation routes if observationStore is provided (STUDY-REV P6.C)
  if (config.observationStore) {
    const observationStore = config.observationStore;
    app.use('/api/observations/*', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('observationStore', observationStore);
      await next();
    });
    app.use('/api/observations', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('observationStore', observationStore);
      await next();
    });
    app.route('/api/observations', observationRoutes);
  }

  // Mount schedule routes if scheduleExecutor is provided
  if (config.scheduleExecutor) {
    const scheduleRoutes = createScheduleRoutes({
      scheduleExecutor: config.scheduleExecutor,
      workflowStore: config.workflowStore,
      executionStore: config.executionStore,
      envelopeStore: config.envelopeStore,
      executors: config.executors,
      eventBus: config.eventBus,
    });
    app.route('/api/schedules', scheduleRoutes);
  }

  // Mount triggers read-only enumerator (P8.A — always mounted when eventBus + webhookRegistry available)
  if (config.eventBus) {
    const webhookReg = config.webhookRegistry ?? new WebhookRegistry();
    const triggersRoutes = createTriggersRoutes({
      webhookRegistry: webhookReg,
      eventBus: config.eventBus,
      scheduleExecutor: config.scheduleExecutor,
      quoxflowOwnScheduler: process.env.QUOXFLOW_OWN_SCHEDULER === 'true',
    });
    app.route('/api/triggers', triggersRoutes);
  }

  // Mount engine validation suite (P8.E rewritten — always available; runs are token-cheap by design)
  app.route('/api/validation', createValidationRoutes());

  // QSKL-13: Session FTS search endpoint.
  // Always mounted; in-memory fallback returns empty results when sessionSearchStore is absent.
  {
    const searchStore = config.sessionSearchStore ?? new InMemorySessionSearchStore();
    const sessionSearchRoutes = createSessionSearchRoutes({ searchStore });
    app.route('/api/session-search', sessionSearchRoutes);
  }

  // Mount lifecycle routes (activate/deactivate) if scheduleExecutor and eventBus are provided
  if (config.scheduleExecutor && config.eventBus) {
    const webhookReg = config.webhookRegistry ?? new WebhookRegistry();
    const lifecycleRoutes = createWorkflowLifecycleRoutes({
      workflowStore: config.workflowStore,
      executionStore: config.executionStore,
      envelopeStore: config.envelopeStore,
      executors: config.executors,
      scheduleExecutor: config.scheduleExecutor,
      eventBus: config.eventBus,
      webhookRegistry: webhookReg,
      // R5.high-2: pass evaluators so trigger callbacks inherit budget + policy gates.
      budgetEvaluator: config.budgetEvaluator,
      budgetScopeResolver: config.budgetScopeResolver,
      policyEvaluator: config.policyEvaluator,
      // REPLAY-ONLY .A-1a: same wiring for activate-triggered runs.
      replayOnlyResolver: config.replayOnlyResolver,
      approvalEngine: config.approvalEngine,
      // R5.high-2: approval store for pending-approval cancellation on deactivate.
      approvalStore: config.approvalStore,
    });
    app.route('/api/workflows', lifecycleRoutes);

    // Mount webhook trigger routes
    // MACHINERY: QUOXFLOW_WEBHOOK_RESPONSE_TIMEOUT_MS config-ables the
    // sync-hold window for respondToWebhook workflows (default 30s).
    const webhookResponseTimeoutMs = Number(process.env.QUOXFLOW_WEBHOOK_RESPONSE_TIMEOUT_MS);
    const webhookTriggerRoutes = createWebhookTriggerRoutes({
      workflowStore: config.workflowStore,
      executionService,
      webhookRegistry: webhookReg,
      ...(Number.isFinite(webhookResponseTimeoutMs) && webhookResponseTimeoutMs > 0
        ? { responseTimeoutMs: webhookResponseTimeoutMs }
        : {}),
    });
    app.route('/webhooks', webhookTriggerRoutes);
  }

  // Mount budget CRUD + usage ingestion routes (P8.B — gated on budgetStore present)
  if (config.budgetStore) {
    const budgetsRoutes = createBudgetsRoutes({ budgetStore: config.budgetStore });
    app.route('/api/budgets', budgetsRoutes);

    const budgetUsageRoutes = createBudgetUsageRoutes({ budgetStore: config.budgetStore });
    app.route('/api/v1/budget', budgetUsageRoutes);
  }

  // Mount replay-only flags CRUD route (REPLAY-ONLY .A-1a — gated on replayOnlyFlagsStore present)
  if (config.replayOnlyFlagsStore) {
    const replayOnlyFlagsRoutes = createReplayOnlyFlagsRoutes({ store: config.replayOnlyFlagsStore });
    app.route('/api/internal/replay-only-flags', replayOnlyFlagsRoutes);
  }

  // Mount skill pack routes (DEVSUITE-SKILLS Phase 2 gap-fix — gated on skillPackStore present)
  if (config.skillPackStore) {
    const skillPackRoutes = createSkillPackRoutes({ store: config.skillPackStore });
    app.route('/api/skill-packs', skillPackRoutes);
  }

  // Mount approval template routes (P8.C — gated on approvalTemplateStore present)
  if (config.approvalTemplateStore) {
    const approvalTemplatesRoutes = createApprovalTemplatesRoutes({
      templateStore: config.approvalTemplateStore,
    });
    app.route('/api/approval-templates', approvalTemplatesRoutes);
  }

  // CLI-PARITY WP1.1: GET /__routes — fully-resolved route table for the
  // CLI's live-vs-static endpoint diff. Mounted last (after every
  // app.route() call above) so it reflects every route actually attached
  // to this Hono app instance, including routes gated behind config flags
  // (skills, triggers, budgets, etc. — see the `if (config.x)` guards
  // above this point).
  //
  // Auth: no separate gate is added here — this route is covered by the
  // same `app.use('*', authMiddleware)` global middleware (registered
  // near the top of createApp, active when config.authEnabled) that every
  // other endpoint in this app already goes through. authMiddleware
  // accepts either a JWT or an X-Service-Key header (see
  // ./middleware/auth.js), matching the service-key pattern the other
  // Quox services use for /__routes.
  app.get('/__routes', c =>
    c.json({
      service: 'quoxflow',
      routes: app.routes.map(r => ({
        method: r.method.toUpperCase(),
        path: r.path,
        mount: r.basePath,
      })),
    })
  );

  // 404 handler
  app.notFound(c =>
    c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route ${c.req.method} ${c.req.path} not found`,
          requestId: c.get('correlationId') || 'unknown',
        },
      },
      404
    )
  );

  return app;
}
