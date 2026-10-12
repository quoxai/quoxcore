/**
 * QSKL-4.E — Auto-Revert Window Primitive
 *
 * After a skill patch promotes, if real-world invocations fail above a
 * configurable threshold within a time window, this module:
 *   1. Detects the threshold breach (evaluateRevertDecision — pure, testable).
 *   2. Rolls the skill body back to the previous version.
 *   3. Writes a quox_skill_patches row with outcome='reverted' + patched_by='system:auto-revert'.
 *   4. Emits VOLT evidence (emitPatchEvidence).
 *   5. Files a HITL inbox item (fileSkillPatchHITL).
 *
 * QSKL-4.E primitive — invoked by:
 *  - QSKL-7 invocation handler (on each new invocation row) when shipped
 *  - A scheduled job that walks `listPromotedInWindow()` (also QSKL-7)
 * Today: callable from tests + manual triggers. Documented as the tunable knob
 * per QSKL-4 plan acceptance criteria.
 */

import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { QuoxSkillPatchesStore, QuoxSkillPatchRecord } from '../store/quox-skill-patches-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { ApprovalEngine } from '../approval/approval-engine.js';
import { emitPatchEvidence } from './skill-patch-evidence.js';
import { ulid } from 'ulid';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface RevertWindowConfig {
  /** Width of the observation window. Default 60. Env: QSKL_REVERT_WINDOW_MINUTES */
  windowMinutes: number;
  /** Fraction of failures that triggers a revert. Default 0.5. Env: QSKL_REVERT_FAILURE_THRESHOLD */
  failureThreshold: number;
  /** Minimum invocations before the rate is considered reliable. Default 5. Env: QSKL_REVERT_MIN_INVOCATIONS */
  minInvocations: number;
}

export function loadRevertWindowConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): RevertWindowConfig {
  const windowMinutes = env.QSKL_REVERT_WINDOW_MINUTES
    ? parseInt(env.QSKL_REVERT_WINDOW_MINUTES, 10)
    : 60;
  const failureThreshold = env.QSKL_REVERT_FAILURE_THRESHOLD
    ? parseFloat(env.QSKL_REVERT_FAILURE_THRESHOLD)
    : 0.5;
  const minInvocations = env.QSKL_REVERT_MIN_INVOCATIONS
    ? parseInt(env.QSKL_REVERT_MIN_INVOCATIONS, 10)
    : 5;

  return { windowMinutes, failureThreshold, minInvocations };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvocationLike {
  skill_id: string;
  skill_version: string;
  outcome: 'success' | 'failure' | string;
  created_at: string | Date;
}

export type RevertDecisionReason =
  | 'in_window_threshold_exceeded'
  | 'window_expired'
  | 'insufficient_invocations'
  | 'threshold_not_met';

export interface RevertDecisionResult {
  shouldRevert: boolean;
  reason: RevertDecisionReason;
  stats: {
    totalInvocations: number;
    failedInvocations: number;
    failureRate: number;
    windowExpiresAt: string;
  };
}

export interface CheckAndAutoRevertOptions {
  promotedPatch: QuoxSkillPatchRecord;
  skillsStore: QuoxSkillsStore;
  patchesStore: QuoxSkillPatchesStore;
  invocationsReader: (skillId: string, sinceIso: string) => Promise<InvocationLike[]>;
  evidenceStore?: EvidenceStore;
  approvalEngine?: ApprovalEngine;
  orgId: string;
  now?: Date;
  config?: RevertWindowConfig;
}

export interface CheckAndAutoRevertResult {
  reverted: boolean;
  reason: string;
  revertPatch?: QuoxSkillPatchRecord;
}

// ─── Pure decision function ───────────────────────────────────────────────────

export function evaluateRevertDecision(opts: {
  promotedPatch: { skillId: string; toVersion: string; createdAt: string | Date };
  invocations: InvocationLike[];
  now: Date;
  config: RevertWindowConfig;
}): RevertDecisionResult {
  const { promotedPatch, invocations, now, config } = opts;

  const promotedAt = new Date(promotedPatch.createdAt);
  const windowExpiresAt = new Date(promotedAt.getTime() + config.windowMinutes * 60 * 1000);

  const stats = {
    totalInvocations: 0,
    failedInvocations: 0,
    failureRate: 0,
    windowExpiresAt: windowExpiresAt.toISOString(),
  };

  // Window expired — no action possible
  if (now > windowExpiresAt) {
    return { shouldRevert: false, reason: 'window_expired', stats };
  }

  // Filter invocations to only those for this skill version.
  // The caller (invocationsReader) is responsible for pre-filtering by time window;
  // we additionally filter by skill_id + version to be safe against mixed results.
  const windowInvocations = invocations.filter(inv =>
    inv.skill_id === promotedPatch.skillId &&
    inv.skill_version === promotedPatch.toVersion
  );

  const totalInvocations = windowInvocations.length;
  const failedInvocations = windowInvocations.filter(inv => inv.outcome === 'failure').length;
  const failureRate = totalInvocations > 0 ? failedInvocations / totalInvocations : 0;

  stats.totalInvocations = totalInvocations;
  stats.failedInvocations = failedInvocations;
  stats.failureRate = failureRate;

  // Not enough data to make a reliable decision
  if (totalInvocations < config.minInvocations) {
    return { shouldRevert: false, reason: 'insufficient_invocations', stats };
  }

  // Below threshold — no revert
  if (failureRate < config.failureThreshold) {
    return { shouldRevert: false, reason: 'threshold_not_met', stats };
  }

  return { shouldRevert: true, reason: 'in_window_threshold_exceeded', stats };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function checkAndAutoRevert(opts: CheckAndAutoRevertOptions): Promise<CheckAndAutoRevertResult> {
  const {
    promotedPatch,
    skillsStore,
    patchesStore,
    invocationsReader,
    evidenceStore,
    approvalEngine,
    orgId,
    now = new Date(),
    config = loadRevertWindowConfig(),
  } = opts;

  const windowStart = new Date(promotedPatch.createdAt);
  const invocations = await invocationsReader(promotedPatch.skillId, windowStart.toISOString());

  const decision = evaluateRevertDecision({
    promotedPatch: {
      skillId: promotedPatch.skillId,
      toVersion: promotedPatch.toVersion,
      createdAt: promotedPatch.createdAt,
    },
    invocations,
    now,
    config,
  });

  if (!decision.shouldRevert) {
    return { reverted: false, reason: decision.reason };
  }

  // ── Revert: look up previous body ──────────────────────────────────────────

  // Find the current skill row (the promoted version) — use unchecked since this is
  // a system-level auto-revert job that may run outside of a request context.
  const currentSkill = await skillsStore.findByIdUnchecked(promotedPatch.skillId);
  if (!currentSkill) {
    return { reverted: false, reason: 'skill_not_found' };
  }

  // Find all versions of this skill, locate the fromVersion row
  const allVersions = await skillsStore.listVersions({ orgId, name: currentSkill.name });
  const previousVersionRow = allVersions.find(r => r.version === promotedPatch.fromVersion);

  if (!previousVersionRow) {
    return { reverted: false, reason: 'previous_version_not_found' };
  }

  // ── Update skill row to previous body (system revert — no Crystal eval) ────
  await skillsStore.update(promotedPatch.skillId, { bodyMd: previousVersionRow.bodyMd });

  // ── Write audit patch row ──────────────────────────────────────────────────
  const revertReason = `auto-revert window threshold exceeded: ${(decision.stats.failureRate * 100).toFixed(1)}% failure rate over ${decision.stats.totalInvocations} invocations`;

  const revertPatch = await patchesStore.create({
    skillId: promotedPatch.skillId,
    fromVersion: promotedPatch.toVersion,   // rolling back FROM the promoted version
    toVersion: promotedPatch.fromVersion,   // back TO the previous version
    patchedBy: 'system:auto-revert',
    reason: revertReason,
    diff: {
      from_body_md: currentSkill.bodyMd,
      to_body_md: previousVersionRow.bodyMd,
    },
    crystalsEvaluated: 0,
    crystalsPassed: 0,
    crystalsFailed: [],
    outcome: 'reverted',
    envelopeId: null,
  });

  // ── Emit VOLT evidence ─────────────────────────────────────────────────────
  if (evidenceStore) {
    const { envelopeId } = await emitPatchEvidence({
      evidenceStore,
      orgId,
      skillId: promotedPatch.skillId,
      patchRecord: {
        id: revertPatch.id,
        from_version: revertPatch.fromVersion,
        to_version: revertPatch.toVersion,
      },
      diff: {
        from_body_md: currentSkill.bodyMd,
        to_body_md: previousVersionRow.bodyMd,
      },
      crystalsEvaluated: 0,
      crystalsPassed: 0,
      crystalsFailed: [],
      outcome: 'reverted',
      who: 'system:auto-revert',
      reason: revertReason,
    });
    await patchesStore.setEnvelopeId(revertPatch.id, envelopeId);
  }

  // ── File HITL inbox item ───────────────────────────────────────────────────
  if (approvalEngine) {
    const failurePct = (decision.stats.failureRate * 100).toFixed(1);
    const title = `Auto-revert: ${currentSkill.name} v${promotedPatch.toVersion} after ${failurePct}% failure rate`;

    const bodyMd = [
      `**Skill:** \`${currentSkill.name}\` (id: ${promotedPatch.skillId})`,
      `**Reverted:** ${promotedPatch.toVersion} → ${promotedPatch.fromVersion}`,
      `**Revert patch:** ${revertPatch.id}`,
      '',
      `## Failure stats`,
      `- Total invocations in window: ${decision.stats.totalInvocations}`,
      `- Failed invocations: ${decision.stats.failedInvocations}`,
      `- Failure rate: ${failurePct}%`,
      `- Window expires at: ${decision.stats.windowExpiresAt}`,
      '',
      `## Action`,
      `The skill body was automatically rolled back to v${promotedPatch.fromVersion}.`,
      `Review and re-promote if the regression was not caused by the patch.`,
    ].join('\n');

    await approvalEngine.createApproval({
      correlationId: ulid(),
      workflowId: `skill-auto-revert:${promotedPatch.skillId}`,
      workflowName: `Auto-Revert: ${currentSkill.name}`,
      executionId: revertPatch.id,
      trigger: {
        policyId: 'skill_patch_safety',
        ruleId: 'auto_revert_window',
        condition: 'invocation_failure_threshold',
        context: {
          skillId: promotedPatch.skillId,
          patchId: revertPatch.id,
          failureRate: decision.stats.failureRate,
          totalInvocations: decision.stats.totalInvocations,
        },
      },
      approvers: [],
      metadata: {
        type: 'notification',
        orgId,
        priority: 'high',
        title,
        message: bodyMd,
        body_md: bodyMd,
        trigger: 'auto_revert_window',
        patch_id: revertPatch.id,
        patchId: revertPatch.id,
        skill_id: promotedPatch.skillId,
        from_version: promotedPatch.toVersion,
        to_version: promotedPatch.fromVersion,
        failure_rate: decision.stats.failureRate,
      },
    });
  }

  return { reverted: true, reason: decision.reason, revertPatch };
}
