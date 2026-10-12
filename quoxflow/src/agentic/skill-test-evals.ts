/**
 * QSKL-5.D — Skill Test Evals Persistence
 *
 * Builds a TestsEvalSummary from a runSkillTests result and merges it
 * into the skill's evals JSONB under the sub-key `evals.tests`.
 * Other evals sub-keys (e.g. QSKL-7's success_rate_30d) are preserved.
 */

import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { SkillTestRunResult, SkillTestResult } from './skill-test-runner.js';

export interface TestsEvalSummary {
  /** ISO timestamp of when the test run completed */
  last_run_at: string;
  total: number;
  passed: number;
  failed: number;
  /** true iff failed > 0 */
  drifter: boolean;
  /** Per-test detail rows from runSkillTests */
  results: SkillTestResult[];
}

export async function persistTestEvals(
  store: QuoxSkillsStore,
  skillId: string,
  runResult: SkillTestRunResult,
): Promise<TestsEvalSummary> {
  const summary: TestsEvalSummary = {
    last_run_at: new Date().toISOString(),
    total: runResult.totalTests,
    passed: runResult.passed,
    failed: runResult.failed,
    drifter: runResult.failed > 0,
    results: runResult.results,
  };

  const existing = await store.findByIdUnchecked(skillId);
  if (!existing) {
    throw new Error(`Skill ${skillId} not found`);
  }

  // Merge: preserve all other evals keys, only write tests sub-key
  const evals = { ...existing.evals, tests: summary };

  await store.update(skillId, { evals });

  return summary;
}
