/**
 * TopologyBadge — Compact pill showing team topology type with micro-icon
 *
 * Adapted from quox-remotion reference. Remotion deps removed.
 * Uses dashboard CSS variables and design system.
 *
 * @param {string} type — 'star' | 'hierarchical' | 'pipeline' | 'mesh'
 * @param {'sm'|'md'} size — badge size (default 'md')
 */

const TOPOLOGY_CONFIG = {
  star:         { icon: '\u2605', color: '#3b82f6', label: 'Star' },
  hierarchical: { icon: '\u229e', color: '#a855f7', label: 'Hierarchical' },
  pipeline:     { icon: '\u25b8\u25b8', color: '#f59e0b', label: 'Pipeline' },
  mesh:         { icon: '\u25c8', color: '#06b6d4', label: 'Mesh' },
}

const SIZE_CONFIG = {
  sm: { fontSize: 10, iconSize: 11, px: 6, py: 2 },
  md: { fontSize: 12, iconSize: 13, px: 10, py: 3 },
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r},${g},${b}`
}

export default function TopologyBadge({ type = 'star', size = 'md' }) {
  const topo = TOPOLOGY_CONFIG[type] || TOPOLOGY_CONFIG.star
  const dims = SIZE_CONFIG[size] || SIZE_CONFIG.md

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      background: `rgba(${hexToRgb(topo.color)}, 0.1)`,
      border: `1px solid rgba(${hexToRgb(topo.color)}, 0.2)`,
      borderRadius: 10,
      paddingLeft: dims.px,
      paddingRight: dims.px,
      paddingTop: dims.py,
      paddingBottom: dims.py,
      lineHeight: 1,
    }}>
      <span style={{ fontSize: dims.iconSize, color: topo.color, lineHeight: 1 }}>
        {topo.icon}
      </span>
      <span style={{
        fontSize: dims.fontSize, color: 'rgba(255,255,255,0.85)',
        fontWeight: 500, lineHeight: 1,
      }}>
        {topo.label}
      </span>
    </span>
  )
}
