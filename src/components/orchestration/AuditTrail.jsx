/**
 * AuditTrail — Vertical timeline of orchestration audit events
 *
 * Adapted from quox-remotion/src/visuals-hitl/AuditTrail.jsx for production use.
 * All Remotion dependencies removed. Uses CSS transitions for hover effects.
 *
 * Props:
 *   events     — [{type, actor, timestamp, detail}]
 *   maxVisible — max visible events (default 8)
 *   compact    — boolean for smaller version
 */
import React, { useState } from 'react';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const FONT = "Inter, system-ui, sans-serif";

const EVENT_CONFIG = {
  // HITL events
  created:   { color: '#3b82f6', icon: '\u25C6', label: 'Created' },
  assigned:  { color: '#a855f7', icon: '\u2192', label: 'Assigned' },
  viewed:    { color: '#71717a', icon: '\u25C9', label: 'Viewed' },
  responded: { color: '#10b981', icon: '\u2713', label: 'Responded' },
  escalated: { color: '#f59e0b', icon: '\u25B2', label: 'Escalated' },
  expired:   { color: '#ef4444', icon: '\u2715', label: 'Expired' },
  resolved:  { color: '#10b981', icon: '\u25CF', label: 'Resolved' },
  // Task execution events
  started:   { color: '#3b82f6', icon: '\u25B6', label: 'Started' },
  completed: { color: '#10b981', icon: '\u2713', label: 'Completed' },
  failed:    { color: '#ef4444', icon: '\u2715', label: 'Failed' },
  paused:    { color: '#f59e0b', icon: '\u23F8', label: 'Paused' },
  resumed:   { color: '#3b82f6', icon: '\u25B6', label: 'Resumed' },
  cancelled: { color: '#71717a', icon: '\u2298', label: 'Cancelled' },
  retry:     { color: '#f59e0b', icon: '\u21BB', label: 'Retry' },
  heartbeat: { color: '#71717a', icon: '\u2665', label: 'Heartbeat' },
};

/**
 * Format a timestamp as relative time ("2m ago", "1h ago", "3d ago").
 * Falls back to absolute HH:MM if the date cannot be parsed.
 */
function formatRelativeTime(ts) {
  const now = Date.now();
  const then = new Date(ts).getTime();
  if (isNaN(then)) return '—';

  const diffMs = now - then;
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return seconds <= 5 ? 'just now' : `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function EventRow({ event, isLast, compact, hovered, onHover, onLeave }) {
  const evConf = EVENT_CONFIG[event.type] || EVENT_CONFIG.created;

  // In compact mode, hide heartbeat events
  if (compact && event.type === 'heartbeat') return null;

  const dotSize = compact ? 16 : 20;
  const iconSize = compact ? 8 : 10;

  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        display: 'flex',
        gap: compact ? 8 : 12,
        background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        borderRadius: 6,
        padding: compact ? '2px 4px' : '2px 4px',
        marginLeft: -4,
        marginRight: -4,
        transition: 'background 0.15s ease',
      }}
    >
      {/* Timeline column */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: dotSize,
          flexShrink: 0,
        }}
      >
        {/* Dot */}
        <div
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${evConf.color}18`,
            border: `2px solid ${evConf.color}40`,
            color: evConf.color,
            fontSize: iconSize,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {evConf.icon}
        </div>
        {/* Connecting line */}
        {!isLast && (
          <div
            style={{
              width: 1,
              flex: 1,
              minHeight: compact ? 12 : 20,
              background: `linear-gradient(to bottom, ${evConf.color}30, rgba(255,255,255,0.04))`,
            }}
          />
        )}
      </div>

      {/* Content column */}
      <div
        style={{
          flex: 1,
          paddingBottom: isLast ? 0 : compact ? 6 : 14,
          minWidth: 0,
        }}
      >
        {/* Top row: label + actor + time */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: compact ? 1 : 3,
            gap: 6,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                fontSize: compact ? 9 : 10,
                fontFamily: MONO,
                fontWeight: 700,
                color: evConf.color,
                letterSpacing: '0.5px',
                flexShrink: 0,
              }}
            >
              {evConf.label.toUpperCase()}
            </span>
            <span
              style={{
                fontSize: compact ? 10 : 11,
                fontFamily: MONO,
                fontWeight: 500,
                color: 'rgba(255,255,255,0.6)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {event.actor}
            </span>
          </div>
          <span
            style={{
              fontSize: compact ? 8 : 9,
              fontFamily: MONO,
              color: 'rgba(255,255,255,0.25)',
              flexShrink: 0,
            }}
          >
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>

        {/* Detail — hidden in compact mode if missing */}
        {(!compact || event.detail) && event.detail && (
          <div
            style={{
              fontSize: compact ? 10 : 11,
              color: 'rgba(255,255,255,0.35)',
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: compact ? 'nowrap' : 'normal',
            }}
          >
            {event.detail}
          </div>
        )}
      </div>
    </div>
  );
}

const AuditTrail = ({
  events = [],
  maxVisible = 8,
  compact = false,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState(null);

  // In compact mode, filter out heartbeat events before slicing
  const filtered = compact
    ? events.filter(e => e.type !== 'heartbeat')
    : events;
  const visible = filtered.slice(0, maxVisible);
  const totalCount = events.length;

  return (
    <div
      style={{
        width: compact ? 320 : 420,
        borderRadius: compact ? 10 : 14,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
        fontFamily: FONT,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: compact ? '6px 12px' : '10px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.01)',
        }}
      >
        <div
          style={{
            fontSize: compact ? 9 : 10,
            fontFamily: MONO,
            fontWeight: 700,
            letterSpacing: '1px',
            color: 'rgba(255,255,255,0.4)',
          }}
        >
          AUDIT TRAIL
        </div>
        <div
          style={{
            fontSize: compact ? 8 : 9,
            fontFamily: MONO,
            color: 'rgba(255,255,255,0.25)',
          }}
        >
          {totalCount} event{totalCount !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Events */}
      <div style={{ padding: compact ? '8px 12px' : '12px 16px' }}>
        {visible.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.2)',
              fontFamily: MONO,
              textAlign: 'center',
              padding: '12px 0',
            }}
          >
            No events recorded
          </div>
        )}
        {visible.map((event, i) => (
          <EventRow
            key={event.id || `${event.timestamp}-${i}`}
            event={event}
            isLast={i === visible.length - 1}
            compact={compact}
            hovered={hoveredIdx === i}
            onHover={() => setHoveredIdx(i)}
            onLeave={() => setHoveredIdx(null)}
          />
        ))}
        {filtered.length > maxVisible && (
          <div
            style={{
              fontSize: compact ? 9 : 10,
              fontFamily: MONO,
              color: 'rgba(255,255,255,0.2)',
              textAlign: 'center',
              paddingTop: compact ? 6 : 10,
            }}
          >
            +{filtered.length - maxVisible} more event{filtered.length - maxVisible !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
};

export default AuditTrail;
