/**
 * EnvelopeCard - Single envelope display
 *
 * Renders an AEE envelope with role-based styling, optional dev info,
 * and verbosity levels. Clickable to view raw detail.
 */

import { getIntentMetadata, getEnvelopeSummary } from '../../lib/aee'
import { deriveSeverity } from '../../lib/aee/envelopeSeverity'
import { getIntentLabel } from '../../lib/aee/intentLabels'
import DecisionEvidenceCard from './DecisionEvidenceCard'

const SEVERITY_SHORT_LABEL = { critical: 'CRIT', warn: 'WARN', info: 'INFO', debug: 'DEBUG' }

/**
 * Determine sender role for visual styling
 */
function getSenderRole(envelope) {
  if (envelope.from?.startsWith('human')) return 'user'
  if (envelope.intent?.startsWith('aocl.')) return 'system'
  if (envelope.from?.startsWith('agent')) return 'agent'
  if (envelope.from?.startsWith('quoxagent')) return 'agent'
  return 'other'
}

/**
 * Get intent category for badge coloring
 */
function getIntentCategory(intent) {
  if (!intent) return ''
  if (intent.startsWith('aocl.')) return 'intent-aocl'
  if (intent.includes('chat')) return 'intent-chat'
  if (intent.includes('test')) return 'intent-testing'
  if (intent.includes('ops') || intent.includes('operation')) return 'intent-ops'
  if (intent.includes('agent.think')) return 'intent-agentic'
  if (intent.includes('quoxagent') || intent.includes('mha')) return 'intent-agent'
  if (intent.includes('aee')) return 'intent-protocol'
  return ''
}

/**
 * Format relative time for display
 */
function formatRelativeTime(ts) {
  const date = new Date(ts)
  const now = new Date()
  const diff = now - date

  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Format sender name for display (strip prefix)
 */
function formatSender(from) {
  if (!from) return 'unknown'
  // human.adam -> Adam, agent.cipher -> Cipher
  const parts = from.split('.')
  if (parts.length > 1) {
    return parts.slice(1).join('.').replace(/^\w/, c => c.toUpperCase())
  }
  return from
}

export default function EnvelopeCard({
  envelope,
  compact = false,
  showDevInfo = false,
  verbosity = 'normal',
  onViewDetail
}) {
  const meta = getIntentMetadata(envelope.intent)
  const role = getSenderRole(envelope)
  const intentCategory = getIntentCategory(envelope.intent)
  const severity = deriveSeverity(envelope)
  const intentLabel = getIntentLabel(envelope)

  const getTypeClass = (type) => {
    switch (type) {
      case 'task': return 'type-task'
      case 'result': return 'type-result'
      case 'event': return 'type-event'
      case 'error': return 'type-error'
      case 'stream': return 'type-stream'
      default: return ''
    }
  }

  // Compact mode -- minimal inline display
  if (compact) {
    return (
      <div
        className={`envelope-card compact ${getTypeClass(envelope.type)} role-${role} severity-${severity}`}
        onClick={() => onViewDetail?.(envelope)}
      >
        <span className={`severity-chip severity-${severity}`}>{SEVERITY_SHORT_LABEL[severity]}</span>
        <span className="envelope-sender">{formatSender(envelope.from)}</span>
        <span className={`intent-badge ${intentCategory}`}>{intentLabel}</span>
        <time className="envelope-time" title={new Date(envelope.ts).toLocaleString()}>
          {formatRelativeTime(envelope.ts)}
        </time>
      </div>
    )
  }

  // Minimal verbosity -- one-line summary
  if (verbosity === 'minimal') {
    return (
      <div
        className={`envelope-card minimal ${getTypeClass(envelope.type)} role-${role} severity-${severity}`}
        onClick={() => onViewDetail?.(envelope)}
      >
        <span className={`severity-chip severity-${severity}`}>{SEVERITY_SHORT_LABEL[severity]}</span>
        <span className="envelope-sender">{formatSender(envelope.from)}</span>
        <span className="envelope-summary-text">{getEnvelopeSummary(envelope)}</span>
        <time className="envelope-time" title={new Date(envelope.ts).toLocaleString()}>
          {formatRelativeTime(envelope.ts)}
        </time>
      </div>
    )
  }

  // AOCL system event -- condensed display
  if (role === 'system') {
    const layer = envelope.payload?.layer || ''
    const status = envelope.payload?.status || ''
    const duration = envelope.payload?.duration_ms

    return (
      <div
        className={`envelope-card system-event ${getTypeClass(envelope.type)} role-system severity-${severity}`}
        onClick={() => onViewDetail?.(envelope)}
      >
        <div className="system-event-row">
          <span className={`severity-chip severity-${severity}`}>{SEVERITY_SHORT_LABEL[severity]}</span>
          {layer && <span className={`layer-badge layer-${layer}`}>{layer}</span>}
          <span className="system-event-label">{intentLabel}{status ? ` · ${status}` : ''}</span>
          {duration != null && <span className="system-event-duration">{duration}ms</span>}
          <time className="envelope-time" title={new Date(envelope.ts).toLocaleString()}>
            {formatRelativeTime(envelope.ts)}
          </time>
        </div>
      </div>
    )
  }

  // Normal / Verbose display
  return (
    <div
      className={`envelope-card ${getTypeClass(envelope.type)} role-${role} severity-${severity}`}
      onClick={() => onViewDetail?.(envelope)}
    >
      <div className="envelope-header">
        <span className={`severity-chip severity-${severity}`}>{SEVERITY_SHORT_LABEL[severity]}</span>
        <span className="envelope-sender">{formatSender(envelope.from)}</span>
        <span className="envelope-arrow">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </span>
        <span className="envelope-recipient">{formatSender(envelope.to)}</span>
        <span className={`intent-badge ${intentCategory}`} title={envelope.intent}>
          {meta.icon} {intentLabel}
        </span>
        <time className="envelope-time" title={new Date(envelope.ts).toLocaleString()}>
          {formatRelativeTime(envelope.ts)}
        </time>
      </div>

      {envelope.payload?.decision_evidence && (
        <DecisionEvidenceCard evidence={envelope.payload.decision_evidence} />
      )}

      {envelope.intent === 'quox.agent.think.decide' && envelope.payload?.reasoning && (
        <DecisionEvidenceCard evidence={{
          decision: envelope.payload.action || 'Decision',
          reason_summary: envelope.payload.reasoning,
          confidence: envelope.payload.confidence,
          action_taken: envelope.payload.action,
        }} />
      )}

      <div className="envelope-payload">
        {envelope.payload?.text ? (
          <p className="payload-text">
            {verbosity === 'verbose'
              ? envelope.payload.text
              : envelope.payload.text.length > 300
                ? envelope.payload.text.slice(0, 297) + '...'
                : envelope.payload.text}
          </p>
        ) : envelope.payload?.command ? (
          <code className="payload-command">$ {envelope.payload.command}</code>
        ) : envelope.payload?.output ? (
          <pre className="payload-output">
            {(() => {
              const out = envelope.payload.output;
              const str = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
              return verbosity === 'verbose' ? str : str.length > 200 ? str.slice(0, 197) + '...' : str;
            })()}
          </pre>
        ) : envelope.payload?.error_message ? (
          <p className="payload-error">{envelope.payload.error_message}</p>
        ) : null}
      </div>

      {envelope.type === 'error' && envelope.payload?.error_code && (
        <div className="envelope-error-info">
          <span className="error-code">{envelope.payload.error_code}</span>
        </div>
      )}

      {/* Dev info -- only shown when toggled */}
      {showDevInfo && (
        <div className="envelope-footer">
          <span className="envelope-id" title={envelope.id}>
            ID: {envelope.id?.slice(0, 10)}...
          </span>
          {envelope.reply_to && (
            <span className="envelope-reply-to" title={envelope.reply_to}>
              Reply to: {envelope.reply_to?.slice(0, 10)}...
            </span>
          )}
          <button
            className="view-detail-btn"
            onClick={(e) => {
              e.stopPropagation()
              onViewDetail?.(envelope)
            }}
          >
            View Raw
          </button>
        </div>
      )}
    </div>
  )
}
