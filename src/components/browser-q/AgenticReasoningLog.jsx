/**
 * AgenticReasoningLog — BQ Phase 5: Live reasoning display
 *
 * Shows the agentic executor's observe→think→act iterations in real-time.
 * Each iteration card displays:
 *   - Iteration number
 *   - Reasoning text
 *   - Action taken + params
 *   - Confidence badge
 *   - Success/failure status
 *   - Duration
 *
 * Fed by SSE `agentic_iteration` events from the tasks service,
 * or from a static action_log array for completed runs.
 *
 * Props:
 *   objectiveId  — for live SSE subscription (null for static mode)
 *   actionLog    — static action_log array for completed runs
 *   compact      — smaller variant for sidebar display
 */

import { useState, useEffect, useRef } from 'react'

function formatMs(ms) {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function ConfidenceBadge({ confidence }) {
  if (confidence == null) return null
  const pct = Math.round(confidence * 100)
  const color = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8,
      background: `${color}20`, color,
      fontFamily: 'var(--m-font-mono, monospace)',
    }}>
      {pct}%
    </span>
  )
}

function IterationCard({ entry, index, compact }) {
  const [expanded, setExpanded] = useState(false)
  const isSuccess = entry.success !== false
  const statusColor = isSuccess ? '#10b981' : '#ef4444'

  return (
    <div
      style={{
        padding: compact ? '4px 8px' : '6px 10px',
        borderRadius: 6,
        background: isSuccess ? 'rgba(16,185,129,0.04)' : 'rgba(239,68,68,0.04)',
        border: `1px solid ${statusColor}15`,
        animation: `eux-fade-in 0.25s ease-out ${index * 0.05}s both`,
      }}
    >
      {/* Header row */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(x => !x) } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          cursor: 'pointer', fontSize: compact ? 10 : 11,
        }}
      >
        {/* Iteration number */}
        <span style={{
          width: 18, height: 18, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${statusColor}15`, color: statusColor,
          fontSize: 9, fontWeight: 700, flexShrink: 0,
        }}>
          {(entry.iteration ?? index) + 1}
        </span>

        {/* Action badge */}
        <span style={{
          fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(99,102,241,0.1)', color: 'rgba(165,180,252,0.9)',
          textTransform: 'uppercase', flexShrink: 0,
        }}>
          {entry.action}
        </span>

        {/* Reasoning excerpt */}
        <span style={{
          flex: '1 1 0', minWidth: 0, color: 'rgba(255,255,255,0.7)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {entry.reasoning}
        </span>

        <ConfidenceBadge confidence={entry.confidence} />

        {entry.durationMs > 0 && (
          <span style={{
            fontSize: 9, color: 'rgba(255,255,255,0.6)',
            fontFamily: 'var(--m-font-mono, monospace)',
            flexShrink: 0,
          }}>
            {formatMs(entry.durationMs)}
          </span>
        )}

        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)"
          strokeWidth="2" strokeLinecap="round" style={{
            flexShrink: 0, transition: 'transform 0.15s',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{
          marginTop: 6, paddingTop: 6,
          borderTop: '1px solid rgba(255,255,255,0.04)',
          fontSize: compact ? 10 : 11,
        }}>
          <div style={{ color: '#fff', lineHeight: 1.5, marginBottom: 4 }}>
            {entry.reasoning}
          </div>
          {entry.params && Object.keys(entry.params).length > 0 && (
            <div style={{
              padding: '4px 6px', borderRadius: 4,
              background: 'rgba(0,0,0,0.2)',
              fontSize: 10, fontFamily: 'var(--m-font-mono, monospace)',
              color: 'rgba(255,255,255,0.6)', whiteSpace: 'pre-wrap',
              maxHeight: 100, overflow: 'auto',
            }}>
              {JSON.stringify(entry.params, null, 2)}
            </div>
          )}
          {entry.observation && (
            <div style={{
              marginTop: 4, fontSize: 10,
              color: 'rgba(255,255,255,0.6)', lineHeight: 1.4,
            }}>
              Observed: {entry.observation}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function AgenticReasoningLog({ objectiveId, actionLog: staticLog, compact }) {
  const [iterations, setIterations] = useState(staticLog || [])
  const scrollRef = useRef(null)

  // Live SSE subscription for running objectives
  useEffect(() => {
    if (!objectiveId || staticLog) return

    let es = null
    try {
      es = new EventSource(`/tasks/api/objectives/${objectiveId}/stream`, { withCredentials: true })

      es.addEventListener('agentic_iteration', (e) => {
        try {
          const data = JSON.parse(e.data)
          setIterations(prev => [...prev, {
            iteration: data.iteration,
            reasoning: data.reasoning || '',
            action: data.action || '',
            params: data.params || {},
            observation: data.observation || '',
            success: data.success !== false,
            confidence: data.confidence,
            durationMs: data.durationMs || data.duration_ms || 0,
          }])
        } catch { /* ignore parse errors */ }
      })

      es.onerror = () => { /* reconnect handled by EventSource */ }
    } catch { /* SSE not available */ }

    return () => {
      if (es) es.close()
    }
  }, [objectiveId, staticLog])

  // Sync static log changes
  useEffect(() => {
    if (staticLog) setIterations(staticLog)
  }, [staticLog])

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [iterations.length])

  if (iterations.length === 0) {
    return (
      <div style={{
        padding: '16px 12px', textAlign: 'center',
        fontSize: 11, color: 'rgba(255,255,255,0.6)',
      }}>
        Waiting for agent reasoning...
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)',
        fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
        Agent Reasoning ({iterations.length} iteration{iterations.length !== 1 ? 's' : ''})
      </div>

      {/* Iteration list */}
      <div
        ref={scrollRef}
        style={{
          flex: '1 1 0', minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 3,
          padding: '6px 6px',
        }}
      >
        {iterations.map((entry, i) => (
          <IterationCard key={i} entry={entry} index={i} compact={compact} />
        ))}
      </div>

      <style>{`
        @keyframes eux-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
