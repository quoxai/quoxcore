import { useState, useEffect } from 'react'

function StatWidget({
  title,
  icon,
  value,
  subValue,
  status = 'normal', // normal, warning, critical, good
  onClick,
  loading = false,
  color = '#38bdf8'
}) {
  return (
    <button
      className={`stat-widget ${status} ${loading ? 'loading' : ''}`}
      onClick={onClick}
      style={{ '--widget-color': color }}
    >
      <div className="widget-icon">{icon}</div>
      <div className="widget-content">
        <div className="widget-title">{title}</div>
        <div className="widget-value">{loading ? '...' : value}</div>
        {subValue && <div className="widget-subvalue">{subValue}</div>}
      </div>
      <div className={`widget-status-dot ${status}`} />
    </button>
  )
}

// Hosts widget with live data
export function HostsWidget({ hosts = [], onClick, loading }) {
  const online = hosts.filter(h => h.status !== 'offline' && h.status !== 'error').length
  const total = hosts.length
  const status = online === total ? 'good' : online > total * 0.9 ? 'normal' : 'warning'

  return (
    <StatWidget
      title="HOSTS"
      icon="H"
      value={`${online}/${total}`}
      subValue="online"
      status={status}
      onClick={onClick}
      loading={loading}
      color="#3090ff"
    />
  )
}

// Metrics widget with CPU/Memory
export function MetricsWidget({ metrics = {}, onClick, loading }) {
  const cpu = metrics.cpu || 0
  const mem = metrics.memory || 0
  const status = Math.max(cpu, mem) > 90 ? 'critical' : Math.max(cpu, mem) > 75 ? 'warning' : 'good'

  return (
    <StatWidget
      title="METRICS"
      icon="M"
      value={`${cpu}%`}
      subValue={`MEM ${mem}%`}
      status={status}
      onClick={onClick}
      loading={loading}
      color="#30ff90"
    />
  )
}

// Threats widget
export function ThreatsWidget({ threats = [], onClick, loading }) {
  const active = threats.filter(t => t.active).length
  const status = active > 5 ? 'critical' : active > 0 ? 'warning' : 'good'

  return (
    <StatWidget
      title="THREATS"
      icon="T"
      value={active}
      subValue={active === 0 ? 'all clear' : 'active'}
      status={status}
      onClick={onClick}
      loading={loading}
      color="#38bdf8"
    />
  )
}

// Network widget
export function NetworkWidget({ network = {}, onClick, loading }) {
  const formatBandwidth = (bytes) => {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)}G`
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)}M`
    if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)}K`
    return `${bytes}B`
  }

  const bw = network.bandwidth || 0
  const status = network.status === 'degraded' ? 'warning' : network.status === 'down' ? 'critical' : 'good'

  return (
    <StatWidget
      title="NETWORK"
      icon="N"
      value={formatBandwidth(bw)}
      subValue="throughput"
      status={status}
      onClick={onClick}
      loading={loading}
      color="#9d4edd"
    />
  )
}

export default StatWidget
