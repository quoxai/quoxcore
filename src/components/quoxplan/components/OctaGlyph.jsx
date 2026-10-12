import { statusColorVar } from '../lib/colors.js';

const DIAMOND = 'M8 1 L15 8 L8 15 L1 8 Z';
const BOTTOM_TRIANGLE = 'M1 8 L15 8 L8 15 Z';
const MIDLINE = 'M1 8 L15 8';
// Four outline edges, drawn separately (rather than one closed polygon path)
// so BLOCKED can omit one and read as a notch in the wireframe.
const OUTLINE_EDGES = ['M8 1 L15 8', 'M15 8 L8 15', 'M8 15 L1 8', 'M1 8 L8 1'];
const NOTCH_EDGE_INDEX = 1; // bottom-right edge, omitted for BLOCKED

/**
 * The Quox octahedron node primitive, used as the status glyph throughout
 * QuoxPlan (the "instrument, not gloss" identity pass — replaces status dot
 * pills everywhere except the sidebar roadmap health dots and the qx-menu
 * status/tier pickers, which stay as-is).
 *
 * NOT_STARTED     dim wireframe outline only
 * IN_PROGRESS     bottom half filled, warn color
 * BLOCKED         fully filled error color, one outline edge omitted (notch)
 * DECISION_NEEDED wireframe outline + centered dot, purple
 * COMPLETE        fully filled success, slightly dimmed
 */
export default function OctaGlyph({ status, size = 14, className = '' }) {
  const color = statusColorVar(status);
  const dim = 'var(--m-text-tertiary)';
  const isWireframe = status === 'NOT_STARTED' || status === 'DECISION_NEEDED' || !status;
  const strokeColor = isWireframe ? dim : color;
  const notchIndex = status === 'BLOCKED' ? NOTCH_EDGE_INDEX : null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`qxp-octa-glyph ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
    >
      {status === 'IN_PROGRESS' && <path d={BOTTOM_TRIANGLE} fill={color} opacity={0.85} />}
      {status === 'BLOCKED' && <path d={DIAMOND} fill={color} />}
      {status === 'COMPLETE' && <path d={DIAMOND} fill={color} opacity={0.72} />}
      {OUTLINE_EDGES.map((d, i) =>
        i === notchIndex ? null : (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={strokeColor}
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity={isWireframe ? 0.65 : 0.9}
          />
        )
      )}
      <path d={MIDLINE} fill="none" stroke={strokeColor} strokeWidth="1" opacity={isWireframe ? 0.5 : 0.7} />
      {status === 'DECISION_NEEDED' && <circle cx="8" cy="8" r="2" fill="var(--m-quox-secondary)" />}
    </svg>
  );
}
