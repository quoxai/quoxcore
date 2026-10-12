/**
 * QSKL-4.D — Skill Patch Evidence Emitter
 *
 * Emits a VOLT-style evidence envelope for every skill patch attempt.
 * Fields: who, when, reason, diff, crystals_evaluated, crystals_passed,
 *         crystals_failed, outcome.
 *
 * The returned envelopeId is written back to the quox_skill_patches row
 * so the audit trail links evidence ↔ patch record bidirectionally.
 */

import { ulid } from 'ulid';
import type { EvidenceStore } from '../evidence/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrystalFailureDetail {
  crystal_id: string;
  failure_reason: string;
  failed_step_index?: number;
}

export interface PatchDiff {
  from_body_md: string;
  to_body_md: string;
  step_diff?: unknown;
}

export interface SkillTestFailureDetail {
  name: string;
  passed: boolean;
  failure_reason?: string;
  ranAt: string;
}

export interface EmitPatchEvidenceOptions {
  evidenceStore: EvidenceStore;
  orgId: string;
  skillId: string;
  patchRecord: { id: string; from_version: string; to_version: string };
  diff: PatchDiff;
  crystalsEvaluated: number;
  crystalsPassed: number;
  crystalsFailed: CrystalFailureDetail[];
  outcome: 'promoted' | 'reverted' | 'pending_hitl';
  who: string;
  reason: string | null;
  /** QSKL-5.B: tests-run aggregate captured in the patch row. */
  testsRun?: number;
  /** QSKL-5.B: tests-passed aggregate captured in the patch row. */
  testsPassed?: number;
  /** QSKL-5.B: per-test failure detail when the patch was reverted by the tests gate. */
  testsFailed?: SkillTestFailureDetail[];
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function emitPatchEvidence(opts: EmitPatchEvidenceOptions): Promise<{ envelopeId: string }> {
  const {
    evidenceStore,
    orgId,
    skillId,
    patchRecord,
    diff,
    crystalsEvaluated,
    crystalsPassed,
    crystalsFailed,
    outcome,
    who,
    reason,
    testsRun,
    testsPassed,
    testsFailed,
  } = opts;

  const envelopeId = ulid();

  const contentBlob: Record<string, unknown> = {
    who,
    when: new Date().toISOString(),
    reason,
    diff,
    crystals_evaluated: crystalsEvaluated,
    crystals_passed: crystalsPassed,
    crystals_failed: crystalsFailed,
    outcome,
  };
  if (testsRun !== undefined) contentBlob.tests_run = testsRun;
  if (testsPassed !== undefined) contentBlob.tests_passed = testsPassed;
  if (testsFailed !== undefined) contentBlob.tests_failed = testsFailed;

  await evidenceStore.store({
    correlationId: patchRecord.id,
    envelopeId,
    type: 'skill_patch_evaluation',
    contentType: 'application/json',
    content: JSON.stringify(contentBlob),
    orgId,
    metadata: {
      orgId,
      skillId,
      outcome,
      fromVersion: patchRecord.from_version,
      toVersion: patchRecord.to_version,
    },
  });

  return { envelopeId };
}
