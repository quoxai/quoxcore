/**
 * Contradiction Gate (PIECE 2) — pauses a Crystal auto-fire for HITL review
 * when it diverges sharply from a track-record neighbor for the same
 * objective.
 *
 * Wired into src/executors/agentic.executor.ts immediately after a fuzzy
 * `replayCandidate` (C0) is selected (the "crystal-binding call site" —
 * see that file's P9.1 retrieval block, `replayCandidate = retrievedCrystals.find(...)`)
 * and before the deterministic-replay branch executes it.
 *
 * For each neighbor Ci returned by skillLibraryStore.findApplicable(),
 * computes:
 *
 *   divergenceScore = |C0.successRate - Ci.successRate|
 *                      × Jaccard(C0.objectiveKeywords, Ci.objectiveKeywords)
 *                      × ( min(execCount) / (min(execCount) + 5) )
 *
 * Exception: when either side has an empty objectiveKeywords array (legacy
 * Crystals predating this field, or any draft path that omits it), the
 * Jaccard term is dropped rather than treated as 0 — see the comment on
 * computeDivergenceScore() for why "no keyword data" must not silently
 * exempt a candidate from the gate.
 *
 * Any neighbor scoring >= CONTRADICTION_DIVERGENCE_THRESHOLD triggers a
 * paused HITL approval (metadata.type deliberately OMITTED — see
 * server.ts's inbox branching around lines 471-476: isHumanTask=false,
 * isNotification=false → default 'approval' kind, Approve/Deny buttons,
 * paused workflow. Confirmed against current server.ts before writing;
 * this mirrors the exact createApproval() shape used by
 * src/agentic/skill-patch-hitl.ts's fileSkillPatchHITL(), which
 * deliberately sets metadata.type='notification' for its FYI case — this
 * gate is the opposite case, hence the omission).
 */

import { ulid } from 'ulid';
import type { ApprovalEngine } from '../approval/approval-engine.js';
import type { SkillLibraryRecord, FindApplicableOptions } from '../store/skill-library-store.js';

export const CONTRADICTION_DIVERGENCE_THRESHOLD = 0.35;

export interface ContradictionCrystal {
  id: string;
  name: string;
  successRate: number;
  executionCount: number;
  objectiveKeywords: string[];
}

/** Jaccard similarity of two keyword sets. Empty ∩ empty = 0 (no signal, not full overlap). */
export function jaccardOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const k of setA) {
    if (setB.has(k)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function computeDivergenceScore(c0: ContradictionCrystal, ci: ContradictionCrystal): number {
  const rateDelta = Math.abs(c0.successRate - ci.successRate);
  const minExec = Math.min(c0.executionCount, ci.executionCount);
  const execConfidence = minExec / (minExec + 5);

  // Missing objectiveKeywords means "we don't know if these are related",
  // not "confirmed unrelated" — a legacy Crystal (created before this field
  // existed) or any draft path that omits it (see skill-library-store.ts's
  // `objectiveKeywords: draft.objectiveKeywords ?? []`) must NOT be treated
  // as automatically exempt from the gate just because Jaccard(∅, x) = 0.
  // When either side's keyword set is empty, drop the Jaccard term entirely
  // instead of multiplying by 0, and gate purely on |Δsuccess_rate| ×
  // execConfidence. This is safe against over-triggering on truly unrelated
  // pairs because both candidates only ever reach this comparison via
  // skillLibraryStore.findApplicable(), which only returns a neighbor with
  // empty objectiveKeywords when it shares the SAME agentId as the query
  // (findApplicable's `agentMatch || keywordMatch` — an empty keyword set
  // can never satisfy keywordMatch) — same-agent authorship is itself a
  // relatedness signal, so no additional threshold damping is needed here.
  const keywordDataMissing = c0.objectiveKeywords.length === 0 || ci.objectiveKeywords.length === 0;
  if (keywordDataMissing) {
    return rateDelta * execConfidence;
  }

  const overlap = jaccardOverlap(c0.objectiveKeywords, ci.objectiveKeywords);
  return rateDelta * overlap * execConfidence;
}

export interface DivergentNeighbor {
  id: string;
  name: string;
  successRate: number;
  executionCount: number;
  score: number;
}

export interface ContradictionGateDeps {
  skillLibraryStore: Pick<{ findApplicable(opts: FindApplicableOptions): Promise<SkillLibraryRecord[]> }, 'findApplicable'>;
  /** Optional: without an approvalEngine, divergence is still detected/returned
   * but nothing can be paused — callers should treat that as fail-open with
   * the divergentNeighbors list logged, not a silent skip. */
  approvalEngine?: Pick<ApprovalEngine, 'createApproval'>;
}

export interface ContradictionGateParams {
  orgId: string;
  agentId?: string;
  objectiveKeywords: string[];
  /** C0 — the crystal about to auto-fire. */
  candidate: ContradictionCrystal;
  correlationId: string;
  workflowId: string;
  workflowName?: string;
  executionId: string;
  nodeId?: string;
}

export interface ContradictionGateResult {
  paused: boolean;
  approvalId?: string;
  divergentNeighbors: DivergentNeighbor[];
}

export async function runContradictionGate(
  params: ContradictionGateParams,
  deps: ContradictionGateDeps,
): Promise<ContradictionGateResult> {
  const neighbors = await deps.skillLibraryStore.findApplicable({
    orgId: params.orgId,
    agentId: params.agentId,
    objectiveKeywords: params.objectiveKeywords,
    maxCrystals: 5,
  });

  const divergentNeighbors: DivergentNeighbor[] = [];
  for (const n of neighbors) {
    if (n.id === params.candidate.id) continue;
    const ci: ContradictionCrystal = {
      id: n.id,
      name: n.name,
      successRate: n.successRate,
      executionCount: n.executionCount,
      objectiveKeywords: (n.metadata?.objectiveKeywords as string[] | undefined) ?? [],
    };
    const score = computeDivergenceScore(params.candidate, ci);
    if (score >= CONTRADICTION_DIVERGENCE_THRESHOLD) {
      divergentNeighbors.push({ id: ci.id, name: ci.name, successRate: ci.successRate, executionCount: ci.executionCount, score });
    }
  }

  if (divergentNeighbors.length === 0) {
    return { paused: false, divergentNeighbors: [] };
  }

  if (!deps.approvalEngine) {
    return { paused: false, divergentNeighbors };
  }

  const trackRecordLines = [
    `- **${params.candidate.name}** (${params.candidate.id}): success_rate=${params.candidate.successRate.toFixed(2)}, executions=${params.candidate.executionCount}`,
    ...divergentNeighbors.map(
      d => `- **${d.name}** (${d.id}): success_rate=${d.successRate.toFixed(2)}, executions=${d.executionCount}, divergence_score=${d.score.toFixed(2)}`,
    ),
  ];

  const bodyMd = [
    `Crystal **${params.candidate.name}** is about to auto-fire, but its track record diverges ` +
      `sharply (>= ${CONTRADICTION_DIVERGENCE_THRESHOLD}) from ${divergentNeighbors.length} other Crystal(s) ` +
      'proven applicable to the same objective. Review both track records before allowing this run.',
    '',
    '## Track records',
    ...trackRecordLines,
  ].join('\n');

  const approval = await deps.approvalEngine.createApproval({
    correlationId: params.correlationId,
    workflowId: params.workflowId,
    workflowName: params.workflowName,
    executionId: params.executionId,
    nodeId: params.nodeId,
    trigger: {
      policyId: 'contradiction_gate',
      ruleId: 'crystal_divergence',
      condition: `divergence_score>=${CONTRADICTION_DIVERGENCE_THRESHOLD}`,
      context: {
        candidateId: params.candidate.id,
        divergentIds: divergentNeighbors.map(d => d.id),
      },
    },
    approvers: [],
    metadata: {
      // type deliberately OMITTED — defaults to 'approval' kind with
      // Approve/Deny buttons + paused workflow (server.ts inbox branching).
      orgId: params.orgId,
      priority: 'high',
      title: `Contradictory Crystals detected for "${params.candidate.name}"`,
      nodeName: params.nodeId,
      message: bodyMd,
      body_md: bodyMd,
    },
  });

  return { paused: true, approvalId: approval.id, divergentNeighbors };
}

/** Small helper kept exported for callers that build correlation IDs for
 * sub-approvals fired within an already-running workflow correlation. */
export function newContradictionApprovalCorrelationId(): string {
  return ulid();
}
