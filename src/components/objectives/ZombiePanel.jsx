/**
 * ZombiePanel — Stale/stuck process visibility and cleanup
 *
 * Shows objectives that have gone stale (>10min no updates) or stuck (>30min).
 * Provides per-row Cancel/Retry and batch Cancel All.
 * Renders nothing when no zombie processes exist.
 *
 * Props:
 *   processes — array from useRunningProcesses (with health, elapsed, etc.)
 *   onCancel  — callback(objectiveId)
 *   onRetry   — callback(objectiveId)
 */

import { useState } from 'react'
import { formatElapsed } from '../../hooks/useRunningProcesses'

const HEALTH_COLORS = {
  stale: { bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.2)', dot: '#fbbf24', label: 'Stale' },
  stuck: { bg: 'rgba(248,113,113,0.06)', border: 'rgba(248,113,113,0.2)', dot: '#f87171', label: 'Stuck' },
}

export default function ZombiePanel({ processes, onCancel, onRetry }) {
  const [collapsed, setCollapsed] = useState(false)

  const zombies = (processes || []).filter(p => p.health === 'stale' || p.health === 'stuck')
  if (zombies.length === 0) return null

  const handleCancelAll = () => {
    zombies.forEach(z => onCancel(z.id))
  }

  return (
    <div style={{
      marginBottom: 12,
      borderRadius: 'var(--m-radius-lg, 8px)',
      border: '1px solid rgba(251,191,36,0.15)',
      background: 'rgba(251,191,36,0.03)',
      overflow: 'hidden',
    }}>
      {/* Header — clickable to collapse */}
      <div
        data-testid="zombie-header"
        role="button"
        aria-expanded={!collapsed}
        aria-label="Toggle stale process details"
        onClick={() => setCollapsed(c => !c)}
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          color: '#fbbf24',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: '#fbbf24' }} strokeWidth="2" strokeLinecap="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>{zombies.length} stale process{zombies.length !== 1 ? 'es' : ''}</span>
        <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 'auto' }}>
          {collapsed ? '▸' : '▾'}
        </span>
      </div>

      {/* Process list */}
      {!collapsed && (
        <div style={{ padding: '0 12px 8px' }}>
          {zombies.map(proc => {
            const colors = HEALTH_COLORS[proc.health] || HEALTH_COLORS.stale
            return (
              <div key={proc.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                marginBottom: 4,
                borderRadius: 'var(--m-radius-sm, 4px)',
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                fontSize: 12,
              }}>
                {/* Status dot */}
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: colors.dot, flexShrink: 0,
                }} />

                {/* Title */}
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', color: 'var(--m-text-primary, #f4f4f5)',
                }}>
                  {proc.title}
                </span>

                {/* Task progress */}
                {proc.taskCount > 0 && (
                  <span style={{
                    fontSize: 10, color: 'var(--m-text-tertiary)',
                    fontFamily: 'var(--m-font-mono)', fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}>
                    {proc.completedTasks}/{proc.taskCount}
                  </span>
                )}

                {/* Elapsed */}
                <span style={{
                  fontSize: 10, color: colors.dot,
                  fontFamily: 'var(--m-font-mono)', fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600, flexShrink: 0,
                }}>
                  {formatElapsed(proc.elapsed)}
                </span>

                {/* Actions */}
                <button
                  onClick={(e) => { e.stopPropagation(); onRetry(proc.id) }}
                  style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                    background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                    color: '#60a5fa', cursor: 'pointer', flexShrink: 0,
                  }}
                >Retry</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onCancel(proc.id) }}
                  style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                    color: '#f87171', cursor: 'pointer', flexShrink: 0,
                  }}
                >Cancel</button>
              </div>
            )
          })}

          {/* Batch cancel */}
          {zombies.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={handleCancelAll}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
                  color: '#f87171', cursor: 'pointer',
                  textTransform: 'uppercase', letterSpacing: 0.3,
                }}
              >Cancel All</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
