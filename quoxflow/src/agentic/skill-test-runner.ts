/**
 * QSKL-5.A — Skill Test Runner
 *
 * Pure-function runner for the author-written test pairs declared on a skill.
 * Used to gate:
 *   - The QSKL-4 patch flow (runs BEFORE the Crystal evaluator)
 *   - Promotion of a skill to edition='stable'
 *   - The daily skill-tests cron (drifter detection)
 *
 * Deterministic by construction — the caller supplies an executeSkill ctx so
 * we never need a live LLM in tests.
 */

import type { QuoxSkillRecord } from '../store/quox-skills-store.js';

// ─── Test-pair shape (matches the migration 007 JSONB comment) ────────────────

export interface SkillTestExpects {
  /** Output must contain every one of these substrings. */
  contains?: string[];
  /** Output must contain none of these substrings. */
  not_contains?: string[];
  /** Emitted-action tokens must include every one of these substrings. */
  skill_should_emit?: string[];
}

export interface SkillTestPair {
  input: Record<string, unknown>;
  expects: SkillTestExpects;
}

export interface SkillTestResult {
  name: string;
  passed: boolean;
  failure_reason?: string;
  ranAt: string;
}

export interface SkillTestRunResult {
  allPassed: boolean;
  totalTests: number;
  passed: number;
  failed: number;
  results: SkillTestResult[];
}

export interface SkillTestExecuteContext {
  executeSkill: (
    skill: QuoxSkillRecord,
    input: Record<string, unknown>
  ) => Promise<{ output: string; emitted: string[] }>;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runSkillTests(
  skill: QuoxSkillRecord,
  ctx: SkillTestExecuteContext
): Promise<SkillTestRunResult> {
  const tests = normaliseTests(skill.tests);

  if (tests.length === 0) {
    return { allPassed: true, totalTests: 0, passed: 0, failed: 0, results: [] };
  }

  const results: SkillTestResult[] = [];
  for (const { name, pair } of tests) {
    results.push(await runOne(skill, name, pair, ctx));
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  return {
    allPassed: failed === 0,
    totalTests: results.length,
    passed,
    failed,
    results,
  };
}

async function runOne(
  skill: QuoxSkillRecord,
  name: string,
  pair: SkillTestPair,
  ctx: SkillTestExecuteContext
): Promise<SkillTestResult> {
  const ranAt = new Date().toISOString();
  let output: string;
  let emitted: string[];

  try {
    const exec = await ctx.executeSkill(skill, pair.input ?? {});
    output = exec.output ?? '';
    emitted = exec.emitted ?? [];
  } catch (err) {
    return {
      name,
      passed: false,
      failure_reason: `executor blew up: ${err instanceof Error ? err.message : String(err)}`,
      ranAt,
    };
  }

  const reason = checkExpects(pair.expects ?? {}, output, emitted);
  if (reason) {
    return { name, passed: false, failure_reason: reason, ranAt };
  }
  return { name, passed: true, ranAt };
}

function checkExpects(
  expects: SkillTestExpects,
  output: string,
  emitted: string[]
): string | null {
  if (expects.contains) {
    for (const needle of expects.contains) {
      if (!output.includes(needle)) {
        return `contains: output missing required substring "${needle}"`;
      }
    }
  }
  if (expects.not_contains) {
    for (const forbidden of expects.not_contains) {
      if (output.includes(forbidden)) {
        return `not_contains: output included forbidden substring "${forbidden}"`;
      }
    }
  }
  if (expects.skill_should_emit) {
    for (const token of expects.skill_should_emit) {
      const found = emitted.some(e => e.includes(token));
      if (!found) {
        return `skill_should_emit: no emitted action contained required token "${token}"`;
      }
    }
  }
  return null;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Accept either:
 *   - the canonical record shape `{ [name]: { input, expects } }` (per migration 007)
 *   - the array shape `[{ name, input, expects }]` (per the plan-doc YAML example)
 *
 * Anything else (null/undefined/empty) returns []. Malformed entries are
 * silently skipped — the goal is for a broken `tests` JSONB to fail open
 * rather than crash the patch flow.
 */
function normaliseTests(
  raw: unknown
): Array<{ name: string; pair: SkillTestPair }> {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    const out: Array<{ name: string; pair: SkillTestPair }> = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { name?: unknown; input?: unknown; expects?: unknown };
      if (typeof e.name !== 'string' || !e.name) continue;
      out.push({
        name: e.name,
        pair: {
          input: (e.input as Record<string, unknown>) ?? {},
          expects: (e.expects as SkillTestExpects) ?? {},
        },
      });
    }
    return out;
  }

  if (typeof raw === 'object') {
    const out: Array<{ name: string; pair: SkillTestPair }> = [];
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as { input?: unknown; expects?: unknown };
      out.push({
        name,
        pair: {
          input: (v.input as Record<string, unknown>) ?? {},
          expects: (v.expects as SkillTestExpects) ?? {},
        },
      });
    }
    return out;
  }

  return [];
}
