/**
 * ProxmoxNodes — Node health dashboard panel.
 *
 * Displays per-node health cards in a responsive grid. Each card shows:
 * - Online/offline status with breathing dot
 * - CPU radial gauge + percentage
 * - Memory usage bar with used/total
 * - Storage usage bar
 * - Load average (1m/5m/15m)
 * - Uptime display
 * - Kernel version
 *
 * Data fetched via getNodeStatus() per node, refreshed on interval.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getNodeStatus } from '../../services/proxmoxClient'
import { formatBytes, formatUptime } from '../../services/proxmoxClient'
import './proxmox-nodes.css'

const MONO = "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace"
const NODE_REFRESH = 30000 // 30s

function healthColor(value, warn = 70, crit = 90) {
  if (value == null) return '#3f3f46'
  if (value >= crit) return '#ff5555'
  if (value >= warn) return '#ffb030'
  return '#30ff90'
}

function healthLevel(cpuPct, memPct) {
  if (cpuPct >= 90 || memPct >= 90) return 'critical'
  if (cpuPct >= 70 || memPct >= 70) return 'warning'
  return 'healthy'
}

/** Radial gauge — pure SVG, no dependencies */
function RadialGauge({ value, size = 72, strokeWidth = 5, label, color }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (pct / 100) * circumference
  const gaugeColor = color || healthColor(pct)

  return (
    <div className="pxn-gauge">
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {/* Track */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeWidth}
        />
        {/* Value arc */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none"
          stroke={gaugeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.3s ease' }}
        />
      </svg>
      <div className="pxn-gauge__value" style={{ color: gaugeColor }}>
        {value != null ? `${Math.round(pct)}` : '--'}
        <span className="pxn-gauge__unit">%</span>
      </div>
      {label && <div className="pxn-gauge__label">{label}</div>}
    </div>
  )
}

/** Horizontal metric bar */
function MetricBar({ label, value, detail, color, warn = 70, crit = 90 }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  const barColor = color || healthColor(pct, warn, crit)

  return (
    <div className="pxn-metric">
      <div className="pxn-metric__header">
        <span className="pxn-metric__label">{label}</span>
        <span className="pxn-metric__value" style={{ color: barColor }}>
          {detail || `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="pxn-metric__track">
        <div
          className="pxn-metric__fill"
          style={{ width: `${pct}%`, background: barColor, transition: 'width 0.5s ease' }}
        />
      </div>
    </div>
  )
}

/** Load average display — 3 values with color coding */
function LoadDisplay({ loadavg }) {
  if (!loadavg) return <span className="pxn-muted">--</span>

  const parts = typeof loadavg === 'string'
    ? loadavg.split(/\s+/).map(Number)
    : Array.isArray(loadavg) ? loadavg.map(Number) : []

  if (parts.length < 3) return <span className="pxn-muted">--</span>

  return (
    <div className="pxn-load">
      {['1m', '5m', '15m'].map((period, i) => {
        const val = parts[i] || 0
        const color = val >= 8 ? '#ff5555' : val >= 3 ? '#ffb030' : 'rgba(255,255,255,0.6)'
        return (
          <div key={period} className="pxn-load__item">
            <span className="pxn-load__value" style={{ color }}>{val.toFixed(2)}</span>
            <span className="pxn-load__period">{period}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Single node health card */
function NodeCard({ node, stats, isExpanded, onToggle }) {
  const isOnline = node.online === 1
  const cpuPct = stats?.cpu ? parseFloat(stats.cpu) : null
  const memPct = stats?.memory?.percent ? parseFloat(stats.memory.percent) : null
  const level = isOnline && cpuPct != null ? healthLevel(cpuPct, memPct || 0) : (isOnline ? 'healthy' : 'offline')

  return (
    <div className={`pxn-card pxn-card--${level}`}>
      {/* Card header */}
      <div className="pxn-card__header" onClick={onToggle}>
        <div className="pxn-card__identity">
          <span className={`pxn-card__dot pxn-card__dot--${isOnline ? 'online' : 'offline'}`} />
          <span className="pxn-card__name">{node.name}</span>
        </div>
        <div className="pxn-card__badges">
          {level === 'critical' && <span className="pxn-badge pxn-badge--critical">CRIT</span>}
          {level === 'warning' && <span className="pxn-badge pxn-badge--warning">WARN</span>}
          {!isOnline && <span className="pxn-badge pxn-badge--offline">DOWN</span>}
          <span className="pxn-card__expand">{isExpanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* Gauges row — always visible */}
      {isOnline && (
        <div className="pxn-card__gauges">
          <RadialGauge value={cpuPct} size={68} strokeWidth={5} label="CPU" />
          <div className="pxn-card__bars">
            <MetricBar
              label="MEM"
              value={memPct}
              detail={stats?.memory ? `${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}` : null}
            />
            <div className="pxn-card__uptime">
              <span className="pxn-card__uptime-label">UP</span>
              <span className="pxn-card__uptime-value">
                {stats?.uptime ? formatUptime(stats.uptime) : '--'}
              </span>
            </div>
          </div>
        </div>
      )}

      {!isOnline && (
        <div className="pxn-card__offline">
          <span className="pxn-card__offline-icon">⊘</span>
          <span>Node unreachable</span>
        </div>
      )}

      {/* Expanded details */}
      {isExpanded && isOnline && (
        <div className="pxn-card__details">
          <div className="pxn-card__detail-row">
            <span className="pxn-card__detail-label">Load Average</span>
            <LoadDisplay loadavg={stats?.loadavg} />
          </div>
          {node.ip && (
            <div className="pxn-card__detail-row">
              <span className="pxn-card__detail-label">IP</span>
              <span className="pxn-card__detail-value">{node.ip}</span>
            </div>
          )}
          {stats?.kversion && (
            <div className="pxn-card__detail-row">
              <span className="pxn-card__detail-label">Kernel</span>
              <span className="pxn-card__detail-value pxn-card__detail-value--mono">
                {stats.kversion.split(' ')[0] || stats.kversion}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ProxmoxNodes({ cluster }) {
  const [nodeStats, setNodeStats] = useState({})
  const [loading, setLoading] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState(new Set())
  const mountedRef = useRef(true)

  const nodes = useMemo(() => cluster?.nodes || [], [cluster])

  const fetchNodeStats = useCallback(async (isBackground = false) => {
    if (nodes.length === 0) return
    if (!isBackground) setLoading(true)

    const results = await Promise.allSettled(
      nodes.filter(n => n.online === 1).map(n => getNodeStatus(n.name))
    )

    if (!mountedRef.current) return

    const stats = {}
    const onlineNodes = nodes.filter(n => n.online === 1)
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value.success) {
        stats[onlineNodes[idx].name] = result.value
      }
    })

    setNodeStats(stats)
    setLoading(false)
  }, [nodes])

  useEffect(() => {
    mountedRef.current = true
    fetchNodeStats()
    const interval = setInterval(() => fetchNodeStats(true), NODE_REFRESH)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [fetchNodeStats])

  const toggleExpand = useCallback((name) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  // Summary stats
  const summary = useMemo(() => {
    const online = nodes.filter(n => n.online === 1).length
    const total = nodes.length
    let avgCpu = 0, avgMem = 0, count = 0
    for (const [, s] of Object.entries(nodeStats)) {
      if (s.cpu) { avgCpu += parseFloat(s.cpu); count++ }
      if (s.memory?.percent) avgMem += parseFloat(s.memory.percent)
    }
    if (count > 0) { avgCpu /= count; avgMem /= count }
    return { online, total, avgCpu, avgMem }
  }, [nodes, nodeStats])

  if (loading && Object.keys(nodeStats).length === 0) {
    return (
      <div className="pxn">
        <div className="pxn-loading">Loading node data...</div>
      </div>
    )
  }

  return (
    <div className="pxn">
      {/* Summary strip */}
      <div className="pxn-summary">
        <div className="pxn-summary__item">
          <span className="pxn-summary__value" style={{ color: summary.online === summary.total ? '#30ff90' : '#ffb030' }}>
            {summary.online}/{summary.total}
          </span>
          <span className="pxn-summary__label">nodes online</span>
        </div>
        <div className="pxn-summary__sep" />
        <div className="pxn-summary__item">
          <span className="pxn-summary__value" style={{ color: healthColor(summary.avgCpu) }}>
            {summary.avgCpu.toFixed(0)}%
          </span>
          <span className="pxn-summary__label">avg CPU</span>
        </div>
        <div className="pxn-summary__sep" />
        <div className="pxn-summary__item">
          <span className="pxn-summary__value" style={{ color: healthColor(summary.avgMem) }}>
            {summary.avgMem.toFixed(0)}%
          </span>
          <span className="pxn-summary__label">avg MEM</span>
        </div>
      </div>

      {/* Node cards grid */}
      <div className="pxn-grid">
        {nodes.map(node => (
          <NodeCard
            key={node.name}
            node={node}
            stats={nodeStats[node.name]}
            isExpanded={expandedNodes.has(node.name)}
            onToggle={() => toggleExpand(node.name)}
          />
        ))}
      </div>
    </div>
  )
}

export default ProxmoxNodes
