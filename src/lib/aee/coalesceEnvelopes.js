/**
 * coalesceEnvelopes — QOBS-1c
 *
 * One chat turn emits 26+ envelopes, many of them consecutive repeats of
 * the same intent (per-node aocl.layer.* events, tool invoke/complete
 * triples, agent thinking steps). This pure function collapses runs of
 * consecutive same-intent envelopes into a single coalesced row carrying
 * a ×N count, so the detail chain can render one row instead of N and
 * let the user expand it to see the individual envelopes.
 *
 * Only ADJACENT envelopes are merged — a non-consecutive repeat of the
 * same intent starts a new group. This preserves chronological ordering
 * exactly as it appears in the input list.
 */

/**
 * @typedef {Object} CoalescedGroup
 * @property {string} key - Stable React key, derived from the first
 *   envelope's id in the group. Stable across re-renders of the same
 *   underlying data regardless of expand/collapse state.
 * @property {string} intent - The shared intent of every envelope in the group.
 * @property {Array<object>} envelopes - The original envelopes, in order.
 * @property {number} count - envelopes.length (>= 1).
 */

/**
 * @param {Array<object>} list - Envelopes in chronological order.
 * @returns {CoalescedGroup[]}
 */
export function coalesceEnvelopes(list = []) {
  const groups = []
  let current = null

  for (const env of list) {
    if (!env) continue

    if (current && current.intent === env.intent) {
      current.envelopes.push(env)
      continue
    }

    current = {
      key: env.id != null ? String(env.id) : `idx-${groups.length}`,
      intent: env.intent,
      envelopes: [env],
    }
    groups.push(current)
  }

  return groups.map((g) => ({ ...g, count: g.envelopes.length }))
}
