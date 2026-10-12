/**
 * EnvelopeAuditTrail — EUX-2: Real AEE envelope audit trail
 *
 * Replaces the fake started/completed/failed event trail with actual
 * AEE envelopes from QuoxFlow execution. Falls back to task-based
 * events when no QuoxFlow execution ID is available.
 *
 * Props:
 *   tasks                — objective.tasks array
 *   quoxflowExecutionId  — objective.quoxflow_execution_id (optional)
 */

import { useState, useEffect, useMemo } from 'react'
import EnvelopeCard from '../activity/EnvelopeCard'
import { AuditTrail } from '../orchestration'
import { getObjectiveExecution } from '../../services/objectiveQuoxFlowBridge'

// ─── Intent categorization for filter badges ──────────────────────────────────

function categorizeIntent(intent) {
  if (!intent) return 'unknown'
  if (intent.startsWith('aocl.')) return 'aocl'
  if (intent.includes('agent.think')) return 'thinking'
  // AEE-FULL Gap 3: both legacy quox.flow.agent.* and canonical quox.flow.llm.*
  // categorize as 'execution'. Historical envelopes are WARD-immutable; dual-
  // read is the permanent shape, not transition debt.
  if (intent.includes('agent.completed') || intent.includes('agent.started')) return 'execution'
  if (intent.includes('llm.completed') || intent.includes('llm.invoked') || intent.includes('llm.failed')) return 'execution'
  if (intent.includes('flow.')) return 'flow'
  if (intent.includes('tool.')) return 'tool'
  return 'other'
}

const CATEGORY_CONFIG = {
  execution: { label: 'Execution', color: '#10b981' },
  thinking:  { label: 'Thinking',  color: '#a855f7' },
  tool:      { label: 'Tool Call', color: '#3b82f6' },
  flow:      { label: 'Flow',     color: '#6366f1' },
  aocl:      { label: 'AOCL',     color: '#71717a' },
  other:     { label: 'Other',    color: '#52525b' },
  unknown:   { label: 'Unknown',  color: '#52525b' },
}

// ─── Fallback: generate events from task data ─────────────────────────────────

function generateFallbackEvents(tasks) {
  return tasks.flatMap(t => {
    const evts = []
    if (t.started_at) evts.push({ type: 'started', actor: t.agent_id || 'system', timestamp: t.started_at, detail: t.title })
    if (t.status === 'completed' && t.completed_at) evts.push({ type: 'completed', actor: t.agent_id || 'system', timestamp: t.completed_at, detail: t.title })
    if (t.status === 'failed' && t.completed_at) evts.push({ type: 'failed', actor: t.agent_id || 'system', timestamp: t.completed_at, detail: `${t.title}${t.result ? ' — ' + String(t.result).slice(0, 80) : ''}` })
    if (t.status === 'skipped') evts.push({ type: 'cancelled', actor: 'system', timestamp: t.completed_at || t.created_at, detail: `Skipped: ${t.title}` })
    return evts
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EnvelopeAuditTrail({ tasks, quoxflowExecutionId }) {
  const [envelopeData, setEnvelopeData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [activeFilter, setActiveFilter] = useState(null)
  const [showCount, setShowCount] = useState(12)
  const [rawViewEnvelope, setRawViewEnvelope] = useState(null)

  // Fetch QuoxFlow envelopes
  useEffect(() => {
    if (!quoxflowExecutionId) return
    let cancelled = false
    setLoading(true)
    getObjectiveExecution(quoxflowExecutionId).then(data => {
      if (!cancelled) {
        setEnvelopeData(data)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [quoxflowExecutionId])

  // Process envelopes
  const { envelopes, categoryCounts, hasEnvelopes } = useMemo(() => {
    const list = envelopeData?.envelopes || []
    if (list.length === 0) return { envelopes: [], categoryCounts: {}, hasEnvelopes: false }

    // Sort newest first
    const sorted = [...list].sort((a, b) => {
      const ta = new Date(a.ts || a.timestamp || 0).getTime()
      const tb = new Date(b.ts || b.timestamp || 0).getTime()
      return tb - ta
    })

    // Count by category
    const counts = {}
    for (const env of sorted) {
      const cat = categorizeIntent(env.intent)
      counts[cat] = (counts[cat] || 0) + 1
    }

    return { envelopes: sorted, categoryCounts: counts, hasEnvelopes: true }
  }, [envelopeData])

  // Apply category filter
  const filteredEnvelopes = useMemo(() => {
    if (!activeFilter) return envelopes
    return envelopes.filter(env => categorizeIntent(env.intent) === activeFilter)
  }, [envelopes, activeFilter])

  const visibleEnvelopes = filteredEnvelopes.slice(0, showCount)
  const hasMore = filteredEnvelopes.length > showCount

  // No execution ID or no envelopes — fall back to task-based trail
  if (!quoxflowExecutionId || (!loading && !hasEnvelopes)) {
    const fallbackEvents = generateFallbackEvents(tasks)
    if (fallbackEvents.length === 0) return null
    return (
      <details style={{ marginTop: 12 }}>
        <summary style={{
          cursor: 'pointer', fontSize: 12, fontWeight: 600,
          color: 'var(--m-text-secondary)', marginBottom: 8,
        }}>
          Event Trail ({fallbackEvents.length})
        </summary>
        <AuditTrail events={fallbackEvents} maxVisible={12} compact />
      </details>
    )
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <h3 className="obj-section-title" style={{ margin: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ verticalAlign: -2, marginRight: 6, opacity: 0.6 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          Audit Trail
          {loading && <span style={{ fontSize: 10, color: 'rgba(161,161,170,0.4)', marginLeft: 8 }}>loading...</span>}
        </h3>
        <span style={{ fontSize: 11, color: 'rgba(161,161,170,0.5)' }}>
          {envelopes.length} envelope{envelopes.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Category filter chips */}
      {Object.keys(categoryCounts).length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          <button
            onClick={() => setActiveFilter(null)}
            style={{
              padding: '2px 8px', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontSize: 10, fontWeight: 600,
              background: activeFilter === null ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)',
              color: activeFilter === null ? '#a5b4fc' : 'rgba(161,161,170,0.5)',
              transition: 'all 0.15s',
            }}
          >
            All ({envelopes.length})
          </button>
          {Object.entries(categoryCounts).map(([cat, count]) => {
            const cfg = CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.other
            const isActive = activeFilter === cat
            return (
              <button
                key={cat}
                onClick={() => setActiveFilter(isActive ? null : cat)}
                style={{
                  padding: '2px 8px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  fontSize: 10, fontWeight: 600,
                  background: isActive ? `${cfg.color}30` : 'rgba(255,255,255,0.05)',
                  color: isActive ? cfg.color : 'rgba(161,161,170,0.5)',
                  transition: 'all 0.15s',
                }}
              >
                {cfg.label} ({count})
              </button>
            )
          })}
        </div>
      )}

      {/* Envelope list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {visibleEnvelopes.map((env, idx) => (
          <div key={env.id || idx} style={{
            animation: `eux-fade-in 0.25s ease-out ${idx * 0.03}s both`,
          }}>
            <EnvelopeCard
              envelope={env}
              compact={filteredEnvelopes.length > 8}
              verbosity={filteredEnvelopes.length > 15 ? 'minimal' : 'normal'}
              onViewDetail={() => setRawViewEnvelope(rawViewEnvelope?.id === env.id ? null : env)}
            />
          </div>
        ))}
      </div>

      {/* Show more */}
      {hasMore && (
        <button
          onClick={() => setShowCount(s => s + 20)}
          style={{
            display: 'block', width: '100%', marginTop: 6,
            padding: '6px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: 'rgba(255,255,255,0.03)', color: 'rgba(161,161,170,0.5)',
            fontSize: 11, fontWeight: 500,
            transition: 'background 0.15s',
          }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
          onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
        >
          Show more ({filteredEnvelopes.length - showCount} remaining)
        </button>
      )}

      {/* Raw JSON viewer */}
      {rawViewEnvelope && (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 8,
          background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)',
          maxHeight: 300, overflowY: 'auto',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6,
          }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(161,161,170,0.5)' }}>
              Raw Envelope — {rawViewEnvelope.id?.slice(0, 16)}
            </span>
            <button
              onClick={() => setRawViewEnvelope(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(161,161,170,0.4)', fontSize: 14, padding: '0 4px',
              }}
            >
              ×
            </button>
          </div>
          <pre style={{
            margin: 0, fontSize: 10, lineHeight: 1.5,
            color: 'rgba(161,161,170,0.7)',
            fontFamily: 'var(--m-font-mono, monospace)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {JSON.stringify(rawViewEnvelope, null, 2)}
          </pre>
        </div>
      )}

      {/* Reuse the fade animation from EUX-1 */}
      <style>{`
        @keyframes eux-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
