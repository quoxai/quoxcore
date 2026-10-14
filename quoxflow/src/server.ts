/**
 * Quoxflow API Server
 *
 * Standalone HTTP server entry point.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... PORT=3000 npx tsx src/server.ts
 */

import { serve } from '@hono/node-server';
import { assertDatabaseConfigured, assertReplayOnlyStoreDurable } from './server-boot-guard.js';
import { runMigrationsFromEnv } from './migrations/run-migrations.js';
import { createApp } from './api/index.js';
import type { SkillScoreboardReader } from './api/routes/quox-skills.js';
import { listSkillScoreboard, readSkillScoreboard, type ScoreboardOrgScope } from './store/skill-scoreboard.js';
import { SYSTEM_SCOPE } from './api/middleware/org-scope.js';
import { envelopes, Intents } from './core/envelope.js';
import { createWorkflowStore, createInMemoryWorkflowStore } from './api/stores/workflow-store.js';
import { createExecutionStore, createInMemoryExecutionStore } from './api/stores/execution-store.js';
import { createInMemoryStore, createPostgresStore } from './store/envelope-store.js';
import { createCollectorForwarder } from './store/envelope-forwarder.js';
import { reconcileUnsettledDispatchIntents } from './pipeline/dispatch-intent-reconciliation.js';
import { createInMemoryPolicyStore, createPostgresPolicyStore } from './store/policy-store.js';
import {
  createInMemoryApprovalStore,
  createPostgresApprovalStore,
  createApprovalEngine,
  scheduleApprovalExpirySweep,
  shouldMintInboxItem,
} from './approval/index.js';
import {
  createInMemoryEvidenceStore,
  createPostgresEvidenceStore,
  createMemoryStorageBackend,
  createFileStorageBackend,
} from './evidence/index.js';
import {
  createInMemorySkillLibraryStore,
  createPostgresSkillLibraryStore,
} from './store/skill-library-store.js';
import {
  createInMemorySkillPackStore,
  createPostgresSkillPackStore,
} from './store/skill-pack-store.js';
import { CORE_DEV_PACK_SEED } from './store/core-dev-pack-seed.js';
import { QuoxSkillsStore } from './store/quox-skills-store.js';
import { seedSkillsFromFs } from './store/skill-seed-loader.js';
import { QuoxSkillPatchesStore } from './store/quox-skill-patches-store.js';
import { QuoxSkillInvocationsStore } from './store/quox-skill-invocations-store.js';
import { createCollectorToolsmithAdapter } from './agentic/toolsmith-collector-adapter.js';
import {
  createInMemoryExecutionHistoryStore,
  createPostgresExecutionHistoryStore,
} from './store/execution-history-store.js';
import {
  createInMemoryObservationStore,
  createPostgresObservationStore,
} from './store/observation-store.js';
import {
  createInMemoryPrecedentStore,
  createPostgresPrecedentStore,
} from './store/precedent-store.js';
import { createApprovalPrecedentHook } from './approval/precedent-recorder.js';
import { executorRegistry } from './executors/executor.interface.js';
import { eventBus } from './events/event-bus.js';
import { WebhookRegistry } from './api/routes/webhook-triggers.js';
import { bootstrapTriggers } from './runtime/trigger-bootstrap.js';
import { createInMemoryBudgetStore, createPostgresBudgetStore } from './budget/budget-store.js';
import { BudgetEvaluator } from './budget/budget-evaluator.js';
import { PolicyEvaluator } from './policy/evaluator.js';
import type { BudgetScopeContext } from './pipeline/control-pipeline.js';
import {
  createInMemoryReplayOnlyFlagsStore,
  createPostgresReplayOnlyFlagsStore,
  resolveEffectiveReplayOnly,
  type ReplayOnlyResolveParams,
} from './store/replay-only-flags-store.js';
import { scheduleNightly } from './validation/scheduler.js';
import { scheduleSkillTestsDaily } from './validation/skill-tests-scheduler.js';
import { scheduleSkillStaleFlagDaily } from './validation/skill-stale-flag-scheduler.js';
import { createSkillDecayCron } from './agentic/skill-decay-cron.js';
import { scheduleSkillDecayDaily } from './validation/skill-decay-scheduler.js';
import { createSkillJudgeJob } from './agentic/skill-judge-job.js';
import { createCollectorLlmClient } from './agentic/skill-judge-collector-client.js';
import { createLineageAnalyzerCollectorClient } from './pipeline/lineage-analyzer.js';
import { createCollectorSkillExecuteContext } from './agentic/skill-execution-collector-client.js';
import { scheduleSkillJudgeWeekly } from './validation/skill-judge-scheduler.js';
import { createSkillSafetyJudgeJob } from './agentic/skill-safety-judge-job.js';
import { scheduleSkillSafetyJudgeWeekly } from './validation/skill-safety-judge-scheduler.js';
import {
  createInMemorySkillReviewQueueStore,
  createPostgresSkillReviewQueueStore,
} from './store/skill-review-queue-store.js';
import {
  createPostgresSessionSearchStore,
  createInMemorySessionSearchStore,
} from './store/session-search-store.js';
import { createPatchRateLimiter } from './agentic/skill-patch-rate-limiter.js';
import { createSkillFirewall } from './security/skill_firewall.js';
import {
  createInMemorySkillFirewallLogStore,
  createPostgresSkillFirewallLogStore,
} from './store/skill-firewall-log-store.js';
import { logger } from './logger.js';

const log = logger.for('Server');
const startupLog = logger.for('startup');
const skillSeedLog = logger.for('skill-seed');
const hv2Log = logger.for('HV2');
const shutdownLog = logger.for('Shutdown');

// Register executors
import { callExecutor } from './executors/call.executor.js';
import { transformExecutor } from './executors/transform.executor.js';
import { webhookExecutor } from './executors/webhook.executor.js';
import { conditionExecutor } from './executors/condition.executor.js';
import { switchExecutor } from './executors/switch.executor.js';
import { loopExecutor } from './executors/loop.executor.js';
import { tryExecutor, catchExecutor, throwExecutor } from './executors/error.executor.js';
import { waitExecutor, logExecutor, subworkflowExecutor, SubworkflowExecutor } from './executors/utility.executor.js';
import { parallelExecutor, mergeExecutor } from './executors/parallel.executor.js';
import { endExecutor } from './executors/end.executor.js';
import { aggregateExecutor } from './executors/aggregate.executor.js';
import { scheduleExecutor } from './executors/schedule.executor.js';
import { eventTriggerExecutor } from './executors/event-trigger.executor.js';
import { toolCallExecutor } from './executors/tool-call.executor.js';
import { ApprovalGateExecutor } from './executors/approval-gate.executor.js';
import { HumanTaskExecutor } from './executors/human-task.executor.js';
import { agentInvokeExecutor } from './executors/agent-invoke.executor.js';
import { browserExecutor } from './executors/browser.executor.js';
import { agenticExecutor } from './executors/agentic.executor.js';
import { fetchPersona } from './agentic/persona-fetcher.js';
import { teamInvokeExecutor } from './executors/team-invoke.executor.js';
import { teamMemberExecutor } from './executors/team-member.executor.js';
import { assistantInvokeExecutor } from './executors/assistant-invoke.executor.js';
import { NotificationDeliverExecutor } from './executors/notification-deliver.executor.js';
import { respondWebhookExecutor } from './executors/respond-webhook.executor.js';

executorRegistry.register(callExecutor);
executorRegistry.register(transformExecutor);
executorRegistry.register(webhookExecutor);
executorRegistry.register(respondWebhookExecutor);
executorRegistry.register(conditionExecutor);
executorRegistry.register(switchExecutor);
executorRegistry.register(loopExecutor);
executorRegistry.register(tryExecutor);
executorRegistry.register(catchExecutor);
executorRegistry.register(throwExecutor);
executorRegistry.register(waitExecutor);
executorRegistry.register(logExecutor);
executorRegistry.register(subworkflowExecutor);
executorRegistry.register(parallelExecutor);
executorRegistry.register(mergeExecutor);
executorRegistry.register(endExecutor);
executorRegistry.register(aggregateExecutor);
executorRegistry.register(scheduleExecutor);
executorRegistry.register(eventTriggerExecutor);
executorRegistry.register(toolCallExecutor);
executorRegistry.register(agentInvokeExecutor);
executorRegistry.register(browserExecutor);
executorRegistry.register(agenticExecutor);
executorRegistry.register(teamInvokeExecutor);
executorRegistry.register(teamMemberExecutor);
executorRegistry.register(assistantInvokeExecutor);

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  // TRUST-GATE 1.1: refuse to boot in production without a real DATABASE_URL
  // (empty string counts as unset — docker-compose empty-var interpolation).
  // Falling back to in-memory stores silently loses all run/approval/audit
  // state on restart. Throws unless QUOXFLOW_ALLOW_MEMORY_STORES=true.
  const bootGuard = assertDatabaseConfigured();
  if (bootGuard.usingMemoryStores) {
    if (bootGuard.productionOverride) {
      startupLog.warn(
        'WARNING: QUOXFLOW_ALLOW_MEMORY_STORES=true in production — ' +
        'using non-durable in-memory stores. All run/approval/audit state will ' +
        'be lost on restart, and crash recovery (failStale) will NOT run. ' +
        'This is not recommended for production.',
      );
    } else {
      startupLog.warn(
        'DATABASE_URL not set — using in-memory stores. State will ' +
        'not persist across restarts.',
      );
    }
  }

  // REPLAY-ONLY .A-1b G6: skill_library (Crystal store) must be PG-backed
  // if replay-only can be active — fail loud at boot otherwise. Separate,
  // stricter override from QUOXFLOW_ALLOW_MEMORY_STORES (see
  // server-boot-guard.ts docstring for the rationale).
  const replayOnlyBootGuard = assertReplayOnlyStoreDurable({ usingMemoryStores: bootGuard.usingMemoryStores });
  if (replayOnlyBootGuard.usingMemoryStores && replayOnlyBootGuard.productionOverride) {
    startupLog.warn(
      'WARNING: QUOXFLOW_ALLOW_REPLAY_ONLY_MEMORY=true in production — the ' +
      'skill_library (Crystal) store is in-memory. Canonical Crystals will evaporate ' +
      'on every restart. This is a compliance hazard for replay-only mode and is not ' +
      'recommended in production.',
    );
  }

  // QSKL-FIX slice 1B: run SQL migrations before any store is initialised.
  // This ensures all tables exist before stores attempt to use them.
  // Only runs when a real DB is configured; in-memory mode skips.
  if (dbUrl) {
    await runMigrationsFromEnv(dbUrl);
  }

  // Create stores
  const envelopeStore = dbUrl
    ? createPostgresStore({ connectionString: dbUrl })
    : createInMemoryStore();

  const workflowStore = dbUrl
    ? createWorkflowStore({ connectionString: dbUrl })
    : createInMemoryWorkflowStore();

  const executionStore = dbUrl
    ? createExecutionStore({ connectionString: dbUrl })
    : createInMemoryExecutionStore();

  const policyStore = dbUrl
    ? createPostgresPolicyStore({ connectionString: dbUrl })
    : createInMemoryPolicyStore();

  const approvalStore = dbUrl
    ? createPostgresApprovalStore({ connectionString: dbUrl })
    : createInMemoryApprovalStore();

  // Create evidence store with appropriate backend
  const evidenceBasePath = process.env.EVIDENCE_PATH || '/tmp/quoxflow/evidence';
  const evidenceBackend = dbUrl
    ? createFileStorageBackend({ basePath: evidenceBasePath })
    : createMemoryStorageBackend();
  const evidenceStore = dbUrl
    ? createPostgresEvidenceStore({ connectionString: dbUrl }, evidenceBackend)
    : createInMemoryEvidenceStore(evidenceBackend);

  // STUDY-REV W4: Skill Library + Execution History (Crystalliser persistence)
  const skillLibraryStore = dbUrl
    ? createPostgresSkillLibraryStore({ connectionString: dbUrl })
    : createInMemorySkillLibraryStore();
  // DEVSUITE-SKILLS Phase 2 gap-fix: Skill Pack store, backing
  // GET /api/skill-packs/:id/verify (see api/routes/skill-packs.ts).
  const skillPackStore = dbUrl
    ? createPostgresSkillPackStore({ connectionString: dbUrl })
    : createInMemorySkillPackStore();
  // QSKL-2: QuoxSkills store (procedural knowledge, distinct from Crystals).
  // Uses the same PG config pattern as skillLibraryStore.
  const quoxSkillsStore = dbUrl
    ? new QuoxSkillsStore({ connectionString: dbUrl })
    : new QuoxSkillsStore();
  // QSKL-4.A: Skill patch audit log store.
  // Table created by migration 007-quox-skills.sql (already exists).
  const quoxSkillPatchesStore = dbUrl
    ? new QuoxSkillPatchesStore({ connectionString: dbUrl })
    : new QuoxSkillPatchesStore();
  // QSKL-7.8: Per-invocation telemetry store.
  // Only created when a real DB is configured (requires PG pool for INSERT/SELECT).
  // In-memory mode: undefined — skillViewHandler silently skips writes when absent.
  const { Pool: PgPool } = dbUrl ? await import('pg') : { Pool: null };
  const quoxSkillInvocationsStore = dbUrl && PgPool
    ? new QuoxSkillInvocationsStore(new PgPool({ connectionString: dbUrl }))
    : undefined;
  const executionHistoryStore = dbUrl
    ? createPostgresExecutionHistoryStore({ connectionString: dbUrl })
    : createInMemoryExecutionHistoryStore();
  // STUDY-REV W2: per-step observation store. The third store the durable
  // hooks need to actually fire in the production pipeline.
  const observationStore = dbUrl
    ? createPostgresObservationStore({ connectionString: dbUrl })
    : createInMemoryObservationStore();

  // PRECEDENT wiring: judgment-call precedent store (migration
  // 022-precedent-store.sql). Feeds two consumers — the approval engine's
  // resolved-hook writes human rulings into it, and the agentic executor's
  // terminal done-gate reads from it. An empty store leaves both behaving
  // exactly as they did before it was wired.
  const precedentStore = dbUrl
    ? createPostgresPrecedentStore({ connectionString: dbUrl })
    : createInMemoryPrecedentStore();

  // P8.B: Budget store + evaluator. The store handles CRUD routes; the evaluator
  // is threaded into ControlPipeline via ExecutionService so the pre-exec budget
  // check guard at control-pipeline.ts:137 actually fires in production.
  const budgetStore = dbUrl
    ? createPostgresBudgetStore({ connectionString: dbUrl })
    : createInMemoryBudgetStore();
  const budgetEvaluator = new BudgetEvaluator(budgetStore);
  // Scope resolver: map (workflowId, orgId) → {scope:'execution', scopeId:orgId, orgId}.
  // orgId is the primary scope key in QuoxCORE's single-tenant-per-org model.
  const budgetScopeResolver = (_workflowId: string, orgId?: string): BudgetScopeContext | null =>
    orgId ? { scope: 'execution', scopeId: orgId, orgId } : null;

  // P8.C: Policy evaluator. Threaded into ControlPipeline so per-node policy
  // gates at control-pipeline.ts:400 fire. The store (policyStore) already
  // exists above — evaluator wraps it with no extra I/O.
  const policyEvaluator = new PolicyEvaluator(policyStore);

  // REPLAY-ONLY .A-1a: flag store + resolver. The store backs the internal
  // replay-only-flags CRUD route (app.ts); the resolver closure is threaded
  // into ControlPipeline via ExecutionService so context.effectiveReplayOnly
  // is actually resolved at run start instead of defaulting to false.
  const replayOnlyFlagsStore = dbUrl
    ? createPostgresReplayOnlyFlagsStore({ connectionString: dbUrl })
    : createInMemoryReplayOnlyFlagsStore();
  const replayOnlyResolver = (params: ReplayOnlyResolveParams): Promise<boolean> =>
    resolveEffectiveReplayOnly(replayOnlyFlagsStore, params);

  // Initialize stores
  await envelopeStore.init();
  await workflowStore.init();
  await executionStore.init();

  // R5.crit-1: Crash recovery — any execution still 'running' after a restart
  // will never complete. Mark them failed so the dashboard reflects reality.
  // Threshold: 60 seconds (anything started > 60s ago is assumed from the prior process).
  {
    const failed = await executionStore.failStale('running', new Date(Date.now() - 60_000));
    if (failed > 0) startupLog.info(`Failed ${failed} stale running executions from prior crash`);
  }

  // QUOXTRUST-B3: crash recovery for outward dispatch intents. The pass
  // above handles a whole execution left 'running'; this handles a single
  // node that crashed mid external-effect (HTTP call, agent/team invoke,
  // HITL-approval creation, ...). A dispatch-intent with no correlated
  // dispatch-settled/outcome_unknown after the same 60s threshold means the
  // process died between recording intent and recording outcome, and the
  // effect itself may or may not have fired. This NEVER re-runs it; it only
  // durably records that the outcome is unknown. Idempotent across boots
  // (see dispatch-intent-reconciliation.ts).
  {
    const reconciled = await reconcileUnsettledDispatchIntents(envelopeStore, 60_000, startupLog);
    if (reconciled > 0) startupLog.info(`Recorded outcome_unknown for ${reconciled} unsettled dispatch intents from prior crash`);
  }

  // R5.med: Release stale budget reservations from crashed processes.
  // Any reservation older than 1h is assumed orphaned.
  if (budgetStore.releaseStaleReservations) {
    const releasedReservations = await budgetStore.releaseStaleReservations(3600_000);
    if (releasedReservations > 0) startupLog.info(`Released ${releasedReservations} stale budget reservations from prior crash`);
  }

  await policyStore.init();
  await approvalStore.init();
  await evidenceStore.init();
  await skillLibraryStore.init();
  await skillPackStore.init();
  await quoxSkillsStore.init();

  // QSKL-10.2: Seed skills from filesystem at boot. Default-on.
  // Only the store matters for seeding — pass it explicitly so we use the
  // already-initialised postgres/in-memory instance rather than the default
  // in-memory fallback inside seedSkillsFromFs.
  if (process.env.QUOX_SKILLS_SEED_DISABLED !== 'true') {
    const seedResult = await seedSkillsFromFs({
      store: quoxSkillsStore,
      logger: (level, msg, ctx) => skillSeedLog[level](msg, ctx as Record<string, unknown> | undefined),
    });
    skillSeedLog.info(`complete: inserted=${seedResult.inserted} updated=${seedResult.updated} skipped=${seedResult.skipped} errors=${seedResult.errors.length}`);
    if (seedResult.errors.length > 0) {
      for (const err of seedResult.errors) {
        skillSeedLog.error(`error in ${err.path}: ${err.error}`);
      }
    }
  }

  await quoxSkillPatchesStore.init();
  await executionHistoryStore.init();
  await observationStore.init();
  await precedentStore.init();

  // 2026-05-03 — forward every persisted envelope to the collector's
  // /aee/sync sink so workflow runs surface in the dashboard ActivityView
  // alongside chats. Without this, AOCL/AEE envelopes for workflow
  // executions live only in QuoxFlow's own DB and the activity view shows
  // them as bare entries with no AOCL steps or request/response detail.
  // Disabled by setting QUOXFLOW_FORWARD_ENVELOPES=false.
  const collectorUrl = process.env.COLLECTOR_URL || 'http://collector:9848';
  const forwardEnvelopes = process.env.QUOXFLOW_FORWARD_ENVELOPES !== 'false';
  if (forwardEnvelopes && collectorUrl) {
    envelopeStore.setSink(createCollectorForwarder({
      collectorUrl,
      serviceKey: process.env.INTERNAL_SERVICE_KEY,
    }));
    logger.for('EnvelopeStore').info(`Forwarding envelopes to ${collectorUrl}/aee/sync`);

    // QUOXTRUST-B2: periodic drain of the durable forward outbox — the live
    // forward on append/appendBatch above only fires once; if the collector
    // is briefly unreachable that attempt leaves the row 'pending' forever
    // unless something retries it. Same QUOXFLOW_FORWARD_ENVELOPES gate as
    // the live sink. Guarded against stacking (isDraining) and backs off
    // (capped) on consecutive failed drains so an unreachable collector
    // doesn't hammer itself every tick; resets the moment a drain forwards
    // anything.
    const drainLog = logger.for('EnvelopeStore');
    const DRAIN_INTERVAL_MS = 30_000;
    const MAX_DRAIN_BACKOFF_MS = 30 * 60_000;
    let isDraining = false;
    let nextDrainEligibleAt = 0;

    setInterval(() => {
      if (isDraining || Date.now() < nextDrainEligibleAt) return;
      isDraining = true;
      envelopeStore.drainPendingForwards()
        .then(result => {
          if (result.attempted === 0) return; // nothing pending — not a failure, no backoff
          if (result.forwarded > 0) {
            nextDrainEligibleAt = 0;
            drainLog.info(`drainPendingForwards: forwarded ${result.forwarded}/${result.attempted}`);
          } else {
            const backoffMs = Math.min(
              DRAIN_INTERVAL_MS * 2 ** envelopeStore.getConsecutiveFailedDrains(),
              MAX_DRAIN_BACKOFF_MS
            );
            nextDrainEligibleAt = Date.now() + backoffMs;
            drainLog.error(`drainPendingForwards: ${result.failed} envelopes still failing to forward, backing off ${backoffMs}ms`);
          }
        })
        .catch(err => {
          drainLog.error(`drainPendingForwards threw: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => { isDraining = false; });
    }, DRAIN_INTERVAL_MS).unref();
  }

  // Create approval engine with HITL inbox bridge (HV2-1)
  const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const internalServiceKey = process.env.INTERNAL_SERVICE_KEY || '';

  // REPLAY-ONLY .B2: crystal signing oracle client. promoteCanonical (the
  // single seam covering all 3 promotion call sites — agentic.executor.ts x2,
  // task-time-promotion-sweep.ts) computes a canonical hash of the
  // action-snapshot and calls this closure to get it signed by auth's
  // signing oracle (POST /api/internal/crystals/sign, shipped in .B1a). The
  // CSK/private key never leaves auth — this client only ever sends a hash
  // and receives a signature back.
  //
  // Cross-service hygiene (known failure class: silent-success-on-failed-
  // fetch): explicitly check response.ok; on non-2xx or a network error,
  // log the failure with a body excerpt and resolve to null rather than
  // throwing. The store treats null as "signing unavailable right now" —
  // it commits the crystal with signature_status='pending' instead of
  // blocking promotion.
  const crystalSignLog = logger.for('CrystalSigner');
  skillLibraryStore.setCrystalSigner(async ({ orgId, hash }) => {
    try {
      const res = await fetch(`${authServiceUrl}/api/internal/crystals/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
        },
        body: JSON.stringify({ org_id: orgId, hash }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        crystalSignLog.error(`crystals/sign failed (${res.status})`, { body: errBody.slice(0, 500) });
        return null;
      }

      const result = (await res.json()) as {
        key_id: string;
        algorithm: string;
        signature: string;
        public_key_hex: string;
      };
      return { signature: result.signature, key_id: result.key_id, algorithm: result.algorithm };
    } catch (err) {
      crystalSignLog.error('crystals/sign network error', { error: (err as Error).message });
      return null;
    }
  });

  // REPLAY-ONLY .B3: org public-key fetcher for the replay-only
  // signature-verify gate (agentic.executor.ts). Mirrors the crystalSigner
  // client above: GET auth's public-key oracle
  // (GET /api/internal/crystals/public-key/:orgId, shipped in .B1a),
  // X-Service-Key gated, explicit response.ok check, never throws — any
  // failure (non-2xx, network error) resolves to null and the executor's
  // gate treats that as replay_only_signature_invalid (fail-closed). The
  // executor caches the result per-org in-process, so this fires at most
  // once per org per process lifetime (barring key rotation follow-ups).
  const crystalPubKeyLog = logger.for('CrystalPublicKeyFetcher');
  agenticExecutor.setFetchOrgPublicKey(async (orgId: string) => {
    try {
      const res = await fetch(`${authServiceUrl}/api/internal/crystals/public-key/${encodeURIComponent(orgId)}`, {
        method: 'GET',
        headers: {
          ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
        },
      });

      if (!res.ok) {
        const errBody = await res.text();
        crystalPubKeyLog.error(`crystals/public-key failed (${res.status})`, { orgId, body: errBody.slice(0, 500) });
        return null;
      }

      const result = (await res.json()) as {
        key_id: string;
        algorithm: string;
        public_key_hex: string;
        status?: string;
      };
      return { public_key_hex: result.public_key_hex, key_id: result.key_id, algorithm: result.algorithm };
    } catch (err) {
      crystalPubKeyLog.error('crystals/public-key network error', { orgId, error: (err as Error).message });
      return null;
    }
  });

  // DEVSUITE-SKILLS Phase 2 gap-fix: skill-pack public-key fetcher, backing
  // verifyPack() (called by GET /api/skill-packs/:id/verify). Same oracle,
  // same X-Service-Key gate, same fail-closed-on-null contract as
  // agenticExecutor.setFetchOrgPublicKey above — a distinct closure per
  // consumer rather than a shared reference, matching this file's existing
  // per-consumer wiring style (see crystalSigner / crystalPubKeyLog above).
  const skillPackPubKeyLog = logger.for('SkillPackPublicKeyFetcher');
  skillPackStore.setPublicKeyFetcher(async (orgId: string) => {
    try {
      const res = await fetch(`${authServiceUrl}/api/internal/crystals/public-key/${encodeURIComponent(orgId)}`, {
        method: 'GET',
        headers: {
          ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
        },
      });

      if (!res.ok) {
        const errBody = await res.text();
        skillPackPubKeyLog.error(`crystals/public-key failed (${res.status})`, { orgId, body: errBody.slice(0, 500) });
        return null;
      }

      const result = (await res.json()) as {
        key_id: string;
        algorithm: string;
        public_key_hex: string;
        status?: string;
      };
      return { public_key_hex: result.public_key_hex, key_id: result.key_id, algorithm: result.algorithm };
    } catch (err) {
      skillPackPubKeyLog.error('crystals/public-key network error', { orgId, error: (err as Error).message });
      return null;
    }
  });

  // DEVSUITE-SKILLS seq 4: packs sign through the SAME oracle as crystals
  // (PackSigner's own doc says so), but nothing ever wired the signer, so
  // every created pack committed 'unsigned' and verification failed closed.
  // Distinct closure per consumer, matching crystalSigner above.
  const packSignLog = logger.for('SkillPackSigner');
  skillPackStore.setSigner(async ({ orgId, hash }) => {
    try {
      const res = await fetch(`${authServiceUrl}/api/internal/crystals/sign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
        },
        body: JSON.stringify({ org_id: orgId, hash }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        packSignLog.error(`crystals/sign failed (${res.status})`, { body: errBody.slice(0, 500) });
        return null;
      }
      const result = (await res.json()) as { key_id: string; algorithm: string; signature: string };
      return { signature: result.signature, key_id: result.key_id, algorithm: result.algorithm };
    } catch (err) {
      packSignLog.error('crystals/sign network error', { error: (err as Error).message });
      return null;
    }
  });

  // Boot-time idempotent seed of the well-known core dev pack, so dev-server
  // registration can install it instead of failing closed against an empty
  // registry (the 2026-08-15 unverified_pack finding). Non-blocking: a seed
  // failure is loud in the log but never stops quoxflow from serving.
  const packSeedLog = logger.for('SkillPackSeed');
  skillPackStore
    .ensureWellKnownPack(CORE_DEV_PACK_SEED)
    .then(({ record, action }) => {
      packSeedLog.info(`core dev pack ${action}`, {
        id: record.id,
        version: record.packVersion,
        signature_status: record.signatureStatus,
      });
      if (record.signatureStatus !== 'signed') {
        packSeedLog.error('core dev pack is NOT signed — pack installs will fail closed until the signing oracle is reachable', {
          signature_status: record.signatureStatus,
        });
      }
    })
    .catch((err) => packSeedLog.error('core dev pack seed failed', { error: (err as Error).message }));

  // Dead-link fix: resolve the auth-side inbox mirror for an approval that has
  // reached a terminal state without a human decision (cancelled on workflow
  // deactivation, or expired). The mirror was created by onApprovalCreated;
  // leaving it 'open' makes it a dead link nobody can action. Fire-and-forget
  // and never throws: the approval's terminal state is authoritative whether or
  // not the auth service is reachable.
  const cancelAuthInboxMirror = async (
    approval: { id: string; executionId?: string; orgId?: string },
    reason: string,
  ): Promise<void> => {
    if (!approval.orgId) return; // cannot route a mirror-cancel without an org
    try {
      await fetch(`${authServiceUrl}/api/internal/orgs/${encodeURIComponent(approval.orgId)}/inbox/cancel-by-execution`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
        },
        body: JSON.stringify({ execution_id: approval.executionId, approval_id: approval.id, reason }),
      });
    } catch (err) {
      hv2Log.warn('Failed to cancel auth inbox mirror', { approvalId: approval.id, error: (err as Error).message });
    }
  };

  const approvalEngine = createApprovalEngine({
    store: approvalStore,
    defaultTimeoutMs: 86400000, // 24 hours
    // PRECEDENT wiring: a resolved approval that carries an approver comment
    // becomes an org-scoped, 'hitl-approved' precedent. Composed rather than
    // owned — pass an existing resolved-hook as the second argument if one is
    // ever added here. Best-effort: the recorder never throws.
    onApprovalResolved: createApprovalPrecedentHook(precedentStore),
    // quox#513: an expired approval left its owning execution's evidence
    // trail exactly as blank as a denied one did (see the resume() fix
    // above) — nothing ever recorded that the hold timed out. The run stays
    // paused (existing semantics, unchanged); this only makes the expiry
    // itself auditable in the SAME corr as the rest of that execution's
    // envelopes, mirroring the ops.approval.deny/grant decision envelopes.
    onApprovalExpired: async (approval) => {
      const env = envelopes.create({
        to: 'quox.audit',
        type: 'event',
        intent: Intents.APPROVAL.EXPIRED,
        corr: approval.correlationId,
        payload: {
          executionId: approval.executionId,
          workflowId: approval.workflowId,
          nodeId: approval.nodeId,
          approvalId: approval.id,
          expiresAt: approval.expiresAt,
        },
      });
      await envelopeStore.append(env, approval.orgId ?? SYSTEM_SCOPE);
      // Resolve the auth-side mirror so an expired approval is not a dead link.
      await cancelAuthInboxMirror(approval, 'approval expired');
    },
    // Dead-link fix: when an approval is cancelled (e.g. workflow deactivated),
    // resolve its auth-side inbox mirror so it does not sit open forever.
    onApprovalCancelled: async (approval) => {
      await cancelAuthInboxMirror(approval, 'workflow deactivated');
    },
    onApprovalCreated: async (approval) => {
      // HV2-1: Create inbox item in auth service so humans can respond
      // The execution ID is stored on the inbox item so the respond endpoint
      // can call back to QuoxFlow POST /api/executions/:id/resume
      const metadata = (approval.metadata || {}) as Record<string, unknown>;

      // TRUST-PROOF twin-item fix: the collector's native-tool gate mints
      // its own inbox item (the resumable native_tool_approval shape) and
      // declares so with suppress_inbox — minting a second one here created
      // a dead twin whose approval executed nothing.
      if (!shouldMintInboxItem(metadata)) {
        hv2Log.info(`Skipping inbox mint for approval ${approval.id}: caller owns the human-facing item (suppress_inbox).`);
        return;
      }

      // P8.F HITL-ORGID-PLUMB: orgId is now first-class on ExecutionContext
      // and flows through approval metadata via the gate/human-task executors.
      // Priority: metadata.orgId (from context) → env-var (CLI/test fallback only).
      // If neither is present the hook throws a loud error rather than silently
      // landing items under the wrong tenant.
      const orgIdFromMeta = metadata.orgId as string | undefined;
      const envFallbackOrgId = process.env.DEFAULT_INBOX_ORG_ID;
      const orgId = orgIdFromMeta || envFallbackOrgId;

      if (!orgId) {
        // No plumb-through and no env-var — this is a configuration error.
        // Log loudly and throw so the approval creation fails visibly.
        hv2Log.error('quox.hv2.orgid_missing: orgId not in approval metadata and DEFAULT_INBOX_ORG_ID not set. ' +
          `Approval ${approval.id} for execution ${approval.executionId} cannot be routed to an inbox. ` +
          'Ensure orgId is passed at workflow execute time or set DEFAULT_INBOX_ORG_ID for CLI test runs.');
        throw new Error('quox.hv2.orgid_missing');
      }

      if (!orgIdFromMeta && envFallbackOrgId) {
        // Log a warning when falling back — useful for auditing CLI test runs.
        hv2Log.warn(`Using DEFAULT_INBOX_ORG_ID env-var fallback for approval ${approval.id} ` +
          '(orgId was not in approval metadata — this is expected for CLI-invoked test runs only).');
      }

      const fallbackAssigneeUserId =
        (metadata.assignee_user_id as string) ||
        process.env.DEFAULT_INBOX_USER_ID ||
        undefined;

      // Three flavours of inbox item, distinguished by metadata.type:
      //   human_task   → kind:task, custom action buttons, paused workflow
      //   notification → kind:info, NO buttons, NO pause (FYI delivery)
      //   default      → kind:approval, Approve/Deny buttons, paused (legacy approval gate)
      // The previous binary branch defaulted everything-not-human_task to
      // 'approval', which made notification:deliver render with Approve/Deny
      // buttons — defeating the whole point of having a separate executor.
      const isHumanTask = metadata.type === 'human_task';
      const isNotification = metadata.type === 'notification';

      const workflowLabel = approval.workflowName || approval.workflowId;
      const inboxKind = isHumanTask
        ? ((metadata.kind as string) || 'task')
        : isNotification
          ? 'info'
          : 'approval';
      const inboxPriority = isHumanTask
        ? ((metadata.priority as string) || 'normal')
        : isNotification
          ? ((metadata.priority as string) || 'normal')
          : 'high';
      const inboxTitle = isHumanTask
        ? ((metadata.title as string) || `Task: ${workflowLabel}`)
        : isNotification
          ? ((metadata.title as string) || workflowLabel)
          : ((metadata.message as string) || `Approval required: ${workflowLabel}`);
      const inboxBody = isNotification
        ? // Notifications: lead with the message body — that's the actual
          // content the human is here to see. Workflow name as a small
          // footer; deliberately NO node name (was leaking type strings
          // like "notification:deliver" into the UI when WEAVER named
          // the node sloppily).
          [
            metadata.message ? String(metadata.message) : null,
            `\n*From:* ${workflowLabel}`,
          ].filter(Boolean).join('\n')
        : [
            `**Workflow:** ${workflowLabel}`,
            metadata.nodeName ? `**Step:** ${metadata.nodeName}` : null,
            metadata.message ? `\n${metadata.message}` : null,
            `\n*Expires:* ${new Date(approval.expiresAt).toLocaleString()}`,
          ].filter(Boolean).join('\n');

      const inboxPayload: Record<string, unknown> = {
        kind: inboxKind,
        priority: inboxPriority,
        title: inboxTitle,
        body_md: inboxBody,
        payload: {
          approval_id: approval.id,
          workflow_id: approval.workflowId,
          execution_id: approval.executionId,
          node_id: approval.nodeId,
          approvers: approval.approvers,
          expires_at: approval.expiresAt,
          pipeline_input: metadata.pipelineInput,
          // human:task extras — only for actual human:task items
          ...(isHumanTask && metadata.customActions ? { custom_actions: metadata.customActions } : {}),
          ...(isHumanTask && metadata.responseSchema ? { response_schema: metadata.responseSchema } : {}),
          // Mark notification items so the UI can pick the info-card render path
          ...(isNotification ? { source: 'notification_deliver', auto_resolve: true } : {}),
          // R3.high: Forward policy metadata so InboxItemDetailView can render the policy badge.
          // policy_injected/policyId/policyName are written to approval.metadata by ControlPipeline.
          ...(metadata.policy_injected ? {
            policy_injected: true,
            policy_id: metadata.policyId,
            policy_name: metadata.policyName,
          } : {}),
        },
        aee_correlation_id: approval.correlationId,
        quoxflow_execution_id: approval.executionId,
        ...(fallbackAssigneeUserId ? { assignee_user_id: fallbackAssigneeUserId } : {}),
      };

      try {
        const res = await fetch(`${authServiceUrl}/api/internal/orgs/${orgId}/inbox`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalServiceKey ? { 'X-Service-Key': internalServiceKey } : {}),
          },
          body: JSON.stringify(inboxPayload),
        });

        if (!res.ok) {
          const errBody = await res.text();
          hv2Log.error(`Failed to create inbox item (${res.status})`, { body: errBody });
        } else {
          const result = await res.json();
          hv2Log.info(`Inbox item created: ${(result as any).item?.id} for execution ${approval.executionId}`);
        }
      } catch (err) {
        // Fire-and-forget: approval still works even if inbox creation fails
        hv2Log.error('Auth service inbox error', { error: (err as Error).message });
      }
    },
  });

  // Register approval gate and human task executors (both need engine instance)
  const approvalGateExecutor = new ApprovalGateExecutor({ approvalEngine });
  executorRegistry.register(approvalGateExecutor);

  const humanTaskExecutor = new HumanTaskExecutor({ approvalEngine });
  executorRegistry.register(humanTaskExecutor);

  const notificationDeliverExecutor = new NotificationDeliverExecutor({ approvalEngine });
  executorRegistry.register(notificationDeliverExecutor);

  // Re-register subworkflow executor with full deps (replaces the placeholder)
  const fullSubworkflowExecutor = new SubworkflowExecutor({
    workflowStore,
    executors: executorRegistry,
    envelopeStore,
  });
  executorRegistry.register(fullSubworkflowExecutor);

  // P9 + P8.B + QSKL-2 wiring: the agenticExecutor singleton is module-level
  // (constructed before async main() runs), so stores are not available at
  // construction time. Inject them now before any workflow executes.
  agenticExecutor.setSkillLibraryStore(skillLibraryStore);
  agenticExecutor.setExecutionHistoryStore(executionHistoryStore);  // MEM-DECAY MD.3
  agenticExecutor.setQuoxSkillsStore(quoxSkillsStore);  // QSKL-2 Gap 1
  agenticExecutor.setQuoxSkillPatchesStore(quoxSkillPatchesStore);  // QSKL-4.A
  if (quoxSkillInvocationsStore) {
    agenticExecutor.setSkillInvocationsStore(quoxSkillInvocationsStore);  // QSKL-7.8
  }
  agenticExecutor.setEvidenceStore(evidenceStore);       // QSKL-4.D
  agenticExecutor.setApprovalEngine(approvalEngine);     // QSKL-4.D
  agenticExecutor.setPrecedentStore(precedentStore);     // PRECEDENT done-gate

  // AEE-FULL-P2: wire EvidenceStore into the three tool-dispatch executors
  // so quox.flow.tool.invoked / .completed envelopes can store full args/result
  // blobs (>16KB) via sha256-keyed side storage. Mirrors agenticExecutor wiring.
  toolCallExecutor.setEvidenceStore(evidenceStore);
  callExecutor.setEvidenceStore(evidenceStore);
  browserExecutor.setEvidenceStore(evidenceStore);

  // AEE-FULL-P3: wire EvidenceStore into the LLM-dispatch executors so
  // quox.flow.llm.invoked / .completed envelopes can store full prompt + completion
  // blobs (>16KB) via sha256-keyed side storage. agenticExecutor.setEvidenceStore
  // was already wired above (QSKL-4.D). Same pattern for the other two.
  agentInvokeExecutor.setEvidenceStore(evidenceStore);
  assistantInvokeExecutor.setEvidenceStore(evidenceStore);

  // AUDIT-FIX: call/agent-invoke/assistant-invoke previously minted a
  // `evidence:<ulid>` ref and attached it to the result without ever
  // persisting anything — a phantom pointer. They now persist the real
  // request/response (or prompt/completion) exchange via the evidenceStore
  // already wired above (see each executor's inline comment). team-member
  // had the same phantom bug AND no evidenceStore wiring at all — add it
  // here so its ref resolves too. Without this wiring the executor still
  // runs, it just correctly omits evidenceRefs.
  teamMemberExecutor.setEvidenceStore(evidenceStore);

  // QSKL-6: Real Toolsmith adapter, backed by the collector's live
  // validate/analyse/sandbox-run pipeline. buildToolFromSkill is fully
  // functional when a skill carries authored tool.json/script.py source;
  // draftSkillFromTool honestly reports NO_DOCS (no collector endpoint
  // exists to read back a published tool's docs). See
  // agentic/toolsmith-collector-adapter.ts.
  const toolsmithAdapter = createCollectorToolsmithAdapter({
    collectorUrl: process.env.COLLECTOR_URL ?? 'http://collector:9848',
    serviceKey: process.env.INTERNAL_SERVICE_KEY ?? '',
    skillsStore: quoxSkillsStore,
  });
  agenticExecutor.setToolsmithAdapter(toolsmithAdapter);
  agenticExecutor.setBudgetEvaluator(budgetEvaluator);

  // QSKL-13: Session FTS search store. Postgres when dbUrl is set, in-memory fallback.
  // Hoisted (not block-scoped) so it can be passed to both agenticExecutor and createApp.
  const sessionSearchStore = dbUrl && PgPool
    ? createPostgresSessionSearchStore(new PgPool({ connectionString: dbUrl }))
    : createInMemorySessionSearchStore();
  agenticExecutor.setSessionSearchStore(sessionSearchStore);  // QSKL-13

  // QSKL-14a: Instantiate patch rate-limiter and wire to agenticExecutor.
  // Default: 10 patches per 24h per agent. Override via QSKL_PATCH_RATE_LIMIT_PER_DAY.
  const patchRateLimiter = createPatchRateLimiter({ patchesStore: quoxSkillPatchesStore });
  agenticExecutor.setPatchRateLimiter(patchRateLimiter);

  // QSKL-SAFETY.B / Fix3: Instantiate firewall + log store and wire to agenticExecutor.
  // Default-ON: createSkillFirewall() uses process.env; set QSKL_FIREWALL_DISABLED=true to bypass.
  // Fix3: Use Postgres-backed log store when DATABASE_URL is set; fall back to
  // in-memory only when DB is absent (mirrors the pattern used by all other stores).
  const skillFirewall = createSkillFirewall();
  const skillFirewallLogStore = dbUrl && PgPool
    ? createPostgresSkillFirewallLogStore(new PgPool({ connectionString: dbUrl }))
    : createInMemorySkillFirewallLogStore();
  agenticExecutor.setSkillFirewall(skillFirewall);             // QSKL-SAFETY.B
  agenticExecutor.setSkillFirewallLogStore(skillFirewallLogStore);  // QSKL-SAFETY.B

  // QSKL-SAFETY.E: Instantiate review queue store and wire to agenticExecutor.
  // Postgres-backed when DATABASE_URL is set; in-memory fallback otherwise.
  // QSKL-7.7a: Skill scoreboard reader. Reads the org-partitioned materialised view
  // (migration 016+). Only wired when PG is configured — in-memory mode → /scoreboard
  // returns 503 by design.
  const skillScoreboardReader: SkillScoreboardReader | undefined = dbUrl && PgPool
    ? (() => {
        const pool = new PgPool({ connectionString: dbUrl });
        return {
          readAll: (scope: ScoreboardOrgScope) => listSkillScoreboard(pool, scope),
          readOne: (skillId: string, orgId?: string) => readSkillScoreboard(pool, skillId, orgId ?? SYSTEM_SCOPE),
        };
      })()
    : undefined;

  const skillReviewQueueStore = dbUrl && PgPool
    ? createPostgresSkillReviewQueueStore(new PgPool({ connectionString: dbUrl }))
    : createInMemorySkillReviewQueueStore();
  agenticExecutor.setSkillReviewQueueStore(skillReviewQueueStore);  // QSKL-SAFETY.E
  agenticExecutor.setEnvelopeStore(envelopeStore);                  // QSKL-SAFETY Gap 6

  // QSKL-12: Wire real persona fetcher (HTTP call to collector per agent run).
  agenticExecutor.setPersonaFetcher(fetchPersona);

  // QSKL-SAFETY self-bootstrap: create tables inline (CREATE TABLE IF NOT EXISTS)
  // so production deploys work without running migration files manually.
  await skillFirewallLogStore.init();
  await skillReviewQueueStore.init();

  // Create app
  const authEnabled = process.env.QUOXFLOW_AUTH_ENABLED === 'true';
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
  const webhookRegistry = new WebhookRegistry();

  // QSKL-11a: Instantiate skill-decay cron so it can be passed to createApp
  // (POST /api/internal/skill-decay/run ops trigger) AND scheduled below.
  // MEM-DECAY MD.2: envelopeStore wired so the cron can emit a quox.decay.swept
  // AEE event per run (fire-and-forget; already initialised above for AOCL/HITL emissions).
  // MEM-DECAY MD.3: success-rate branch reuses the same skillScoreboardReader wired
  // for the /scoreboard route above (readAll() -> listSkillScoreboard(pool)) —
  // undefined in in-memory mode, so the branch is skipped there by design.
  const skillDecayCron = createSkillDecayCron({
    store: quoxSkillsStore,
    evidenceStore,
    envelopeStore,
    scoreboard: skillScoreboardReader
      ? { list: () => skillScoreboardReader.readAll(SYSTEM_SCOPE) } // trusted system job: all orgs
      : undefined,
  });

  // QSKL-11b: Build the judge LLM client + weekly judge job + scheduler.
  // Default-ON. Set QSKL_JUDGE_DISABLED=true to disable.
  const judgeLlmClient = createCollectorLlmClient({
    collectorUrl: process.env.COLLECTOR_URL ?? 'http://collector:9848',
    serviceKey: process.env.INTERNAL_SERVICE_KEY ?? '',
  });
  const skillJudgeJob = createSkillJudgeJob({
    store: quoxSkillsStore,
    llmClient: judgeLlmClient,
    evidenceStore,
  });

  // MEM-DECAY MD.3: lineage graph LLM client — one call per failed run,
  // wired through ExecutionService -> durable-hooks.ts. Same collector
  // /api/internal/agents/invoke endpoint as judgeLlmClient, distinct agent_id.
  const lineageLlmClient = createLineageAnalyzerCollectorClient({
    collectorUrl: process.env.COLLECTOR_URL ?? 'http://collector:9848',
    serviceKey: process.env.INTERNAL_SERVICE_KEY ?? '',
  });

  // QSKL-5.F: Real skill-execution context, backed by the same collector
  // invoke endpoint judgeLlmClient uses. Wired into both the manual
  // POST /api/quox-skills/:id/run-tests route (via createApp config) and the
  // daily skill-tests cron below, so author-written skill tests actually
  // execute instead of warn-and-noop.
  const skillExecuteContext = createCollectorSkillExecuteContext({
    collectorUrl: process.env.COLLECTOR_URL ?? 'http://collector:9848',
    serviceKey: process.env.INTERNAL_SERVICE_KEY ?? '',
  });

  // QSKL-SAFETY.E: Safety judge job — runs weekly on Tuesday 05:00 UTC.
  // Targets experimental skills. Queues failing skills in skill_review_queue.
  const skillSafetyJudgeJob = createSkillSafetyJudgeJob({
    store: quoxSkillsStore,
    llmClient: judgeLlmClient,
    reviewQueueStore: skillReviewQueueStore,
    evidenceStore,
    envelopeStore,  // QSKL-SAFETY Gap 6: AOCL layer-5 gate emissions
  });

  const app = createApp({
    envelopeStore,
    workflowStore,
    executionStore,
    policyStore,
    approvalEngine,
    // R5.high-2: pass approval store so deactivate can cancel pending approvals.
    approvalStore,
    evidenceStore,
    skillLibraryStore,
    skillPackStore,
    quoxSkillsStore,
    quoxSkillPatchesStore,  // QSKL-4.A
    quoxSkillInvocationsStore,  // QSKL-7.8 — per-invocation telemetry (undefined in in-memory mode)
    executeSkillContext: skillExecuteContext,  // QSKL-5.F — powers POST /:id/run-tests
    toolsmithAdapter,  // QSKL-6 — real collector-backed adapter; webhook + future build calls
    executionHistoryStore,
    observationStore,
    scheduleExecutor,
    eventBus,
    webhookRegistry,
    executors: executorRegistry,
    authEnabled,
    corsOrigins,
    // P8.B + P8.C: wire evaluators so ControlPipeline budget + policy guards fire
    budgetStore,
    budgetEvaluator,
    budgetScopeResolver,
    policyEvaluator,
    // REPLAY-ONLY .A-1a: flag store (CRUD route) + resolver (ControlPipeline wiring)
    replayOnlyFlagsStore,
    replayOnlyResolver,
    skillDecayCron,  // QSKL-11a — ops manual trigger at POST /api/internal/skill-decay/run
    skillJudgeJob,   // QSKL-11b — ops manual trigger at POST /api/internal/skill-judge/run
    sessionSearchStore,  // QSKL-13 — FTS search REST endpoint
    patchRateLimiter,    // QSKL-14a — per-agent patch rate-limiting
    skillFirewall,       // QSKL-SAFETY.B — firewall gate on skill writes
    skillFirewallLogStore,  // QSKL-SAFETY.B — persist scan results
    skillSafetyJudgeJob,    // QSKL-SAFETY.E — ops trigger at POST /api/internal/skill-safety-judge/run
    skillReviewQueueStore,  // QSKL-SAFETY.E — review queue store for promotion gate
    skillScoreboardReader,  // QSKL-7.7a — org-partitioned scoreboard reader (migration 016)
    lineageLlmClient,  // MEM-DECAY MD.3 — lineage graph LLM client
  });

  const port = parseInt(process.env.PORT || '3000', 10);

  log.info('Quoxflow API Server starting', {
    port,
    database: dbUrl ? 'PostgreSQL' : 'In-memory',
    auth: authEnabled ? 'Enabled (JWT + Service Key)' : 'Disabled',
    cors: corsOrigins ? corsOrigins.join(', ') : '*',
    executorsRegistered: executorRegistry.getRegisteredTypes().length,
  });

  serve({
    fetch: app.fetch,
    port,
  });

  log.info(`Server listening at http://localhost:${port}`);

  // Bootstrap triggers for active workflows
  try {
    const bootstrapResult = await bootstrapTriggers({
      workflowStore,
      executionStore,
      envelopeStore,
      scheduleExecutor,
      eventBus,
      executors: executorRegistry,
      observationStore,
      executionHistoryStore,
      skillLibraryStore,
      evidenceStore,
      // R3.crit-2: wire budget + policy gates for schedule/event/webhook triggers
      budgetEvaluator,
      budgetScopeResolver,
      policyEvaluator,
      // REPLAY-ONLY .A-1a: same wiring for schedule/event/webhook triggered runs
      replayOnlyResolver,
      approvalEngine,
      lineageLlmClient,  // MEM-DECAY MD.3
    });

    // Register bootstrapped webhooks. QF-MT WP4: wh.orgId (owning workflow's
    // org) is threaded into the registry. Per-entry try/catch so a single
    // cross-org path collision doesn't abort registering the rest of the
    // startup batch — the offending workflow's webhook simply doesn't
    // register (its activation would need to be retried/fixed).
    for (const wh of bootstrapResult.webhooks) {
      try {
        webhookRegistry.register(wh.path, wh.workflowId, wh.nodeId, wh.orgId, wh.method);
      } catch (err) {
        log.error(`Webhook registration failed for ${wh.workflowId}:${wh.nodeId} (/${wh.path})`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info(`Triggers: ${bootstrapResult.registered} workflows, ${scheduleExecutor.activeCount} schedules, ${eventBus.subscriberCount} event subscriptions, ${bootstrapResult.webhooks.length} webhooks`);
  } catch (err) {
    log.error('Warning: trigger bootstrap failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // R5.high-4: Register nightly validation suite cron if enabled.
  // Gated on QUOXFLOW_VALIDATION_SUITE=true so it's off by default.
  if (process.env.QUOXFLOW_VALIDATION_SUITE === 'true') {
    scheduleNightly();
  }

  // QSKL-5.F: Register daily skill tests cron if enabled.
  // executeSkillContext is now wired to the real collector invoke path
  // (skillExecuteContext, built above) — the cron actually runs author
  // tests when enabled. orgIds is intentionally omitted so the sweep covers
  // every org via QuoxSkillsStore.listAllStableSkills(). See
  // skill-tests-scheduler.ts.
  if (process.env.QUOXFLOW_SKILL_TESTS_CRON === 'true') {
    scheduleSkillTestsDaily({ store: quoxSkillsStore, executeSkillContext: skillExecuteContext });
  }

  // QSKL-7.8: Register daily stale-flag cron (default: ON).
  // Set QSKL_STALE_FLAG_JOB_ENABLED=false to disable.
  // Requires a real DB (dbUrl must be set).
  if (process.env.QSKL_STALE_FLAG_JOB_ENABLED !== 'false' && dbUrl) {
    const { Pool: StaleFlagPool } = await import('pg');
    const staleFlagPool = new StaleFlagPool({ connectionString: dbUrl });
    const staleFlagSchedule = process.env.QSKL_STALE_FLAG_SCHEDULE ?? '0 3 * * *';
    scheduleSkillStaleFlagDaily({
      pool: staleFlagPool,
      skillsStore: quoxSkillsStore,
      schedule: staleFlagSchedule,
      enabled: true,
    });
  }

  // QSKL-11a: Register daily skill-decay cron (default: ON).
  // Set QSKL_DECAY_DISABLED=true to disable.
  // skillDecayCron instance created above (before createApp) so the same object
  // backs both the scheduled job and the POST /api/internal/skill-decay/run route.
  scheduleSkillDecayDaily({ cron: skillDecayCron });

  // QSKL-11b: Register weekly skill-judge cron (default: ON, Mon 04:00 UTC).
  // Set QSKL_JUDGE_DISABLED=true to disable.
  // skillJudgeJob instance created above (before createApp) so the same object
  // backs both the scheduled job and the POST /api/internal/skill-judge/run route.
  scheduleSkillJudgeWeekly({ job: skillJudgeJob });

  // QSKL-SAFETY.E: Register weekly safety-judge cron (default: ON, Tue 05:00 UTC).
  // Set QSKL_SAFETY_JUDGE_DISABLED=true to disable.
  // Different day from skill-judge cron to spread load.
  scheduleSkillSafetyJudgeWeekly({ job: skillSafetyJudgeJob });

  // Issue #499: Register approval-expiry sweep (default: ON, every 5 min).
  // Set QUOXFLOW_APPROVAL_EXPIRY_DISABLED=true to disable. Nothing previously
  // scheduled ApprovalEngine.processExpired() — the only caller was the
  // admin route (POST /admin/expire) — so a pending approval past
  // expiresAt stayed pending forever. See approval-expiry-scheduler.ts for
  // the failure-accounting/backoff/retirement triad.
  const approvalExpiryScheduler = scheduleApprovalExpirySweep({ engine: approvalEngine });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    shutdownLog.info('SIGTERM received, stopping schedules...');
    scheduleExecutor.stopAll();
    approvalExpiryScheduler?.stop();
    eventBus.clear();
    shutdownLog.info('Triggers stopped. Exiting.');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    shutdownLog.info('SIGINT received, stopping schedules...');
    scheduleExecutor.stopAll();
    approvalExpiryScheduler?.stop();
    eventBus.clear();
    process.exit(0);
  });

  // Static reference banner — unchanging per-boot endpoint list, useful for a
  // human tailing boot logs but not worth an info-level line per route.
  // Collapsed to a single debug-level call (was 34 separate console.log calls).
  log.debug(
    'Endpoints:\n' +
      '  GET  /health                      Health check\n' +
      '  POST /api/workflows               Create workflow\n' +
      '  GET  /api/workflows               List workflows\n' +
      '  GET  /api/workflows/:id           Get workflow\n' +
      '  POST /api/workflows/:id/validate  Validate workflow\n' +
      '  POST /api/workflows/:id/execute   Execute workflow\n' +
      '  POST /api/workflows/import-n8n    Import n8n workflow\n' +
      '  GET  /api/executions              List executions\n' +
      '  GET  /api/executions/:id          Get execution\n' +
      '  GET  /api/executions/:id/envelopes Get execution envelopes\n' +
      '  GET  /api/envelopes               Query envelopes\n' +
      '  GET  /api/envelopes/:id           Get envelope\n' +
      '  GET  /api/envelopes/:id/chain     Get causality chain\n' +
      '  POST /api/policies                Create policy\n' +
      '  GET  /api/policies                List policies\n' +
      '  GET  /api/policies/:id            Get policy\n' +
      '  PUT  /api/policies/:id            Update policy\n' +
      '  DELETE /api/policies/:id          Delete policy\n' +
      '  POST /api/policies/:id/test       Test policy\n' +
      '  POST /api/policies/test           Test inline policy\n' +
      '  POST /api/approvals               Create approval request\n' +
      '  GET  /api/approvals               List approvals\n' +
      '  GET  /api/approvals/stats         Approval statistics\n' +
      '  GET  /api/approvals/pending/:user Pending for user\n' +
      '  GET  /api/approvals/:id           Get approval\n' +
      '  POST /api/approvals/:id/approve   Approve request\n' +
      '  POST /api/approvals/:id/deny      Deny request\n' +
      '  POST /api/approvals/:id/cancel    Cancel request\n' +
      '  GET  /api/evidence                List evidence\n' +
      '  GET  /api/evidence/:id            Get evidence record\n' +
      '  GET  /api/evidence/:id/content    Download evidence\n' +
      '  DELETE /api/evidence/:id          Delete evidence\n' +
      '  GET  /api/schedules              List active schedules\n' +
      '  POST /api/workflows/:id/activate  Activate workflow triggers\n' +
      '  POST /api/workflows/:id/deactivate Deactivate workflow triggers\n' +
      '  POST /webhooks/:path              Webhook trigger endpoint',
  );
}

main().catch(error => {
  log.error('Fatal error', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
