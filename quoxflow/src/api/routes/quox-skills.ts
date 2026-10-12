/**
 * QuoxSkills API Routes — QSKL-1
 *
 * Procedural-knowledge layer, distinct from legacy /api/skills (Crystals).
 *
 * GET    /api/quox-skills                    → list (orgId required)
 * GET    /api/quox-skills/versions           → version history by name
 * GET    /api/quox-skills/by-name/:name      → latest version by name (orgId in query)
 * GET    /api/quox-skills/:id                → fetch by id
 * POST   /api/quox-skills                    → create
 * PATCH  /api/quox-skills/:id                → update (mutable fields only)
 * DELETE /api/quox-skills/:id                → hard delete
 */

import { queueHumanReview } from '../../agentic/skill-human-review.js';
import { Hono } from 'hono';
import { AppEnv } from '../types.js';
import { z } from 'zod';
import { validateBody, validateParams, IdParamSchema } from '../middleware/validation.js';
import { NotFoundError, ErrorCodes, ApiError } from '../middleware/error-handler.js';
import { requireOrgScope, SYSTEM_SCOPE } from '../middleware/org-scope.js';
import { QuoxSkillsStore, QuoxSkillInput } from '../../store/quox-skills-store.js';
import { QuoxSkillPatchesStore } from '../../store/quox-skill-patches-store.js';
import { SkillLibraryStore } from '../../store/skill-library-store.js';
import { applySkillPatch } from '../../agentic/skill-patch-flow.js';
import { runSkillTests, SkillTestExecuteContext } from '../../agentic/skill-test-runner.js';
import { persistTestEvals } from '../../agentic/skill-test-evals.js';
import type { ToolsmithAdapter } from '../../agentic/toolsmith-adapter.js';
import { EnvelopeStore } from '../../store/envelope-store.js';
import { envelopes, Intents, EnvelopeFactory } from '../../core/envelope.js';
import type { ScoreboardRow } from '../../store/skill-scoreboard.js';
import { createSkillFirewall } from '../../security/skill_firewall.js';
import type { SkillFirewall, SkillInput } from '../../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../../store/skill-firewall-log-store.js';
import type { SkillReviewQueueStore } from '../../store/skill-review-queue-store.js';
import { emitQsklSafetyAocl } from '../../security/qskl-safety-aocl.js';
import type { SkillOverridesStore, SkillOverrideScope } from '../../store/skill-overrides-store.js';
import { mergeSkillOverridesForRead, findNonOverridableFields } from '../../agentic/skill-overrides-merge.js';

const _aoclFactory = new EnvelopeFactory('agent.qskl-routes');

// ─── Scoreboard Reader Interface ──────────────────────────────────────────────

/**
 * Abstraction over the PG-backed skill_scoreboard view.
 * Accepted by createQuoxSkillsRoutes so callers can inject an in-memory
 * fake in tests without requiring a live Postgres connection.
 *
 * readOne is org-scoped (migration 016): callers must pass orgId so the view
 * returns only the requesting org's invocation aggregates for the skill.
 */
export interface SkillScoreboardReader {
  readOne(skillId: string, orgId?: string): Promise<ScoreboardRow | null>;
  readAll(): Promise<ScoreboardRow[]>;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const CreateSkillSchema = z.object({
  /** quox#748: agent-authored skills (chat skill_manage, NotesQ propose) are queued for human review and gated until approved. */
  requireHumanReview: z.boolean().optional(),
  reviewSource: z.enum(['chat', 'notesq', 'api']).optional(),
  orgId: z.string().min(1),
  scopeId: z.string().min(1).nullable(),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
  bodyMd: z.string().min(1),
  author: z.string().min(1),
  // SKILLRIGHTS #478: licence declaration, recorded verbatim (no allowlist).
  license: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  bestForAgents: z.array(z.string()).optional(),
  requiredTools: z.array(z.any()).optional(),
  relatedSkills: z.array(z.any()).optional(),
  delegateTargets: z.array(z.any()).optional(),
  llmPreference: z.record(z.string(), z.unknown()).optional(),
  modelDirectives: z.record(z.string(), z.string()).optional(),
  policySatisfies: z.array(z.string()).optional(),
  policyRequired: z.array(z.string()).optional(),
  kind: z.string().optional(),
  refs: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  tests: z.record(z.string(), z.unknown()).optional(),
  authoringEnvelopeId: z.string().optional(),
});

const UpdateSkillSchema = z.object({
  description: z.string().optional(),
  bodyMd: z.string().optional(),
  // SKILLRIGHTS #478: nullable so a caller can explicitly clear a licence.
  license: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  bestForAgents: z.array(z.string()).optional(),
  requiredTools: z.array(z.any()).optional(),
  relatedSkills: z.array(z.any()).optional(),
  delegateTargets: z.array(z.any()).optional(),
  llmPreference: z.record(z.string(), z.unknown()).optional(),
  modelDirectives: z.record(z.string(), z.string()).optional(),
  policySatisfies: z.array(z.string()).optional(),
  policyRequired: z.array(z.string()).optional(),
  refs: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  tests: z.record(z.string(), z.unknown()).optional(),
  edition: z.enum(['experimental', 'stable', 'deprecated', 'archived']).optional(),
  decayState: z.string().optional(),
  lastPatchedBy: z.string().optional(),
  lastPatchEnvelopeId: z.string().optional(),
  signature: z.string().optional(),
  signedBy: z.string().optional(),
  supersededBy: z.string().optional(),
  evals: z.record(z.string(), z.unknown()).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type HonoCtx = {
  json: (data: unknown, status?: number) => Response;
  get: (key: string) => unknown;
  req: { query: (k: string) => string | undefined; raw: Request };
};

function success<T>(c: HonoCtx, data: T, status = 200) {
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
  c: HonoCtx,
  code: string,
  message: string,
  status: number,
  data?: Record<string, unknown>
) {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return c.json(
    {
      success: false,
      error,
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

/**
 * resolveOrgId — JWT-primary.
 *
 * When auth middleware is active (c.get('user') is set), org_id MUST come from
 * the JWT. A missing or empty org_id in the JWT throws a 401 — there is no
 * query-param or 'org-default' fallback. This prevents cross-org identity spoofing.
 *
 * When auth middleware is NOT active (c.get('user') is undefined, i.e. authEnabled=false
 * in dev/test), the query param ?orgId= is accepted as a backwards-compatible fallback
 * so that existing tests and internal tooling do not break.
 *
 * If both are absent, throws 401.
 *
 * IMPORTANT: Once a request reaches a route handler the auth middleware has already
 * run (when auth is enabled). If user is set but org_id is missing, it means the
 * JWT was valid but the token was issued without an org — that is always a 401.
 */
// QF-MT WP1: resolveOrgId was extracted into the shared helper
// src/api/middleware/org-scope.ts. This route uses requireOrgScope(c) — identical
// behavior for JWT (access-token) callers; service-key callers now receive 403
// (system scope) instead of 401 when no X-Org-Id header is supplied.

/**
 * QSKL-HARDEN HRD-1: resolve the requesting user id for the user-scope
 * override layer. Mirrors the x-user-id header fallback already used by the
 * PATCH /:id route for author attribution in dev/test mode.
 */
function resolveUserId(c: HonoCtx): string | null {
  const user = c.get('user') as { id?: string; user_id?: string } | undefined;
  if (user?.id) return user.id;
  if (user?.user_id) return user.user_id;
  const header = (c.req as unknown as { header?: (k: string) => string | undefined }).header?.('x-user-id');
  return header ?? null;
}

/**
 * PG numeric columns come back as strings. Normalise them to JS numbers so
 * the API response always has numeric types regardless of the storage backend.
 */
function normaliseScoreboardRow(row: ScoreboardRow) {
  return {
    skill_id: row.skill_id,
    success_rate_30d: Number(row.success_rate_30d),
    success_rate_7d: Number(row.success_rate_7d),
    total_invocations_30d: Number(row.total_invocations_30d),
    total_invocations_7d: Number(row.total_invocations_7d),
    avg_cost_usd: row.avg_cost_usd != null ? Number(row.avg_cost_usd) : null,
    avg_latency_ms: row.avg_latency_ms != null ? Number(row.avg_latency_ms) : null,
    crystal_hit_rate: Number(row.crystal_hit_rate),
    drift_trend: row.drift_trend != null ? Number(row.drift_trend) : null,
    last_used_at: row.last_used_at,
    refreshed_at: row.refreshed_at,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createQuoxSkillsRoutes(deps: {
  store: QuoxSkillsStore;
  patchesStore: QuoxSkillPatchesStore;
  skillLibraryStore?: SkillLibraryStore;
  evidenceStore?: import('../../evidence/types.js').EvidenceStore;
  approvalEngine?: import('../../approval/approval-engine.js').ApprovalEngine;
  /** QSKL-5.E: Optional test execution context. When absent, run-tests returns 503. */
  executeSkillContext?: SkillTestExecuteContext;
  /** QSKL-7.7a: Optional scoreboard reader. When absent, scoreboard routes return 503/404. */
  scoreboardReader?: SkillScoreboardReader;
  /** QSKL-SAFETY.B: Firewall instance. Defaults to createSkillFirewall() when absent. */
  firewall?: SkillFirewall;
  /** QSKL-SAFETY.B: Firewall log store. When absent, no log rows are written. */
  firewallLogStore?: SkillFirewallLogStore;
  /** QSKL-SAFETY.E: Review queue store. When provided, blocks experimental→stable when active review row exists. */
  reviewQueueStore?: SkillReviewQueueStore;
  /** QSKL-SAFETY.F: Envelope store for skill.review_decided events. */
  envelopeStore?: EnvelopeStore;
  /**
   * QSKL-HARDEN HRD-1: Skill overrides store. When provided, GET /:id merges
   * org/user overrides into the served view and the /:name/override routes
   * are enabled. When absent, reads are unmerged and the override routes
   * return 503.
   */
  overridesStore?: SkillOverridesStore;
}) {
  const app = new Hono<AppEnv>();

  // GET /api/quox-skills/versions?name=X&orgId=Y — version history by name
  // Mounted before /:id so the path segment "versions" doesn't match as an id.
  app.get('/versions', async c => {
    const name = c.req.query('name');
    if (!name) {
      return failure(c, 'INVALID_PARAM', 'name is required', 400);
    }
    const orgId = requireOrgScope(c);
    const versions = await deps.store.listVersions({ orgId, name });
    return success(c, versions);
  });

  // GET /api/quox-skills/by-name/:name — latest version by name
  app.get('/by-name/:name', async c => {
    const name = c.req.param('name');
    if (!name) {
      return failure(c, 'INVALID_PARAM', 'name is required', 400);
    }
    const orgId = requireOrgScope(c);
    const version = c.req.query('version');
    const record = await deps.store.findByName({ orgId, name, version });
    if (!record) {
      throw new NotFoundError(ErrorCodes.NOT_FOUND, `Skill "${name}" not found`);
    }
    return success(c, record);
  });

  // GET /api/quox-skills/scoreboards — bulk scoreboard (QSKL-7.7a)
  // Mounted before /:id to prevent "scoreboards" matching as an id.
  app.get('/scoreboards', async c => {
    if (!deps.scoreboardReader) {
      return failure(c, 'SCOREBOARD_NOT_CONFIGURED', 'Scoreboard reader not wired. Requires a live database connection.', 503);
    }
    const rows = await deps.scoreboardReader.readAll();
    // Normalise numeric fields from PG numeric type (returned as strings) to JS numbers
    const normalised = rows.map(normaliseScoreboardRow);
    return success(c, normalised);
  });

  // GET /api/quox-skills/with-status?ids=a,b,c — bulk status for decay-badge lookups (QSKL-11a)
  // Mounted before /:id so the path segment "with-status" is matched literally.
  app.get('/with-status', async c => {
    const idsParam = c.req.query('ids');
    if (idsParam === undefined) {
      return c.json({ error: 'ids query parameter required' }, 400);
    }
    if (idsParam === '') return c.json([]);
    const orgId = requireOrgScope(c);
    const ids = idsParam.split(',').map((s: string) => s.trim()).filter(Boolean);
    const results: Array<{ id: string; edition: string; decayState: string }> = [];
    for (const id of ids) {
      const skill = await deps.store.findById(id, orgId);
      if (skill) {
        results.push({ id: skill.id, edition: skill.edition, decayState: skill.decayState });
      }
    }
    return c.json(results);
  });

  // GET /api/quox-skills — list
  app.get('/', async c => {
    const orgId = requireOrgScope(c);
    if (!orgId || orgId === 'org-default') {
      // Still allow org-default (service callers), but enforce explicit orgId in strict mode
    }
    const category = c.req.query('category');
    const edition = c.req.query('edition');
    const agentId = c.req.query('agentId');
    const tag = c.req.query('tag');
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    // QSKL-AP-1: optional ordering
    const orderByRaw = c.req.query('orderBy');
    const orderBy = orderByRaw === 'last_used_at' || orderByRaw === 'created_at' ? orderByRaw : undefined;
    const orderRaw = c.req.query('order');
    const order = orderRaw === 'asc' || orderRaw === 'desc' ? orderRaw : undefined;

    const records = await deps.store.list({ orgId, category, edition, agentId, tag, limit, orderBy, order });
    return success(c, records);
  });

  // ─── QSKL-SAFETY.F: Review Queue Routes ──────────────────────────────────
  //
  // Mounted BEFORE /:id so "review-queue" doesn't match as an id param.
  //
  // GET  /review-queue                → list items (default status=pending, org-scoped)
  // GET  /review-queue/:qid           → single item with skill snapshot + firewall log
  // POST /review-queue/:qid/approve   → approve + emit skill.review_decided
  // POST /review-queue/:qid/reject    → reject  + emit skill.review_decided

  /**
   * Join a queue row with skill metadata (name, body_md preview, author, edition, created_at)
   * and the latest firewall log row for the same skill_id.
   * orgId is required for org-scoped firewall log access.
   */
  async function enrichQueueRow(row: import('../../store/skill-review-queue-store.js').SkillReviewQueueRow, includeBodyMd = false, orgId?: string) {
    // Use unchecked for review-queue enrichment: the queue row is already org-scoped
    // (listByStatus filters by orgId), so skill lookup can use unchecked without leaking.
    const skill = row.skill_id ? await deps.store.findByIdUnchecked(row.skill_id) : null;
    const BODY_MD_PREVIEW_MAX = 4096;

    let latestFirewallLog: unknown = null;
    if (deps.firewallLogStore && row.skill_id && orgId) {
      const logs = await deps.firewallLogStore.listBySkill(row.skill_id, orgId);
      if (logs.length > 0) {
        const sorted = [...logs].sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
        latestFirewallLog = sorted[0];
      }
    }

    return {
      ...row,
      skill_name: skill?.name ?? null,
      ...(includeBodyMd ? {
        skill_body_md_preview: skill?.bodyMd
          ? skill.bodyMd.slice(0, BODY_MD_PREVIEW_MAX)
          : null,
        skill_author_id: skill?.author ?? null,
        skill_edition: skill?.edition ?? null,
        skill_created_at: skill?.createdAt ?? null,
      } : {}),
      latest_firewall_log: latestFirewallLog,
    };
  }

  app.get('/review-queue', async c => {
    if (!deps.reviewQueueStore) {
      return failure(c, 'REVIEW_QUEUE_NOT_CONFIGURED', 'Review queue store not wired.', 503);
    }
    const orgId = requireOrgScope(c);
    const statusParam = c.req.query('status');
    const validStatuses = ['pending', 'approved', 'rejected'] as const;
    const status = validStatuses.includes(statusParam as typeof validStatuses[number])
      ? (statusParam as typeof validStatuses[number])
      : 'pending';

    const rows = await deps.reviewQueueStore.listByStatus(status, orgId);
    const enriched = await Promise.all(rows.map(r => enrichQueueRow(r, false, orgId)));
    return success(c, enriched);
  });

  app.get('/review-queue/:qid', async c => {
    if (!deps.reviewQueueStore) {
      return failure(c, 'REVIEW_QUEUE_NOT_CONFIGURED', 'Review queue store not wired.', 503);
    }
    const qid = c.req.param('qid');
    const row = await deps.reviewQueueStore.getById(qid, SYSTEM_SCOPE);
    if (!row) {
      return failure(c, 'NOT_FOUND', `Review queue item ${qid} not found`, 404);
    }
    const orgId = requireOrgScope(c);
    if (row.org_id && row.org_id !== orgId) {
      return failure(c, 'FORBIDDEN', 'Review queue item belongs to a different org', 403);
    }
    const enriched = await enrichQueueRow(row, true, orgId);
    return success(c, enriched);
  });

  app.post('/review-queue/:qid/approve', async c => {
    if (!deps.reviewQueueStore) {
      return failure(c, 'REVIEW_QUEUE_NOT_CONFIGURED', 'Review queue store not wired.', 503);
    }
    const qid = c.req.param('qid');
    const row = await deps.reviewQueueStore.getById(qid, SYSTEM_SCOPE);
    if (!row) {
      return failure(c, 'NOT_FOUND', `Review queue item ${qid} not found`, 404);
    }
    const orgId = requireOrgScope(c);
    if (row.org_id && row.org_id !== orgId) {
      return failure(c, 'FORBIDDEN', 'Review queue item belongs to a different org', 403);
    }
    if (row.status !== 'pending') {
      return failure(c, 'ALREADY_DECIDED', `Review queue item is already ${row.status}`, 409);
    }

    const user = c.get('user') as { user_id?: string } | undefined;
    const reviewerId = user?.user_id ?? null;

    let comment: string | null = null;
    try {
      const body = await c.req.json() as { comment?: string };
      comment = typeof body?.comment === 'string' ? body.comment : null;
    } catch { /* comment is optional */ }

    // DB write FIRST — no governance theater
    await deps.reviewQueueStore.markDecision({ id: qid, status: 'approved', reviewer_id: reviewerId, comment });

    // Emit envelope fire-and-forget
    if (deps.envelopeStore) {
      try {
        const correlationId = (c.get('correlationId') as string) ?? qid;
        await deps.envelopeStore.append(
          envelopes.event('skill.review_decided', correlationId, {
            queue_row_id: qid,
            skill_id: row.skill_id,
            decision: 'approve',
            reviewer_id: reviewerId,
            comment,
            decided_at: new Date().toISOString(),
          }),
          orgId
        );
      } catch { /* fire-and-forget */ }
    }

    // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete for review approve
    {
      const corrId = (c.get('correlationId') as string) ?? qid;
      await emitQsklSafetyAocl({
        envelopeStore: deps.envelopeStore,
        factory: _aoclFactory,
        correlationId: corrId,
        gate: 'skill_review',
        outcome: 'complete',
        skillId: row.skill_id,
        orgId: row.org_id ?? null,
        extra: { queue_row_id: qid, decision: 'approve', reviewer_id: reviewerId },
      });
    }

    const updated = await deps.reviewQueueStore.getById(qid, SYSTEM_SCOPE);
    return success(c, updated);
  });

  app.post('/review-queue/:qid/reject', async c => {
    if (!deps.reviewQueueStore) {
      return failure(c, 'REVIEW_QUEUE_NOT_CONFIGURED', 'Review queue store not wired.', 503);
    }
    const qid = c.req.param('qid');
    const row = await deps.reviewQueueStore.getById(qid, SYSTEM_SCOPE);
    if (!row) {
      return failure(c, 'NOT_FOUND', `Review queue item ${qid} not found`, 404);
    }
    const orgId = requireOrgScope(c);
    if (row.org_id && row.org_id !== orgId) {
      return failure(c, 'FORBIDDEN', 'Review queue item belongs to a different org', 403);
    }
    if (row.status !== 'pending') {
      return failure(c, 'ALREADY_DECIDED', `Review queue item is already ${row.status}`, 409);
    }

    const user = c.get('user') as { user_id?: string } | undefined;
    const reviewerId = user?.user_id ?? null;

    let comment: string | null = null;
    try {
      const body = await c.req.json() as { comment?: string };
      comment = typeof body?.comment === 'string' ? body.comment : null;
    } catch { /* comment is optional */ }

    // DB write FIRST — no governance theater
    await deps.reviewQueueStore.markDecision({ id: qid, status: 'rejected', reviewer_id: reviewerId, comment });

    // Emit envelope fire-and-forget
    if (deps.envelopeStore) {
      try {
        const correlationId = (c.get('correlationId') as string) ?? qid;
        await deps.envelopeStore.append(
          envelopes.event('skill.review_decided', correlationId, {
            queue_row_id: qid,
            skill_id: row.skill_id,
            decision: 'reject',
            reviewer_id: reviewerId,
            comment,
            decided_at: new Date().toISOString(),
          }),
          orgId
        );
      } catch { /* fire-and-forget */ }
    }

    // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for review queue reject
    {
      const corrId = (c.get('correlationId') as string) ?? qid;
      await emitQsklSafetyAocl({
        envelopeStore: deps.envelopeStore,
        factory: _aoclFactory,
        correlationId: corrId,
        gate: 'skill_review',
        outcome: 'reject',
        skillId: row.skill_id,
        orgId: row.org_id ?? null,
        extra: { queue_row_id: qid, decision: 'reject', reviewer_id: reviewerId },
      });
    }

    const updated = await deps.reviewQueueStore.getById(qid, SYSTEM_SCOPE);
    return success(c, updated);
  });

  // GET /api/quox-skills/:id — fetch by id (org-scoped: 404 on cross-org)
  app.get('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    const record = await deps.store.findById(id, orgId);
    if (!record) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    // QSKL-HARDEN HRD-1: merge org/user overrides into the served view.
    // Canonical row is never mutated — only the response body is affected.
    const userId = resolveUserId(c);
    const { merged, override_applied } = await mergeSkillOverridesForRead(
      record as unknown as Record<string, unknown>,
      { overridesStore: deps.overridesStore, orgId, skillName: record.name, userId }
    );
    return success(c, override_applied ? { ...merged, override_applied } : merged);
  });

  // ─── QSKL-HARDEN HRD-1: Skill Override Routes ────────────────────────────
  //
  // PUT    /:name/override    → upsert an org- or user-scope override
  // DELETE /:name/override    → reset (remove) an override for a scope
  //
  // Mounted before /:id so ":name/override" isn't mistaken for an id segment
  // (it has an extra path component, so it wouldn't collide anyway, but the
  // ordering keeps this section grouped with the other named sub-resources).

  const OverrideUpsertSchema = z.object({
    scope: z.enum(['org', 'user']),
    userId: z.string().min(1).optional(),
    overrides: z.record(z.string(), z.unknown()),
  });

  app.put('/:name/override', validateBody(OverrideUpsertSchema), async c => {
    if (!deps.overridesStore) {
      return failure(c, 'OVERRIDES_NOT_CONFIGURED', 'Skill overrides store not wired.', 503);
    }
    const name = c.req.param('name');
    const body = c.get('validatedBody') as z.infer<typeof OverrideUpsertSchema>;
    const orgId = requireOrgScope(c);

    if (body.scope === 'user' && !body.userId) {
      return failure(c, 'INVALID_PARAM', 'userId is required when scope="user"', 400);
    }

    const badFields = findNonOverridableFields(body.overrides);
    if (badFields.length > 0) {
      return failure(
        c,
        'FIELD_NOT_OVERRIDABLE',
        `Field(s) not overridable: ${badFields.join(', ')}`,
        400,
        { fields: badFields }
      );
    }

    const createdBy = resolveUserId(c) ?? 'unknown';
    const row = await deps.overridesStore.upsert({
      org_id: orgId,
      skill_name: name,
      scope: body.scope,
      user_id: body.scope === 'user' ? body.userId : null,
      overrides: body.overrides,
      created_by: createdBy,
    });
    return success(c, row);
  });

  app.delete('/:name/override', async c => {
    if (!deps.overridesStore) {
      return failure(c, 'OVERRIDES_NOT_CONFIGURED', 'Skill overrides store not wired.', 503);
    }
    const name = c.req.param('name');
    const orgId = requireOrgScope(c);
    const scopeParam = c.req.query('scope');
    const scope: SkillOverrideScope = scopeParam === 'user' ? 'user' : 'org';
    const userId = c.req.query('userId');

    if (scope === 'user' && !userId) {
      return failure(c, 'INVALID_PARAM', 'userId query param is required when scope=user', 400);
    }

    const deleted = await deps.overridesStore.delete({ orgId, skillName: name, scope, userId: userId ?? null });
    return success(c, { deleted });
  });

  // POST /api/quox-skills — create
  app.post('/', validateBody(CreateSkillSchema), async c => {
    const body = c.get('validatedBody') as z.infer<typeof CreateSkillSchema>;

    // QSKL-SAFETY.B / Fix2: Firewall scan before DB insert.
    // Log ordering:
    //   - BLOCK path: write log with skill_id=null + pending_skill_name BEFORE returning 422
    //   - ALLOW path: write log with real skill_id AFTER store.create() succeeds
    const fw = deps.firewall ?? createSkillFirewall();
    const skillInput: SkillInput = {
      body_md: body.bodyMd,
      references: body.refs as Record<string, string> | undefined,
      scripts: body.scripts as Record<string, string> | undefined,
      metadata: { name: body.name, description: body.description, tags: body.tags },
      author_id: body.author,
      tags: Array.isArray(body.tags) ? body.tags : [],
    };
    const scanReport = await fw.scan(skillInput);
    // orgId resolved from JWT (auth mode) or URL/body fallback (dev/test mode).
    const orgId = requireOrgScope(c);

    // QSKL-HARDEN HRD-2: ?dry_run=true — return the validated firewall verdict
    // as a preview, BEFORE any write (no firewallLogStore row, no evidence
    // envelope, no AOCL emission, no deps.store.create()).
    if (c.req.query('dry_run') === 'true') {
      return c.json(
        {
          success: scanReport.allow,
          ...(scanReport.allow ? {} : { error: { code: 'FIREWALL_BLOCKED', message: `Skill body rejected by firewall (${scanReport.findings.length} finding(s))` } }),
          data: {
            dryRun: true,
            wouldCreate: scanReport.allow,
            findings: scanReport.findings,
            scanned_at: scanReport.scanned_at,
            rule_set_version: scanReport.rule_set_version,
          },
          meta: { requestId: c.get('correlationId'), timestamp: new Date().toISOString() },
        },
        scanReport.allow ? 200 : 422
      );
    }

    if (!scanReport.allow && scanReport.reason !== 'disabled') {
      // BLOCK path: log with NULL skill_id + pending_skill_name
      if (deps.firewallLogStore) {
        try {
          await deps.firewallLogStore.record({
            skill_id: null,
            pending_skill_name: body.name,
            version: 1,
            org_id: orgId,
            author_id: body.author,
            scanned_at: scanReport.scanned_at,
            allow: false,
            findings: scanReport.findings,
            reason: scanReport.reason ?? null,
            rule_set_version: scanReport.rule_set_version,
            source: 'api_publish',
          });
        } catch (logErr) {
          console.warn('[POST /api/quox-skills] firewallLogStore.record() (block) failed (best-effort):', logErr);
        }
      }
      // QSKL-SAFETY-EV #108: best-effort evidence envelope emission on block
      // (no record.id yet since DB insert never happened — mirrors the
      // firewallLogStore block-path use of pending_skill_name in place of skill_id).
      if (deps.evidenceStore) {
        try {
          const { ulid: _ulid } = await import('ulid');
          const envelopeMeta: Record<string, unknown> = {
            pending_skill_name: body.name,
            org_id: orgId,
            allow: false,
            finding_count: scanReport.findings.length,
            rule_set_version: scanReport.rule_set_version,
            source: 'api_publish',
            scanned_at: scanReport.scanned_at,
          };
          await deps.evidenceStore.store({
            correlationId: body.name,
            envelopeId: _ulid(),
            type: 'skill_firewall_scanned',
            contentType: 'application/json',
            content: JSON.stringify(envelopeMeta),
            metadata: envelopeMeta,
            orgId,
          });
        } catch (evErr) {
          console.warn('[POST /api/quox-skills] evidenceStore.store(skill_firewall_scanned block) failed (best-effort):', evErr);
        }
      }
      // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for firewall block on publish
      {
        const corrId = (c.get('correlationId') as string) ?? body.name ?? 'unknown';
        await emitQsklSafetyAocl({
          envelopeStore: deps.envelopeStore,
          factory: _aoclFactory,
          correlationId: corrId,
          gate: 'skill_firewall',
          outcome: 'reject',
          skillName: body.name,
          orgId,
          extra: { source: 'api_publish', finding_count: scanReport.findings.length },
        });
      }
      return failure(
        c,
        'FIREWALL_BLOCKED',
        `Skill body rejected by firewall (${scanReport.findings.length} finding(s))`,
        422,
        {
          findings: scanReport.findings,
          scanned_at: scanReport.scanned_at,
          rule_set_version: scanReport.rule_set_version,
        }
      );
    }

    try {
      const { requireHumanReview, reviewSource, ...skillBody } = body;
      const record = await deps.store.create(skillBody as QuoxSkillInput);

      // quox#748: queue agent-authored skills for human review (skill_view refuses them until approved).
      const humanReview = requireHumanReview
        ? await queueHumanReview(deps.reviewQueueStore, { skillId: record.id, version: record.version, orgId, author: body.author ?? null, source: reviewSource ?? 'api' })
        : null;

      // ALLOW path: log with real skill_id now that DB row exists
      if (scanReport.reason !== 'disabled' && deps.firewallLogStore) {
        try {
          await deps.firewallLogStore.record({
            skill_id: record.id,
            pending_skill_name: null,
            version: 1,
            org_id: orgId,
            author_id: body.author,
            scanned_at: scanReport.scanned_at,
            allow: true,
            findings: scanReport.findings,
            reason: scanReport.reason ?? null,
            rule_set_version: scanReport.rule_set_version,
            source: 'api_publish',
          });
        } catch (logErr) {
          console.warn('[POST /api/quox-skills] firewallLogStore.record() (allow) failed (best-effort):', logErr);
        }
      }

      // Best-effort evidence envelope emission (after DB insert, use real id)
      if (scanReport.reason !== 'disabled' && deps.evidenceStore) {
        try {
          const { ulid: _ulid } = await import('ulid');
          const envelopeMeta: Record<string, unknown> = {
            skill_id: record.id,
            org_id: orgId,
            allow: scanReport.allow,
            finding_count: scanReport.findings.length,
            rule_set_version: scanReport.rule_set_version,
            source: 'api_publish',
            scanned_at: scanReport.scanned_at,
          };
          await deps.evidenceStore.store({
            correlationId: record.id,
            envelopeId: _ulid(),
            type: 'skill_firewall_scanned',
            contentType: 'application/json',
            content: JSON.stringify(envelopeMeta),
            metadata: envelopeMeta,
            orgId,
          });
        } catch (evErr) {
          console.warn('[POST /api/quox-skills] evidenceStore.store(skill_firewall_scanned) failed (best-effort):', evErr);
        }
      }

      // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete for firewall allow on publish
      if (scanReport.reason !== 'disabled') {
        const corrId = (c.get('correlationId') as string) ?? record.id;
        await emitQsklSafetyAocl({
          envelopeStore: deps.envelopeStore,
          factory: _aoclFactory,
          correlationId: corrId,
          gate: 'skill_firewall',
          outcome: 'complete',
          skillId: record.id,
          skillName: record.name,
          orgId,
          extra: { source: 'api_publish' },
        });
      }

      return success(c, humanReview ? { ...record, review: { status: humanReview.queued ? "pending_human_review" : "not_queued", queue_row_id: humanReview.row?.id ?? null } } : record, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('already exists')) {
        return failure(c, 'DUPLICATE_SKILL', msg, 409);
      }
      throw err;
    }
  });

  // PATCH /api/quox-skills/:id — update mutable fields
  app.patch('/:id', validateParams(IdParamSchema), validateBody(UpdateSkillSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const patch = c.get('validatedBody') as z.infer<typeof UpdateSkillSchema>;

    // body_md (camelCase: bodyMd) present → go through the patch audit flow
    if (patch.bodyMd !== undefined) {
      // QSKL-HARDEN HRD-2: ?dry_run=true — suppresses the firewall log row,
      // evidence envelope, and AOCL emission below (in addition to threading
      // dryRun through applySkillPatch, which owns the rest of the write path).
      const dryRun = c.req.query('dry_run') === 'true';

      // QSKL-SAFETY Fix1: Firewall scan BEFORE applySkillPatch runs.
      // Block-tier content must not reach the patch flow via the REST path.
      {
        const fw = deps.firewall ?? createSkillFirewall();
        const skillInput: SkillInput = {
          body_md: patch.bodyMd,
          metadata: {},
          author_id: (c.req as any).header?.('x-user-id') ?? 'http',
          tags: [],
        };
        const report = await fw.scan(skillInput);

        if (report.reason !== 'disabled' && !dryRun) {
          const orgId = requireOrgScope(c);
          if (deps.firewallLogStore) {
            try {
              await deps.firewallLogStore.record({
                skill_id: id,
                version: 1,
                org_id: orgId,
                author_id: (c.req as any).header?.('x-user-id') ?? null,
                scanned_at: report.scanned_at,
                allow: report.allow,
                findings: report.findings,
                reason: report.reason ?? null,
                rule_set_version: report.rule_set_version,
                source: 'api_patch',
              });
            } catch (logErr) {
              console.warn('[PATCH /api/quox-skills/:id] firewallLogStore.record() failed (best-effort):', logErr);
            }
          }
        }

        if (!report.allow) {
          // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for PATCH firewall block
          // (skipped in dry-run — a preview must not emit governance envelopes)
          if (!dryRun) {
            const corrId = (c.get('correlationId') as string) ?? id;
            const patchOrgId = report.reason !== 'disabled' ? requireOrgScope(c) : null;
            await emitQsklSafetyAocl({
              envelopeStore: deps.envelopeStore,
              factory: _aoclFactory,
              correlationId: corrId,
              gate: 'skill_firewall',
              outcome: 'reject',
              skillId: id,
              orgId: patchOrgId,
              extra: { source: 'api_patch', finding_count: report.findings.length },
            });
          }
          return failure(
            c,
            'FIREWALL_BLOCKED',
            `Skill body rejected by firewall (${report.findings.length} finding(s))`,
            422,
            {
              findings: report.findings,
              scanned_at: report.scanned_at,
              rule_set_version: report.rule_set_version,
            }
          );
        }

        // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete for PATCH firewall allow
        if (report.allow && report.reason !== 'disabled' && !dryRun) {
          const corrId = (c.get('correlationId') as string) ?? id;
          const patchOrgId = requireOrgScope(c);
          await emitQsklSafetyAocl({
            envelopeStore: deps.envelopeStore,
            factory: _aoclFactory,
            correlationId: corrId,
            gate: 'skill_firewall',
            outcome: 'complete',
            skillId: id,
            orgId: patchOrgId,
            extra: { source: 'api_patch' },
          });
        }
      }

      const userId = (c.req as any).header?.('x-user-id') ?? 'http';
      const { bodyMd, ...metadataPatch } = patch;

      const result = await applySkillPatch({
        skillsStore: deps.store,
        patchesStore: deps.patchesStore,
        skillLibraryStore: deps.skillLibraryStore,
        evidenceStore: deps.evidenceStore,
        approvalEngine: deps.approvalEngine,
        orgId: requireOrgScope(c),
        skillId: id,
        newBodyMd: bodyMd,
        patchedBy: userId,
        metadataPatch: metadataPatch as Record<string, unknown>,
        dryRun,
      });

      if (!result.ok) {
        if (result.code === 'NOT_FOUND') {
          throw new NotFoundError(ErrorCodes.NOT_FOUND, `Skill ${id} not found`);
        }
        if (result.code === 'CRYSTALS_REGRESSED') {
          return failure(c, 'PATCH_CRYSTALS_REGRESSED', `${result.crystalsFailed.length} Crystal(s) failed evaluation.`, 422);
        }
        if (result.code === 'STORE_ERROR') {
          throw new Error(result.message);
        }
        if (result.code === 'REQUIRED_TOOL_MISSING') {
          return failure(c, 'REQUIRED_TOOL_MISSING', result.message, 422);
        }
        if (result.code === 'TESTS_FAILED') {
          return failure(c, 'PATCH_TESTS_FAILED', `${result.testsFailed.length} of ${result.testsRun} author-written test(s) failed.`, 422);
        }
        if (result.code === 'RATE_LIMITED') {
          return failure(c, 'RATE_LIMITED', `Agent patch rate limit reached (${result.count}/${result.threshold}).`, 429);
        }
      }

      if (!result.ok) {
        throw new Error(`applySkillPatch unhandled error code: ${(result as { code: string }).code}`);
      }

      // QSKL-HARDEN HRD-2: dry-run preview — no skill/patch was persisted.
      if ('dryRun' in result) {
        return success(c, {
          dryRun: true,
          diff: result.diff,
          testsOutcome: result.testsOutcome,
          crystalEvalOutcome: result.crystalEvalOutcome,
          wouldPromote: result.wouldPromote,
        });
      }

      return success(c, { skill: result.skill, patch: result.patch });
    }

    // metadata-only patch (no bodyMd) — skip audit flow

    // QSKL-SAFETY.E: Promotion gate — block experimental→stable when
    // a pending or rejected review queue row exists for this skill.
    // Must fire BEFORE deps.store.update() to prevent partial updates.
    if (patch.edition === 'stable' && deps.reviewQueueStore) {
      const activeRow = await deps.reviewQueueStore.findActiveBySkill(id);
      if (activeRow) {
        // Best-effort evidence envelope
        if (deps.evidenceStore) {
          try {
            const { ulid: _ulid } = await import('ulid');
            const gatedMeta: Record<string, unknown> = {
              skill_id: id,
              org_id: requireOrgScope(c),
              queue_row_id: activeRow.id,
              queue_status: activeRow.status,
              reason: 'PROMOTION_GATED_BY_REVIEW',
            };
            await deps.evidenceStore.store({
              correlationId: id,
              envelopeId: _ulid(),
              type: 'skill.promotion_gated',
              contentType: 'application/json',
              content: JSON.stringify(gatedMeta),
              metadata: gatedMeta,
              orgId: requireOrgScope(c),
            });
          } catch (evErr) {
            console.warn('[PATCH /api/quox-skills/:id] evidenceStore.store(skill.promotion_gated) failed (best-effort):', evErr);
          }
        }
        // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for promotion gate block
        {
          const corrId = (c.get('correlationId') as string) ?? id;
          await emitQsklSafetyAocl({
            envelopeStore: deps.envelopeStore,
            factory: _aoclFactory,
            correlationId: corrId,
            gate: 'skill_promotion',
            outcome: 'reject',
            skillId: id,
            orgId: requireOrgScope(c),
            extra: { queue_row_id: activeRow.id, queue_status: activeRow.status },
          });
        }
        return failure(
          c,
          'PROMOTION_GATED_BY_REVIEW',
          `Skill cannot be promoted to stable: an active review queue entry exists (status=${activeRow.status}, id=${activeRow.id})`,
          422
        );
      }
    }

    try {
      const record = await deps.store.update(id, patch);
      return success(c, record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw new NotFoundError(ErrorCodes.NOT_FOUND, msg);
      }
      if (/cannot promote to stable/i.test(msg)) {
        return failure(c, 'PROMOTION_BLOCKED', msg, 422);
      }
      throw err;
    }
  });

  // GET /api/quox-skills/:id/patches — version + patch history for a skill
  app.get('/:id/patches', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);

    const skill = await deps.store.findById(id, orgId);
    if (!skill) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    const patches = await deps.patchesStore.listBySkillId(id);
    // Ensure DESC order (in-memory store returns unordered; PG already orders by created_at DESC)
    patches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const versions = await deps.store.listVersions({ orgId, name: skill.name });

    return success(c, { patches, versions });
  });

  // POST /api/quox-skills/:id/revert — revert current skill body to a prior version
  const RevertBodySchema = z.object({
    to_version: z.string().min(1),
    reason: z.string().optional(),
  });

  app.post('/:id/revert', validateParams(IdParamSchema), validateBody(RevertBodySchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const { to_version, reason } = c.get('validatedBody') as z.infer<typeof RevertBodySchema>;
    const orgId = requireOrgScope(c);

    const skill = await deps.store.findById(id, orgId);
    if (!skill) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    // Look up the target version row
    const targetVersion = await deps.store.findByName({ orgId, name: skill.name, version: to_version });
    if (!targetVersion) {
      return failure(c, 'INVALID_TARGET_VERSION', `Version ${to_version} not found for skill "${skill.name}"`, 422);
    }

    const userId = (c.req as any).header?.('x-user-id') ?? 'http:revert';
    const revertReason = `manual revert to ${to_version}${reason ? ' — ' + reason : ''}`;

    const result = await applySkillPatch({
      skillsStore: deps.store,
      patchesStore: deps.patchesStore,
      skillLibraryStore: deps.skillLibraryStore,
      evidenceStore: deps.evidenceStore,
      approvalEngine: deps.approvalEngine,
      orgId,
      skillId: id,
      newBodyMd: targetVersion.bodyMd,
      patchedBy: userId,
      reason: revertReason,
    });

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') {
        throw new NotFoundError(ErrorCodes.NOT_FOUND, `Skill ${id} not found`);
      }
      if (result.code === 'CRYSTALS_REGRESSED') {
        return failure(c, 'PATCH_CRYSTALS_REGRESSED', `${result.crystalsFailed.length} Crystal(s) failed evaluation.`, 422);
      }
      if (result.code === 'STORE_ERROR') {
        throw new Error(result.message);
      }
      if (result.code === 'REQUIRED_TOOL_MISSING') {
        return failure(c, 'REQUIRED_TOOL_MISSING', result.message, 422);
      }
    }

    if (!result.ok) {
      throw new Error(`applySkillPatch unhandled error code: ${(result as { code: string }).code}`);
    }
    // /revert never passes dryRun, so this branch is unreachable at runtime —
    // narrowed only to satisfy the ApplySkillPatchResult union.
    if ('dryRun' in result) {
      throw new Error('applySkillPatch returned a dry-run result on a non-dry-run call');
    }
    return success(c, { skill: result.skill, patch: result.patch });
  });

  // POST /api/quox-skills/:id/run-tests — ad-hoc test trigger (QSKL-5.E)
  app.post('/:id/run-tests', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);

    // Org-ownership guard: 404 on cross-org (don't leak existence)
    const skill = await deps.store.findById(id, orgId);
    if (!skill) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    if (!deps.executeSkillContext) {
      return failure(c, 'TESTS_NOT_CONFIGURED', 'Test execution engine not wired. The cron scheduler will wire one; POST run-tests works once a SkillTestExecuteContext is configured.', 503);
    }

    const result = await runSkillTests(skill, deps.executeSkillContext);
    const summary = await persistTestEvals(deps.store, id, result);

    return success(c, { skillId: id, summary, results: result.results });
  });

  // GET /api/quox-skills/:id/scoreboard — single scoreboard row (QSKL-7.7a)
  app.get('/:id/scoreboard', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);

    // Org-ownership guard: 404 on cross-org (don't leak existence)
    const skill = await deps.store.findById(id, orgId);
    if (!skill) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    if (!deps.scoreboardReader) {
      return failure(c, 'SCOREBOARD_NOT_CONFIGURED', 'Scoreboard reader not wired. Requires a live database connection.', 503);
    }

    const row = await deps.scoreboardReader.readOne(id, orgId);
    if (!row) {
      return failure(c, ErrorCodes.NOT_FOUND, `No scoreboard row found for skill ${id}`, 404);
    }

    return success(c, normaliseScoreboardRow(row));
  });

  // GET /api/quox-skills/:id/evals — fetch persisted evals (QSKL-5.E)
  app.get('/:id/evals', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);

    const skill = await deps.store.findById(id, orgId);
    if (!skill) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }

    return success(c, { skillId: id, evals: skill.evals ?? {} });
  });

  // POST /api/quox-skills/:id/archive — manually archive a decay-flagged skill (QSKL-11a)
  app.post('/:id/archive', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    // Org-ownership guard: 404 on cross-org (don't leak existence)
    const existing = await deps.store.findById(id, orgId);
    if (!existing) return failure(c, ErrorCodes.NOT_FOUND, 'skill not found', 404);
    const updated = await deps.store.update(id, { decayState: 'archived', edition: 'archived' });
    return success(c, updated);
  });

  // DELETE /api/quox-skills/:id (org-scoped: 404 on cross-org)
  app.delete('/:id', validateParams(IdParamSchema), async c => {
    const { id } = c.get('validatedParams') as z.infer<typeof IdParamSchema>;
    const orgId = requireOrgScope(c);
    // Org-ownership guard: 404 on cross-org (don't leak existence)
    const existing = await deps.store.findById(id, orgId);
    if (!existing) {
      return failure(c, ErrorCodes.NOT_FOUND, `Skill ${id} not found`, 404);
    }
    await deps.store.delete(id);
    return success(c, { id, deleted: true });
  });

  return app;
}

// ─── Internal Webhook Factory — QSKL-6.6 ─────────────────────────────────────
//
// POST /api/internal/tool-published
//   Called by Toolsmith when it publishes a new tool. Drafts a skill from the
//   tool via the adapter, emits an audit envelope, and returns the result.
//
//   200  → adapter returned ok:true (draftSkillId in body)
//   202  → adapter returned ok:false (NOT_SHIPPED or other reason — accepted,
//           no draft created)
//   400  → malformed body (toolName or version missing)
//   503  → no adapter wired

export function createInternalSkillsRoutes(deps: {
  toolsmithAdapter?: ToolsmithAdapter;
  envelopeStore?: EnvelopeStore;
}) {
  const app = new Hono<AppEnv>();

  app.post('/tool-published', async c => {
    const correlationId = c.get('correlationId') as string ?? 'internal';

    // Guard: adapter must be present
    if (!deps.toolsmithAdapter) {
      return c.json({ ok: false, code: 'ADAPTER_UNAVAILABLE', message: 'Toolsmith adapter not wired' }, 503);
    }

    // Parse + validate body
    let body: { toolName?: unknown; version?: unknown; source?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, code: 'INVALID_PAYLOAD', message: 'toolName and version required' }, 400);
    }

    if (!body || typeof body.toolName !== 'string' || typeof body.version !== 'string') {
      return c.json({ ok: false, code: 'INVALID_PAYLOAD', message: 'toolName and version required' }, 400);
    }

    const { toolName, version } = body;
    const source = typeof body.source === 'string' ? body.source : null;

    // Call adapter
    const result = await deps.toolsmithAdapter.draftSkillFromTool(toolName, version);

    // Emit audit envelope — fire-and-forget
    if (deps.envelopeStore) {
      try {
        // QF-MT WP5: this internal Toolsmith→quoxflow webhook has no caller
        // org (service-to-service ingest, no JWT/X-Org-Id contract defined
        // yet) — SYSTEM_SCOPE preserves current behavior (hidden from tenant
        // reads, not leaked).
        await deps.envelopeStore.append(
          envelopes.event(Intents.TOOLSMITH.TOOL_PUBLISHED_RECEIVED, correlationId, {
            toolName,
            version,
            source,
            draft_result: result,
            received_at: new Date().toISOString(),
          })
        );
      } catch { /* fire-and-forget */ }
    }

    // Respond
    if (result.ok) {
      return c.json({ ok: true, draftSkillId: result.draftSkillId, source }, 200);
    }

    return c.json({ ok: false, code: result.reason, detail: (result as { detail?: string }).detail ?? null }, 202);
  });

  return app;
}
