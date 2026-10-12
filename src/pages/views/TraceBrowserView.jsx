/**
 * TRV-4: TraceBrowserView — /traces page
 * Searchable, filterable list of traces with pagination.
 */

import { useNavigate, useSearchParams } from 'react-router-dom'
import { TraceSearchBar, TraceList } from '../../components/traces'
import { GlassPill, F, COLORS, PROTOCOL_COLORS } from '../../components/compliance/glass-primitives'
import useTraceSearch from '../../hooks/useTraceSearch'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'

export default function TraceBrowserView() {
  const diag = usePluginLicenseDiagnosis('aocl-compliance-suite')
  const licensed = diag.licensed
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Initialize filters from URL params
  const initialFilters = {
    query: searchParams.get('q') || '',
    outcome: searchParams.get('outcome') || null,
    sort: searchParams.get('sort') || 'newest',
    has_denial: searchParams.get('denial') === '1' || null,
    has_hitl: searchParams.get('hitl') === '1' || null,
  }

  const {
    traces, total, loading, error,
    filters, updateFilter, clearFilters,
    offset, setOffset, limit,
  } = useTraceSearch(initialFilters)

  // Sync filters to URL params
  const handleFilterChange = (key, value) => {
    updateFilter(key, value)
    const params = new URLSearchParams(searchParams)
    const urlMap = { query: 'q', outcome: 'outcome', sort: 'sort', has_denial: 'denial', has_hitl: 'hitl' }
    const urlKey = urlMap[key]
    if (urlKey) {
      if (value && value !== 'newest') {
        params.set(urlKey, key === 'has_denial' || key === 'has_hitl' ? '1' : value)
      } else {
        params.delete(urlKey)
      }
      setSearchParams(params, { replace: true })
    }
  }

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Traces" accentColor="#a855f7" />
  }

  return (
    <div style={{ padding: 20, maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontFamily: F, fontSize: 18, fontWeight: 600, color: COLORS.white, margin: 0 }}>
          Trace Explorer
        </h2>
        <GlassPill color={PROTOCOL_COLORS.AOCL}>{total} traces</GlassPill>
      </div>

      {/* Search + Filters */}
      <TraceSearchBar
        filters={filters}
        onFilterChange={handleFilterChange}
      />

      {/* Error */}
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 12,
          background: `${COLORS.red}10`, border: `1px solid ${COLORS.red}30`,
          fontFamily: F, fontSize: 12, color: COLORS.red,
        }}>
          {error}
        </div>
      )}

      {/* Trace list */}
      <TraceList
        traces={traces}
        total={total}
        offset={offset}
        limit={limit}
        loading={loading}
        onSelectTrace={id => navigate(`/traces/${encodeURIComponent(id)}`)}
        onPageChange={setOffset}
      />
    </div>
  )
}
