/**
 * WardView — WARD Dashboard
 *
 * Write-once Append-only Receipt Digests viewer.
 * Browse witness chains, inspect content-free hash-chain entries,
 * verify chain integrity, and view tips.
 *
 * Route: /ward
 */

import { useState, useCallback, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import useWardData from '../../hooks/useWardData'
import WardTipCard from '../../components/ward/WardTipCard'
import WardSinkActions from '../../components/ward/WardSinkActions'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import { COLORS, GlassPanel, GlassButton, ProgressRing, M } from '../../components/compliance/glass-primitives'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import '../../components/ward/ward.css'

const SOURCE_COLORS = {
  AEE:      { bg: '#38bdf815', fg: '#38bdf8', label: 'AEE' },
  AOCL:     { bg: '#a855f715', fg: '#a855f7', label: 'AOCL' },
  VOLT:     { bg: '#f59e0b15', fg: '#f59e0b', label: 'VOLT' },
  WARD:     { bg: '#06b6d415', fg: '#06b6d4', label: 'WARD' },
  EXTERNAL: { bg: '#64748b15', fg: '#64748b', label: 'EXT' }
}

const WardIcon = () => (
  <svg className="ward-header__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 7h6M9 11h6M9 15h4" />
    <circle cx="17" cy="15" r="2" fill="currentColor" stroke="none" />
  </svg>
)

const ShieldCheckIcon = ({ size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

const ChainIcon = ({ size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

const RefreshIcon = ({ size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
)

function truncHash(h) {
  if (!h || h.length < 16) return h || '—'
  return h.slice(0, 8) + '…' + h.slice(-6)
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

/** Source kind badge */
function SourceBadge({ kind }) {
  const c = SOURCE_COLORS[kind] || SOURCE_COLORS.EXTERNAL
  return (
    <span className="ward-source-badge" style={{ background: c.bg, color: c.fg }}>
      {c.label}
    </span>
  )
}

/** Stats bar — 4 metric cards (GLV-2: migrated to glass-primitives) */
function WardStatCard({ icon, iconColor, value, label, highlight }) {
  return (
    <GlassPanel highlight={highlight} style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${iconColor}1f`, color: iconColor,
        }}>
          {icon}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontFamily: M, fontSize: 20, fontWeight: 700, color: '#fff',
            fontVariantNumeric: 'tabular-nums', lineHeight: 1.2,
          }}>{value}</span>
          <span style={{
            fontFamily: M, fontSize: 10, fontWeight: 500, color: COLORS.dimText,
            textTransform: 'uppercase', letterSpacing: 1,
          }}>{label}</span>
        </div>
      </div>
    </GlassPanel>
  )
}

function WardStatsBar({ stats, breakdown }) {
  const s = stats?.stats || {}
  const w = stats?.witness || {}
  const integrityPct = w.witnessed > 0
    ? Math.round((w.witnessed / (w.witnessed + (w.errors || 0))) * 100)
    : 100
  const integrityColor = integrityPct >= 95 ? COLORS.green : integrityPct >= 80 ? COLORS.amber : COLORS.red

  return (
    <div style={{ padding: '16px 24px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 12,
      }}>
        <WardStatCard
          icon={<WardIcon />}
          iconColor={COLORS.teal}
          value={s.entries ?? 0}
          label="Receipts"
        />
        <WardStatCard
          icon={<ChainIcon size={20} />}
          iconColor={COLORS.cyan}
          value={s.chains ?? 0}
          label="Chains"
        />
        <WardStatCard
          icon={<ShieldCheckIcon size={20} />}
          iconColor={COLORS.purple}
          value={s.tips ?? 0}
          label="Tips"
        />
        <GlassPanel highlight={integrityColor} style={{ padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flexShrink: 0 }}>
              <ProgressRing value={integrityPct} size={52} strokeWidth={4} color={integrityColor} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{
                fontFamily: M, fontSize: 20, fontWeight: 700, color: '#fff',
                fontVariantNumeric: 'tabular-nums', lineHeight: 1.2,
              }}>{integrityPct}%</span>
              <span style={{
                fontFamily: M, fontSize: 10, fontWeight: 500, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 1,
              }}>Integrity</span>
            </div>
          </div>
        </GlassPanel>
      </div>

      {/* Source breakdown pills */}
      {breakdown.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, paddingLeft: 2,
        }}>
          {breakdown.map(b => (
            <span key={b.source_kind} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 8px', borderRadius: 6,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontFamily: M, fontSize: 10,
            }}>
              <SourceBadge kind={b.source_kind} />
              <span style={{ color: COLORS.dimText, fontVariantNumeric: 'tabular-nums' }}>{b.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Entry list — scrollable list of ward entries (GLV-4: glass-migrated) */
function WardEntryList({ entries, selectedEntry, onSelect, loading, loadMore, pagination, filters, setFilters, onVerify, verifying }) {
  return (
    <div className="ward-entry-list">
      {/* Filters */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <select
          value={filters.source_kind}
          onChange={e => setFilters(f => ({ ...f, source_kind: e.target.value }))}
          style={{
            fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#fff',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px 10px', outline: 'none',
            flex: 1, cursor: 'pointer',
          }}
        >
          <option value="" style={{ background: '#1a1a2e' }}>All Sources</option>
          <option value="AEE" style={{ background: '#1a1a2e' }}>AEE</option>
          <option value="AOCL" style={{ background: '#1a1a2e' }}>AOCL</option>
          <option value="VOLT" style={{ background: '#1a1a2e' }}>VOLT</option>
          <option value="WARD" style={{ background: '#1a1a2e' }}>WARD</option>
          <option value="EXTERNAL" style={{ background: '#1a1a2e' }}>External</option>
        </select>
        <GlassButton variant="primary" onClick={onVerify} disabled={verifying}>
          <ShieldCheckIcon size={14} />
          {verifying ? 'Verifying…' : 'Verify Chain'}
        </GlassButton>
      </div>

      {/* Entry rows */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '8px 12px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {loading && entries.length === 0 ? (
          <div style={{
            padding: 32, textAlign: 'center',
            fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: COLORS.dimText,
          }}>Loading WARD data…</div>
        ) : entries.length === 0 ? (
          <GlassPanel style={{ padding: 24, textAlign: 'center', margin: 8 }}>
            <div style={{
              fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: COLORS.dimText,
            }}>No entries recorded yet</div>
          </GlassPanel>
        ) : (
          entries.map(entry => {
            const isSelected = selectedEntry?.ward_entry_id === entry.ward_entry_id
            const kindColor = (SOURCE_COLORS[entry.source_kind] || SOURCE_COLORS.EXTERNAL).fg
            return (
              <button
                key={entry.ward_entry_id}
                onClick={() => onSelect(entry)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  alignItems: 'center',
                  gap: 10, padding: '8px 12px',
                  borderRadius: 8, cursor: 'pointer',
                  background: isSelected
                    ? `linear-gradient(145deg, ${kindColor}1a 0%, ${kindColor}05 100%)`
                    : 'transparent',
                  border: isSelected
                    ? `1px solid ${kindColor}55`
                    : '1px solid transparent',
                  boxShadow: isSelected ? `0 0 12px ${kindColor}15` : 'none',
                  transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                  textAlign: 'left', fontFamily: 'inherit',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <SourceBadge kind={entry.source_kind} />
                  <span style={{
                    fontFamily: "'JetBrains Mono',monospace", fontSize: 10,
                    color: COLORS.dimText, fontVariantNumeric: 'tabular-nums',
                  }}>#{entry.seq}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#fff',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={entry.source_id}>
                    {entry.source_id.length > 28 ? entry.source_id.slice(0, 28) + '…' : entry.source_id}
                  </span>
                  <span style={{
                    fontFamily: "'JetBrains Mono',monospace", fontSize: 9,
                    color: COLORS.dimText,
                  }} title={entry.chain_hash}>
                    {truncHash(entry.chain_hash)}
                  </span>
                </div>
                <span style={{
                  fontFamily: "'JetBrains Mono',monospace", fontSize: 10,
                  color: COLORS.dimText, fontVariantNumeric: 'tabular-nums',
                }}>{timeAgo(entry.witnessed_at)}</span>
              </button>
            )
          })
        )}

        {pagination.offset + pagination.limit < pagination.total && (
          <div style={{ padding: '8px 4px 4px' }}>
            <GlassButton onClick={loadMore} style={{ width: '100%', justifyContent: 'center' }}>
              Load more ({pagination.total - pagination.offset - pagination.limit} remaining)
            </GlassButton>
          </div>
        )}
      </div>
    </div>
  )
}

/** Entry detail panel */
function WardEntryDetail({ entry, onClose, onNavigate }) {
  const [tab, setTab] = useState('fields')

  if (!entry) return null

  // AUD-WS-4: derive a cross-surface navigation target from the source kind.
  // VOLT sources (run IDs) can link to /volt; AEE sources (envelope IDs) to
  // the audit log. External/WARD sources have no destination.
  const navTarget = (() => {
    if (!onNavigate) return null
    const kind = (entry.source_kind || '').toUpperCase()
    if (kind === 'VOLT' && entry.source_id) {
      return { label: 'View in VOLT', href: `/volt?run_id=${encodeURIComponent(entry.source_id)}` }
    }
    if (kind === 'AEE' && entry.source_id) {
      return { label: 'View in AEE', href: `/evidence?envelope=${encodeURIComponent(entry.source_id)}` }
    }
    return null
  })()

  return (
    <div className="ward-detail">
      <div className="ward-detail__header">
        <h3>Entry #{entry.seq}</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {navTarget && (
            <button
              onClick={() => onNavigate(navTarget.href)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: "'JetBrains Mono',monospace",
                background: 'rgba(168,85,247,0.12)',
                border: '1px solid rgba(168,85,247,0.35)',
                color: '#d8b4fe',
                borderRadius: 4,
                cursor: 'pointer',
              }}
              title={`Navigate to ${navTarget.label.toLowerCase()}`}
            >
              {navTarget.label} →
            </button>
          )}
          <button className="ward-detail__close" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="ward-detail__tabs">
        <button className={`ward-tab${tab === 'fields' ? ' ward-tab--active' : ''}`} onClick={() => setTab('fields')}>Fields</button>
        <button className={`ward-tab${tab === 'chain' ? ' ward-tab--active' : ''}`} onClick={() => setTab('chain')}>Chain</button>
        <button className={`ward-tab${tab === 'json' ? ' ward-tab--active' : ''}`} onClick={() => setTab('json')}>JSON</button>
      </div>

      <div className="ward-detail__body">
        {tab === 'fields' && (
          <div className="ward-fields">
            <FieldRow label="Entry ID" value={entry.ward_entry_id} mono />
            <FieldRow label="Source Kind" value={<SourceBadge kind={entry.source_kind} />} />
            <FieldRow label="Source ID" value={entry.source_id} mono />
            <FieldRow label="Payload Hash" value={entry.payload_hash} mono />
            <FieldRow label="Witnessed At" value={entry.witnessed_at} />
            {entry.source_ts && <FieldRow label="Source Time" value={entry.source_ts} />}
            <FieldRow label="Issuer" value={entry.issuer_id} mono />
            <FieldRow label="Version" value={entry.ward_version} />
            {entry.tags && <FieldRow label="Tags" value={entry.tags} />}
          </div>
        )}

        {tab === 'chain' && (
          <div className="ward-fields">
            <FieldRow label="Sequence" value={`#${entry.seq}`} />
            <FieldRow label="Chain ID" value={entry.chain_id} mono />
            <FieldRow label="Prev Chain Hash" value={entry.prev_chain_hash} mono />
            <FieldRow label="Chain Hash" value={entry.chain_hash} mono />
            {entry.sig && <FieldRow label="Signature" value={entry.sig} mono />}
          </div>
        )}

        {tab === 'json' && (
          <pre className="ward-json">{JSON.stringify(entry, null, 2)}</pre>
        )}
      </div>
    </div>
  )
}

function FieldRow({ label, value, mono }) {
  return (
    <div className="ward-field-row">
      <span className="ward-field-row__label">{label}</span>
      <span className={`ward-field-row__value${mono ? ' ward-field-row__value--mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

/** Verify result banner */
function VerifyBanner({ result, onClose }) {
  if (!result) return null
  const ok = result.status === 'INTACT'
  return (
    <div className={`ward-verify-banner ward-verify-banner--${ok ? 'intact' : 'broken'}`}>
      <div className="ward-verify-banner__content">
        <span className="ward-verify-banner__icon">{ok ? '✓' : '✗'}</span>
        <span className="ward-verify-banner__status">{result.status}</span>
        {result.reason && <span className="ward-verify-banner__reason">{result.reason}</span>}
        {result.entry_count != null && <span className="ward-verify-banner__count">{result.entry_count} entries verified</span>}
      </div>
      <button className="ward-verify-banner__close" onClick={onClose}>✕</button>
    </div>
  )
}

export default function WardView() {
  const diag = usePluginLicenseDiagnosis('decision-evidence')
  const licensed = diag.licensed
  const {
    stats, chains, entries, breakdown, tips,
    selectedEntry, loading, error,
    pagination, filters, setFilters,
    verifyResult, setVerifyResult,
    refresh, loadMore, verify,
    selectEntry, clearSelection,
    selectedChain
  } = useWardData()

  const [verifying, setVerifying] = useState(false)
  const [publishingAll, setPublishingAll] = useState(false)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // AUD-WS-4: URL-param driven filtering for cross-surface deep links.
  // Arriving from /volt → /ward?source_id=<run_id> auto-filters the entries
  // list to witnesses of that run.
  useEffect(() => {
    const sourceId = searchParams.get('source_id')
    if (sourceId && filters && typeof setFilters === 'function') {
      setFilters(f => ({ ...f, source_id: sourceId }))
    }
  }, [searchParams])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleVerify = useCallback(async () => {
    setVerifying(true)
    await verify()
    setVerifying(false)
  }, [verify])

  const handlePublishAll = useCallback(async () => {
    setPublishingAll(true)
    try {
      const res = await fetch('/collector/ward/tips/publish-all', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        console.log(`[WARD] Published ${data.published} tips`)
        // Refresh tips data
        refresh()
      }
    } catch (err) {
      console.error('[WARD] Publish all failed:', err)
    } finally {
      setPublishingAll(false)
    }
  }, [refresh])

  const deepLinkedSourceId = searchParams.get('source_id')

  const chainPill = stats?.chainIntact === false
    ? { label: 'CHAIN BROKEN', color: COLORS.red }
    : stats?.totalEntries > 0
      ? { label: 'CHAIN INTACT', color: COLORS.green }
      : null

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="WARD" accentColor="#06b6d4" />
  }

  const refreshButton = (
    <GlassButton size="sm" onClick={refresh} title="Refresh">
      <RefreshIcon />
    </GlassButton>
  )

  return (
    <GovernancePageLayout
      protocol="WARD"
      title="Write-once Receipt Digests"
      subtitle="Witness chain · External timestamping · Public verification"
      statusPill={chainPill}
      actions={refreshButton}
      crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'WARD' }]}
    >
    <div className="ward-view">

      {/* AUD-WS-4: evidence trail breadcrumb when arrived via cross-link */}
      {deepLinkedSourceId && (
        <div style={{
          margin: '8px 16px 0',
          padding: '8px 14px',
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: "'JetBrains Mono',monospace",
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>
            Evidence trail
          </span>
          <button
            onClick={() => navigate(`/volt?run_id=${encodeURIComponent(deepLinkedSourceId)}`)}
            style={{ background: 'transparent', border: 'none', color: '#f59e0b', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: 0 }}
          >VOLT run {deepLinkedSourceId.slice(0, 24)}…</button>
          <span style={{ color: 'rgba(255,255,255,0.4)' }}>→</span>
          <span style={{ color: '#06b6d4' }}>WARD witnesses</span>
          <button
            onClick={() => { setSearchParams({}); setFilters(f => ({ ...f, source_id: undefined })) }}
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: '2px 8px', borderRadius: 3, fontSize: 10 }}
            title="Clear filter"
          >Clear</button>
        </div>
      )}

      {/* Verify result banner */}
      <VerifyBanner result={verifyResult} onClose={() => setVerifyResult(null)} />

      {/* Error state */}
      {error && (
        <div className="ward-error">
          WARD unavailable: {error}. Chain witnessing continues in the background.
        </div>
      )}

      {/* Stats dashboard */}
      <WardStatsBar stats={stats} breakdown={breakdown} />

      {/* Content area — master-detail split */}
      <div className={`ward-content${selectedEntry ? ' ward-content--split' : ''}`}>
        <WardEntryList
          entries={entries}
          selectedEntry={selectedEntry}
          onSelect={selectEntry}
          loading={loading}
          loadMore={loadMore}
          pagination={pagination}
          filters={filters}
          setFilters={setFilters}
          onVerify={handleVerify}
          verifying={verifying}
        />

        {selectedEntry && (
          <WardEntryDetail
            entry={selectedEntry}
            onClose={clearSelection}
            onNavigate={(href) => navigate(href)}
          />
        )}
      </div>

      {/* Tips section with sink publication status */}
      {tips.length > 0 && !selectedEntry && (
        <div className="ward-tips-section">
          <h3 className="ward-tips-section__title">
            <ShieldCheckIcon size={16} /> Recent Tips
          </h3>

          {/* Sink actions: publish unpublished + verify link */}
          <WardSinkActions
            unpublishedCount={tips.filter(t => !t.sink_ref).length}
            onPublishAll={handlePublishAll}
            chainId={selectedChain || chains[0]?.chain_id}
            publishing={publishingAll}
          />

          <div className="ward-tips-grid">
            {tips.slice(0, 6).map(tip => (
              <WardTipCard key={tip.tip_id} tip={tip} />
            ))}
          </div>
        </div>
      )}
    </div>
    </GovernancePageLayout>
  )
}
