/**
 * QSKL-SAFETY.E — Skill Safety Judge Job
 *
 * Weekly sweep that calls claude-haiku-4-5-20251001 to score each
 * `experimental` edition skill on the 5-axis safety rubric (plan §4.2).
 *
 * When ANY axis score < 5 OR overall_score < 7, inserts a row into
 * skill_review_queue with status='pending' and findings JSONB populated.
 *
 * When all axes pass: NO queue row inserted; emits a skill.safety_judge_passed
 * evidence envelope for telemetry.
 *
 * Default-ON. Set QSKL_SAFETY_JUDGE_DISABLED=true to short-circuit.
 * (NOT QSKL_SAFETY_JUDGE_ENABLED — follow the QSKL_JUDGE_DISABLED pattern.)
 *
 * Cost plumbing: tokens_in / tokens_out / cost_usd populated from a real
 * usage object on the mock LLM response. NO hardcoded zeros.
 *
 * Idempotency: ON CONFLICT DO NOTHING in the store means re-running within
 * the window produces no duplicate rows.
 */

import { ulid } from 'ulid';
import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { SkillReviewQueueStore } from '../store/skill-review-queue-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { SkillJudgeLlmClient } from './skill-judge-llm-client.js';
import type { EnvelopeStore } from '../store/envelope-store.js';
import { EnvelopeFactory } from '../core/envelope.js';
import { emitQsklSafetyAocl } from '../security/qskl-safety-aocl.js';

const _aoclFactory = new EnvelopeFactory('agent.skill-safety-judge');
import {
  SAFETY_JUDGE_MODEL,
  SAFETY_JUDGE_MAX_TOKENS,
  SAFETY_JUDGE_SYSTEM_PROMPT,
  SAFETY_RUBRIC_VERSION,
  buildSafetyJudgePrompt,
  parseSafetyJudgeResponse,
  extractFailingFindings,
  isSafetyPass,
} from './skill-safety-judge-prompts.js';
import { estimateCostUsd } from './model-pricing.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SkillSafetyJudgeJobDeps {
  store: QuoxSkillsStore;
  llmClient: SkillJudgeLlmClient;
  reviewQueueStore: SkillReviewQueueStore;
  evidenceStore?: EvidenceStore;
  /** QSKL-SAFETY Gap 6: Envelope store for AOCL layer-5 gate emissions. Fire-and-forget. */
  envelopeStore?: EnvelopeStore;
  env?: NodeJS.ProcessEnv;
}

export interface SkillSafetyJudgeJobResult {
  ran: boolean;
  checked: number;
  queued: number;
  passed: number;
  errors: number;
  total_tokens: number;
  total_cost_usd: number;
  reason?: 'disabled';
}

export interface SkillSafetyJudgeJob {
  run(): Promise<SkillSafetyJudgeJobResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSkillSafetyJudgeJob(deps: SkillSafetyJudgeJobDeps): SkillSafetyJudgeJob {
  const {
    store,
    llmClient,
    reviewQueueStore,
    evidenceStore,
    envelopeStore,
    env = process.env,
  } = deps;

  return {
    async run(): Promise<SkillSafetyJudgeJobResult> {
      // Default-ON: short-circuit only when QSKL_SAFETY_JUDGE_DISABLED is exactly 'true'.
      if (env.QSKL_SAFETY_JUDGE_DISABLED === 'true') {
        return {
          ran: false,
          reason: 'disabled',
          checked: 0,
          queued: 0,
          passed: 0,
          errors: 0,
          total_tokens: 0,
          total_cost_usd: 0,
        };
      }

      // ── Fetch all experimental skills for safety judge ────────────────────
      // Only experimental skills need judging — stable skills already passed.
      const allSkills = await store.list({ orgId: '' });
      const experimentalSkills = allSkills.filter(s => s.edition === 'experimental');

      let checked = 0;
      let queued = 0;
      let passed = 0;
      let errors = 0;
      let totalTokens = 0;
      let totalCostUsd = 0;

      for (const skill of experimentalSkills) {
        checked++;
        try {
          // ── Build prompts ─────────────────────────────────────────────────
          const userText = buildSafetyJudgePrompt(skill);

          // ── Call LLM ─────────────────────────────────────────────────────
          const resp = await llmClient.complete({
            model: SAFETY_JUDGE_MODEL,
            system: SAFETY_JUDGE_SYSTEM_PROMPT,
            user: userText,
            max_tokens: SAFETY_JUDGE_MAX_TOKENS,
          });

          // ── Compute cost — real usage, NO zeros ────────────────────────────
          const costUsd = estimateCostUsd(
            resp.usage.model || SAFETY_JUDGE_MODEL,
            resp.usage.input_tokens,
            resp.usage.output_tokens
          );
          const callTokens = resp.usage.input_tokens + resp.usage.output_tokens;
          totalTokens += callTokens;
          totalCostUsd += costUsd;

          // ── Parse & validate response ──────────────────────────────────────
          // parseSafetyJudgeResponse throws on invalid JSON or schema violation.
          // Any parse failure = auto-fail: insert queue row with empty findings.
          let judgeResponse;
          let parseError: string | null = null;
          try {
            judgeResponse = parseSafetyJudgeResponse(resp.text);
          } catch (parseErr) {
            parseError = (parseErr as Error).message;
          }

          const judgeRunId = ulid();

          if (parseError || !judgeResponse) {
            // Parse failure = auto-fail: queue for human review
            const inserted = await reviewQueueStore.insert({
              skill_id: skill.id,
              version: skill.version,
              org_id: skill.orgId,
              judge_run_id: judgeRunId,
              findings: [{ axis: 'parse_error', score: 0, notes: parseError ?? 'Unknown parse error' }],
              rubric_scores: null,
              rubric_version: SAFETY_RUBRIC_VERSION,
              cost_usd: costUsd,
              tokens_in: resp.usage.input_tokens,
              tokens_out: resp.usage.output_tokens,
            });

            if (inserted !== null) {
              queued++;
            }

            // Emit evidence
            if (evidenceStore) {
              const meta: Record<string, unknown> = {
                skill_id: skill.id,
                org_id: skill.orgId,
                judge_run_id: judgeRunId,
                parse_error: parseError,
                cost_usd: costUsd,
                tokens_in: resp.usage.input_tokens,
                tokens_out: resp.usage.output_tokens,
              };
              try {
                await evidenceStore.store({
          orgId: skill.orgId,
                  correlationId: skill.id,
                  envelopeId: ulid(),
                  type: 'skill.safety_judge_ran',
                  contentType: 'application/json',
                  content: JSON.stringify(meta),
                  metadata: meta,
                });
              } catch (evErr) {
                console.warn('[SkillSafetyJudgeJob] evidenceStore.store(skill.safety_judge_ran) failed:', evErr);
              }
            }

            // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for parse-error queue insert
            await emitQsklSafetyAocl({
              envelopeStore,
              factory: _aoclFactory,
              correlationId: skill.id,
              gate: 'skill_safety_judge',
              outcome: 'reject',
              skillId: skill.id,
              skillName: skill.name,
              orgId: skill.orgId,
              extra: { judge_run_id: judgeRunId, reason: 'parse_error' },
            });
            continue;
          }

          const isPass = isSafetyPass(judgeResponse);

          if (isPass) {
            passed++;
            // Emit telemetry envelope for passed skills
            if (evidenceStore) {
              const meta: Record<string, unknown> = {
                skill_id: skill.id,
                org_id: skill.orgId,
                judge_run_id: judgeRunId,
                overall_score: judgeResponse.overall_score,
                verdict: judgeResponse.verdict,
                axis_scores: judgeResponse.axis_scores,
                cost_usd: costUsd,
                tokens_in: resp.usage.input_tokens,
                tokens_out: resp.usage.output_tokens,
                rubric_version: SAFETY_RUBRIC_VERSION,
              };
              try {
                await evidenceStore.store({
          orgId: skill.orgId,
                  correlationId: skill.id,
                  envelopeId: ulid(),
                  type: 'skill.safety_judge_passed',
                  contentType: 'application/json',
                  content: JSON.stringify(meta),
                  metadata: meta,
                });
              } catch (evErr) {
                console.warn('[SkillSafetyJudgeJob] evidenceStore.store(skill.safety_judge_passed) failed:', evErr);
              }
            }
            // QSKL-SAFETY Gap 6: emit AOCL layer-5 complete for judge pass
            await emitQsklSafetyAocl({
              envelopeStore,
              factory: _aoclFactory,
              correlationId: skill.id,
              gate: 'skill_safety_judge',
              outcome: 'complete',
              skillId: skill.id,
              skillName: skill.name,
              orgId: skill.orgId,
              extra: { judge_run_id: judgeRunId, overall_score: judgeResponse.overall_score, verdict: judgeResponse.verdict },
            });
          } else {
            // Extract failing dimensions and insert queue row
            const findings = extractFailingFindings(judgeResponse);

            const inserted = await reviewQueueStore.insert({
              skill_id: skill.id,
              version: skill.version,
              org_id: skill.orgId,
              judge_run_id: judgeRunId,
              findings,
              rubric_scores: judgeResponse.axis_scores as Record<string, unknown>,
              rubric_version: SAFETY_RUBRIC_VERSION,
              cost_usd: costUsd,
              tokens_in: resp.usage.input_tokens,
              tokens_out: resp.usage.output_tokens,
            });

            if (inserted !== null) {
              queued++;
            }
            // Else: already queued (idempotency), no increment

            // Emit evidence for ran/queued
            if (evidenceStore) {
              const meta: Record<string, unknown> = {
                skill_id: skill.id,
                org_id: skill.orgId,
                judge_run_id: judgeRunId,
                overall_score: judgeResponse.overall_score,
                verdict: judgeResponse.verdict,
                axis_scores: judgeResponse.axis_scores,
                failing_dimensions: findings.map(f => f.axis),
                queued: inserted !== null,
                cost_usd: costUsd,
                tokens_in: resp.usage.input_tokens,
                tokens_out: resp.usage.output_tokens,
                rubric_version: SAFETY_RUBRIC_VERSION,
              };
              try {
                await evidenceStore.store({
          orgId: skill.orgId,
                  correlationId: skill.id,
                  envelopeId: ulid(),
                  type: 'skill.safety_judge_ran',
                  contentType: 'application/json',
                  content: JSON.stringify(meta),
                  metadata: meta,
                });
              } catch (evErr) {
                console.warn('[SkillSafetyJudgeJob] evidenceStore.store(skill.safety_judge_ran) failed:', evErr);
              }
            }
            // QSKL-SAFETY Gap 6: emit AOCL layer-5 reject for judge fail (queue insert path)
            await emitQsklSafetyAocl({
              envelopeStore,
              factory: _aoclFactory,
              correlationId: skill.id,
              gate: 'skill_safety_judge',
              outcome: 'reject',
              skillId: skill.id,
              skillName: skill.name,
              orgId: skill.orgId,
              extra: { judge_run_id: judgeRunId, overall_score: judgeResponse.overall_score, verdict: judgeResponse.verdict, queued: inserted !== null },
            });
          }
        } catch (err: unknown) {
          errors++;
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[SkillSafetyJudgeJob] Error processing skill ${skill.id}:`, reason);

          if (evidenceStore) {
            const errorMeta: Record<string, unknown> = {
              skill_id: skill.id,
              reason,
              agent_id: 'system:skill-safety-judge',
            };
            try {
              await evidenceStore.store({
          orgId: skill.orgId,
                correlationId: skill.id,
                envelopeId: ulid(),
                type: 'skill.safety_judge_ran',
                contentType: 'application/json',
                content: JSON.stringify(errorMeta),
                metadata: errorMeta,
              });
            } catch (evErr) {
              console.warn('[SkillSafetyJudgeJob] evidenceStore.store(error) failed:', evErr);
            }
          }
        }
      }

      return {
        ran: true,
        checked,
        queued,
        passed,
        errors,
        total_tokens: totalTokens,
        total_cost_usd: totalCostUsd,
      };
    },
  };
}
