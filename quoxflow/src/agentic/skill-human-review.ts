/**
 * quox#748: queue an agent-authored skill for HUMAN review at creation.
 *
 * Skills written by an agent (chat skill_manage, NotesQ propose-skill, the
 * QuoxFlow agentic executor's skill_manage) are told to users as "pending
 * review, human approval required". Before this, nothing put them in the
 * review queue (only the automated safety judge did), and skill_view had no
 * gate, so an agent could write a skill and run it at once. The queued row is
 * what skillViewHandler's gate checks; approving it in the review queue lets
 * the skill run.
 *
 * Best-effort on the store call is NOT acceptable here: if the row cannot be
 * written the caller must know, because the skill would otherwise be runnable.
 */
import type { SkillReviewQueueStore, SkillReviewQueueRow } from '../store/skill-review-queue-store.js';

export interface QueueHumanReviewInput {
  skillId: string;
  version: string | number;
  orgId: string | null;
  author: string | null;
  source: 'chat' | 'notesq' | 'agentic_executor' | 'api';
}

export async function queueHumanReview(
  store: SkillReviewQueueStore | undefined,
  input: QueueHumanReviewInput,
): Promise<{ queued: boolean; row: SkillReviewQueueRow | null; reason?: string }> {
  if (!store) return { queued: false, row: null, reason: 'no_review_queue_store' };
  const row = await store.insert({
    skill_id: input.skillId,
    version: String(input.version),
    org_id: input.orgId,
    judge_run_id: null,
    findings: [{ kind: 'human_review_required', source: input.source, author: input.author }],
    rubric_scores: null,
    rubric_version: 0,
  });
  // null = a row already exists for (skill_id, version): still gated.
  return { queued: true, row };
}
