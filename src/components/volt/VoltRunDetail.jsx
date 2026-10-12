/**
 * VoltRunDetail — Tabbed run detail panel
 *
 * Displays:
 * - Header with close button
 * - Action bar: Export Bundle + Verify Chain buttons
 * - Metadata grid (run_id, corr, status, events, hashes, times)
 * - Tabbed content: Timeline | Events | JSON | Verify
 */

import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, Tab, TabPanel } from '../ui/Tabs'
import VoltEventChain from './VoltEventChain'
import VoltWaterfall from './VoltWaterfall'
import VoltEventsTable from './VoltEventsTable'
import VoltJsonViewer from './VoltJsonViewer'
import VoltChainIntegrity from './VoltChainIntegrity'
import { GlassButton, GlassPanel, COLORS, M } from '../compliance/glass-primitives'
import QuoxVerifiedBadge, { parseCountersignature } from '../ward/QuoxVerifiedBadge'

const STATUS_COLORS = {
  completed: COLORS.green,
  active:    COLORS.cyan,
  error:     COLORS.red,
}

// ── Inline SVG icons ──────────────────────────────────────

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

const ChevronRightIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const ContractIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
)

// AGH-RESP-3: Guard name humanization map
const GUARD_LABELS = {
  verify_claimed_actions:        'Verify Claimed Actions',
  verify_external_fact_claims:   'Verify External Fact Claims',
  sanitize_markdown:             'Sanitize Markdown',
  enforce_language_consistency:  'Enforce Language Consistency',
}

// AGH-CHAIN-1/2/3: Chain verification guard labels
const CHAIN_GUARD_LABELS = {
  detect_promise:           'Promise Detection',
  verify_promise_kept:      'Promise Fulfillment',
  verify_cross_agent_claim: 'Cross-Agent Verification',
  verify_cross_org_claim:   'Cross-Org Verification',
}

const CHECK_NAMES = [
  { code: 'PARSE_ERROR',              name: 'JSON Parse' },
  { code: 'MISSING_MANIFEST',         name: 'Manifest Present' },
  { code: 'MISSING_EVENTS',           name: 'Events Present' },
  { code: 'UNSUPPORTED_VERSION',      name: 'Version Supported' },
  { code: 'BUNDLE_VALIDATION_FAILED', name: 'Bundle Integrity' },
  { code: 'EVENT_COUNT_MISMATCH',     name: 'Event Count' },
  { code: 'FIRST_HASH_MISMATCH',      name: 'First Hash Anchor' },
  { code: 'LAST_HASH_MISMATCH',       name: 'Last Hash Anchor' },
  { code: 'MERKLE_ROOT_MISMATCH',     name: 'Merkle Root' },
  { code: 'CHAIN_BROKEN',             name: 'Hash Chain' },
  { code: 'REDACTION_INCONSISTENT',   name: 'Redaction Consistency' },
  { code: 'SIGNATURE_INVALID',        name: 'Signatures' },
  { code: 'TIMESTAMP_INVALID',        name: 'Timestamps' },
]

const CheckIcon = () => (
  <svg className="volt-verify-inline__icon volt-verify-inline__icon--pass" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const XIcon = () => (
  <svg className="volt-verify-inline__icon volt-verify-inline__icon--fail" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

function formatTimestamp(ts) {
  if (!ts) return '\u2014'
  const d = new Date(ts)
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

function truncHash(hash) {
  if (!hash) return '\u2014'
  return hash.slice(0, 12) + '\u2026' + hash.slice(-8)
}

export default function VoltRunDetail({
  run,
  events,
  eventsLoading,
  onClose,
  onExport,
  onVerify
}) {
  const [activeTab, setActiveTab] = useState('timeline')
  const [exporting, setExporting] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)
  const [showDiff, setShowDiff] = useState({})
  const navigate = useNavigate()

  // AGH-RESP-3: Derive response_contract data from events
  const contractData = useMemo(() => {
    if (!events || events.length === 0) return null
    // Find the first event of type response_contract_applied (or any with payload.response_contract)
    const contractEvent = events.find(
      e => e.event_type === 'response_contract_applied' ||
           (e.payload && e.payload.response_contract)
    )
    if (!contractEvent) return null
    const payload = contractEvent.payload || {}
    const traceMap = payload.response_contract || {}
    const anyApplied = Object.values(traceMap).some(
      g => g && typeof g === 'object' && g.applied === true
    )
    return { traceMap, anyApplied, payload }
  }, [events])

  // Auto-open when any guard applied; reset when events change (new run selected)
  const [contractOpen, setContractOpen] = useState(false)
  useEffect(() => {
    setContractOpen(contractData?.anyApplied ?? false)
  }, [contractData])

  // AGH-CHAIN-1: Derive chain_verification data from events
  const chainData = useMemo(() => {
    if (!events || events.length === 0) return null
    const chainEvent = events.find(
      e => e.event_type === 'chain_verification_applied' ||
           (e.payload && e.payload.chain_verification)
    )
    if (!chainEvent) return null
    const payload = chainEvent.payload || {}
    const traceMap = payload.chain_verification || {}
    const anyApplied = Object.values(traceMap).some(
      g => g && typeof g === 'object' && g.applied === true
    )
    return { traceMap, anyApplied, payload }
  }, [events])

  const [chainOpen, setChainOpen] = useState(false)
  useEffect(() => {
    setChainOpen(chainData?.anyApplied ?? false)
  }, [chainData])

  if (!run) return null

  const isActive = run.status === 'active'
  const eventCount = run.seq ? run.seq - 1 : events.length

  const handleExport = async () => {
    setExporting(true)
    try {
      await onExport(run)
    } catch (err) {
      console.error('[VOLT] Export failed:', err)
    } finally {
      setExporting(false)
    }
  }

  const handleVerify = async () => {
    setVerifying(true)
    try {
      const result = await onVerify(run)
      setVerifyResult(result)
    } catch (err) {
      console.error('[VOLT] Verify failed:', err)
    } finally {
      setVerifying(false)
    }
  }

  const checks = verifyResult
    ? CHECK_NAMES.map(({ code, name }) => {
        const matchingError = verifyResult.errors?.find(e => e.code === code)
        return {
          name,
          pass: !matchingError,
          detail: matchingError?.detail || matchingError?.message || null,
        }
      })
    : null

  const statusColor = STATUS_COLORS[run.status] || COLORS.dimText

  return (
    <div className="volt-detail" role="region" aria-label="Run detail">
      {/* Header — GLV-5 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
      }}>
        <h3 style={{
          fontFamily: M, fontSize: 13, fontWeight: 700, color: '#fff',
          letterSpacing: 0.8, textTransform: 'uppercase', margin: 0,
        }}>Run Detail</h3>
        <GlassButton size="sm" onClick={onClose} title="Close detail panel">
          <CloseIcon />
        </GlassButton>
      </div>

      <div className="volt-detail__body">
        {/* Action bar — GLV-3: migrated to GlassButton */}
        <div className="volt-actions">
          <GlassButton
            onClick={handleExport}
            disabled={isActive || exporting}
            title={isActive ? 'Cannot export an active run' : 'Export evidence bundle as JSON'}
          >
            <DownloadIcon />
            {exporting ? 'Exporting\u2026' : 'Export Bundle'}
          </GlassButton>
          <GlassButton
            variant="primary"
            onClick={handleVerify}
            disabled={isActive || verifying}
            title={isActive ? 'Cannot verify an active run' : 'Verify hash chain integrity'}
          >
            <ShieldIcon />
            {verifying ? 'Verifying\u2026' : 'Verify Chain'}
          </GlassButton>
          {/* AUD-WS-4: cross-surface navigation — jump to WARD witnesses for this run */}
          <GlassButton
            variant="cyan"
            onClick={() => navigate(`/ward?source_id=${encodeURIComponent(run.run_id)}`)}
            title="See WARD witnesses for this run"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
            </svg>
            View in WARD
          </GlassButton>
        </div>

        {/* Metadata grid — GLV-5 */}
        <GlassPanel style={{ padding: 14, margin: '0 0 12px' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px 20px',
          }}>
            {[
              { label: 'Run ID',      value: run.run_id,                            mono: true },
              { label: 'Source',      value: run.source || 'chat',                  mono: false },
              { label: 'Correlation', value: run.corr || '—',                       mono: true },
              { label: 'Status',      value: (
                <span style={{
                  fontFamily: M, fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                  padding: '2px 8px', borderRadius: 4,
                  background: `${statusColor}1f`, color: statusColor,
                  textTransform: 'uppercase',
                }}>{run.status}</span>
              ) },
              { label: 'Events',      value: eventCount },
              { label: 'Head Hash',   value: truncHash(run.head_hash),              mono: true },
              { label: 'Seq',         value: run.seq },
              { label: 'Started',     value: formatTimestamp(run.started_at) },
              { label: 'Completed',   value: formatTimestamp(run.completed_at) },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{
                  fontFamily: M, fontSize: 9, fontWeight: 600, letterSpacing: 1,
                  color: COLORS.dimText, textTransform: 'uppercase',
                }}>{item.label}</span>
                <span style={{
                  fontFamily: item.mono ? M : M, fontSize: 11, color: '#fff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}>{item.value}</span>
              </div>
            ))}
          </div>
        </GlassPanel>

        {/* LL-9i3: Quox Verified countersignature — additive, never a gate. It
            reports only whether quox.ai has countersigned this bundle's digest;
            local chain verification (below) is independent of it. */}
        <div style={{ margin: '0 0 12px' }}>
          <QuoxVerifiedBadge countersignature={parseCountersignature(run.sink_ref, run.countersignature)} />
        </div>

        {/* AGH-RESP-3: Response Contract collapsible section */}
        {contractData && (
          <div style={{ margin: '0 0 12px' }}>
            {/* Collapsible header */}
            <button
              onClick={() => setContractOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', background: contractData.anyApplied
                  ? `${COLORS.amber}18`
                  : 'rgba(255,255,255,0.03)',
                border: `1px solid ${contractData.anyApplied ? `${COLORS.amber}44` : 'rgba(255,255,255,0.08)'}`,
                borderRadius: contractOpen ? '6px 6px 0 0' : 6,
                padding: '9px 12px', cursor: 'pointer',
                textAlign: 'left',
              }}
              aria-expanded={contractOpen}
              aria-label="Response Contract"
            >
              <span style={{ color: contractData.anyApplied ? COLORS.amber : COLORS.dimText }}>
                <ContractIcon />
              </span>
              <span style={{
                fontFamily: M, fontSize: 10, fontWeight: 700, letterSpacing: 1,
                textTransform: 'uppercase',
                color: contractData.anyApplied ? COLORS.amber : COLORS.dimText,
                flex: 1,
              }}>Response Contract</span>
              {contractData.anyApplied && (
                <span style={{
                  fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                  padding: '2px 7px', borderRadius: 10,
                  background: `${COLORS.amber}30`, color: COLORS.amber,
                  textTransform: 'uppercase',
                }}>Guards Applied</span>
              )}
              <span style={{ color: COLORS.dimText, marginLeft: 4 }}>
                {contractOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </span>
            </button>

            {contractOpen && (
              <div style={{
                border: `1px solid ${contractData.anyApplied ? `${COLORS.amber}44` : 'rgba(255,255,255,0.08)'}`,
                borderTop: 'none', borderRadius: '0 0 6px 6px',
                padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
                background: 'rgba(0,0,0,0.15)',
              }}>
                {/* Four guard rows */}
                {Object.entries(GUARD_LABELS).map(([guardKey, guardLabel]) => {
                  const guard = contractData.traceMap[guardKey] || {}
                  const applied = guard.applied === true
                  const diffKey = guardKey
                  const diffOpen = !!showDiff[diffKey]
                  return (
                    <div key={guardKey} style={{
                      borderRadius: 5,
                      border: `1px solid ${applied ? `${COLORS.amber}40` : 'rgba(255,255,255,0.06)'}`,
                      padding: '8px 10px',
                      background: applied ? `${COLORS.amber}08` : 'rgba(255,255,255,0.02)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Status badge */}
                        <span style={{
                          fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                          padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase',
                          background: applied ? `${COLORS.amber}25` : 'rgba(255,255,255,0.07)',
                          color: applied ? COLORS.amber : COLORS.dimText,
                          flexShrink: 0,
                        }}>
                          {applied ? 'Applied' : 'Skipped'}
                        </span>
                        {/* Guard name */}
                        <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600, flex: 1 }}>
                          {guardLabel}
                        </span>
                        {/* Show diff toggle (only when both previews present) */}
                        {applied && contractData.payload.original_preview && contractData.payload.final_preview && (
                          <button
                            onClick={() => setShowDiff(d => ({ ...d, [diffKey]: !d[diffKey] }))}
                            style={{
                              fontFamily: M, fontSize: 9, color: COLORS.cyan,
                              background: 'none', border: `1px solid ${COLORS.cyan}44`,
                              borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {diffOpen ? 'Hide diff' : 'Show diff'}
                          </button>
                        )}
                      </div>
                      {/* Guard detail — reason / claims_stripped */}
                      {applied && (guard.reason || guard.claims_stripped) && (
                        <div style={{
                          fontFamily: M, fontSize: 10, color: COLORS.dimText,
                          marginTop: 4, paddingLeft: 4,
                        }}>
                          {guard.reason || (guard.claims_stripped ? `Stripped: ${JSON.stringify(guard.claims_stripped)}` : null)}
                        </div>
                      )}
                      {/* Diff view */}
                      {applied && diffOpen && contractData.payload.original_preview && contractData.payload.final_preview && (
                        <div style={{
                          marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                        }}>
                          <div>
                            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.8 }}>Before</div>
                            <pre style={{
                              fontFamily: M, fontSize: 10, color: '#ffcdd2',
                              background: 'rgba(239,68,68,0.08)', borderRadius: 4,
                              padding: 8, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              maxHeight: 120, overflowY: 'auto',
                            }}>
                              {contractData.payload.original_preview}
                            </pre>
                          </div>
                          <div>
                            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.8 }}>After</div>
                            <pre style={{
                              fontFamily: M, fontSize: 10, color: '#c8e6c9',
                              background: 'rgba(48,255,144,0.06)', borderRadius: 4,
                              padding: 8, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              maxHeight: 120, overflowY: 'auto',
                            }}>
                              {contractData.payload.final_preview}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* AGH-CHAIN-1: Chain Verification collapsible section */}
        {chainData && (
          <div style={{ margin: '0 0 12px' }}>
            {/* Collapsible header */}
            <button
              onClick={() => setChainOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', background: chainData.anyApplied
                  ? `${COLORS.amber}18`
                  : 'rgba(255,255,255,0.03)',
                border: `1px solid ${chainData.anyApplied ? `${COLORS.amber}44` : 'rgba(255,255,255,0.08)'}`,
                borderRadius: chainOpen ? '6px 6px 0 0' : 6,
                padding: '9px 12px', cursor: 'pointer',
                textAlign: 'left',
              }}
              aria-expanded={chainOpen}
              aria-label="Chain Verification"
            >
              <span style={{ color: chainData.anyApplied ? COLORS.amber : COLORS.dimText }}>
                <ContractIcon />
              </span>
              <span style={{
                fontFamily: M, fontSize: 10, fontWeight: 700, letterSpacing: 1,
                textTransform: 'uppercase',
                color: chainData.anyApplied ? COLORS.amber : COLORS.dimText,
                flex: 1,
              }}>Chain Verification</span>
              {chainData.anyApplied && (
                <span style={{
                  fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                  padding: '2px 7px', borderRadius: 10,
                  background: `${COLORS.amber}30`, color: COLORS.amber,
                  textTransform: 'uppercase',
                }}>Guards Applied</span>
              )}
              <span style={{ color: COLORS.dimText, marginLeft: 4 }}>
                {chainOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </span>
            </button>

            {chainOpen && (
              <div style={{
                border: `1px solid ${chainData.anyApplied ? `${COLORS.amber}44` : 'rgba(255,255,255,0.08)'}`,
                borderTop: 'none', borderRadius: '0 0 6px 6px',
                padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
                background: 'rgba(0,0,0,0.15)',
              }}>
                {/* Chain guard rows */}
                {Object.entries(CHAIN_GUARD_LABELS).map(([guardKey, guardLabel]) => {
                  const guard = chainData.traceMap[guardKey] || {}
                  const applied = guard.applied === true
                  const diffKey = `chain_${guardKey}`
                  const diffOpen = !!showDiff[diffKey]
                  return (
                    <div key={guardKey} style={{
                      borderRadius: 5,
                      border: `1px solid ${applied ? `${COLORS.amber}40` : 'rgba(255,255,255,0.06)'}`,
                      padding: '8px 10px',
                      background: applied ? `${COLORS.amber}08` : 'rgba(255,255,255,0.02)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Status badge */}
                        <span style={{
                          fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                          padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase',
                          background: applied ? `${COLORS.amber}25` : 'rgba(255,255,255,0.07)',
                          color: applied ? COLORS.amber : COLORS.dimText,
                          flexShrink: 0,
                        }}>
                          {applied ? 'Applied' : 'Skipped'}
                        </span>
                        {/* Guard name */}
                        <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600, flex: 1 }}>
                          {guardLabel}
                        </span>
                        {/* Show diff toggle (only when both previews present) */}
                        {applied && chainData.payload.original_preview && chainData.payload.final_preview && (
                          <button
                            onClick={() => setShowDiff(d => ({ ...d, [diffKey]: !d[diffKey] }))}
                            style={{
                              fontFamily: M, fontSize: 9, color: COLORS.cyan,
                              background: 'none', border: `1px solid ${COLORS.cyan}44`,
                              borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {diffOpen ? 'Hide diff' : 'Show diff'}
                          </button>
                        )}
                      </div>
                      {/* Guard detail — chain-specific fields */}
                      {applied && (
                        <div style={{
                          fontFamily: M, fontSize: 10, color: COLORS.dimText,
                          marginTop: 4, paddingLeft: 4,
                        }}>
                          {guard.reason && <div>Reason: {guard.reason}</div>}
                          {guard.promise_id && <div>Promise: <code style={{ fontFamily: M, color: '#fff' }}>{guard.promise_id}</code></div>}
                          {guard.inferred_action && <div>Action: {guard.inferred_action.skill}</div>}
                          {guard.claim_kind && <div>Claim kind: {guard.claim_kind}</div>}
                          {guard.agent_name && <div>Named agent: {guard.agent_name}</div>}
                          {guard.org_name && <div>Counterparty: {guard.org_name}</div>}
                          {guard.claim_action && <div>Claimed action: {guard.claim_action}</div>}
                          {guard.envelopes_found !== undefined && <div>Envelopes matched: {guard.envelopes_found}</div>}
                          {guard.severity === 'high' && (
                            <span style={{
                              display: 'inline-block',
                              fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
                              padding: '2px 7px', borderRadius: 10,
                              background: 'rgba(239,68,68,0.18)', color: '#ff6b6b',
                              marginTop: 4, textTransform: 'uppercase',
                            }}>High Severity</span>
                          )}
                        </div>
                      )}
                      {/* Passthrough status — show even when not applied (e.g. reason: 'verified') */}
                      {!applied && guard.reason && (
                        <div style={{
                          fontFamily: M, fontSize: 10, color: COLORS.dimText,
                          marginTop: 4, paddingLeft: 4,
                        }}>
                          Status: {guard.reason}
                        </div>
                      )}
                      {/* Diff view */}
                      {applied && diffOpen && chainData.payload.original_preview && chainData.payload.final_preview && (
                        <div style={{
                          marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
                        }}>
                          <div>
                            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.8 }}>Before</div>
                            <pre style={{
                              fontFamily: M, fontSize: 10, color: '#ffcdd2',
                              background: 'rgba(239,68,68,0.08)', borderRadius: 4,
                              padding: 8, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              maxHeight: 120, overflowY: 'auto',
                            }}>
                              {chainData.payload.original_preview}
                            </pre>
                          </div>
                          <div>
                            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.8 }}>After</div>
                            <pre style={{
                              fontFamily: M, fontSize: 10, color: '#c8e6c9',
                              background: 'rgba(48,255,144,0.06)', borderRadius: 4,
                              padding: 8, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              maxHeight: 120, overflowY: 'auto',
                            }}>
                              {chainData.payload.final_preview}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Tabbed content */}
        <Tabs value={activeTab} onChange={setActiveTab} size="sm">
          <Tab value="timeline">Timeline</Tab>
          <Tab value="events">Events</Tab>
          <Tab value="json">JSON</Tab>
          <Tab value="verify">Verify</Tab>
        </Tabs>

        <div className="volt-detail__tabs-content">
          <TabPanel value="timeline" activeValue={activeTab}>
            {eventsLoading ? (
              <div className="volt-state">
                <div className="volt-spinner" />
                <div className="volt-state__text">Loading events\u2026</div>
              </div>
            ) : (
              <>
                <VoltChainIntegrity events={events} />
                <VoltWaterfall events={events} />
              </>
            )}
          </TabPanel>

          <TabPanel value="events" activeValue={activeTab}>
            {eventsLoading ? (
              <div className="volt-state">
                <div className="volt-spinner" />
                <div className="volt-state__text">Loading events\u2026</div>
              </div>
            ) : (
              <VoltEventsTable events={events} />
            )}
          </TabPanel>

          <TabPanel value="json" activeValue={activeTab}>
            <VoltJsonViewer run={run} events={events} />
          </TabPanel>

          <TabPanel value="verify" activeValue={activeTab}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
              {!verifyResult && !verifying && (
                <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
                  <GlassButton variant="primary" onClick={handleVerify} disabled={isActive}>
                    <ShieldIcon />
                    Run Verification
                  </GlassButton>
                  <p style={{
                    fontFamily: M, fontSize: 11, color: COLORS.dimText,
                    marginTop: 12, marginBottom: 0, lineHeight: 1.5,
                  }}>
                    Runs 13 integrity checks including hash chain, merkle root, signatures, and timestamps.
                  </p>
                </GlassPanel>
              )}

              {verifying && (
                <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
                  <div className="volt-spinner" style={{ margin: '0 auto 10px' }} />
                  <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>Running verification…</div>
                </GlassPanel>
              )}

              {verifyResult && checks && (
                <>
                  <GlassPanel
                    highlight={verifyResult.valid ? COLORS.green : COLORS.red}
                    style={{ padding: 14, textAlign: 'center' }}
                  >
                    <span style={{
                      fontFamily: M, fontSize: 13, fontWeight: 700, letterSpacing: 0.8,
                      color: verifyResult.valid ? COLORS.green : COLORS.red,
                      textTransform: 'uppercase',
                    }}>
                      {verifyResult.valid ? '✓ Verification Passed' : '✗ Verification Failed'}
                    </span>
                  </GlassPanel>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {checks.map(({ name, pass, detail }, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '8px 12px', borderRadius: 6,
                        background: pass ? 'rgba(48,255,144,0.04)' : 'rgba(239,68,68,0.06)',
                        border: `1px solid ${pass ? 'rgba(48,255,144,0.15)' : 'rgba(239,68,68,0.2)'}`,
                      }}>
                        <span style={{ color: pass ? COLORS.green : COLORS.red, flexShrink: 0, marginTop: 1 }}>
                          {pass ? <CheckIcon /> : <XIcon />}
                        </span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600 }}>{name}</div>
                          {detail && (
                            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginTop: 2 }}>
                              {detail}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {verifyResult.warnings?.length > 0 && (
                    <GlassPanel highlight={COLORS.amber} style={{ padding: 12 }}>
                      <div style={{
                        fontFamily: M, fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                        color: COLORS.amber, textTransform: 'uppercase', marginBottom: 6,
                      }}>Warnings</div>
                      {verifyResult.warnings.map((w, i) => (
                        <div key={i} style={{ fontFamily: M, fontSize: 11, color: '#fff', padding: '2px 0' }}>
                          {w.message}
                        </div>
                      ))}
                    </GlassPanel>
                  )}
                </>
              )}
            </div>
          </TabPanel>
        </div>
      </div>
    </div>
  )
}
