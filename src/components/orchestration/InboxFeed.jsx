/**
 * InboxFeed — Scrolling inbox feed of approval/task items
 *
 * Adapted from quox-remotion/src/visuals-hitl/InboxFeed.jsx for production use.
 * All Remotion dependencies removed. Uses CSS transitions and real timestamps.
 *
 * Props:
 *   items      — [{title, kind, status, timestamp, agent, priority, unread}]
 *   maxVisible — max visible rows (default 6)
 *   compact    — boolean for smaller version
 *   onItemClick — optional callback(item)
 */
import React, { useState, useEffect, useRef } from 'react';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const FONT = "Inter, system-ui, sans-serif";

const KIND_CONFIG = {
  approval:          { color: '#3b82f6', icon: '\u25CF' },
  question:          { color: '#a855f7', icon: '\u25CF' },
  task:              { color: '#10b981', icon: '\u25CF' },
  incident:          { color: '#ef4444', icon: '\u25CF' },
  info:              { color: '#71717a', icon: '\u25CF' },
  override_required: { color: '#f59e0b', icon: '\u25CF' },
};

const PRIORITY_CONFIG = {
  urgent: { label: 'URG',  color: '#ef4444' },
  high:   { label: 'HIGH', color: '#f59e0b' },
  normal: { label: 'NORM', color: '#3b82f6' },
  low:    { label: 'LOW',  color: '#71717a' },
};

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const InboxFeed = ({
  items = [],
  maxVisible = 6,
  compact = false,
  onItemClick,
}) => {
  const [visible, setVisible] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  if (items.length === 0) return null;

  const rowHeight = compact ? 38 : 48;
  const unreadCount = items.filter(i => i.unread).length;

  return (
    <div style={{
      overflow: 'hidden',
      borderRadius: 14,
      background: 'rgba(255,255,255,0.015)',
      border: '1px solid rgba(255,255,255,0.06)',
      fontFamily: FONT,
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.4s ease-out',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: compact ? '8px 12px' : '10px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        background: 'rgba(255,255,255,0.02)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10, fontFamily: MONO, color: 'rgba(59,130,246,0.56)',
            letterSpacing: '2px', fontWeight: 700,
          }}>
            INBOX
          </span>
          {unreadCount > 0 && (
            <span style={{
              fontSize: 9, fontFamily: MONO, fontWeight: 700,
              padding: '1px 6px', borderRadius: 8,
              background: 'rgba(59,130,246,0.13)', color: '#3b82f6',
            }}>
              {unreadCount}
            </span>
          )}
        </div>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          backgroundColor: '#3b82f6', opacity: 0.8,
        }} />
      </div>

      {/* Scrollable rows */}
      <div
        ref={scrollRef}
        style={{
          maxHeight: maxVisible * rowHeight,
          overflowY: items.length > maxVisible ? 'auto' : 'hidden',
        }}
      >
        {items.map((item, i) => {
          const kindCfg = KIND_CONFIG[item.kind] || KIND_CONFIG.info;
          const priCfg = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG.normal;
          const isUnread = item.unread;

          return (
            <div
              key={i}
              onClick={() => onItemClick?.(item)}
              style={{
                display: 'flex', alignItems: 'center',
                padding: compact ? '0 12px' : '0 16px',
                gap: compact ? 8 : 10,
                height: rowHeight,
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                background: isUnread ? 'rgba(255,255,255,0.02)' : 'transparent',
                borderLeft: isUnread ? `2px solid ${kindCfg.color}40` : '2px solid transparent',
                cursor: onItemClick ? 'pointer' : 'default',
                opacity: visible ? 1 : 0,
                transition: `opacity 0.3s ease-out ${i * 0.04}s, background 0.15s`,
              }}
              onMouseEnter={(e) => { if (onItemClick) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = isUnread ? 'rgba(255,255,255,0.02)' : 'transparent'; }}
            >
              {/* Kind dot */}
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                backgroundColor: kindCfg.color,
                opacity: isUnread ? 1 : 0.6,
                flexShrink: 0,
              }} />

              {/* Title */}
              <div style={{
                flex: 1, fontSize: compact ? 11 : 12,
                fontWeight: isUnread ? 600 : 400,
                color: isUnread ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {item.title}
              </div>

              {/* Priority badge */}
              {!compact && (
                <div style={{
                  fontSize: 8, fontFamily: MONO, fontWeight: 700,
                  padding: '1px 5px', borderRadius: 3,
                  background: `${priCfg.color}15`, color: priCfg.color,
                  letterSpacing: '0.5px', flexShrink: 0,
                }}>
                  {priCfg.label}
                </div>
              )}

              {/* Agent/source */}
              {item.agent && !compact && (
                <div style={{
                  fontSize: 9, fontFamily: MONO, color: kindCfg.color,
                  opacity: 0.7, width: 55, textAlign: 'right', flexShrink: 0,
                  textTransform: 'uppercase',
                }}>
                  {item.agent}
                </div>
              )}

              {/* Time */}
              <div style={{
                fontSize: 9, fontFamily: MONO, color: 'rgba(255,255,255,0.6)',
                width: 24, textAlign: 'right', flexShrink: 0,
              }}>
                {formatTimeAgo(item.timestamp)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default InboxFeed;
