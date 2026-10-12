/**
 * CalendarGrid — the Calendar-Q month/week grid BODY (AQ-9B design pass;
 * nav row extracted to CalendarNavRow.jsx in PASS 2).
 *
 * Pure presentation over data CalendarTab already fetched (overlay +
 * clashes) — no data fetching of its own. Monday-first month matrix (6
 * rows) or a single 7-column week row, previous/next-month days dimmed,
 * today's day number ringed in a filled accent circle, out-of-coverage days
 * hatched (never rendered as confidently empty).
 *
 * Day-cell density (PASS 2, familiarity fix 2): all-day occurrences render
 * as a full-width tinted title bar at the cell top, never as a chip line.
 * Timed occurrences render as a single slim line — colour dot + mono HH:mm
 * + title, no pill background — and same-layer, same-title repeats (cron
 * heartbeats) collapse into ONE line with an "x N" count rather than
 * flooding the cell. Max 3 lines, then a "+N more" flyout built from the
 * same OccurrenceCard/ClashBadge the agenda list uses.
 *
 * `todayDate` is passed in by CalendarTab rather than read from `new Date()`
 * here, so "today" is a single resolved value shared with the Agenda view's
 * anchor and is injectable in tests without mocking the system clock.
 */
import { useMemo, useState } from 'react';
import {
  localDateKey, formatDateHeading, ClashBadge, OccurrenceCard,
} from './occurrenceDisplay.jsx';
import {
  buildMonthDays, buildWeekDays, cellKey, dateKeyAddDays,
} from './calendarGridDates.js';

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MAX_VISIBLE_LINES = 3;

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** Every local date key an occurrence covers. All-day/multi-day events get
 * one chip per covered day (no spanning bars in this pass); timed events
 * render on their start day only. */
function expandOccurrenceDateKeys(occ) {
  if (occ.allDay && occ.dateOnlyStart) {
    const startKey = occ.dateOnlyStart;
    const endKey = typeof occ.endTs === 'number' ? new Date(occ.endTs).toISOString().slice(0, 10) : startKey;
    const keys = [];
    let cur = startKey;
    let guard = 0;
    while (cur < endKey && guard < 370) {
      keys.push(cur);
      cur = dateKeyAddDays(cur, 1);
      guard += 1;
    }
    if (keys.length === 0) keys.push(startKey);
    return keys;
  }
  return [localDateKey(occ.startTs, occ.timezone)];
}

/** Groups a day's timed occurrences into display lines: one line per
 * occurrence normally, but same-layer + same-title repeats (cron
 * heartbeats firing many times a day) collapse into a single line carrying
 * an "x N" count instead of one chip each (the exact flood this pass kills
 * — a day that used to show "+47 more" now shows one collapsed line). */
function buildDayLines(timedOccs) {
  const order = [];
  const groups = new Map();
  for (const occ of timedOccs) {
    const groupKey = `${occ.layerId}::${occ.title || ''}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey).push(occ);
  }
  return order.map((groupKey) => {
    const occs = groups.get(groupKey);
    return { key: groupKey, occs, collapsed: occs.length > 1 };
  });
}

export default function CalendarGrid({
  mode, anchorDate, occurrences, layerById,
  clashByOccurrenceKey, occurrenceByKey, windowStartDate, windowEndDateExclusive,
  todayDate,
}) {
  const [openDateKey, setOpenDateKey] = useState(null);

  const todayKey = useMemo(() => cellKey(todayDate), [todayDate]);
  const days = useMemo(
    () => (mode === 'week' ? buildWeekDays(anchorDate) : buildMonthDays(anchorDate)),
    [mode, anchorDate],
  );

  const occurrencesByDate = useMemo(() => {
    const map = new Map();
    for (const occ of occurrences) {
      for (const key of expandOccurrenceDateKeys(occ)) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(occ);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startTs - b.startTs;
      });
    }
    return map;
  }, [occurrences]);

  return (
    <div className="cq-grid-wrap" data-testid="calendarq-calendar-grid">
      <div className="cq-weekday-row">
        {WEEKDAY_LABELS.map((w) => (<div key={w} className="cq-weekday">{w}</div>))}
      </div>

      <div className={`cq-grid cq-grid--${mode}`}>
        {days.map((date) => {
          const key = cellKey(date);
          const isToday = key === todayKey;
          const inAnchorMonth = mode === 'week' || date.getMonth() === anchorDate.getMonth();
          const uncovered = date < windowStartDate || date >= windowEndDateExclusive;
          const dayOccs = occurrencesByDate.get(key) || [];
          const allDayOccs = dayOccs.filter((o) => o.allDay);
          const timedOccs = dayOccs.filter((o) => !o.allDay);
          const lines = buildDayLines(timedOccs);
          const visibleLines = lines.slice(0, MAX_VISIBLE_LINES);
          const overflowCount = lines.length - visibleLines.length;
          const isOpen = openDateKey === key;

          return (
            <div
              key={key}
              className={`cq-day${isToday ? ' cq-day--today' : ''}${inAnchorMonth ? '' : ' cq-day--outside'}${uncovered ? ' cq-day--uncovered' : ''}`}
              data-testid={`calendarq-day-${key}`}
              data-today={isToday ? 'true' : 'false'}
              data-uncovered={uncovered ? 'true' : 'false'}
            >
              {allDayOccs.length > 0 && (
                <div className="cq-day__allday">
                  {allDayOccs.map((occ) => {
                    const layer = layerById.get(occ.layerId);
                    return (
                      <div
                        key={occ.occurrenceKey}
                        className="cq-day__allday-bar"
                        style={{ background: layer?.color ? `color-mix(in srgb, ${layer.color} 38%, transparent)` : 'rgba(255,255,255,0.14)' }}
                        title={occ.title || '(untitled)'}
                        data-testid="calendarq-day-allday-bar"
                      >
                        <span className="cq-day__allday-title">{occ.title || '(untitled)'}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className={`cq-day__num${isToday ? ' cq-day__num--today' : ''}`}>{date.getDate()}</div>
              <div className="cq-day__chips">
                {visibleLines.map((line) => {
                  const representative = line.occs[0];
                  const layer = layerById.get(representative.layerId);
                  const anyClash = line.occs.find((o) => clashByOccurrenceKey.get(o.occurrenceKey));
                  return (
                    <div
                      key={line.key}
                      className="cq-day-line"
                      title={representative.title || '(untitled)'}
                      data-testid="calendarq-day-line"
                    >
                      <span aria-hidden="true" className="cq-day-line__dot" style={{ background: layer?.color || '#999' }} />
                      {!line.collapsed && (
                        <span className="cq-day-line__time">{new Date(representative.startTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: representative.timezone || undefined })}</span>
                      )}
                      <span className="cq-day-line__title">
                        {line.collapsed ? `${representative.title || '(untitled)'} x${line.occs.length}` : (representative.title || '(untitled)')}
                      </span>
                      {anyClash && <ClashBadge clash={clashByOccurrenceKey.get(anyClash.occurrenceKey)} occurrenceByKey={occurrenceByKey} />}
                    </div>
                  );
                })}
                {overflowCount > 0 && (
                  <button
                    type="button"
                    className="cq-day-line cq-day-line--more"
                    onClick={() => setOpenDateKey(isOpen ? null : key)}
                    data-testid={`calendarq-day-more-${key}`}
                  >
                    {`+${overflowCount} more`}
                  </button>
                )}
              </div>

              {isOpen && (
                <>
                  <div className="cq-day-flyout-backdrop" onClick={() => setOpenDateKey(null)} />
                  <div className="qx-card qx-surface--backed cq-day-flyout" data-testid={`calendarq-day-flyout-${key}`}>
                    <div className="qx-row qx-row--apart" style={{ marginBottom: 8, alignItems: 'center' }}>
                      <strong style={{ fontSize: 13 }}>{formatDateHeading(key)}</strong>
                      <button type="button" className="qx-row-action" aria-label="Close" onClick={() => setOpenDateKey(null)}>
                        <CloseIcon />
                      </button>
                    </div>
                    <div className="qx-stack qx-stack--tight">
                      {dayOccs.map((occ) => (
                        <OccurrenceCard
                          key={occ.occurrenceKey}
                          occ={occ}
                          layer={layerById.get(occ.layerId)}
                          clash={clashByOccurrenceKey.get(occ.occurrenceKey)}
                          occurrenceByKey={occurrenceByKey}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
