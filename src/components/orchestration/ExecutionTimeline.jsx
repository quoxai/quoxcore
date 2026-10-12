/**
 * ExecutionTimeline — Horizontal timeline with event dots, labels, and colored segment lines
 *
 * Adapted from quox-remotion/src/visuals-orchestration/ExecutionTimeline.jsx for production use.
 * All Remotion dependencies removed. Uses CSS transitions for animations.
 *
 * Props:
 *   events   — [{label, sublabel, status, color}]
 *   compact  — boolean for smaller version (no labels)
 */
import React, { useState, useEffect } from 'react';

const DOT_SIZE = 6;
const PADDING_X = 16;

const STATUS_COLORS = {
  created:    '#71717a',
  assigned:   '#3b82f6',
  started:    '#3b82f6',
  running:    '#6366f1',
  checkpoint: '#10b981',
  completed:  '#10b981',
  warning:    '#f59e0b',
  resumed:    '#3b82f6',
  failed:     '#ef4444',
  retried:    '#f59e0b',
  paused:     '#f59e0b',
  cancelled:  '#71717a',
  pending:    '#52525b',
};

const ExecutionTimeline = ({
  events = [],
  compact = false,
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  if (events.length === 0) return null;

  const height = compact ? 24 : 48;
  const labelFontSize = compact ? 8 : 10;
  const trackY = compact ? 12 : 16;

  return (
    <div
      style={{
        width: '100%',
        height,
        background: 'rgba(6, 7, 12, 0.5)',
        position: 'relative',
        fontFamily: 'Inter, system-ui, sans-serif',
        overflow: 'hidden',
        borderRadius: 6,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease-out',
      }}
    >
      {/* Track line (background) */}
      <div
        style={{
          position: 'absolute',
          left: PADDING_X,
          top: trackY,
          right: PADDING_X,
          height: 1.5,
          background: 'linear-gradient(90deg, rgba(113,113,122,0.27), rgba(113,113,122,0.13))',
          transition: 'width 0.6s ease-out',
        }}
      />

      {/* Events laid out evenly */}
      {events.map((evt, i) => {
        const pct = events.length === 1 ? 50 : (i / (events.length - 1)) * 100;
        const color = evt.color || STATUS_COLORS[evt.status] || STATUS_COLORS.pending;
        const isFailed = evt.status === 'failed';
        const prevColor = i > 0 ? (events[i - 1].color || STATUS_COLORS[events[i - 1].status] || '#52525b') : null;

        return (
          <React.Fragment key={i}>
            {/* Segment line from previous event */}
            {i > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: `${(i - 1) / (events.length - 1) * 100}%`,
                  top: trackY,
                  width: `${100 / (events.length - 1)}%`,
                  height: 1.5,
                  paddingLeft: PADDING_X,
                  paddingRight: PADDING_X,
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    background: prevColor,
                    opacity: visible ? 0.6 : 0,
                    transition: `opacity 0.5s ease-out ${i * 0.08}s`,
                  }}
                />
              </div>
            )}

            {/* Dot + label container */}
            <div
              style={{
                position: 'absolute',
                left: `${pct}%`,
                top: 0,
                transform: 'translateX(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                opacity: visible ? 1 : 0,
                transition: `opacity 0.4s ease-out ${i * 0.08}s, transform 0.4s ease-out ${i * 0.08}s`,
              }}
            >
              {/* Glow */}
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: trackY,
                  width: 20,
                  height: 20,
                  marginLeft: -10,
                  marginTop: -10,
                  borderRadius: '50%',
                  background: `radial-gradient(circle, ${color}25 0%, transparent 70%)`,
                  pointerEvents: 'none',
                }}
              />

              {/* Dot */}
              <div
                style={{
                  position: 'absolute',
                  top: trackY - DOT_SIZE / 2 + 0.75,
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  borderRadius: isFailed ? 1 : '50%',
                  background: color,
                  transform: isFailed ? 'rotate(45deg)' : 'none',
                  transition: 'transform 0.3s ease-out',
                }}
              />

              {/* Failed X marker */}
              {isFailed && (
                <div
                  style={{
                    position: 'absolute',
                    top: trackY - 3,
                    fontSize: 7,
                    fontWeight: 700,
                    color: color,
                    lineHeight: '6px',
                  }}
                >
                  {'\u2717'}
                </div>
              )}

              {/* Label (alternate above/below to avoid overlap) */}
              {!compact && (
                <div
                  style={{
                    position: 'absolute',
                    top: i % 2 === 0 ? trackY + DOT_SIZE + 5 : trackY - DOT_SIZE - 16,
                    fontSize: labelFontSize,
                    color: 'rgba(161, 161, 170, 0.85)',
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                  }}
                >
                  {evt.label}
                  {evt.sublabel && (
                    <div style={{ fontSize: 8, color: 'rgba(161, 161, 170, 0.6)', marginTop: 1 }}>
                      {evt.sublabel}
                    </div>
                  )}
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default ExecutionTimeline;
