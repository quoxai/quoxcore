/**
 * GaugeCluster — Dashboard of multiple circular gauges arranged together
 *
 * Adapted from quox-remotion. All Remotion deps removed, animations via CSS transitions.
 *
 * Each gauge: circular arc (270 deg sweep), centre value, label below,
 * colour threshold (green/amber/red).
 * "dashboard" layout: one large gauge flanked by smaller ones.
 *
 * Props:
 *   gauges  — [{label, value, max, unit?, color?}]
 *   layout  — "row" | "grid" | "dashboard" (default "row")
 *   size    — base gauge diameter (default 80)
 */
import React, { useState, useEffect, useRef } from 'react';

const MONO = "'SF Mono', 'JetBrains Mono', monospace";
const FONT = "Inter, system-ui, sans-serif";

function thresholdColor(pct) {
  if (pct < 0.6) return '#22c55e';
  if (pct < 0.85) return '#f59e0b';
  return '#ef4444';
}

const SingleGauge = ({ label, value, max, unit, color, size }) => {
  const [animated, setAnimated] = useState(false);
  const prevValueRef = useRef(0);

  useEffect(() => {
    // Trigger animation on mount or when value changes
    const raf = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    prevValueRef.current = value;
  }, [value]);

  const pct = Math.min(value / max, 1);
  const displayColor = color || thresholdColor(pct);

  const sweepDeg = 270;
  const startAngle = 135;
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const arcLength = (sweepDeg / 360) * circumference;
  const gapLength = circumference - arcLength;

  const filledArc = animated ? arcLength * pct : 0;
  const emptyArc = circumference - filledArc;

  const cx = size / 2;
  const cy = size / 2;

  const displayVal = animated ? value : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Background arc */}
          <circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke="rgba(255,255,255,0.06)" strokeWidth={Math.max(4, size * 0.06)}
            strokeDasharray={`${arcLength} ${gapLength}`}
            strokeLinecap="round"
            transform={`rotate(${startAngle} ${cx} ${cy})`}
          />
          {/* Filled arc */}
          <circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={displayColor} strokeWidth={Math.max(4, size * 0.06)}
            strokeDasharray={`${filledArc} ${emptyArc}`}
            strokeLinecap="round"
            transform={`rotate(${startAngle} ${cx} ${cy})`}
            style={{
              opacity: 0.9,
              transition: 'stroke-dasharray 0.8s ease, stroke 0.4s ease',
            }}
          />
          {/* Bright glow layer */}
          <circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={displayColor} strokeWidth={Math.max(2, size * 0.025)}
            strokeDasharray={`${filledArc} ${emptyArc}`}
            strokeLinecap="round"
            transform={`rotate(${startAngle} ${cx} ${cy})`}
            style={{
              opacity: 0.35,
              transition: 'stroke-dasharray 0.8s ease, stroke 0.4s ease',
            }}
          />
        </svg>

        {/* Centre value */}
        <div style={{
          position: 'absolute', top: 0, left: 0, width: size, height: size,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={{
            fontFamily: MONO, fontSize: size * 0.22, fontWeight: 700,
            color: 'rgba(255,255,255,0.95)', lineHeight: 1,
          }}>
            {displayVal}
          </span>
          {unit && (
            <span style={{
              fontFamily: MONO, fontSize: size * 0.1, color: 'rgba(255,255,255,0.6)',
              marginTop: 2,
            }}>
              {unit}
            </span>
          )}
        </div>
      </div>

      {/* Label */}
      <span style={{
        fontFamily: FONT, fontSize: Math.max(9, size * 0.09),
        color: 'rgba(255,255,255,0.65)', letterSpacing: 1, textTransform: 'uppercase',
      }}>
        {label}
      </span>
    </div>
  );
};

const GaugeCluster = ({
  gauges = [],
  layout = 'row',
  size = 80,
}) => {
  if (!gauges.length) return null;

  if (layout === 'row') {
    return (
      <div style={{
        display: 'flex', gap: 24,
        alignItems: 'flex-end', justifyContent: 'center',
        flexWrap: 'wrap',
      }}>
        {gauges.map((g) => (
          <SingleGauge key={g.label} {...g} size={size} />
        ))}
      </div>
    );
  }

  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(gauges.length));
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 16, justifyItems: 'center',
      }}>
        {gauges.map((g) => (
          <SingleGauge key={g.label} {...g} size={size} />
        ))}
      </div>
    );
  }

  // Dashboard layout: big gauge + smaller flanking ones
  const big = gauges[0];
  const smalls = gauges.slice(1, 5);
  const bigSize = Math.round(size * 1.6);
  const smallSize = Math.round(size * 0.85);

  const leftCol = smalls.slice(0, 2);
  const rightCol = smalls.slice(2, 4);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28,
    }}>
      {/* Left column */}
      {leftCol.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
          {leftCol.map((g) => (
            <SingleGauge key={g.label} {...g} size={smallSize} />
          ))}
        </div>
      )}

      {/* Centre big gauge */}
      <SingleGauge {...big} size={bigSize} />

      {/* Right column */}
      {rightCol.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
          {rightCol.map((g) => (
            <SingleGauge key={g.label} {...g} size={smallSize} />
          ))}
        </div>
      )}
    </div>
  );
};

export default GaugeCluster;
