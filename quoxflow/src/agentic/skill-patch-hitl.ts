/**
 * QSKL-4.D — Skill Patch HITL Routing
 *
 * When a skill patch is auto-reverted due to Crystal regression, this helper
 * files an inbox item via the existing ApprovalEngine → onApprovalCreated hook
 * that routes to the auth service HITL inbox.
 *
 * If approvalEngine is undefined (test contexts or non-HITL deployments) this
 * is a silent no-op — it must never throw.
 *
 * QSKL-6.4a adds a sibling function `fileSkillRequiredToolHITL` which fires
 * when a required tool is not available (NOT_SHIPPED / POLICY_VIOLATION /
 * BUILD_FAILED / BLOCKED_STABLE). It reuses the same approval-engine plumbing.
 */

import type { ApprovalEngine } from '../approval/approval-engine.js';
import type { RequiredToolSpec } from './skill-required-tools-types.js';
import { ulid } from 'ulid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrystalFailureDetail {
  crystal_id: string;
  failure_reason: string;
  failed_step_index?: number;
}

export interface SkillTestFailureDetail {
  name: string;
  failure_reason?: string;
}

export interface FileSkillPatchHITLOptions {
  approvalEngine: ApprovalEngine | undefined;
  orgId: string;
  skillId: string;
  skillName: string;
  fromVersion: string;
  toVersion: string;
  patchId: string;
  diff: { from_body_md: string; to_body_md: string; step_diff?: unknown };
  crystalsFailed: CrystalFailureDetail[];
  /** QSKL-5.B: when the patch was reverted by the tests gate. */
  testsFailed?: SkillTestFailureDetail[];
  /** QSKL-5.B: short reason header — 'tests_gate' or 'crystal_regression'. */
  trigger?: 'tests_gate' | 'crystal_regression';
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function fileSkillPatchHITL(opts: FileSkillPatchHITLOptions): Promise<void> {
  const {
    approvalEngine,
    orgId,
    skillId,
    skillName,
    fromVersion,
    toVersion,
    patchId,
    diff,
    crystalsFailed,
    testsFailed,
    trigger = 'crystal_regression',
  } = opts;

  // Silent no-op when engine is not wired (test contexts)
  if (!approvalEngine) {
    return;
  }

  const title = trigger === 'tests_gate'
    ? `Skill patch reverted (tests failed): ${skillName}`
    : `Skill patch reverted: ${skillName} v${fromVersion} → v${toVersion}`;

  // Build body markdown summarising the diff + failed Crystals / tests
  const crystalLines = crystalsFailed
    .map(f => `- **${f.crystal_id}**: ${f.failure_reason}${f.failed_step_index !== undefined ? ` (step ${f.failed_step_index})` : ''}`)
    .join('\n');

  const testLines = (testsFailed ?? [])
    .map(f => `- **${f.name}**: ${f.failure_reason ?? 'no reason given'}`)
    .join('\n');

  const failureSection = trigger === 'tests_gate'
    ? [`## Failed Tests (${(testsFailed ?? []).length})`, testLines || '_(none)_']
    : [`## Failed Crystals (${crystalsFailed.length})`, crystalLines || '_(none)_'];

  const bodyMd = [
    `**Skill:** \`${skillName}\` (id: ${skillId})`,
    `**Patch:** ${fromVersion} → ${toVersion}`,
    `**Patch record:** ${patchId}`,
    '',
    '## Diff',
    '```',
    `FROM:\n${diff.from_body_md}`,
    '',
    `TO:\n${diff.to_body_md}`,
    '```',
    '',
    ...failureSection,
  ].join('\n');

  // The approval engine's onApprovalCreated callback (server.ts) reads metadata
  // fields to determine inbox kind/priority/title/body. We use type='notification'
  // (FYI delivery — no Approve/Deny buttons) with high priority since this is
  // an automated safety-net alert rather than a gate requiring human approval.
  await approvalEngine.createApproval({
    correlationId: ulid(),
    workflowId: `skill-patch:${skillId}`,
    workflowName: `Skill Patch: ${skillName}`,
    executionId: patchId,
    trigger: {
      policyId: 'skill_patch_safety',
      ruleId: trigger === 'tests_gate' ? 'tests_gate' : 'crystal_regression',
      condition: trigger,
      context: { skillId, patchId, crystalsFailed: crystalsFailed.length },
    },
    approvers: [],
    metadata: {
      type: 'notification',
      orgId,
      priority: 'high',
      title,
      message: bodyMd,
      body_md: bodyMd,
      trigger,
      patch_id: patchId,
      patchId,
      skill_id: skillId,
      from_version: fromVersion,
      to_version: toVersion,
    },
  });
}

// ─── QSKL-14a Slice 3: WARD re-cert HITL filer ───────────────────────────────

export interface FileWardRecertHITLOptions {
  approvalEngine: ApprovalEngine | undefined;
  orgId: string;
  skillId: string;
  skillName: string;
  agentId: string | null;
  old_claims: string[];
  new_claims: string[];
  diff_summary: string;
}

/**
 * File a HITL notification when a skill's `policySatisfies` array changes.
 * The previous cert decision was based on the old claims, so WARD re-cert
 * is required.
 *
 * If `approvalEngine` is undefined → silent no-op (matches existing pattern).
 */
export async function fileWardRecertHITL(
  opts: FileWardRecertHITLOptions,
): Promise<void> {
  const {
    approvalEngine,
    orgId,
    skillId,
    skillName,
    agentId,
    old_claims,
    new_claims,
    diff_summary,
  } = opts;

  // Silent no-op when engine is not wired
  if (!approvalEngine) {
    return;
  }

  const title = `WARD re-certification needed: ${skillName} policy_satisfies changed`;

  const bodyMd = [
    `**Skill:** \`${skillName}\` (id: ${skillId})`,
    agentId ? `**Agent:** ${agentId}` : '**Patched by:** user/system',
    '',
    '## Policy Satisfies Change',
    `**Old claims:** ${old_claims.length > 0 ? old_claims.map((c) => `\`${c}\``).join(', ') : '_(none)_'}`,
    `**New claims:** ${new_claims.length > 0 ? new_claims.map((c) => `\`${c}\``).join(', ') : '_(none)_'}`,
    `**Change:** ${diff_summary || '_(no change)_'}`,
    '',
    'The previous WARD certification decision was based on the old `policySatisfies` claims.',
    'A WARD re-certification run is required to validate the updated claims.',
  ].join('\n');

  await approvalEngine.createApproval({
    correlationId: ulid(),
    workflowId: `ward-recert:${skillId}`,
    workflowName: `WARD Re-cert: ${skillName}`,
    executionId: ulid(),
    trigger: {
      policyId: 'ward_recertification',
      ruleId: 'policy_satisfies_changed',
      condition: 'policy_satisfies_changed',
      context: {
        skillId,
        agentId,
        old_claims,
        new_claims,
        diff_summary,
      },
    },
    approvers: [],
    metadata: {
      type: 'notification',
      orgId,
      priority: 'high',
      trigger: 'policy_satisfies_changed',
      title,
      message: bodyMd,
      body_md: bodyMd,
      skill_id: skillId,
      skill_name: skillName,
      agent_id: agentId,
      claim_diff: { old_claims, new_claims, diff_summary },
      suggested_action: 'WARD re-certification needed',
    },
  });
}

// ─── QSKL-6.4a: Required-tool HITL filer ─────────────────────────────────────

export type SkillRequiredToolReason =
  | 'NOT_SHIPPED'
  | 'POLICY_VIOLATION'
  | 'BUILD_FAILED'
  | 'BLOCKED_STABLE';

export interface FileSkillRequiredToolHITLOptions {
  approvalEngine: ApprovalEngine | undefined;
  orgId: string;
  skillId: string;
  skillName: string;
  skillVersion: string;
  missingTools: RequiredToolSpec[];
  reason: SkillRequiredToolReason;
  detail?: string;
}

/**
 * Render a markdown summary of missing tools.
 * Exported for testability — consumers may use it directly if needed.
 */
export function renderMissingToolsMarkdown(missingTools: RequiredToolSpec[]): string {
  if (missingTools.length === 0) {
    return '_(no missing tools)_';
  }
  const lines = missingTools.map((t) => {
    const parts = [`- **${t.name}**`];
    if (t.version_constraint) {
      parts.push(`version: \`${t.version_constraint}\``);
    }
    if (t.must_satisfy_policy && t.must_satisfy_policy.length > 0) {
      parts.push(`policy: ${t.must_satisfy_policy.map((p) => `\`${p}\``).join(', ')}`);
    }
    return parts.join(' — ');
  });
  return lines.join('\n');
}

/**
 * File a HITL notification when a required tool is not available at skill
 * invocation / promotion time.
 *
 * If `approvalEngine` is undefined → silent no-op (matches existing pattern
 * in `fileSkillPatchHITL`).
 */
export async function fileSkillRequiredToolHITL(
  opts: FileSkillRequiredToolHITLOptions,
): Promise<void> {
  const {
    approvalEngine,
    orgId,
    skillId,
    skillName,
    skillVersion,
    missingTools,
    reason,
    detail,
  } = opts;

  // Silent no-op when engine is not wired (test contexts / non-HITL deployments)
  if (!approvalEngine) {
    return;
  }

  const title = `Skill "${skillName}" needs a tool that isn't available`;
  const message = `Reason: ${reason}${detail ? ' — ' + detail : ''}`;

  const bodyMd = [
    `**Skill:** \`${skillName}\` (id: ${skillId})`,
    `**Version:** ${skillVersion}`,
    `**Reason:** ${reason}${detail ? ` — ${detail}` : ''}`,
    '',
    `## Missing Tools (${missingTools.length})`,
    renderMissingToolsMarkdown(missingTools),
  ].join('\n');

  await approvalEngine.createApproval({
    correlationId: ulid(),
    workflowId: `skill-required-tool:${skillId}`,
    workflowName: `Skill Required Tool: ${skillName}`,
    executionId: ulid(),
    trigger: {
      policyId: 'skill_required_tool_safety',
      ruleId: 'skill_required_tool_missing',
      condition: 'skill_required_tool_missing',
      context: { skillId, skillVersion, missingCount: missingTools.length },
    },
    approvers: [],
    metadata: {
      type: 'notification',
      orgId,
      priority: 'high',
      trigger: 'skill_required_tool_missing',
      title,
      message,
      body_md: bodyMd,
      skill_id: skillId,
      skill_version: skillVersion,
      missing_tools: missingTools,
      reason,
    },
  });
}
