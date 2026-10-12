/**
 * VoltWaterfall — APM-style horizontal bar timeline
 *
 * Each event renders as a positioned bar colored by event_type.
 * Pill tabs toggle between Waterfall and Swimlane views.
 * Time scale markers at bottom.
 */

import { useState, useMemo } from 'react'
import { Tabs, Tab, TabPanel } from '../ui/Tabs'
import VoltSwimlane from './VoltSwimlane'

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

function getBarColor(eventType) {
  return EVENT_COLORS[eventType] || DEFAULT_COLOR
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export default function VoltWaterfall({ events = [], onSelectEvent }) {
  const [viewTab, setViewTab] = useState('waterfall')
  const [hoveredIdx, setHoveredIdx] = useState(null)

  const { bars, totalDuration, runStart } = useMemo(() => {
    if (events.length === 0) return { bars: [], totalDuration: 0, runStart: 0 }

    const start = new Date(events[0].ts).getTime()
    const end = new Date(events[events.length - 1].ts).getTime()
    const duration = Math.max(end - start, 1)

    const computed = events.map((evt, i) => {
      const evtTime = new Date(evt.ts).getTime()
      const nextTime = i < events.length - 1
        ? new Date(events[i + 1].ts).getTime()
        : evtTime + duration * 0.02
      const offsetPct = ((evtTime - start) / duration) * 100
      const widthPct = Math.max(((nextTime - evtTime) / duration) * 100, 2)
      const durationMs = nextTime - evtTime

      return { evt, offsetPct, widthPct, durationMs }
    })

    return { bars: computed, totalDuration: duration, runStart: start }
  }, [events])

  if (events.length === 0) {
    return (
      <div className="volt-state">
        <div className="volt-state__text">No events to display.</div>
      </div>
    )
  }

  const midpoint = totalDuration / 2

  return (
    <div className="volt-waterfall">
      {/* View toggle */}
      <div className="volt-waterfall__toggle">
        <Tabs value={viewTab} onChange={setViewTab} variant="pill" size="sm">
          <Tab value="waterfall">Waterfall</Tab>
          <Tab value="swimlane">Swimlane</Tab>
        </Tabs>
      </div>

      <TabPanel value="waterfall" activeValue={viewTab}>
        <div className="volt-waterfall__chart" role="img" aria-label="Event waterfall timeline">
          {bars.map(({ evt, offsetPct, widthPct, durationMs }, i) => {
            const color = getBarColor(evt.event_type)
            const isHovered = hoveredIdx === i

            return (
              <div
                key={evt.event_id}
                className={`volt-waterfall__row${isHovered ? ' volt-waterfall__row--hover' : ''}`}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => onSelectEvent?.(evt)}
              >
                <span className="volt-waterfall__seq">#{evt.seq}</span>
                <span className="volt-waterfall__type" title={evt.event_type}>
                  {evt.event_type}
                </span>
                <div className="volt-waterfall__track">
                  <div
                    className="volt-waterfall__bar"
                    style={{
                      left: `${offsetPct}%`,
                      width: `${widthPct}%`,
                      background: color,
                    }}
                  />
                </div>
                <span className="volt-waterfall__duration">
                  {formatDuration(durationMs)}
                </span>

                {/* Tooltip */}
                {isHovered && (
                  <div className="volt-waterfall__tooltip">
                    <div className="volt-waterfall__tooltip-type">{evt.event_type}</div>
                    <div className="volt-waterfall__tooltip-actor">
                      {evt.actor?.actor_id || evt.actor?.actor_type || '—'}
                    </div>
                    <div className="volt-waterfall__tooltip-time">
                      {new Date(evt.ts).toLocaleTimeString()}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Time scale */}
          <div className="volt-waterfall__scale">
            <span>0ms</span>
            <span>{formatDuration(midpoint)}</span>
            <span>{formatDuration(totalDuration)}</span>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="swimlane" activeValue={viewTab}>
        <VoltSwimlane events={events} onSelectEvent={onSelectEvent} />
      </TabPanel>
    </div>
  )
}
