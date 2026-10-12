/**
 * ConversationList - Clickable list of conversations grouped by correlation ID
 *
 * Simplified to selection-only (no inline expansion).
 * Detail view is handled by ConversationDetail in the right panel.
 */

import { getEnvelopeSummary, getIntentMetadata } from '../../lib/aee'
import { classifySource, SOURCE_CATEGORIES } from '../../lib/aee/store'
import { getEmptyStateInfo } from './activityEmptyState'

export default function ConversationList({
  conversations,
  selectedConv,
  onSelect,
  comparisonEnabled = false,
  selectedForComparison = new Set(),
  onToggleComparison,
  onCompare,
  verbosity = 'normal',
  // QOBS follow-up: total conversations known to exist (pre-filter) so the
  // empty state can tell "genuinely nothing here" apart from "everything
  // is hidden by the current filters".
  totalCount = 0,
  onRelaxFilters,
  // ACTIVITY-TABS-2: which log-type tab is active, so the genuine-empty
  // copy is contextual ("No agent conversations yet" vs "No workflow runs").
  activeTab
}) {
  const formatTime = (ts) => {
    const date = new Date(ts)
    const now = new Date()
    const diff = now - date

    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }

  const getTypeIndicator = (type) => {
    switch (type) {
      case 'task': return { label: 'Task', cls: 'indicator-task' }
      case 'result': return { label: 'Result', cls: 'indicator-result' }
      case 'event': return { label: 'Event', cls: 'indicator-event' }
      case 'error': return { label: 'Error', cls: 'indicator-error' }
      case 'stream': return { label: 'Stream', cls: 'indicator-stream' }
      default: return { label: '', cls: '' }
    }
  }

  if (conversations.length === 0) {
    const emptyState = getEmptyStateInfo({ visibleCount: conversations.length, totalCount, tab: activeTab })

    if (emptyState.kind === 'filtered') {
      return (
        <div className="conversation-list-empty conversation-list-empty--filtered">
          <p>{emptyState.title}</p>
          <p className="hint">{emptyState.message}</p>
          {onRelaxFilters && (
            <button
              type="button"
              className="conversation-list-empty__relax-btn"
              onClick={onRelaxFilters}
              title="Clear filters and include infrastructure events"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M6 12h12M10 18h4"/>
              </svg>
              Show hidden activity
            </button>
          )}
        </div>
      )
    }

    return (
      <div className="conversation-list-empty">
        <p>{emptyState.title}</p>
        <p className="hint">{emptyState.message}</p>
      </div>
    )
  }

  return (
    <div className="conversation-list">
      {/* Comparison Selection Bar */}
      {comparisonEnabled && selectedForComparison.size > 0 && (
        <div className="comparison-selection-bar">
          <span>{selectedForComparison.size} selected for comparison</span>
          <div className="comparison-selection-actions">
            <button
              className="clear-selection-btn"
              onClick={() => onToggleComparison && onToggleComparison(null, true)}
            >
              Clear
            </button>
            <button
              className="compare-btn"
              onClick={() => onCompare && onCompare(Array.from(selectedForComparison))}
              disabled={selectedForComparison.size < 2}
            >
              Compare {selectedForComparison.size} Traces
            </button>
          </div>
        </div>
      )}

      {/* Conversations */}
      {conversations.map(conv => {
        const summary = getEnvelopeSummary(conv.firstMessage)
        const isSelected = selectedForComparison.has(conv.corr)
        const isActive = selectedConv === conv.corr
        const typeInfo = getTypeIndicator(conv.firstMessage?.type)
        const isAoclConv = conv.firstMessage?.intent?.startsWith('aocl.')
        const sourceKey = classifySource(conv.corr)
        const sourceCat = SOURCE_CATEGORIES[sourceKey]

        return (
          <div
            key={conv.corr}
            className={`conversation-item ${isActive ? 'active' : ''} ${isSelected ? 'selected-for-compare' : ''}`}
            onClick={() => onSelect(conv.corr)}
          >
            <div className="conversation-header">
              {comparisonEnabled && (
                <input
                  type="checkbox"
                  className="compare-checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    e.stopPropagation()
                    onToggleComparison && onToggleComparison(conv.corr)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  title="Select for comparison"
                />
              )}
              <div className="conversation-info">
                <span className="conversation-summary">
                  {summary}
                </span>
                <span className="conversation-meta">
                  {sourceCat && (
                    <span
                      className="source-badge"
                      style={{ color: sourceCat.color, borderColor: sourceCat.color + '55' }}
                    >
                      {sourceCat.label}
                    </span>
                  )}
                  {isAoclConv && <span className="conv-tag conv-tag--system">AOCL</span>}
                  {typeInfo.label && <span className={`conv-tag ${typeInfo.cls}`}>{typeInfo.label}</span>}
                  <span className="message-count">{conv.count} msgs</span>
                  {/* AEE-CORE-5.1: rollup badges from server-computed breakdown.
                      Tools / AOCL / policies / errors — each only renders when
                      non-zero so chat-only rows stay uncluttered. */}
                  {conv.breakdown?.tools > 0 && (
                    <span className="conv-badge conv-badge--tools" title={`${conv.breakdown.tools} tool call${conv.breakdown.tools === 1 ? '' : 's'}`}>
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3 }}>
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                      </svg>
                      {conv.breakdown.tools}
                    </span>
                  )}
                  {conv.breakdown?.aocl_layers > 0 && (
                    <span className="conv-badge conv-badge--aocl" title={`${conv.breakdown.aocl_layers} AOCL layer event${conv.breakdown.aocl_layers === 1 ? '' : 's'}`}>
                      L{conv.breakdown.aocl_layers}
                    </span>
                  )}
                  {conv.breakdown?.policy_checks > 0 && (
                    <span className="conv-badge conv-badge--policy" title={`${conv.breakdown.policy_checks} policy check${conv.breakdown.policy_checks === 1 ? '' : 's'}`}>
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3 }}>
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      </svg>
                      {conv.breakdown.policy_checks}
                    </span>
                  )}
                  {conv.breakdown?.errors > 0 && (
                    <span className="conv-badge conv-badge--errors" title={`${conv.breakdown.errors} error${conv.breakdown.errors === 1 ? '' : 's'}`}>
                      ⚠ {conv.breakdown.errors}
                    </span>
                  )}
                  <span className="conversation-time">{formatTime(conv.lastTs)}</span>
                </span>
              </div>
              <span className="conversation-chevron">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </span>
            </div>
          </div>
        )
      })}
      {/* AEE-CORE-2.4: standalone orphan-events strip retired — orphans
          surface in the main list via the infra toggle. Single audit surface. */}
    </div>
  )
}
