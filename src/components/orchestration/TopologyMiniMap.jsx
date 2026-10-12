/**
 * TopologyMiniMap — Tiny decorative SVG showing team topology structure
 *
 * Star: radial layout. Hierarchical: top-down tree. Pipeline: left-to-right chain. Mesh: grid.
 * Adapted from quox-remotion. No Remotion deps.
 *
 * @param {'star'|'hierarchical'|'pipeline'|'mesh'} type
 * @param {number} [agents] — node count (default 6)
 * @param {number} [size] — SVG viewBox (default 60)
 * @param {string} [accentColor] — default '#3b82f6'
 */

const NODE_R = 2
const CENTER_R = 2.5

function buildTopology(type, count, size) {
  const cx = size / 2
  const cy = size / 2
  const margin = 8
  const radius = (size - margin * 2) / 2
  const nodes = []
  const edges = []

  if (type === 'star') {
    nodes.push({ x: cx, y: cy, isCenter: true })
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count - Math.PI / 2
      nodes.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, isCenter: false })
      edges.push({ from: 0, to: i + 1 })
    }
  } else if (type === 'hierarchical') {
    nodes.push({ x: cx, y: margin + 2, isCenter: true })
    const l1 = Math.min(3, Math.ceil(count / 2))
    const l2 = count - l1
    for (let i = 0; i < l1; i++) {
      const nx = l1 === 1 ? cx : margin + 4 + ((size - margin * 2 - 8) * i) / Math.max(1, l1 - 1)
      nodes.push({ x: nx, y: cy - 2, isCenter: false })
      edges.push({ from: 0, to: nodes.length - 1 })
    }
    let idx = 0
    for (let p = 0; p < l1 && idx < l2; p++) {
      const children = p < l1 - 1 ? Math.ceil(l2 / l1) : l2 - idx
      for (let c = 0; c < children && idx < l2; c++) {
        const parent = nodes[1 + p]
        const offset = children === 1 ? 0 : (c - (children - 1) / 2) * 10
        nodes.push({ x: parent.x + offset, y: size - margin - 2, isCenter: false })
        edges.push({ from: 1 + p, to: nodes.length - 1 })
        idx++
      }
    }
  } else if (type === 'pipeline') {
    for (let i = 0; i < count; i++) {
      nodes.push({ x: margin + 2 + ((size - margin * 2 - 4) * i) / Math.max(1, count - 1), y: cy, isCenter: i === 0 })
      if (i > 0) edges.push({ from: i - 1, to: i })
    }
  } else if (type === 'mesh') {
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    let idx = 0
    for (let r = 0; r < rows && idx < count; r++) {
      for (let c = 0; c < cols && idx < count; c++) {
        nodes.push({
          x: margin + 4 + ((size - margin * 2 - 8) * c) / Math.max(1, cols - 1),
          y: margin + 4 + ((size - margin * 2 - 8) * r) / Math.max(1, rows - 1),
          isCenter: idx === 0,
        })
        if (c > 0) edges.push({ from: idx - 1, to: idx })
        if (r > 0 && idx - cols >= 0) edges.push({ from: idx - cols, to: idx })
        idx++
      }
    }
  }

  return { nodes, edges }
}

export default function TopologyMiniMap({ type = 'star', agents = 6, size = 60, accentColor = '#3b82f6' }) {
  const { nodes, edges } = buildTopology(type, agents, size)

  return (
    <svg width={size} height={size * 0.67} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible', opacity: 0.6 }}>
      {edges.map((e, i) => (
        <line key={i}
          x1={nodes[e.from].x} y1={nodes[e.from].y}
          x2={nodes[e.to].x} y2={nodes[e.to].y}
          stroke={accentColor} strokeWidth={1} opacity={0.3}
        />
      ))}
      {nodes.map((n, i) => (
        <circle key={i}
          cx={n.x} cy={n.y} r={n.isCenter ? CENTER_R : NODE_R}
          fill={n.isCenter ? accentColor : 'rgba(255,255,255,0.5)'}
          opacity={n.isCenter ? 0.8 : 0.5}
        />
      ))}
    </svg>
  )
}
