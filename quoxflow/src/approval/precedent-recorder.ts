/**
 * Approval -> Precedent recorder (QLoop precedent wiring, piece 2).
 *
 * Human rulings bind. When an approval resolves (approve or deny) and the
 * approver left a comment, that comment is the ratio: the operative reasoning
 * that generalises beyond this one case. It is persisted to the precedent
 * store with authority 'hitl-approved' so the agentic executor's terminal
 * done-gate (src/executors/agentic.executor.ts) can require the agent to
 * follow or distinguish it.
 *
 * v1 scope, deliberately narrow:
 *   - Only HITL resolutions are written. Agent-autonomous dispositions are
 *     NOT recorded as precedents in this pass.
 *   - A resolution with no comment is skipped: a ratio-less precedent gives
 *     the gate nothing to show the agent.
 *   - The write is best-effort. A store failure is logged and swallowed, the
 *     same contract durable-hooks.ts uses for lineage writes: an approval
 *     must never fail because precedent recording failed.
 *
 * Fact pattern shape: PrecedentStore.findApplicable() fuzzy-matches on the
 * TOP-LEVEL KEY NAMES of fact_pattern (see its doc comment), not on values.
 * So the pattern carries two kinds of entry:
 *   - descriptive fields (workflow_id, node_id, policy_id, condition, ...)
 *     which record what was judged, and
 *   - namespaced match tokens as keys (`workflow:<id>`, `node_type:<type>`,
 *     `policy:<id>`, `kw:<word>`) which are what a caller's contextKeys are
 *     compared against. Namespacing keeps the match narrow: a generic key
 *     like `workflow_id` would otherwise match every judgment call in the org.
 */

import { logger } from '../logger.js';
import type { PrecedentRecord, PrecedentStore } from '../store/precedent-store.js';
import type { ApprovalRequest } from './types.js';

const log = logger.for('PrecedentRecorder');

/** Max keyword tokens derived from free text, matching the executor's own
 * objective-keyword slice (agentic.executor.ts). */
const MAX_KEYWORD_TOKENS = 10;

/** Words shorter than this are dropped, matching the executor's filter. */
const MIN_KEYWORD_LENGTH = 4;

/**
 * Split free text into the same keyword shape the agentic executor derives
 * from its objective, so the two sides of the fuzzy match can agree.
 */
export function deriveKeywordTokens(sources: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const word of source.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (word.length >= MIN_KEYWORD_LENGTH) seen.add(word);
      if (seen.size >= MAX_KEYWORD_TOKENS) return [...seen];
    }
  }
  return [...seen];
}

/**
 * Build the fact pattern for a resolved approval. Exported for the executor
 * side to reason about (and for tests) — see the module header for why the
 * match tokens are namespaced keys rather than values.
 */
export function buildApprovalFactPattern(approval: ApprovalRequest): Record<string, unknown> {
  const metadata = (approval.metadata ?? {}) as Record<string, unknown>;
  const nodeType = typeof metadata.nodeType === 'string' ? metadata.nodeType : undefined;

  const keywords = deriveKeywordTokens([
    approval.workflowName,
    approval.trigger?.condition,
    typeof metadata.title === 'string' ? metadata.title : undefined,
    typeof metadata.message === 'string' ? metadata.message : undefined,
  ]);

  const factPattern: Record<string, unknown> = {
    judgment: 'hitl_approval',
    workflow_id: approval.workflowId,
    node_id: approval.nodeId ?? null,
    node_type: nodeType ?? null,
    policy_id: approval.trigger?.policyId ?? null,
    rule_id: approval.trigger?.ruleId ?? null,
    condition: approval.trigger?.condition ?? null,
  };

  if (approval.workflowId) factPattern[`workflow:${approval.workflowId}`] = true;
  if (nodeType) factPattern[`node_type:${nodeType}`] = true;
  if (approval.trigger?.policyId) factPattern[`policy:${approval.trigger.policyId}`] = true;
  for (const kw of keywords) factPattern[`kw:${kw}`] = true;

  return factPattern;
}

/**
 * Write a precedent for a resolved approval. Returns the written record, or
 * null when nothing was written (unresolved, no comment, or a store failure).
 * Never throws.
 */
export async function recordApprovalPrecedent(
  approval: ApprovalRequest,
  precedentStore: Pick<PrecedentStore, 'write'>,
): Promise<PrecedentRecord | null> {
  const resolution = approval.resolution;
  if (!resolution || (resolution.decision !== 'approved' && resolution.decision !== 'denied')) {
    return null;
  }

  const ratio = (resolution.comment ?? '').trim();
  if (ratio === '') {
    // A ruling with no stated reasoning cannot bind anything: there is no
    // ratio to show the next agent, so recording it would only make the gate
    // fire with an empty explanation.
    return null;
  }

  const metadata = (approval.metadata ?? {}) as Record<string, unknown>;
  const orgId = approval.orgId
    || (typeof metadata.orgId === 'string' ? metadata.orgId : undefined)
    || 'default';

  try {
    return await precedentStore.write({
      orgId,
      factPattern: buildApprovalFactPattern(approval),
      ratio,
      disposition: {
        decision: resolution.decision,
        approver: approval.resolvedBy ?? null,
        resolvedAt: approval.resolvedAt ?? null,
        approvalId: approval.id,
      },
      authority: 'hitl-approved',
      status: 'active',
    });
  } catch (err) {
    log.warn(
      `precedent write failed for approval ${approval.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Build an onApprovalResolved hook that records the precedent and then runs
 * any pre-existing consumer. Composition, not replacement: server.ts may
 * already have a resolved-hook and it keeps its behaviour, including its
 * throw semantics (the precedent is written first, so an existing consumer
 * failing does not lose the ruling).
 */
export function createApprovalPrecedentHook(
  precedentStore: Pick<PrecedentStore, 'write'>,
  next?: (approval: ApprovalRequest) => void | Promise<void>,
): (approval: ApprovalRequest) => Promise<void> {
  return async (approval: ApprovalRequest): Promise<void> => {
    await recordApprovalPrecedent(approval, precedentStore);
    if (next) await next(approval);
  };
}
