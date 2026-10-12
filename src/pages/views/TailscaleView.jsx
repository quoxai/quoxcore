/**
 * TailscaleView — TailMesh Dashboard
 *
 * Orchestrator view: license gate → credential check → onboarding → dashboard.
 * Renders MeshPulseBar + tabs (Devices, Routes, Keys, DNS & Access, Activity).
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isPluginLicensed } from '../../services/licenseValidator'
import useTailscaleData from '../../hooks/useTailscaleData'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import MeshOverview from '../../components/tailscale/MeshOverview'
import RoutesPanel from '../../components/tailscale/RoutesPanel'
import KeysPanel from '../../components/tailscale/KeysPanel'
import { TailscaleChatSidebar } from '../../components/tailscale/TailscaleChatSidebar'
import ActivityPanel from '../../components/tailscale/ActivityPanel'
import CrossOrgCredentialBanner from '../../components/integrations/CrossOrgCredentialBanner'
import '../../styles/tailscale.css'

// Mesh icon (inline SVG, explicit colours — no currentColor)
const MeshIcon = ({ size = 48 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="3" stroke="#4f46e5" strokeWidth="1.5" />
    <circle cx="5" cy="5" r="2" stroke="#4f46e5" strokeWidth="1.5" />
    <circle cx="19" cy="5" r="2" stroke="#4f46e5" strokeWidth="1.5" />
    <circle cx="5" cy="19" r="2" stroke="#4f46e5" strokeWidth="1.5" />
    <circle cx="19" cy="19" r="2" stroke="#4f46e5" strokeWidth="1.5" />
    <line x1="7" y1="6.5" x2="9.5" y2="10" stroke="#818cf8" strokeWidth="1" opacity="0.5" />
    <line x1="17" y1="6.5" x2="14.5" y2="10" stroke="#818cf8" strokeWidth="1" opacity="0.5" />
    <line x1="7" y1="17.5" x2="9.5" y2="14" stroke="#818cf8" strokeWidth="1" opacity="0.5" />
    <line x1="17" y1="17.5" x2="14.5" y2="14" stroke="#818cf8" strokeWidth="1" opacity="0.5" />
  </svg>
)

const TABS = [
  { id: 'devices', label: 'Devices' },
  { id: 'routes', label: 'Routes' },
  { id: 'keys', label: 'Keys' },
  { id: 'dns', label: 'DNS & Access' },
  { id: 'activity', label: 'Activity' },
]

export default function TailscaleView() {
  const navigate = useNavigate()
  const licensed = isPluginLicensed('tailscale')
  const { currentOrg } = useWorkspace?.() || {}
  const orgName = currentOrg?.name || 'your organisation'
  const [activeTab, setActiveTab] = useState('devices')
  const [notification, setNotification] = useState(null)
  const [refreshAgo, setRefreshAgo] = useState(0)
  const [showChat, setShowChat] = useState(true)

  // Hook must be called unconditionally (React rules of hooks)
  const data = useTailscaleData({ autoPoll: licensed, orgId: currentOrg?.id })


  const showNotification = useCallback((message, type = 'success') => {
    setNotification({ message, type })
    const timer = setTimeout(() => setNotification(null), 4000)
    return () => clearTimeout(timer)
  }, [])

  // Refresh countdown timer
  useEffect(() => {
    const t = setInterval(() => {
      if (data.lastRefresh) {
        setRefreshAgo(Math.round((Date.now() - data.lastRefresh.getTime()) / 1000))
      }
    }, 1000)
    return () => clearInterval(t)
  }, [data.lastRefresh])

  // Load secondary data when tabs are switched
  useEffect(() => {
    if (activeTab === 'dns' && !data.dns) {
      data.loadDns()
      data.loadAcl()
    }
    if (activeTab === 'activity' && data.auditEntries.length === 0) {
      data.loadAuditLog()
    }
  }, [activeTab])

  // ── License gate ──
  if (!licensed) {
    return (
      <div className="ts-empty">
        <MeshIcon size={64} />
        <h2 className="ts-empty__title">TailMesh</h2>
        <p className="ts-empty__desc">
          Monitor and manage your Tailscale mesh network. See every device, manage routes and keys,
          get alerts when things change, and ask MESHNET anything in plain English.
        </p>
        <div className="ts-empty__features">
          <div className="ts-empty__feature">
            <span style={{ color: '#4ade80' }}>●</span> Real-time mesh status with device grid
          </div>
          <div className="ts-empty__feature">
            <span style={{ color: '#fbbf24' }}>●</span> Alerts when devices go offline or keys expire
          </div>
          <div className="ts-empty__feature">
            <span style={{ color: '#818cf8' }}>●</span> Natural language management via MESHNET agent
          </div>
        </div>
        <button className="ts-btn ts-btn--primary" onClick={() => navigate('/settings#plugins')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Activate TailMesh — Free
        </button>
      </div>
    )
  }

  // ── Error state (no credentials or API failure) ──
  if (data.error && !data.devices.length) {
    const isCredentialError = data.error.includes('not available') || data.error.includes('Missing credential') || data.error.includes('No tailscale credentials') || data.error.includes('credentials in the vault')
    return (
      <div className="ts-view">
        <div className="ts-onboarding">
          <div className="ts-onboarding__card">
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <MeshIcon size={48} />
            </div>
            <h2 className="ts-onboarding__title">
              {isCredentialError ? 'Connect Your Tailnet' : 'Connection Error'}
            </h2>
            <p className="ts-onboarding__subtitle">
              {isCredentialError
                ? `No Tailscale credentials found for ${orgName}. Add your API credentials to the vault for this organisation.`
                : data.error}
            </p>

            {isCredentialError ? (
              <>
                {/* Cross-org availability — shows BEFORE the setup steps so
                    users in the wrong org notice it before walking through
                    a full token-creation dance. */}
                <CrossOrgCredentialBanner
                  integrationType="tailscale"
                  integrationLabel="Tailscale"
                  onCopySuccess={data.refresh}
                />

                {/* Step-by-step setup guide */}
                <div style={{ textAlign: 'left', width: '100%' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-text-primary, #f4f4f5)', marginBottom: 12 }}>
                    How to connect:
                  </div>

                  {/* Step 1 */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-start' }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(79,70,229,0.15)', color: '#818cf8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>1</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--m-text-primary, #f4f4f5)', marginBottom: 2 }}>
                        Generate an API access token
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--m-text-tertiary, #71717a)', lineHeight: 1.5 }}>
                        Go to <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#818cf8', textDecoration: 'none' }}>login.tailscale.com/admin/settings/keys</a> and click <strong>Generate access token</strong>. Set expiry to 90 days. Copy the token (starts with <code style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>tskey-api-</code>).
                      </div>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-start' }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(79,70,229,0.15)', color: '#818cf8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>2</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--m-text-primary, #f4f4f5)', marginBottom: 2 }}>
                        Find your tailnet name
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--m-text-tertiary, #71717a)', lineHeight: 1.5 }}>
                        Your tailnet name is shown at the top of the <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer" style={{ color: '#818cf8', textDecoration: 'none' }}>admin console</a>. It looks like <code style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>yourname.github</code> or <code style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>example.com</code>. You can also use <code style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>-</code> for the default.
                      </div>
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'flex-start' }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(79,70,229,0.15)', color: '#818cf8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>3</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--m-text-primary, #f4f4f5)', marginBottom: 2 }}>
                        Add both to the QuoxCORE vault
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--m-text-tertiary, #71717a)', lineHeight: 1.5 }}>
                        Click the button below to open the vault. Find <strong>Tailscale</strong> under Zero Trust, paste your token and tailnet name, and save. Credentials are encrypted with AES-256-GCM and never leave the vault.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ts-onboarding__actions" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button className="ts-btn ts-btn--primary" onClick={() => navigate('/vault/credentials?type=tailscale')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="11" width="18" height="10" rx="2" stroke="#818cf8" strokeWidth="1.5" />
                      <path d="M7 11V7a5 5 0 0110 0v4" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Open Vault and Add Credentials
                  </button>
                  <button className="ts-btn" onClick={data.refresh}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M1 4v6h6M23 20v-6h-6" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    I've Added My Credentials
                  </button>
                </div>

                <div style={{ marginTop: 20, padding: 12, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="#4ade80" strokeWidth="1.5" />
                  </svg>
                  <div style={{ fontSize: 11, color: 'var(--m-text-tertiary, #71717a)', lineHeight: 1.5 }}>
                    Credentials are stored in the encrypted QuoxCORE vault (AES-256-GCM) and resolved at runtime by the connector bridge. They are never stored in localStorage, config files, or environment variables.
                  </div>
                </div>
              </>
            ) : (
              <div className="ts-onboarding__actions">
                <button className="ts-btn" onClick={data.refresh}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M1 4v6h6M23 20v-6h-6" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Retry
                </button>
                <button className="ts-btn" onClick={() => navigate('/vault/credentials?type=tailscale')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="11" width="18" height="10" rx="2" stroke="#818cf8" strokeWidth="1.5" />
                    <path d="M7 11V7a5 5 0 0110 0v4" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Check Credentials
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Loading skeleton ──
  if (data.loading && !data.devices.length) {
    return (
      <div className="ts-view">
        <div className="ts-skeleton ts-skeleton--bar" />
        <div className="ts-tabs">
          {TABS.map(t => (
            <div key={t.id} className="ts-tabs__tab" style={{ opacity: 0.3 }}>{t.label}</div>
          ))}
        </div>
        <div className="ts-content">
          <div className="ts-toolbar" style={{ marginBottom: 16 }}>
            <div className="ts-skeleton" style={{ height: 36, width: 300, borderRadius: 6 }} />
          </div>
          <div className="ts-device-grid">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="ts-skeleton ts-skeleton--card" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Compute pulse bar state ──
  const { summary } = data
  // Pulse dot: green = all online, amber = some offline or keys expiring, red = ALL offline
  const allOffline = summary.total > 0 && summary.online === 0
  const someOffline = summary.offline > 0 || data.keySummary.expiringSoon > 0
  const dotClass = allOffline ? 'ts-pulse__dot--error' : someOffline ? 'ts-pulse__dot--warning' : ''

  return (
    <div className="ts-view">
      {/* ── Mesh Pulse Bar ── */}
      <div className="ts-pulse">
        <div className="ts-pulse__left">
          <div className={`ts-pulse__dot ${dotClass}`} />
          <div className="ts-pulse__stats">
            <button
              className={`ts-pulse__stat ${data.statusFilter === 'all' ? 'ts-pulse__stat--active' : ''}`}
              onClick={() => data.setStatusFilter('all')}
            >
              <span className="ts-pulse__stat-value">{summary.total}</span> Devices
            </button>
            <button
              className={`ts-pulse__stat ${data.statusFilter === 'online' ? 'ts-pulse__stat--active' : ''}`}
              onClick={() => data.setStatusFilter(data.statusFilter === 'online' ? 'all' : 'online')}
            >
              <span className="ts-pulse__stat-dot" style={{ background: '#4ade80' }} />
              <span className="ts-pulse__stat-value">{summary.online}</span> Online
            </button>
            {summary.offline > 0 && (
              <button
                className={`ts-pulse__stat ${data.statusFilter === 'offline' ? 'ts-pulse__stat--active' : ''}`}
                onClick={() => data.setStatusFilter(data.statusFilter === 'offline' ? 'all' : 'offline')}
              >
                <span className="ts-pulse__stat-dot" style={{ background: '#6b7280' }} />
                <span className="ts-pulse__stat-value">{summary.offline}</span> Offline
              </button>
            )}
            {summary.subnetRouters > 0 && (
              <button
                className={`ts-pulse__stat ${data.statusFilter === 'routes' ? 'ts-pulse__stat--active' : ''}`}
                onClick={() => data.setStatusFilter(data.statusFilter === 'routes' ? 'all' : 'routes')}
              >
                <span className="ts-pulse__stat-dot" style={{ background: '#a78bfa' }} />
                <span className="ts-pulse__stat-value">{summary.subnetRouters}</span> Routes
              </button>
            )}
            {data.keySummary.expiringSoon > 0 && (
              <button
                className={`ts-pulse__stat ${data.statusFilter === 'expiring' ? 'ts-pulse__stat--active' : ''}`}
                onClick={() => data.setStatusFilter(data.statusFilter === 'expiring' ? 'all' : 'expiring')}
              >
                <span className="ts-pulse__stat-dot" style={{ background: '#fbbf24' }} />
                <span className="ts-pulse__stat-value">{data.keySummary.expiringSoon}</span> Expiring
              </button>
            )}
          </div>

          {/* Segmented health bar */}
          {summary.total > 0 && summary.total <= 20 && (
            <div className="ts-pulse__bar">
              {data.devices.map(d => (
                <div
                  key={d.id}
                  className={`ts-pulse__bar-segment ${d.online ? 'ts-pulse__bar-segment--online' : ''} ${
                    d.daysUntilExpiry !== null && d.daysUntilExpiry <= 7 ? 'ts-pulse__bar-segment--warning' : ''
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="ts-pulse__right">
          {currentOrg?.name && (
            <span
              className="ts-pulse__org-chip"
              title={`Mesh data scoped to ${currentOrg.name}. Switch organisations to see another tailnet.`}
              style={{
                fontSize: 11,
                color: 'rgba(129,140,248,0.9)',
                background: 'rgba(79,70,229,0.12)',
                border: '1px solid rgba(79,70,229,0.25)',
                padding: '3px 8px',
                borderRadius: 999,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {currentOrg.name}
            </span>
          )}
          <span className="ts-pulse__refresh">
            {refreshAgo}s ago
          </span>
          <button
            className="ts-pulse__gear"
            onClick={data.refresh}
            title="Refresh now"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M1 4v6h6M23 20v-6h-6" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="ts-pulse__gear"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide MESHNET' : 'Show MESHNET'}
            style={showChat ? { color: '#818cf8' } : {}}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke={showChat ? '#818cf8' : 'rgba(255,255,255,0.7)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body: Tabs+Content + Sidebar ── */}
      <div className="ts-body">
        {/* Left: main content */}
        <div className="ts-body__main">
          {/* Tabs */}
          <div className="ts-tabs">
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`ts-tabs__tab ${activeTab === tab.id ? 'ts-tabs__tab--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="ts-content">
            {activeTab === 'devices' && (
              <MeshOverview data={data} showNotification={showNotification} />
            )}
            {activeTab === 'routes' && (
              <RoutesPanel data={data} showNotification={showNotification} />
            )}
            {activeTab === 'keys' && (
              <KeysPanel data={data} showNotification={showNotification} />
            )}
            {activeTab === 'dns' && (
              <DnsAccessPanel data={data} />
            )}
            {activeTab === 'activity' && (
              <ActivityPanel data={data} />
            )}
          </div>
        </div>

        {/* Right: MESHNET chat sidebar */}
        <div className={`ts-body__chat ${showChat ? '' : 'ts-body__chat--collapsed'}`}>
          <TailscaleChatSidebar
            devices={data.devices}
            keys={data.keys}
            summary={data.summary}
            selectedDevice={data.selectedDevice}
          />
        </div>
      </div>

      {/* ── Toast Notification ── */}
      {notification && (
        <div className={`ts-toast ts-toast--${notification.type}`}>
          {notification.type === 'success' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M20 6L9 17l-5-5" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#f87171" strokeWidth="1.5" />
              <path d="M15 9l-6 6M9 9l6 6" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          {notification.message}
        </div>
      )}
    </div>
  )
}

// ── Inline DNS & Access Panel (simpler — doesn't need its own file) ──

function DnsAccessPanel({ data }) {
  if (!data.dns && !data.acl) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="ts-skeleton" style={{ height: 160, borderRadius: 12 }} />
        <div className="ts-skeleton" style={{ height: 160, borderRadius: 12 }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* DNS Config */}
      {data.dns && (
        <div className="ts-dns-card">
          <div className="ts-dns-card__title">DNS Configuration</div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">MagicDNS</span>
            <span className={`ts-dns-card__value ${data.dns.magicDNS ? 'ts-dns-card__value--enabled' : ''}`}>
              {data.dns.magicDNS ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">Nameservers</span>
            <span className="ts-dns-card__value">
              {(data.dns.nameservers || []).join(', ') || 'Default'}
            </span>
          </div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">Search Paths</span>
            <span className="ts-dns-card__value">
              {(data.dns.searchPaths || []).join(', ') || 'None'}
            </span>
          </div>
          {data.dns.splitDNS && Object.keys(data.dns.splitDNS).length > 0 && (
            <div className="ts-dns-card__row">
              <span className="ts-dns-card__label">Split DNS</span>
              <span className="ts-dns-card__value">
                {Object.entries(data.dns.splitDNS).map(([domain, servers]) =>
                  `${domain} → ${Array.isArray(servers) ? servers.join(', ') : servers}`
                ).join('; ')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ACL Summary */}
      {data.acl && (
        <div className="ts-dns-card">
          <div className="ts-dns-card__title">Access Policy</div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">Groups</span>
            <span className="ts-dns-card__value">
              {Object.keys(data.acl.groups || {}).length} defined
            </span>
          </div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">ACL Rules</span>
            <span className="ts-dns-card__value">
              {(data.acl.acls || []).length} active
            </span>
          </div>
          <div className="ts-dns-card__row">
            <span className="ts-dns-card__label">Tag Owners</span>
            <span className="ts-dns-card__value">
              {Object.keys(data.acl.tagowners || {}).length} defined
            </span>
          </div>
          {data.acl.humanReadableSummary && (
            <div style={{ marginTop: 12, padding: 12, background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
              <pre style={{ fontSize: 12, color: 'var(--m-text-secondary, #a1a1aa)', whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--m-font-mono, monospace)' }}>
                {data.acl.humanReadableSummary}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
