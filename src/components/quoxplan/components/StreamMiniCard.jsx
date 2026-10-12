import { Link, useLocation } from 'react-router-dom';
import { StatusRead, TierNotch } from './Chips.jsx';
import PhaseProgress from './PhaseProgress.jsx';
import { statusColorVar, tierColorVar } from '../lib/colors.js';

/**
 * Shared read-only stream summary card used by Focus and Board. Accent color
 * defaults to the stream's status (Focus reads status-first); pass
 * `accent="tier"` for Board's tier-first reading.
 */
export default function StreamMiniCard({ stream, accent = 'status', footer = null }) {
  const location = useLocation();
  const accentColor = accent === 'tier' ? tierColorVar(stream.tier) : statusColorVar(stream.status);

  return (
    <Link
      to={`/quoxplan/streams/${stream.id}`}
      state={{ from: location.pathname }}
      className="qx-card qx-card--compact qx-card--lift qxp-card-accent"
      style={{ '--qxp-accent-color': accentColor, display: 'block', textDecoration: 'none' }}
    >
      <TierNotch tier={stream.tier} />
      <div className="qx-stack qx-stack--tight">
        <span className="qx-hint qx-hint--sm qxp-mono" style={{ whiteSpace: 'nowrap' }}>
          {stream.id}
        </span>
        <strong style={{ fontSize: 'var(--m-text-base)' }}>{stream.name}</strong>
        <StatusRead status={stream.status} />
        {stream.summary && (
          <p
            className="qx-hint"
            style={{
              margin: 0,
              WebkitLineClamp: 2,
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}
          >
            {stream.summary}
          </p>
        )}
        <PhaseProgress phases={stream.phases} />
        {stream.status === 'BLOCKED' && stream.depends_on?.length > 0 && (
          <span className="qx-hint qx-hint--danger">blocked by {stream.depends_on.join(', ')}</span>
        )}
        {footer}
      </div>
    </Link>
  );
}
