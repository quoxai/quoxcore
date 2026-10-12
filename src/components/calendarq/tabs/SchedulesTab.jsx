/**
 * SchedulesTab — the "absorbed page": team schedules + live workflow cron
 * triggers, read-only here (management stays in Triggers).
 *
 * Reuses the existing clients rather than a new endpoint: teamService's
 * listAllSchedules (GET /api/schedules, org-wide across every team) for
 * team-owned schedules, and workflowEngine's listSchedules (quoxflow's own
 * live registered Cron jobs) for workflow-owned ones — same split
 * services/collector/lib/calendarq/layers.js's team_schedules/workflow_cron
 * layers use, so this tab shows the same two sources Calendar-Q's own
 * overlay reads, not a third ad-hoc list.
 *
 * ScheduleRow (src/components/scheduling/ScheduleRow.jsx) was NOT reused —
 * it renders with extensive bespoke inline styles (hex backgrounds, a
 * transparent-background toggle button) rather than qx-* classes, which
 * fails the glass-design-system law this view is held to. A thin qx-table
 * row is built here instead.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { listAllSchedules } from '../../../services/teamService';
import { listSchedules as listWorkflowSchedules } from '../../../services/workflowEngine';
import { cronToHuman } from '../../../services/cronHelper';

function formatCountdown(nextAtIso) {
  if (!nextAtIso) return '—';
  const ms = new Date(nextAtIso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function normalizeTeamRow(s) {
  return {
    id: `team:${s.id}`,
    kind: 'team',
    name: s.name || s.id,
    cronHuman: cronToHuman(s.cron_expression),
    nextAt: s.next_trigger_at || null,
    active: s.enabled === 1 || s.enabled === true,
    teamName: s.team_name || 'Org-wide',
  };
}

function normalizeWorkflowRow(w) {
  return {
    id: `workflow:${w.workflowId}:${w.nodeId}`,
    kind: 'workflow',
    name: `Workflow ${w.workflowId} (${w.nodeId})`,
    cronHuman: cronToHuman(w.expression),
    nextAt: w.nextFireAt || null,
    active: !!w.active,
    teamName: 'Workflow',
  };
}

export default function SchedulesTab() {
  const { authFetch } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | paused

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      listAllSchedules(authFetch).catch(() => ({ schedules: [] })),
      listWorkflowSchedules().catch(() => []),
    ])
      .then(([teamRes, workflowRes]) => {
        const teamRows = (teamRes?.schedules || [])
          .filter((s) => s.kind !== 'workflow')
          .map(normalizeTeamRow);
        const workflowRows = (workflowRes || []).map(normalizeWorkflowRow);
        setRows([...teamRows, ...workflowRows]);
      })
      .catch((e) => setError(e.message || 'Could not load schedules.'))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter === 'active' && !r.active) return false;
      if (statusFilter === 'paused' && r.active) return false;
      if (search.trim() && !r.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [rows, statusFilter, search]);

  if (loading) {
    return (
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="calendarq-schedules-loading">
        <div className="qx-skeleton" style={{ height: 32 }} />
        <div className="qx-skeleton" style={{ height: 160 }} />
      </div>
    );
  }

  if (error) {
    return <div className="qx-banner qx-banner--error" data-testid="calendarq-schedules-error">{error}</div>;
  }

  return (
    // Own card now that the main pane is a transparent column (NotesQ look):
    // this tab's content carries its own glass.
    <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="calendarq-schedules-tab">
      <div className="qx-row qx-row--wrap" style={{ gap: 10, alignItems: 'center' }}>
        <input
          type="text"
          className="qx-input"
          placeholder="Search schedules..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 200, flex: 1 }}
          aria-label="Search schedules"
        />
        <div className="qx-row qx-row--nowrap" style={{ gap: 6, overflowX: 'auto' }}>
          {[['all', 'All'], ['active', 'Active'], ['paused', 'Paused']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`qx-chip${statusFilter === key ? ' qx-chip--active' : ''}`}
              onClick={() => setStatusFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="qx-empty" data-testid="calendarq-schedules-empty">
          <div className="qx-empty__title">No schedules match</div>
          <div className="qx-empty__body">Team schedules and workflow cron triggers for this org will show up here.</div>
        </div>
      ) : (
        <table className="qx-table" data-testid="calendarq-schedules-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Cadence</th>
              <th>Next run</th>
              <th>Owner</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.cronHuman}</td>
                <td>{formatCountdown(r.nextAt)}</td>
                <td>{r.teamName}</td>
                <td>
                  <span className={`qx-pill qx-pill--xs ${r.active ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
                    {r.active ? 'Active' : 'Paused'}
                  </span>
                </td>
                <td>
                  <Link className="qx-btn qx-btn--sm qx-btn--ghost" to="/triggers?tab=schedules">Manage in Triggers</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
