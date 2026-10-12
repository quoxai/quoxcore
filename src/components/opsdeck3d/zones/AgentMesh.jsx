/**
 * AgentMesh — Container for all agent nodes, connection lines, and delegation arcs.
 *
 * Fibonacci layout:
 *   Orchestrator (QUOX):   [0, 2, 0] near nucleus
 *   Core Assistants:       r=17 (managers + analysts: WARDEN, CIPHER, DAEDALUS, PRISM)
 *   Core Agents:           r=25 (specialists: HYPERION, METRICS, etc.)
 *   Plugin agents:         NOT rendered here — appear in TeamClusters at r=38/59
 *
 * Renders AgentNode for each core agent, faint connection lines from QUOX,
 * and DelegationArc for each active delegation.
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { useDisposable } from '../lib/useDisposable'
import { resolveOverlayColor } from '../lib/colorOverlays'
import AgentNode from './AgentNode'
import DelegationArc from '../effects/DelegationArc'
import { PALETTE } from '../lib/design-system'

// Ring radii (Fibonacci layout)
const R_ASSISTANTS = 17  // managers + analysts
const R_AGENTS = 25      // specialists

// ─── Structured layout ──────────────────────────────────
function computePositions(agents) {
  const positions = new Map()
  const orchestrators = []
  const assistants = []  // managers + analysts
  const coreAgents = [] // specialists (source=core)
  const pluginAgents = [] // plugin agents (rendered in TeamClusters, but still need positions for delegation arcs)

  agents.forEach(a => {
    const role = a.role || 'specialist'
    const isPlugin = a.source === 'plugin' || a.ownership?.source === 'plugin'
    if (role === 'orchestrator') {
      orchestrators.push(a)
    } else if (role === 'manager' || role === 'analyst') {
      assistants.push(a)
    } else if (isPlugin) {
      pluginAgents.push(a)
    } else {
      coreAgents.push(a)
    }
  })

  // Orchestrator: near nucleus
  orchestrators.forEach(a => {
    positions.set(a.id, [0, 2, 0])
  })

  // Core Assistants: r=17 equatorial band
  assistants.forEach((a, i) => {
    const angle = (i / Math.max(assistants.length, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * R_ASSISTANTS,
      Math.sin(angle * 2.3) * 0.5,
      Math.sin(angle) * R_ASSISTANTS,
    ])
  })

  // Core Agents (specialists): r=25, evenly spaced upper hemisphere bias
  coreAgents.forEach((a, i) => {
    const angle = (i / Math.max(coreAgents.length, 1)) * Math.PI * 2
    const yOffset = 0.5 + Math.sin(i * 1.7) * 1.5
    positions.set(a.id, [
      Math.cos(angle) * R_AGENTS,
      yOffset,
      Math.sin(angle) * R_AGENTS,
    ])
  })

  // Plugin agents: positioned off-scene (they render in TeamClusters)
  // but we still record positions for delegation arcs to find them
  pluginAgents.forEach((a, i) => {
    const angle = (i / Math.max(pluginAgents.length, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * 38,
      0,
      Math.sin(angle) * 38,
    ])
  })

  return positions
}

// ─── Connection line (thin line from A to B) ────────────
function ConnectionLine({ from, to, opacity = 0.08 }) {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    const verts = new Float32Array([
      from[0], from[1], from[2],
      to[0], to[1], to[2],
    ])
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    return g
  }, [from, to])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial
        color={PALETTE.connection}
        transparent
        opacity={opacity}
        depthWrite={false}
      />
    </line>
  )
}

export default function AgentMesh({
  agents = [],
  settings = {},
  onSelect,
  delegations = [],
  overlayMode = 'default',
}) {
  const connOpacity = settings.connectionOpacity ?? 0.08

  // Compute stable positions
  const positions = useMemo(() => computePositions(agents), [agents])

  // Find orchestrator for connection lines
  const orchestrator = agents.find(a => a.role === 'orchestrator')
  const orchestratorPos = orchestrator ? positions.get(orchestrator.id) : null

  // Core assistants + agents (exclude plugin agents — they render in TeamClusters)
  const coreAgents = agents.filter(a => {
    const isPlugin = a.source === 'plugin' || a.ownership?.source === 'plugin'
    return !isPlugin
  })

  // Assistants get connection lines from QUOX
  const assistants = agents.filter(a => a.role === 'manager' || a.role === 'analyst')

  return (
    <group>
      {/* Core agent nodes (orchestrator + assistants + specialists) */}
      {coreAgents.map(agent => {
        const pos = positions.get(agent.id) || [0, 0, 0]
        const overlay = resolveOverlayColor(agent, overlayMode)
        return (
          <AgentNode
            key={agent.id}
            agentId={agent.id}
            position={pos}
            name={agent.name}
            role={agent.role}
            state={agent.state}
            color={overlay.color}
            opacity={overlay.opacity}
            description={agent.description}
            tools={agent.tools || []}
            capabilities={agent.capabilities || []}
            settings={settings}
            onSelect={onSelect}
          />
        )
      })}

      {/* Connection lines: QUOX to each assistant */}
      {orchestratorPos && assistants.map(m => {
        const mPos = positions.get(m.id)
        if (!mPos) return null
        return (
          <ConnectionLine
            key={`conn-${m.id}`}
            from={orchestratorPos}
            to={mPos}
            opacity={connOpacity}
          />
        )
      })}

      {/* Delegation arcs */}
      {delegations.map(d => {
        const fromPos = positions.get(d.from)
        const toPos = positions.get(d.to)
        if (!fromPos || !toPos) return null
        return (
          <DelegationArc
            key={d.id}
            from={fromPos}
            to={toPos}
            color={PALETTE.delegation}
            duration={1.2}
            onComplete={d.onComplete}
          />
        )
      })}
    </group>
  )
}

// Export positions helper for target lock
export { computePositions }
