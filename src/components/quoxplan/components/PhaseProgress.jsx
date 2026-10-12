/**
 * Phase progress as segmented micro-blocks (owner feedback 2026-07-25, point
 * 5) — one 8x3px block per phase, derived from first-class phase rows
 * (never a bare counter). Omits itself entirely when there are no phases on
 * the payload.
 */
export default function PhaseProgress({ phases }) {
  if (!phases || phases.length === 0) return null;
  const done = phases.filter((p) => p.status === 'DONE').length;
  const total = phases.length;

  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
      <div className="qxp-phase-blocks">
        {phases.map((p) => (
          <span
            key={p.id}
            className={`qxp-phase-block qxp-phase-block--${
              p.status === 'DONE' ? 'done' : p.status === 'IN_PROGRESS' ? 'active' : 'todo'
            }`}
          />
        ))}
      </div>
      <span className="qx-hint qx-hint--sm qxp-mono">
        {done}/{total}
      </span>
    </div>
  );
}
