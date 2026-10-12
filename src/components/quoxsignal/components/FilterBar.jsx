import { useEffect, useState } from 'react';

/**
 * The Feed's filter row: source, stage, topic, unread (the original four),
 * plus free-text search and a "Show discarded" toggle (SIGNAL-UX items 1-2).
 * Rebuilt on `.qx-select` / `.qx-chip` / `.qx-search-wrap` (design system)
 * instead of the standalone app's bespoke `.qs-select` / `.qs-toggle`.
 */
const SEARCH_DEBOUNCE_MS = 300;

export default function FilterBar({ filters, onChange, sources, topics }) {
  function set(field, value) {
    onChange({ ...filters, [field]: value });
  }

  // Debounced free-text search: typed keystrokes update a local echo
  // immediately (so the input never feels laggy) but only push into
  // `filters.q` — and therefore re-run the (potentially large) filterItems()
  // pass — after the user pauses typing.
  const [searchInput, setSearchInput] = useState(filters.q || '');
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput !== (filters.q || '')) set('q', searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  return (
    <div className="qx-row qx-row--tight qx-row--nowrap" role="group" aria-label="Filters">
      <div className="qx-search-wrap" style={{ maxWidth: 260 }}>
        <span className="qx-search-wrap__icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="qx-input"
          placeholder="Search title, source, transcript…"
          aria-label="Search items"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      <select
        className="qx-select qx-select--auto"
        aria-label="Filter by source"
        value={filters.source || ''}
        onChange={(e) => set('source', e.target.value)}
      >
        <option value="">All sources</option>
        {sources.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* SIGNAL-PIPELINE alignment: the stage <select> is GONE. Stage
          navigation belongs to the pipeline bar's stations now — a second
          stage control here contradicted it (owner, 2026-09-18). filters.stage
          itself remains, driven by the ?stage= URL param. */}
      <select
        className="qx-select qx-select--auto"
        aria-label="Filter by topic"
        value={filters.topic || ''}
        onChange={(e) => set('topic', e.target.value)}
      >
        <option value="">All topics</option>
        {topics.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      <button
        type="button"
        className={`qx-chip${filters.unread ? ' qx-chip--active' : ''}`}
        aria-pressed={Boolean(filters.unread)}
        onClick={() => set('unread', !filters.unread)}
      >
        Unread only
      </button>

      <button
        type="button"
        className={`qx-chip${filters.showDiscarded ? ' qx-chip--active' : ''}`}
        aria-pressed={Boolean(filters.showDiscarded)}
        onClick={() => set('showDiscarded', !filters.showDiscarded)}
      >
        Show discarded
      </button>

      {/* SIGNAL-AUDIT 2026-09-18: text-native items (JSON/web feeds whose text
          arrives with the entry — CISA KEV et al) reach 'transcribed' with no
          ASR run and can drown real transcriptions. Kept in the feed by
          default (the owner keeps CISA), one chip to mute them. */}
      <button
        type="button"
        className={`qx-chip${filters.hideText ? ' qx-chip--active' : ''}`}
        aria-pressed={Boolean(filters.hideText)}
        onClick={() => set('hideText', !filters.hideText)}
      >
        Hide text posts
      </button>
    </div>
  );
}
