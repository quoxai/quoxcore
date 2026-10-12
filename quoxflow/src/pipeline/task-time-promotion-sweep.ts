/**
 * Task-Time Crystal Promotion Sweep — MACHINERY
 *
 * The interactive path (agentic.executor.ts) only evaluates promotion when
 * the LLM happens to emit `propose_crystal` mid-loop and then reaches `done`
 * within the SAME execution. A run that reuses a pattern from a PREVIOUS
 * run's still-experimental (draft) Crystal — without ever re-proposing it —
 * never triggers `analyseDraft()`, so the Crystal can sit at
 * consecutiveSuccess=0 forever even after N more successful task-time uses.
 *
 * This module closes that gap: called from a run-completion hook
 * (durable-hooks.ts `onWorkflowComplete`) for every successful agentic node
 * execution, it looks for an existing EXPERIMENTAL (draft-state) Crystal
 * belonging to the same (orgId, agentId) whose action_pattern matches the
 * just-completed run's real tool-call sequence. If found, it increments the
 * cross-execution consecutive-success counter and re-runs the same
 * `analyseDraft()` promotion evaluator used by the interactive path. Ready
 * drafts are promoted to canonical through the SAME firewall content-scan
 * gate used elsewhere in the Crystal/Skill system (`skill_firewall.ts`) —
 * no bypass. Blocked attempts are recorded via the firewall log store
 * (best-effort, mirrors the skill_manage logging pattern) instead of
 * silently promoting.
 */

import { SkillLibraryStore, CrystalDraft } from '../store/skill-library-store.js';
import { analyseDraft } from './crystalliser.js';
import { createSkillFirewall, SkillFirewall } from '../security/skill_firewall.js';
import type { SkillFirewallLogStore } from '../store/skill-firewall-log-store.js';
import { logger } from '../logger.js';

const log = logger.for('TaskTimePromotionSweep');

/** Meta-actions excluded from the real tool-call pattern (mirrors agentic.executor.ts). */
const META_ACTIONS = new Set(['done', 'propose_crystal', 'refine_crystal']);

export interface TaskTimePromotionSweepInput {
  orgId: string;
  agentId?: string;
  executionId: string;
  /** Fine-grained action log for the run, as produced by the agentic loop. */
  actionLog: Array<{ action: string; success: boolean }>;
}

export interface TaskTimePromotionSweepConfig {
  skillLibraryStore: SkillLibraryStore;
  /** Defaults to createSkillFirewall() — same default as agentic.executor.ts. */
  firewall?: SkillFirewall;
  /** Best-effort — no log row written when absent. */
  firewallLogStore?: SkillFirewallLogStore;
  promotionThreshold?: { confidence: number; consecutive_success: number };
  /**
   * Default ON. Set to false (or CRYSTAL_TASKTIME_PROMOTION_DISABLED=true env
   * var, checked by the caller) to disable the sweep entirely.
   */
  enabled?: boolean;
}

export interface TaskTimePromotionSweepResult {
  /** True when a matching experimental draft was found and evaluated. */
  evaluated: boolean;
  /** IDs of Crystals promoted to canonical this sweep. */
  promotedCrystalIds: string[];
  /** True when at least one ready draft was blocked by the firewall. */
  firewallBlocked: boolean;
  reason?: string;
}

const NOOP_RESULT = (reason: string): TaskTimePromotionSweepResult => ({
  evaluated: false,
  promotedCrystalIds: [],
  firewallBlocked: false,
  reason,
});

/**
 * Run the task-time promotion sweep for one completed, successful run.
 * Non-throwing by design — callers (lifecycle hooks) treat this as best-effort.
 */
export async function runTaskTimePromotionSweep(
  input: TaskTimePromotionSweepInput,
  config: TaskTimePromotionSweepConfig,
): Promise<TaskTimePromotionSweepResult> {
  if (config.enabled === false) {
    return NOOP_RESULT('disabled');
  }

  const realActions = (input.actionLog || []).filter(a => !META_ACTIONS.has(a.action));
  if (realActions.length === 0) {
    return NOOP_RESULT('no_real_actions');
  }
  const completedPattern = realActions.map(a => a.action).join(',');

  const { skillLibraryStore } = config;
  const matchingDrafts = skillLibraryStore.findDraftsByPattern(input.orgId, input.agentId, completedPattern);
  if (matchingDrafts.length === 0) {
    return NOOP_RESULT('no_matching_draft');
  }

  const threshold = config.promotionThreshold ?? { confidence: 0.8, consecutive_success: 3 };
  const firewall = config.firewall ?? createSkillFirewall();

  const promotedCrystalIds: string[] = [];
  let firewallBlocked = false;
  let lastReason: string | undefined;

  for (const draft of matchingDrafts) {
    try {
      const newCount = skillLibraryStore.recordSuccessfulRun({
        agentId: draft.agentId || input.agentId || '',
        orgId: draft.orgId,
        actionPattern: draft.actionPattern,
        completedActionPattern: completedPattern,
      });

      const updatedDraft: CrystalDraft =
        skillLibraryStore.getDraftByExecution(draft.executionId) ?? { ...draft, consecutiveSuccess: newCount };

      const analysis = analyseDraft(updatedDraft, input.actionLog, threshold);
      log.debug(
        `sweep: draft "${updatedDraft.name}" ready=${analysis.ready} ` +
        `confidence=${analysis.recomputedConfidence.toFixed(2)} ` +
        `consecutiveSuccess=${analysis.consecutiveSuccess}/${threshold.consecutive_success}` +
        (analysis.reason ? ` reason=${analysis.reason}` : '')
      );

      if (!analysis.ready) {
        lastReason = analysis.reason;
        continue;
      }

      // ─── Firewall gate — same content-scan mechanism as the Skill write path.
      // No bypass: a ready draft is scanned before promotion, exactly like
      // skill_manage scans body_md before writing a Skill.
      const report = await firewall.scan({
        body_md: `${updatedDraft.name}\n\n${updatedDraft.summary}\n\n${updatedDraft.actionPattern}`,
        metadata: { agentId: updatedDraft.agentId, orgId: updatedDraft.orgId, executionId: updatedDraft.executionId },
      });

      if (config.firewallLogStore) {
        try {
          await config.firewallLogStore.record({
            skill_id: null,
            pending_skill_name: updatedDraft.name,
            version: 1,
            org_id: updatedDraft.orgId,
            author_id: updatedDraft.agentId ?? null,
            allow: report.allow,
            findings: report.findings,
            reason: report.reason ?? null,
            rule_set_version: report.rule_set_version,
            source: 'crystal_promotion_sweep',
          });
        } catch (err) {
          log.warn('firewallLogStore.record() failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (!report.allow) {
        firewallBlocked = true;
        lastReason = `firewall_blocked (${report.findings.length} finding(s))`;
        log.debug(`sweep: draft "${updatedDraft.name}" blocked by firewall — attempt recorded, not promoted`);
        continue;
      }

      const promoted = await skillLibraryStore.promoteCanonical({
        orgId: updatedDraft.orgId,
        executionId: updatedDraft.executionId,
        name: updatedDraft.name,
        summary: updatedDraft.summary,
        actionPattern: updatedDraft.actionPattern,
        confidence: analysis.recomputedConfidence,
        agentId: updatedDraft.agentId,
        objectiveKeywords: updatedDraft.objectiveKeywords,
        actionLogSnapshot: updatedDraft.actionLogSnapshot,
      }, { promotion_trigger: 'task-time-sweep' });

      skillLibraryStore.clearDraft(updatedDraft.executionId);
      promotedCrystalIds.push(promoted.id);
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      log.warn('sweep: promotion attempt failed (non-fatal)', { error: lastReason });
    }
  }

  return {
    evaluated: true,
    promotedCrystalIds,
    firewallBlocked,
    reason: lastReason,
  };
}
