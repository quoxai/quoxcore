/**
 * FullTraceView — End-to-end trace across all layers
 *
 * Takes a correlation ID and shows the entire chain:
 * user → agent → workflow → bastion → host → evidence
 *
 * CLI-3.5B3 (Stream CLI Phase 3.5)
 */

import './FullTraceView.css'

function getLayerClass(from) {
  if (!from) return 'trace-event--unknown'
  if (from.startsWith('human')) return 'trace-event--human'
  if (from.startsWith('agent')) return 'trace-event--agent'
  if (from === 'bastion') return 'trace-event--bastion'
  if (from.startsWith('workflow') || from.startsWith('quoxflow')) return 'trace-event--workflow'
  return 'trace-event--system'
}

function getEventSummary(event) {
  const p = event.payload || {}
  if (p.text) return p.text
  if (p.command) return `$ ${p.command}`
  if (p.tool_name) return `${p.tool_name} ${p.success ? '✓' : '✗'} ${p.duration_ms ? `(${p.duration_ms}ms)` : ''}`
  if (p.target_agent) return `→ ${p.target_agent}: ${p.reason || ''}`
  return event.intent || event.type
}

function formatTime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toISOString().slice(11, 19) // HH:MM:SS
  } catch {
    return ts
  }
}

export default function FullTraceView({ trace, loading }) {
  if (loading) {
    return (
      <div className="full-trace full-trace--loading">
        <span>Loading trace...</span>
      </div>
    )
  }

  if (!trace) {
    return (
      <div className="full-trace full-trace--empty">
        <span>No trace data</span>
      </div>
    )
  }

  const events = trace.events || []

  return (
    <div className="full-trace">
      <div className="trace-header">
        <span className="trace-corr-id">{trace.correlationId}</span>
        <span className="trace-event-count">{events.length} events</span>
      </div>

      {events.length === 0 ? (
        <div className="trace-empty">No events in this trace</div>
      ) : (
        <div className="trace-timeline">
          {events.map((event, i) => (
            <div key={event.id || i} className={`trace-event ${getLayerClass(event.from)}`}>
              <span className="trace-event-time">{formatTime(event.ts)}</span>
              <span className="trace-event-line" />
              <div className="trace-event-body">
                <span className="trace-event-from">{event.from}</span>
                <span className="trace-event-summary">{getEventSummary(event)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
