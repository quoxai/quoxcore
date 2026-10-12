import { useEffect, useState } from 'react';

function relativeTime(ts) {
  if (!ts) return null;
  const diffS = Math.floor((Date.now() - ts) / 1000);
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

/**
 * SIGNAL-PERF: lib/api.js's module-level cache already makes a second visit
 * to a tab free (no fetch at all), but there was no way to ask for FRESH
 * data short of reloading the whole page — which throws the cache away and
 * re-triggers the full cold request storm the cache exists to avoid. This is
 * the honest half of caching: one explicit control per list-backed view that
 * forces just that view's own data fresh, plus a quiet "updated Xm ago" so a
 * cached view never silently passes for live.
 *
 * `loading` here means "a refresh is in flight" (useAsync's `refreshing`),
 * not the initial-load flag AsyncBoundary already owns — this control never
 * blanks the view it sits in.
 */
export default function RefreshControl({ onRefresh, loading, updatedAt }) {
  // Re-render every 15s purely so the "updated Xm ago" text keeps counting up
  // without the user having to trigger any state change themselves.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
      <button
        type="button"
        className="qx-btn qx-btn--sm qx-btn--ghost"
        onClick={onRefresh}
        disabled={loading}
        data-testid="signal-refresh"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <span className="qx-hint qx-hint--sm" data-testid="signal-updated-at">
        {updatedAt ? `updated ${relativeTime(updatedAt)}` : loading ? 'loading…' : ''}
      </span>
    </div>
  );
}
