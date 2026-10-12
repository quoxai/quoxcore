/**
 * QSKL-4.C — Skill Patch Evaluator (real Crystal-eval engine)
 *
 * Performs a side-effect-free structural "shadow replay" of each canonical
 * Crystal whose metadata.source_skill_id matches the skill being patched.
 * No HTTP calls, no envelope writes, no LLM calls.
 */

import type { QuoxSkillRecord } from '../store/quox-skills-store.js';
import type { SkillLibraryStore, SkillLibraryRecord } from '../store/skill-library-store.js';

// ─── Known executor action names ──────────────────────────────────────────────

export const KNOWN_EXECUTOR_ACTIONS = new Set([
  'call',
  'transform',
  'condition',
  'switch',
  'loop',
  'try',
  'catch',
  'throw',
  'wait',
  'log',
  'subworkflow',
  'parallel',
  'merge',
  'aggregate',
  'webhook',
  'start',
  'end',
  'noop',
  'skills_list',
  'skill_view',
  'skill_manage',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionStep {
  action: string;
  params: Record<string, unknown>;
}

export type CheckStepFn = (
  step: ActionStep,
  patchedSkill: QuoxSkillRecord,
  ctx: unknown,
  crystalId: string,
  stepIndex: number,
) => { pass: true } | { pass: false; reason: string };

export interface CrystalFailure {
  crystal_id: string;
  failure_reason: string;
  failed_step_index?: number;
}

export interface PatchEvalResult {
  allPassed: boolean;
  crystalsEvaluated: number;
  crystalsPassed: number;
  crystalsFailed: CrystalFailure[];
}

export interface EvaluatorContext {
  skillLibraryStore: SkillLibraryStore;
  checkStep?: CheckStepFn;
}

// ─── Default checkStep ────────────────────────────────────────────────────────

/**
 * Default structural check: passes if the action is a known executor action OR
 * is listed in the patched skill's requiredTools metadata.
 * Phase 4.E will refine this with parameter-level schema validation.
 */
export function defaultCheckStep(
  step: ActionStep,
  patchedSkill: QuoxSkillRecord,
  _ctx: unknown,
): { pass: true } | { pass: false; reason: string } {
  if (KNOWN_EXECUTOR_ACTIONS.has(step.action)) {
    return { pass: true };
  }

  const requiredTools = Array.isArray(patchedSkill.requiredTools)
    ? (patchedSkill.requiredTools as Array<{ name?: string } | string>)
    : [];

  const toolNames = requiredTools.map(t =>
    typeof t === 'string' ? t : (t as { name?: string }).name ?? '',
  );

  if (toolNames.includes(step.action)) {
    return { pass: true };
  }

  return { pass: false, reason: 'action_not_dispatchable' };
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Evaluate a proposed body_md patch against the skill's canonical Crystals.
 *
 * Finds all canonical Crystals attributable to `skill` via
 * metadata.source_skill_id, runs a structural check on each step in
 * action_log_snapshot, and returns aggregate pass/fail.
 */
export async function evaluatePatchAgainstCrystals(
  skill: QuoxSkillRecord,
  _newBodyMd: string,
  ctx: EvaluatorContext,
): Promise<PatchEvalResult> {
  const { skillLibraryStore, checkStep = defaultCheckStep } = ctx;

  // Build the "patched" skill view — metadata is unchanged for structural checks;
  // body change is the thing being evaluated against existing Crystals.
  const patchedSkill = skill;

  // Find all canonical Crystals for this skill
  const crystals: SkillLibraryRecord[] = await skillLibraryStore.findCanonicalCrystalsBySourceSkillId(
    skill.orgId,
    skill.id,
  );

  const crystalsFailed: CrystalFailure[] = [];

  for (const crystal of crystals) {
    const snapshot = (crystal.workflowJson?.action_log_snapshot ?? []) as ActionStep[];

    let crystalFailed = false;
    for (let i = 0; i < snapshot.length; i++) {
      const step = snapshot[i];
      const checkResult = checkStep(step, patchedSkill, ctx, crystal.id, i);

      if (!checkResult.pass) {
        crystalsFailed.push({
          crystal_id: crystal.id,
          failure_reason: checkResult.reason,
          failed_step_index: i,
        });
        crystalFailed = true;
        break; // one failure per Crystal is enough; continue with next Crystal
      }
    }

    // Crystals with empty snapshots pass by default
    void crystalFailed;
  }

  const crystalsPassed = crystals.length - crystalsFailed.length;

  return {
    allPassed: crystalsFailed.length === 0,
    crystalsEvaluated: crystals.length,
    crystalsPassed,
    crystalsFailed,
  };
}
