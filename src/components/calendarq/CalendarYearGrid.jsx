/**
 * CalendarYearGrid — Calendar-Q Year view (AQ-9B design pass PASS 2,
 * familiarity fix 3).
 *
 * 12 mini-month grids (4x3), the current month visually distinct. Each mini
 * day gets a density dot when it has occurrences: the layer colour for a
 * "busy human" day (any occurrence from a non-workflow_cron layer), a dim
 * neutral dot for a machine-only day (every occurrence that day is a
 * workflow_cron firing). Clicking a mini-month switches the caller to Month
 * view anchored on that month — but only when it is in coverage. This is
 * presentation ONLY over the overlay CalendarTab already fetched for its
 * clash-check window (7 days back / 30 forward): it never widens that
 * fetch, so a month mostly or entirely outside the window renders dimmed
 * and non-navigable with the same hatch language CalendarGrid uses for an
 * out-of-coverage day — never as confidently empty.
 */
import { useMemo } from 'react';
import {
  buildMonthDays, cellKey, rangeOverlapsWindow,
} from './calendarGridDates.js';
import { localDateKey } from './occurrenceDisplay.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1);
  const endExclusive = new Date(year, monthIndex + 1, 1);
  return { start, endExclusive };
}

export default function CalendarYearGrid({
  anchorDate, occurrences, layerById, todayDate, windowStartDate, windowEndDateExclusive, onOpenMonth,
}) {
  const year = anchorDate.getFullYear();
  const todayKey = useMemo(() => cellKey(todayDate), [todayDate]);
  const currentMonthKey = `${todayDate.getFullYear()}-${todayDate.getMonth()}`;

  // Keyed by start day only (not full multi-day span) — a density overview,
  // not a literal per-day event list, so this stays a cheap presentation
  // pass over data CalendarGrid's own expansion already renders in full.
  const occsByDate = useMemo(() => {
    const map = new Map();
    for (const occ of occurrences) {
      const key = occ.allDay && occ.dateOnlyStart ? occ.dateOnlyStart : localDateKey(occ.startTs, occ.timezone);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(occ);
    }
    return map;
  }, [occurrences]);

  function densityForDay(key) {
    const occs = occsByDate.get(key);
    if (!occs || occs.length === 0) return null;
    const humanOcc = occs.find((o) => layerById.get(o.layerId)?.kind !== 'workflow_cron');
    if (humanOcc) return layerById.get(humanOcc.layerId)?.color || '#999';
    return 'machine';
  }

  return (
    <div className="cq-year-grid" data-testid="calendarq-year-grid">
      {MONTH_NAMES.map((name, monthIndex) => {
        const { start, endExclusive } = monthRange(year, monthIndex);
        const covered = rangeOverlapsWindow(start, endExclusive, windowStartDate, windowEndDateExclusive);
        const isCurrentMonth = `${year}-${monthIndex}` === currentMonthKey;
        const days = buildMonthDays(start);
        const monthLabel = `${name} ${year}`;

        return (
          <button
            type="button"
            key={name}
            className={`cq-mini-month${isCurrentMonth ? ' cq-mini-month--current' : ''}${covered ? '' : ' cq-mini-month--uncovered'}`}
            data-testid={`calendarq-mini-month-${year}-${String(monthIndex + 1).padStart(2, '0')}`}
            disabled={!covered}
            onClick={() => onOpenMonth(start)}
            title={covered ? `Open ${monthLabel} in Month view` : `${monthLabel} is outside the checked window`}
          >
            <div className="cq-mini-month__title">{name}</div>
            <div className="cq-mini-month__grid">
              {days.map((d) => {
                const inMonth = d.getMonth() === monthIndex;
                const key = cellKey(d);
                const isToday = key === todayKey;
                const density = inMonth ? densityForDay(key) : null;
                return (
                  <div
                    key={key}
                    className={`cq-mini-day${inMonth ? '' : ' cq-mini-day--outside'}${isToday ? ' cq-mini-day--today' : ''}`}
                  >
                    <span className="cq-mini-day__num">{d.getDate()}</span>
                    {density && (
                      <span
                        aria-hidden="true"
                        className={`cq-mini-day__dot${density === 'machine' ? ' cq-mini-day__dot--machine' : ''}`}
                        style={density === 'machine' ? undefined : { background: density }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
}
