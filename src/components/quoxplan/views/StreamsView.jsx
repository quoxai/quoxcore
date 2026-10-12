import { useMemo, useState } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { flattenStreams } from '../lib/format.js';
import { fuzzyFilter } from '../lib/fuzzy.js';
import { sortStreams } from '../lib/streamSort.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import { StatusRead, TierRead } from '../components/Chips.jsx';

const STATUS_FILTERS = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DECISION_NEEDED', 'COMPLETE'];

// Column order matches the table; only these are sortable (Tags is not).
// Default remains priority asc (owner feedback 2026-07-25 wave 2, item 7).
const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'tier', label: 'Tier' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority', numeric: true },
  { key: 'effort', label: 'Effort' }
];

export default function StreamsView() {
  const { roadmapId } = useParams();
  const location = useLocation();
  const { activeScope } = useRoadmapCtx();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [sortKey, setSortKey] = useState('priority');
  const [sortDir, setSortDir] = useState('asc');

  const { loading, error, data, retry } = useAsync(
    () => api.listStreams(roadmapId, 'all', activeScope),
    [roadmapId, activeScope]
  );

  const flat = useMemo(() => (data ? flattenStreams(data.streams) : []), [data]);

  const visible = useMemo(() => {
    let list = flat;
    if (statusFilter) list = list.filter((s) => s.status === statusFilter);
    if (query.trim()) {
      list = fuzzyFilter(query, list, (s) => `${s.id} ${s.name} ${(s.tags || []).join(' ')}`);
    }
    return sortStreams(list, sortKey, sortDir);
  }, [flat, query, statusFilter, sortKey, sortDir]);

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className="qx-view qx-stack qxp-streams-view">
      <div className="qxp-streams-filterbar qx-card qx-card--bar qx-row qx-row--apart">
        <div className="qx-search-wrap" style={{ maxWidth: 320 }}>
          <span className="qx-search-wrap__icon">⌕</span>
          <input
            className="qx-input"
            placeholder="Filter by id, name, or tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="qx-row qx-row--tight qx-row--wrap">
          <button
            type="button"
            className={`qx-pill qx-pill--sm ${statusFilter === null ? 'qx-pill--purple' : 'qx-pill--ghost'}`}
            onClick={() => setStatusFilter(null)}
          >
            All
          </button>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={`qx-pill qx-pill--sm qx-pill--${statusFilter === s ? 'purple' : 'ghost'}`}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={10}>
        <div className="qx-card qxp-streams-table-wrap">
          <table className="qx-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => {
                  const indicator = sortKey === col.key ? (sortDir === 'asc' ? '--asc' : '--desc') : '';
                  return (
                    <th
                      key={col.key}
                      className={`qx-table__sort${indicator ? ` qx-table__sort${indicator}` : ''}${col.numeric ? ' qx-num' : ''}`}
                      onClick={() => handleSort(col.key)}
                      aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      {col.label}
                    </th>
                  );
                })}
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id} className={s.scope_context ? 'qxp-scope-context' : undefined}>
                  <td className="qx-mono">
                    <Link to={`/quoxplan/streams/${s.id}`} state={{ from: location.pathname }}>
                      {s.id}
                    </Link>
                  </td>
                  <td>{s.name}</td>
                  <td>
                    <TierRead tier={s.tier} />
                  </td>
                  <td>
                    <StatusRead status={s.status} size={12} />
                  </td>
                  <td className="qx-num">{s.priority}</td>
                  <td className="qxp-mono">{s.effort}</td>
                  <td>
                    {(s.tags || []).map((t) => (
                      <span key={t} className="qx-chip qx-chip--xs" style={{ marginRight: 4 }}>
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <span className="qx-hint">No streams match this filter.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AsyncBoundary>
    </div>
  );
}
