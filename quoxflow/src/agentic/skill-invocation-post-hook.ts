/**
 * QSKL-7.5 — Post-Invocation Auto-Revert Hook
 *
 * After skillViewHandler records a typed invocation row (Slice 3), this
 * module checks whether the skill has a recently-promoted patch within the
 * configurable window and, if so, invokes QSKL-4's checkAndAutoRevert for
 * each such patch.
 *
 * Best-effort: any failure inside this module must NOT propagate to the
 * skill_view caller.
 */

import type { QuoxSkillsStore } from '../store/quox-skills-store.js';
import type { QuoxSkillPatchesStore } from '../store/quox-skill-patches-store.js';
import type { QuoxSkillInvocationsStore } from '../store/quox-skill-invocations-store.js';
import type { EvidenceStore } from '../evidence/types.js';
import type { ApprovalEngine } from '../approval/approval-engine.js';
import {
  checkAndAutoRevert,
  loadRevertWindowConfig,
  type RevertWindowConfig,
} from './skill-patch-revert-window.js';
import { createInvocationsReader } from './skill-invocations-reader.js';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface PostInvocationContext {
  skillId: string;
  orgId: string;
  skillsStore: QuoxSkillsStore;
  patchesStore: QuoxSkillPatchesStore;
  invocationsStore: QuoxSkillInvocationsStore;
  evidenceStore?: EvidenceStore;
  approvalEngine?: ApprovalEngine;
  config?: RevertWindowConfig;
  now?: Date;
}

export interface PostInvocationResult {
  checkedPatches: number;
  reverts: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Enumerate recent promoted patches for the skill and call checkAndAutoRevert
 * per-patch (usually 0 or 1 in the window — promotions are rare).
 *
 * Best-effort: never throws to caller. Logs a single warn line on failure.
 */
export async function runPostInvocationAutoRevertCheck(
  ctx: PostInvocationContext
): Promise<PostInvocationResult> {
  try {
    const config = ctx.config ?? loadRevertWindowConfig();
    const now = ctx.now ?? new Date();

    const windowStart = new Date(now.getTime() - config.windowMinutes * 60 * 1000);
    const recentPromoted = await ctx.patchesStore.findRecentPromoted(
      ctx.skillId,
      windowStart.toISOString()
    );

    if (recentPromoted.length === 0) {
      return { checkedPatches: 0, reverts: 0 };
    }

    const invocationsReader = createInvocationsReader(ctx.invocationsStore, ctx.orgId);

    const results = await Promise.all(
      recentPromoted.map(promotedPatch =>
        checkAndAutoRevert({
          promotedPatch,
          skillsStore: ctx.skillsStore,
          patchesStore: ctx.patchesStore,
          invocationsReader,
          evidenceStore: ctx.evidenceStore,
          approvalEngine: ctx.approvalEngine,
          orgId: ctx.orgId,
          now,
          config,
        })
      )
    );

    return {
      checkedPatches: recentPromoted.length,
      reverts: results.filter(r => r.reverted).length,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[runPostInvocationAutoRevertCheck] best-effort error for skillId=${ctx.skillId}: ${msg}`);
    return { checkedPatches: 0, reverts: 0 };
  }
}
