/**
 * activityEmptyState.js — QOBS-1e follow-up
 *
 * Pure helpers so the Activity Centre never shows a misleading "no data"
 * message when data exists but is merely hidden by the current filters,
 * and never shows a stat number that is mathematically impossible.
 */

// ACTIVITY-TABS-2: per-tab "genuine empty" copy. Each log-type family has
// its own meaning of "nothing here yet" — a generic "start a conversation"
// message is misleading on, say, the Workflows or Governance tab where the
// user never "starts a conversation" at all.
const TAB_EMPTY_COPY = {
  chats: {
    title: 'No agent conversations yet',
    message: 'Start a chat with an agent to see it here',
  },
  objectives: {
    title: 'No objectives yet',
    message: 'Objectives created by agents will appear here',
  },
  workflows: {
    title: 'No workflow runs',
    message: 'Workflow executions will appear here once one runs',
  },
  governance: {
    title: 'No governance activity',
    message: 'Policy checks and anomaly detections will appear here',
  },
  tools: {
    title: 'No tool executions',
    message: 'Tool calls made by agents will appear here',
  },
  rooms: {
    title: 'No room activity',
    message: 'Matrix room-DAG receipts and agent turns will appear here',
  },
  system: {
    title: 'No system activity',
    message: 'Infrastructure and session events will appear here',
  },
}

const DEFAULT_EMPTY_COPY = {
  title: 'No activity yet',
  message: 'Start a conversation to see messages here',
}

/**
 * Decide what empty-state copy to show for the conversation list.
 *
 * - `visibleCount > 0`  -> no empty state needed (caller should render the list).
 * - `visibleCount === 0 && totalCount === 0` -> genuinely no activity at all
 *   (per-tab copy — see TAB_EMPTY_COPY).
 * - `visibleCount === 0 && totalCount > 0`   -> everything is filtered out;
 *   today's signal-first default lens (or another active filter) is hiding
 *   real conversations. Say so honestly and offer a one-click way out.
 *
 * @param {{visibleCount: number, totalCount: number, tab?: string}} args
 * @returns {null | { kind: 'genuine'|'filtered', title: string, message: string, hiddenCount?: number }}
 */
export function getEmptyStateInfo({ visibleCount, totalCount, tab }) {
  if (visibleCount > 0) return null

  const total = Number.isFinite(totalCount) ? totalCount : 0

  if (total <= 0) {
    const copy = TAB_EMPTY_COPY[tab] || DEFAULT_EMPTY_COPY
    return {
      kind: 'genuine',
      title: copy.title,
      message: copy.message,
    }
  }

  return {
    kind: 'filtered',
    hiddenCount: total,
    title: 'No signal activity in the selected filters',
    message: `${total.toLocaleString()} conversation${total === 1 ? '' : 's'} hidden (mostly agent/system events). Adjust filters or include infrastructure events to see them.`,
  }
}

/**
 * Decide the envelope count to display in the header stat block.
 *
 * Every conversation has at least one envelope, so a correct envelope
 * total can never be lower than the conversation total. If it is, the
 * envelope figure came from a stale/partial source (e.g. the local
 * IndexedDB fallback used when the server `/aee/stats` call times out or
 * fails) — display it as unavailable rather than a self-contradicting
 * number that reads as backwards to the user.
 *
 * @param {number|null|undefined} totalEnvelopes
 * @param {number|null|undefined} conversationsTotal
 * @returns {number|null}
 */
export function getEnvelopeDisplayValue(totalEnvelopes, conversationsTotal) {
  if (typeof totalEnvelopes !== 'number' || Number.isNaN(totalEnvelopes)) return null
  if (typeof conversationsTotal === 'number' && !Number.isNaN(conversationsTotal) &&
      totalEnvelopes < conversationsTotal) {
    return null
  }
  return totalEnvelopes
}
