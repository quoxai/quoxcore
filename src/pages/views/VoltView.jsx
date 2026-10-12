/**
 * VoltView — VOLT Dashboard
 *
 * Verifiable Operations Ledger & Trace viewer.
 * Browse runs, inspect hash-chained events, export evidence bundles,
 * and verify chain integrity.
 *
 * Route: /volt
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import useVoltData from '../../hooks/useVoltData'
import VoltStatsBar from '../../components/volt/VoltStatsBar'
import VoltRunList from '../../components/volt/VoltRunList'
import VoltRunDetail from '../../components/volt/VoltRunDetail'
import VoltVerifyModal from '../../components/volt/VoltVerifyModal'
import VoltBundleInspector, { VoltExportPreview } from '../../components/volt/VoltBundleInspector'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import { GlassPill, COLORS } from '../../components/compliance/glass-primitives'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import '../../components/volt/volt.css'

export default function VoltView() {
  const diag = usePluginLicenseDiagnosis('decision-evidence')
  const licensed = diag.licensed
  const {
    runs, stats, bridgeStats, loading, loadingMore, error, pagination,
    filters, setFilters, clearFilters,
    selectedRun, selectedEvents, eventsLoading,
    selectRun, clearSelection,
    refresh, loadMore, exportBundle, verifyRun, importBundle
  } = useVoltData()

  const [verifyResult, setVerifyResult] = useState(null)
  const [focusIndex, setFocusIndex] = useState(-1)
  const [exportPreview, setExportPreview] = useState(null)
  const containerRef = useRef(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // AUD-WS-4: deep-link support. Arriving from /ward?source_id=<run_id> →
  // /volt?run_id=<run_id> auto-selects the matching run once it loads.
  useEffect(() => {
    const runId = searchParams.get('run_id')
    if (!runId || !runs || runs.length === 0) return
    if (selectedRun?.run_id === runId) return
    const match = runs.find(r => r.run_id === runId)
    if (match) selectRun(match)
  }, [searchParams, runs])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleVerify = async (run) => {
    const result = await verifyRun(run)
    setVerifyResult(result)
    return result
  }

  // Export with preview modal
  const handleExportWithPreview = useCallback((run) => {
    setExportPreview(run)
  }, [])

  const confirmExport = useCallback(async () => {
    if (exportPreview) {
      await exportBundle(exportPreview)
      setExportPreview(null)
    }
  }, [exportPreview, exportBundle])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Skip when target is input or textarea
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIndex(prev => Math.min(prev + 1, runs.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && focusIndex >= 0 && focusIndex < runs.length) {
        e.preventDefault()
        selectRun(runs[focusIndex])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        clearSelection()
        setFocusIndex(-1)
      }
    }

    const el = containerRef.current
    if (el) el.addEventListener('keydown', handleKeyDown)
    return () => { if (el) el.removeEventListener('keydown', handleKeyDown) }
  }, [runs, focusIndex, selectRun, clearSelection])

  const deepLinkedRunId = searchParams.get('run_id')

  const chainStatusPill = stats?.chainIntact === false
    ? { label: 'CHAIN BROKEN', color: COLORS.red }
    : stats?.totalRuns > 0
      ? { label: 'CHAIN INTACT', color: COLORS.green }
      : null

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="VOLT" accentColor="#f59e0b" />
  }

  return (
    <GovernancePageLayout
      protocol="VOLT"
      title="Verifiable Operations Ledger"
      subtitle="Hash-chained events · Evidence bundles · Chain verification"
      statusPill={chainStatusPill}
      crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'VOLT' }]}
    >
    <div className="volt-view" ref={containerRef} tabIndex={-1}>
      {/* AUD-WS-4: evidence trail breadcrumb when arrived via deep-link */}
      {deepLinkedRunId && (
        <div style={{
          margin: '8px 16px 0', padding: '8px 14px',
          background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.3)',
          borderRadius: 6, fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>
            Evidence trail
          </span>
          <button
            onClick={() => navigate(`/ward?source_id=${encodeURIComponent(deepLinkedRunId)}`)}
            style={{ background: 'transparent', border: 'none', color: '#06b6d4', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: 0 }}
          >WARD witnesses</button>
          <span style={{ color: 'rgba(255,255,255,0.4)' }}>→</span>
          <span style={{ color: '#f59e0b' }}>VOLT run {deepLinkedRunId.slice(0, 24)}…</span>
          <button
            onClick={() => { setSearchParams({}); clearSelection() }}
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: '2px 8px', borderRadius: 3, fontSize: 10 }}
          >Clear</button>
        </div>
      )}

      {/* Stats dashboard */}
      <VoltStatsBar stats={stats} bridgeStats={bridgeStats} />

      {/* Content area — master-detail split */}
      <div className={`volt-content${selectedRun ? ' volt-content--split' : ''}`}>
        <VoltRunList
          runs={runs}
          stats={stats}
          bridgeStats={bridgeStats}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          filters={filters}
          setFilters={setFilters}
          clearFilters={clearFilters}
          refresh={refresh}
          loadMore={loadMore}
          pagination={pagination}
          selectedRun={selectedRun}
          onSelectRun={selectRun}
          focusIndex={focusIndex}
        />

        {selectedRun && (
          <VoltRunDetail
            run={selectedRun}
            events={selectedEvents}
            eventsLoading={eventsLoading}
            onClose={clearSelection}
            onExport={handleExportWithPreview}
            onVerify={handleVerify}
          />
        )}
      </div>

      {/* Bundle inspector (import) — shown when no run selected */}
      {!selectedRun && !loading && (
        <VoltBundleInspector onImportVerify={importBundle} />
      )}

      {/* Export preview modal */}
      <VoltExportPreview
        run={exportPreview}
        eventCount={exportPreview ? (exportPreview.seq ? exportPreview.seq - 1 : selectedEvents.length) : 0}
        isOpen={!!exportPreview}
        onConfirm={confirmExport}
        onCancel={() => setExportPreview(null)}
      />

      {/* Verify modal (for standalone bundle verification) */}
      {verifyResult && (
        <VoltVerifyModal
          result={verifyResult}
          onClose={() => setVerifyResult(null)}
        />
      )}
    </div>
    </GovernancePageLayout>
  )
}
