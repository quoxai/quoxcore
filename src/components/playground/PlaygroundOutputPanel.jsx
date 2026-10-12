/**
 * PlaygroundOutputPanel - Output display for layer execution results
 *
 * Shows result, timing, and emitted events from layer execution.
 * Part of AOCL Developer Kit (Free)
 */

import { useState } from 'react'
import { AOCL_LAYERS } from '../../lib/aee'

export default function PlaygroundOutputPanel({ result, isExecuting }) {
  const [activeSection, setActiveSection] = useState('result')

  if (isExecuting) {
    return (
      <div className="playground-output-panel">
        <div className="output-loading">
          <div className="loading-spinner" />
          <span>Executing layer...</span>
        </div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="playground-output-panel">
        <div className="output-empty">
          <p>No output yet</p>
          <p className="hint">Configure input and execute the layer to see results</p>
        </div>
      </div>
    )
  }

  const layerDef = AOCL_LAYERS[result.layerId]

  return (
    <div className="playground-output-panel">
      {/* Status Banner */}
      <div className={`output-status ${result.success ? 'success' : 'error'}`}>
        <div className="status-icon">
          {result.success ? '[OK]' : '[ERR]'}
        </div>
        <div className="status-details">
          <span className="status-layer">
            <span
              className="layer-dot"
              style={{ backgroundColor: layerDef?.color || '#666' }}
            />
            {result.layerId} - {result.layerName || layerDef?.label}
          </span>
          <span className="status-timing">
            {result.timing?.duration_ms}ms
          </span>
        </div>
        {result.error && (
          <div className="status-error">{result.error}</div>
        )}
      </div>

      {/* Section Tabs */}
      <div className="output-tabs">
        <button
          className={`output-tab ${activeSection === 'result' ? 'active' : ''}`}
          onClick={() => setActiveSection('result')}
        >
          Result
        </button>
        <button
          className={`output-tab ${activeSection === 'timing' ? 'active' : ''}`}
          onClick={() => setActiveSection('timing')}
        >
          Timing
        </button>
        <button
          className={`output-tab ${activeSection === 'events' ? 'active' : ''}`}
          onClick={() => setActiveSection('events')}
        >
          Events ({result.events?.length || 0})
        </button>
        <button
          className={`output-tab ${activeSection === 'raw' ? 'active' : ''}`}
          onClick={() => setActiveSection('raw')}
        >
          Raw JSON
        </button>
      </div>

      {/* Section Content */}
      <div className="output-content">
        {activeSection === 'result' && (
          <ResultSection result={result} />
        )}

        {activeSection === 'timing' && (
          <TimingSection result={result} />
        )}

        {activeSection === 'events' && (
          <EventsSection events={result.events} />
        )}

        {activeSection === 'raw' && (
          <RawJsonSection result={result} />
        )}
      </div>
    </div>
  )
}

function ResultSection({ result }) {
  if (!result.result) {
    return <div className="section-empty">No result data</div>
  }

  const data = result.result

  return (
    <div className="result-section">
      {/* Status */}
      <div className="result-row">
        <span className="result-label">Status</span>
        <span className={`result-value status-badge ${data.status}`}>
          {data.status}
        </span>
      </div>

      {/* Layer-specific rendering */}
      {data.handled !== undefined && (
        <div className="result-row">
          <span className="result-label">Handled</span>
          <span className={`result-value ${data.handled ? 'yes' : 'no'}`}>
            {data.handled ? 'Yes' : 'No'}
          </span>
        </div>
      )}

      {data.allowed !== undefined && (
        <div className="result-row">
          <span className="result-label">Allowed</span>
          <span className={`result-value ${data.allowed ? 'yes' : 'no'}`}>
            {data.allowed ? 'Yes' : 'No'}
          </span>
        </div>
      )}

      {data.valid !== undefined && (
        <div className="result-row">
          <span className="result-label">Valid</span>
          <span className={`result-value ${data.valid ? 'yes' : 'no'}`}>
            {data.valid ? 'Yes' : 'No'}
          </span>
        </div>
      )}

      {data.confidence !== undefined && (
        <div className="result-row">
          <span className="result-label">Confidence</span>
          <span className="result-value">{(data.confidence * 100).toFixed(1)}%</span>
        </div>
      )}

      {data.handler && (
        <div className="result-row">
          <span className="result-label">Handler</span>
          <span className="result-value">{data.handler}</span>
        </div>
      )}

      {data.pattern && (
        <div className="result-row">
          <span className="result-label">Pattern</span>
          <span className="result-value code">{data.pattern}</span>
        </div>
      )}

      {data.reason && (
        <div className="result-row full-width">
          <span className="result-label">Reason</span>
          <span className="result-value">{data.reason}</span>
        </div>
      )}

      {/* Checks (for L3, L8) */}
      {data.checks && (
        <div className="result-checks">
          <span className="result-label">Checks</span>
          <div className="checks-list">
            {data.checks.map((check, i) => (
              <div key={i} className={`check-item ${check.passed ? 'passed' : 'failed'}`}>
                <span className="check-icon">{check.passed ? '[v]' : '[x]'}</span>
                <span className="check-name">{check.name}</span>
                {check.details && <span className="check-details">{check.details}</span>}
                {check.score !== undefined && (
                  <span className="check-score">{(check.score * 100).toFixed(0)}%</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Warnings (for L8) */}
      {data.warnings && data.warnings.length > 0 && (
        <div className="result-warnings">
          <span className="result-label">Warnings</span>
          <div className="warnings-list">
            {data.warnings.map((warning, i) => (
              <div key={i} className="warning-item">{warning}</div>
            ))}
          </div>
        </div>
      )}

      {/* Items (for L5) */}
      {data.items && (
        <div className="result-items">
          <span className="result-label">Retrieved Items ({data.itemCount})</span>
          <div className="items-list">
            {data.items.map((item, i) => (
              <div key={i} className="item-card">
                <div className="item-header">
                  <span className="item-type">{item.type}</span>
                  <span className="item-relevance">{(item.relevance * 100).toFixed(0)}%</span>
                </div>
                <div className="item-content">{item.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Response (for L7) */}
      {data.response && (
        <div className="result-response">
          <span className="result-label">Response</span>
          <div className="response-content">{data.response}</div>
          {data.usage && (
            <div className="usage-stats">
              <span>Input: {data.usage.inputTokens} tokens</span>
              <span>Output: {data.usage.outputTokens} tokens</span>
              <span>Total: {data.usage.totalTokens} tokens</span>
            </div>
          )}
        </div>
      )}

      {/* Transformations */}
      {data.transformations && (
        <div className="result-row full-width">
          <span className="result-label">Transformations</span>
          <div className="transformations-list">
            {data.transformations.map((t, i) => (
              <span key={i} className="transformation-badge">{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TimingSection({ result }) {
  const timing = result.timing

  if (!timing) {
    return <div className="section-empty">No timing data</div>
  }

  return (
    <div className="timing-section">
      <div className="timing-chart">
        <div className="timing-bar">
          <div
            className="timing-fill"
            style={{ width: `${Math.min(timing.duration_ms / 10, 100)}%` }}
          />
          <span className="timing-value">{timing.duration_ms}ms</span>
        </div>
      </div>

      <div className="timing-details">
        <div className="timing-row">
          <span className="timing-label">Start Time</span>
          <span className="timing-value">{formatTime(timing.startTime)}</span>
        </div>
        <div className="timing-row">
          <span className="timing-label">End Time</span>
          <span className="timing-value">{formatTime(timing.endTime)}</span>
        </div>
        <div className="timing-row">
          <span className="timing-label">Duration</span>
          <span className="timing-value highlight">{timing.duration_ms}ms</span>
        </div>
      </div>

      {/* Latency breakdown for L7 */}
      {result.result?.latency && (
        <div className="latency-breakdown">
          <h5>Latency Breakdown</h5>
          <div className="latency-row">
            <span className="latency-label">Time to First Token</span>
            <span className="latency-value">{result.result.latency.ttft?.toFixed(0)}ms</span>
          </div>
          <div className="latency-row">
            <span className="latency-label">Total Response Time</span>
            <span className="latency-value">{result.result.latency.total?.toFixed(0)}ms</span>
          </div>
        </div>
      )}
    </div>
  )
}

function EventsSection({ events }) {
  if (!events || events.length === 0) {
    return <div className="section-empty">No events emitted</div>
  }

  return (
    <div className="events-section">
      <div className="events-timeline">
        {events.map((event, i) => (
          <div key={i} className="event-item">
            <div className="event-marker" />
            <div className="event-content">
              <div className="event-header">
                <span className="event-intent">{event.intent}</span>
                <span className="event-time">
                  {new Date(event.ts).toLocaleTimeString()}
                </span>
              </div>
              <div className="event-payload">
                <code>{JSON.stringify(event.payload, null, 2)}</code>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function RawJsonSection({ result }) {
  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(result, null, 2))
  }

  return (
    <div className="raw-json-section">
      <div className="raw-json-actions">
        <button className="copy-btn" onClick={copyToClipboard}>
          Copy JSON
        </button>
      </div>
      <pre className="raw-json-content">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  )
}

function formatTime(isoString) {
  if (!isoString) return '-'
  return new Date(isoString).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}
