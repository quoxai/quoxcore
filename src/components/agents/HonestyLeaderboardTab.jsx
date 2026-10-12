import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import './HonestyLeaderboardTab.css';

const WINDOWS = [
  { id: '24h', label: '24h' },
  { id: '7d',  label: '7 days' },
  { id: '30d', label: '30 days' },
];

export function HonestyLeaderboardTab({ agentId }) {
  const { authFetch } = useAuth();
  const [windowId, setWindowId] = useState('24h');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drillEvents, setDrillEvents] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/v1/agh-chain/leaderboard/${encodeURIComponent(agentId)}?window=${windowId}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e?.message || e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [agentId, windowId, authFetch]);

  const openDrill = (guard) => {
    authFetch(`/api/v1/agh-chain/leaderboard/${encodeURIComponent(agentId)}/events?window=${windowId}&guard=${guard}`)
      .then(r => r.json())
      .then(d => setDrillEvents({ guard, events: d.events || [] }));
  };

  return (
    <div className="honesty-leaderboard">
      <div className="honesty-leaderboard__window-toggle">
        {WINDOWS.map(w => (
          <button
            key={w.id}
            onClick={() => setWindowId(w.id)}
            className={windowId === w.id ? 'honesty-leaderboard__window-btn honesty-leaderboard__window-btn--active' : 'honesty-leaderboard__window-btn'}
          >
            {w.label}
          </button>
        ))}
      </div>

      {loading && <div className="honesty-leaderboard__loading">Loading...</div>}
      {error && <div className="honesty-leaderboard__error">Error: {error}</div>}

      {data && (
        <>
          <div className="honesty-leaderboard__metrics">
            <Metric label="Honesty rate" value={`${Math.round((data.honesty_rate ?? 0) * 100)}%`} />
            <Metric label="Claims made" value={data.claims_made ?? 0} />
            <Metric label="Claims verified" value={data.claims_verified ?? 0} />
            <Metric label="Claims rewritten" value={data.claims_stripped ?? 0} onClick={() => openDrill('claims_stripped')} />
            <Metric label="Open promises" value={data.unfulfilled_promises ?? 0} />
          </div>

          {data.sparkline && data.sparkline.length > 0 && (
            <Sparkline points={data.sparkline} />
          )}

          {drillEvents && (
            <DrillThroughPanel guard={drillEvents.guard} events={drillEvents.events} onClose={() => setDrillEvents(null)} />
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, onClick }) {
  return (
    <div
      className={onClick ? 'honesty-leaderboard__metric honesty-leaderboard__metric--clickable' : 'honesty-leaderboard__metric'}
      onClick={onClick}
    >
      <div className="honesty-leaderboard__metric-label">{label}</div>
      <div className="honesty-leaderboard__metric-value">{value}</div>
    </div>
  );
}

function Sparkline({ points }) {
  // points: array of [bucket_start_iso, claims_made, claims_stripped]
  const w = 320, h = 60, pad = 4;
  const max = Math.max(1, ...points.map(p => p[1]));
  const xStep = (w - pad * 2) / Math.max(1, points.length - 1);
  const yScale = (v) => h - pad - (v / max) * (h - pad * 2);
  const linePath = (idx) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * xStep} ${yScale(p[idx])}`).join(' ');
  return (
    <svg className="honesty-leaderboard__sparkline" width={w} height={h} aria-label="Honesty sparkline">
      <path d={linePath(1)} fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
      <path d={linePath(2)} fill="none" stroke="#ff8800" strokeWidth="1.5" />
    </svg>
  );
}

function DrillThroughPanel({ guard, events, onClose }) {
  return (
    <div className="honesty-leaderboard__drill-panel">
      <div className="honesty-leaderboard__drill-header">
        <span>{guard} &mdash; {events.length} events</span>
        <button className="honesty-leaderboard__drill-close" onClick={onClose}>Close</button>
      </div>
      <ul className="honesty-leaderboard__drill-list">
        {events.map(e => (
          <li key={e.event_id} className="honesty-leaderboard__drill-item">
            <code>{e.event_id}</code>
            <span className="honesty-leaderboard__drill-ts">{e.ts}</span>
            <a
              className="honesty-leaderboard__drill-link"
              href={`/orgs/_/audit?run_id=${encodeURIComponent(e.run_id)}`}
            >
              view run
            </a>
          </li>
        ))}
        {events.length === 0 && (
          <li className="honesty-leaderboard__drill-empty">No events in this window.</li>
        )}
      </ul>
    </div>
  );
}
