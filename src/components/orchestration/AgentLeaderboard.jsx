/**
 * AgentLeaderboard — Ranked table of agents by composite score
 *
 * Score bar, success rate, avg duration, tokens, trend arrow.
 * Sortable by clicking column headers.
 *
 * @param {Array} agents — [{ id, name, color, score, successRate, avgDurationMs, tokensUsed, taskCount, trend }]
 * @param {string} sortBy — current sort field
 * @param {Function} [onSort] — callback(field)
 * @param {Function} [onAgentClick] — callback(agentId)
 */

import { useState, useMemo } from 'react'

const RANK_COLORS = ['#f59e0b', '#94a3b8', '#cd7f32']
const TREND = { up: { arrow: '\u2191', color: '#10b981' }, down: { arrow: '\u2193', color: '#ef4444' }, flat: { arrow: '\u2192', color: '#71717a' } }

function formatDuration(ms) {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function scoreColor(score) {
  if (score >= 80) return '#10b981'
  if (score >= 50) return '#f59e0b'
  return '#ef4444'
}

const COLUMNS = [
  { key: 'rank', label: '#', width: 30 },
  { key: 'name', label: 'Agent', width: 'auto' },
  { key: 'score', label: 'Score', width: 100 },
  { key: 'successRate', label: 'Success', width: 60 },
  { key: 'avgDurationMs', label: 'Avg Time', width: 65 },
  { key: 'tokensUsed', label: 'Tokens', width: 65 },
  { key: 'trend', label: '', width: 24 },
]

export default function AgentLeaderboard({ agents = [], sortBy: initialSort = 'score', onSort, onAgentClick }) {
  const [sortField, setSortField] = useState(initialSort)

  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (sortField === 'name') return a.name.localeCompare(b.name)
      if (sortField === 'avgDurationMs') return (a.avgDurationMs || 0) - (b.avgDurationMs || 0)
      return (b[sortField] || 0) - (a[sortField] || 0)
    })
  }, [agents, sortField])

  const handleSort = (field) => {
    setSortField(field)
    if (onSort) onSort(field)
  }

  if (agents.length === 0) return null

  return (
    <div style={{ width: '100%', fontSize: 12, fontFamily: 'var(--m-font-mono, monospace)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 32,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        padding: '0 8px',
      }}>
        {COLUMNS.map(col => (
          <div
            key={col.key}
            onClick={col.key !== 'rank' && col.key !== 'trend' ? () => handleSort(col.key) : undefined}
            style={{
              width: col.width === 'auto' ? undefined : col.width,
              flex: col.width === 'auto' ? 1 : undefined,
              fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
              color: sortField === col.key ? 'var(--m-coral, #ff8a6b)' : 'rgba(255,255,255,0.4)',
              cursor: col.key !== 'rank' && col.key !== 'trend' ? 'pointer' : 'default',
              fontWeight: 600,
            }}
          >
            {col.label}
          </div>
        ))}
      </div>

      {/* Rows */}
      {sorted.map((agent, idx) => {
        const trend = TREND[agent.trend] || TREND.flat
        const rankColor = idx < 3 ? RANK_COLORS[idx] : 'rgba(255,255,255,0.4)'

        return (
          <div
            key={agent.id}
            onClick={onAgentClick ? () => onAgentClick(agent.id) : undefined}
            style={{
              display: 'flex', alignItems: 'center', height: 36,
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              padding: '0 8px',
              cursor: onAgentClick ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {/* Rank */}
            <div style={{ width: 30, fontWeight: 700, color: rankColor, fontSize: 13 }}>
              {idx + 1}
            </div>

            {/* Name */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: agent.color || '#71717a', flexShrink: 0,
              }} />
              <span style={{ color: 'var(--m-text-primary, #f4f4f5)', fontWeight: 500, fontSize: 12 }}>
                {agent.name}
              </span>
            </div>

            {/* Score bar */}
            <div style={{ width: 100, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 60, height: 6, borderRadius: 3,
                background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
              }}>
                <div style={{
                  width: `${Math.min(agent.score, 100)}%`, height: '100%',
                  borderRadius: 3, background: scoreColor(agent.score),
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <span style={{ fontSize: 11, color: scoreColor(agent.score), fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(agent.score)}
              </span>
            </div>

            {/* Success rate */}
            <div style={{ width: 60, color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums' }}>
              {agent.successRate != null ? `${Math.round(agent.successRate * 100)}%` : '-'}
            </div>

            {/* Avg time */}
            <div style={{ width: 65, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
              {formatDuration(agent.avgDurationMs)}
            </div>

            {/* Tokens */}
            <div style={{ width: 65, color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
              {agent.tokensUsed ? agent.tokensUsed.toLocaleString() : '-'}
            </div>

            {/* Trend */}
            <div style={{ width: 24, textAlign: 'center', color: trend.color, fontSize: 14 }}>
              {trend.arrow}
            </div>
          </div>
        )
      })}
    </div>
  )
}
