/**
 * QSKL-11b — Skill Judge Job
 *
 * Weekly sweep that calls claude-haiku-4-5-20251001 to score each stable skill
 * on 4 dimensions (clarity, completeness, recency, drift), writes a JudgeResult
 * to evals.judge, and flags skills for review when rolling avg drops below 3.0.
 *
 * Default-ON. Set QSKL_JUDGE_DISABLED=true to short-circuit.
 * Token budget: QSKL_JUDGE_TOKEN_BUDGET (default 200_000). Emits a warning
 * envelope when exceeded but continues.
 *
 * No EnvelopeBus — emission via EvidenceStore.store().
 */

import { ulid } from 'ulid';
import type { QuoxSkillsStore, JudgeResult } from '../store/quox-skills-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { SkillJudgeLlmClient } from './skill-judge-llm-client.js';
import {
  buildJudgePrompt,
  parseJudgeResponse,
  JUDGE_SYSTEM_PROMPT,
  RUBRIC_VERSION,
} from './skill-judge-prompts.js';
import { estimateCostUsd } from './model-pricing.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// LLM-CHOICE Phase 2.5 — env-overridable so ops can pin the judge to a
// different model/provider without a code change. Default unchanged.
const JUDGE_MODEL = process.env.QUOXFLOW_JUDGE_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 800;
const DEFAULT_TOKEN_BUDGET = 200_000;
/** Minimum number of rolling history entries (current + history) before review_needed can fire. */
const ROLLING_WINDOW_ENTRIES = 4;
/** Rolling avg threshold: below this → set review_needed. */
const REVIEW_THRESHOLD = 3.0;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SkillJudgeJobDeps {
  store: QuoxSkillsStore;
  llmClient: SkillJudgeLlmClient;
  evidenceStore?: EvidenceStore;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface SkillJudgeJobResult {
  ran: boolean;
  succeeded: number;
  failed: number;
  skipped: number;
  total_tokens: number;
  total_cost_usd: number;
  reason?: 'disabled' | 'no_llm_provider';
}

export interface SkillJudgeJob {
  run(opts?: { now?: Date; force?: boolean }): Promise<SkillJudgeJobResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSkillJudgeJob(deps: SkillJudgeJobDeps): SkillJudgeJob {
  const {
    store,
    llmClient,
    evidenceStore,
    env = process.env,
    now: nowFn = () => new Date(),
  } = deps;

  return {
    async run(opts = {}): Promise<SkillJudgeJobResult> {
      // Default-ON: short-circuit only when QSKL_JUDGE_DISABLED is exactly 'true'.
      if (env.QSKL_JUDGE_DISABLED === 'true') {
        return {
          ran: false,
          reason: 'disabled',
          succeeded: 0,
          failed: 0,
          skipped: 0,
          total_tokens: 0,
          total_cost_usd: 0,
        };
      }

      const effectiveNow = opts.now ?? nowFn();
      const tokenBudget =
        parseInt(env.QSKL_JUDGE_TOKEN_BUDGET ?? '', 10) || DEFAULT_TOKEN_BUDGET;
      const force = opts.force === true;

      // ── Determine skills to judge ─────────────────────────────────────────
      // force=true: pass -1 so cutoff is in the future → all stable skills qualify
      const skills = force
        ? await store.listSkillsForJudging(effectiveNow, -1)
        : await store.listSkillsForJudging(effectiveNow, 7);

      // fleet #372 — cheap pre-flight instead of running every skill through
      // complete() only to have each one throw "invoke response missing
      // usage field" and log a skill_judge_error. Any fresh org with no LLM
      // provider configured hit this on the first Monday cron: 29/29
      // crystals, 0 real judge failures, 29 identical error entries.
      if (skills.length > 0 && !(await llmClient.isReady())) {
        return {
          ran: false,
          reason: 'no_llm_provider',
          succeeded: 0,
          failed: 0,
          skipped: skills.length,
          total_tokens: 0,
          total_cost_usd: 0,
        };
      }

      let succeeded = 0;
      let failed = 0;
      let totalTokens = 0;
      let totalCostUsd = 0;
      let budgetWarningEmitted = false;

      for (const skill of skills) {
        try {
          // ── Fetch recent invocations (last 30 days, up to 30 rows) ────────
          const invocations = await store.getRecentInvocations(skill.id, 30, 30);

          // ── Build prompts ─────────────────────────────────────────────────
          const userText = buildJudgePrompt(skill, invocations, effectiveNow);
          const systemText = JUDGE_SYSTEM_PROMPT(effectiveNow);

          // ── Call LLM ─────────────────────────────────────────────────────
          const resp = await llmClient.complete({
            model: JUDGE_MODEL,
            system: systemText,
            user: userText,
            max_tokens: MAX_TOKENS,
          });

          // ── Parse & validate response ──────────────────────────────────────
          // parseJudgeResponse throws on invalid JSON or schema violation
          const parsed = parseJudgeResponse(resp.text);

          // ── Compute avg_score ─────────────────────────────────────────────
          // drift may be null (no invocations); average over non-null scores only
          const nonNullScores: number[] = [
            parsed.scores.clarity,
            parsed.scores.completeness,
            parsed.scores.recency,
          ];
          if (parsed.scores.drift !== null) {
            nonNullScores.push(parsed.scores.drift);
          }
          const avgScore =
            nonNullScores.reduce((sum, s) => sum + s, 0) / nonNullScores.length;

          // ── Compute cost ──────────────────────────────────────────────────
          const costUsd = estimateCostUsd(
            JUDGE_MODEL,
            resp.usage.input_tokens,
            resp.usage.output_tokens
          );

          // ── Build JudgeResult payload ─────────────────────────────────────
          const judgeResult: JudgeResult = {
            scored_at: effectiveNow.toISOString(),
            scores: parsed.scores,
            avg_score: avgScore,
            judge_notes: parsed.notes,
            cost_usd: costUsd,
            tokens_in: resp.usage.input_tokens,
            tokens_out: resp.usage.output_tokens,
            rubric_version: RUBRIC_VERSION,
          };

          // ── Persist ───────────────────────────────────────────────────────
          await store.setJudgeResult(skill.id, judgeResult);

          // ── Emit envelope ─────────────────────────────────────────────────
          if (evidenceStore) {
            const meta: Record<string, unknown> = {
              skill_id: skill.id,
              agent_id: 'system:skill-judge',
              scored_at: judgeResult.scored_at,
              avg_score: avgScore,
              scores: parsed.scores,
              cost_usd: costUsd,
              tokens_in: resp.usage.input_tokens,
              tokens_out: resp.usage.output_tokens,
              rubric_version: RUBRIC_VERSION,
            };
            try {
              await evidenceStore.store({
              orgId: skill.orgId,
                correlationId: skill.id,
                envelopeId: ulid(),
                type: 'skill_judged',
                contentType: 'application/json',
                content: JSON.stringify(meta),
                metadata: meta,
              });
            } catch (evidenceErr: unknown) {
              console.warn('[SkillJudgeJob] evidenceStore.store(skill_judged) failed (best-effort):', evidenceErr);
            }
          }

          // ── Update token totals ───────────────────────────────────────────
          const callTokens = resp.usage.input_tokens + resp.usage.output_tokens;
          totalTokens += callTokens;
          totalCostUsd += costUsd;

          // ── Budget warning ────────────────────────────────────────────────
          if (totalTokens > tokenBudget && !budgetWarningEmitted && evidenceStore) {
            budgetWarningEmitted = true;
            const warningMeta: Record<string, unknown> = {
              total_tokens_used: totalTokens,
              budget: tokenBudget,
              agent_id: 'system:skill-judge',
            };
            try {
              await evidenceStore.store({
              orgId: skill.orgId,
                correlationId: 'system:skill-judge',
                envelopeId: ulid(),
                type: 'skill_judge_budget_warning',
                contentType: 'application/json',
                content: JSON.stringify(warningMeta),
                metadata: warningMeta,
              });
            } catch (warningErr: unknown) {
              console.warn('[SkillJudgeJob] evidenceStore.store(skill_judge_budget_warning) failed:', warningErr);
            }
          }

          // ── Recompute rolling avg & update review_needed ──────────────────
          // Re-fetch to get the state after setJudgeResult (history was updated)
          const refetched = await store.findByIdUnchecked(skill.id);
          if (refetched) {
            const refetchedEvals = (refetched.evals as Record<string, unknown>) ?? {};
            const currentJudge = refetchedEvals.judge as Record<string, unknown> | undefined;
            const judgeHistory = (refetchedEvals.judge_history as Array<Record<string, unknown>>) ?? [];

            // Rolling window: current judge + history entries (newest-first).
            // Take the most recent ROLLING_WINDOW_ENTRIES total.
            const allEntries: Array<{ avg_score: number }> = [];
            if (currentJudge && typeof currentJudge.avg_score === 'number') {
              allEntries.push({ avg_score: currentJudge.avg_score });
            }
            for (const h of judgeHistory) {
              if (typeof h.avg_score === 'number') {
                allEntries.push({ avg_score: h.avg_score });
              }
            }
            const window = allEntries.slice(0, ROLLING_WINDOW_ENTRIES);

            if (window.length >= ROLLING_WINDOW_ENTRIES) {
              const rollingAvg =
                window.reduce((sum, e) => sum + e.avg_score, 0) / window.length;

              if (rollingAvg < REVIEW_THRESHOLD) {
                await store.setReviewNeeded(skill.id, true);
              } else if (refetched.reviewNeeded) {
                // Recovery: rolling avg is good, clear the flag
                await store.setReviewNeeded(skill.id, false);
              }
            }
          }

          succeeded++;
        } catch (err: unknown) {
          failed++;
          const reason = err instanceof Error ? err.message : String(err);

          if (evidenceStore) {
            const errorMeta: Record<string, unknown> = {
              skill_id: skill.id,
              reason,
              agent_id: 'system:skill-judge',
            };
            try {
              await evidenceStore.store({
              orgId: skill.orgId,
                correlationId: skill.id,
                envelopeId: ulid(),
                type: 'skill_judge_error',
                contentType: 'application/json',
                content: JSON.stringify(errorMeta),
                metadata: errorMeta,
              });
            } catch (evidenceErr: unknown) {
              console.warn('[SkillJudgeJob] evidenceStore.store(skill_judge_error) failed (best-effort):', evidenceErr);
            }
          }
        }
      }

      return {
        ran: true,
        succeeded,
        failed,
        skipped: 0,
        total_tokens: totalTokens,
        total_cost_usd: totalCostUsd,
      };
    },
  };
}
