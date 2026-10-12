/**
 * Dispatch Intent Reconciliation, QUOXTRUST-B3
 *
 * Boot-time crash-recovery counterpart to control-pipeline.ts's
 * dispatchExecutor(): a process that crashes between recording a
 * `quox.flow.dispatch.intent` envelope (durably appended BEFORE an outward
 * executor's external effect: HTTP call, agent/team invoke, HITL-approval
 * creation, ...) and recording its `quox.flow.dispatch.settled` outcome
 * leaves that effect in an honestly unknown state: it may or may not have
 * fired.
 *
 * This NEVER re-runs the effect. It only records, once and durably, the
 * fact that the outcome is unknown, the same "distinguish an uncertain
 * outcome from a clean failure" guarantee server.ts's existing
 * executionStore.failStale() crash-recovery pass provides for whole
 * executions, extended down to individual outward dispatches.
 */

import { EnvelopeStore } from '../store/envelope-store.js';
import { envelopes as envelopeFactory, Intents } from '../core/envelope.js';
import { SYSTEM_SCOPE } from '../api/middleware/org-scope.js';
import type { Logger } from '../logger.js';

/**
 * Finds every dispatch-intent envelope older than `olderThanMs` with no
 * correlated dispatch-settled/outcome_unknown envelope (via
 * EnvelopeStore.findUnsettledDispatchIntents), and appends exactly one
 * `quox.flow.dispatch.outcome_unknown` envelope for each, into the same org
 * the intent was recorded under.
 *
 * Idempotent across repeated calls (e.g. every server boot): once an
 * outcome_unknown has been appended for an intent, that intent no longer
 * matches findUnsettledDispatchIntents() on a subsequent call, so it is
 * never reconciled twice.
 *
 * Returns the number of intents reconciled this call (0 is not a failure,
 * it means nothing was unsettled).
 */
export async function reconcileUnsettledDispatchIntents(
  store: EnvelopeStore,
  olderThanMs: number,
  logger?: Logger
): Promise<number> {
  const unsettled = await store.findUnsettledDispatchIntents(olderThanMs);

  for (const record of unsettled) {
    const payload = record.envelope.payload as {
      nodeId?: string;
      execId?: string;
      inputDigest?: string;
    };
    const outcomeEnv = envelopeFactory.create({
      to: 'quox.audit',
      type: 'event',
      intent: Intents.DISPATCH.OUTCOME_UNKNOWN,
      corr: record.envelope.corr,
      payload: {
        nodeId: payload.nodeId,
        execId: payload.execId,
        corr: record.envelope.id,
        inputDigest: payload.inputDigest,
      },
    });
    await store.append(outcomeEnv, record.orgId ?? SYSTEM_SCOPE);
  }

  if (unsettled.length > 0) {
    logger?.warn(
      `Recorded outcome_unknown for ${unsettled.length} unsettled dispatch intent(s) from a prior crash, the effect may or may not have fired; it was NOT re-run`,
      { count: unsettled.length }
    );
  }

  return unsettled.length;
}
