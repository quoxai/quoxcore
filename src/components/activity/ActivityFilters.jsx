/**
 * ActivityFilters - Grouped Glass Filter Strip
 *
 * Collapsed: compact bar with search, active pills, count, clear-all, expand
 * Expanded: grouped source toggles + time/search/verbosity controls
 *
 * Sources grouped by purpose (not flat 19-chip wall):
 *   Conversations: chat, inbox, telegram
 *   Work: workflows, objectives, actions
 *   Infrastructure: shell, terminal, fleet, delegation
 *   System: aocl, audit, memory, approvals
 *   Content: files, plugins, teams
 *   Issues: errors
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { SOURCE_CATEGORIES } from '../../lib/aee/store'
import { queueSync } from '../../services/serverSyncQueue'

const FILTER_STORAGE_KEY = 'quox_activity_filters'

const SOURCE_GROUPS = [
  { id: 'conversations', label: 'Conversations', sources: ['chat', 'inbox', 'telegram'], color: '#38bdf8',
    icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'work', label: 'Work', sources: ['workflow', 'objectives', 'actions'], color: '#a855f7',
    icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id: 'infra', label: 'Infra', sources: ['shell', 'terminal', 'fleet', 'delegation'], color: '#22d3ee',
    icon: 'M4 17l6-6-6-6M12 19h8' },
  { id: 'system', label: 'System', sources: ['aocl', 'audit', 'memory', 'approvals'], color: '#f59e0b',
    icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { id: 'content', label: 'Content', sources: ['files', 'plugins', 'teams'], color: '#10b981',
    icon: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' },
  { id: 'issues', label: 'Issues', sources: ['errors'], color: '#ef4444',
    icon: 'M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' },
]

export const DEFAULT_FILTERS = {
  search: '',
  dateRange: 'all',
  verbosity: 'normal',
  sources: [],
  // AEE-CORE-2.4: when true, list includes single-event infrastructure
  // envelopes (ops.volt.sync, aocl.layer.* orphans, fleet heartbeats, etc.)
  // that are normally hidden from user-facing view.
  includeInfra: false,
  // QOBS-1b: signal-first default lens. When true (the default), the
  // conversation list only shows conversations with at least one real
  // user action (breakdown.user_actions > 0) — pure-infra conversations
  // (AOCL/tool/agent-stream chatter with zero user actions) are hidden.
  // Toggling "Include infrastructure events" clears this (see
  // ActivityFilters' infra checkbox) to reveal them alongside includeInfra.
  // A user's saved localStorage choice always wins over this default.
  onlyWithUserActions: true,
  // AEE-CORE-5.2: agent filter — '' means "any agent". Populated from the
  // set of agent ids found in the loaded conversations.
  agent: '',
  // AEE-CORE-5.3: breakdown quick-filters — each filters conversations to
  // only those whose breakdown has >0 in that category.
  onlyWithTools: false,
  onlyWithPolicy: false,
  onlyWithErrors: false,
  // Legacy keys kept for compat — not rendered as controls anymore
  type: 'all',
  intent: 'all',
  layer: 'all',
}

function loadPersistedFilters() {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY)
    if (saved) return { ...DEFAULT_FILTERS, ...JSON.parse(saved) }
  } catch { /* ignore */ }
  return null
}

function persistFilters(filters) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters)) } catch { /* ignore */ }
  queueSync('activityFilters', filters)
}

/** Check if a group is fully selected */
function isGroupActive(sources, group) {
  return group.sources.every(s => sources.includes(s))
}

/** Check if a group is partially selected */
function isGroupPartial(sources, group) {
  return group.sources.some(s => sources.includes(s)) && !isGroupActive(sources, group)
}

/** Build active filter pills */
function getActivePills(filters) {
  const pills = []
  if (filters.sources?.length > 0) {
    // Show group names if full groups are selected, otherwise individual sources
    const remaining = [...filters.sources]
    for (const group of SOURCE_GROUPS) {
      if (isGroupActive(filters.sources, group)) {
        pills.push({ key: `group-${group.id}`, label: group.label, color: group.color, clear: () => {
          const without = filters.sources.filter(s => !group.sources.includes(s))
          return { sources: without }
        }})
        group.sources.forEach(s => { const idx = remaining.indexOf(s); if (idx >= 0) remaining.splice(idx, 1) })
      }
    }
    // Any remaining individual sources
    for (const s of remaining) {
      const cat = SOURCE_CATEGORIES[s]
      pills.push({ key: `src-${s}`, label: cat?.label || s, color: cat?.color || '#64748b', clear: () => {
        return { sources: filters.sources.filter(x => x !== s) }
      }})
    }
  }
  if (filters.dateRange !== 'all') {
    const labels = { hour: 'Last Hour', day: 'Last 24h', week: 'Last Week' }
    pills.push({ key: 'dateRange', label: labels[filters.dateRange] || filters.dateRange, color: '#a855f7', clear: () => ({ dateRange: 'all' }) })
  }
  return pills
}

function countActive(filters) {
  let n = 0
  if (filters.sources?.length > 0) n++
  if (filters.dateRange !== 'all') n++
  if (filters.search) n++
  if (filters.agent) n++
  if (filters.onlyWithTools) n++
  if (filters.onlyWithPolicy) n++
  if (filters.onlyWithErrors) n++
  if (filters.includeInfra) n++
  return n
}

export default function ActivityFilters({ filters, onFilterChange, totalCount, filteredCount, availableAgents = [], hideSourceGroups = false }) {
  const [expanded, setExpanded] = useState(false)
  const [panelHeight, setPanelHeight] = useState(0)
  const panelRef = useRef(null)

  useEffect(() => {
    const saved = loadPersistedFilters()
    if (saved) onFilterChange(() => saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { persistFilters(filters) }, [filters])

  // Animate panel
  useEffect(() => {
    if (!panelRef.current) return
    if (expanded) {
      setPanelHeight(panelRef.current.scrollHeight)
      const timer = setTimeout(() => setPanelHeight('auto'), 300)
      return () => clearTimeout(timer)
    } else {
      setPanelHeight(panelRef.current.scrollHeight)
      requestAnimationFrame(() => setPanelHeight(0))
    }
  }, [expanded])

  const handleChange = useCallback((key, value) => {
    onFilterChange(prev => ({ ...prev, [key]: value }))
  }, [onFilterChange])

  const toggleGroup = useCallback((group) => {
    onFilterChange(prev => {
      const current = prev.sources || []
      if (isGroupActive(current, group)) {
        // Deselect all in group
        return { ...prev, sources: current.filter(s => !group.sources.includes(s)) }
      } else {
        // Select all in group (add missing ones)
        const next = [...current]
        for (const s of group.sources) {
          if (!next.includes(s)) next.push(s)
        }
        return { ...prev, sources: next }
      }
    })
  }, [onFilterChange])

  const toggleSource = useCallback((sourceKey) => {
    onFilterChange(prev => {
      const current = prev.sources || []
      const next = current.includes(sourceKey)
        ? current.filter(s => s !== sourceKey)
        : [...current, sourceKey]
      return { ...prev, sources: next }
    })
  }, [onFilterChange])

  const clearAll = useCallback(() => {
    onFilterChange(() => ({ ...DEFAULT_FILTERS }))
  }, [onFilterChange])

  const removePill = useCallback((clearFn) => {
    onFilterChange(prev => ({ ...prev, ...clearFn() }))
  }, [onFilterChange])

  const activeSources = filters.sources || []
  const activeCount = countActive(filters)
  const pills = getActivePills(filters)

  return (
    <div className="af">
      {/* ── Collapsed Bar ── */}
      <div className="af-bar">
        <div className="af-bar__search">
          <svg viewBox="0 0 24 24" width="13" height="13" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.4)', strokeWidth: 2 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={filters.search}
            onChange={e => handleChange('search', e.target.value)}
            placeholder="Search..."
          />
          {filters.search && (
            <button className="af-bar__search-clear" onClick={() => handleChange('search', '')}>
              <svg viewBox="0 0 24 24" width="10" height="10" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2.5 }}>
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>

        {/* Active filter pills */}
        {pills.map(pill => (
          <span key={pill.key} className="af-pill" style={{ '--pill-color': pill.color }}>
            {pill.label}
            <button className="af-pill__x" onClick={() => removePill(pill.clear)}>
              <svg viewBox="0 0 24 24" width="8" height="8" style={{ fill: 'none', stroke: pill.color, strokeWidth: 3 }}>
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </span>
        ))}

        {/* Count */}
        <span className="af-bar__summary">
          {filteredCount !== undefined && totalCount !== undefined && (
            <span className="af-bar__count">{filteredCount}/{totalCount}</span>
          )}
        </span>

        {/* Clear all */}
        {activeCount > 0 && (
          <button className="af-bar__clear" onClick={clearAll} title="Clear all filters">
            Clear
          </button>
        )}

        {/* Expand toggle */}
        <button className={`af-bar__toggle ${expanded ? 'af-bar__toggle--open' : ''}`} onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse filters' : 'Expand filters'}>
          <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.6)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', transition: 'transform 0.2s ease', transform: expanded ? 'rotate(180deg)' : 'none' }}>
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
      </div>

      {/* ── Expanded Panel ── */}
      <div
        className="af-panel"
        ref={panelRef}
        style={{ maxHeight: typeof panelHeight === 'number' ? `${panelHeight}px` : panelHeight }}
      >
        <div className="af-panel__inner">
          {/* Source groups — hidden when a log-type tab already scopes the
              query (Governance/Tools/System); only meaningful on the default
              Conversations tab where multiple source types are still mixed. */}
          {!hideSourceGroups && (
          <div className="af-groups">
            {SOURCE_GROUPS.map(group => {
              const active = isGroupActive(activeSources, group)
              const partial = isGroupPartial(activeSources, group)
              return (
                <div key={group.id} className="af-group">
                  <button
                    className={`af-group__btn ${active ? 'af-group__btn--active' : ''} ${partial ? 'af-group__btn--partial' : ''}`}
                    style={{ '--group-color': group.color }}
                    onClick={() => toggleGroup(group)}
                    title={`${active ? 'Hide' : 'Show'} ${group.label}`}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" style={{ fill: 'none', stroke: active ? group.color : 'rgba(255,255,255,0.5)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                      <path d={group.icon}/>
                    </svg>
                    <span className="af-group__label">{group.label}</span>
                    <span className="af-group__count">{group.sources.length}</span>
                  </button>
                  {/* Individual sources within group */}
                  <div className="af-group__sources">
                    {group.sources.map(s => {
                      const cat = SOURCE_CATEGORIES[s]
                      const isActive = activeSources.includes(s)
                      return (
                        <button
                          key={s}
                          className={`af-src ${isActive ? 'af-src--active' : ''}`}
                          style={isActive ? { '--src-color': cat?.color || group.color } : {}}
                          onClick={() => toggleSource(s)}
                        >
                          {cat?.label || s}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          )}

          {/* Time + Verbosity row */}
          <div className="af-row">
            <span className="af-label">Time</span>
            <div className="af-time-pills">
              {[
                { value: 'all', label: 'All' },
                { value: 'hour', label: '1h' },
                { value: 'day', label: '24h' },
                { value: 'week', label: '7d' },
              ].map(opt => (
                <button
                  key={opt.value}
                  className={`af-time ${filters.dateRange === opt.value ? 'af-time--active' : ''}`}
                  onClick={() => handleChange('dateRange', opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <span className="af-label" style={{ marginLeft: 'auto' }}>Detail</span>
            <div className="af-time-pills">
              {[
                { value: 'minimal', label: 'Min' },
                { value: 'normal', label: 'Normal' },
                { value: 'verbose', label: 'Full' },
              ].map(opt => (
                <button
                  key={opt.value}
                  className={`af-time ${filters.verbosity === opt.value ? 'af-time--active' : ''}`}
                  onClick={() => handleChange('verbosity', opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* AEE-CORE-2.4: Infrastructure toggle — reveals ops dot-star,
              VOLT sync, orphan AOCL events etc. that are hidden from the default list. */}
          <div className="af-row" style={{ marginTop: 10 }}>
            <label className="af-infra-toggle" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>
              <input
                type="checkbox"
                checked={!!filters.includeInfra}
                onChange={(e) => {
                  const checked = e.target.checked
                  // QOBS-1b: the infra toggle now controls both the
                  // server-side noise blocklist (includeInfra) and the
                  // client-side signal lens (onlyWithUserActions) — one
                  // control, two mechanisms, same user intent.
                  onFilterChange(prev => ({ ...prev, includeInfra: checked, onlyWithUserActions: !checked }))
                }}
                style={{ cursor: 'pointer' }}
              />
              Include infrastructure events
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
                (ops, AOCL layers, VOLT sync, fleet heartbeats)
              </span>
            </label>
          </div>

          {/* AEE-CORE-5: agent dropdown + breakdown quick-filters. */}
          <div className="af-row af-row--expanded-controls" style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {availableAgents.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.72)' }}>
                <span className="af-label">Agent</span>
                <select
                  className="af-agent-select"
                  value={filters.agent || ''}
                  onChange={(e) => handleChange('agent', e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.85)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, padding: '3px 8px', fontSize: 12 }}
                >
                  <option value="">Any</option>
                  {availableAgents.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
            )}

            <div className="af-quick-filters" style={{ display: 'flex', gap: 6, marginLeft: availableAgents.length > 0 ? 0 : 'auto' }}>
              {[
                { key: 'onlyWithTools',  label: 'Tools',    title: 'Only conversations that invoked tools' },
                { key: 'onlyWithPolicy', label: 'Policy',   title: 'Only conversations with policy evaluations' },
                { key: 'onlyWithErrors', label: 'Errors',   title: 'Only conversations containing errors' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`af-time ${filters[opt.key] ? 'af-time--active' : ''}`}
                  title={opt.title}
                  onClick={() => handleChange(opt.key, !filters[opt.key])}
                  style={{ fontSize: 11 }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
