/**
 * CommandStream — Live scrolling event feed for execution monitoring
 *
 * Adapted from quox-remotion v4 reference. Remotion deps removed.
 * Accepts real SSE events from useObjectivesStream.
 *
 * @param {Array} events — [{ time, level, source, message }] newest first
 * @param {number} maxVisible — max visible entries (default 12)
 * @param {boolean} showIcons — show severity icons (default true)
 * @param {'feed'|'compact'} variant — display mode
 */

import { useRef, useEffect } from 'react'

const LEVEL_CONFIG = {
  info:    { icon: '\u25CF', color: '#38bdf8' },
  success: { icon: '\u2713', color: '#30ff90' },
  warning: { icon: '\u26A0', color: '#f59e0b' },
  error:   { icon: '\u2715', color: '#ef4444' },
  agent:   { icon: '\u25C8', color: '#a855f7' },
  audit:   { icon: '\u25C6', color: '#06b6d4' },
  task:    { icon: '\u25B6', color: '#3b82f6' },
  heartbeat: { icon: '\u2665', color: '#71717a' },
}

function formatTime(ts) {
  if (!ts) return '--:--:--'
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-GB', { hour12: false })
  } catch { return '--:--:--' }
}

export default function CommandStream({ events = [], maxVisible = 12, showIcons = true, variant = 'feed' }) {
  const scrollRef = useRef(null)
  const isCompact = variant === 'compact'
  const lineHeight = isCompact ? 28 : 36

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0 // newest at top
    }
  }, [events.length])

  const visible = events.slice(0, maxVisible)

  return (
    <div style={{
      width: '100%',
      background: 'rgba(0,0,0,0.3)',
      borderRadius: 6,
      overflow: 'hidden',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: isCompact ? 10 : 11,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontSize: 10, fontWeight: 600,
        color: 'rgba(255,255,255,0.5)',
        textTransform: 'uppercase', letterSpacing: 0.5,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: events.length > 0 ? '#30ff90' : '#71717a', animation: events.length > 0 ? 'cmdPulse 2s ease-in-out infinite' : 'none' }} />
        Live Events
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.3)' }}>
          {events.length}
        </span>
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        style={{
          maxHeight: maxVisible * lineHeight,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {visible.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>
            Waiting for events...
          </div>
        )}

        {visible.map((evt, i) => {
          const cfg = LEVEL_CONFIG[evt.level] || LEVEL_CONFIG.info
          const isNewest = i === 0
          const isError = evt.level === 'error'

          return (
            <div
              key={`${evt.time}-${i}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: isCompact ? '3px 10px' : '5px 10px',
                minHeight: lineHeight,
                background: isError
                  ? 'rgba(239,68,68,0.06)'
                  : isNewest
                    ? 'rgba(255,255,255,0.03)'
                    : i % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent',
                borderLeft: isNewest ? `2px solid ${cfg.color}` : '2px solid transparent',
                transition: 'background 0.15s',
              }}
            >
              {/* Icon */}
              {showIcons && (
                <span style={{
                  fontSize: isCompact ? 10 : 13,
                  color: cfg.color,
                  flexShrink: 0,
                  width: 16,
                  textAlign: 'center',
                  textShadow: isNewest ? `0 0 6px ${cfg.color}40` : 'none',
                }}>
                  {cfg.icon}
                </span>
              )}

              {/* Time */}
              <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: isCompact ? 9 : 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {formatTime(evt.time)}
              </span>

              {/* Source badge */}
              <span style={{
                padding: '1px 5px', borderRadius: 3,
                background: `${cfg.color}15`,
                color: cfg.color,
                fontSize: isCompact ? 8 : 9,
                fontWeight: 600,
                flexShrink: 0,
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {evt.source}
              </span>

              {/* Message */}
              <span style={{
                color: isError ? '#fca5a5' : 'rgba(255,255,255,0.8)',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {evt.message}
              </span>

              {/* Severity pip */}
              <span style={{
                width: 4, height: 4, borderRadius: '50%',
                background: cfg.color, opacity: 0.5, flexShrink: 0,
              }} />
            </div>
          )
        })}
      </div>

      <style>{`
        @keyframes cmdPulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  )
}
