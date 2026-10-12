/**
 * Precedent Gate — fail-closed citation enforcement for judgment-call
 * resolutions (PIECE 1 of the precedent-store work).
 *
 * When a judgment call is about to be resolved and an active precedent
 * exists for its fact pattern, the resolving envelope's reasoning trace
 * MUST either follow that precedent (`follows_precedent:<id>`) or
 * explicitly distinguish it (`distinguishes_precedent:{"id":"<id>","factual_delta":"..."}`).
 * Silence is rejected — mirrors the fail-closed empty-string check in
 * src/pipeline/crystalliser.ts's analyseDraft() (around line 257:
 * `if (!draft.actionPattern || draft.actionPattern.trim() === '')`),
 * generalised from "was anything recorded at all" to "was the *correct
 * shape* of thing recorded".
 *
 * WIRING NOTE (documented, not forced — see task instructions on not
 * forcing real surgery): this module is a standalone, fully-tested gate
 * function. It is deliberately NOT wired into src/policy/policy-layer.ts's
 * PolicyEvaluator. That evaluator (src/policy/evaluator.ts) is a
 * deterministic DSL rule engine — it resolves policies by matching
 * structured conditions against ExpressionContext, and has no free-text
 * "reasoning" field anywhere in its result types (PolicyEvaluationResult /
 * AggregatedPolicyResult, src/policy/types.ts). A grep across src for
 * "judgment"/"judgement"/"reasoning_trace" turned up no existing concept of
 * an LLM-authored judgment-call resolution with a reasoning trace outside
 * the agentic executor's per-iteration `decision.reasoning` field
 * (src/executors/agentic.executor.ts) — and that loop has no notion of
 * "fact pattern" or "org-scoped judgment call boundary" today. Threading
 * factPatternHash through the 2000+-line, heavily-tested executor and
 * deciding which of its many decision points count as a "judgment call"
 * is real surgery, not a straightforward addition, so it was not forced.
 * Call `enforcePrecedentCitation()` from whichever call site the next pass
 * identifies as the actual judgment-call resolution boundary.
 */

import type { PrecedentStore, FindApplicablePrecedentOptions } from '../store/precedent-store.js';

const FOLLOWS_PATTERN = /follows_precedent:([A-Za-z0-9_-]+)/;
const DISTINGUISHES_PATTERN = /distinguishes_precedent:(\{[^}]*\})/;

export interface PrecedentCitationCheck {
  /** Whether the reasoning trace cites a precedent in the required shape. */
  cited: boolean;
  mode?: 'follows' | 'distinguishes';
  precedentId?: string;
  factualDelta?: string;
}

/**
 * Pure parser: does `reasoningTrace` contain a valid citation marker?
 * Exported standalone so callers can pre-validate free text without a
 * store round-trip.
 */
export function parsePrecedentCitation(reasoningTrace: string | undefined | null): PrecedentCitationCheck {
  if (!reasoningTrace || reasoningTrace.trim() === '') {
    return { cited: false };
  }

  const followsMatch = reasoningTrace.match(FOLLOWS_PATTERN);
  if (followsMatch) {
    return { cited: true, mode: 'follows', precedentId: followsMatch[1] };
  }

  const distinguishesMatch = reasoningTrace.match(DISTINGUISHES_PATTERN);
  if (distinguishesMatch) {
    try {
      const parsed = JSON.parse(distinguishesMatch[1]) as { id?: string; factual_delta?: string };
      if (parsed.id && parsed.factual_delta && parsed.factual_delta.trim() !== '') {
        return { cited: true, mode: 'distinguishes', precedentId: parsed.id, factualDelta: parsed.factual_delta };
      }
    } catch {
      // Malformed JSON in the distinguishes_precedent{} payload — fail
      // closed, same as no citation at all.
      return { cited: false };
    }
  }

  return { cited: false };
}

export interface EnforcePrecedentCitationParams {
  orgId: string;
  factPatternHash?: string;
  contextKeys?: string[];
  /** The resolving envelope's reasoning-trace text (e.g. decision.reasoning). */
  reasoningTrace: string | undefined | null;
}

export interface EnforcePrecedentCitationResult {
  /** True when the resolution may proceed. */
  allowed: boolean;
  /** Present when an active precedent was found (cited or not). */
  matchedPrecedentId?: string;
  /** Present when allowed === false. */
  reason?: string;
  citation?: PrecedentCitationCheck;
}

/**
 * Fail-closed enforcement: if findApplicable() returns an active precedent
 * for this fact pattern, reasoningTrace MUST cite it (follows or
 * distinguishes) or the resolution is rejected. No active precedent means
 * no gate — always allowed in that case (a resolution can't be required to
 * cite something that doesn't exist).
 */
export async function enforcePrecedentCitation(
  params: EnforcePrecedentCitationParams,
  precedentStore: Pick<PrecedentStore, 'findApplicable'>,
): Promise<EnforcePrecedentCitationResult> {
  const findOpts: FindApplicablePrecedentOptions = {
    orgId: params.orgId,
    factPatternHash: params.factPatternHash,
    contextKeys: params.contextKeys,
    maxResults: 1,
  };

  const matches = await precedentStore.findApplicable(findOpts);

  if (matches.length === 0) {
    return { allowed: true };
  }

  const active = matches[0];
  const citation = parsePrecedentCitation(params.reasoningTrace);

  if (!citation.cited) {
    return {
      allowed: false,
      matchedPrecedentId: active.id,
      citation,
      reason:
        `An active precedent (${active.id}) exists for this fact pattern. ` +
        'The resolution reasoning trace must contain follows_precedent:<id> or ' +
        'distinguishes_precedent:{"id":"...","factual_delta":"..."} — none was found.',
    };
  }

  return { allowed: true, matchedPrecedentId: active.id, citation };
}
