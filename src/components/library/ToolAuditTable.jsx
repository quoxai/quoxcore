/**
 * ToolAuditTable — STUDY-REV-2 / P4.D
 *
 * Sortable table showing every TOOL_DEFS key with:
 *   Tool / Source / Status / Agents Using / Last Executed / 30d Calls
 *
 * Data: GET /collector/api/v1/tools/audit
 *
 * Status pill colours:
 *   live       → qx-pill--success  (green)
 *   orphan     → qx-pill--ghost    (neutral)
 *   broken     → qx-pill--high     (red/orange)
 *   deprecated → qx-pill--medium   (amber)
 *
 * Source chip: qx-chip with label.
 * Agents Using: chip-list; click navigates to /tools?view=assignments.
 * Sortable by clicking column headers.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

const AUDIT_URL = '/collector/api/v1/tools/audit';

// Status → pill modifier
const STATUS_PILL = {
  live:       'qx-pill--success',
  orphan:     'qx-pill--ghost',
  broken:     'qx-pill--high',
  deprecated: 'qx-pill--medium',
};

// Source → display label
const SOURCE_LABEL = {
  core:    'Core',
  openapi: 'OpenAPI',
  mcp:     'MCP',
  repo:    'Repo',
  script:  'Script',
};

// ── Sort helpers ──────────────────────────────────────────────────────────────

function sortRows(rows, key, dir) {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    let av = a[key];
    let bv = b[key];

    // Numeric columns
    if (key === 'execution_count_30d') {
      av = av ?? 0;
      bv = bv ?? 0;
      return dir === 'asc' ? av - bv : bv - av;
    }

    // Date columns
    if (key === 'last_executed_at') {
      av = av ? new Date(av).getTime() : 0;
      bv = bv ? new Date(bv).getTime() : 0;
      return dir === 'asc' ? av - bv : bv - av;
    }

    // agents_using: sort by count
    if (key === 'agents_using') {
      av = (av || []).length;
      bv = (bv || []).length;
      return dir === 'asc' ? av - bv : bv - av;
    }

    // String columns
    av = (av || '').toLowerCase();
    bv = (bv || '').toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ── Column header with sort indicator ─────────────────────────────────────────

function SortTh({ label, colKey, sortKey, sortDir, onSort, className }) {
  const isActive = sortKey === colKey;
  const indicator = isActive ? (sortDir === 'asc' ? '--asc' : '--desc') : '';
  return (
    <th
      className={`qx-table__sort${indicator ? ` qx-table__sort${indicator}` : ''} ${className || ''}`}
      onClick={() => onSort(colKey)}
    >
      {label}
    </th>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ToolAuditTable() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sortKey, setSortKey] = useState('tool_id');
  const [sortDir, setSortDir] = useState('asc');

  // Fetch audit data
  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(AUDIT_URL, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setRows(data.tools || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAudit(); }, [loadAudit]);

  // Toggle sort column / direction
  const handleSort = useCallback((col) => {
    setSortKey(prev => {
      if (prev === col) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        return col;
      }
      setSortDir('asc');
      return col;
    });
  }, []);

  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 3v3m0 12v3M3 12h3m12 0h3" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="qx-empty__body">Loading tool audit...</div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__title">Failed to load audit</div>
        <div className="qx-empty__body">{error}</div>
        <button className="qx-btn qx-btn--ghost" onClick={loadAudit}>Retry</button>
      </div>
    );
  }

  // ── Empty ─────────────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__title">No tools registered yet.</div>
        <div className="qx-empty__body">Tools will appear here once the collector boots with TOOL_DEFS.</div>
      </div>
    );
  }

  // ── Table ─────────────────────────────────────────────────────────────────

  const thProps = { sortKey, sortDir, onSort: handleSort };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <table className="qx-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <SortTh label="Tool"         colKey="tool_id"             {...thProps} />
            <SortTh label="Source"       colKey="source"              {...thProps} />
            <SortTh label="Status"       colKey="status"              {...thProps} />
            <SortTh label="Agents Using" colKey="agents_using"        {...thProps} />
            <SortTh label="Last Executed" colKey="last_executed_at"   {...thProps} />
            <SortTh label="30d Calls"    colKey="execution_count_30d" {...thProps} className="qx-num" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <tr key={row.tool_id}>

              {/* Tool name — monospace */}
              <td className="qx-mono" style={{ fontWeight: 500 }}>{row.tool_id}</td>

              {/* Source chip */}
              <td>
                <span className="qx-chip qx-chip--xs">
                  {SOURCE_LABEL[row.source] || row.source}
                </span>
              </td>

              {/* Status pill */}
              <td>
                <span className={`qx-pill qx-pill--sm ${STATUS_PILL[row.status] || 'qx-pill--ghost'}`}>
                  {row.status}
                </span>
              </td>

              {/* Agents Using — chip list, click navigates to assignments view */}
              <td>
                {row.agents_using && row.agents_using.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {row.agents_using.map(agentId => (
                      <button
                        key={agentId}
                        className="qx-chip qx-chip--xs"
                        onClick={() => navigate(`/tools?view=assignments`)}
                        title={`Go to ${agentId} assignments`}
                      >
                        {agentId}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>—</span>
                )}
              </td>

              {/* Last Executed */}
              <td style={{ color: row.last_executed_at ? 'inherit' : 'rgba(255,255,255,0.3)', fontSize: 12 }}>
                {row.last_executed_at
                  ? new Date(row.last_executed_at).toLocaleString()
                  : '—'}
              </td>

              {/* 30d calls — right-aligned numeric */}
              <td className="qx-num" style={{ color: row.execution_count_30d > 0 ? 'inherit' : 'rgba(255,255,255,0.3)' }}>
                {row.execution_count_30d ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
