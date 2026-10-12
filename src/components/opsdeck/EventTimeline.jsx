/**
 * EventTimeline — Horizontal event strip at the bottom of OpsDeck canvas
 *
 * Shows last 50 events as coloured pills with auto-scrolling.
 * Click a pill to highlight the associated agent on the canvas.
 */

import { useRef, useState, useEffect } from 'react'

const DOT_CLASS_MAP = {
  task_started: 'opsdeck-timeline__dot--started',
  task_completed: 'opsdeck-timeline__dot--completed',
  task_failed: 'opsdeck-timeline__dot--failed',
  task_skipped: 'opsdeck-timeline__dot--skipped',
  decomposition_completed: 'opsdeck-timeline__dot--decomposition',
  objective_completed: 'opsdeck-timeline__dot--objective-done',
  objective_failed: 'opsdeck-timeline__dot--failed',
}

function relativeTime(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function truncate(str, max = 20) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '\u2026' : str
}

export default function EventTimeline({ events = [], onHighlightAgent }) {
  const lastPillRef = useRef(null)
  const [, setTick] = useState(0)

  // Update relative timestamps every second
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-scroll to newest event
  useEffect(() => {
    if (lastPillRef.current) {
      lastPillRef.current.scrollIntoView({ behavior: 'smooth', inline: 'end' })
    }
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className="opsdeck-timeline">
        <span className="opsdeck-timeline__empty">No events yet</span>
      </div>
    )
  }

  // Display oldest-first so newest is on the right
  const ordered = [...events].reverse()

  return (
    <div className="opsdeck-timeline">
      {ordered.map((evt, i) => (
        <div
          key={evt.id}
          className="opsdeck-timeline__pill"
          ref={i === ordered.length - 1 ? lastPillRef : null}
          onClick={() => evt.agentId && onHighlightAgent?.(evt.agentId)}
          title={`${evt.type}: ${evt.title || evt.agentName || ''}`}
        >
          <span className={`opsdeck-timeline__dot ${DOT_CLASS_MAP[evt.type] || ''}`} />
          <span>{truncate(evt.title || evt.agentName || evt.type)}</span>
          <span className="opsdeck-timeline__ts">{relativeTime(evt.ts)}</span>
        </div>
      ))}
    </div>
  )
}
