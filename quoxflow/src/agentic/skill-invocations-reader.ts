/**
 * QSKL-7.4 — createInvocationsReader factory
 *
 * Wraps QuoxSkillInvocationsStore.findRecent() to produce the
 * InvocationLike[] shape expected by QSKL-4's checkAndAutoRevert
 * invocationsReader slot.
 *
 * Null-safety: SkillInvocationRecord.success is typed as boolean, but the DB
 * column can surface as null at runtime (e.g. in legacy rows or coercion edge
 * cases). We treat any falsy value as 'failure' via Boolean() coercion so that
 * the revert guard errs on the side of caution.
 *
 * QF-MT WP7: orgId is bound into the closure here (findRecent() now requires
 * it) rather than threaded through the invocationsReader function shape,
 * since checkAndAutoRevert's invocationsReader slot is a fixed
 * (skillId, sinceIso) => Promise<InvocationLike[]> signature shared with
 * other callers.
 */

import type { QuoxSkillInvocationsStore } from '../store/quox-skill-invocations-store.js';
import type { InvocationLike } from './skill-patch-revert-window.js';

export function createInvocationsReader(
  store: QuoxSkillInvocationsStore,
  orgId: string
): (skillId: string, sinceIso: string) => Promise<InvocationLike[]> {
  return async (skillId, sinceIso) => {
    const rows = await store.findRecent(skillId, sinceIso, orgId);
    return rows.map(r => ({
      skill_id: r.skillId,
      skill_version: r.skillVersion,
      // Treat any falsy value (including null) as 'failure' defensively.
      outcome: r.success ? 'success' : 'failure',
      created_at: r.createdAt as string,
    }));
  };
}
