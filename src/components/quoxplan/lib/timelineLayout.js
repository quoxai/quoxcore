/**
 * Pure geometry/layout helpers for the Timeline (Gantt) view. No DOM, no
 * fetching — everything here takes the server's already-scheduled timeline
 * array (`{ id, name, parent_id, start_offset_days, end_offset_days, ... }`,
 * see server/src/domain/streams.js#getTimeline) and turns it into row order
 * and pixel geometry. Kept separate from components so it's cheaply testable.
 */

export const ZOOM_PRESETS = {
  compact: { key: 'compact', label: 'Compact', pxPerDay: 4 },
  normal: { key: 'normal', label: 'Normal', pxPerDay: 10 },
  wide: { key: 'wide', label: 'Wide', pxPerDay: 22 }
};

export const DEFAULT_ROW_HEIGHT = 36;

/**
 * Continuous zoom range (owner feedback 2026-07-25 wave 2, item 8): replaces
 * the three fixed presets above with a slider from MIN to MAX px/day, plus a
 * Fit-to-width mode that can go below MIN for very long roadmaps.
 */
export const MIN_PX_PER_DAY = 0.5;
export const MAX_PX_PER_DAY = 24;

/** Below this scale every bar label overlaps its neighbours ("text soup"). */
export const BAR_LABEL_MIN_PX_PER_DAY = 3;

/**
 * Fit-to-width: pxPerDay so the whole roadmap span (day 0..maxDay) fits
 * inside the available chart width, floored at MIN_PX_PER_DAY so an
 * extremely long roadmap still renders a visible sliver per day rather than
 * collapsing toward zero. Falls back to MIN_PX_PER_DAY if the container
 * hasn't been measured yet (width <= 0).
 */
export function computeFitPxPerDay(containerWidthPx, maxDay) {
  const span = Math.max(1, maxDay ?? 0);
  const width = Math.max(0, containerWidthPx ?? 0);
  if (width <= 0) return MIN_PX_PER_DAY;
  return Math.max(MIN_PX_PER_DAY, width / span);
}

/**
 * In-bar/outside bar name labels are suppressed below
 * BAR_LABEL_MIN_PX_PER_DAY to avoid text soup at low zoom, except for the
 * row currently hovered (`hovered = true`), which always shows its label.
 */
export function shouldShowBarLabel(pxPerDay, hovered = false) {
  return hovered || pxPerDay >= BAR_LABEL_MIN_PX_PER_DAY;
}

/**
 * Groups the flat timeline list into display rows: root streams (no
 * parent, or an orphaned parent_id not present in this set) ordered by
 * start_offset_days then priority, each immediately followed by its
 * (recursively) nested substreams in the same order, indented one level
 * per depth. A collapsed parent's descendants are omitted from the
 * returned array but still counted in `childCount`.
 *
 * Returns an array of row descriptors:
 *   { ...originalItem, depth, parentId, hasChildren, childCount, collapsed }
 */
export function computeRowOrder(timeline, collapsedIds = new Set()) {
  const byId = new Map(timeline.map((item) => [item.id, item]));
  const childrenOf = new Map();
  for (const item of timeline) {
    const hasParent = item.parent_id != null && byId.has(item.parent_id);
    const key = hasParent ? item.parent_id : null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(item);
  }

  const byStartThenPriority = (a, b) => {
    const diff = (a.start_offset_days ?? 0) - (b.start_offset_days ?? 0);
    if (diff !== 0) return diff;
    return (a.priority ?? 0) - (b.priority ?? 0);
  };

  for (const list of childrenOf.values()) list.sort(byStartThenPriority);

  function countDescendants(id) {
    const kids = childrenOf.get(id) || [];
    let count = kids.length;
    for (const kid of kids) count += countDescendants(kid.id);
    return count;
  }

  const rows = [];
  function pushLevel(id, depth) {
    const kids = childrenOf.get(id) || [];
    for (const item of kids) {
      const ownChildren = childrenOf.get(item.id) || [];
      const collapsed = collapsedIds.has(item.id);
      rows.push({
        ...item,
        depth,
        parentId: id,
        hasChildren: ownChildren.length > 0,
        childCount: countDescendants(item.id),
        collapsed
      });
      if (!collapsed) pushLevel(item.id, depth + 1);
    }
  }
  pushLevel(null, 0);
  return rows;
}

/** Day offset -> pixel x. */
export function dayToX(day, pxPerDay) {
  return (day ?? 0) * pxPerDay;
}

/**
 * Weekly gridlines from day 0 to (at least) maxDay, labeled W1, W2, ...
 * Always includes a leading W1 at day 0.
 */
export function weekGridlines(maxDay, pxPerDay) {
  const lines = [];
  const lastDay = Math.max(0, maxDay ?? 0);
  // Long imported roadmaps span hundreds of weeks; keep labels legible by
  // labelling only every Nth gridline. Labels render as 'W12 . d77' (~70px wide), so keep at least 84px between labelled lines.
  const weekPx = 7 * pxPerDay;
  const labelEvery = Math.max(1, Math.ceil(84 / Math.max(weekPx, 1)));
  for (let day = 0, week = 1; day <= lastDay; day += 7, week += 1) {
    const labelled = (week - 1) % labelEvery === 0;
    lines.push({ day, x: dayToX(day, pxPerDay), label: labelled ? `W${week}` : '' });
  }
  return lines;
}

/**
 * Pixel rectangle for a single bar. `rowIndex` is the row's position in the
 * ordered row list (see computeRowOrder). Width is floored at 2px so
 * zero/near-zero-effort streams still render a visible sliver.
 */
export function barRect(item, { pxPerDay, rowHeight = DEFAULT_ROW_HEIGHT, rowIndex, rowPad = 6 }) {
  const start = item.start_offset_days ?? 0;
  const end = item.end_offset_days ?? start;
  const x = dayToX(start, pxPerDay);
  const width = Math.max(2, dayToX(end - start, pxPerDay));
  const y = rowIndex * rowHeight + rowPad;
  const height = rowHeight - rowPad * 2;
  return { x, y, width, height };
}

/** Vertical mid-point of a row, for connector anchoring. */
export function rowMidY(rowIndex, rowHeight = DEFAULT_ROW_HEIGHT) {
  return rowIndex * rowHeight + rowHeight / 2;
}

/**
 * SVG path `d` string for an elbow connector from the end of a dependency's
 * bar to the start of the dependent's bar: out horizontally from the source,
 * a vertical jog at the midpoint, then horizontal into the target.
 */
export function connectorElbowPath(from, to) {
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}
