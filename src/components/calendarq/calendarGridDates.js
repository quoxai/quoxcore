/**
 * calendarGridDates — pure date/grid arithmetic shared by CalendarGrid.jsx
 * (month/week body), CalendarYearGrid.jsx (12 mini-months), and
 * CalendarNavRow.jsx (the single unified nav row, AQ-9B design pass PASS 2).
 * No React here — a leaf module so the date math is testable in isolation
 * from rendering, and so three consumers never carry three copies of it.
 */

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** First-of-month, n months from d's month/year (drops the day-of-month —
 * matches the original CalendarGrid behaviour: navigating by month always
 * lands the anchor on the 1st). */
export function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** Same month, n years away (year-view stepping never needs day-of-month). */
export function addYears(d, n) {
  return new Date(d.getFullYear() + n, d.getMonth(), 1);
}

export function cellKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function mondayOnOrBefore(d) {
  const x = startOfDay(d);
  const dow = x.getDay(); // 0 Sun .. 6 Sat
  const diff = dow === 0 ? 6 : dow - 1;
  return addDays(x, -diff);
}

export function buildMonthDays(anchorDate) {
  const first = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const gridStart = mondayOnOrBefore(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function buildWeekDays(anchorDate) {
  const start = mondayOnOrBefore(anchorDate);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function rangeOverlapsWindow(rangeStart, rangeEndExclusive, windowStart, windowEndExclusive) {
  return rangeStart < windowEndExclusive && windowStart < rangeEndExclusive;
}

export function dateKeyAddDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  return cellKey(new Date(y, m - 1, d + delta));
}

/** The visible date range a mode (month/week) renders for a given anchor —
 * used to decide whether stepping prev/next would land entirely outside the
 * fetched coverage window (year mode never gates on this; see
 * CalendarNavRow). */
export function viewRangeFor(mode, candidateAnchor) {
  const days = mode === 'week' ? buildWeekDays(candidateAnchor) : buildMonthDays(candidateAnchor);
  return { start: days[0], endExclusive: addDays(days[days.length - 1], 1) };
}

export function weekLabel(anchorDate) {
  const days = buildWeekDays(anchorDate);
  return `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
