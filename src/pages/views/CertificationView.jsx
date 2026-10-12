/**
 * CertificationView — VOLT Certification Tiers Dashboard
 *
 * Browse certifications, certify runs, view badges, manage trust seals.
 *
 * Route: /certification
 */

import { useState, useEffect, useCallback } from 'react'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import { COLORS, GlassPanel, GlassButton, M } from '../../components/compliance/glass-primitives'
import '../../components/volt/volt-cert.css'

const TIER_COLORS = {
  bronze:   '#CD7F32',
  silver:   '#C0C0C0',
  gold:     '#FFD700',
  platinum: '#E5E4E2',
  none:     'rgba(255,255,255,0.3)'
}

const TIER_LABELS = {
  bronze:   'Bronze',
  silver:   'Silver',
  gold:     'Gold',
  platinum: 'Platinum',
  none:     'None'
}

const TIER_FORMAL = {
  bronze:   'VOLT-Compatible',
  silver:   'VOLT-Verified',
  gold:     'VOLT-Attested',
  platinum: 'VOLT-Enterprise'
}

const TIER_DESCRIPTIONS = {
  bronze:   'AEE envelopes present, valid event schema, actor and context fields, run lifecycle events.',
  silver:   'Hash chain intact with no gaps, sequence numbers monotonic, Merkle root verified, bundle valid.',
  gold:     'RFC 3161 external timestamp (auto via FreeTSA), Ed25519 signed bundle, 30-day data retention proven.',
  platinum: 'Independent third-party audit, compliance evidence bundle (SOC 2, ISO 27001, etc.), 10+ evidence items. Contact us for enterprise certification.'
}

const CONTACT_US_TIERS = new Set(['platinum'])

const ShieldIcon = ({ size = 24, color = 'currentColor' }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" style={{ stroke: color }} strokeWidth="1.5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

const RefreshIcon = ({ size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" style={{ stroke: 'rgba(255,255,255,0.7)' }} strokeWidth="2">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
)

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function isExpired(expiresAt) {
  return new Date(expiresAt) < new Date()
}

export default function CertificationView() {
  const [certs, setCerts] = useState([])
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [certifying, setCertifying] = useState(false)
  const [runId, setRunId] = useState('')
  const [selectedCert, setSelectedCert] = useState(null)
  const [error, setError] = useState(null)
  const [embedTab, setEmbedTab] = useState('html')
  const [copied, setCopied] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [certsRes, statsRes, runsRes] = await Promise.all([
        fetch('/collector/volt/certs').then(r => r.json()).catch(() => ({ certs: [] })),
        fetch('/collector/volt/certs/stats').then(r => r.json()).catch(() => ({})),
        fetch('/collector/volt/runs?limit=20').then(r => r.json()).catch(() => ({ runs: [] }))
      ])
      setCerts(certsRes.certs || [])
      setStats(statsRes)
      setRuns(runsRes.runs || [])
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleCertify = async () => {
    if (!runId.trim()) return
    setCertifying(true)
    setError(null)
    try {
      const res = await fetch('/collector/volt/certify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: runId.trim() })
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Certification failed')
      } else {
        setSelectedCert(data)
        setRunId('')
        fetchData()
      }
    } catch (err) {
      setError(err.message)
    }
    setCertifying(false)
  }

  const handleRevoke = async (certId) => {
    if (!confirm('Revoke this certification?')) return
    try {
      await fetch(`/collector/volt/cert/${certId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Manual revocation' })
      })
      fetchData()
      if (selectedCert?.cert_id === certId) setSelectedCert(null)
    } catch (err) {
      setError(err.message)
    }
  }

  const handleViewCert = async (certId) => {
    try {
      const res = await fetch(`/collector/volt/cert/${certId}`)
      const data = await res.json()
      setSelectedCert(data.cert)
    } catch (err) {
      setError(err.message)
    }
  }

  const refreshBtn = (
    <button
      onClick={fetchData}
      disabled={loading}
      style={{
        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
        color: COLORS.subtleText, borderRadius: 6, padding: '4px 12px', cursor: loading ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
      }}
    >
      <RefreshIcon /> Refresh
    </button>
  )

  return (
    <GovernancePageLayout
      protocol="VOLT"
      title="VOLT Certification"
      subtitle="Bronze · Silver · Gold · Platinum tier progression · Trust seal management"
      actions={refreshBtn}
      crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Certification' }]}
    >
    <div className="cert-view">

      {/* Tier explanation cards — GLV-2: migrated to GlassPanel */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
        padding: '16px 24px 8px',
      }}>
        {['bronze', 'silver', 'gold', 'platinum'].map(tier => (
          <GlassPanel key={tier} highlight={TIER_COLORS[tier]} style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <ShieldIcon size={16} color={TIER_COLORS[tier]} />
              <span style={{
                fontFamily: M, fontSize: 13, fontWeight: 700, color: TIER_COLORS[tier],
                letterSpacing: 0.5, textTransform: 'uppercase',
              }}>{TIER_LABELS[tier]}</span>
            </div>
            <div style={{
              fontFamily: M, fontSize: 10, color: COLORS.dimText,
              textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
            }}>{TIER_FORMAL[tier]}</div>
            <div style={{
              fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.82)',
            }}>{TIER_DESCRIPTIONS[tier]}</div>
            {CONTACT_US_TIERS.has(tier) && (
              <div style={{
                marginTop: 10, display: 'inline-block',
                padding: '3px 8px', borderRadius: 4,
                background: `${TIER_COLORS[tier]}1a`, color: TIER_COLORS[tier],
                fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
              }}>CONTACT US</div>
            )}
            {tier === 'gold' && (
              <div style={{
                marginTop: 10, display: 'inline-block',
                padding: '3px 8px', borderRadius: 4,
                background: `${TIER_COLORS[tier]}1a`, color: TIER_COLORS[tier],
                fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
              }}>AUTO TSA + SIGNING</div>
            )}
          </GlassPanel>
        ))}
      </div>

      {/* Stats bar — GLV-2: migrated to GlassPanel */}
      {stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
          padding: '8px 24px 16px',
        }}>
          {[
            { key: 'total', label: 'Total Certs', value: stats.total || 0, color: COLORS.cyan },
            { key: 'bronze', label: 'Bronze', value: stats.bronze || 0, color: TIER_COLORS.bronze },
            { key: 'silver', label: 'Silver', value: stats.silver || 0, color: TIER_COLORS.silver },
            { key: 'gold', label: 'Gold', value: stats.gold || 0, color: TIER_COLORS.gold },
            { key: 'platinum', label: 'Platinum', value: stats.platinum || 0, color: TIER_COLORS.platinum },
            { key: 'expired', label: 'Expired/Revoked', value: (stats.expired || 0) + (stats.revoked || 0), color: COLORS.red },
          ].map(s => (
            <GlassPanel key={s.key} highlight={s.color} style={{ padding: 12, textAlign: 'center' }}>
              <div style={{
                fontFamily: M, fontSize: 22, fontWeight: 800, color: s.color,
                fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
              }}>{s.value}</div>
              <div style={{
                fontFamily: M, fontSize: 9, fontWeight: 600, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 1, marginTop: 4,
              }}>{s.label}</div>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* Certify a run */}
      <div className="cert-certify-panel">
        <div className="cert-certify-panel__title">Certify a Run</div>
        <div className="cert-certify-panel__input-row">
          {runs.length > 0 ? (
            <select
              className="cert-certify-panel__input"
              value={runId}
              onChange={e => setRunId(e.target.value)}
            >
              <option value="">Select a VOLT run...</option>
              {runs.map(r => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_id} ({r.status}, {r.seq || 0} events)
                </option>
              ))}
            </select>
          ) : (
            <input
              className="cert-certify-panel__input"
              type="text"
              placeholder="Enter run_id (e.g. RUN_01JFX...)"
              value={runId}
              onChange={e => setRunId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCertify()}
            />
          )}
          <GlassButton variant="warn" onClick={handleCertify} disabled={certifying || !runId.trim()}>
            <ShieldIcon size={14} color="#FFD700" />
            {certifying ? 'Certifying...' : 'Certify'}
          </GlassButton>
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>

      {/* Selected cert detail */}
      {selectedCert && (
        <div className="cert-detail">
          <div className="cert-detail__header">
            <div className="cert-detail__tier-badge">
              <ShieldIcon size={28} color={TIER_COLORS[selectedCert.tier] || TIER_COLORS.none} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: TIER_COLORS[selectedCert.tier] || TIER_COLORS.none }}>
                  {selectedCert.tier_name || 'Not Certified'}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
                  {selectedCert.cert_id}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              <div>Certified: {new Date(selectedCert.certified_at).toLocaleDateString()}</div>
              <div>Expires: {new Date(selectedCert.expires_at).toLocaleDateString()}</div>
              <div>Checks: {selectedCert.summary?.passed || 0}/{selectedCert.summary?.total_checks || 0} passed</div>
            </div>
          </div>

          {/* Badge preview */}
          {selectedCert.tier && selectedCert.tier !== 'none' && (
            <div className="cert-badge-preview">
              <img
                src={`/collector/volt/cert/${selectedCert.cert_id}/badge`}
                alt={`VOLT ${TIER_LABELS[selectedCert.tier]} badge`}
                style={{ maxWidth: 240 }}
              />
            </div>
          )}

          {/* Check results grouped by tier */}
          {selectedCert.checks && (
            <div className="cert-detail__checks">
              {['bronze', 'silver', 'gold', 'platinum'].map(tier => {
                const tierChecks = selectedCert.checks.filter(c => c.tier === tier)
                if (tierChecks.length === 0) return null
                return (
                  <div key={tier}>
                    <div className="cert-tier-section" style={{ color: TIER_COLORS[tier] }}>
                      {TIER_LABELS[tier]} — {TIER_FORMAL[tier]}
                    </div>
                    {tierChecks.map((check, i) => (
                      <div key={i} className={`cert-check cert-check--${check.passed ? 'pass' : 'fail'}`}>
                        <span className="cert-check__icon">{check.passed ? '✓' : '✗'}</span>
                        <span>{check.message}</span>
                        <span className="cert-check__tier-label">{check.code}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <GlassButton onClick={() => setSelectedCert(null)}>Close</GlassButton>
            {selectedCert.tier && selectedCert.tier !== 'none' && (
              <GlassButton variant="danger" onClick={() => handleRevoke(selectedCert.cert_id)}>
                Revoke
              </GlassButton>
            )}
          </div>
        </div>
      )}

      {/* Embed Widget */}
      {selectedCert && selectedCert.tier && selectedCert.tier !== 'none' && (
        <div className="cert-embed-panel">
          <div className="cert-embed-panel__title">Embed Badge</div>
          <div className="cert-embed-panel__desc">Add this badge to your website or documentation to display your VOLT certification status.</div>
          <div className="cert-embed-tabs">
            <button
              className={`cert-embed-tab ${embedTab === 'html' ? 'cert-embed-tab--active' : ''}`}
              onClick={() => setEmbedTab('html')}
            >HTML</button>
            <button
              className={`cert-embed-tab ${embedTab === 'markdown' ? 'cert-embed-tab--active' : ''}`}
              onClick={() => setEmbedTab('markdown')}
            >Markdown</button>
            <button
              className={`cert-embed-tab ${embedTab === 'url' ? 'cert-embed-tab--active' : ''}`}
              onClick={() => setEmbedTab('url')}
            >URL</button>
          </div>
          <div className="cert-embed-code">
            <pre className="cert-embed-pre">{
              embedTab === 'html'
                ? `<a href="${window.location.origin}/volt/verify/${selectedCert.cert_id}">\n  <img src="${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg"\n       alt="VOLT ${TIER_LABELS[selectedCert.tier]} Certified"\n       width="240" height="80" />\n</a>`
                : embedTab === 'markdown'
                ? `[![VOLT ${TIER_LABELS[selectedCert.tier]} Certified](${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg)](${window.location.origin}/volt/verify/${selectedCert.cert_id})`
                : `${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg`
            }</pre>
            <GlassButton size="sm" variant={copied ? 'success' : 'default'} onClick={() => {
              const text = embedTab === 'html'
                ? `<a href="${window.location.origin}/volt/verify/${selectedCert.cert_id}">\n  <img src="${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg"\n       alt="VOLT ${TIER_LABELS[selectedCert.tier]} Certified"\n       width="240" height="80" />\n</a>`
                : embedTab === 'markdown'
                ? `[![VOLT ${TIER_LABELS[selectedCert.tier]} Certified](${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg)](${window.location.origin}/volt/verify/${selectedCert.cert_id})`
                : `${window.location.origin}/api/volt/badge/${selectedCert.cert_id}.svg`
              navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}>
              {copied ? '✓ Copied' : 'Copy'}
            </GlassButton>
          </div>
        </div>
      )}

      {/* Certification list */}
      <div className="cert-list">
        <div className="cert-list__header">
          <div className="cert-list__title">Issued Certifications</div>
        </div>

        {certs.length === 0 ? (
          <div className="cert-list__empty">
            <div className="cert-list__empty-icon">
              <ShieldIcon size={32} color="rgba(255,255,255,0.2)" />
            </div>
            <div>No certifications issued yet.</div>
            <div style={{ marginTop: 4, fontSize: 11 }}>Select a VOLT run above and click Certify to issue a trust seal.</div>
          </div>
        ) : (
          certs.map(cert => (
            <div key={cert.cert_id} className="cert-row" onClick={() => handleViewCert(cert.cert_id)}>
              <div className="cert-row__shield">
                <ShieldIcon size={20} color={TIER_COLORS[cert.tier] || TIER_COLORS.none} />
              </div>
              <div className="cert-row__run">{cert.run_id || '—'}</div>
              <div className="cert-row__tier" style={{ color: TIER_COLORS[cert.tier] || TIER_COLORS.none }}>
                {TIER_LABELS[cert.tier] || 'None'}
              </div>
              <div className="cert-row__date">{timeAgo(cert.certified_at)}</div>
              <div className={`cert-row__expiry ${cert.revoked_at ? 'cert-row__expiry--revoked' : isExpired(cert.expires_at) ? 'cert-row__expiry--expired' : 'cert-row__expiry--valid'}`}>
                {cert.revoked_at ? 'Revoked' : isExpired(cert.expires_at) ? 'Expired' : `Expires ${new Date(cert.expires_at).toLocaleDateString()}`}
              </div>
              <div className="cert-row__actions">
                <GlassButton size="sm" onClick={(e) => { e.stopPropagation(); handleViewCert(cert.cert_id) }}>
                  View
                </GlassButton>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
    </GovernancePageLayout>
  )
}
