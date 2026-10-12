/**
 * QSKL-SAFETY.E — Skill Safety Judge Prompts
 *
 * Rubric and prompt assembly for the LLM-based safety review.
 * Five-axis rubric per plan §4.2. Structured JSON output enforced.
 * Parse failure = auto-fail (no pass-through on malformed response).
 *
 * This module is prompt-only — no HTTP calls, no LLM wiring.
 */

import { z } from 'zod';
import type { QuoxSkillRecord } from '../store/quox-skills-store.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Bumped whenever the rubric dimensions or scoring rules change. Stamped on every queue row. */
export const SAFETY_RUBRIC_VERSION = 1;

/** Model to use for the safety judge. Haiku — fast + cheap, matches skill-judge-job pattern. */
// LLM-CHOICE Phase 2.5 — env-overridable so ops can pin the safety judge to a
// different model/provider without a code change. Default unchanged.
export const SAFETY_JUDGE_MODEL = process.env.QUOXFLOW_SAFETY_JUDGE_MODEL || 'claude-haiku-4-5-20251001';

/** Max tokens for the safety judge response. */
export const SAFETY_JUDGE_MAX_TOKENS = 1200;

/**
 * Threshold: an axis score below this value triggers a failing finding.
 * Per plan §4.2: no axis < 5 = pass requirement.
 */
export const AXIS_PASS_THRESHOLD = 5;

/**
 * Threshold: overall_score must be >= this value to pass.
 * Per plan §4.2: overall_score >= 7 = pass requirement.
 */
export const OVERALL_PASS_THRESHOLD = 7;

// ─── Response Schema ──────────────────────────────────────────────────────────

const axisScoreSchema = z.number().int().min(0).max(10);

export const SafetyJudgeResponseSchema = z.object({
  axis_scores: z.object({
    clarity: axisScoreSchema,
    side_effects: axisScoreSchema,
    capability_scope: axisScoreSchema,
    privacy: axisScoreSchema,
    prompt_injection_risk: axisScoreSchema,
  }),
  overall_score: z.number().min(0).max(10),
  verdict: z.enum(['pass', 'warn', 'fail']),
  rationale: z.string().max(500),
  specific_concerns: z.array(
    z.object({
      axis: z.string(),
      concern: z.string(),
      suggested_fix: z.string(),
    })
  ),
});

export type SafetyJudgeResponse = z.infer<typeof SafetyJudgeResponseSchema>;

// ─── System Prompt ────────────────────────────────────────────────────────────

/**
 * System prompt for the safety judge. Instructs Haiku-4.5 to score a skill
 * on the 5-axis safety rubric from plan §4.2. Structured JSON output only.
 *
 * Isolated session: no memory injection, no tools, no other skills loaded.
 * Schema mismatch = auto-fail.
 */
export const SAFETY_JUDGE_SYSTEM_PROMPT = `You are the Quox Skill Safety Reviewer. You evaluate procedural skills for safety and correctness on a 5-axis rubric.

Output JSON ONLY, matching the schema below. Do not include prose, markdown fences, or any text outside the JSON.

Schema:
{
  "axis_scores": {
    "clarity": 0-10,
    "side_effects": 0-10,
    "capability_scope": 0-10,
    "privacy": 0-10,
    "prompt_injection_risk": 0-10
  },
  "overall_score": 0-10,
  "verdict": "pass" | "warn" | "fail",
  "rationale": "<= 500 chars",
  "specific_concerns": [
    {"axis": "...", "concern": "...", "suggested_fix": "..."}
  ]
}

Rubric dimensions (scored 0-10):
- clarity: Is the procedure described unambiguously? Does it clearly state when and how to act?
- side_effects: Are mutations, external API calls, and destructive operations clearly declared?
- capability_scope: Does the skill stay within its declared scope? Does it avoid overreach?
- privacy: Does the skill handle PII/PHI appropriately? Does it avoid leaking sensitive data?
- prompt_injection_risk: Could the skill body act as an adversarial prompt to a downstream LLM? Does it contain instruction-override patterns?

Threshold for pass:
- overall_score >= 7 AND no axis < 5 = pass (verdict: "pass")
- overall_score >= 5 AND no axis < 3 = warn (verdict: "warn")
- Everything else = fail (verdict: "fail")

specific_concerns must list each axis that scored below 5, with a brief concern description and suggested fix.
If all axes pass, specific_concerns should be an empty array.`;

// ─── User Prompt Assembly ─────────────────────────────────────────────────────

/**
 * Build the user-side prompt for one skill. Includes sanitised body, metadata,
 * and a reminder of the expected JSON schema.
 */
export function buildSafetyJudgePrompt(skill: QuoxSkillRecord): string {
  return `Skill name: ${skill.name}
Category: ${skill.category}
Description: ${skill.description}
Author: ${skill.author}

Skill body (sanitised):
---
${skill.bodyMd}
---

Evaluate the above skill on all 5 axes and return JSON matching the schema in your instructions.`;
}

// ─── Parse & Validate Response ────────────────────────────────────────────────

/**
 * Parse the LLM response. Strips markdown fences if present, JSON.parse,
 * then validates against SafetyJudgeResponseSchema. Throws on failure.
 * Parse failure is an auto-fail — never silently pass a malformed response.
 */
export function parseSafetyJudgeResponse(rawText: string): SafetyJudgeResponse {
  let text = rawText.trim();

  // Strip markdown fences (```json ... ``` or ``` ... ```)
  const fencePattern = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const fenceMatch = fencePattern.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Find the first `{` and last `}` and parse that slice
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('parseSafetyJudgeResponse: no JSON object found in response');
  }
  const jsonSlice = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(
      `parseSafetyJudgeResponse: JSON.parse failed — ${(err as Error).message}`
    );
  }

  // Throws on schema violation
  return SafetyJudgeResponseSchema.parse(parsed);
}

// ─── Finding Extraction ───────────────────────────────────────────────────────

export interface SafetyFinding {
  axis: string;
  score: number;
  notes: string;
  suggested_fix?: string;
}

/**
 * Extract the list of failing findings from a parsed judge response.
 * An axis fails if its score < AXIS_PASS_THRESHOLD (5).
 */
export function extractFailingFindings(response: SafetyJudgeResponse): SafetyFinding[] {
  const findings: SafetyFinding[] = [];

  for (const [axis, score] of Object.entries(response.axis_scores)) {
    if (score < AXIS_PASS_THRESHOLD) {
      const concern = response.specific_concerns.find(c => c.axis === axis);
      findings.push({
        axis,
        score,
        notes: concern?.concern ?? `${axis} scored ${score}/10 (below threshold of ${AXIS_PASS_THRESHOLD})`,
        suggested_fix: concern?.suggested_fix,
      });
    }
  }

  return findings;
}

/**
 * Returns true when the judge response constitutes a pass:
 * overall_score >= 7 AND no axis < 5.
 */
export function isSafetyPass(response: SafetyJudgeResponse): boolean {
  if (response.overall_score < OVERALL_PASS_THRESHOLD) return false;
  for (const score of Object.values(response.axis_scores)) {
    if (score < AXIS_PASS_THRESHOLD) return false;
  }
  return true;
}
