/**
 * FleetHeatmap — Visual grid of all Prometheus-scraped hosts
 * Colour-coded by health (green/amber/red), click to drill into metrics.
 * Uniquely "quoxish" — AI-driven anomaly notes and capacity warnings.
 */

import { useState, useEffect, useCallback } from 'react'
import { queryPrometheus, queryRange, getTargets, getAlerts, COMMON_QUERIES } from '../../services/prometheusClient'

// Thresholds for colour coding
const THRESHOLDS = {
  cpu:    { warn: 70, crit: 90 },
  memory: { warn: 75, crit: 90 },
  disk:   { warn: 80, crit: 92 },
  load:   { warn: 3, crit: 8 }
}

function healthColor(value, metric) {
  const t = THRESHOLDS[metric] || THRESHOLDS.cpu
  if (value == null || isNaN(value)) return '#3f3f46'
  if (value >= t.crit) return '#ef4444'
  if (value >= t.warn) return '#f59e0b'
  return '#22c55e'
}

function healthLevel(host) {
  if (!host) return 'unknown'
  const vals = [
    { v: host.cpu, m: 'cpu' },
    { v: host.memory, m: 'memory' },
    { v: host.disk, m: 'disk' }
  ]
  if (vals.some(x => x.v != null && x.v >= THRESHOLDS[x.m].crit)) return 'critical'
  if (vals.some(x => x.v != null && x.v >= THRESHOLDS[x.m].warn)) return 'warning'
  if (vals.every(x => x.v == null)) return 'unknown'
  return 'healthy'
}

function worstColor(host) {
  const level = healthLevel(host)
  if (level === 'critical') return '#ef4444'
  if (level === 'warning') return '#f59e0b'
  if (level === 'unknown') return '#3f3f46'
  return '#22c55e'
}

function shortHostname(instance) {
  // "10.0.0.101:9100" → "10.0.0.101", "docker01:9100" → "docker01"
  return (instance || '').replace(/:.*$/, '')
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '-'
  const gb = bytes / (1024 * 1024 * 1024)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function estimateDaysUntilFull(currentPct, historyPoints) {
  if (!historyPoints || historyPoints.length < 2 || currentPct >= 99) return null
  const first = historyPoints[0]
  const last = historyPoints[historyPoints.length - 1]
  const timeDiffHours = (last[0] - first[0]) / 3600
  const valueDiff = parseFloat(last[1]) - parseFloat(first[1])
  if (valueDiff <= 0 || timeDiffHours < 1) return null
  const ratePerDay = (valueDiff / timeDiffHours) * 24
  const remaining = 100 - currentPct
  const days = remaining / ratePerDay
  return days > 0 && days < 365 ? Math.round(days) : null
}

export function FleetHeatmap({ onSelectHost } = {}) {
  const [hosts, setHosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedHost, setSelectedHost] = useState(null)
  const [drillData, setDrillData] = useState(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [anomalies, setAnomalies] = useState([])
  const [sortBy, setSortBy] = useState('health') // health, name, cpu, memory, disk

  const fetchFleetData = useCallback(async () => {
    try {
      setLoading(true)

      const [cpuResult, memResult, diskResult, loadResult, targetsResult, alertsResult, uptimeResult] = await Promise.all([
        queryPrometheus(COMMON_QUERIES.cpuUsage),
        queryPrometheus(COMMON_QUERIES.memoryUsage),
        queryPrometheus(COMMON_QUERIES.diskUsage),
        queryPrometheus(COMMON_QUERIES.loadAvg),
        getTargets(),
        getAlerts(),
        queryPrometheus(COMMON_QUERIES.uptime)
      ])

      // Build host map from all metric sources
      const hostMap = {}

      const addMetric = (result, key) => {
        if (!result.success || !result.result) return
        result.result.forEach(r => {
          const instance = r.metric.instance
          if (!instance) return
          const id = shortHostname(instance)
          if (!hostMap[id]) hostMap[id] = { id, instance }
          hostMap[id][key] = parseFloat(parseFloat(r.value[1]).toFixed(1))
        })
      }

      addMetric(cpuResult, 'cpu')
      addMetric(memResult, 'memory')
      addMetric(diskResult, 'disk')
      addMetric(loadResult, 'load')

      if (uptimeResult.success && uptimeResult.result) {
        uptimeResult.result.forEach(r => {
          const id = shortHostname(r.metric.instance)
          if (hostMap[id]) {
            hostMap[id].uptimeSeconds = parseFloat(r.value[1])
          }
        })
      }

      // Mark down targets
      if (targetsResult.success && targetsResult.down) {
        targetsResult.down.forEach(t => {
          const id = shortHostname(t.labels?.instance)
          if (!hostMap[id]) hostMap[id] = { id, instance: t.labels?.instance }
          hostMap[id].down = true
          hostMap[id].lastError = t.lastError
        })
      }

      const hostList = Object.values(hostMap)
      setHosts(hostList)
      setAlerts(alertsResult.firing || [])
      setLastUpdate(new Date())

      // Detect anomalies — disk capacity forecasting
      detectAnomalies(hostList)
    } catch (err) {
      console.error('[FleetHeatmap] Failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const detectAnomalies = useCallback(async (hostList) => {
    const found = []

    // Check for high-load hosts
    hostList.forEach(h => {
      if (h.cpu != null && h.cpu >= 90) {
        found.push({ host: h.id, type: 'critical', msg: `CPU at ${h.cpu}% — sustained high load` })
      }
      if (h.memory != null && h.memory >= 92) {
        found.push({ host: h.id, type: 'critical', msg: `Memory at ${h.memory}% — OOM risk` })
      }
      if (h.disk != null && h.disk >= 90) {
        found.push({ host: h.id, type: 'warning', msg: `Disk at ${h.disk}% — space running low` })
      }
      if (h.down) {
        found.push({ host: h.id, type: 'critical', msg: 'Target DOWN — not responding to scrapes' })
      }
    })

    // Disk growth forecast for hosts above 70%
    const diskHosts = hostList.filter(h => h.disk != null && h.disk >= 70)
    if (diskHosts.length > 0) {
      const now = Math.floor(Date.now() / 1000)
      const weekAgo = now - 7 * 86400
      try {
        const rangeResult = await queryRange(
          COMMON_QUERIES.diskUsage,
          String(weekAgo), String(now), '1h'
        )
        if (rangeResult.success && rangeResult.result) {
          rangeResult.result.forEach(series => {
            const id = shortHostname(series.metric.instance)
            const host = diskHosts.find(h => h.id === id)
            if (!host) return
            const days = estimateDaysUntilFull(host.disk, series.values)
            if (days != null && days <= 30) {
              found.push({
                host: id,
                type: days <= 7 ? 'critical' : 'warning',
                msg: `Disk full in ~${days} day${days !== 1 ? 's' : ''} at current growth rate`
              })
            }
          })
        }
      } catch { /* ignore forecast errors */ }
    }

    setAnomalies(found)
  }, [])

  const loadDrillDown = useCallback(async (host) => {
    setSelectedHost(host)
    onSelectHost?.(host)
    setDrillLoading(true)
    setDrillData(null)

    try {
      const now = Math.floor(Date.now() / 1000)
      const hourAgo = now - 3600
      const instanceFilter = `instance=~"${host.instance || host.id}.*"`

      const [cpuHistory, memHistory, diskHistory, memTotalResult, diskTotalResult] = await Promise.all([
        queryRange(`100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle",${instanceFilter}}[5m])) * 100)`, String(hourAgo), String(now), '2m'),
        queryRange(`(1 - (node_memory_MemAvailable_bytes{${instanceFilter}} / node_memory_MemTotal_bytes{${instanceFilter}})) * 100`, String(hourAgo), String(now), '2m'),
        queryRange(`(1 - (node_filesystem_avail_bytes{mountpoint="/",${instanceFilter}} / node_filesystem_size_bytes{mountpoint="/",${instanceFilter}})) * 100`, String(hourAgo), String(now), '2m'),
        queryPrometheus(`node_memory_MemTotal_bytes{${instanceFilter}}`),
        queryPrometheus(`node_filesystem_size_bytes{mountpoint="/",${instanceFilter}}`)
      ])

      // Get alerts for this host
      const hostAlerts = alerts.filter(a =>
        (a.labels?.instance || '').includes(host.id)
      )

      setDrillData({
        cpuHistory: cpuHistory.success ? cpuHistory.result?.[0]?.values || [] : [],
        memHistory: memHistory.success ? memHistory.result?.[0]?.values || [] : [],
        diskHistory: diskHistory.success ? diskHistory.result?.[0]?.values || [] : [],
        memTotal: memTotalResult.success ? parseFloat(memTotalResult.result?.[0]?.value?.[1] || 0) : null,
        diskTotal: diskTotalResult.success ? parseFloat(diskTotalResult.result?.[0]?.value?.[1] || 0) : null,
        alerts: hostAlerts,
        anomalies: anomalies.filter(a => a.host === host.id)
      })
    } catch (err) {
      console.error('[FleetHeatmap] Drill-down failed:', err)
    } finally {
      setDrillLoading(false)
    }
  }, [alerts, anomalies])

  useEffect(() => {
    fetchFleetData()
    const interval = setInterval(fetchFleetData, 30000)
    return () => clearInterval(interval)
  }, [fetchFleetData])

  // Sort hosts
  const sortedHosts = [...hosts].sort((a, b) => {
    if (sortBy === 'health') {
      const order = { critical: 0, warning: 1, unknown: 2, healthy: 3 }
      return (order[healthLevel(a)] ?? 4) - (order[healthLevel(b)] ?? 4)
    }
    if (sortBy === 'name') return (a.id || '').localeCompare(b.id || '')
    if (sortBy === 'cpu') return (b.cpu ?? -1) - (a.cpu ?? -1)
    if (sortBy === 'memory') return (b.memory ?? -1) - (a.memory ?? -1)
    if (sortBy === 'disk') return (b.disk ?? -1) - (a.disk ?? -1)
    return 0
  })

  const healthCounts = {
    healthy: hosts.filter(h => healthLevel(h) === 'healthy').length,
    warning: hosts.filter(h => healthLevel(h) === 'warning').length,
    critical: hosts.filter(h => healthLevel(h) === 'critical').length,
    unknown: hosts.filter(h => healthLevel(h) === 'unknown').length
  }

  return (
    <div className="fleet-heatmap">
      <style>{heatmapStyles}</style>

      {/* Header */}
      <div className="fh-header">
        <div className="fh-header__left">
          <h2 className="fh-title">Fleet Health</h2>
          <div className="fh-summary">
            {healthCounts.healthy > 0 && <span className="fh-badge fh-badge--ok">{healthCounts.healthy} healthy</span>}
            {healthCounts.warning > 0 && <span className="fh-badge fh-badge--warn">{healthCounts.warning} warning</span>}
            {healthCounts.critical > 0 && <span className="fh-badge fh-badge--crit">{healthCounts.critical} critical</span>}
            {healthCounts.unknown > 0 && <span className="fh-badge fh-badge--unk">{healthCounts.unknown} unknown</span>}
          </div>
        </div>
        <div className="fh-header__right">
          {lastUpdate && (
            <span className="fh-updated">{lastUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
          <div className="fh-sort">
            {['health', 'name', 'cpu', 'memory', 'disk'].map(s => (
              <button key={s} className={`fh-sort-btn ${sortBy === s ? 'active' : ''}`} onClick={() => setSortBy(s)}>
                {s === 'health' ? 'Worst first' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <button className="fh-refresh" onClick={fetchFleetData} disabled={loading}>
            <span style={{ fontSize: 14 }}>{loading ? '...' : '↻'}</span>
          </button>
        </div>
      </div>

      {/* Anomaly banner */}
      {anomalies.length > 0 && (
        <div className="fh-anomalies">
          <div className="fh-anomalies__title">
            <span style={{ fontSize: 14 }}>⚠</span> Intelligence ({anomalies.length})
          </div>
          {anomalies.slice(0, 5).map((a, i) => (
            <div key={i} className={`fh-anomaly fh-anomaly--${a.type}`}>
              <span className="fh-anomaly__host">{a.host}</span>
              <span className="fh-anomaly__msg">{a.msg}</span>
            </div>
          ))}
          {anomalies.length > 5 && (
            <div className="fh-anomaly fh-anomaly--more">+{anomalies.length - 5} more</div>
          )}
        </div>
      )}

      {/* Heatmap grid */}
      {loading && hosts.length === 0 ? (
        <div className="fh-loading">Querying Prometheus...</div>
      ) : (
        <div className="fh-grid">
          {sortedHosts.map(host => (
            <button
              key={host.id}
              className={`fh-cell ${selectedHost?.id === host.id ? 'fh-cell--selected' : ''} ${host.down ? 'fh-cell--down' : ''}`}
              onClick={() => loadDrillDown(host)}
              title={`${host.id} — CPU: ${host.cpu ?? '?'}% | Mem: ${host.memory ?? '?'}% | Disk: ${host.disk ?? '?'}%`}
            >
              <div className="fh-cell__indicator" style={{ background: worstColor(host) }} />
              <div className="fh-cell__name">{host.id}</div>
              <div className="fh-cell__metrics">
                {host.cpu != null && (
                  <span className="fh-cell__metric" style={{ color: healthColor(host.cpu, 'cpu') }}>
                    {host.cpu.toFixed(0)}%
                  </span>
                )}
                {host.memory != null && (
                  <span className="fh-cell__metric" style={{ color: healthColor(host.memory, 'memory') }}>
                    {host.memory.toFixed(0)}%
                  </span>
                )}
                {host.disk != null && (
                  <span className="fh-cell__metric" style={{ color: healthColor(host.disk, 'disk') }}>
                    {host.disk.toFixed(0)}%
                  </span>
                )}
              </div>
              <div className="fh-cell__labels">
                <span>CPU</span><span>MEM</span><span>DSK</span>
              </div>
              {host.down && <div className="fh-cell__down">DOWN</div>}
              {anomalies.some(a => a.host === host.id) && !host.down && (
                <div className="fh-cell__alert-dot" />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Drill-down panel */}
      {selectedHost && (
        <div className="fh-drill">
          <div className="fh-drill__header">
            <h3>{selectedHost.id}</h3>
            <button className="fh-drill__close" onClick={() => { setSelectedHost(null); onSelectHost?.(null); setDrillData(null) }}>✕</button>
          </div>

          {drillLoading ? (
            <div className="fh-loading">Loading host metrics...</div>
          ) : drillData ? (
            <div className="fh-drill__body">
              {/* Current values */}
              <div className="fh-drill__current">
                <div className="fh-drill__stat">
                  <div className="fh-drill__stat-label">CPU</div>
                  <div className="fh-drill__stat-value" style={{ color: healthColor(selectedHost.cpu, 'cpu') }}>
                    {selectedHost.cpu?.toFixed(1) ?? '-'}%
                  </div>
                </div>
                <div className="fh-drill__stat">
                  <div className="fh-drill__stat-label">Memory</div>
                  <div className="fh-drill__stat-value" style={{ color: healthColor(selectedHost.memory, 'memory') }}>
                    {selectedHost.memory?.toFixed(1) ?? '-'}%
                  </div>
                  {drillData.memTotal && (
                    <div className="fh-drill__stat-sub">{formatBytes(drillData.memTotal)} total</div>
                  )}
                </div>
                <div className="fh-drill__stat">
                  <div className="fh-drill__stat-label">Disk</div>
                  <div className="fh-drill__stat-value" style={{ color: healthColor(selectedHost.disk, 'disk') }}>
                    {selectedHost.disk?.toFixed(1) ?? '-'}%
                  </div>
                  {drillData.diskTotal && (
                    <div className="fh-drill__stat-sub">{formatBytes(drillData.diskTotal)} total</div>
                  )}
                </div>
                <div className="fh-drill__stat">
                  <div className="fh-drill__stat-label">Load</div>
                  <div className="fh-drill__stat-value" style={{ color: healthColor(selectedHost.load, 'load') }}>
                    {selectedHost.load?.toFixed(2) ?? '-'}
                  </div>
                </div>
                {selectedHost.uptimeSeconds != null && (
                  <div className="fh-drill__stat">
                    <div className="fh-drill__stat-label">Uptime</div>
                    <div className="fh-drill__stat-value" style={{ color: 'rgba(255,255,255,0.7)' }}>
                      {Math.floor(selectedHost.uptimeSeconds / 86400)}d
                    </div>
                  </div>
                )}
              </div>

              {/* Sparklines (1h history) */}
              <div className="fh-drill__charts">
                <MiniChart label="CPU (1h)" data={drillData.cpuHistory} color="#3b82f6" metric="cpu" />
                <MiniChart label="Memory (1h)" data={drillData.memHistory} color="#8b5cf6" metric="memory" />
                <MiniChart label="Disk (1h)" data={drillData.diskHistory} color="#f59e0b" metric="disk" />
              </div>

              {/* Anomalies for this host */}
              {drillData.anomalies.length > 0 && (
                <div className="fh-drill__anomalies">
                  <div className="fh-drill__section-title">Intelligence</div>
                  {drillData.anomalies.map((a, i) => (
                    <div key={i} className={`fh-anomaly fh-anomaly--${a.type}`}>
                      <span className="fh-anomaly__msg">{a.msg}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Alerts for this host */}
              {drillData.alerts.length > 0 && (
                <div className="fh-drill__alerts">
                  <div className="fh-drill__section-title">Active Alerts</div>
                  {drillData.alerts.map((a, i) => (
                    <div key={i} className={`fh-drill__alert fh-drill__alert--${a.labels?.severity || 'warning'}`}>
                      <span className="fh-drill__alert-name">{a.labels?.alertname}</span>
                      <span className="fh-drill__alert-sev">{a.labels?.severity || 'warning'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * MiniChart — Pure CSS sparkline from time-series data
 * No chart library needed — renders as SVG polyline
 */
function MiniChart({ label, data, color, metric }) {
  if (!data || data.length < 2) {
    return (
      <div className="fh-chart">
        <div className="fh-chart__label">{label}</div>
        <div className="fh-chart__empty">No data</div>
      </div>
    )
  }

  const values = data.map(d => parseFloat(d[1]))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const latest = values[values.length - 1]

  // SVG polyline points
  const width = 200
  const height = 40
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')

  const t = THRESHOLDS[metric] || THRESHOLDS.cpu

  return (
    <div className="fh-chart">
      <div className="fh-chart__header">
        <span className="fh-chart__label">{label}</span>
        <span className="fh-chart__value" style={{ color }}>{latest.toFixed(1)}%</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="fh-chart__svg" preserveAspectRatio="none">
        {/* Threshold lines */}
        {max > t.warn && (
          <line
            x1="0" x2={width}
            y1={height - ((t.warn - min) / range) * (height - 4) - 2}
            y2={height - ((t.warn - min) / range) * (height - 4) - 2}
            stroke="#f59e0b" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4"
          />
        )}
        {max > t.crit && (
          <line
            x1="0" x2={width}
            y1={height - ((t.crit - min) / range) * (height - 4) - 2}
            y2={height - ((t.crit - min) / range) * (height - 4) - 2}
            stroke="#ef4444" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4"
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

const heatmapStyles = `
.fleet-heatmap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Header */
.fh-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
}
.fh-header__left { display: flex; flex-direction: column; gap: 6px; }
.fh-header__right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fh-title { font-size: 1.1rem; font-weight: 600; color: #f4f4f5; margin: 0; }
.fh-summary { display: flex; gap: 6px; flex-wrap: wrap; }
.fh-badge {
  font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 500;
}
.fh-badge--ok { background: rgba(34,197,94,0.12); color: #22c55e; }
.fh-badge--warn { background: rgba(245,158,11,0.12); color: #f59e0b; }
.fh-badge--crit { background: rgba(239,68,68,0.12); color: #ef4444; }
.fh-badge--unk { background: rgba(63,63,70,0.3); color: #71717a; }

.fh-updated { font-size: 0.7rem; color: #52525b; }

.fh-sort { display: flex; gap: 2px; background: rgba(255,255,255,0.03); border-radius: 4px; padding: 2px; }
.fh-sort-btn {
  background: transparent; border: none; color: #52525b; font-size: 0.65rem;
  padding: 3px 8px; border-radius: 3px; cursor: pointer; transition: all 0.15s;
}
.fh-sort-btn:hover { color: #a1a1aa; }
.fh-sort-btn.active { color: #e6522c; background: rgba(230,82,44,0.12); }

.fh-refresh {
  width: 28px; height: 28px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.7); cursor: pointer; display: flex;
  align-items: center; justify-content: center;
}
.fh-refresh:hover { background: rgba(255,255,255,0.08); color: #f4f4f5; }

/* Anomaly banner */
.fh-anomalies {
  background: rgba(245,158,11,0.06);
  border: 1px solid rgba(245,158,11,0.15);
  border-radius: 8px; padding: 10px 14px;
  display: flex; flex-direction: column; gap: 6px;
}
.fh-anomalies__title {
  font-size: 0.75rem; font-weight: 600; color: #f59e0b;
  display: flex; align-items: center; gap: 6px;
}
.fh-anomaly {
  display: flex; align-items: center; gap: 8px; font-size: 0.72rem;
  padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.03);
}
.fh-anomaly:last-child { border-bottom: none; }
.fh-anomaly--critical .fh-anomaly__host { color: #ef4444; }
.fh-anomaly--warning .fh-anomaly__host { color: #f59e0b; }
.fh-anomaly__host {
  font-weight: 600; font-family: 'SF Mono', 'JetBrains Mono', monospace;
  min-width: 100px;
}
.fh-anomaly__msg { color: rgba(255,255,255,0.6); }
.fh-anomaly--more { color: #52525b; font-style: italic; }

/* Heatmap grid */
.fh-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
}
.fh-cell {
  position: relative; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px; padding: 10px; cursor: pointer; transition: all 0.15s;
  display: flex; flex-direction: column; gap: 4px; text-align: left;
  min-height: 80px;
}
.fh-cell:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.12); }
.fh-cell--selected { border-color: #e6522c; background: rgba(230,82,44,0.06); }
.fh-cell--down { opacity: 0.6; }

.fh-cell__indicator {
  position: absolute; top: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%;
}
.fh-cell__name {
  font-size: 0.72rem; font-weight: 600; color: #e4e4e7;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px;
}
.fh-cell__metrics {
  display: flex; gap: 6px; font-size: 0.7rem; font-weight: 600;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
}
.fh-cell__labels {
  display: flex; gap: 6px; font-size: 0.55rem; color: #52525b; text-transform: uppercase;
  letter-spacing: 0.5px;
}
.fh-cell__metric { min-width: 28px; }
.fh-cell__down {
  position: absolute; bottom: 6px; right: 8px; font-size: 0.55rem; font-weight: 700;
  color: #ef4444; letter-spacing: 1px;
}
.fh-cell__alert-dot {
  position: absolute; top: 6px; left: 8px; width: 6px; height: 6px;
  border-radius: 50%; background: #f59e0b; animation: fh-pulse 2s infinite;
}
@keyframes fh-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* Drill-down panel */
.fh-drill {
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; overflow: hidden;
}
.fh-drill__header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.fh-drill__header h3 {
  margin: 0; font-size: 0.9rem; font-weight: 600; color: #f4f4f5;
  font-family: 'SF Mono', 'JetBrains Mono', monospace;
}
.fh-drill__close {
  background: none; border: none; color: rgba(255,255,255,0.5); font-size: 16px;
  cursor: pointer; padding: 4px 8px;
}
.fh-drill__close:hover { color: #f4f4f5; }
.fh-drill__body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }

/* Current stats row */
.fh-drill__current { display: flex; gap: 20px; flex-wrap: wrap; }
.fh-drill__stat { display: flex; flex-direction: column; gap: 2px; min-width: 60px; }
.fh-drill__stat-label { font-size: 0.65rem; color: #52525b; text-transform: uppercase; letter-spacing: 0.5px; }
.fh-drill__stat-value { font-size: 1.1rem; font-weight: 700; font-family: 'SF Mono', 'JetBrains Mono', monospace; }
.fh-drill__stat-sub { font-size: 0.65rem; color: #52525b; }

/* Charts */
.fh-drill__charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 800px) { .fh-drill__charts { grid-template-columns: 1fr; } }
.fh-chart {
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);
  border-radius: 6px; padding: 8px 10px;
}
.fh-chart__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.fh-chart__label { font-size: 0.65rem; color: #71717a; }
.fh-chart__value { font-size: 0.75rem; font-weight: 600; font-family: 'SF Mono', 'JetBrains Mono', monospace; }
.fh-chart__svg { width: 100%; height: 40px; }
.fh-chart__empty { font-size: 0.7rem; color: #3f3f46; padding: 10px 0; text-align: center; }

/* Drill sections */
.fh-drill__section-title { font-size: 0.7rem; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; }
.fh-drill__anomalies, .fh-drill__alerts { display: flex; flex-direction: column; gap: 6px; }
.fh-drill__alert {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-radius: 4px; font-size: 0.72rem;
}
.fh-drill__alert--critical { background: rgba(239,68,68,0.08); }
.fh-drill__alert--warning { background: rgba(245,158,11,0.08); }
.fh-drill__alert-name { color: rgba(255,255,255,0.7); font-weight: 500; }
.fh-drill__alert-sev { font-size: 0.6rem; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
.fh-drill__alert--critical .fh-drill__alert-sev { color: #ef4444; }
.fh-drill__alert--warning .fh-drill__alert-sev { color: #f59e0b; }

.fh-loading { padding: 2rem; text-align: center; color: #52525b; font-size: 0.8rem; }
`

export default FleetHeatmap
