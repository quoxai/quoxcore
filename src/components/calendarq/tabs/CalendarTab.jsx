/**
 * CalendarTab — the Calendar-Q calendar surface (AQ-9B design pass; PASS 2
 * familiarity fixes 2026-10-03).
 *
 * Default view is a MONTH grid (CalendarGrid.jsx) — the calendar face a
 * calendar app is expected to open on — with Year/Week/Agenda as alternate
 * modes via a segmented control. Fetches the merged overlay (every
 * connected layer) and the clash detection pass once on mount, same as
 * before. PASS 2 collapses what used to be five stacked rows above the
 * grid into two: CalendarNavRow (title + prev/Today/next + the mode seg +
 * a compact CoveragePill, all one row) and the LayerSwitcher chip row — so
 * the grid itself is the page, not a strip under a half-screen of banners.
 * No new data fetching beyond what calendarQService already exposes — this
 * stays a presentation pass over the same overlay/clashes call the
 * agenda-only phase used.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useTextSize } from '../../ui/TextSizeControl';
import { getOverlay, getClashes } from '../../../services/calendarQService';
import {
  localDateKey, formatDateHeading, OccurrenceCard,
} from '../occurrenceDisplay.jsx';
import { glyphForLayer } from '../providerGlyphs.jsx';
import CalendarGrid from '../CalendarGrid.jsx';
import CalendarYearGrid from '../CalendarYearGrid.jsx';
import CalendarNavRow from '../CalendarNavRow.jsx';

const COVERAGE_LABELS = {
  complete: (ts) => `checked ${formatTime(ts)}`,
  stale: (ts) => `stale since ${formatTime(ts)}`,
  partial: (ts) => `partially checked ${formatTime(ts)}`,
  disconnected: () => 'not connected',
  empty: (ts) => `checked ${formatTime(ts)}, nothing found`,
  unavailable: () => 'unavailable right now',
};

const CONCERNING_STATES = new Set(['disconnected', 'unavailable', 'stale', 'partial']);

const MODES = [
  { key: 'year', label: 'Year' },
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'agenda', label: 'Agenda' },
];

function formatTime(ts) {
  if (!ts) return 'unknown time';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'unknown time';
  }
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

/** CoveragePill — the compact row-1 replacement for the old full-width
 * CoverageBanner paragraph (familiarity fix 1). Shows a coloured dot per
 * layer plus the latest freshness time; click or hover expands a flyout
 * with the full per-layer detail (the old banner's text, verbatim) and the
 * clash-check window sentence that used to sit on its own row below. */
function CoveragePill({ layers, windowCoverageStatement }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(layers) || layers.length === 0) return null;

  const concerning = layers.some((l) => CONCERNING_STATES.has(l.coverage?.state));
  const freshnessTimes = layers.map((l) => l.coverage?.freshnessTs).filter((ts) => typeof ts === 'number');
  const latest = freshnessTimes.length > 0 ? Math.max(...freshnessTimes) : null;
  const summary = latest ? `checked ${formatTime(latest)}` : 'checked —';

  return (
    <span className="qx-disclosure cq-coverage-wrap">
      <button
        type="button"
        className={`qx-chip qx-chip--xs cq-coverage-pill${concerning ? ' cq-coverage-pill--warn' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        title="Layer coverage — click for per-layer detail"
        data-testid="calendarq-coverage-pill"
      >
        <span className="cq-coverage-pill__dots" aria-hidden="true">
          {layers.map((l) => (<span key={l.layerId} className="cq-coverage-pill__dot" style={{ background: l.color || '#999' }} />))}
        </span>
        {`${layers.length} layer${layers.length === 1 ? '' : 's'} · ${summary}`}
      </button>
      {open && (
        <div className="qx-card qx-card--compact qx-surface--backed cq-coverage-flyout" data-testid="calendarq-coverage-flyout">
          <div className="qx-stack qx-stack--tight">
            {layers.map((l) => {
              const state = l.coverage?.state;
              const describe = COVERAGE_LABELS[state] || (() => 'unknown');
              return (
                <div key={l.layerId} className="qx-hint qx-hint--sm">
                  <span aria-hidden="true" className="cq-coverage-pill__dot" style={{ background: l.color || '#999', marginRight: 6 }} />
                  {l.displayName} {describe(l.coverage?.freshnessTs)}
                </div>
              );
            })}
            {windowCoverageStatement && (
              <div className="qx-hint qx-hint--sm">Clash check window: {windowCoverageStatement}</div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** LayerSwitcher — provider/source glyph + per-layer colour dot + name +
 * visibility eye icon. Click anywhere on the chip toggles it.
 * TODO(AQ-9B L2-C2): no PATCH /layers route exists yet to persist visibility
 * server-side (services/collector/lib/calendarq/api.js only registers GET
 * /layers) — this toggle is view-local (filters the rendered view only)
 * until a later phase adds one. Honest about that: it never claims to save. */
function LayerSwitcher({ layers, hiddenLayerIds, onToggle }) {
  if (!Array.isArray(layers) || layers.length === 0) return null;
  return (
    <div className="qx-row qx-row--nowrap cq-layer-row" data-testid="calendarq-layer-switcher">
      {layers.map((l) => {
        const hidden = hiddenLayerIds.has(l.layerId);
        return (
          <button
            key={l.layerId}
            type="button"
            className={`qx-chip${hidden ? '' : ' qx-chip--active'}`}
            onClick={() => onToggle(l.layerId)}
            title={hidden ? `${l.displayName} hidden in this view (not saved)` : `${l.displayName} visible in this view`}
          >
            <span className="cq-layer-glyph" aria-hidden="true" style={{ opacity: hidden ? 0.4 : 1 }}>{glyphForLayer(l)}</span>
            <span aria-hidden="true" className="cq-layer-dot" style={{ background: l.color || '#999', opacity: hidden ? 0.35 : 1 }} />
            {l.displayName}
            {hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        );
      })}
    </div>
  );
}

/** AgendaList — grouped-by-day occurrence list, anchored to today: the
 * today (or next-upcoming) group scrolls into view on mount, past days stay
 * reachable by scrolling up since the fetched window already covers 7 days
 * back. */
function AgendaList({ occurrences, layerById, clashByOccurrenceKey, occurrenceByKey, todayDate }) {
  const containerRef = useRef(null);
  const todayKey = useMemo(() => localDateKey(todayDate.getTime(), undefined), [todayDate]);

  const grouped = useMemo(() => {
    const byDate = new Map();
    for (const occ of occurrences) {
      const key = localDateKey(occ.startTs, occ.timezone);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(occ);
    }
    for (const list of byDate.values()) list.sort((a, b) => a.startTs - b.startTs);
    return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [occurrences]);

  useEffect(() => {
    if (!containerRef.current || grouped.length === 0) return;
    const target = grouped.find(([key]) => key >= todayKey) || grouped[grouped.length - 1];
    const el = containerRef.current.querySelector(`[data-date-heading="${target[0]}"]`);
    el?.scrollIntoView?.({ block: 'start' });
  }, [grouped, todayKey]);

  if (occurrences.length === 0) {
    return (
      <div className="qx-empty" data-testid="calendarq-agenda-empty">
        <div className="qx-empty__title">Nothing in this window</div>
        <div className="qx-empty__body">No visible layer has an occurrence in the current window, or every visible layer is hidden above.</div>
      </div>
    );
  }

  return (
    <div className="qx-stack qx-stack--tight" data-testid="calendarq-agenda-list" ref={containerRef}>
      {grouped.map(([dateKey, occs]) => (
        <div key={dateKey} className="qx-stack qx-stack--tight">
          <span className="qx-section-title" data-date-heading={dateKey} data-today={dateKey === todayKey ? 'true' : 'false'}>{formatDateHeading(dateKey)}</span>
          {occs.map((occ) => (
            <OccurrenceCard
              key={occ.occurrenceKey}
              occ={occ}
              layer={layerById.get(occ.layerId)}
              clash={clashByOccurrenceKey.get(occ.occurrenceKey)}
              occurrenceByKey={occurrenceByKey}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function CalendarTab({ onOverlayLoaded, now }) {
  const { authFetch } = useAuth();
  const [overlay, setOverlay] = useState(null);
  const [clashes, setClashes] = useState([]);
  const [windowCoverageStatement, setWindowCoverageStatement] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hiddenLayerIds, setHiddenLayerIds] = useState(() => new Set());
  const [mode, setMode] = useState('month');
  // NotesQ look rule 8: the reader controls their reading. Zoom applies to
  // the slate (the calendar face) only — chrome and toolbars do not scale.
  const [zoom, textSize] = useTextSize('quox.calendarq.textZoom');

  // `now` is an optional injected clock (tests only — production never
  // passes it, so this resolves to the real "today" exactly once per mount,
  // same as before). Both the grid's today-ring and the agenda's anchor
  // read from this single resolved value, so they always agree.
  const todayDate = useMemo(() => startOfDay(now || new Date()), [now]);
  const [anchorDate, setAnchorDate] = useState(() => todayDate);

  // The server's default overlay/clashes window (no explicit date params
  // passed below) is 7 days back / 30 days forward from today — mirrored
  // here client-side purely to mark grid days outside that window as
  // "not covered" rather than confidently empty.
  const windowBounds = useMemo(() => {
    const start = new Date(todayDate);
    start.setDate(todayDate.getDate() - 7);
    const endExclusive = new Date(todayDate);
    endExclusive.setDate(todayDate.getDate() + 30);
    return { start, endExclusive };
  }, [todayDate]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getOverlay(authFetch), getClashes(authFetch)])
      .then(([overlayRes, clashRes]) => {
        setOverlay(overlayRes);
        setClashes(clashRes.clashes || []);
        setWindowCoverageStatement(clashRes.windowCoverageStatement || '');
        onOverlayLoaded?.(overlayRes, clashRes.clashes || []);
      })
      .catch((e) => setError(e.message || 'Could not load the calendar overlay.'))
      .finally(() => setLoading(false));
  }, [authFetch, onOverlayLoaded]);

  useEffect(() => { load(); }, [load]);

  const layers = overlay?.layers || [];
  const layerById = useMemo(() => new Map(layers.map((l) => [l.layerId, l])), [layers]);
  const visibleOccurrences = useMemo(
    () => (overlay?.occurrences || []).filter((o) => !hiddenLayerIds.has(o.layerId)),
    [overlay, hiddenLayerIds],
  );
  const occurrenceByKey = useMemo(
    () => new Map((overlay?.occurrences || []).map((o) => [o.occurrenceKey, o])),
    [overlay],
  );
  const clashByOccurrenceKey = useMemo(() => {
    const m = new Map();
    for (const clash of clashes) {
      for (const key of clash.occurrenceKeys) m.set(key, clash);
    }
    return m;
  }, [clashes]);

  const toggleLayer = useCallback((layerId) => {
    setHiddenLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId); else next.add(layerId);
      return next;
    });
  }, []);

  // Year view's mini-month click: jump to Month view anchored on that
  // month. Year itself never gates on coverage (see CalendarNavRow); the
  // mini-month button is disabled when out of coverage, so this only ever
  // fires for a covered month.
  const openMonth = useCallback((monthStart) => {
    setAnchorDate(monthStart);
    setMode('month');
  }, []);

  if (loading) {
    return (
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="calendarq-calendar-tab-loading">
        <div className="qx-skeleton" style={{ height: 32 }} />
        <div className="cq-grid-skeleton">
          {Array.from({ length: 35 }).map((_, i) => (<div key={i} className="qx-skeleton qx-skeleton--block" />))}
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="qx-banner qx-banner--error" data-testid="calendarq-calendar-tab-error">{error}</div>;
  }

  if (layers.length === 0) {
    return (
      <div className="qx-card qx-card--compact qx-empty" data-testid="calendarq-no-layers-empty">
        <div className="qx-empty__title">No calendar connected yet</div>
        <div className="qx-empty__body">Connect a calendar in the Connections tab to see it here.</div>
      </div>
    );
  }

  return (
    <div className="qx-stack cq-face" data-mode={mode}>
      {/* NotesQ look rule 1: header card (the tools) and the calendar face
          (the content) are two separate cards, not one slab. The mode seg
          stays a plain .qx-seg (a mode switch, not a tool group — rule 3). */}
      <header className="qx-card qx-card--compact cq-face-head">
        <CalendarNavRow
          mode={mode}
          anchorDate={anchorDate}
          onAnchorChange={setAnchorDate}
          todayDate={todayDate}
          windowStartDate={windowBounds.start}
          windowEndDateExclusive={windowBounds.endExclusive}
          right={(
            <>
              <div className="qx-seg" role="group" aria-label="Calendar view mode">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`qx-seg__btn${mode === m.key ? ' qx-seg__btn--active' : ''}`}
                    onClick={() => setMode(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <CoveragePill layers={layers} windowCoverageStatement={windowCoverageStatement} />
              {textSize}
            </>
          )}
        />
        <LayerSwitcher layers={layers} hiddenLayerIds={hiddenLayerIds} onToggle={toggleLayer} />
      </header>
      {/* NotesQ look rule 2: the calendar face is the object being read, so
          it sits on the one dark slate surface; everything translucent
          around it reads as the tools. */}
      <div className="qx-card qx-card--compact qx-slate cq-slate" style={{ '--qx-text-zoom': zoom }}>
      {mode === 'agenda' ? (
        <AgendaList
          occurrences={visibleOccurrences}
          layerById={layerById}
          clashByOccurrenceKey={clashByOccurrenceKey}
          occurrenceByKey={occurrenceByKey}
          todayDate={todayDate}
        />
      ) : mode === 'year' ? (
        <CalendarYearGrid
          anchorDate={anchorDate}
          occurrences={visibleOccurrences}
          layerById={layerById}
          todayDate={todayDate}
          windowStartDate={windowBounds.start}
          windowEndDateExclusive={windowBounds.endExclusive}
          onOpenMonth={openMonth}
        />
      ) : (
        <CalendarGrid
          mode={mode}
          anchorDate={anchorDate}
          todayDate={todayDate}
          occurrences={visibleOccurrences}
          layerById={layerById}
          clashByOccurrenceKey={clashByOccurrenceKey}
          occurrenceByKey={occurrenceByKey}
          windowStartDate={windowBounds.start}
          windowEndDateExclusive={windowBounds.endExclusive}
        />
      )}
      </div>
    </div>
  );
}
