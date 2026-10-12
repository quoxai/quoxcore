/**
 * TRV-4: TraceSearchBar — filters for trace search
 * Search input + filter dropdowns + active filter pills
 */

import { GlassPill, M, F, COLORS } from '../compliance/glass-primitives'

const OUTCOME_OPTIONS = [
  { value: '', label: 'All outcomes' },
  { value: 'complete', label: 'Complete' },
  { value: 'policy_deny', label: 'Denied' },
  { value: 'hitl_pending', label: 'HITL Pending' },
  { value: 'error', label: 'Error' },
]

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'slowest', label: 'Slowest first' },
  { value: 'fastest', label: 'Fastest first' },
]

const selectStyle = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, padding: '6px 10px',
  fontFamily: M, fontSize: 11, color: COLORS.white,
  cursor: 'pointer', outline: 'none',
}

export default function TraceSearchBar({ filters, onFilterChange, onSearch }) {
  const activeFilters = []
  if (filters.outcome) activeFilters.push({ key: 'outcome', label: `Outcome: ${filters.outcome}` })
  if (filters.actor) activeFilters.push({ key: 'actor', label: `Actor: ${filters.actor}` })
  if (filters.after) activeFilters.push({ key: 'after', label: `After: ${filters.after.slice(0, 10)}` })
  if (filters.before) activeFilters.push({ key: 'before', label: `Before: ${filters.before.slice(0, 10)}` })
  if (filters.has_denial) activeFilters.push({ key: 'has_denial', label: 'Has denial' })
  if (filters.has_hitl) activeFilters.push({ key: 'has_hitl', label: 'Has HITL' })

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 12,
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid var(--m-border-default)',
      }}>
        {/* Search input */}
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 150 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COLORS.subtleText} strokeWidth="2"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search traces..."
            value={filters.query || ''}
            onChange={e => onFilterChange('query', e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--m-border-default)',
              borderRadius: 10, padding: '6px 10px 6px 32px',
              fontFamily: F, fontSize: 12, color: '#fff',
              outline: 'none',
            }}
          />
        </div>

        {/* Outcome filter */}
        <select
          value={filters.outcome || ''}
          onChange={e => onFilterChange('outcome', e.target.value || null)}
          style={selectStyle}
        >
          {OUTCOME_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Sort */}
        <select
          value={filters.sort || 'newest'}
          onChange={e => onFilterChange('sort', e.target.value)}
          style={selectStyle}
        >
          {SORT_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Denial toggle */}
        <button
          onClick={() => onFilterChange('has_denial', !filters.has_denial ? true : null)}
          style={{
            ...selectStyle,
            background: filters.has_denial ? `${COLORS.red}15` : selectStyle.background,
            borderColor: filters.has_denial ? `${COLORS.red}40` : 'rgba(255,255,255,0.1)',
            color: filters.has_denial ? COLORS.red : COLORS.dimText,
          }}
        >
          Denials
        </button>

        {/* HITL toggle */}
        <button
          onClick={() => onFilterChange('has_hitl', !filters.has_hitl ? true : null)}
          style={{
            ...selectStyle,
            background: filters.has_hitl ? `${COLORS.amber}15` : selectStyle.background,
            borderColor: filters.has_hitl ? `${COLORS.amber}40` : 'rgba(255,255,255,0.1)',
            color: filters.has_hitl ? COLORS.amber : COLORS.dimText,
          }}
        >
          HITL
        </button>
      </div>

      {/* Active filter pills */}
      {activeFilters.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {activeFilters.map(f => (
            <GlassPill key={f.key} color={COLORS.cyan} style={{ cursor: 'pointer', fontSize: 9 }}>
              {f.label}
              <span
                onClick={() => onFilterChange(f.key, f.key === 'has_denial' || f.key === 'has_hitl' ? null : '')}
                style={{ marginLeft: 4, opacity: 0.6, cursor: 'pointer' }}
              >
                x
              </span>
            </GlassPill>
          ))}
          <span
            onClick={() => {
              // Clear all non-default filters
              for (const f of activeFilters) {
                onFilterChange(f.key, f.key === 'has_denial' || f.key === 'has_hitl' ? null : '')
              }
            }}
            style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, cursor: 'pointer', alignSelf: 'center' }}
          >
            Clear all
          </span>
        </div>
      )}
    </div>
  )
}
