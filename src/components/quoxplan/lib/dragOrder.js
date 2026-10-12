/**
 * Pure drag-and-drop order computation for the Board view's pointer-based
 * reorder (no external DnD library). No DOM, no fetching — components pass
 * in plain id arrays and get back the new order to POST to
 * /api/v1/roadmaps/:id/reprioritise.
 */

/**
 * Moves the item at `fromIndex` to `toIndex` within `ids`, returning a new
 * array (never mutates the input). A no-op (same array contents, new
 * reference) when the indices are equal or out of range.
 */
export function reorderList(ids, fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= ids.length ||
    toIndex < 0
  ) {
    return ids.slice();
  }
  const next = ids.slice();
  const [moved] = next.splice(fromIndex, 1);
  const clampedTo = Math.min(toIndex, next.length);
  next.splice(clampedTo, 0, moved);
  return next;
}

/**
 * Given the Board's column groups (each an ordered array of top-level stream
 * ids, columns in their current display order) and a single drag move,
 * returns the new flattened top-level priority order for the whole roadmap
 * (columns concatenated in the same column order) — the exact shape
 * `POST /roadmaps/:id/reprioritise` expects for `order`.
 *
 * Covers both same-column reorder (fromColumnIndex === toColumnIndex) and
 * cross-column drops (e.g. dragging a card into another status column).
 * When `toItemIndex` is omitted the item is appended to the end of the
 * target column.
 */
export function computeBoardReorder(columns, move) {
  const { fromColumnIndex, fromItemIndex, toColumnIndex, toItemIndex } = move;
  const next = columns.map((col) => col.slice());
  const [movedId] = next[fromColumnIndex].splice(fromItemIndex, 1);
  const targetCol = next[toColumnIndex];
  const insertAt = toItemIndex == null ? targetCol.length : Math.min(toItemIndex, targetCol.length);
  targetCol.splice(insertAt, 0, movedId);
  return next.flat();
}
