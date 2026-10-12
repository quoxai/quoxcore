/**
 * MemorySummaryCard — compact memory-lattice summary for the dashboard Memory
 * tab. MemoryView is a full page; this is the small card version.
 *
 * Data: useCognitiveSummary().memory === getMemoryLatticeStats() (server-first
 * via the memory service). Truthfulness: a null/fallback stat block is a
 * cold-start signal rendered as "Warming up", never a fabricated 0; healthScore
 * null renders "Collecting", never DOWN.
 */
import { Link } from 'react-router-dom';
import useCognitiveSummary from '../../hooks/useCognitiveSummary';

function MemoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M4 9h5M4 15h5M15 9h5M15 15h5" />
    </svg>
  );
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

export default function MemorySummaryCard() {
  const { memory, loading } = useCognitiveSummary();

  if (loading && !memory) {
    return (
      <div className="dashboard-card">
        <div className="dashboard-card__header">
          <div className="dashboard-card__title"><MemoryIcon /><span>Memory</span></div>
        </div>
        <div className="dashboard-card__body"><p>Loading memory lattice…</p></div>
      </div>
    );
  }

  const warming = !memory || memory.fallback;
  const stats = memory || {};
  const health = stats.healthScore;
  const healthWord = health == null ? 'Collecting'
    : health >= 80 ? 'Healthy' : health >= 50 ? 'Fair' : 'Attention';
  const healthDot = health == null ? 'status-dot--loading'
    : health >= 80 ? 'status-dot--online' : health >= 50 ? 'status-dot--degraded' : 'status-dot--offline';

  const tiles = [
    { label: 'Total memories', value: stats.totalMemories },
    { label: 'Episodic', value: stats.episodic },
    { label: 'Semantic', value: stats.semantic },
    { label: 'Entities', value: stats.entities },
    { label: 'Learned', value: stats.learned },
    { label: 'Conversations', value: stats.conversations },
  ];

  return (
    <div className="dashboard-card">
      <div className="dashboard-card__header">
        <div className="dashboard-card__title"><MemoryIcon /><span>Memory</span></div>
        <Link to="/memory" className="dashboard-card__link">Open memory</Link>
      </div>
      <div className="dashboard-card__body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span className={`status-dot ${healthDot}`} />
          <span style={{ fontWeight: 600 }}>{healthWord}</span>
          {health != null && (
            <span style={{ color: 'rgba(255,255,255,0.75)' }}>· {Math.round(health)}% health</span>
          )}
          {warming && (
            <span style={{ color: 'rgba(255,255,255,0.75)' }}>· warming up</span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
          {tiles.map((t) => (
            <div key={t.label}>
              <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(t.value)}</div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.75)' }}>{t.label}</div>
            </div>
          ))}
        </div>
        {stats.contradictions > 0 && (
          <div style={{ marginTop: 14, color: '#fbbf24', fontSize: 13 }}>
            {fmt(stats.contradictions)} contradiction{stats.contradictions === 1 ? '' : 's'} flagged
          </div>
        )}
      </div>
    </div>
  );
}
