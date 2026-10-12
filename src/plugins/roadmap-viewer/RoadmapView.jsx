/**
 * Roadmap Viewer — Third-party community plugin
 *
 * Displays the strategic roadmap (~/STRATEGIC_ROADMAP.json) served via
 * the collector API. Glass design system throughout.
 */

import { useState, useEffect, useMemo } from 'react'

const M = "'JetBrains Mono','Fira Code',monospace"
const F = "'Inter',system-ui,sans-serif"

const TIER_COLORS = {
  0: { bg: '#ef444420', border: '#ef4444', label: 'P0 BLOCKER', color: '#ef4444' },
  1: { bg: '#38bdf820', border: '#38bdf8', label: 'TIER 1', color: '#38bdf8' },
  2: { bg: '#a855f720', border: '#a855f7', label: 'TIER 2', color: '#a855f7' },
  3: { bg: '#30ff9020', border: '#30ff90', label: 'TIER 3', color: '#30ff90' },
  4: { bg: '#f59e0b20', border: '#f59e0b', label: 'TIER 4', color: '#f59e0b' },
  5: { bg: '#71717a20', border: '#71717a', label: 'TIER 5', color: '#71717a' },
}

const STATUS_ICONS = {
  NOT_STARTED: '○',
  IN_PROGRESS: '●',
  COMPLETE: '✓',
  BLOCKED: '■',
  DECISION_NEEDED: '?',
}

const STATUS_COLORS = {
  NOT_STARTED: 'rgba(255,255,255,0.5)',
  IN_PROGRESS: '#f59e0b',
  COMPLETE: '#30ff90',
  BLOCKED: '#ef4444',
  DECISION_NEEDED: '#a855f7',
}

function Glass({ children, style = {}, highlight }) {
  return (
    <div style={{
      backdropFilter: 'var(--glass-blur-strong)',
      WebkitBackdropFilter: 'var(--glass-blur-strong)',
      background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
      borderTop: `1px solid ${highlight ? `${highlight}50` : 'rgba(255,255,255,0.40)'}`,
      borderLeft: `1px solid ${highlight ? `${highlight}30` : 'rgba(255,255,255,0.31)'}`,
      borderRight: '1px solid transparent',
      borderBottom: '1px solid transparent',
      borderRadius: 12,
      boxShadow: highlight
        ? `0 0 20px ${highlight}15, 0 5px 19px rgba(0,0,0,0.35)`
        : '0 5px 19px rgba(0,0,0,0.35)',
      position: 'relative', overflow: 'hidden', padding: 16,
      ...style,
    }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
        background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)' }} />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}

function Pill({ children, color = '#fff', style = {} }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 5,
      background: `${color}15`, border: `1px solid ${color}25`,
      fontFamily: M, fontSize: 9, fontWeight: 600, color,
      ...style,
    }}>{children}</span>
  )
}

function ProgressBar({ done, total, color = '#30ff90' }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 3, width: `${pct}%`, background: color, transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.6)', minWidth: 28 }}>{done}/{total}</span>
    </div>
  )
}

export default function RoadmapView() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all') // all, active, blocked, completed
  const [expandedStream, setExpandedStream] = useState(null)
  const [planDoc, setPlanDoc] = useState(null) // { path, content, loading, error }

  const openPlanDoc = (path) => {
    setPlanDoc({ path, loading: true })
    fetch(`/collector/api/v1/roadmap/plan-doc?path=${encodeURIComponent(path)}`, { credentials: 'include' })
      .then(r => r.json().then(j => r.ok ? j : Promise.reject(j.error || `${r.status}`)))
      .then(j => setPlanDoc({ path, content: j.content }))
      .catch(err => setPlanDoc({ path, error: String(err) }))
  }

  useEffect(() => {
    fetch('/collector/api/v1/roadmap', { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const streams = useMemo(() => {
    if (!data?.streams) return []
    let s = [...data.streams]
    if (filter === 'active') s = s.filter(x => x.status === 'IN_PROGRESS')
    if (filter === 'blocked') s = s.filter(x => x.status === 'BLOCKED' || x.status === 'DECISION_NEEDED')
    if (filter === 'completed') return data.completed || []
    return s
  }, [data, filter])

  const stats = useMemo(() => {
    if (!data) return {}
    const s = data.streams || []
    const c = data.completed || []
    return {
      total: s.length + c.length,
      active: s.filter(x => x.status === 'IN_PROGRESS').length,
      pending: s.filter(x => x.status === 'NOT_STARTED').length,
      blocked: s.filter(x => x.status === 'BLOCKED' || x.status === 'DECISION_NEEDED').length,
      completed: c.length,
    }
  }, [data])

  if (loading) return <div style={{ padding: 40, fontFamily: M, color: 'rgba(255,255,255,0.5)' }}>Loading roadmap...</div>
  if (error) return <div style={{ padding: 40, fontFamily: M, color: '#ef4444' }}>Failed to load roadmap: {error}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: F, fontSize: 20, fontWeight: 800, color: '#fff', margin: 0 }}>Strategic Roadmap</h1>
          <div style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
            {stats.total} streams — {stats.active} active — {stats.completed} completed
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {stats.active > 0 && <Pill color="#f59e0b">{stats.active} ACTIVE</Pill>}
          {stats.blocked > 0 && <Pill color="#ef4444">{stats.blocked} BLOCKED</Pill>}
          <Pill color="#30ff90">{stats.completed} DONE</Pill>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
        {[
          { label: 'Total', value: stats.total, color: '#fff' },
          { label: 'Active', value: stats.active, color: '#f59e0b' },
          { label: 'Pending', value: stats.pending, color: 'rgba(255,255,255,0.6)' },
          { label: 'Blocked', value: stats.blocked, color: '#ef4444' },
          { label: 'Completed', value: stats.completed, color: '#30ff90' },
        ].map(s => (
          <Glass key={s.label} style={{ padding: 12, textAlign: 'center' }}>
            <div style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{s.label}</div>
          </Glass>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {[
          { id: 'all', label: `All (${(data?.streams || []).length})` },
          { id: 'active', label: `Active (${stats.active})` },
          { id: 'blocked', label: `Blocked (${stats.blocked})` },
          { id: 'completed', label: `Completed (${stats.completed})` },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            style={{
              padding: '6px 14px', borderRadius: 8, border: 'none',
              fontFamily: M, fontSize: 10, fontWeight: filter === tab.id ? 700 : 500,
              color: filter === tab.id ? '#fff' : 'rgba(255,255,255,0.5)',
              background: filter === tab.id ? 'linear-gradient(145deg, rgba(168,85,247,0.15), rgba(56,189,248,0.06))' : 'transparent',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Stream list */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {streams.map(stream => {
          const tier = TIER_COLORS[stream.tier] || TIER_COLORS[3]
          const isExpanded = expandedStream === stream.id
          const isCompleted = stream.status === 'COMPLETE'
          const phasesTotal = stream.phases_total || stream.phases?.length || 0
          const phasesDone = stream.phases_done || 0

          return (
            <Glass
              key={stream.id}
              highlight={isExpanded ? tier.border : undefined}
              style={{ padding: isExpanded ? 16 : 12, cursor: 'pointer', opacity: isCompleted && filter !== 'completed' ? 0.7 : 1 }}
            >
              <div
                onClick={() => setExpandedStream(isExpanded ? null : stream.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12 }}
              >
                {/* Status icon */}
                <span style={{
                  fontFamily: M, fontSize: 16, fontWeight: 800,
                  color: STATUS_COLORS[stream.status] || '#fff',
                  minWidth: 20, textAlign: 'center',
                }}>{STATUS_ICONS[stream.status] || '○'}</span>

                {/* Priority */}
                <span style={{
                  fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.4)',
                  minWidth: 24, textAlign: 'right',
                }}>#{stream.priority}</span>

                {/* Stream ID */}
                <Pill color={tier.color} style={{ minWidth: 60, justifyContent: 'center' }}>
                  {stream.id}
                </Pill>

                {/* Name */}
                <span style={{ fontFamily: F, fontSize: 13, fontWeight: 600, color: '#fff', flex: 1 }}>
                  {stream.name}
                </span>

                {/* Progress */}
                {phasesTotal > 0 && (
                  <ProgressBar done={phasesDone} total={phasesTotal} color={tier.color} />
                )}

                {/* Effort */}
                {stream.effort && (
                  <span style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
                    {stream.effort}
                  </span>
                )}

                {/* Expand arrow */}
                <span style={{
                  fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.4)',
                  transform: `rotate(${isExpanded ? 180 : 0}deg)`, transition: 'transform 0.2s',
                }}>▼</span>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {/* Summary */}
                  {stream.summary && (
                    <p style={{ fontFamily: F, fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6, marginBottom: 12, margin: 0 }}>
                      {stream.summary}
                    </p>
                  )}

                  {/* Metadata row */}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                    <Pill color={tier.color}>{tier.label}</Pill>
                    <Pill color={STATUS_COLORS[stream.status]}>{stream.status}</Pill>
                    {stream.effort && <Pill color="rgba(255,255,255,0.6)">{stream.effort}</Pill>}
                    {stream.plan_doc && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openPlanDoc(stream.plan_doc) }}
                        style={{ all: 'unset', cursor: 'pointer' }}
                        title={stream.plan_doc}
                      >
                        <Pill color="#38bdf8">📄 View plan doc</Pill>
                      </button>
                    )}
                    {stream.depends_on?.length > 0 && (
                      <Pill color="#f59e0b">Depends: {stream.depends_on.join(', ')}</Pill>
                    )}
                  </div>

                  {/* Phases */}
                  {Array.isArray(stream.phases) && stream.phases.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
                        Phases ({phasesDone}/{phasesTotal})
                      </div>
                      {stream.phases.map((phase, i) => {
                        const isDone = i < phasesDone
                        const phaseText = typeof phase === 'string' ? phase : phase.name || `Phase ${i + 1}`
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'flex-start', gap: 8,
                            padding: '6px 10px', borderRadius: 6,
                            background: isDone ? 'rgba(48,255,144,0.04)' : 'rgba(255,255,255,0.01)',
                          }}>
                            <span style={{
                              fontFamily: M, fontSize: 11, color: isDone ? '#30ff90' : 'rgba(255,255,255,0.4)',
                              marginTop: 1,
                            }}>{isDone ? '✓' : '○'}</span>
                            <span style={{
                              fontFamily: F, fontSize: 11,
                              color: isDone ? 'rgba(255,255,255,0.5)' : '#fff',
                              textDecoration: isDone ? 'line-through' : 'none',
                              lineHeight: 1.4,
                            }}>{phaseText}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Notes */}
                  {stream.notes && (
                    <div style={{
                      marginTop: 12, padding: '8px 12px', borderRadius: 6,
                      background: `${tier.color}08`, borderLeft: `3px solid ${tier.color}40`,
                      fontFamily: F, fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5,
                    }}>
                      {stream.notes}
                    </div>
                  )}
                </div>
              )}
            </Glass>
          )
        })}
      </div>

      {planDoc && (
        <div
          onClick={() => setPlanDoc(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgba(20,20,28,0.98)', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 12, padding: 24, maxWidth: 900, width: '100%', maxHeight: '85vh',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontFamily: M, fontSize: 11, color: '#38bdf8' }}>{planDoc.path}</div>
              <button onClick={() => setPlanDoc(null)} style={{ all: 'unset', cursor: 'pointer', color: '#fff', fontSize: 18, padding: '0 8px' }}>×</button>
            </div>
            <div style={{
              flex: 1, overflow: 'auto', fontFamily: M, fontSize: 12, color: 'rgba(255,255,255,0.85)',
              whiteSpace: 'pre-wrap', lineHeight: 1.5, padding: 12,
              background: 'rgba(0,0,0,0.3)', borderRadius: 6,
            }}>
              {planDoc.loading && 'Loading...'}
              {planDoc.error && <span style={{ color: '#ef4444' }}>Error: {planDoc.error}</span>}
              {planDoc.content}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
