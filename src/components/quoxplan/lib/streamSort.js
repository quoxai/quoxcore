/**
 * Pure sort helper for the Streams table column-header sorting (owner
 * feedback 2026-07-25 wave 2, item 7). Mirrors the click-a-header-to-sort
 * pattern already used by ToolAuditTable (src/components/library/
 * ToolAuditTable.jsx SortTh/sortRows) so the interaction is recognisable
 * elsewhere in the dashboard. No DOM here — just data in, sorted data out.
 */

const STATUS_ORDER = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DECISION_NEEDED', 'COMPLETE'];

export const STREAM_SORT_COLUMNS = ['id', 'name', 'tier', 'status', 'priority', 'effort'];

function compareBy(key, a, b) {
  if (key === 'status') {
    return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  }
  if (key === 'tier' || key === 'priority') {
    return (a[key] ?? 0) - (b[key] ?? 0);
  }
  const av = String(a[key] ?? '');
  const bv = String(b[key] ?? '');
  return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sorts a flat stream list by column key/direction. Stable (relies on
 * Array.prototype.sort's stability; direction is applied by flipping the
 * comparator sign rather than reversing the sorted array, so ties keep their
 * original relative order in both directions), never mutates the input.
 */
export function sortStreams(streams, key, dir = 'asc') {
  const mult = dir === 'desc' ? -1 : 1;
  return [...streams].sort((a, b) => mult * compareBy(key, a, b));
}
