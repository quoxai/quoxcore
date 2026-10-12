/**
 * VoltSwimlane — Events grouped by actor in horizontal lanes
 *
 * Each actor gets a horizontal lane with label.
 * Events positioned as bars within their actor's track.
 */

import { useMemo } from 'react'

const EVENT_COLORS = {
  'run.started':              '#34d399',
  'run.completed':            '#34d399',
  'aee.envelope.received':    '#38bdf8',
  'aee.envelope.sent':        '#6366f1',
  'tool.call.requested':      '#fbbf24',
  'tool.call.executed':       '#fbbf24',
  'model.responded':          '#a78bfa',
  'aocl.policy.evaluated':    '#a855f7',
  'hitl.requested':           '#f97316',
  'hitl.approved':            '#22c55e',
  'hitl.denied':              '#ef4444',
  'credential.accessed':      '#ef4444',
}

const DEFAULT_COLOR = '#64748b'

export default function VoltSwimlane({ events = [], onSelectEvent }) {
  const { lanes, totalDuration } = useMemo(() => {
    if (events.length === 0) return { lanes: [], totalDuration: 0 }

    const start = new Date(events[0].ts).getTime()
    const end = new Date(events[events.length - 1].ts).getTime()
    const duration = Math.max(end - start, 1)

    // Group events by actor
    const actorMap = new Map()
    for (const evt of events) {
      const actorId = evt.actor?.actor_id || evt.actor?.actor_type || 'unknown'
      if (!actorMap.has(actorId)) actorMap.set(actorId, [])
      actorMap.get(actorId).push(evt)
    }

    const computed = []
    for (const [actorId, actorEvents] of actorMap) {
      const bars = actorEvents.map((evt, i) => {
        const evtTime = new Date(evt.ts).getTime()
        const nextTime = i < actorEvents.length - 1
          ? new Date(actorEvents[i + 1].ts).getTime()
          : evtTime + duration * 0.02
        const offsetPct = ((evtTime - start) / duration) * 100
        const widthPct = Math.max(((nextTime - evtTime) / duration) * 100, 2)

        return { evt, offsetPct, widthPct }
      })
      computed.push({ actorId, bars })
    }

    return { lanes: computed, totalDuration: duration }
  }, [events])

  if (events.length === 0) {
    return (
      <div className="volt-state">
        <div className="volt-state__text">No events to display.</div>
      </div>
    )
  }

  return (
    <div className="volt-swimlane" role="img" aria-label="Actor swimlane timeline">
      {lanes.map(({ actorId, bars }) => (
        <div key={actorId} className="volt-swimlane__lane">
          <span className="volt-swimlane__actor" title={actorId}>
            {actorId}
          </span>
          <div className="volt-swimlane__track">
            {bars.map(({ evt, offsetPct, widthPct }) => (
              <div
                key={evt.event_id}
                className="volt-swimlane__bar"
                style={{
                  left: `${offsetPct}%`,
                  width: `${widthPct}%`,
                  background: EVENT_COLORS[evt.event_type] || DEFAULT_COLOR,
                }}
                title={`#${evt.seq} ${evt.event_type}`}
                onClick={() => onSelectEvent?.(evt)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
