/**
 * RoutesPanel — Tab 2: Subnet routes and exit nodes
 *
 * Shows devices that advertise routes, which routes are enabled/disabled,
 * and warnings for offline subnet routers.
 */

import React, { useState, useEffect } from 'react'

export default function RoutesPanel({ data, showNotification }) {
  const [confirmRoute, setConfirmRoute] = useState(null) // { deviceId, routes, action }

  // Escape key closes modal
  useEffect(() => {
    if (!confirmRoute) return
    const handler = (e) => { if (e.key === 'Escape') setConfirmRoute(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [confirmRoute])

  const routeDevices = data.devices.filter(d =>
    (d.advertisedRoutes?.length > 0) || (d.enabledRoutes?.length > 0)
  )

  const handleRouteToggle = (device, route, currentlyEnabled) => {
    if (currentlyEnabled) {
      // Disabling — show confirmation
      const newRoutes = (device.enabledRoutes || []).filter(r => r !== route)
      setConfirmRoute({
        deviceId: device.id,
        hostname: device.hostname,
        route,
        routes: newRoutes,
        action: 'disable',
      })
    } else {
      // Enabling — show confirmation
      const newRoutes = [...(device.enabledRoutes || []), route]
      setConfirmRoute({
        deviceId: device.id,
        hostname: device.hostname,
        route,
        routes: newRoutes,
        action: 'enable',
      })
    }
  }

  const executeRouteChange = async () => {
    if (!confirmRoute) return
    try {
      await data.manageRoutes(confirmRoute.deviceId, confirmRoute.routes)
      showNotification(`Route ${confirmRoute.route} ${confirmRoute.action}d on ${confirmRoute.hostname}`, 'success')
    } catch (err) {
      showNotification(`Route change failed: ${err.message}`, 'error')
    }
    setConfirmRoute(null)
  }

  if (routeDevices.length === 0) {
    return (
      <div className="ts-empty" style={{ minHeight: '30vh' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6 }}>
          <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#a78bfa" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#a78bfa" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <p className="ts-empty__title" style={{ fontSize: 15 }}>No Subnet Routes</p>
        <p className="ts-empty__desc" style={{ fontSize: 13 }}>
          No devices are advertising subnet routes. Enable subnet routing on a device to make internal networks accessible via Tailscale.
        </p>
      </div>
    )
  }

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
      <table className="ts-routes-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Route</th>
            <th>Status</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {routeDevices.flatMap(device =>
            (device.advertisedRoutes || []).map(route => {
              const enabled = (device.enabledRoutes || []).includes(route)
              const isExit = route === '0.0.0.0/0' || route === '::/0'
              return (
                <tr key={`${device.id}-${route}`}>
                  <td>
                    <span className="ts-routes-table__device">{device.hostname}</span>
                    {!device.online && enabled && (
                      <div className="ts-routes-table__warning">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <path d="M12 9v4M12 17h.01" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
                          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#fbbf24" strokeWidth="1.5" />
                        </svg>
                        Device offline — route unreachable
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="ts-routes-table__route">
                      {isExit ? 'Exit Node' : route}
                    </span>
                  </td>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: device.online ? '#4ade80' : '#6b7280'
                      }} />
                      {device.online ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td>
                    <button
                      className={`ts-route-toggle ${enabled ? 'ts-route-toggle--enabled' : ''}`}
                      onClick={() => handleRouteToggle(device, route, enabled)}
                      title={enabled ? 'Disable route' : 'Enable route'}
                    />
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
      </div>

      {/* Confirmation modal */}
      {confirmRoute && (
        <div className="ts-modal-overlay" onClick={() => setConfirmRoute(null)}>
          <div className="ts-modal" onClick={e => e.stopPropagation()}>
            <div className="ts-modal__title">
              {confirmRoute.action === 'enable' ? 'Enable Route' : 'Disable Route'}
            </div>
            <div className="ts-modal__desc">
              {confirmRoute.action === 'enable'
                ? `Enable route ${confirmRoute.route} on ${confirmRoute.hostname}? Traffic for this subnet will be routed through this device.`
                : `Disable route ${confirmRoute.route} on ${confirmRoute.hostname}? Devices using this route will lose access to the subnet.`}
            </div>
            <div className="ts-modal__actions">
              <button className="ts-btn" onClick={() => setConfirmRoute(null)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Cancel
              </button>
              <button
                className={`ts-btn ${confirmRoute.action === 'disable' ? 'ts-btn--danger' : 'ts-btn--primary'}`}
                onClick={executeRouteChange}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6L9 17l-5-5" stroke={confirmRoute.action === 'disable' ? '#f87171' : '#818cf8'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {confirmRoute.action === 'enable' ? 'Enable' : 'Disable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
