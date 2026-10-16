/**
 * Skills API Routes — STUDY-REV W4
 *
 * The visible surface for the W2-persisted Skill Library.
 *
 * GET    /api/skills                 → list latest-version skills, scoped per org
 * GET    /api/skills/:id             → fetch one skill by id
 * POST   /api/skills/from-execution  → idempotent crystallisation trigger
 *                                       body: { workflowId }
 *                                       returns: 201 created | 200 already-exists | 422 NOT_READY
 */

import { Hono, type Context } from 'hono';
import { AppEnv } from '../types.js';
import { z } from 'zod';
import { validateBody, validateParams, IdParamSchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes } from '../middleware/error-handler.js';
import { requireOrgScope } from '../middleware/org-scope.js';
import { SkillLibraryStore } from '../../store/skill-library-store.js';
import { ExecutionHistoryStore } from '../../store/execution-history-store.js';
import { ExecutionStore } from '../stores/execution-store.js';
import { WorkflowStore } from '../stores/workflow-store.js';
import {
  analyseExecutionHistory,
  analyseDraft,
  crystallise,
  extractVariables,
  CrystallisationCandidate,
  ExecutionRecord,
} from '../../pipeline/crystalliser.js';

const FromExecutionSchema = z.object({
  workflowId: z.string().min(1),
  workflowName: z.string().optional(),
});

/** P9.4: Schemas for draft + promote-draft endpoints */
const DraftLookupSchema = z.object({
  executionId: z.string().min(1),
});

const PromoteDraftSchema = z.object({
  executionId: z.string().min(1),
  /** Caller asserts their tier. tier_b = allowed, tier_a = 402. Default: tier_a */
  orgTier: z.enum(['tier_a', 'tier_b']).optional(),
});

const RollbackSchema = z.object({
  sourceWorkflowId: z.string().min(1),
  targetVersion: z.number().int().positive(),
});

function success<T>(c: { json: (data: unknown, status?: number) => Response; get: (key: string) => unknown }, data: T, status = 200) {
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

function failure(
  c: { json: (data: unknown, status?: number) => Response; get: (key: string) => unknown },
  code: string,
  message: string,
  status: number
) {
  return c.json(
    {
      success: false,
      error: { code, message },
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

// Org scope: the shared requireOrgScope (middleware/org-scope.ts). The old local resolveOrgId
// read `user.org_id || X-Org-ID` for any authenticated caller, so a user token without an
// org could name any org in the header. Now a user token is served only for its JWT org, a
// service-key caller for its X-Org-Id, and a service caller with no org is refused (403).
const resolveOrgId = (c: Context<AppEnv>): string => requireOrgScope(c);

export function createSkillsRoutes(deps: {
  skillLibraryStore: SkillLibraryStore;
  executionHistoryStore: ExecutionHistoryStore;
  /** Optional: canonical executions table for legacy backfill union-read. */
  executionStore?: ExecutionStore;
  /** Optional: workflow store used to synthesise actionLog for legacy rows. */
  workflowStore?: WorkflowStore;
}) {
  const app = new Hono<AppEnv>();

  // GET /api/skills - List latest-version skills for the org
  app.get('/', async c => {
    const orgId = resolveOrgId(c);
    const skills = await deps.skillLibraryStore.list({ orgId });
    return success(c, skills);
  });

  // GET /api/skills/:id - Fetch one skill
  app.get('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = resolveOrgId(c);

    const all = await deps.skillLibraryStore.list({ orgId, includeAllVersions: true });
    const skill = all.find(s => s.id === id);
    if (!skill) {
      throw new NotFoundError(ErrorCodes.NOT_FOUND ?? 'NOT_FOUND', `Skill ${id} not found`);
    }
    return success(c, skill);
  });

  // GET /api/skills/by-source/:sourceWorkflowId
  // STUDY-REV SV-2: full version history for one source workflow,
  // ascending. Used by the SkillLibraryView version-history accordion
  // and as the data source for rollback target selection.
  app.get('/by-source/:sourceWorkflowId', async c => {
    const sourceWorkflowId = c.req.param('sourceWorkflowId');
    if (!sourceWorkflowId) {
      return failure(c, 'INVALID_PARAM', 'sourceWorkflowId is required', 400);
    }
    const orgId = resolveOrgId(c);
    const versions = await deps.skillLibraryStore.listVersions({ orgId, sourceWorkflowId });
    return success(c, versions);
  });

  // POST /api/skills/rollback-to-version
  // STUDY-REV SV-2: rollback writes a NEW version that copies the target
  // version's content. Latest-pointer semantics stay simple (latest
  // version is always the active one) and the audit trail is preserved
  // by adding 'rolled-back' + 'from-version-N' tags to the new entry.
  app.post('/rollback-to-version', validateBody(RollbackSchema), async c => {
    const body = c.get('validatedBody') as z.infer<typeof RollbackSchema>;
    const orgId = resolveOrgId(c);

    const versions = await deps.skillLibraryStore.listVersions({
      orgId,
      sourceWorkflowId: body.sourceWorkflowId,
    });
    if (versions.length === 0) {
      throw new NotFoundError(
        ErrorCodes.NOT_FOUND ?? 'NOT_FOUND',
        `No skills exist for source workflow ${body.sourceWorkflowId}`
      );
    }

    const target = versions.find(v => v.version === body.targetVersion);
    if (!target) {
      return failure(
        c,
        'TARGET_VERSION_NOT_FOUND',
        `Version ${body.targetVersion} not found for ${body.sourceWorkflowId} ` +
        `(available: ${versions.map(v => v.version).join(', ')})`,
        422
      );
    }

    const latest = versions[versions.length - 1];
    if (target.id === latest.id) {
      // Rolling back to the current latest is a no-op semantically; return
      // the latest unchanged so the caller can render "already at v3".
      return success(c, latest, 200);
    }

    const baseTags = Array.isArray(target.tags) ? target.tags : [];
    const rollbackTags = Array.from(new Set([
      ...baseTags,
      'rolled-back',
      `from-version-${target.version}`,
    ]));

    const written = await deps.skillLibraryStore.write({
      orgId,
      sourceWorkflowId: target.sourceWorkflowId,
      name: target.name,
      confidence: target.confidence,
      executionCount: target.executionCount,
      successRate: target.successRate,
      workflowJson: target.workflowJson,
      tags: rollbackTags,
      variables: target.variables,
    });

    return success(c, written, 201);
  });

  // POST /api/skills/from-execution - Manually crystallise a workflow into a skill
  app.post('/from-execution', validateBody(FromExecutionSchema), async c => {
    const body = c.get('validatedBody') as z.infer<typeof FromExecutionSchema>;
    const orgId = resolveOrgId(c);

    // Idempotent: if a skill already exists for this source workflow, return it.
    const existing = await deps.skillLibraryStore.getLatest({
      orgId,
      sourceWorkflowId: body.workflowId,
    });
    if (existing) {
      return success(c, existing, 200);
    }

    // Step 1: read from execution_history (primary, post-W2-wire rows).
    const recent = await deps.executionHistoryStore.getRecent({
      orgId,
      workflowId: body.workflowId,
      limit: 50,
    });

    // Step 2: legacy backfill — union-read from canonical executions table.
    // For any executions row whose id is NOT already represented in execution_history
    // (matched by exec_id), synthesise an ExecutionRecord stub so the Crystalliser
    // sees the true run count. Only terminal statuses count: completed or failed.
    // running and paused are excluded because they haven't proven the pattern yet.
    let combined: ExecutionRecord[] = [...recent];

    if (deps.executionStore) {
      // Collect exec_ids already in execution_history so we can dedup.
      const historyExecIds = new Set(recent.map(r => r.id));

      // Fetch all completed + failed runs from canonical table.
      // QF-MT WP5: orgId already resolved above for this route (line ~214).
      const legacyCompleted = await deps.executionStore.list(orgId, {
        workflowId: body.workflowId,
        status: 'completed',
        limit: 500,
      });
      const legacyFailed = await deps.executionStore.list(orgId, {
        workflowId: body.workflowId,
        status: 'failed',
        limit: 500,
      });
      const legacyAll = [...legacyCompleted, ...legacyFailed];

      // Fetch workflow definition once (to derive actionLog for structural checks).
      let syntheticActionLog: Array<{ action: string; params: Record<string, unknown> }> = [];
      if (deps.workflowStore && legacyAll.some(e => !historyExecIds.has(e.id))) {
        // QF-MT WP3: orgId already resolved above for this route (line ~214).
        const wf = await deps.workflowStore.get(body.workflowId, orgId);
        if (wf?.definition?.nodes) {
          syntheticActionLog = wf.definition.nodes.map(n => ({
            action: n.type as string,
            params: (n.config ?? (n as unknown as Record<string, unknown>).data ?? {}) as Record<string, unknown>,
          }));
        }
      }

      // Build stubs for executions not already in history.
      for (const e of legacyAll) {
        if (historyExecIds.has(e.id)) continue; // already counted via history row
        combined.push({
          id: e.id,
          success: e.status === 'completed',
          nodeTypes: [],
          nodeCount: e.nodeCount ?? 0,
          durationMs: e.duration ?? 0,
          actionLog: syntheticActionLog,
        });
      }
    }

    const analysis = analyseExecutionHistory(combined);
    if (!analysis.ready) {
      return failure(c, 'NOT_READY', analysis.reason || 'Workflow not ready for crystallisation', 422);
    }

    const successfulRuns = combined.filter(r => r.success);
    const canonicalActions = successfulRuns[0]?.actionLog ?? [];
    const variables = extractVariables(combined);

    const candidate: CrystallisationCandidate = {
      workflowId: body.workflowId,
      workflowName: body.workflowName || body.workflowId,
      confidence: analysis.confidence,
      executionCount: analysis.executionCount,
      successRate: analysis.successRate,
      canonicalActions,
      variables,
    };

    const crystallised = crystallise(candidate);

    const written = await deps.skillLibraryStore.write({
      orgId,
      sourceWorkflowId: body.workflowId,
      name: crystallised.name,
      confidence: analysis.confidence,
      executionCount: analysis.executionCount,
      successRate: analysis.successRate,
      workflowJson: crystallised as unknown as Record<string, unknown>,
      tags: crystallised.tags,
      variables,
    });

    return success(c, written, 201);
  });

  // ─── P9.4: Task-time draft + promotion endpoints ──────────────────────
  //
  // QF-MT WP7: draft lookup by executionId previously had no org constraint —
  // any caller who could guess/observe an executionId could read (and, via
  // promote-draft, promote) another org's in-flight Crystal draft. Both
  // routes now use requireOrgScope() (tenant-mandatory — a service caller
  // without X-Org-Id gets 403, there's no legitimate cross-org use here) and
  // 404 when the draft's org doesn't match the caller's resolved org (hides
  // existence, same as the rest of the org-isolation pattern).

  // POST /api/skills/draft — get in-flight draft for an execution
  app.post('/draft', validateBody(DraftLookupSchema), async c => {
    const body = c.get('validatedBody') as z.infer<typeof DraftLookupSchema>;
    const orgId = requireOrgScope(c);
    const draft = deps.skillLibraryStore.getDraftByExecution(body.executionId);
    if (!draft || draft.orgId !== orgId) {
      return failure(c, 'NOT_FOUND', `No in-flight draft found for executionId: ${body.executionId}`, 404);
    }
    return success(c, draft, 200);
  });

  // POST /api/skills/promote-draft — promote a draft Crystal to the skill library
  // Tier_b gate: tier_a returns 402, tier_b proceeds with candidate promotion.
  app.post('/promote-draft', validateBody(PromoteDraftSchema), async c => {
    const body = c.get('validatedBody') as z.infer<typeof PromoteDraftSchema>;

    // Tier gate — default to tier_a (no access) if orgTier not specified
    const orgTier = body.orgTier || 'tier_a';
    if (orgTier !== 'tier_b') {
      return failure(c, 'TIER_REQUIRED', 'Task-time crystal promotion requires tier_b. Upgrade your plan.', 402);
    }

    const orgId = requireOrgScope(c);
    const draft = deps.skillLibraryStore.getDraftByExecution(body.executionId);
    if (!draft || draft.orgId !== orgId) {
      return failure(c, 'NOT_FOUND', `No in-flight draft found for executionId: ${body.executionId}`, 404);
    }

    // Promote to candidate
    const promoted = await deps.skillLibraryStore.promote({
      orgId: draft.orgId,
      executionId: draft.executionId,
      name: draft.name,
      summary: draft.summary,
      actionPattern: draft.actionPattern,
      confidence: draft.confidence,
      agentId: draft.agentId,
      objectiveKeywords: draft.objectiveKeywords,
    }, { stage: 'candidate' });

    // Clear draft after promotion
    deps.skillLibraryStore.clearDraft(body.executionId);

    return success(c, promoted, 201);
  });

  return app;
}
