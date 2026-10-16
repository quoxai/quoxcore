/**
 * QSKL-7-CHAT-FIX — Agentic Skill Actions HTTP Route
 *
 * POST /api/agentic/skill-actions/skill-view
 *
 * Wraps skillViewHandler so the collector's chat-side skill_view tool call
 * writes typed rows to quox_skill_invocations (AGENT-HONESTY telemetry).
 *
 * The bare GET /api/quox-skills/:id remains intact — it is used by the
 * dashboard UI for read-only browsing and must NOT be replaced.
 */

import type { SkillReviewQueueStore } from '../../store/skill-review-queue-store.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types.js';
import { validateBody } from '../middleware/validation.js';
import { requireOrgScope } from '../middleware/org-scope.js';
import { skillViewHandler } from '../../agentic/skills-actions.js';
import type { QuoxSkillsStore } from '../../store/quox-skills-store.js';
import type { QuoxSkillPatchesStore } from '../../store/quox-skill-patches-store.js';
import type { QuoxSkillInvocationsStore } from '../../store/quox-skill-invocations-store.js';

// ─── Body Schema ───────────────────────────────────────────────────────────────

const SkillViewBodySchema = z.object({
  skill_id_or_name: z.string().min(1, 'skill_id_or_name is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  session_id: z.string().nullable().optional(),
});

// ─── Org scope ─────────────────────────────────────────────────────────────────
// Shared requireOrgScope (middleware/org-scope.ts), like quox-skills.ts: a user token's org
// comes from its JWT, a service-key caller's from X-Org-Id, and a service caller with no
// org is refused (403). The route's old local copy treated the collector's service
// principal as a token without an org, so chat skill_view was a 401 every time.

// ─── Route Config ──────────────────────────────────────────────────────────────

export interface AgenticSkillActionsConfig {
  store: QuoxSkillsStore;
  patchesStore: QuoxSkillPatchesStore;
  invocationsStore?: QuoxSkillInvocationsStore;
  /** quox#748: skill_view refuses skills with an active (pending/rejected) human review row. */
  reviewQueueStore?: SkillReviewQueueStore;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAgenticSkillActionsRoutes(config: AgenticSkillActionsConfig) {
  const app = new Hono<AppEnv>();

  /**
   * POST /skill-view
   *
   * Dispatches into skillViewHandler so the invocation is written to
   * quox_skill_invocations. Returns the same shape skillViewHandler produces.
   *
   * Body: { skill_id_or_name: string, agent_id: string, session_id?: string | null }
   *
   * Errors:
   *   401 — missing org_id (JWT absent or empty)
   *   403 — service-key caller without X-Org-Id
   *   400 — invalid body (Zod)
   *   404 — skill not found
   *   422 — REQUIRED_TOOL_MISSING (skill has unmet tool dependencies)
   */
  app.post('/skill-view', validateBody(SkillViewBodySchema), async (c) => {
    const orgId = requireOrgScope(c);
    const body = c.get('validatedBody') as z.infer<typeof SkillViewBodySchema>;

    const result = await skillViewHandler({
      store: config.store,
      patchesStore: config.patchesStore,
      invocationsStore: config.invocationsStore,
      reviewQueueStore: config.reviewQueueStore,
      orgId,
      agentId: body.agent_id,
      sessionId: body.session_id ?? null,
      lastLlmUsage: null,      // Chat surface has no LLM usage at this layer; tokens_used=0, cost_usd=0
      params: {
        id_or_name: body.skill_id_or_name,
      },
    });

    if (!result.success) {
      if (result.code === 'REQUIRED_TOOL_MISSING') {
        return c.json(result, 422);
      }
      // quox#748: awaiting (or refused) human review: the skill exists but may not run.
      if (result.code === 'SKILL_PENDING_REVIEW' || result.code === 'SKILL_REVIEW_REJECTED') {
        return c.json(result, 423);
      }
      // Skill not found
      if (result.error && result.error.includes('not found')) {
        return c.json(result, 404);
      }
      return c.json(result, 400);
    }

    return c.json(result, 200);
  });

  return app;
}
