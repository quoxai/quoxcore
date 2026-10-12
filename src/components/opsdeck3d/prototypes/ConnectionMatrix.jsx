/**
 * ConnectionMatrix — 3D visualization of agent-to-agent relationships.
 *
 * Every canDelegateTo relationship is a persistent faint connection.
 * Active delegations brighten the connection and add flowing particles.
 * The matrix also shows which agents are working on which objective.
 *
 * This reveals the TOPOLOGY of the system — not just who exists,
 * but who talks to whom and how busy each channel is.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const AGENTS = [
  { id: 'quox', name: 'QUOX', color: '#38bdf8', role: 'orchestrator' },
  { id: 'sentinel', name: 'WARDEN', color: '#3090ff', role: 'manager' },
  { id: 'cipher', name: 'CIPHER', color: '#9d4edd', role: 'manager' },
  { id: 'nova', name: 'DAEDALUS', color: '#30ff90', role: 'manager' },
  { id: 'atlas', name: 'HYPERION', color: '#ff8c00', role: 'specialist' },
  { id: 'metrics', name: 'METRICS', color: '#e6522c', role: 'specialist' },
  { id: 'forge', name: 'VULCAN', color: '#8b5cf6', role: 'specialist' },
  { id: 'beacon', name: 'VIGIL', color: '#00c853', role: 'specialist' },
]

// canDelegateTo relationships (directed)
const CONNECTIONS = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], // QUOX → all
  [1, 4], [1, 5], // WARDEN → HYPERION, METRICS
  [2, 6], // CIPHER → VULCAN
  [3, 6], [3, 7], // DAEDALUS → VULCAN, VIGIL
]

// Currently active delegations (subset of connections that are "hot")
const ACTIVE_DELEGATIONS = [
  { from: 0, to: 1, task: 'security scan' },
  { from: 0, to: 3, task: 'deploy v2.4' },
  { from: 3, to: 6, task: 'build image' },
]

export default function ConnectionMatrix() {
  const groupRef = useRef()
  const timeRef = useRef(0)

  // Position agents in a circle
  const positions = useMemo(() => {
    return AGENTS.map((_, i) => {
      if (i === 0) return [0, 0, 0] // QUOX centre
      const angle = ((i - 1) / (AGENTS.length - 1)) * Math.PI * 2 - Math.PI / 2
      const r = 8
      return [Math.cos(angle) * r, 0, Math.sin(angle) * r]
    })
  }, [])

  useFrame((_, delta) => {
    timeRef.current += delta
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.02
    }
  })

  return (
    <group ref={groupRef}>
      {/* Agent nodes */}
      {AGENTS.map((agent, i) => (
        <AgentDot key={agent.id} agent={agent} position={positions[i]} />
      ))}

      {/* Passive connections (all canDelegateTo) */}
      {CONNECTIONS.map(([fi, ti], i) => {
        const isActive = ACTIVE_DELEGATIONS.some(d => d.from === fi && d.to === ti)
        return (
          <ConnectionLine
            key={`conn-${i}`}
            from={positions[fi]}
            to={positions[ti]}
            color={isActive ? PALETTE.delegation : '#ffffff'}
            opacity={isActive ? 0.2 : 0.03}
            active={isActive}
          />
        )
      })}

      {/* Active delegation flow particles */}
      {ACTIVE_DELEGATIONS.map((del, i) => (
        <FlowParticles
          key={`flow-${i}`}
          from={positions[del.from]}
          to={positions[del.to]}
          color={PALETTE.delegation}
          label={del.task}
        />
      ))}

      {/* Connection count labels */}
      {AGENTS.map((agent, i) => {
        const outgoing = CONNECTIONS.filter(([f]) => f === i).length
        const incoming = CONNECTIONS.filter(([, t]) => t === i).length
        const activeOut = ACTIVE_DELEGATIONS.filter(d => d.from === i).length
        return (
          <Billboard key={`stat-${i}`} position={[positions[i][0], -1.2, positions[i][2]]}>
            <Text fontSize={0.12} color="rgba(255,255,255,0.25)" anchorX="center">
              {`↑${outgoing} ↓${incoming}${activeOut > 0 ? ` ●${activeOut}` : ''}`}
            </Text>
          </Billboard>
        )
      })}
    </group>
  )
}

function AgentDot({ agent, position }) {
  const wireRef = useRef()
  const timeRef = useRef(Math.random() * 50)
  const isActive = ACTIVE_DELEGATIONS.some(d =>
    AGENTS[d.from]?.id === agent.id || AGENTS[d.to]?.id === agent.id
  )

  useFrame((_, delta) => {
    timeRef.current += delta
    if (wireRef.current) wireRef.current.rotation.y += delta * 0.15
  })

  const scale = agent.role === 'orchestrator' ? 1.0 : agent.role === 'manager' ? 0.7 : 0.5
  const col = new THREE.Color(agent.color)

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={col} wireframe transparent opacity={isActive ? 0.4 : 0.15} />
      </mesh>
      <mesh scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isActive ? 0.8 : 0.2} transparent opacity={isActive ? 0.8 : 0.4} roughness={0.3} metalness={0.05} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.6, 0]}>
        <circleGeometry args={[scale * 0.9, 12]} />
        <meshBasicMaterial color={col} transparent opacity={isActive ? 0.1 : 0.03} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <Billboard position={[0, scale + 0.4, 0]}>
        <Text fontSize={0.22} color="white" anchorX="center" outlineWidth={0.015} outlineColor="#000" fillOpacity={isActive ? 0.8 : 0.3}>{agent.name}</Text>
      </Billboard>
    </group>
  )
}

function ConnectionLine({ from, to, color, opacity, active }) {
  return (
    <line geometry={new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from),
      new THREE.Vector3(...to),
    ])}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

function FlowParticles({ from, to, color, label }) {
  const pointsRef = useRef()
  const timeRef = useRef(Math.random() * 10)
  const count = 8

  const positions = useMemo(() => new Float32Array(count * 3), [])
  const mid = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 2, (from[2] + to[2]) / 2]

  useFrame((_, delta) => {
    timeRef.current += delta * 0.5
    if (pointsRef.current) {
      const posAttr = pointsRef.current.geometry.attributes.position
      for (let i = 0; i < count; i++) {
        const t = (timeRef.current + i / count) % 1
        // Quadratic bezier
        const u = 1 - t
        posAttr.array[i * 3] = u * u * from[0] + 2 * u * t * mid[0] + t * t * to[0]
        posAttr.array[i * 3 + 1] = u * u * from[1] + 2 * u * t * mid[1] + t * t * to[1]
        posAttr.array[i * 3 + 2] = u * u * from[2] + 2 * u * t * mid[2] + t * t * to[2]
      }
      posAttr.needsUpdate = true
    }
  })

  return (
    <group>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial size={0.08} color={color} transparent opacity={0.7} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
      {/* Label at arc midpoint */}
      <Billboard position={mid}>
        <Text fontSize={0.12} color={color} anchorX="center" fillOpacity={0.4}>{label}</Text>
      </Billboard>
    </group>
  )
}
