/**
 * VoltRunList — Run list with search, filters, ARIA listbox
 *
 * GLV-4: migrated to glass-primitives (GlassPanel + GlassButton).
 * Search bar, filter panel, run rows, empty/error/loading states
 * now use unified glass tokens + COLORS from compliance/glass-primitives.
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import { GlassPanel, GlassButton, COLORS, M } from '../compliance/glass-primitives'

// ── Inline SVG icons ──────────────────────────────────────

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const FilterIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </svg>
)

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
)

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

const XIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ── Date grouping ─────────────────────────────────────────

function groupByDate(runs) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const thisWeek = new Date(today)
  thisWeek.setDate(thisWeek.getDate() - 7)

  const groups = { today: [], yesterday: [], thisWeek: [], older: [] }

  for (const run of runs) {
    const d = new Date(run.started_at)
    if (d >= today) groups.today.push(run)
    else if (d >= yesterday) groups.yesterday.push(run)
    else if (d >= thisWeek) groups.thisWeek.push(run)
    else groups.older.push(run)
  }
  return groups
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const GROUP_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This Week',
  older: 'Older'
}

const STATUS_COLORS = {
  completed: COLORS.green,
  active:    COLORS.cyan,
  error:     COLORS.red,
}

// ── Glass input primitives (local to this file) ──────────

const glassInputStyle = {
  fontFamily: M, fontSize: 11, color: '#fff',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8, padding: '6px 10px',
  outline: 'none',
}

// ── Component ─────────────────────────────────────────────

export default function VoltRunList({
  runs,
  stats,
  bridgeStats,
  loading,
  loadingMore,
  error,
  filters,
  setFilters,
  clearFilters,
  refresh,
  loadMore,
  pagination,
  selectedRun,
  onSelectRun,
  focusIndex = -1
}) {
  const [showFilters, setShowFilters] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const listRef = useRef(null)

  const activeFilterCount = [filters.status, filters.after, filters.before].filter(Boolean).length

  const grouped = useMemo(() => groupByDate(runs), [runs])

  const flatRuns = useMemo(() => {
    const flat = []
    for (const key of ['today', 'yesterday', 'thisWeek', 'older']) {
      for (const run of grouped[key]) flat.push(run)
    }
    return flat
  }, [grouped])

  useEffect(() => {
    if (focusIndex >= 0 && listRef.current) {
      const rows = listRef.current.querySelectorAll('[role="option"]')
      if (rows[focusIndex]) rows[focusIndex].scrollIntoView({ block: 'nearest' })
    }
  }, [focusIndex])

  const handleSearch = (e) => {
    if (e.key === 'Enter') {
      setFilters(prev => ({ ...prev, corr: searchValue.trim() }))
    }
  }

  const handleSearchClear = () => {
    setSearchValue('')
    setFilters(prev => ({ ...prev, corr: '' }))
  }

  const runFocusMap = useMemo(() => {
    const map = new Map()
    flatRuns.forEach((run, i) => map.set(run.run_id, i))
    return map
  }, [flatRuns])

  return (
    <div className="volt-list-panel">
      {/* Search + filter bar — GLV-4 */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: COLORS.dimText, display: 'flex', pointerEvents: 'none',
          }}>
            <SearchIcon />
          </span>
          <input
            style={{ ...glassInputStyle, width: '100%', paddingLeft: 32, paddingRight: searchValue ? 30 : 10 }}
            placeholder="Search by correlation ID…"
            value={searchValue}
            onChange={e => setSearchValue(e.target.value)}
            onKeyDown={handleSearch}
          />
          {searchValue && (
            <button
              onClick={handleSearchClear}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                background: 'transparent', border: 'none', padding: 2,
                color: COLORS.dimText, cursor: 'pointer', display: 'flex',
              }}
              aria-label="Clear search"
            >
              <XIcon />
            </button>
          )}
        </div>

        <GlassButton
          variant={showFilters || activeFilterCount > 0 ? 'primary' : 'default'}
          onClick={() => setShowFilters(!showFilters)}
        >
          <FilterIcon />
          Filters
          {activeFilterCount > 0 && (
            <span style={{
              padding: '1px 6px', borderRadius: 10,
              background: 'rgba(168,85,247,0.25)',
              fontFamily: M, fontSize: 9, fontWeight: 700,
            }}>{activeFilterCount}</span>
          )}
        </GlassButton>

        <GlassButton onClick={refresh} title="Refresh" size="sm">
          <RefreshIcon />
        </GlassButton>
      </div>

      {/* Filter panel — GLV-4 */}
      {showFilters && (
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.015)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr)) auto', gap: 10, alignItems: 'end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{
                fontFamily: M, fontSize: 9, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 0.8,
              }}>Status</label>
              <select
                style={glassInputStyle}
                value={filters.status}
                onChange={e => setFilters(prev => ({ ...prev, status: e.target.value }))}
              >
                <option value="" style={{ background: '#1a1a2e' }}>All</option>
                <option value="completed" style={{ background: '#1a1a2e' }}>Completed</option>
                <option value="active" style={{ background: '#1a1a2e' }}>Active</option>
                <option value="error" style={{ background: '#1a1a2e' }}>Error</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{
                fontFamily: M, fontSize: 9, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 0.8,
              }}>After</label>
              <input
                type="date"
                style={{ ...glassInputStyle, colorScheme: 'dark' }}
                value={filters.after ? filters.after.slice(0, 10) : ''}
                onChange={e => setFilters(prev => ({
                  ...prev,
                  after: e.target.value ? new Date(e.target.value).toISOString() : ''
                }))}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{
                fontFamily: M, fontSize: 9, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 0.8,
              }}>Before</label>
              <input
                type="date"
                style={{ ...glassInputStyle, colorScheme: 'dark' }}
                value={filters.before ? filters.before.slice(0, 10) : ''}
                onChange={e => setFilters(prev => ({
                  ...prev,
                  before: e.target.value ? new Date(e.target.value + 'T23:59:59').toISOString() : ''
                }))}
              />
            </div>
            <GlassButton onClick={() => { clearFilters(); setSearchValue('') }}>
              Clear
            </GlassButton>
          </div>
        </div>
      )}

      {/* Run list */}
      <div className="volt-list-scroll" ref={listRef} role="listbox" aria-label="VOLT runs">
        {loading && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', padding: 48, gap: 12,
          }}>
            <div className="volt-spinner" />
            <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>Loading VOLT runs…</div>
          </div>
        )}

        {error && (
          <div style={{ padding: 16 }}>
            <GlassPanel highlight={COLORS.red} style={{ padding: 20, textAlign: 'center' }}>
              <div style={{ fontFamily: M, fontSize: 12, color: COLORS.red, marginBottom: 6, fontWeight: 700 }}>Error</div>
              <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText, marginBottom: 12 }}>{error}</div>
              <GlassButton variant="danger" onClick={refresh}>Retry</GlassButton>
            </GlassPanel>
          </div>
        )}

        {!loading && !error && runs.length === 0 && (
          <div style={{ padding: 16 }}>
            <GlassPanel style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', marginBottom: 12 }}>
                <ShieldIcon />
              </div>
              <div style={{ fontFamily: M, fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                No VOLT runs yet
              </div>
              <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText, maxWidth: 340, margin: '0 auto', lineHeight: 1.5 }}>
                VOLT records hash-chained audit trails for agent actions via the AEE bridge.
                Runs will appear here once the bridge is active.
              </div>
            </GlassPanel>
          </div>
        )}

        {!loading && !error && runs.length > 0 && (
          <>
            {Object.entries(grouped).map(([key, groupRuns]) => {
              if (groupRuns.length === 0) return null
              return (
                <div key={key} style={{ padding: '8px 16px 4px' }}>
                  <div style={{
                    fontFamily: M, fontSize: 9, fontWeight: 600, letterSpacing: 1,
                    color: COLORS.dimText, textTransform: 'uppercase',
                    padding: '6px 4px',
                  }}>{GROUP_LABELS[key]}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {groupRuns.map(run => {
                      const flatIdx = runFocusMap.get(run.run_id)
                      const isFocused = flatIdx === focusIndex
                      const isSelected = selectedRun?.run_id === run.run_id
                      const statusColor = STATUS_COLORS[run.status] || COLORS.dimText

                      return (
                        <div
                          key={run.run_id}
                          onClick={() => onSelectRun(run)}
                          role="option"
                          aria-selected={isSelected}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '80px 1fr auto auto auto',
                            alignItems: 'center',
                            gap: 10, padding: '8px 12px',
                            borderRadius: 8, cursor: 'pointer',
                            background: isSelected
                              ? `linear-gradient(145deg, ${statusColor}18 0%, ${statusColor}06 100%)`
                              : isFocused ? 'rgba(255,255,255,0.04)' : 'transparent',
                            border: isSelected
                              ? `1px solid ${statusColor}50`
                              : '1px solid transparent',
                            boxShadow: isSelected ? `0 0 12px ${statusColor}15` : 'none',
                            transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                          }}
                        >
                          <span style={{
                            fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                            padding: '2px 8px', borderRadius: 4,
                            background: `${statusColor}1f`,
                            color: statusColor,
                            textTransform: 'uppercase', textAlign: 'center',
                          }}>{run.status}</span>
                          <span style={{
                            fontFamily: M, fontSize: 11, color: '#fff',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }} title={run.corr}>
                            {run.corr || run.run_id}
                          </span>
                          <span style={{
                            fontFamily: M, fontSize: 10, color: COLORS.dimText,
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {run.seq ? run.seq - 1 : 0} evts
                          </span>
                          <span style={{
                            fontFamily: M, fontSize: 10, color: COLORS.dimText,
                            fontVariantNumeric: 'tabular-nums',
                          }} title={run.run_id}>
                            {run.run_id.slice(0, 8)}
                          </span>
                          <span style={{
                            fontFamily: M, fontSize: 10, color: COLORS.dimText,
                            fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                          }}>
                            {formatTime(run.started_at)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {/* Load More */}
            {pagination && pagination.total > 0 && (pagination.offset + pagination.limit) < pagination.total && (
              <div style={{ padding: '12px 16px 16px' }}>
                <GlassButton
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {loadingMore ? 'Loading…' : `Load More (${runs.length} of ${pagination.total})`}
                </GlassButton>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
