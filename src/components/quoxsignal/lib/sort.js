import { stageRank } from './stage.js';

/**
 * Column sort for the Feed table. The API already orders items newest-first
 * server-side (items.js's GET /items: `ORDER BY COALESCE(published_at,
 * discovered_at, created_at) DESC`), but the Feed never sorted client-side —
 * a filtered/re-fetched list had no guaranteed order, which is what the
 * owner meant by "not today's behaviour". This makes "most recent first" an
 * explicit, testable default rather than an accident of fetch order, and
 * lets the same comparator drive every sortable column.
 *
 * Pure function, no React, so it's testable without mounting a component —
 * same posture as lib/filters.js.
 */
export const SORT_COLUMNS = ['published', 'duration', 'source', 'stage'];

export const DEFAULT_SORT = { key: 'published', dir: 'desc' };

function publishedValue(item) {
  const raw = item.published_at || item.discovered_at || item.created_at;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

const ACCESSORS = {
  published: publishedValue,
  duration: (item) => (typeof item.duration_s === 'number' ? item.duration_s : -Infinity),
  source: (item) => (item.source_label || item.platform || '').toLowerCase(),
  stage: (item) => stageRank(item.stage)
};

/** Toggles/cycles a column's sort: unsorted column -> desc, same column -> flip dir. */
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'desc' };
  return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
}

/** Sorts a (typically already-filtered) item list by the given { key, dir } state. Stable — ties keep their incoming order. */
export function sortItems(items, sort = DEFAULT_SORT) {
  const accessor = ACCESSORS[sort?.key] || ACCESSORS.published;
  const dir = sort?.dir === 'asc' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const av = accessor(a.item);
      const bv = accessor(b.item);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
