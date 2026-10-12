/**
 * QSKL-11b — Skill Judge Prompts
 *
 * Builds the LLM prompt for the skill-quality judge and parses its response.
 * The judge scores a skill on 4 dimensions (1-5 each):
 *   clarity, completeness, recency, drift
 *
 * This module is prompt-only — no HTTP calls, no LLM wiring.
 * Slice 3 handles calling Haiku-4.5 and storing the JudgeResult.
 */

import { z } from 'zod';
import type { QuoxSkillRecord, QuoxSkillInvocationRow } from '../store/quox-skills-store.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Bumped whenever the rubric dimensions or scoring rules change. Stamped on every JudgeResult. */
export const RUBRIC_VERSION = 1;

// ─── Response Schema ──────────────────────────────────────────────────────────

const scoreSchema = z.number().int().min(1).max(5);

export const JudgeResponseSchema = z.object({
  scores: z.object({
    clarity: scoreSchema,
    completeness: scoreSchema,
    recency: scoreSchema,
    drift: scoreSchema.nullable(),
  }),
  notes: z.object({
    clarity: z.string().max(400),
    completeness: z.string().max(400),
    recency: z.string().max(400),
    drift: z.string().max(400),
  }),
});

export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

// ─── System Prompt ────────────────────────────────────────────────────────────

/**
 * QSKL-11b: System prompt for the skill judge. Instructs Haiku-4.5 to score
 * a skill on 4 dimensions (1-5 each) + return short notes per dimension.
 * Anchored on a "current date" so the recency dimension has a temporal frame.
 */
export const JUDGE_SYSTEM_PROMPT = (now: Date): string => {
  const isoDate = now.toISOString();
  return `You are a skill-quality judge. The current date is ${isoDate}.
You will evaluate a procedural Skill (SKILL.md format) on 4 dimensions, each scored 1-5:
- clarity: is the skill body unambiguous about WHEN to apply and HOW to act?
- completeness: does it cover the obvious failure cases the skill name implies?
- recency: does it reference current tool versions, endpoints, model names? (anchored on the current date above)
- drift: does the SKILL.md prose match what its recent invocations actually did? Return null when no invocations are provided.

Return ONLY valid JSON, no prose, no markdown fences. Schema:
{"scores":{"clarity":1-5,"completeness":1-5,"recency":1-5,"drift":1-5|null},
 "notes":{"clarity":"...","completeness":"...","recency":"...","drift":"..."}}
Each note must be ≤ 200 characters. If drift is null, notes.drift must explain why (e.g. "no invocations in last 30 days").`;
};

// ─── Invocation Formatting ────────────────────────────────────────────────────

function formatInvocations(invocations: QuoxSkillInvocationRow[]): string {
  if (invocations.length === 0) {
    return 'no invocations in last 30 days';
  }
  return invocations
    .map((inv) => {
      const base = `${inv.createdAt} agent=${inv.agentId} success=${inv.success} tokens=${inv.tokensUsed} latency=${inv.latencyMs}ms`;
      // QSKL-7-FIX: include action names so the judge can detect behavioral drift
      // vs SKILL.md body. Empty array (or missing on pre-fix rows) means no LLM actions recorded.
      const log = inv.actionLog ?? [];
      const actions = log.length > 0
        ? ` actions=[${log.join(',')}]`
        : '';
      return `${base}${actions}`;
    })
    .join('\n');
}

// ─── Build User Prompt ────────────────────────────────────────────────────────

/**
 * Build the user-side prompt for one skill. Includes the skill body, the
 * invocation context (or fallback line when empty), and reminders about the
 * required JSON shape.
 */
export function buildJudgePrompt(
  skill: QuoxSkillRecord,
  invocations: QuoxSkillInvocationRow[],
  now: Date,
): string {
  const systemSection = JUDGE_SYSTEM_PROMPT(now);
  const invocationSection = formatInvocations(invocations);

  return `${systemSection}

Skill name: ${skill.name}
Skill description: ${skill.description}
Skill body:
${skill.bodyMd}

Recent invocations (last 30 days, up to 30 rows):
${invocationSection}`;
}

// ─── Parse & Validate Response ────────────────────────────────────────────────

/**
 * Parse the LLM response. Strips markdown fences if present, JSON.parse,
 * then validates against JudgeResponseSchema. Throws on failure.
 */
export function parseJudgeResponse(rawText: string): JudgeResponse {
  // Strip markdown fences (```json ... ``` or ``` ... ```)
  let text = rawText.trim();
  const fencePattern = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const fenceMatch = fencePattern.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Find the first `{` and last `}` and parse that slice
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('parseJudgeResponse: no JSON object found in response');
  }
  const jsonSlice = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`parseJudgeResponse: JSON.parse failed — ${(err as Error).message}`);
  }

  // Throws on schema violation (out-of-range, missing key, non-integer, etc.)
  return JudgeResponseSchema.parse(parsed);
}
