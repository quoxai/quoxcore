/**
 * AgentHandoffDetail - Handoff detail panel
 *
 * Shows handoff context, data passed between agents, and timing.
 * Part of AOCL Compliance Suite (Enterprise)
 */

export default function AgentHandoffDetail({ handoff, onClose }) {
  if (!handoff) return null

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}m`
  }

  const formatTime = (ts) => {
    return new Date(ts).toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    })
  }

  const getTypeLabel = (type) => {
    switch (type) {
      case 'delegate':
        return 'Delegation'
      case 'sequential':
        return 'Sequential'
      case 'parallel':
        return 'Parallel'
      case 'callback':
        return 'Callback'
      default:
        return type || 'Unknown'
    }
  }

  const getTypeDescription = (type) => {
    switch (type) {
      case 'delegate':
        return 'Source agent delegated work to target agent'
      case 'sequential':
        return 'Target agent started after source completed'
      case 'parallel':
        return 'Agents ran concurrently with coordination'
      case 'callback':
        return 'Target agent returning result to source'
      default:
        return 'Agent-to-agent communication'
    }
  }

  return (
    <div className="handoff-detail-panel">
      <div className="handoff-detail-header">
        <h4>Handoff Detail</h4>
        <button className="close-btn" onClick={onClose}>X</button>
      </div>

      <div className="handoff-detail-content">
        {/* Flow visualization */}
        <div className="handoff-flow">
          <div className="flow-agent flow-from">
            <span className="agent-icon">[A]</span>
            <span className="agent-name">{handoff.fromAgent}</span>
            <span className="agent-role">Source</span>
          </div>

          <div className="flow-arrow">
            <div className="arrow-body">
              <span className="handoff-type-badge">{getTypeLabel(handoff.type)}</span>
            </div>
            <div className="arrow-tip" />
          </div>

          <div className="flow-agent flow-to">
            <span className="agent-icon">[A]</span>
            <span className="agent-name">{handoff.toAgent}</span>
            <span className="agent-role">Target</span>
          </div>
        </div>

        {/* Details */}
        <div className="handoff-details">
          <div className="detail-row">
            <span className="detail-label">Type</span>
            <span className="detail-value">{getTypeLabel(handoff.type)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Description</span>
            <span className="detail-value detail-desc">{getTypeDescription(handoff.type)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Timestamp</span>
            <span className="detail-value">{formatTime(handoff.timestamp)}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Latency</span>
            <span className={`detail-value ${handoff.latency > 1000 ? 'latency-high' : ''}`}>
              {formatDuration(handoff.latency)}
              {handoff.latency > 1000 && <span className="latency-warning"> (high)</span>}
            </span>
          </div>
        </div>

        {/* Run IDs */}
        <div className="handoff-runs">
          <div className="run-ref">
            <span className="run-label">From Run</span>
            <code className="run-id">{handoff.fromRunId}</code>
          </div>
          <div className="run-ref">
            <span className="run-label">To Run</span>
            <code className="run-id">{handoff.toRunId}</code>
          </div>
        </div>

        {/* Context data (if available) */}
        {handoff.context && (
          <div className="handoff-context">
            <h5>Handoff Context</h5>
            <pre className="context-json">
              {JSON.stringify(handoff.context, null, 2)}
            </pre>
          </div>
        )}

        {/* Payload preview (if available) */}
        {handoff.payload && (
          <div className="handoff-payload">
            <h5>Payload Passed</h5>
            <pre className="payload-json">
              {JSON.stringify(handoff.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="handoff-detail-actions">
        <button
          className="action-btn"
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(handoff, null, 2))
          }}
        >
          Copy JSON
        </button>
        <button
          className="action-btn"
          onClick={() => {
            // Could link to trace view for the source run
            console.log('View source trace:', handoff.fromRunId)
          }}
        >
          View Source
        </button>
        <button
          className="action-btn"
          onClick={() => {
            // Could link to trace view for the target run
            console.log('View target trace:', handoff.toRunId)
          }}
        >
          View Target
        </button>
      </div>
    </div>
  )
}
