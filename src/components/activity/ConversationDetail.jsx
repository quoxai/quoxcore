/**
 * ConversationDetail - Detail panel for a selected conversation
 *
 * Renders the full message thread with timeline visualization,
 * action buttons, and a dev-info toggle.
 */

import { useState, useEffect } from 'react'
import { getEnvelopeSummary, findRelatedEvents } from '../../lib/aee'
import { deriveSeverity } from '../../lib/aee/envelopeSeverity'
import { coalesceEnvelopes } from '../../lib/aee/coalesceEnvelopes'
import { dedupDualRead } from '../../lib/aee/dedupDualRead'
import EnvelopeCard from './EnvelopeCard'
import WitnessPanel from './WitnessPanel'

/**
 * Format conversation time range
 */
function formatTimeRange(messages) {
  if (!messages || messages.length === 0) return ''
  const first = new Date(messages[0].ts)
  const last = new Date(messages[messages.length - 1].ts)
  const durationMs = last - first

  if (durationMs < 1000) return 'instant'
  if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`
  if (durationMs < 3600000) return `${Math.round(durationMs / 60000)}m`
  return `${Math.round(durationMs / 3600000)}h`
}

export default function ConversationDetail({
  corr,
  messages,
  loading,
  conversation,
  onClose,
  onContinue,
  onCopyThread,
  onReplay,
  onSelectEnvelope,
  onViewCorrelation,
  replayEnabled = false,
  correlationEnabled = false,
  verbosity = 'normal'
}) {
  const [showDevInfo, setShowDevInfo] = useState(false)
  const [viewMode, setViewMode] = useState('pretty') // 'pretty' | 'json'
  const [relatedEvents, setRelatedEvents] = useState(null)
  const [loadingRelated, setLoadingRelated] = useState(false)
  const [showRelated, setShowRelated] = useState(false)
  // QOBS-1b: debug-severity rows (AOCL layer/tool/LLM chatter, heartbeats,
  // session markers) are collapsed behind a "show N debug events" expander
  // by default. Collapses again whenever a new conversation is selected.
  const [showDebugEvents, setShowDebugEvents] = useState(false)
  useEffect(() => { setShowDebugEvents(false) }, [corr])
  // QOBS-1c: which coalesced (×N) groups are expanded to show their
  // individual envelopes. Keyed by CoalescedGroup.key. Resets per conversation.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
  useEffect(() => { setExpandedGroups(new Set()) }, [corr])
  const toggleGroupExpanded = (key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const summary = conversation?.firstMessage
    ? getEnvelopeSummary(conversation.firstMessage)
    : corr

  if (loading) {
    return (
      <div className="conversation-detail">
        <div className="detail-header">
          <div className="detail-header-left">
            <h3 className="detail-title">Loading...</h3>
          </div>
          <div className="detail-header-right">
            <button className="detail-close" onClick={onClose} title="Close panel">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div className="detail-loading">Loading conversation...</div>
      </div>
    )
  }

  return (
    <div className="conversation-detail">
      {/* Sticky header */}
      <div className="detail-header">
        <div className="detail-header-left">
          <h3 className="detail-title" title={summary}>
            {summary.length > 50 ? summary.slice(0, 47) + '...' : summary}
          </h3>
          <div className="detail-meta">
            <span className="detail-msg-count">{messages.length} messages</span>
            <span className="detail-duration">{formatTimeRange(messages)}</span>
          </div>
        </div>
        <div className="detail-header-right">
          <div className="detail-view-toggle">
            <button
              className={`detail-view-btn ${viewMode === 'pretty' ? 'active' : ''}`}
              onClick={() => setViewMode('pretty')}
              title="Formatted view"
            >
              Pretty
            </button>
            <button
              className={`detail-view-btn ${viewMode === 'json' ? 'active' : ''}`}
              onClick={() => setViewMode('json')}
              title="Raw JSON view"
            >
              JSON
            </button>
          </div>
          <button
            className={`detail-dev-toggle ${showDevInfo ? 'active' : ''}`}
            onClick={() => setShowDevInfo(prev => !prev)}
            title="Show envelope IDs and raw data"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            Dev
          </button>
          <button className="detail-close" onClick={onClose} title="Close panel">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* AEE-CORE-6.1: VOLT + WARD witness strip + evidence bundle download */}
      {corr && <WitnessPanel corr={corr} />}

      {/* Action bar */}
      <div className="detail-actions">
        <button
          className="detail-action-btn detail-action-primary"
          onClick={() => onContinue && onContinue(conversation)}
          title="Continue this conversation"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Continue
        </button>
        <button
          className="detail-action-btn"
          onClick={() => onCopyThread && onCopyThread(conversation)}
          title="Copy thread as Markdown"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy
        </button>
        {replayEnabled && onReplay && (
          <button
            className="detail-action-btn detail-action-replay"
            onClick={() => onReplay(conversation, messages)}
            title="Replay this trace with modifications"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Replay
          </button>
        )}
        {conversation?.corr && (
          <a
            className="detail-action-btn"
            href={`/traces/${encodeURIComponent(conversation.corr)}`}
            title="View AOCL trace waterfall"
            style={{ textDecoration: 'none' }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Trace
          </a>
        )}
        {correlationEnabled && onViewCorrelation && (
          <button
            className="detail-action-btn detail-action-correlation"
            onClick={() => onViewCorrelation(conversation)}
            title="View multi-agent correlation"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            Correlation
          </button>
        )}
        <button
          className={`detail-action-btn ${showRelated ? 'active' : ''}`}
          onClick={async () => {
            if (showRelated) { setShowRelated(false); return }
            setLoadingRelated(true)
            try {
              const events = await findRelatedEvents(corr)
              // Exclude events that are already in the current conversation
              const currentIds = new Set(messages.map(m => m.id))
              const related = events.filter(e => !currentIds.has(e.id))
              setRelatedEvents(related)
              setShowRelated(true)
            } catch { setRelatedEvents([]) ; setShowRelated(true) }
            finally { setLoadingRelated(false) }
          }}
          title="Find events linked to this conversation via parentCorr"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          {loadingRelated ? '...' : 'Related'}
        </button>
        <button
          className="detail-action-btn"
          onClick={() => onSelectEnvelope && messages[0] && onSelectEnvelope(messages[0])}
          title="View raw JSON"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
          Raw
        </button>
      </div>

      {/* Related events panel */}
      {showRelated && relatedEvents && (
        <div className="detail-related-panel">
          <div className="detail-related-header">
            <span className="detail-related-title">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              Related Events ({relatedEvents.length})
            </span>
            <button className="detail-related-close" onClick={() => setShowRelated(false)}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          {relatedEvents.length === 0 ? (
            <div className="detail-related-empty">No linked events found</div>
          ) : (
            <div className="detail-related-list">
              {relatedEvents.map(env => (
                <div key={env.id} className="detail-related-item" onClick={() => onSelectEnvelope && onSelectEnvelope(env)}>
                  <span className="related-intent">{env.intent || env.type}</span>
                  <span className="related-from">{env.from}</span>
                  <span className="related-time">{new Date(env.ts).toLocaleTimeString()}</span>
                  {env.payload?.parentCorr && <span className="related-linked" title="Linked via parentCorr">↩</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Message timeline */}
      <div className="detail-messages">
        {viewMode === 'json' ? (
          <div className="detail-json-view">
            {messages.map(env => (
              <div key={env.id} className="detail-json-block">
                <div className="detail-json-meta">
                  <span className={`detail-json-sender role-${env.from?.startsWith('human') ? 'user' : env.intent?.startsWith('aocl.') ? 'system' : 'agent'}`}>
                    {env.from}
                  </span>
                  <span className="detail-json-intent">{env.intent}</span>
                  <time className="detail-json-time">{new Date(env.ts).toLocaleTimeString()}</time>
                </div>
                <pre className="detail-json-pre">{JSON.stringify(env, null, 2)}</pre>
              </div>
            ))}
          </div>
        ) : (() => {
          // QOBS-1c: hide legacy dual-read siblings (quox.flow.agent.*,
          // ops.assistant.invoked, agentic.think) whenever the canonical
          // quox.flow.llm.* envelope for the same reply_to window is present.
          const deduped = dedupDualRead(messages)

          // QOBS-1b: partition the chain into signal (non-debug) and debug
          // (AOCL layer/tool/LLM chatter, heartbeats, session markers) rows.
          // Debug rows stay hidden until the user expands them.
          const debugMessages = deduped.filter(env => deriveSeverity(env) === 'debug')
          const visibleMessages = showDebugEvents ? deduped : deduped.filter(env => deriveSeverity(env) !== 'debug')

          // QOBS-1c: collapse consecutive same-intent envelopes (per-node
          // AOCL layer bursts, tool call triples, etc.) into a single ×N row.
          const groups = coalesceEnvelopes(visibleMessages)

          return (
            <div className="conversation-timeline">
              {debugMessages.length > 0 && (
                <button
                  type="button"
                  className="debug-events-toggle"
                  onClick={() => setShowDebugEvents(v => !v)}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d={showDebugEvents ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
                  </svg>
                  {showDebugEvents
                    ? `Hide ${debugMessages.length} debug event${debugMessages.length === 1 ? '' : 's'}`
                    : `Show ${debugMessages.length} debug event${debugMessages.length === 1 ? '' : 's'}`}
                </button>
              )}
              {groups.map(group => {
                if (group.count === 1) {
                  return (
                    <EnvelopeCard
                      key={group.key}
                      envelope={group.envelopes[0]}
                      showDevInfo={showDevInfo}
                      verbosity={verbosity}
                      onViewDetail={onSelectEnvelope}
                    />
                  )
                }

                const isExpanded = expandedGroups.has(group.key)
                return (
                  <div key={group.key} className="coalesced-group">
                    <button
                      type="button"
                      className="coalesced-group-toggle"
                      onClick={() => toggleGroupExpanded(group.key)}
                      title={`${group.count} consecutive ${group.intent} events`}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d={isExpanded ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
                      </svg>
                      <EnvelopeCard
                        envelope={group.envelopes[0]}
                        showDevInfo={showDevInfo}
                        verbosity={verbosity}
                        compact
                      />
                      <span className="coalesced-group-count">×{group.count}</span>
                    </button>
                    {isExpanded && (
                      <div className="coalesced-group-items">
                        {group.envelopes.map(env => (
                          <EnvelopeCard
                            key={env.id}
                            envelope={env}
                            showDevInfo={showDevInfo}
                            verbosity={verbosity}
                            onViewDetail={onSelectEnvelope}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
