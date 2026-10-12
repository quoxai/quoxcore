import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { filterItems, sourceOptions, topicOptions } from '../lib/filters.js';
import { nextStageFor } from '../lib/stage.js';
import { sumCost } from '../lib/cost.js';
import { useReadState } from '../lib/readState.js';
import { drainLegacyDiscards } from '../lib/discardState.js';
import { sortItems, nextSort, DEFAULT_SORT } from '../lib/sort.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import ItemRow from '../components/ItemRow.jsx';
import FilterBar from '../components/FilterBar.jsx';
import SourceHealthBanner from '../components/SourceHealthBanner.jsx';
import RefreshControl from '../components/RefreshControl.jsx';

/* Two lists, one screen: the server's default /items now EXCLUDES dismissed
   rows (they are server-side state since SIGNAL-AUDIT 2026-09-18), and
   ?dismissed=1 is the discarded view. Fetch both so "Show discarded" is an
   instant client toggle rather than a refetch, and so a discard can be
   undone from the same screen it happened on. */
const fetchItems = async (opts) => {
  const [live, dismissed] = await Promise.all([
    api.listItems({}, opts),
    api.listItems({ dismissed: 1 }, opts),
  ]);
  return { items: [...(live?.items || []), ...(dismissed?.items || [])] };
};

/* An item stays "in flight" server-side for as long as its `requested_stage` is set — a
   worker owns it, but nothing pushes state changes to the browser. Without polling, the
   feed only ever learns a queued item finished when the user manually refreshes. */
const POLL_MS = 3000;

/**
 * The Feed: one list, one primary action per row. Time to first useful
 * screen with zero configuration is the whole point, so this is the default
 * tab and does the least amount of setup possible before showing items.
 *
 * Ported from the standalone app's FeedView.jsx — same filtering, polling,
 * and j/k/Enter/x keyboard triage logic, rebuilt on `.qx-table` instead of
 * the standalone app's bespoke `.qs-card-list`.
 */
export default function FeedView() {
  const navigate = useNavigate();
  const { loading, error, data, retry, refreshing, updatedAt } = useAsync(fetchItems, []);
  const items = data?.items || [];

  const [filters, setFilters] = useState({ source: '', stage: '', topic: '', unread: false, q: '', showDiscarded: false, hideText: false });

  // SIGNAL-PIPELINE: the pipeline bar deep-links feed stations as
  // /quoxsignal?tab=feed&stage=<stage>. The URL param drives the stage
  // filter (and re-drives it on every station click); changing the filter
  // by hand in the FilterBar is still allowed and simply diverges until
  // the next station click re-asserts the URL.
  const [searchParams] = useSearchParams();
  const urlStage = searchParams.get('stage') || '';
  useEffect(() => {
    setFilters((f) => (f.stage === urlStage ? f : { ...f, stage: urlStage }));
  }, [urlStage]);
  // SIGNAL-PIPELINE alignment: on a single-stage station view every row
  // carries the same stage, so the Stage column is pure repetition — hide
  // it and let the pipeline bar say where you are. The mixed view (plain
  // Feed tab, no ?stage=) keeps the column: there it still disambiguates.
  const showStageColumn = !filters.stage;
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [advancingIds, setAdvancingIds] = useState(() => new Set());
  const { isRead, markRead } = useReadState();

  // Server-side discard: the item's own `dismissed` field is the truth, the
  // handlers call the API and silently refresh. The old localStorage set is
  // drained into the server once (best effort — a failure just retries on
  // the next mount).
  const isDiscarded = useCallback(
    (id) => Boolean(items.find((i) => i.id === id)?.dismissed),
    [items]
  );
  const discard = useCallback(async (id) => {
    try {
      await api.dismissItem(id);
      retry({ force: true, silent: true });
    } catch { /* row stays; nothing destructive happened */ }
  }, [retry]);
  const undiscard = useCallback(async (id) => {
    try {
      await api.undismissItem(id);
      retry({ force: true, silent: true });
    } catch { /* row stays dismissed; visible in Show discarded */ }
  }, [retry]);
  useEffect(() => {
    drainLegacyDiscards(api)
      .then((n) => { if (n > 0) retry({ force: true, silent: true }); })
      .catch(() => { /* key kept, retried next mount */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot migration on mount
  }, []);

  const sources = useMemo(() => sourceOptions(items), [items]);

  /* Items carry source_label but not the source's avatar or monogram: those live on the
     source record, not duplicated onto every item. Fetch the sources once and join by
     label so a row can render a real avatar instead of the "?" fallback, which is what
     an unjoined row looked like. Failure here is silent on purpose: a missing avatar is
     cosmetic and must never blank the feed. */
  const [sourceRecords, setSourceRecords] = useState([]);
  useEffect(() => {
    let cancelled = false;
    // Guarded: this join is a cosmetic enhancement, so it must degrade to the monogram
    // fallback rather than throw if the client surface ever lacks listSources.
    if (typeof api.listSources !== 'function') return undefined;
    api.listSources()
      .then((res) => { if (!cancelled) setSourceRecords(res?.sources || []); })
      .catch(() => { /* cosmetic only */ });
    return () => { cancelled = true; };
  }, []);
  const sourceByLabel = useMemo(() => {
    const m = new Map();
    for (const s of sourceRecords) m.set(s.label, s);
    return m;
  }, [sourceRecords]);
  const topics = useMemo(() => topicOptions(items), [items]);
  const searched = useMemo(
    () => filterItems(items, filters, isRead, isDiscarded),
    [items, filters, isRead, isDiscarded]
  );
  // Default is most-recent-first (see lib/sort.js) — sorting happens after
  // filtering so a search/stage/source narrow never disturbs the column
  // the owner actually clicked.
  const filtered = useMemo(() => sortItems(searched, sort), [searched, sort]);

  function onSortClick(key) {
    setSort((prev) => nextSort(prev, key));
  }

  // Keep the cursor in bounds whenever the filtered list shrinks or grows.
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Poll while any item is queued (server-side, requested_stage set) or working (a client
  // advance click is in flight), so a worker finishing a transcribe/analyse shows up without
  // a manual refresh. Stops the moment nothing is in flight — this is not a background job,
  // it only ever runs while this view is mounted and something is actually happening.
  useEffect(() => {
    const inFlight = items.some((i) => i.requested_stage) || advancingIds.size > 0;
    if (!inFlight) return undefined;
    const interval = setInterval(() => retry(), POLL_MS);
    return () => clearInterval(interval);
  }, [items, advancingIds, retry]);

  const advanceOne = useCallback(
    async (item) => {
      const to = nextStageFor(item.stage);
      if (!to) return;
      setAdvancingIds((prev) => new Set(prev).add(item.id));
      try {
        await api.advanceStage(item.id, to);
        markRead(item.id);
        retry();
      } finally {
        setAdvancingIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [markRead, retry]
  );

  const toggleSelect = useCallback((item) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const openItem = useCallback(
    (item) => {
      markRead(item.id);
      navigate(`/quoxsignal/items/${encodeURIComponent(item.id)}`);
    },
    [markRead, navigate]
  );

  // Keyboard triage: j/k move the cursor, Enter advances the focused item a
  // stage, x toggles its selection. Ignored while typing in a filter control.
  const listRef = useRef(filtered);
  listRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const list = listRef.current;
      if (e.key === 'j') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(0, list.length - 1)));
      } else if (e.key === 'k') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = list[cursorRef.current];
        if (item) advanceOne(item);
      } else if (e.key === 'x') {
        e.preventDefault();
        const item = list[cursorRef.current];
        if (item) toggleSelect(item);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advanceOne, toggleSelect]);

  const selectedItems = filtered.filter((i) => selected.has(i.id));
  const bulkCost = sumCost(selectedItems.map((i) => i.duration_s));

  async function advanceSelected() {
    for (const item of selectedItems) {
      // eslint-disable-next-line no-await-in-loop
      await advanceOne(item);
    }
    setSelected(new Set());
  }

  /* SIGNAL-RETHINK (owner): ticked items had Advance but NO discard, so bulk
     triage of junk was impossible and "Show discarded" had nothing to show.
     Sequential like advanceSelected — small lists, no proxy hammering. */
  async function discardSelected() {
    for (const item of selectedItems) {
      // eslint-disable-next-line no-await-in-loop
      await api.dismissItem(item.id).catch(() => { /* row stays; nothing destructive */ });
    }
    setSelected(new Set());
    retry({ force: true, silent: true });
  }

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={6}>
      <div className="qx-stack">
        {/* Source health belongs on the surface where the absence is felt. A dead source
            makes this list look calm, which reads as "nothing happened". */}
        <SourceHealthBanner sources={sourceRecords} />

        {/* SIGNAL-PIPELINE polish (owner, 2026-09-18): refresh + every filter
            in ONE glass bar. The controls used to float bare on the cinematic
            across three wrapping rows, which read as flat and messy; the
            keyboard-shortcut hint line is gone (the shortcuts themselves
            still work). nowrap + overflow-x per the design-system rule for
            cramped chip rows — the bar scrolls sideways, never wraps. */}
        <div className="qx-card qx-card--bar" data-testid="signal-filter-strip">
          <div className="qx-row qx-row--tight" style={{ flexWrap: 'nowrap', alignItems: 'center', overflowX: 'auto' }}>
            <RefreshControl
              onRefresh={() => retry({ force: true, silent: true })}
              loading={refreshing}
              updatedAt={updatedAt}
            />
            <FilterBar filters={filters} onChange={setFilters} sources={sources} topics={topics} />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="qx-card qx-card--compact qx-row qx-row--apart">
            <span className="qx-hint">{selected.size} selected</span>
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={discardSelected} data-testid="signal-bulk-discard">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}>
                  <path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" />
                </svg>
                Discard {selected.size}
              </button>
              <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={advanceSelected}>
                Advance {selected.size} · {bulkCost.label}
              </button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">No items match these filters</div>
          </div>
        ) : (
          <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
            <table className="qx-table">
              <thead>
                <tr>
                  <th></th>
                  <SortableTh label="Source" sortKey="source" sort={sort} onClick={onSortClick} />
                  <th></th>
                  <th>Title</th>
                  {showStageColumn && <SortableTh label="Stage" sortKey="stage" sort={sort} onClick={onSortClick} />}
                  <SortableTh label="Published" sortKey="published" sort={sort} onClick={onSortClick} />
                  <SortableTh label="Duration" sortKey="duration" sort={sort} onClick={onSortClick} className="qx-num" />
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, i) => (
                  <ItemRow
                    source={sourceByLabel.get(item.source_label)}
                    key={item.id}
                    item={item}
                    focused={i === cursor}
                    selected={selected.has(item.id)}
                    unread={!isRead(item.id)}
                    showStage={showStageColumn}
                    discarded={isDiscarded(item.id)}
                    advancing={advancingIds.has(item.id)}
                    onToggleSelect={toggleSelect}
                    onAdvance={advanceOne}
                    onOpen={openItem}
                    onDiscard={discard}
                    onUndiscard={undiscard}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AsyncBoundary>
  );
}

/** A `<th>` that toggles lib/sort.js's sort state on click, using the
 * design system's existing .qx-table__sort/--asc/--desc classes (no bespoke
 * CSS needed — see QX_INDEX.md's Tables section). */
function SortableTh({ label, sortKey, sort, onClick, className }) {
  const active = sort?.key === sortKey;
  const dirClass = active ? (sort.dir === 'asc' ? ' qx-table__sort--asc' : ' qx-table__sort--desc') : '';
  return (
    <th
      className={`qx-table__sort${dirClass}${className ? ` ${className}` : ''}`}
      onClick={() => onClick(sortKey)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
    </th>
  );
}
