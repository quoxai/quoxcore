import { useState, useEffect, useCallback } from 'react'
import { getClusterStatus } from '../../services/proxmoxClient'
import { getAlerts, getTargets } from '../../services/prometheusClient'
import { getHealth } from '../../services/uptimeKumaClient'
import '../core/monitoring/monitoring.css'

/**
 * StatusBar - Compact all-systems status for header
 * Shows quick health indicators for Proxmox, Prometheus, and Uptime Kuma
 */
export function StatusBar() {
  const [proxmox, setProxmox] = useState({ loading: true, ok: false, message: '' })
  const [prometheus, setPrometheus] = useState({ loading: true, ok: false, message: '' })
  const [uptime, setUptime] = useState({ loading: true, ok: false, message: '' })
  const [expanded, setExpanded] = useState(false)

  const fetchStatus = useCallback(async () => {
    // Fetch all statuses in parallel
    const [pveStatus, promAlerts, promTargets, uptimeHealth] = await Promise.all([
      getClusterStatus().catch(() => ({ success: false })),
      getAlerts().catch(() => ({ success: false, summary: { firing: 0 } })),
      getTargets().catch(() => ({ success: false, summary: { down: 0 } })),
      getHealth().catch(() => ({ success: false, healthy: false }))
    ])

    // Proxmox status
    if (pveStatus.success) {
      const ok = pveStatus.summary.quorate && pveStatus.summary.offline === 0
      setProxmox({
        loading: false,
        ok,
        online: pveStatus.summary.online,
        total: pveStatus.summary.totalNodes,
        message: ok ? 'Cluster healthy' : `${pveStatus.summary.offline} nodes offline`
      })
    } else {
      setProxmox({ loading: false, ok: false, message: 'Connection failed' })
    }

    // Prometheus status
    const alertCount = promAlerts.summary?.firing || 0
    const targetsDown = promTargets.summary?.down || 0
    const promOk = alertCount === 0 && targetsDown === 0
    setPrometheus({
      loading: false,
      ok: promOk,
      alerts: alertCount,
      down: targetsDown,
      message: promOk ? 'All clear' : `${alertCount} alerts, ${targetsDown} down`
    })

    // Uptime status
    if (uptimeHealth.success) {
      setUptime({
        loading: false,
        ok: uptimeHealth.healthy,
        up: uptimeHealth.summary?.up || 0,
        down: uptimeHealth.summary?.down || 0,
        message: uptimeHealth.healthy ? 'All services up' : `${uptimeHealth.summary?.down} down`
      })
    } else {
      setUptime({ loading: false, ok: false, message: 'Connection failed' })
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 60000) // Refresh every 60s
    return () => clearInterval(interval)
  }, [fetchStatus])

  const allOk = proxmox.ok && prometheus.ok && uptime.ok
  const anyLoading = proxmox.loading || prometheus.loading || uptime.loading

  return (
    <div className={`status-bar ${expanded ? 'expanded' : ''}`}>
      <button
        className="status-bar-toggle"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Collapse status' : 'Expand status'}
      >
        <span className={`status-bar-indicator ${anyLoading ? 'loading' : allOk ? 'ok' : 'warn'}`} />
        <span className="status-bar-label">SYS</span>
      </button>

      {expanded && (
        <div className="status-bar-details">
          {/* Proxmox */}
          <div className={`status-bar-item ${proxmox.loading ? 'loading' : proxmox.ok ? 'ok' : 'warn'}`}>
            <span className="status-bar-item-icon">
              {proxmox.loading ? '◌' : proxmox.ok ? '●' : '●'}
            </span>
            <span className="status-bar-item-name">PVE</span>
            {!proxmox.loading && proxmox.online !== undefined && (
              <span className="status-bar-item-value">
                {proxmox.online}/{proxmox.total}
              </span>
            )}
          </div>

          {/* Prometheus */}
          <div className={`status-bar-item ${prometheus.loading ? 'loading' : prometheus.ok ? 'ok' : 'warn'}`}>
            <span className="status-bar-item-icon">
              {prometheus.loading ? '◌' : prometheus.ok ? '●' : '●'}
            </span>
            <span className="status-bar-item-name">PROM</span>
            {!prometheus.loading && prometheus.alerts > 0 && (
              <span className="status-bar-item-value">{prometheus.alerts}</span>
            )}
          </div>

          {/* Uptime */}
          <div className={`status-bar-item ${uptime.loading ? 'loading' : uptime.ok ? 'ok' : 'warn'}`}>
            <span className="status-bar-item-icon">
              {uptime.loading ? '◌' : uptime.ok ? '●' : '●'}
            </span>
            <span className="status-bar-item-name">UP</span>
            {!uptime.loading && uptime.down > 0 && (
              <span className="status-bar-item-value">{uptime.down}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default StatusBar
