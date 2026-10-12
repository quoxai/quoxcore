/**
 * Pure geometry helpers for the Timeline's edit-mode pointer interactions
 * (stretch a bar's right edge to re-estimate effort). No DOM, no fetching —
 * kept separate from TimelineView so it's cheaply testable.
 */

const MIN_EFFORT_DAYS = 1;

/**
 * Converts a horizontal drag delta (in pixels, at the chart's current zoom)
 * into a new whole-day effort estimate, snapped to whole days and floored at
 * `MIN_EFFORT_DAYS` so a stream can never be dragged to zero/negative effort.
 */
export function effortDaysFromDrag(originalDays, deltaPx, pxPerDay) {
  if (!pxPerDay) return Math.max(MIN_EFFORT_DAYS, Math.round(originalDays ?? MIN_EFFORT_DAYS));
  const deltaDays = deltaPx / pxPerDay;
  const raw = (originalDays ?? 0) + deltaDays;
  return Math.max(MIN_EFFORT_DAYS, Math.round(raw));
}
