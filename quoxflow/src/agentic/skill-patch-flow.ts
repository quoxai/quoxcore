/**
 * QSKL-4.A.2 / QSKL-4.C — Shared Skill Patch Flow
 *
 * applySkillPatch() is the single path for body_md patches. Both the HTTP
 * PATCH route and the agentic skillManageHandler call this function so that
 * every body_md change produces an audit row in quox_skill_patches.
 */

import { ulid } from 'ulid';
import type { QuoxSkillsStore, QuoxSkillRecord } from '../store/quox-skills-store.js';
import type { QuoxSkillPatchesStore, QuoxSkillPatchRecord } from '../store/quox-skill-patches-store.js';
import type { SkillLibraryStore } from '../store/skill-library-store.js';
import { evaluatePatchAgainstCrystals } from './skill-patch-evaluator.js';
import type { CrystalFailure } from './skill-patch-evaluator.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { ApprovalEngine } from '../approval/approval-engine.js';
import { emitPatchEvidence } from './skill-patch-evidence.js';
import { fileSkillPatchHITL, fileSkillRequiredToolHITL, fileWardRecertHITL } from './skill-patch-hitl.js';
import { diffPolicySatisfies } from './skill-patch-policy-diff.js';
import { runSkillTests } from './skill-test-runner.js';
import type { SkillTestExecuteContext, SkillTestResult } from './skill-test-runner.js';
import { checkRequiredTools } from './skill-required-tools-check.js';
import type { RequiredToolSpec } from './skill-required-tools-types.js';
import type { ToolsmithAdapter } from './toolsmith-adapter.js';
import type { ToolPresenceLookup } from './tool-presence-lookup.js';
import type { PatchRateLimiter } from './skill-patch-rate-limiter.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ApplySkillPatchOptions {
  skillsStore: QuoxSkillsStore;
  patchesStore: QuoxSkillPatchesStore;
  /** QSKL-4.C: Required for the real evaluator to look up linked Crystals. */
  skillLibraryStore?: SkillLibraryStore;
  /** Optional override for the evaluator; defaults to evaluatePatchAgainstCrystals. */
  evaluator?: typeof evaluatePatchAgainstCrystals;
  /** QSKL-4.D: Evidence store for VOLT audit trail. Optional — no evidence emitted if absent. */
  evidenceStore?: EvidenceStore;
  /** QSKL-4.D: Approval engine for HITL routing on Crystal regression. Optional — no HITL if absent. */
  approvalEngine?: ApprovalEngine;
  skillId: string;
  newBodyMd: string;
  patchedBy: string;
  reason?: string | null;
  stepDiff?: unknown;
  metadataPatch?: Record<string, unknown>;
  /** QSKL-4.D: Org context for evidence + HITL routing. Required — no silent default. */
  orgId: string;
  /** QSKL-5.B: When supplied, author-written skill tests run BEFORE Crystal-eval. */
  executeSkillContext?: SkillTestExecuteContext;
  /** QSKL-5.B: Injectable test runner — defaults to real runSkillTests. */
  testRunner?: typeof runSkillTests;
  /** QSKL-6.5: Toolsmith adapter for building missing tools at promotion time. */
  toolsmithAdapter?: ToolsmithAdapter;
  /** QSKL-6.5: Tool presence lookup. Defaults to all-missing when absent (safe-by-default). */
  toolPresenceLookup?: ToolPresenceLookup;
  /** QSKL-14a: Per-agent patch rate-limiter. When provided and patchedBy starts with 'agent:',
   *  the limiter is checked BEFORE any DB reads. User/system patches bypass the limiter. */
  patchRateLimiter?: PatchRateLimiter;
  /**
   * QSKL-HARDEN HRD-2: When true, runs the full pipeline (required-tools gate,
   * tests gate, Crystal-eval gate) exactly as normal — every one of those gates
   * is already read-only — but short-circuits BEFORE the write at each gate:
   * no HITL filed, no `quox_skill_patches` row, no evidence envelope, no WARD
   * evidence, no store update, and the rate-limiter is checked-but-not-counted
   * (already true today since the count only reflects persisted patch rows).
   * On the would-promote path, returns an `ApplySkillPatchDryRunResult`
   * (validated + would-be-effect, zero persistence) instead of the normal
   * `{ ok: true, skill, patch }` result. Default false.
   */
  dryRun?: boolean;
}

export type ApplySkillPatchResult =
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'CRYSTALS_REGRESSED'; crystalsFailed: CrystalFailure[] }
  | { ok: false; code: 'TESTS_FAILED'; testsFailed: SkillTestResult[]; testsRun: number; testsPassed: number }
  | { ok: false; code: 'STORE_ERROR'; message: string }
  | { ok: false; code: 'REQUIRED_TOOL_MISSING'; message: string; hitl_filed: boolean; missing_tools: RequiredToolSpec[] }
  | { ok: false; code: 'RATE_LIMITED'; count: number; threshold: number; retry_after: number }
  | { ok: true; skill: QuoxSkillRecord; patch: QuoxSkillPatchRecord }
  | ApplySkillPatchDryRunResult;

/**
 * QSKL-HARDEN HRD-2: dry_run success variant.
 *
 * Returned instead of `{ ok: true, skill, patch }` when `dryRun: true` and the
 * patch would have reached the promote block (required-tools gate passed,
 * author tests passed if supplied, Crystal-eval passed). No row was written
 * anywhere — this is a preview.
 */
export interface ApplySkillPatchDryRunResult {
  ok: true;
  dryRun: true;
  skillId: string;
  fromVersion: string;
  diff: { from_body_md: string; to_body_md: string; step_diff?: unknown };
  testsOutcome: { totalTests: number; passed: number; allPassed: boolean } | null;
  crystalEvalOutcome: {
    crystalsEvaluated: number;
    crystalsPassed: number;
    crystalsFailed: CrystalFailure[];
    allPassed: boolean;
  };
  wouldPromote: true;
}

// ─── Core function ─────────────────────────────────────────────────────────────

export async function applySkillPatch(opts: ApplySkillPatchOptions): Promise<ApplySkillPatchResult> {
  const {
    skillsStore,
    patchesStore,
    skillLibraryStore,
    evaluator = evaluatePatchAgainstCrystals,
    evidenceStore,
    approvalEngine,
    skillId,
    newBodyMd,
    patchedBy,
    reason = null,
    stepDiff,
    metadataPatch,
    orgId,
    executeSkillContext,
    testRunner = runSkillTests,
    toolsmithAdapter,
    toolPresenceLookup,
    patchRateLimiter,
    dryRun = false,
  } = opts;

  // QSKL-14a: Rate-limit gate — only for agent patches, before any DB reads.
  // patchedBy must start with 'agent:' to be subject to the limiter.
  // User/system patches bypass entirely. When patchRateLimiter is not wired
  // (undefined), the gate is skipped (graceful degrade for tests/legacy paths).
  if (patchRateLimiter && patchedBy.startsWith('agent:')) {
    const agentId = patchedBy.slice('agent:'.length);
    const limitResult = await patchRateLimiter.check(agentId, undefined, orgId);
    if (!limitResult.allowed) {
      // Emit a rate-limited evidence envelope before returning.
      // QSKL-HARDEN HRD-2: skip in dry-run mode — previews write nothing.
      if (evidenceStore && !dryRun) {
        const envelopeId = ulid();
        await evidenceStore.store({
        orgId,
          correlationId: skillId,
          envelopeId,
          type: 'skill_patch_rate_limited',
          contentType: 'application/json',
          content: JSON.stringify({
            skill_id: skillId,
            agent_id: agentId,
            count: limitResult.count,
            threshold: limitResult.threshold,
            retry_after: limitResult.retry_after,
            patched_by: patchedBy,
          }),
          metadata: {
            orgId,
            skillId,
            agentId,
            count: limitResult.count,
            threshold: limitResult.threshold,
          },
        });
      }
      return {
        ok: false,
        code: 'RATE_LIMITED',
        count: limitResult.count,
        threshold: limitResult.threshold,
        retry_after: limitResult.retry_after,
      };
    }
  }

  // a) Read the existing skill (org-scoped when orgId is a real non-fallback value;
  //    falls back to unchecked for agentic paths that run without a request context,
  //    identified by the 'org-default' sentinel from resolveOrgId).
  const isRealOrg = orgId && orgId !== 'default' && orgId !== 'org-default';
  const existing = isRealOrg
    ? await skillsStore.findById(skillId, orgId)
    : await skillsStore.findByIdUnchecked(skillId);
  if (!existing) {
    return { ok: false, code: 'NOT_FOUND' };
  }

  // a.1) QSKL-6.5: Required-tools pre-flight gate — cheapest gate, runs first
  //      Mirrors the block in skillViewHandler (skills-actions.ts, Slice 4b).
  //      Uses post-patch edition from metadataPatch if supplied, otherwise falls
  //      back to the existing skill's edition (judgement call: treat patch as
  //      not changing edition unless explicitly included in metadataPatch).
  const postPatchEdition = (
    typeof (metadataPatch as Record<string, unknown> | undefined)?.edition === 'string'
      ? (metadataPatch as Record<string, unknown>).edition
      : existing.edition
  ) as string;

  const postPatchRequiredTools = Array.isArray(
    (metadataPatch as Record<string, unknown> | undefined)?.requiredTools
  )
    ? ((metadataPatch as Record<string, unknown>).requiredTools as RequiredToolSpec[])
    : Array.isArray(existing.requiredTools) && existing.requiredTools.length > 0
      ? (existing.requiredTools as RequiredToolSpec[])
      : null;

  if (postPatchRequiredTools !== null) {
    const lookup: ToolPresenceLookup = toolPresenceLookup ?? { isPresent: () => false };
    const edition = (postPatchEdition === 'stable' ? 'stable' : 'experimental') as 'stable' | 'experimental';

    const check = await checkRequiredTools({
      requiredTools: postPatchRequiredTools,
      edition,
      resolve: (spec) => lookup.isPresent(spec),
    });

    if (check.action !== 'PROCEED') {
      // QSKL-HARDEN HRD-2: dry-run never invokes Toolsmith (that's a real
      // build/write) and never files HITL. Report the gate outcome as-is.
      if (dryRun) {
        return {
          ok: false,
          code: 'REQUIRED_TOOL_MISSING',
          message: `Skill patch rejected: ${check.missing.map(m => m.name).join(', ')}`,
          hitl_filed: false,
          missing_tools: check.missing,
        };
      }

      let hitlReason: 'NOT_SHIPPED' | 'POLICY_VIOLATION' | 'BUILD_FAILED' | 'BLOCKED_STABLE';
      let hitlDetail: string | undefined;
      let toolBuilt = false;

      if (check.action === 'TRY_TOOLSMITH' && toolsmithAdapter) {
        const firstMissing = check.missing[0];
        const build = await toolsmithAdapter.buildToolFromSkill(skillId, {
          name: firstMissing.name,
          version: firstMissing.version_constraint,
          policy: firstMissing.must_satisfy_policy,
        });
        if (build.ok) {
          toolBuilt = true;
        } else {
          hitlReason = build.reason;
          hitlDetail = build.detail;
        }
      } else if (check.action === 'TRY_TOOLSMITH') {
        // No adapter — treat as not shipped
        hitlReason = 'NOT_SHIPPED';
      } else {
        // BLOCK_HITL — stable edition, adapter not attempted
        hitlReason = 'BLOCKED_STABLE';
      }

      if (!toolBuilt) {
        await fileSkillRequiredToolHITL({
          approvalEngine,
          orgId,
          skillId,
          skillName: existing.name,
          skillVersion: existing.version,
          missingTools: check.missing,
          reason: hitlReason!,
          detail: hitlDetail,
        });

        return {
          ok: false,
          code: 'REQUIRED_TOOL_MISSING',
          message: `Skill patch rejected: ${check.missing.map(m => m.name).join(', ')}`,
          hitl_filed: true,
          missing_tools: check.missing,
        };
      }
      // toolBuilt === true → fall through to existing gates
    }
  }

  // b) QSKL-5.B: Run author-written tests gate BEFORE Crystal evaluator (opt-in)
  let testResult: Awaited<ReturnType<typeof runSkillTests>> | undefined;
  if (executeSkillContext) {
    testResult = await testRunner(existing, executeSkillContext);
    if (testResult.totalTests > 0 && !testResult.allPassed) {
      const failedTests = testResult.results.filter(r => !r.passed);

      // QSKL-HARDEN HRD-2: dry-run reports the tests-gate outcome without
      // writing a reverted patch row, evidence envelope, or HITL item.
      if (dryRun) {
        return {
          ok: false,
          code: 'TESTS_FAILED',
          testsFailed: failedTests,
          testsRun: testResult.totalTests,
          testsPassed: testResult.passed,
        };
      }

      const diff = {
        from_body_md: existing.bodyMd,
        to_body_md: newBodyMd,
        step_diff: stepDiff ?? null,
      };

      const revertedPatch = await patchesStore.create({
        skillId,
        orgId,
        fromVersion: existing.version,
        toVersion: existing.version, // no version bump
        patchedBy,
        reason: reason ?? null,
        diff,
        testsRun: testResult.totalTests,
        testsPassed: testResult.passed,
        crystalsEvaluated: 0,
        crystalsPassed: 0,
        crystalsFailed: [],
        outcome: 'reverted',
        envelopeId: null,
      });

      if (evidenceStore) {
        const { envelopeId } = await emitPatchEvidence({
          evidenceStore,
          orgId,
          skillId,
          patchRecord: { id: revertedPatch.id, from_version: revertedPatch.fromVersion, to_version: revertedPatch.toVersion },
          diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
          crystalsEvaluated: 0,
          crystalsPassed: 0,
          crystalsFailed: [],
          testsRun: testResult.totalTests,
          testsPassed: testResult.passed,
          testsFailed: failedTests,
          outcome: 'reverted',
          who: patchedBy,
          reason,
        });
        await patchesStore.setEnvelopeId(revertedPatch.id, envelopeId);
      }

      await fileSkillPatchHITL({
        approvalEngine,
        orgId,
        skillId,
        skillName: existing.name,
        fromVersion: existing.version,
        toVersion: existing.version,
        patchId: revertedPatch.id,
        diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
        crystalsFailed: [],
        testsFailed: failedTests,
        trigger: 'tests_gate',
      });

      return {
        ok: false,
        code: 'TESTS_FAILED',
        testsFailed: failedTests,
        testsRun: testResult.totalTests,
        testsPassed: testResult.passed,
      };
    }
  }

  // c) Run Crystal evaluator — structural shadow replay of linked canonical Crystals
  const evalCtx = skillLibraryStore
    ? { skillLibraryStore }
    : { skillLibraryStore: { findCanonicalCrystalsBySourceSkillId: async () => [] } as unknown as SkillLibraryStore };

  const evalResult = await evaluator(existing, newBodyMd, evalCtx);

  if (!evalResult.allPassed) {
    // QSKL-HARDEN HRD-2: dry-run reports the Crystal-eval outcome without
    // writing a reverted patch row, evidence envelope, or HITL item.
    if (dryRun) {
      return {
        ok: false,
        code: 'CRYSTALS_REGRESSED',
        crystalsFailed: evalResult.crystalsFailed,
      };
    }

    // Write a reverted audit row
    const diff = {
      from_body_md: existing.bodyMd,
      to_body_md: newBodyMd,
      step_diff: stepDiff ?? null,
    };

    const revertedPatch = await patchesStore.create({
      skillId,
      orgId,
      fromVersion: existing.version,
      toVersion: existing.version, // no version bump — patch did not land
      patchedBy,
      reason: reason ?? null,
      diff,
      testsRun: testResult?.totalTests ?? 0,
      testsPassed: testResult?.passed ?? 0,
      crystalsEvaluated: evalResult.crystalsEvaluated,
      crystalsPassed: evalResult.crystalsPassed,
      crystalsFailed: evalResult.crystalsFailed,
      outcome: 'reverted',
      envelopeId: null,
    });

    // QSKL-4.D: Emit VOLT evidence for the reverted patch
    if (evidenceStore) {
      const { envelopeId } = await emitPatchEvidence({
        evidenceStore,
        orgId,
        skillId,
        patchRecord: { id: revertedPatch.id, from_version: revertedPatch.fromVersion, to_version: revertedPatch.toVersion },
        diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
        crystalsEvaluated: evalResult.crystalsEvaluated,
        crystalsPassed: evalResult.crystalsPassed,
        crystalsFailed: evalResult.crystalsFailed as Array<{ crystal_id: string; failure_reason: string; failed_step_index?: number }>,
        testsRun: testResult?.totalTests ?? 0,
        testsPassed: testResult?.passed ?? 0,
        outcome: 'reverted',
        who: patchedBy,
        reason,
      });
      await patchesStore.setEnvelopeId(revertedPatch.id, envelopeId);
    }

    // QSKL-4.D: File a HITL inbox item for human review
    await fileSkillPatchHITL({
      approvalEngine,
      orgId,
      skillId,
      skillName: existing.name,
      fromVersion: existing.version,
      toVersion: existing.version,
      patchId: revertedPatch.id,
      diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
      crystalsFailed: evalResult.crystalsFailed as Array<{ crystal_id: string; failure_reason: string; failed_step_index?: number }>,
    });

    return {
      ok: false,
      code: 'CRYSTALS_REGRESSED',
      crystalsFailed: evalResult.crystalsFailed,
    };
  }

  // QSKL-HARDEN HRD-2: dry-run stops HERE, before the promote block's write —
  // every gate above (required-tools, tests, Crystal-eval) has already run
  // and passed. Return the would-be-effect preview: zero persistence anywhere
  // (no skillsStore.update, no quox_skill_patches row, no VOLT evidence, no
  // WARD evidence/HITL). skillsStore.update() is never called in dry-run mode.
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      skillId,
      fromVersion: existing.version,
      diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
      testsOutcome: testResult
        ? { totalTests: testResult.totalTests, passed: testResult.passed, allPassed: testResult.allPassed }
        : null,
      crystalEvalOutcome: {
        crystalsEvaluated: evalResult.crystalsEvaluated,
        crystalsPassed: evalResult.crystalsPassed,
        crystalsFailed: evalResult.crystalsFailed,
        allPassed: evalResult.allPassed,
      },
      wouldPromote: true,
    };
  }

  // c) Promote: update skill via the immutable-version path
  const fromVersion = existing.version;
  let updated: QuoxSkillRecord;
  try {
    updated = await skillsStore.update(skillId, { bodyMd: newBodyMd, ...metadataPatch });
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'STORE_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const toVersion = updated.version;

  // d) Write promoted audit row to quox_skill_patches
  const diff = {
    from_body_md: existing.bodyMd,
    to_body_md: newBodyMd,
    step_diff: stepDiff ?? null,
  };

  const patchRecord = await patchesStore.create({
    skillId,
    orgId,
    fromVersion,
    toVersion,
    patchedBy,
    reason: reason ?? null,
    diff,
    testsRun: testResult?.totalTests ?? 0,
    testsPassed: testResult?.passed ?? 0,
    crystalsEvaluated: evalResult.crystalsEvaluated,
    crystalsPassed: evalResult.crystalsPassed,
    crystalsFailed: evalResult.crystalsFailed,
    outcome: 'promoted',
    envelopeId: null,
  });

  // QSKL-4.D: Emit VOLT evidence for the promoted patch
  let finalPatch = patchRecord;
  if (evidenceStore) {
    const { envelopeId } = await emitPatchEvidence({
      evidenceStore,
      orgId,
      skillId,
      patchRecord: { id: patchRecord.id, from_version: fromVersion, to_version: toVersion },
      diff: { from_body_md: existing.bodyMd, to_body_md: newBodyMd, step_diff: stepDiff },
      crystalsEvaluated: evalResult.crystalsEvaluated,
      crystalsPassed: evalResult.crystalsPassed,
      crystalsFailed: evalResult.crystalsFailed as Array<{ crystal_id: string; failure_reason: string; failed_step_index?: number }>,
      testsRun: testResult?.totalTests ?? 0,
      testsPassed: testResult?.passed ?? 0,
      outcome: 'promoted',
      who: patchedBy,
      reason,
    });
    await patchesStore.setEnvelopeId(patchRecord.id, envelopeId);
    finalPatch = { ...patchRecord, envelopeId };
  }

  // QSKL-14a Slice 3: WARD policy_satisfies hook
  // Fires when both evidenceStore and approvalEngine are present and the
  // normalised policySatisfies set changed between existing and updated.
  if (evidenceStore && approvalEngine) {
    const policyDiff = diffPolicySatisfies(
      existing.policySatisfies,
      updated.policySatisfies,
    );

    if (policyDiff.changed) {
      // Extract agent_id from patchedBy — 'agent:foo' → 'foo'; anything else → null
      const agentId = patchedBy.startsWith('agent:')
        ? patchedBy.slice('agent:'.length)
        : null;

      // Emit ward.policy_satisfies_changed evidence envelope
      const wardEnvelopeId = ulid();
      await evidenceStore.store({
        orgId,
        correlationId: skillId,
        envelopeId: wardEnvelopeId,
        type: 'ward.policy_satisfies_changed',
        contentType: 'application/json',
        content: JSON.stringify({
          skill_id: skillId,
          agent_id: agentId,
          old_claims: policyDiff.old_claims,
          new_claims: policyDiff.new_claims,
          diff_summary: policyDiff.diff_summary,
        }),
        metadata: {
          orgId,
          skillId,
          agentId,
          old_claims: policyDiff.old_claims,
          new_claims: policyDiff.new_claims,
        },
      });

      // File HITL re-cert item
      await fileWardRecertHITL({
        approvalEngine,
        orgId,
        skillId,
        skillName: existing.name,
        agentId,
        old_claims: policyDiff.old_claims,
        new_claims: policyDiff.new_claims,
        diff_summary: policyDiff.diff_summary,
      });
    }
  }

  return { ok: true, skill: updated, patch: finalPatch };
}
