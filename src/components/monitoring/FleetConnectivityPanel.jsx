/**
 * FleetConnectivityPanel - Real-time fleet connectivity status from QuoxBastion
 *
 * Shows:
 * - Overall fleet health summary
 * - Host ping status with latency heatmap
 * - Group health breakdown
 * - Quick SSH action buttons
 */

import { useState, useEffect, useCallback } from 'react'
import * as bastionClient from '../../services/bastionClient'
import CollapsibleSection from './CollapsibleSection'
import '../core/monitoring/monitoring.css'

// Latency color thresholds
const getLatencyColor = (latency) => {
  if (!latency || latency < 0) return 'var(--text-muted)'
  if (latency < 20) return '#30ff90'    // Fast - green
  if (latency < 50) return '#90ff30'    // Good - lime
  if (latency < 100) return '#ffff30'   // OK - yellow
  if (latency < 200) return '#ffb030'   // Slow - orange
  return '#ff3030'                       // Critical - red
}

const getLatencyLabel = (latency) => {
  if (!latency || latency < 0) return 'N/A'
  if (latency < 20) return 'Fast'
  if (latency < 50) return 'Good'
  if (latency < 100) return 'OK'
  if (latency < 200) return 'Slow'
  return 'Critical'
}

function HostCard({ host, ping, onExecute }) {
  const isOnline = ping?.reachable
  const latency = ping?.latency_ms

  return (
    <div
      className={`fleet-host-card ${isOnline ? 'fleet-host-card--online' : 'fleet-host-card--offline'}`}
      title={ping?.error || (isOnline ? `${latency}ms` : 'Unreachable')}
    >
      <div className="fleet-host-card__header">
        <span className="fleet-host-card__status" style={{ background: isOnline ? '#30ff90' : '#ff3030' }} />
        <span className="fleet-host-card__name">{host.id}</span>
      </div>

      <div className="fleet-host-card__info">
        <span className="fleet-host-card__ip">{host.address}</span>
        {isOnline && latency && (
          <span
            className="fleet-host-card__latency"
            style={{ color: getLatencyColor(latency) }}
          >
            {latency}ms
          </span>
        )}
      </div>

      {onExecute && (
        <div className="fleet-host-card__actions">
          <button
            onClick={() => onExecute(host.id, 'uptime')}
            title="Check uptime"
            className="fleet-host-card__action"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </button>
          <button
            onClick={() => onExecute(host.id, 'df -h')}
            title="Check disk usage"
            className="fleet-host-card__action"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

function GroupSummary({ group, hosts, pingResults }) {
  const groupHosts = hosts.filter(h => h.group === group)
  const online = groupHosts.filter(h => pingResults[h.id]?.reachable).length
  const total = groupHosts.length

  const avgLatency = groupHosts
    .filter(h => pingResults[h.id]?.reachable && pingResults[h.id]?.latency_ms)
    .reduce((sum, h, _, arr) => sum + pingResults[h.id].latency_ms / arr.length, 0)

  const healthPercent = total > 0 ? Math.round((online / total) * 100) : 0

  return (
    <div className="fleet-group-summary">
      <div className="fleet-group-summary__name">{group}</div>
      <div className="fleet-group-summary__stats">
        <span className="fleet-group-summary__health" style={{
          color: healthPercent === 100 ? '#30ff90' : healthPercent > 50 ? '#ffb030' : '#ff3030'
        }}>
          {online}/{total}
        </span>
        {avgLatency > 0 && (
          <span className="fleet-group-summary__latency" style={{ color: getLatencyColor(avgLatency) }}>
            {Math.round(avgLatency)}ms avg
          </span>
        )}
      </div>
      <div className="fleet-group-summary__bar">
        <div
          className="fleet-group-summary__bar-fill"
          style={{
            width: `${healthPercent}%`,
            background: healthPercent === 100 ? '#30ff90' : healthPercent > 50 ? '#ffb030' : '#ff3030'
          }}
        />
      </div>
    </div>
  )
}

export function FleetConnectivityPanel({ onExecute, refreshInterval = 30000 }) {
  const [hosts, setHosts] = useState([])
  const [pingResults, setPingResults] = useState({})
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [hostList, pingData, groupList] = await Promise.all([
        bastionClient.listHosts(),
        bastionClient.pingHosts(),
        bastionClient.listGroups()
      ])

      const pingMap = {}
      for (const result of pingData) {
        pingMap[result.host] = {
          reachable: result.reachable,
          latency_ms: result.latency_ms,
          error: result.error
        }
      }

      setHosts(hostList)
      setPingResults(pingMap)
      setGroups(groupList)
      setError(null)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[FleetConnectivityPanel] Failed to fetch:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, refreshInterval)
    return () => clearInterval(interval)
  }, [fetchData, refreshInterval])

  const totalHosts = hosts.length
  const onlineHosts = Object.values(pingResults).filter(p => p.reachable).length
  const offlineHosts = totalHosts - onlineHosts
  const healthPercent = totalHosts > 0 ? Math.round((onlineHosts / totalHosts) * 100) : 0

  const avgLatency = Object.values(pingResults)
    .filter(p => p.reachable && p.latency_ms)
    .reduce((sum, p, _, arr) => sum + p.latency_ms / arr.length, 0)

  if (loading) {
    return (
      <div className="fleet-panel fleet-panel--loading">
        <div className="fleet-panel__spinner" />
        <span>Connecting to QuoxBastion...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="fleet-panel fleet-panel--error">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
        <span>QuoxBastion unavailable: {error}</span>
        <button onClick={fetchData} className="fleet-panel__retry">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="fleet-panel">
      {/* Header with summary */}
      <div className="fleet-panel__header">
        <div className="fleet-panel__title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          Fleet Connectivity
        </div>
        <div className="fleet-panel__summary">
          <span className="fleet-panel__health" style={{
            color: healthPercent === 100 ? '#30ff90' : healthPercent > 80 ? '#ffb030' : '#ff3030'
          }}>
            {healthPercent}%
          </span>
          <span className="fleet-panel__counts">
            {onlineHosts} online / {offlineHosts} offline
          </span>
        </div>
      </div>

      {/* Stats bar */}
      <div className="fleet-panel__stats">
        <div className="fleet-panel__stat">
          <span className="fleet-panel__stat-value">{totalHosts}</span>
          <span className="fleet-panel__stat-label">Total</span>
        </div>
        <div className="fleet-panel__stat">
          <span className="fleet-panel__stat-value" style={{ color: '#30ff90' }}>{onlineHosts}</span>
          <span className="fleet-panel__stat-label">Online</span>
        </div>
        <div className="fleet-panel__stat">
          <span className="fleet-panel__stat-value" style={{ color: offlineHosts > 0 ? '#ff3030' : 'var(--text-muted)' }}>
            {offlineHosts}
          </span>
          <span className="fleet-panel__stat-label">Offline</span>
        </div>
        <div className="fleet-panel__stat">
          <span className="fleet-panel__stat-value" style={{ color: getLatencyColor(avgLatency) }}>
            {avgLatency > 0 ? `${Math.round(avgLatency)}ms` : 'N/A'}
          </span>
          <span className="fleet-panel__stat-label">Avg Latency</span>
        </div>
      </div>

      {/* Group summaries */}
      <CollapsibleSection title="Groups" defaultCollapsed={false}>
        <div className="fleet-panel__groups">
          {groups.map(group => (
            <GroupSummary
              key={group}
              group={group}
              hosts={hosts}
              pingResults={pingResults}
            />
          ))}
        </div>
      </CollapsibleSection>

      {/* Host grid */}
      <CollapsibleSection title="Hosts" defaultCollapsed={totalHosts > 20}>
        <div className="fleet-panel__grid">
          {hosts.map(host => (
            <HostCard
              key={host.id}
              host={host}
              ping={pingResults[host.id]}
              onExecute={onExecute}
            />
          ))}
        </div>
      </CollapsibleSection>

      {/* Footer with refresh info */}
      <div className="fleet-panel__footer">
        <span>
          Last refresh: {lastRefresh ? lastRefresh.toLocaleTimeString() : 'Never'}
        </span>
        <button onClick={fetchData} className="fleet-panel__refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Refresh
        </button>
      </div>
    </div>
  )
}

export default FleetConnectivityPanel
