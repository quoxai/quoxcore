/**
 * ProxmoxTable — Dense ops table for VMs and containers.
 *
 * Sortable columns, row selection, status dots with breathing animation,
 * monospace technical data, filter tabs, node grouping, sparklines,
 * and right-click context menu. Designed for NOC-grade display.
 */

import { useState, useMemo, useCallback } from 'react'
import { formatBytes, formatUptime } from '../../services/proxmoxClient'
import { getStatusColor } from '../core/monitoring/useProxmoxData'
import { SparklineCell } from './SparklineCell'
import './proxmox-table.css'

const COLUMNS = [
  { key: 'status', label: '', width: 32, sortable: false },
  { key: 'name', label: 'Name', width: null, sortable: true },
  { key: 'type', label: 'Type', width: 52, sortable: true },
  { key: 'vmid', label: 'VMID', width: 64, sortable: true, mono: true },
  { key: 'node', label: 'Node', width: 80, sortable: true, mono: true },
  { key: 'ip', label: 'IP', width: 120, sortable: true, mono: true },
  { key: 'cpu', label: 'CPU', width: 80, sortable: true, mono: true },
  { key: 'mem', label: 'Memory', width: 96, sortable: true, mono: true },
  { key: 'uptime', label: 'Uptime', width: 72, sortable: true, mono: true },
]

function SortArrow({ direction }) {
  if (!direction) return null
  return (
    <span className="pxt-sort-arrow">
      {direction === 'asc' ? '▲' : '▼'}
    </span>
  )
}

function StatusDot({ status }) {
  const color = getStatusColor(status)
  return (
    <span className={`pxt-status-dot pxt-status-dot--${status}`}>
      <span className="pxt-status-dot__inner" style={{ background: color }} />
      {status === 'running' && (
        <span className="pxt-status-dot__ring" style={{ borderColor: color }} />
      )}
    </span>
  )
}

function CpuCell({ cpu, status, sparklineData }) {
  if (status !== 'running' || cpu == null) return <span className="pxt-cell-muted">--</span>
  const pct = (cpu * 100).toFixed(0)
  const n = parseFloat(pct)
  const barColor = n > 80 ? '#ff6b30' : n > 50 ? '#ffb030' : '#30ff90'
  return (
    <span className="pxt-cpu-cell">
      <span className="pxt-cpu-value">{pct}%</span>
      <span className="pxt-micro-bar">
        <span className="pxt-micro-bar__fill" style={{ width: `${Math.min(n, 100)}%`, background: barColor }} />
      </span>
      {sparklineData && sparklineData.length >= 2 && <SparklineCell values={sparklineData} />}
    </span>
  )
}

function MemCell({ mem, maxmem, status, sparklineData }) {
  if (status !== 'running' || !mem || !maxmem) return <span className="pxt-cell-muted">--</span>
  const pct = ((mem / maxmem) * 100).toFixed(0)
  const n = parseFloat(pct)
  const barColor = n > 80 ? '#ff6b30' : n > 50 ? '#ffb030' : '#30ff90'
  return (
    <span className="pxt-mem-cell">
      <span className="pxt-mem-value">{formatBytes(mem)}</span>
      <span className="pxt-micro-bar">
        <span className="pxt-micro-bar__fill" style={{ width: `${Math.min(n, 100)}%`, background: barColor }} />
      </span>
      {sparklineData && sparklineData.length >= 2 && <SparklineCell values={sparklineData} />}
    </span>
  )
}

function GroupHeader({ nodeName, items, expanded, onToggle }) {
  const running = items.filter(i => i.status === 'running').length
  const total = items.length
  return (
    <tr className="pxt-group-header" onClick={onToggle}>
      <td colSpan={COLUMNS.length} className="pxt-group-header__td">
        <span className="pxt-group-header__arrow">{expanded ? '▾' : '▸'}</span>
        <span className="pxt-group-header__dot" style={{ background: '#30ff90' }} />
        <span className="pxt-group-header__name">{nodeName}</span>
        <span className="pxt-group-header__count">{running}/{total} running</span>
      </td>
    </tr>
  )
}

export function ProxmoxTable({
  items = [],
  selectedVM,
  onSelectVM,
  filter = 'all',
  onFilterChange,
  typeFilter = 'all',
  onTypeFilterChange,
  onContextMenu,
  error,
  isInitialLoad,
  clusterSummary,
  getHistory,
  itemKey: itemKeyFn,
  children,
}) {
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [grouped, setGrouped] = useState(false)
  const [collapsedNodes, setCollapsedNodes] = useState(new Set())

  const handleSort = useCallback((key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }, [sortKey])

  const toggleNode = useCallback((nodeName) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeName)) next.delete(nodeName)
      else next.add(nodeName)
      return next
    })
  }, [])

  // Filter
  const filtered = useMemo(() => {
    let list = items
    if (typeFilter !== 'all') {
      list = list.filter(item => item.type === typeFilter)
    }
    if (filter !== 'all') {
      list = list.filter(item => item.status === filter)
    }
    return list
  }, [items, filter, typeFilter])

  // Sort
  const sorted = useMemo(() => {
    const mult = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      let va = a[sortKey]
      let vb = b[sortKey]

      if (sortKey === 'status') {
        const order = { running: 0, paused: 1, stopped: 2 }
        return mult * ((order[va] ?? 3) - (order[vb] ?? 3))
      }
      if (sortKey === 'cpu' || sortKey === 'mem' || sortKey === 'vmid' || sortKey === 'uptime') {
        va = va ?? -1
        vb = vb ?? -1
        return mult * (va - vb)
      }

      va = (va || '').toString().toLowerCase()
      vb = (vb || '').toString().toLowerCase()
      return mult * va.localeCompare(vb)
    })
  }, [filtered, sortKey, sortDir])

  // Group by node
  const groupedItems = useMemo(() => {
    if (!grouped) return null
    const map = new Map()
    for (const item of sorted) {
      const node = item.node || 'unknown'
      if (!map.has(node)) map.set(node, [])
      map.get(node).push(item)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [sorted, grouped])

  // Counts for filter tabs
  const counts = useMemo(() => {
    let list = items
    if (typeFilter !== 'all') {
      list = list.filter(item => item.type === typeFilter)
    }
    return {
      all: list.length,
      running: list.filter(i => i.status === 'running').length,
      stopped: list.filter(i => i.status === 'stopped').length,
    }
  }, [items, typeFilter])

  const typeCounts = useMemo(() => ({
    all: items.length,
    qemu: items.filter(i => i.type === 'qemu').length,
    lxc: items.filter(i => i.type === 'lxc').length,
  }), [items])

  const handleContextMenu = useCallback((e, item) => {
    e.preventDefault()
    if (onContextMenu) {
      onSelectVM?.(item)
      onContextMenu(item, { x: e.clientX, y: e.clientY })
    }
  }, [onContextMenu, onSelectVM])

  const renderRow = (item) => {
    const isSelected = selectedVM && selectedVM.vmid === item.vmid && selectedVM.node === item.node
    const key = itemKeyFn ? itemKeyFn(item) : `${item.node}-${item.vmid}`
    const history = getHistory ? getHistory(key) : { cpu: [], mem: [] }

    return (
      <tr
        key={key}
        className={`pxt-row ${item.status === 'stopped' ? 'pxt-row--stopped' : ''} ${isSelected ? 'pxt-row--selected' : ''}`}
        onClick={() => onSelectVM?.(item)}
        onContextMenu={(e) => handleContextMenu(e, item)}
      >
        <td className="pxt-td pxt-td--status">
          <StatusDot status={item.status} />
        </td>
        <td className="pxt-td pxt-td--name">
          {item.name || `${item.type === 'lxc' ? 'CT' : 'VM'} ${item.vmid}`}
        </td>
        <td className="pxt-td pxt-td--type">
          <span className={`pxt-type-badge pxt-type-badge--${item.type}`}>
            {item.type === 'lxc' ? 'CT' : 'VM'}
          </span>
        </td>
        <td className="pxt-td pxt-mono">{item.vmid}</td>
        <td className="pxt-td pxt-mono">{item.node}</td>
        <td className="pxt-td pxt-mono">
          {item.ip ? (
            <span title={item.ip}>{item.ip}</span>
          ) : (
            <span className="pxt-cell-muted" title="Guest agent not available or IP not resolved">--</span>
          )}
        </td>
        <td className="pxt-td pxt-mono">
          <CpuCell cpu={item.cpu} status={item.status} sparklineData={history.cpu} />
        </td>
        <td className="pxt-td pxt-mono">
          <MemCell mem={item.mem} maxmem={item.maxmem} status={item.status} sparklineData={history.mem} />
        </td>
        <td className="pxt-td pxt-mono">
          {item.status === 'running' && item.uptime
            ? formatUptime(item.uptime)
            : <span className="pxt-cell-muted">--</span>
          }
        </td>
      </tr>
    )
  }

  return (
    <div className="pxt">
      {/* Filter bar */}
      <div className="pxt-filters">
        <div className="pxt-type-tabs">
          <button
            className={`pxt-tab ${typeFilter === 'all' ? 'pxt-tab--active' : ''}`}
            onClick={() => onTypeFilterChange?.('all')}
          >All ({typeCounts.all})</button>
          <button
            className={`pxt-tab ${typeFilter === 'qemu' ? 'pxt-tab--active' : ''}`}
            onClick={() => onTypeFilterChange?.('qemu')}
          >VMs ({typeCounts.qemu})</button>
          <button
            className={`pxt-tab ${typeFilter === 'lxc' ? 'pxt-tab--active' : ''}`}
            onClick={() => onTypeFilterChange?.('lxc')}
          >Containers ({typeCounts.lxc})</button>
          <button
            className={`pxt-tab ${typeFilter === 'nodes' ? 'pxt-tab--active' : ''}`}
            onClick={() => onTypeFilterChange?.('nodes')}
          >Nodes ({clusterSummary?.totalNodes ?? 0})</button>
          <button
            className={`pxt-tab ${typeFilter === 'backups' ? 'pxt-tab--active' : ''}`}
            onClick={() => onTypeFilterChange?.('backups')}
          >Backups</button>
        </div>
        {typeFilter !== 'nodes' && typeFilter !== 'backups' && (
          <div className="pxt-controls">
            <button
              className={`pxt-group-toggle ${grouped ? 'pxt-group-toggle--active' : ''}`}
              onClick={() => setGrouped(g => !g)}
              title={grouped ? 'Flat list' : 'Group by node'}
            >
              <span className="pxt-group-toggle__icon">⊞</span>
              Node
            </button>
            <div className="pxt-status-tabs">
              <button
                className={`pxt-pill ${filter === 'all' ? 'pxt-pill--active' : ''}`}
                onClick={() => onFilterChange?.('all')}
              >All</button>
              <button
                className={`pxt-pill ${filter === 'running' ? 'pxt-pill--active' : ''}`}
                onClick={() => onFilterChange?.('running')}
              >Running ({counts.running})</button>
              <button
                className={`pxt-pill ${filter === 'stopped' ? 'pxt-pill--active' : ''}`}
                onClick={() => onFilterChange?.('stopped')}
              >Stopped ({counts.stopped})</button>
            </div>
          </div>
        )}
      </div>

      {/* Content: children (e.g. ProxmoxNodes) override the table */}
      {children || <div className="pxt-table-wrap">
        <table className="pxt-table">
          <thead>
            <tr className="pxt-head-row">
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  className={`pxt-th ${col.sortable ? 'pxt-th--sortable' : ''} ${col.mono ? 'pxt-mono' : ''}`}
                  style={{ width: col.width || undefined }}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  {col.label}
                  {col.sortable && sortKey === col.key && <SortArrow direction={sortDir} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isInitialLoad && (
              <tr><td colSpan={COLUMNS.length} className="pxt-placeholder">Loading cluster data...</td></tr>
            )}
            {!isInitialLoad && error && error !== 'permissionHint' && (
              <tr><td colSpan={COLUMNS.length} className="pxt-placeholder pxt-placeholder--error">
                <span style={{ marginRight: 6 }}>✕</span>{error}
              </td></tr>
            )}
            {!isInitialLoad && error === 'permissionHint' && (
              <tr><td colSpan={COLUMNS.length} className="pxt-placeholder pxt-placeholder--warn">
                API token lacks VM/container permissions. Uncheck "Privilege Separation" on your Proxmox API token.
              </td></tr>
            )}
            {!isInitialLoad && !error && sorted.length === 0 && (
              <tr><td colSpan={COLUMNS.length} className="pxt-placeholder">
                {filter !== 'all' ? `No ${filter} guests` : 'No VMs or containers found'}
              </td></tr>
            )}
            {!isInitialLoad && !grouped && sorted.map(renderRow)}
            {!isInitialLoad && grouped && groupedItems && groupedItems.flatMap(([nodeName, nodeItems]) => {
              const isCollapsed = collapsedNodes.has(nodeName)
              return [
                <GroupHeader
                  key={`group-${nodeName}`}
                  nodeName={nodeName}
                  items={nodeItems}
                  expanded={!isCollapsed}
                  onToggle={() => toggleNode(nodeName)}
                />,
                ...(!isCollapsed ? nodeItems.map(renderRow) : [])
              ]
            })}
          </tbody>
        </table>
      </div>}
    </div>
  )
}

export default ProxmoxTable
