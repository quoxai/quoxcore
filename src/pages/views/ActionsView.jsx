/**
 * ActionsView — Action Tracker Plugin
 * Kanban board with drag-and-drop, confetti, streak tracking.
 * Phase A: quick-add, filter/sort, auto-archive, keyboard shortcuts, user-scoped data.
 * Phase B: department-scoped task lists, aggregate view, scope badges.
 * Data backed by actionsService (server-first with localStorage cache).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import {
  COLUMNS, PRIORITIES, CONFETTI_COLORS,
  computeStats, moveItem, updateStreak,
  migrateItem, filterItems, sortItems, autoArchiveItems,
  getUniqueCategories, getActions,
  addAction, moveAction, updateAction, deleteAction,
  fetchStreak,
} from '../../services/actionsService'
import {
  logActionCreated, logActionMoved, logActionUpdated, logActionDeleted,
} from '../../services/actionAuditService'
import ActionQSidebar from '../../components/actions/ActionQSidebar'
import './actions-view.css'

const PLUGIN_NAME = 'action-tracker'

// ─── Scope Selector ─────────────────────────────────────────────────

function ScopeSelector({ scopes, selectedScope, onSelect }) {
  return (
    <div className="actions-scope-selector">
      <label className="actions-scope-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: '#10b981' }} strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Scope
      </label>
      <select
        className="qx-select"
        value={selectedScope}
        onChange={e => onSelect(e.target.value)}
        style={{ minWidth: 140, fontSize: 12 }}
      >
        <option value="my">My Tasks</option>
        <option value="all">All</option>
        {scopes.map(s => (
          <option key={s.id} value={s.id}>
            {s.type === 'division' ? '│ ' : s.type === 'team' ? '  └ ' : '│ '}{s.name}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── View Toggle (Board | Aggregate | Stats) ────────────────────────

function ViewToggle({ activeView, onToggle }) {
  const stroke = (key) => activeView === key ? '#10b981' : 'rgba(255,255,255,0.6)'
  return (
    <div className="qx-seg">
      <button
        className={`qx-seg__btn${activeView === 'board' ? ' qx-seg__btn--active' : ''}`}
        onClick={() => onToggle('board')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: stroke('board') }}>
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
        Board
      </button>
      <button
        className={`qx-seg__btn${activeView === 'aggregate' ? ' qx-seg__btn--active' : ''}`}
        onClick={() => onToggle('aggregate')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: stroke('aggregate') }}>
          <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
        Aggregate
      </button>
      <button
        className={`qx-seg__btn${activeView === 'stats' ? ' qx-seg__btn--active' : ''}`}
        onClick={() => onToggle('stats')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: stroke('stats') }}>
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        Stats
      </button>
    </div>
  )
}

// ─── Aggregate View ─────────────────────────────────────────────────

function AggregateView({ items, scopes, onSelectScope }) {
  const todayStr = new Date().toISOString().slice(0, 10)

  // Build per-scope stats
  const scopeStats = useMemo(() => {
    // Group items by scopeId, splitting the no-scope bucket by visibility
    // (ACTIONQ-FIX-SPEC 1a): a truly private task and a legacy org-wide task
    // both have scopeId === null, but they are NOT the same thing and must
    // not share the "Personal" label — a legacy null-scope row is visible to
    // the whole org, so labelling it "Personal" overstated its privacy.
    const groups = new Map()
    groups.set('_private', { id: '_private', name: 'Private', items: [] })
    groups.set('_org', { id: '_org', name: 'Organization — legacy shared task', items: [] })

    for (const scope of scopes) {
      groups.set(scope.id, { id: scope.id, name: scope.name, type: scope.type, items: [] })
    }

    for (const item of items) {
      if (item.scopeId && groups.has(item.scopeId)) {
        groups.get(item.scopeId).items.push(item)
        continue
      }
      if (item.scopeId) {
        // Unknown scope - group under a dynamic entry
        groups.set(item.scopeId, { id: item.scopeId, name: item.scopeName || 'Unknown', items: [item] })
        continue
      }
      const bucket = item.visibility === 'org' ? '_org' : '_private'
      groups.get(bucket).items.push(item)
    }

    // Compute stats per scope
    const result = []
    for (const [, group] of groups) {
      if (group.items.length === 0 && (group.id === '_private' || group.id === '_org')) continue
      const todo = group.items.filter(i => i.status === 'todo' && !i.archivedAt).length
      const doing = group.items.filter(i => i.status === 'doing' && !i.archivedAt).length
      const done = group.items.filter(i => i.status === 'done').length
      const overdue = group.items.filter(i =>
        i.status !== 'done' && !i.archivedAt && i.dueDate && i.dueDate < todayStr
      ).length
      result.push({ ...group, todo, doing, done, overdue, total: group.items.length })
    }

    // Sort: most overdue first, then by total descending
    result.sort((a, b) => b.overdue - a.overdue || b.total - a.total)
    return result
  }, [items, scopes, todayStr])

  if (scopeStats.length === 0) {
    return (
      <div className="qx-empty">
        <p className="qx-empty__body">No scoped tasks yet. Assign tasks to departments or teams to see the aggregate view.</p>
      </div>
    )
  }

  return (
    <table className="qx-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th className="qx-num">Todo</th>
          <th className="qx-num">Doing</th>
          <th className="qx-num">Done</th>
          <th className="qx-num">Overdue</th>
          <th className="qx-num">Total</th>
        </tr>
      </thead>
      <tbody>
        {scopeStats.map(scope => {
          const isUnscopedBucket = scope.id === '_private' || scope.id === '_org'
          return (
          <tr
            key={scope.id}
            className={scope.overdue > 0 ? 'actions-aggregate-row--overdue' : ''}
            onClick={() => {
              if (!isUnscopedBucket) onSelectScope(scope.id)
            }}
            style={{ cursor: !isUnscopedBucket ? 'pointer' : 'default' }}
            title={!isUnscopedBucket ? `View ${scope.name} kanban` : ''}
            role={!isUnscopedBucket ? 'button' : undefined}
            tabIndex={!isUnscopedBucket ? 0 : undefined}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !isUnscopedBucket) {
                e.preventDefault()
                onSelectScope(scope.id)
              }
            }}
          >
            <td>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                {scope.type === 'division' && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: '#10b981' }} strokeWidth="2">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                  </svg>
                )}
                {scope.type === 'department' && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: '#10b981' }} strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                  </svg>
                )}
                {scope.type === 'team' && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: '#10b981' }} strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                )}
                {scope.name}
              </span>
            </td>
            <td className="qx-num" style={{ color: '#f59e0b' }}>{scope.todo}</td>
            <td className="qx-num" style={{ color: '#38bdf8' }}>{scope.doing}</td>
            <td className="qx-num" style={{ color: '#4ade80' }}>{scope.done}</td>
            <td className="qx-num" style={{ color: scope.overdue > 0 ? '#f87171' : 'rgba(255,255,255,0.5)', fontWeight: scope.overdue > 0 ? 700 : 400 }}>{scope.overdue}</td>
            <td className="qx-num" style={{ color: 'rgba(255,255,255,0.7)' }}>{scope.total}</td>
          </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Scope Picker for Modal ─────────────────────────────────────────

function ScopePicker({ scopes, value, onChange }) {
  return (
    <div className="qx-field">
      <label className="qx-field__label">Scope (optional)</label>
      <select
        className="qx-select"
        value={value || ''}
        onChange={e => {
          const id = e.target.value
          if (!id) {
            onChange(null, null)
          } else {
            const scope = scopes.find(s => s.id === id)
            onChange(id, scope?.name || '')
          }
        }}
      >
        <option value="">Personal (no scope)</option>
        {scopes.map(s => (
          <option key={s.id} value={s.id}>
            {s.type === 'division' ? '[Div] ' : s.type === 'team' ? '[Team] ' : '[Dept] '}{s.name}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── Stat Tile ───────────────────────────────────────────────────────
// Compact stat — label + value with optional progress bar / accent / prefix.
function StatTile({ label, value, bar, accent, prefix }) {
  return (
    <div className={`actions-stat-tile ${accent ? `actions-stat-tile--${accent}` : ''}`}>
      <div className="actions-stat-tile__label">{label}</div>
      <div className="actions-stat-tile__value">
        {prefix && <span className="actions-stat-tile__prefix">{prefix}</span>}
        {value}
      </div>
      {typeof bar === 'number' && (
        <div className="actions-stat-tile__bar"><div style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></div>
      )}
    </div>
  )
}

// ─── Stats Dashboard (the Stats tab) ─────────────────────────────────
// Combines stat tiles + circular gauges + 7-day completion chart.
function StatsView({ stats, streak, items }) {
  return (
    <div className="actions-stats-view">
      <div className="actions-stats">
        <StatTile label="Total" value={stats.total} />
        <StatTile label="Done" value={`${stats.pct}%`} bar={stats.pct} accent="emerald" />
        <StatTile label="This Week" value={stats.doneThisWeek} />
        <StatTile label="Streak" value={`${streak.current}d`} accent="emerald" prefix="🔥" />
        <StatTile label="Overdue" value={stats.overdue} accent={stats.overdue > 0 ? 'critical' : null} />
        <StatTile label="Avg Days" value={`${stats.avgDays}d`} />
      </div>

      <div className="actions-stats-view__gauges">
        <div className="actions-analytics-gauge-item">
          <div className="actions-gauge-mini">
            <svg width="80" height="80" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4"
                strokeDasharray="147.65 35" strokeLinecap="round" transform="rotate(135 32 32)" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="#10b981" strokeWidth="4"
                strokeDasharray={`${147.65 * (stats.pct / 100)} ${182.65 - 147.65 * (stats.pct / 100)}`}
                strokeLinecap="round" transform="rotate(135 32 32)"
                style={{ transition: 'stroke-dasharray 0.8s ease' }} />
              <text x="32" y="36" textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="14" fontFamily="'SF Mono', 'JetBrains Mono', monospace">{stats.pct}%</text>
            </svg>
          </div>
          <span className="actions-gauge-label">Completion</span>
        </div>
        <div className="actions-analytics-gauge-item">
          <div className="actions-gauge-mini">
            <svg width="80" height="80" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4"
                strokeDasharray="147.65 35" strokeLinecap="round" transform="rotate(135 32 32)" />
              <circle cx="32" cy="32" r="26" fill="none"
                stroke={stats.overdue > 0 ? '#ef4444' : '#22c55e'} strokeWidth="4"
                strokeDasharray={`${stats.total > 0 ? 147.65 * (stats.overdue / stats.total) : 0} ${182.65 - (stats.total > 0 ? 147.65 * (stats.overdue / stats.total) : 0)}`}
                strokeLinecap="round" transform="rotate(135 32 32)"
                style={{ transition: 'stroke-dasharray 0.8s ease' }} />
              <text x="32" y="36" textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="14" fontFamily="'SF Mono', 'JetBrains Mono', monospace">{stats.overdue}</text>
            </svg>
          </div>
          <span className="actions-gauge-label">Overdue</span>
        </div>
        <div className="actions-analytics-gauge-item">
          <div className="actions-gauge-mini">
            <svg width="80" height="80" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4"
                strokeDasharray="147.65 35" strokeLinecap="round" transform="rotate(135 32 32)" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="#10b981" strokeWidth="4"
                strokeDasharray={`${Math.min(147.65, streak.current * 21)} ${182.65 - Math.min(147.65, streak.current * 21)}`}
                strokeLinecap="round" transform="rotate(135 32 32)"
                style={{ transition: 'stroke-dasharray 0.8s ease' }} />
              <text x="32" y="36" textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="14" fontFamily="'SF Mono', 'JetBrains Mono', monospace">{streak.current}d</text>
            </svg>
          </div>
          <span className="actions-gauge-label">Streak</span>
        </div>
      </div>

      <div className="actions-stats-view__chart">
        <div className="actions-analytics-chart-title">Completed per day (last 7 days)</div>
        <CompletionChart items={items} />
      </div>
    </div>
  )
}


// ─── ActionCard ──────────────────────────────────────────────────────

function ActionCard({ item, todayStr, isDragging, isPending, onDragStart, onDragEnd, onEdit, onMove, onDelegate }) {
  const isOverdue = item.dueDate && item.dueDate < todayStr && item.status !== 'done'
  const isArchived = !!item.archivedAt
  const isDelegated = (item.notes || '').includes('Delegated to objective') || (item.description || '').includes('[delegation_meta]')
  const hasVolt = (item.notes || '').includes('[volt_bundle_id:')
  const voltBundleMatch = hasVolt ? (item.notes || '').match(/\[volt_bundle_id:([^\]]+)\]/) : null
  const voltBundleId = voltBundleMatch ? voltBundleMatch[1] : null

  const moveTargets = []
  if (item.status !== 'todo') moveTargets.push({ status: 'todo', label: '← Todo' })
  if (item.status !== 'doing') moveTargets.push({ status: 'doing', label: '→ Doing' })
  if (item.status !== 'done') moveTargets.push({ status: 'done', label: '✓ Done', isDone: true })

  const priorityMap = { urgent: 'critical', high: 'high', medium: 'medium', low: 'low' }

  return (
    <div
      className={`action-item-card card-enter ${isDragging ? 'card-dragging' : ''} ${isArchived ? 'action-item-archived' : ''} ${item.priority ? `priority-accent-${item.priority}` : ''}`}
      draggable
      onDragStart={e => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      onClick={onEdit}
    >
      <div className="action-item-title">{item.title}</div>
      <div className="action-item-meta">
        {isPending && (
          <span className="qx-pill qx-pill--info qx-pill--sm" title="Saving — waiting for server confirmation">
            Saving…
          </span>
        )}
        {isArchived && (
          <span className="qx-pill qx-pill--ghost qx-pill--sm">ARCHIVED</span>
        )}
        {isDelegated && (
          <span className="qx-pill qx-pill--info qx-pill--sm" title="Delegated to agentic objective">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: '#38bdf8' }} strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Delegated
          </span>
        )}
        {hasVolt && (
          <span className="qx-pill qx-pill--purple qx-pill--sm" title={`VOLT evidence: ${voltBundleId || 'linked'}`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: '#c084fc' }} strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            VOLT
          </span>
        )}
        {item.scopeName && (
          <span className="qx-chip qx-chip--brand" title={`Scoped to: ${item.scopeName}`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor', opacity: 0.8 }} strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            {item.scopeName}
          </span>
        )}
        {item.source === 'ai' && (
          <span className="qx-pill qx-pill--purple qx-pill--sm" title="Created by AI">AI</span>
        )}
        {item.priority && (
          <span className={`qx-severity qx-severity--${priorityMap[item.priority] || 'info'}`}>
            {item.priority}
          </span>
        )}
        {item.category && (
          <span className="qx-chip">{item.category}</span>
        )}
        {item.dueDate && (
          isOverdue
            ? <span className="qx-pill qx-pill--critical qx-pill--sm">OVERDUE {item.dueDate}</span>
            : <span className="action-item-due">{item.dueDate}</span>
        )}
      </div>
      <div
        className="action-item-actions"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        draggable={false}
      >
        <button
          type="button"
          className="qx-btn qx-btn--ghost qx-btn--sm action-item-edit-btn"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit action"
          style={{ padding: '3px 8px', fontSize: 10 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Edit
        </button>
        {(item.status === 'todo' || item.status === 'doing') && !isDelegated && onDelegate && (
          <button
            type="button"
            className="qx-btn qx-btn--ghost qx-btn--sm"
            onClick={(e) => { e.stopPropagation(); onDelegate(item); }}
            title="Delegate to agentic objective"
            style={{ padding: '3px 8px', fontSize: 10, color: '#10b981', borderColor: 'rgba(16,185,129,0.2)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: '#10b981' }} strokeWidth="2">
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Delegate
          </button>
        )}
        {moveTargets.map(t => (
          <button
            key={t.status}
            type="button"
            className={`qx-btn qx-btn--sm ${t.isDone ? 'qx-btn--primary' : 'qx-btn--ghost'}`}
            onClick={(e) => { e.stopPropagation(); onMove(item.id, t.status); }}
            disabled={isPending}
            style={{ padding: '3px 8px', fontSize: 10 }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── ConfettiBurst ───────────────────────────────────────────────────

function ConfettiBurst() {
  const pieces = Array.from({ length: 15 }, (_, i) => {
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const left = 40 + Math.random() * 20
    const delay = Math.random() * 0.3
    const size = 6 + Math.random() * 6
    return (
      <div
        key={i}
        className="confetti-piece"
        style={{
          left: `${left}%`,
          top: '-10px',
          width: `${size}px`,
          height: `${size}px`,
          background: color,
          animationDelay: `${delay}s`,
        }}
      />
    )
  })

  return <div className="confetti-container">{pieces}</div>
}

// ─── CompletionChart — inline SVG bar chart ──────────────────────────

function CompletionChart({ items }) {
  const days = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dayStr = d.toISOString().slice(0, 10)
    const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short' })
    const count = items.filter(item =>
      item.completedAt && item.completedAt.slice(0, 10) === dayStr
    ).length
    days.push({ dayStr, dayLabel, count })
  }

  const maxCount = Math.max(1, ...days.map(d => d.count))
  const barWidth = 28
  const chartHeight = 60
  const chartWidth = days.length * (barWidth + 8) + 8

  return (
    <svg width={chartWidth} height={chartHeight + 20} viewBox={`0 0 ${chartWidth} ${chartHeight + 20}`}>
      {days.map((d, i) => {
        const barHeight = maxCount > 0 ? (d.count / maxCount) * chartHeight : 0
        const x = 8 + i * (barWidth + 8)
        const y = chartHeight - barHeight
        return (
          <g key={d.dayStr}>
            {/* Bar background */}
            <rect x={x} y={0} width={barWidth} height={chartHeight} rx={3} fill="rgba(255,255,255,0.04)" />
            {/* Bar fill */}
            <rect x={x} y={y} width={barWidth} height={barHeight} rx={3} fill="#10b981"
              style={{ opacity: d.count > 0 ? 0.8 : 0, transition: 'height 0.5s ease, y 0.5s ease' }} />
            {/* Count label */}
            {d.count > 0 && (
              <text x={x + barWidth / 2} y={y - 3} textAnchor="middle" fill="rgba(255,255,255,0.7)"
                fontSize="10" fontFamily="'SF Mono', monospace">{d.count}</text>
            )}
            {/* Day label */}
            <text x={x + barWidth / 2} y={chartHeight + 14} textAnchor="middle"
              fill="rgba(255,255,255,0.6)" fontSize="9" fontFamily="Inter, system-ui, sans-serif">{d.dayLabel}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── ActionModal ─────────────────────────────────────────────────────

function ActionModal({ mode, item, onSave, onDelete, onClose, scopes }) {
  const [form, setForm] = useState({
    title: item?.title || '',
    description: item?.description || '',
    priority: item?.priority || '',
    category: item?.category || '',
    dueDate: item?.dueDate || '',
    notes: item?.notes || '',
    scopeId: item?.scopeId || '',
    scopeName: item?.scopeName || '',
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const titleRef = useRef(null)
  const modalRef = useRef(null)
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Escape key closes modal + focus trap
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = Array.from(modalRef.current.querySelectorAll(
          'button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
        ))
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    onSave(form)
  }

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div className="actions-modal-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="qx-card actions-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="actions-modal-title"
        style={{ maxWidth: 520, width: '100%', padding: 0 }}
      >
        <div className="actions-modal-header">
          <h2 id="actions-modal-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{mode === 'add' ? 'New Action' : 'Edit Action'}</h2>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} style={{ padding: '4px 8px', fontSize: 16, lineHeight: 1 }}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="actions-modal-body">
            <div className="qx-field">
              <label className="qx-field__label qx-field__label--required">Title</label>
              <input
                ref={titleRef}
                type="text"
                className="qx-input"
                value={form.title}
                onChange={set('title')}
                placeholder="What needs to be done?"
                required
              />
            </div>
            <div className="qx-field">
              <label className="qx-field__label">Description</label>
              <textarea
                className="qx-textarea"
                value={form.description}
                onChange={set('description')}
                rows={2}
                placeholder="Optional details..."
              />
            </div>
            <div className="actions-form-row">
              <div className="qx-field">
                <label className="qx-field__label">Priority</label>
                <select className="qx-select" value={form.priority} onChange={set('priority')}>
                  {PRIORITIES.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div className="qx-field">
                <label className="qx-field__label">Category</label>
                <input
                  type="text"
                  className="qx-input"
                  value={form.category}
                  onChange={set('category')}
                  placeholder="legal, financial, technical..."
                />
              </div>
            </div>
            <div className="qx-field">
              <label className="qx-field__label">Due Date</label>
              <input type="date" className="qx-input" value={form.dueDate} onChange={set('dueDate')} />
            </div>
            {scopes && scopes.length > 0 && (
              <ScopePicker
                scopes={scopes}
                value={form.scopeId}
                onChange={(id, name) => setForm(f => ({ ...f, scopeId: id || '', scopeName: name || '' }))}
              />
            )}
            <div className="qx-field">
              <label className="qx-field__label">Notes</label>
              <textarea
                className="qx-textarea"
                value={form.notes}
                onChange={set('notes')}
                rows={2}
                placeholder="Additional notes..."
              />
            </div>
          </div>
          <div className="actions-modal-footer">
            {mode === 'edit' && !confirmDelete && (
              <button
                type="button"
                className="qx-btn qx-btn--danger qx-btn--sm"
                style={{ marginRight: 'auto' }}
                onClick={() => setConfirmDelete(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete
              </button>
            )}
            {mode === 'edit' && confirmDelete && (
              <div className="actions-delete-confirm" style={{ marginRight: 'auto' }}>
                <span style={{ color: '#f87171', fontSize: 12, fontWeight: 500 }}>Delete this action?</span>
                <button
                  type="button"
                  className="qx-btn qx-btn--danger qx-btn--sm"
                  onClick={() => onDelete(item.id)}
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  className="qx-btn qx-btn--ghost qx-btn--sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={!form.title.trim()}>
              {mode === 'add' ? 'Add Action' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────

export default function ActionsView() {
  const { user } = useAuth()
  const { currentOrg, currentScope, getDivisions, getDepartments, getTeams } = useWorkspace()
  const userId = user?.id
  const orgId = currentOrg?.id
  const diag = usePluginLicenseDiagnosis(PLUGIN_NAME)
  const licensed = diag.licensed

  const [data, setData] = useState({ items: [], streak: { current: 0, lastCompletionDate: null } })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null)
  const [dragState, setDragState] = useState({ draggedId: null, overColumn: null })
  const [confetti, setConfetti] = useState(false)
  const [doneGlow, setDoneGlow] = useState(false)
  const confettiTimer = useRef(null)

  // Inline quick-add (in TODO column header)
  const [inlineAddOpen, setInlineAddOpen] = useState(false)
  const [inlineAddValue, setInlineAddValue] = useState('')
  const inlineAddRef = useRef(null)

  // Scope selector state: 'my' | 'all' | <scopeId>
  const [selectedScope, setSelectedScope] = useState('my')
  const [orgScopes, setOrgScopes] = useState([]) // flat list of divisions/departments/teams

  // View toggle: 'board' | 'aggregate'
  const [activeView, setActiveView] = useState('board')

  // Load org tree (divisions, departments, teams) for scope selector
  useEffect(() => {
    if (!orgId) return
    let cancelled = false

    async function loadScopes() {
      try {
        const [divisions, departments, teams] = await Promise.all([
          getDivisions(orgId),
          getDepartments(orgId),
          getTeams(orgId),
        ])
        if (cancelled) return

        const scopes = []
        for (const div of divisions) {
          scopes.push({ id: div.scope_id || div.id, name: div.name, type: 'division' })
        }
        for (const dept of departments) {
          scopes.push({ id: dept.scope_id || dept.id, name: dept.name, type: 'department' })
        }
        for (const team of teams) {
          scopes.push({ id: team.scope_id || team.id, name: team.name, type: 'team' })
        }
        setOrgScopes(scopes)
      } catch (err) {
        console.warn('[ActionsView] Failed to load org scopes:', err.message)
      }
    }

    loadScopes()
    return () => { cancelled = true }
  }, [orgId, getDivisions, getDepartments, getTeams])

  // Sidebar state (persisted in localStorage)
  const [showChat, setShowChat] = useState(() => {
    try { return localStorage.getItem('action-q-sidebar-open') !== 'false' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('action-q-sidebar-open', showChat ? 'true' : 'false') } catch {}
  }, [showChat])

  // Filter / sort state
  const [filters, setFilters] = useState({
    search: '',
    priority: '',
    category: '',
    sort: 'newest',
    showArchived: false,
  })
  const searchTimerRef = useRef(null)
  const [searchInput, setSearchInput] = useState('')

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setFilters(f => ({ ...f, search: searchInput }))
    }, 200)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchInput])

  // Auto-archive items that have been done >7 days. Only writes state when
  // archive actually flips an item — `migrateItem` always creates new refs so
  // we can't compare references; rely on autoArchiveItems' `changed` flag.
  useEffect(() => {
    if (data.items.length === 0) return
    const migrated = data.items.map(migrateItem)
    const { items: archived, changed } = autoArchiveItems(migrated)
    if (changed) {
      setData(d => ({ ...d, items: archived }))
    }
  }, [data.items])

  // Load from server on mount and when scope changes — guarded on both userId and orgId
  useEffect(() => {
    if (!userId || !orgId) {
      // No auth context yet — nothing is authoritative. ACTIONQ-FIX-SPEC 1b:
      // no pre-auth/default-user cache hydration (a stale cache can belong
      // to a different identity entirely); stay empty and loading.
      setLoading(!userId) // only loading if no user yet
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    // Determine scopeId to pass: 'my' = no scope (user tasks), 'all' = no filter, specific ID = filter by scope
    const scopeOpts = { orgId }
    if (selectedScope !== 'my' && selectedScope !== 'all') {
      scopeOpts.scopeId = selectedScope
    }
    // For 'my' scope, we load all and filter client-side (no scopeId = user's tasks)
    // For 'all', we load everything (no scopeId filter)

    // ACT-STREAK: load streak from server in parallel with items.
    // Streak is now server-authoritative — localStorage is just a fallback.
    Promise.all([
      getActions(userId, scopeOpts),
      fetchStreak(userId, orgId),
    ]).then(([serverItems, serverStreak]) => {
      if (cancelled) return
      setData(d => ({
        ...d,
        items: serverItems,
        streak: serverStreak || d.streak,
      }))
      setLoading(false)
    }).catch(err => {
      if (cancelled) return
      console.warn('[ActionsView] Server load failed:', err.message)
      // ACTIONQ-FIX-SPEC 1b: a failed/unauthorized GET must never fall back
      // to a cached board — the cache could belong to a different org/user.
      // Show an explicit unavailable/retry state instead of stale data.
      setError('Could not reach server — try again')
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [userId, orgId, selectedScope]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e) => {
      // Don't trigger shortcuts when typing in inputs/textareas or contenteditable
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.target.isContentEditable) return
      if (modal) return // modal open, don't hijack

      if (e.key === 'n') {
        e.preventDefault()
        setInlineAddOpen(true)
        setTimeout(() => inlineAddRef.current?.focus(), 50)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [modal])

  // ── Filtered + sorted items via useMemo ──

  const categories = useMemo(() => getUniqueCategories(data.items), [data.items])

  const filteredItemsByColumn = useMemo(() => {
    const migrated = data.items.map(migrateItem)
    const filtered = filterItems(migrated, filters)
    const sorted = sortItems(filtered, filters.sort)

    return {
      todo: sorted.filter(i => i.status === 'todo'),
      doing: sorted.filter(i => i.status === 'doing'),
      done: sorted.filter(i => i.status === 'done'),
    }
  }, [data.items, filters])

  // ── Drag & Drop ──

  const onDragStart = useCallback((e, id) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragState(s => ({ ...s, draggedId: id }))
  }, [])

  const onDragEnd = useCallback(() => {
    setDragState({ draggedId: null, overColumn: null })
  }, [])

  const onDragOver = useCallback((e, colId) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragState(s => (s.overColumn === colId ? s : { ...s, overColumn: colId }))
  }, [])

  const onDragLeave = useCallback((e, colId) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragState(s => (s.overColumn === colId ? { ...s, overColumn: null } : s))
    }
  }, [])

  // ── Actions ──

  const triggerConfetti = useCallback(() => {
    setConfetti(true)
    if (confettiTimer.current) clearTimeout(confettiTimer.current)
    confettiTimer.current = setTimeout(() => setConfetti(false), 1200)
  }, [])

  const triggerDoneGlow = useCallback(() => {
    setDoneGlow(true)
    setTimeout(() => setDoneGlow(false), 1200)
  }, [])

  // ACTIONQ-FIX-SPEC 1c: items with a mutation awaiting server confirmation.
  // The card stays on its LAST CONFIRMED status (no optimistic move) and
  // shows "Saving…" instead — completion/confetti/streak only fire after
  // the server actually confirms (moveAction now rejects on any failure).
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const markPending = useCallback((id) => setPendingIds(s => new Set(s).add(id)), [])
  const clearPending = useCallback((id) => setPendingIds(s => { const n = new Set(s); n.delete(id); return n }), [])

  const handleMove = useCallback(async (id, newStatus) => {
    const item = data.items.find(i => i.id === id)
    if (!item || item.status === newStatus || pendingIds.has(id)) return

    markPending(id)
    try {
      // moveAction is server-authoritative with an org context: it resolves
      // with the canonical server item (and streak, when flipped to done)
      // only after a confirmed 2xx — never before.
      const result = await moveAction(id, newStatus, userId, orgId)
      if (!result) return // local-only no-op (no org context, item missing, etc.)

      setData(d => ({
        items: d.items.some(i => i.id === id) ? d.items.map(i => i.id === id ? result : i) : [...d.items, result],
        streak: result._streak || d.streak,
      }))

      if (newStatus === 'done') {
        triggerConfetti()
        triggerDoneGlow()
      }
    } catch (err) {
      console.warn('[ActionsView] Move failed:', err.message)
      setError(err?.status === 403 || err?.status === 404
        ? 'You no longer have access to this task — refresh to see the current board'
        : 'Could not save — try again')
    } finally {
      clearPending(id)
    }
  }, [data, userId, orgId, pendingIds, markPending, clearPending, triggerConfetti, triggerDoneGlow])

  const onDrop = useCallback((e, colId) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    handleMove(id, colId)
    setDragState({ draggedId: null, overColumn: null })
  }, [handleMove])

  const handleSave = useCallback(async (formData) => {
    if (modal.mode === 'add') {
      // Use service function (server-first)
      try {
        const newItem = await addAction(formData.title, {
          description: formData.description,
          priority: formData.priority,
          category: formData.category,
          dueDate: formData.dueDate,
          notes: formData.notes,
          scopeId: formData.scopeId || null,
          scopeName: formData.scopeName || null,
        }, userId, orgId)
        setData(d => ({ ...d, items: [...d.items, newItem] }))
        logActionCreated(newItem, userId)
        setModal(null)
      } catch (err) {
        console.warn('[ActionsView] Add action failed:', err.message)
        setError('Could not create action — try again')
        setTimeout(() => setError(null), 4000)
        // Modal stays open
      }
    } else {
      const updates = {
        title: formData.title,
        description: formData.description || '',
        priority: formData.priority || null,
        category: formData.category || '',
        dueDate: formData.dueDate || null,
        notes: formData.notes || '',
        scopeId: formData.scopeId || null,
        scopeName: formData.scopeName || null,
      }
      // ACTIONQ-FIX-SPEC 1c: wait for server confirmation before applying
      // the change — a failed update keeps the edit form OPEN and the
      // original item untouched, rather than closing the modal and leaving
      // state that was never actually written server-side.
      try {
        const updatedItem = await updateAction(modal.item.id, updates, userId, orgId)
        setData(d => ({
          ...d,
          items: d.items.map(i => i.id === modal.item.id ? (updatedItem || { ...i, ...updates }) : i),
        }))
        setModal(null)
      } catch (err) {
        console.warn('[ActionsView] Update failed:', err.message)
        setError('Could not save changes — try again')
        // Modal stays open; original item is untouched (no optimistic write).
      }
    }
  }, [modal, userId, orgId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = useCallback(async (id) => {
    // ACTIONQ-FIX-SPEC 1c: wait for confirmed deletion before removing the
    // task from the board/closing the modal — a failed delete keeps the task.
    try {
      await deleteAction(id, userId, orgId)
      setData(d => ({ ...d, items: d.items.filter(i => i.id !== id) }))
      setModal(null)
    } catch (err) {
      console.warn('[ActionsView] Delete failed:', err.message)
      setError('Could not delete — try again')
    }
  }, [userId, orgId])

  // ── Delegate handler ──
  const [delegateToast, setDelegateToast] = useState(null)
  const [showAnalytics, setShowAnalytics] = useState(() => {
    try { return localStorage.getItem('action-q-analytics-open') === 'true' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('action-q-analytics-open', showAnalytics ? 'true' : 'false') } catch {}
  }, [showAnalytics])

  const handleDelegate = useCallback(async (item) => {
    if (!orgId) return
    setDelegateToast(`Delegating "${item.title}"...`)
    try {
      const res = await fetch('/collector/chat/tools/action_delegate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, orgId }),
      })
      if (res.ok) {
        const result = await res.json()
        // Update local state: move to doing
        setData(d => ({
          ...d,
          items: d.items.map(i => i.id === item.id
            ? { ...i, status: 'doing', notes: (i.notes || '') + `\nDelegated to objective ${result.objectiveId || 'unknown'}` }
            : i
          ),
        }))
        setDelegateToast(`Delegated to WARDEN — watch in OpsDeck`)
        setTimeout(() => setDelegateToast(null), 4000)
      } else {
        setDelegateToast('Delegation failed — try via ACTION-Q chat')
        setTimeout(() => setDelegateToast(null), 4000)
      }
    } catch {
      setDelegateToast('Delegation failed — try via ACTION-Q chat')
      setTimeout(() => setDelegateToast(null), 4000)
    }
  }, [orgId])

  // ── Inline quick-add handler ──
  const handleInlineAdd = useCallback(async (e) => {
    e.preventDefault()
    const title = inlineAddValue.trim()
    if (!title) return
    setInlineAddValue('')
    const opts = {}
    if (selectedScope !== 'my' && selectedScope !== 'all') {
      const scope = orgScopes.find(s => s.id === selectedScope)
      if (scope) { opts.scopeId = scope.id; opts.scopeName = scope.name }
    }
    const newItem = await addAction(title, opts, userId, orgId)
    setData(d => ({ ...d, items: [...d.items, newItem] }))
    logActionCreated(newItem, userId)
    // Keep input open for rapid entry
    inlineAddRef.current?.focus()
  }, [inlineAddValue, userId, orgId, selectedScope, orgScopes]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── License gate ──

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Action Tracker" accentColor="#10b981" />
  }

  // ── Render ──

  const stats = computeStats(data.items.map(migrateItem))
  const todayStr = new Date().toISOString().slice(0, 10)

  // Count total filtered items for empty state
  const totalFiltered = filteredItemsByColumn.todo.length + filteredItemsByColumn.doing.length + filteredItemsByColumn.done.length
  const hasActiveFilters = filters.search || filters.priority || filters.category || filters.showArchived

  return (
    <div className="qx-view actions-page">
      <div className="actions-split">
        {/* Main panel — single qx-card containing everything */}
        <main className="actions-main qx-card">
          {/* Top bar — identity (left) | scope + view (centre) | add + chat (right) */}
          <header className="actions-topbar">
            <div className="actions-topbar__identity">
              <span className="qx-dot qx-dot--online" />
              <strong className="actions-topbar__name">ACTION-Q</strong>
              <span className="qx-pill qx-pill--purple qx-pill--sm">Task Management</span>
            </div>

            <div className="actions-topbar__center">
              <ScopeSelector scopes={orgScopes} selectedScope={selectedScope} onSelect={setSelectedScope} />
              <ViewToggle activeView={activeView} onToggle={setActiveView} />
            </div>

            <div className="actions-topbar__actions">
              <button
                type="button"
                className="qx-btn qx-btn--primary qx-btn--sm"
                onClick={() => setModal({ mode: 'add' })}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add
              </button>
              <button
                type="button"
                className={`qx-btn qx-btn--ghost qx-btn--sm ${showChat ? 'actions-chat-btn--active' : ''}`}
                onClick={() => setShowChat(v => !v)}
                title={showChat ? 'Hide ACTION-Q' : 'Show ACTION-Q'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'currentColor' }}>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Chat
              </button>
            </div>
          </header>

          {/* Filters — search + priority + category + sort + archived (single compact row) */}
          <div className="actions-filters">
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search tasks…"
              className="qx-input actions-filters__search"
            />
            <select
              value={filters.priority}
              onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}
              className="qx-select"
            >
              <option value="">All priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              className="qx-select"
              value={filters.category}
              onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
            >
              <option value="">All categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <select
              className="qx-select"
              value={filters.sort}
              onChange={e => setFilters(f => ({ ...f, sort: e.target.value }))}
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="priority">Priority</option>
              <option value="due-date">Due date</option>
            </select>
            <button
              type="button"
              className={`qx-btn qx-btn--ghost qx-btn--sm ${filters.showArchived ? 'actions-archive-btn--active' : ''}`}
              onClick={() => setFilters(f => ({ ...f, showArchived: !f.showArchived }))}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              {filters.showArchived ? 'Hide Archived' : 'Archived'}
            </button>
          </div>

          {/* Inline error banner (transient) */}
          {error && (
            <div className="qx-banner qx-banner--error" style={{ borderRadius: 8 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'currentColor' }} strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {error}
            </div>
          )}

          {/* Loading state */}
          {loading && data.items.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem 0', color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
              Loading actions…
            </div>
          )}

        {/* Body — board or aggregate, fills remaining height */}
        <div className="actions-body">

        {/* Empty state for filtered results */}
        {hasActiveFilters && totalFiltered === 0 && (
          <div className="qx-empty" style={{ padding: '40px 20px' }}>
            <div className="qx-empty__icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <p className="qx-empty__body">No items match your filters</p>
            <button
              className="qx-btn qx-btn--ghost qx-btn--sm"
              onClick={() => { setFilters({ search: '', priority: '', category: '', sort: 'newest', showArchived: false }); setSearchInput('') }}
            >
              Clear Filters
            </button>
          </div>
        )}

        {/* Kanban Board (shown in 'board' view) */}
        {activeView === 'board' && !(hasActiveFilters && totalFiltered === 0) && (
        <div className="actions-board">
          {COLUMNS.map(col => {
            const colItems = filteredItemsByColumn[col.id]
            const isOver = dragState.overColumn === col.id
            return (
              <div
                key={col.id}
                className={[
                  'actions-column',
                  col.className,
                  isOver ? 'column-drag-over' : '',
                  col.id === 'done' && doneGlow ? 'column-done-glow' : '',
                ].filter(Boolean).join(' ')}
                onDragOver={e => onDragOver(e, col.id)}
                onDragLeave={e => onDragLeave(e, col.id)}
                onDrop={e => onDrop(e, col.id)}
              >
                <div className="actions-column-header">
                  <span className="actions-column-title">
                    {col.label}
                    <span className="actions-column-count">{colItems.length}</span>
                  </span>
                </div>

                {/* Inline quick-add at top of TODO column */}
                {col.id === 'todo' && (
                  <div className="actions-column-quick-add">
                    {inlineAddOpen ? (
                      <form onSubmit={handleInlineAdd} style={{ display: 'flex', gap: 4, flex: 1 }}>
                        <input
                          ref={inlineAddRef}
                          type="text"
                          value={inlineAddValue}
                          onChange={e => setInlineAddValue(e.target.value)}
                          placeholder="New task... (Enter to add)"
                          className="qx-input actions-column-quick-add-input"
                          style={{ fontSize: 12, padding: '4px 8px' }}
                          autoFocus
                          onBlur={() => { if (!inlineAddValue.trim()) setInlineAddOpen(false) }}
                          onKeyDown={e => { if (e.key === 'Escape') { setInlineAddOpen(false); setInlineAddValue('') } }}
                        />
                      </form>
                    ) : (
                      <button
                        className="actions-column-quick-add-btn"
                        onClick={() => { setInlineAddOpen(true); setTimeout(() => inlineAddRef.current?.focus(), 50) }}
                        title="Quick add task"
                      >
                        +
                      </button>
                    )}
                  </div>
                )}

                <div className="actions-column-body">
                  {colItems.length === 0 ? (
                    <div className="actions-column-empty">
                      {col.id === 'done' ? 'Drag items here to complete' : 'No items'}
                    </div>
                  ) : (
                    colItems.map(item => (
                      <ActionCard
                        key={item.id}
                        item={item}
                        todayStr={todayStr}
                        isDragging={dragState.draggedId === item.id}
                        isPending={pendingIds.has(item.id)}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onEdit={() => setModal({ mode: 'edit', item })}
                        onMove={handleMove}
                        onDelegate={handleDelegate}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
        )}

        {/* Aggregate View (shown in 'aggregate' view) */}
        {activeView === 'aggregate' && !(hasActiveFilters && totalFiltered === 0) && (
          <div className="actions-aggregate-wrap">
            <AggregateView
              items={data.items.map(migrateItem)}
              scopes={orgScopes}
              onSelectScope={(scopeId) => {
                setSelectedScope(scopeId)
                setActiveView('board')
              }}
            />
          </div>
        )}

        {/* Stats View (shown in 'stats' view) */}
        {activeView === 'stats' && (
          <div className="actions-stats-wrap">
            <StatsView stats={stats} streak={data.streak} items={data.items} />
          </div>
        )}

        </div>{/* /.actions-body */}

        {/* Confetti */}
        {confetti && <ConfettiBurst />}

        {/* Add/Edit Modal */}
        {modal && (
          <ActionModal
            mode={modal.mode}
            item={modal.item}
            onSave={handleSave}
            onDelete={handleDelete}
            onClose={() => setModal(null)}
            scopes={orgScopes}
          />
        )}
      </main>

      {/* Right: ACTION-Q chat sidebar (320px) */}
        <aside className={`actions-sidebar-wrap qx-card ${showChat ? '' : 'collapsed'}`}>
          <ActionQSidebar
            actions={data}
            stats={stats}
          />
        </aside>
      </div>{/* /.actions-split */}
    </div>
  )
}
