/**
 * CalendarNavRow — the single unified "row 1" of the Calendar-Q calendar
 * face (AQ-9B design pass PASS 2, familiarity fix 1).
 *
 * Replaces the old stack of five separate rows (coverage paragraph, layer
 * chips, clash sentence, mode row, month-nav row) with ONE slim row: month
 * title + prev/Today/next on the left, the view-mode seg + coverage pill
 * (passed in as `right`) on the right. Layer chips stay a second row,
 * rendered by the caller (CalendarTab) below this one.
 *
 * Mode-aware stepping: month/week step by month/week and respect the
 * existing out-of-coverage-window disable (unchanged behaviour); year steps
 * by year and is never disabled — Year view is presentation-only over
 * already-fetched data, individual out-of-window months render dimmed
 * inside CalendarYearGrid rather than blocking the whole year from paging.
 * Agenda has no date-range concept, so the row collapses to just a label
 * (no prev/today/next) plus whatever `right` content is passed.
 */
import {
  addDays, addMonths, addYears, viewRangeFor, rangeOverlapsWindow, weekLabel,
} from './calendarGridDates.js';

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export default function CalendarNavRow({
  mode, anchorDate, onAnchorChange, todayDate, windowStartDate, windowEndDateExclusive, right,
}) {
  if (mode === 'agenda') {
    return (
      <div className="qx-row qx-row--apart cq-nav-row" data-testid="calendarq-nav-row">
        <strong className="cq-grid-label">Agenda</strong>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>{right}</div>
      </div>
    );
  }

  const prevCandidate = mode === 'week' ? addDays(anchorDate, -7) : mode === 'year' ? addYears(anchorDate, -1) : addMonths(anchorDate, -1);
  const nextCandidate = mode === 'week' ? addDays(anchorDate, 7) : mode === 'year' ? addYears(anchorDate, 1) : addMonths(anchorDate, 1);

  let prevDisabled = false;
  let nextDisabled = false;
  if (mode !== 'year') {
    const prevRange = viewRangeFor(mode, prevCandidate);
    const nextRange = viewRangeFor(mode, nextCandidate);
    prevDisabled = !rangeOverlapsWindow(prevRange.start, prevRange.endExclusive, windowStartDate, windowEndDateExclusive);
    nextDisabled = !rangeOverlapsWindow(nextRange.start, nextRange.endExclusive, windowStartDate, windowEndDateExclusive);
  }

  const label = mode === 'week'
    ? weekLabel(anchorDate)
    : mode === 'year'
      ? String(anchorDate.getFullYear())
      : anchorDate.toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div className="qx-row qx-row--apart cq-nav-row" data-testid="calendarq-nav-row">
      {/* NotesQ look rule 3: colour lives in the controls, grouped by
          meaning — date navigation is one tinted tool group (sky). The
          view-mode seg in `right` stays plain: tint means "tool", not
          "state". */}
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <strong className="cq-grid-label">{label}</strong>
        <div className="qx-seg qx-seg--tint qx-tint--sky" role="group" aria-label="Date navigation">
          <button type="button" className="qx-seg__btn qx-tint__btn" onClick={() => onAnchorChange(prevCandidate)} disabled={prevDisabled} aria-label="Previous">
            <ChevronLeftIcon />
          </button>
          <button type="button" className="qx-seg__btn qx-tint__btn" onClick={() => onAnchorChange(todayDate)}>Today</button>
          <button type="button" className="qx-seg__btn qx-tint__btn" onClick={() => onAnchorChange(nextCandidate)} disabled={nextDisabled} aria-label="Next">
            <ChevronRightIcon />
          </button>
        </div>
      </div>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>{right}</div>
    </div>
  );
}
