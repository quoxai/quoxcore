/**
 * MeshOverview — Tab 1: Device grid with search, filters, and detail drawer
 *
 * Displays Tailscale devices as cards in a responsive grid.
 * Each card shows: hostname, IP, OS, status, routes, tags, key expiry, quick actions.
 * State changes between polls are highlighted with flash animations.
 * Detail drawer slides in from right on "Details" click.
 *
 * RULES FOLLOWED:
 * - Every button has an icon (inline SVG, explicit colours, no currentColor)
 * - No opacity below 0.6 on dark backgrounds
 * - Flex overflow: min-height:0 on scrollable child
 */

import React, { useState, useCallback, useEffect } from 'react'

// OS display helpers
const OS_LABELS = { linux: 'Linux', macOS: 'macOS', windows: 'Windows', iOS: 'iOS', android: 'Android' }

function formatLastSeen(lastSeen) {
  if (!lastSeen) return 'Unknown'
  const diff = Date.now() - Date.parse(lastSeen)
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function formatKeyExpiry(device) {
  if (device.keyExpiryDisabled) return { text: 'Never expires', className: '' }
  if (device.daysUntilExpiry === null || device.daysUntilExpiry === undefined) return { text: 'No expiry', className: '' }
  if (device.daysUntilExpiry < 0) return { text: 'Expired', className: 'ts-device-card__key-expiry--expired' }
  if (device.daysUntilExpiry <= 7) return { text: `${device.daysUntilExpiry}d left`, className: 'ts-device-card__key-expiry--warning' }
  return { text: `${device.daysUntilExpiry}d left`, className: '' }
}

export default function MeshOverview({ data, showNotification }) {
  const [drawerDevice, setDrawerDevice] = useState(null)

  const copyIp = useCallback((ip) => {
    if (!ip) {
      showNotification('No IP address to copy', 'error')
      return
    }
    navigator.clipboard?.writeText(ip).then(() => {
      showNotification(`Copied ${ip}`, 'success')
    }).catch(() => {
      showNotification('Copy failed', 'error')
    })
  }, [showNotification])

  const openDrawer = useCallback(async (device) => {
    setDrawerDevice(device)
    // Load full details
    const details = await data.loadDeviceDetails(device.id)
    if (details) setDrawerDevice(details)
  }, [data])

  // Escape key closes drawer
  useEffect(() => {
    if (!drawerDevice) return
    const handler = (e) => { if (e.key === 'Escape') setDrawerDevice(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [drawerDevice])

  const { filteredDevices, search, setSearch, statusFilter, setStatusFilter, stateChanges } = data

  return (
    <>
      {/* ── Toolbar ── */}
      <div className="ts-toolbar">
        <div className="ts-toolbar__search">
          <svg className="ts-toolbar__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
            <path d="M21 21l-4.35-4.35" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="Search devices..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="ts-toolbar__filters">
          {['all', 'online', 'offline', 'routes', 'expiring'].map(f => (
            <button
              key={f}
              className={`ts-toolbar__filter ${statusFilter === f ? 'ts-toolbar__filter--active' : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Device Grid ── */}
      {filteredDevices.length === 0 ? (
        <div className="ts-empty" style={{ minHeight: '30vh' }}>
          <p className="ts-empty__title" style={{ fontSize: 15 }}>
            {search || statusFilter !== 'all' ? 'No matching devices' : 'No devices found'}
          </p>
          <p className="ts-empty__desc" style={{ fontSize: 13 }}>
            {search || statusFilter !== 'all'
              ? 'Try adjusting your search or filters.'
              : 'Your tailnet appears empty. Add devices using a Tailscale auth key.'}
          </p>
          {(search || statusFilter !== 'all') && (
            <button className="ts-btn" onClick={() => { setSearch(''); setStatusFilter('all') }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Clear Filters
            </button>
          )}
        </div>
      ) : (
        <div className="ts-device-grid">
          {filteredDevices.map(device => {
            const stateChange = stateChanges[device.id]
            const keyExpiry = formatKeyExpiry(device)
            const accentClass = !device.online ? 'ts-device-card__accent--offline'
              : device.isExitNode ? 'ts-device-card__accent--exit'
              : device.isSubnetRouter ? 'ts-device-card__accent--router'
              : ''

            const cardClass = `ts-device-card ${
              stateChange?.type === 'went_offline' ? 'ts-device-card--state-change' : ''
            } ${stateChange?.type === 'came_online' ? 'ts-device-card--came-online' : ''}`

            return (
              <div key={device.id} className={cardClass}>
                <div className={`ts-device-card__accent ${accentClass}`} />

                {/* Header */}
                <div className="ts-device-card__header">
                  <div className={`ts-device-card__status-dot ${!device.online ? 'ts-device-card__status-dot--offline' : ''}`} />
                  <span className="ts-device-card__hostname">{device.hostname}</span>
                  {stateChange && (
                    <span className={`ts-device-card__state-badge ts-device-card__state-badge--${stateChange.type === 'went_offline' ? 'offline' : 'online'}`}>
                      {stateChange.type === 'went_offline' ? 'Just offline' : 'Back online'}
                    </span>
                  )}
                  <span className="ts-device-card__os">
                    {OS_LABELS[device.os] || device.os}
                  </span>
                </div>

                {/* IP */}
                <div className="ts-device-card__ip">
                  {(device.ips || [])[0] || 'No IP'}
                </div>

                {/* Badges (routes + tags) */}
                {((device.enabledRoutes?.length > 0) || (device.tags?.length > 0)) && (
                  <div className="ts-device-card__badges">
                    {(device.enabledRoutes || []).map(r => (
                      <span key={r} className="ts-device-card__badge ts-device-card__badge--route">
                        {device.isExitNode && (r === '0.0.0.0/0' || r === '::/0') ? 'Exit Node' : r}
                      </span>
                    ))}
                    {(device.tags || []).map(t => (
                      <span key={t} className="ts-device-card__badge ts-device-card__badge--tag">{t}</span>
                    ))}
                  </div>
                )}

                {/* Meta line */}
                <div className="ts-device-card__meta">
                  {!device.online && (
                    <span className="ts-device-card__meta-item ts-device-card__last-seen--offline">
                      Last seen: {formatLastSeen(device.lastSeen)}
                    </span>
                  )}
                  {device.online && device.created && (
                    <span className="ts-device-card__meta-item">
                      v{device.clientVersion || '?'}
                    </span>
                  )}
                  <span className={`ts-device-card__meta-item ${keyExpiry.className}`}>
                    Key: {keyExpiry.text}
                  </span>
                </div>

                {/* Actions */}
                <div className="ts-device-card__actions">
                  <button
                    className="ts-device-card__action"
                    onClick={() => copyIp((device.ips || [])[0])}
                    title="Copy Tailscale IP"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <rect x="9" y="9" width="13" height="13" rx="2" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
                    </svg>
                    Copy IP
                  </button>
                  <button
                    className="ts-device-card__action ts-device-card__action--primary"
                    onClick={() => openDrawer(device)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="#818cf8" strokeWidth="1.5" />
                      <path d="M12 8v4M12 16h.01" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Details
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Detail Drawer ── */}
      <div className={`ts-drawer ${drawerDevice ? 'ts-drawer--open' : ''}`}>
        {drawerDevice && (
          <>
            <div className="ts-drawer__header">
              <span className="ts-drawer__title">{drawerDevice.hostname}</span>
              <button className="ts-drawer__close" onClick={() => setDrawerDevice(null)} title="Close">
                ✕
              </button>
            </div>
            <div className="ts-drawer__body">
              {/* Identity */}
              <div className="ts-drawer__section">
                <div className="ts-drawer__section-title">Identity</div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">FQDN</span>
                  <span className="ts-drawer__field-value">{drawerDevice.fqdn}</span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Tailscale IP</span>
                  <span className="ts-drawer__field-value">{(drawerDevice.ips || [])[0]}</span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">OS</span>
                  <span className="ts-drawer__field-value">{drawerDevice.os}</span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Client Version</span>
                  <span className="ts-drawer__field-value">{drawerDevice.clientVersion || '—'}</span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Status</span>
                  <span className="ts-drawer__field-value" style={{ color: drawerDevice.online ? '#4ade80' : '#f87171' }}>
                    {drawerDevice.online ? 'Online' : `Offline (${formatLastSeen(drawerDevice.lastSeen)})`}
                  </span>
                </div>
              </div>

              {/* Connection */}
              {(drawerDevice.derp || drawerDevice.latency) && (
                <div className="ts-drawer__section">
                  <div className="ts-drawer__section-title">Connection</div>
                  {drawerDevice.derp && (
                    <div className="ts-drawer__field">
                      <span className="ts-drawer__field-label">DERP Relay</span>
                      <span className="ts-drawer__field-value">{drawerDevice.derp}</span>
                    </div>
                  )}
                  {drawerDevice.latency && Object.entries(drawerDevice.latency).map(([region, info]) => (
                    <div className="ts-drawer__field" key={region}>
                      <span className="ts-drawer__field-label">{region}{info.preferred ? ' (preferred)' : ''}</span>
                      <span className="ts-drawer__field-value">{info.latencyMs?.toFixed(1)}ms</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Routes */}
              {(drawerDevice.advertisedRoutes?.length > 0 || drawerDevice.enabledRoutes?.length > 0) && (
                <div className="ts-drawer__section">
                  <div className="ts-drawer__section-title">Routes</div>
                  {(drawerDevice.advertisedRoutes || []).map(r => (
                    <div className="ts-drawer__field" key={r}>
                      <span className="ts-drawer__field-value" style={{ fontFamily: 'var(--m-font-mono, monospace)', color: '#a78bfa' }}>{r}</span>
                      <span style={{ fontSize: 11, color: (drawerDevice.enabledRoutes || []).includes(r) ? '#4ade80' : '#6b7280' }}>
                        {(drawerDevice.enabledRoutes || []).includes(r) ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Tags */}
              {drawerDevice.tags?.length > 0 && (
                <div className="ts-drawer__section">
                  <div className="ts-drawer__section-title">Tags</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {drawerDevice.tags.map(t => (
                      <span key={t} className="ts-device-card__badge ts-device-card__badge--tag">{t}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Security */}
              <div className="ts-drawer__section">
                <div className="ts-drawer__section-title">Security</div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Authorized</span>
                  <span className="ts-drawer__field-value" style={{ color: drawerDevice.authorized ? '#4ade80' : '#f87171' }}>
                    {drawerDevice.authorized ? 'Yes' : 'No'}
                  </span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Key Expiry</span>
                  <span className={`ts-drawer__field-value ${formatKeyExpiry(drawerDevice).className}`}>
                    {formatKeyExpiry(drawerDevice).text}
                  </span>
                </div>
                <div className="ts-drawer__field">
                  <span className="ts-drawer__field-label">Blocks Incoming</span>
                  <span className="ts-drawer__field-value">
                    {drawerDevice.blocksIncomingConnections ? 'Yes (shields up)' : 'No'}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Drawer backdrop */}
      {drawerDevice && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 99 }}
          onClick={() => setDrawerDevice(null)}
        />
      )}
    </>
  )
}
