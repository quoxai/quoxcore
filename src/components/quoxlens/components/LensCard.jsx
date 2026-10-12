import { formatLift } from '../lib/lift.js';

/**
 * One Lens: its name, its one-line stance, its measured lift (or a
 * prominent UNPROVEN badge), and its declared blind spots.
 *
 * Honesty rule (the point of this whole surface): `unproven` comes straight
 * from the collector's isUnproven() — docs/LENS_CONTRACT.md invariant 4's
 * single source of truth — and is rendered as a first-class badge in the
 * card header, not a footnote. A negative lift renders in red with its real
 * sign; this component never rounds a loss into a win, never hides the
 * number, and never suppresses the badge because the number looks bad.
 */
export default function LensCard({ lens }) {
  const lift = formatLift(lens?.eval?.lift?.span?.f1);

  return (
    <div className="qx-card qx-card--compact" data-testid={`qx-lens-card-${lens.id}`}>
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start' }}>
          <div className="qx-stack qx-stack--tight" style={{ gap: 2 }}>
            <strong>{lens.name}</strong>
            <span className="qx-hint qx-hint--sm">{lens.id}@{lens.version || 'unknown'}</span>
          </div>
          {lens.unproven && (
            <span className="qx-pill qx-pill--danger" data-testid={`qx-lens-unproven-${lens.id}`}>
              UNPROVEN
            </span>
          )}
        </div>

        {lens.description && <p className="qx-hint">{lens.description}</p>}

        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {lift ? (
            <span
              className={`qx-trend qx-trend--${lift.direction}`}
              data-testid={`qx-lens-lift-${lens.id}`}
              title={`span-level F1 lift vs baseline, ${lens.eval.model}, ${lens.eval.date}`}
            >
              {lift.direction === 'up' ? '↑' : lift.direction === 'down' ? '↓' : '→'} {lift.label} span F1 vs baseline
            </span>
          ) : (
            <span className="qx-hint qx-hint--sm" data-testid={`qx-lens-no-eval-${lens.id}`}>
              No eval on disk yet
            </span>
          )}
          {!lens.eval?.matches_current_version && lens.eval && (
            <span className="qx-hint qx-hint--sm">(measured against an older lens version)</span>
          )}
        </div>

        {lens.blind_spots?.length > 0 && (
          <div className="qx-stack" style={{ gap: 4 }}>
            <span className="qx-hint qx-hint--sm">Declared blind spots</span>
            <div className="qx-row qx-row--wrap qx-row--tight">
              {lens.blind_spots.map((spot) => (
                <span key={spot} className="qx-chip qx-chip--xs">{spot}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
