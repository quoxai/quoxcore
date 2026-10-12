/**
 * Formats the 422 `{ error, cycle }` payload the dependency-mutating
 * endpoints (`PATCH /streams/:id`, timeline dependency-edge drops) return
 * when a proposed `depends_on` edge would create a cycle, into the
 * house-style inline message: "would create a cycle: A > B > A".
 */
export function formatCycleError(cycle) {
  if (!cycle || cycle.length === 0) return 'would create a cycle';
  return `would create a cycle: ${cycle.join(' > ')}`;
}
