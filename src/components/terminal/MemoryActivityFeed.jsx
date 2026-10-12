/**
 * MemoryActivityFeed
 *
 * Collapsible feed showing real-time memory bridge activity
 * in the terminal chat sidebar. Makes the invisible visible —
 * users SEE entities being learned, errors tracked, and
 * resolutions stored as they happen.
 */

import { useRef, useEffect } from 'react'
import { EVENT_TYPES } from '../../services/memoryActivityEmitter'
import './MemoryActivityFeed.css'

// Event type → display config
const EVENT_CONFIG = {
  [EVENT_TYPES.ENTITY_STORED]: {
    color: 'entity',
    label: (d) => `${d.type}:${d.name}`,
  },
  [EVENT_TYPES.SESSION_START]: {
    color: 'session',
    label: (d) => `Session on ${d.hostId}`,
  },
  [EVENT_TYPES.SESSION_END]: {
    color: 'session',
    label: () => 'Session ended',
  },
  [EVENT_TYPES.ERROR_TRACKED]: {
    color: 'error',
    label: (d) => `Error: ${d.errorType}`,
  },
  [EVENT_TYPES.RESOLUTION_STORED]: {
    color: 'premium',
    label: (d) => `Resolution: ${d.errorType}`,
  },
  [EVENT_TYPES.COMMAND_RECORDED]: {
    color: 'premium',
    label: (d) => `Command recorded`,
  },
  [EVENT_TYPES.FOCUS_UPDATED]: {
    color: 'premium',
    label: (d) => `Focus: ${d.workspace}`,
  },
  [EVENT_TYPES.UPGRADE_BLOCKED]: {
    color: 'upgrade',
    label: (d) => `${d.feature}: unlock with Advanced Memory`,
  },
}

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function MemoryActivityFeed({ events, isCollapsed, toggleCollapsed, eventCount, clearEvents }) {
  const listRef = useRef(null)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (!isCollapsed && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [events.length, isCollapsed])

  if (eventCount === 0 && isCollapsed) return null

  return (
    <div className="memory-feed">
      <button className="memory-feed__toggle" onClick={toggleCollapsed} title="Memory Activity Feed">
        <svg className="memory-feed__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
          <path d="M9 21h6" />
          <path d="M10 21v1a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-1" />
        </svg>
        <span className="memory-feed__label">Memory</span>
        {eventCount > 0 && (
          <span className="memory-feed__count">{eventCount}</span>
        )}
        <svg className={`memory-feed__chevron ${isCollapsed ? '' : 'memory-feed__chevron--open'}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!isCollapsed && (
        <div className="memory-feed__list" ref={listRef}>
          {events.length === 0 ? (
            <div className="memory-feed__empty">No memory activity yet</div>
          ) : (
            events.map((event, i) => {
              const config = EVENT_CONFIG[event.type]
              if (!config) return null
              return (
                <div key={`${event.timestamp}-${i}`} className="memory-feed__item">
                  <span className="memory-feed__time">{formatTime(event.timestamp)}</span>
                  <span className={`memory-feed__dot memory-feed__dot--${config.color}`} />
                  <span className={`memory-feed__text memory-feed__text--${config.color}`}>
                    {config.label(event.detail || {})}
                  </span>
                  {event.isPremium && (
                    <span className="memory-feed__badge">premium</span>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
