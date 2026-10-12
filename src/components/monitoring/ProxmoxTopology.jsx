/**
 * ProxmoxTopology — Node topology visualization.
 *
 * Nodes rendered as boxes, VMs/CTs as dots inside them.
 * Color by status, size by memory allocation.
 * Click dot to select VM, hover for tooltip.
 */

import { useState, useMemo } from 'react'
import { getStatusColor } from '../core/monitoring/useProxmoxData'
import { formatBytes } from '../../services/proxmoxClient'
import './proxmox-topology.css'

function getDotSize(maxmem) {
  if (!maxmem) return 8
  const gb = maxmem / (1024 * 1024 * 1024)
  if (gb >= 8) return 14
  if (gb >= 4) return 11
  return 8
}

function VMDot({ item, isSelected, onSelect }) {
  const [showTooltip, setShowTooltip] = useState(false)
  const color = getStatusColor(item.status)
  const size = getDotSize(item.maxmem)
  const displayName = item.name || `${item.type === 'lxc' ? 'CT' : 'VM'} ${item.vmid}`

  return (
    <div
      className={`pxtp-dot ${isSelected ? 'pxtp-dot--selected' : ''} ${item.status === 'stopped' ? 'pxtp-dot--stopped' : ''}`}
      style={{
        width: size,
        height: size,
        background: color,
        borderColor: isSelected ? '#ff6b30' : 'transparent',
      }}
      onClick={(e) => { e.stopPropagation(); onSelect(item) }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {showTooltip && (
        <div className="pxtp-tooltip">
          <div className="pxtp-tooltip__name">{displayName}</div>
          <div className="pxtp-tooltip__meta">
            <span>{item.type === 'lxc' ? 'CT' : 'VM'} {item.vmid}</span>
            <span style={{ color }}>{item.status}</span>
          </div>
          {item.ip && <div className="pxtp-tooltip__ip">{item.ip}</div>}
          {item.status === 'running' && item.cpu != null && (
            <div className="pxtp-tooltip__res">
              CPU: {(item.cpu * 100).toFixed(0)}%
              {item.mem && item.maxmem && ` · Mem: ${((item.mem / item.maxmem) * 100).toFixed(0)}%`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NodeBox({ nodeName, items, nodeInfo, selectedVM, onSelectVM }) {
  const running = items.filter(i => i.status === 'running').length
  const total = items.length
  const isOnline = nodeInfo?.online === 1

  return (
    <div className={`pxtp-node ${isOnline ? '' : 'pxtp-node--offline'}`}>
      <div className="pxtp-node__header">
        <div className="pxtp-node__name">
          <span className="pxtp-node__status-dot" style={{ background: isOnline ? '#30ff90' : '#ff6b30' }} />
          {nodeName}
        </div>
        <div className="pxtp-node__count">{running}/{total}</div>
      </div>
      <div className="pxtp-node__body">
        {items.map(item => (
          <VMDot
            key={`${item.node}-${item.vmid}`}
            item={item}
            isSelected={selectedVM && selectedVM.vmid === item.vmid && selectedVM.node === item.node}
            onSelect={onSelectVM}
          />
        ))}
        {items.length === 0 && (
          <span className="pxtp-node__empty">No guests</span>
        )}
      </div>
    </div>
  )
}

export function ProxmoxTopology({ items = [], cluster, selectedVM, onSelectVM }) {
  const grouped = useMemo(() => {
    const map = new Map()
    for (const item of items) {
      const node = item.node || 'unknown'
      if (!map.has(node)) map.set(node, [])
      map.get(node).push(item)
    }
    // Sort nodes alphabetically
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [items])

  const nodeInfoMap = useMemo(() => {
    const map = {}
    if (cluster?.nodes) {
      for (const n of cluster.nodes) {
        map[n.name] = n
      }
    }
    return map
  }, [cluster])

  return (
    <div className="pxtp">
      <div className="pxtp-legend">
        <span className="pxtp-legend__item">
          <span className="pxtp-legend__dot" style={{ background: '#30ff90' }} /> Running
        </span>
        <span className="pxtp-legend__item">
          <span className="pxtp-legend__dot" style={{ background: '#ff6b30' }} /> Stopped
        </span>
        <span className="pxtp-legend__item">
          <span className="pxtp-legend__dot" style={{ background: '#ffb030' }} /> Paused
        </span>
        <span className="pxtp-legend__sep" />
        <span className="pxtp-legend__item pxtp-legend__size">
          Dot size = memory allocation
        </span>
      </div>
      <div className="pxtp-grid">
        {grouped.map(([nodeName, nodeItems]) => (
          <NodeBox
            key={nodeName}
            nodeName={nodeName}
            items={nodeItems}
            nodeInfo={nodeInfoMap[nodeName]}
            selectedVM={selectedVM}
            onSelectVM={onSelectVM}
          />
        ))}
      </div>
    </div>
  )
}

export default ProxmoxTopology
