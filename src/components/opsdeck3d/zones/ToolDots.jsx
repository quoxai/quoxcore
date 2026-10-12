/**
 * ToolDots — Clickable tool dots clustered around each agent node.
 *
 * Phase CC-13: Additional Data Layers.
 * Shows tool density as small octahedrons near each agent.
 * Max 5 dots per agent, ~80 total. Individual meshes for click handling.
 *
 * Props:
 *   agents: array of agent objects
 *   onSelect: (tool) => void — called when a tool dot is clicked
 */
import { useMemo, useCallback } from 'react'
import * as THREE from 'three'

const DOT_SCALE = 0.12
const MAX_DOTS_PER_AGENT = 5
const CLOUD_RADIUS = 1.2

// Reproduce agent position logic (same as AgentMesh.jsx)
function computeAgentPositions(agents) {
  const positions = new Map()
  const roles = { orchestrator: [], manager: [], analyst: [], specialist: [], plugin: [] }

  agents.forEach(a => {
    const role = a.role || 'specialist'
    const bucket = roles[role] || roles.specialist
    bucket.push(a)
  })

  roles.orchestrator.forEach(a => {
    positions.set(a.id, [0, 2, 0])
  })

  const managers = [...roles.manager, ...roles.analyst]
  managers.forEach((a, i) => {
    const angle = (i / Math.max(managers.length, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * 17,
      Math.sin(angle * 2.3) * 0.5,
      Math.sin(angle) * 17,
    ])
  })

  roles.specialist.forEach((a, i) => {
    const angle = (i / Math.max(roles.specialist.length, 1)) * Math.PI * 2
    const yOffset = 0.5 + Math.sin(i * 1.7) * 1.5
    positions.set(a.id, [
      Math.cos(angle) * 25,
      yOffset,
      Math.sin(angle) * 25,
    ])
  })

  roles.plugin.forEach((a, i) => {
    const angle = (i / Math.max(roles.plugin.length, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * 38,
      -3 - (i * 0.5 % 2),
      Math.sin(angle) * 38,
    ])
  })

  return positions
}

// Deterministic pseudo-random using seed
function seededRandom(seed) {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

// Shared geometry (created once)
const sharedGeo = new THREE.OctahedronGeometry(1, 0)

function ToolDot({ position, rotation, color, toolName, agentId, agentName, onSelect }) {
  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({ type: 'tool', name: toolName, agentId, agentName })
  }, [onSelect, toolName, agentId, agentName])

  return (
    <mesh
      position={position}
      rotation={rotation}
      scale={DOT_SCALE}
      geometry={sharedGeo}
      onClick={handleClick}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { document.body.style.cursor = 'default' }}
    >
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.3}
        transparent
        opacity={0.35}
        roughness={0.4}
        metalness={0}
        depthWrite={false}
      />
    </mesh>
  )
}

export default function ToolDots({ agents = [], onSelect }) {
  // Build dot positions: for each agent, scatter up to 5 dots
  const dots = useMemo(() => {
    const agentPositions = computeAgentPositions(agents)
    const allDots = []

    agents.forEach((agent) => {
      const agentPos = agentPositions.get(agent.id)
      if (!agentPos) return

      const tools = agent.tools || []
      const dotCount = Math.min(tools.length, MAX_DOTS_PER_AGENT)
      if (dotCount === 0) return

      const color = agent.color || '#555570'
      const rng = seededRandom(agent.id.charCodeAt(0) * 1000 + (agent.id.charCodeAt(1) || 0) * 10)

      for (let i = 0; i < dotCount; i++) {
        const theta = rng() * Math.PI * 2
        const phi = rng() * Math.PI - Math.PI / 2
        const r = CLOUD_RADIUS * (0.4 + rng() * 0.6)

        allDots.push({
          id: `${agent.id}-tool-${i}`,
          position: [
            agentPos[0] + Math.cos(theta) * Math.cos(phi) * r,
            agentPos[1] + Math.sin(phi) * r * 0.5,
            agentPos[2] + Math.sin(theta) * Math.cos(phi) * r,
          ],
          rotation: [rng() * Math.PI, rng() * Math.PI, 0],
          color,
          toolName: tools[i] || `tool-${i}`,
          agentId: agent.id,
          agentName: agent.name,
        })
      }
    })

    return allDots
  }, [agents])

  if (dots.length === 0) return null

  return (
    <group>
      {dots.map(dot => (
        <ToolDot
          key={dot.id}
          position={dot.position}
          rotation={dot.rotation}
          color={dot.color}
          toolName={dot.toolName}
          agentId={dot.agentId}
          agentName={dot.agentName}
          onSelect={onSelect}
        />
      ))}
    </group>
  )
}
