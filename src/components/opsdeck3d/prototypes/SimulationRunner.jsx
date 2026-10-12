/**
 * SimulationRunner — Full system simulation showing data flowing through
 * all layers of the Cognitive Core.
 *
 * 30-second loop:
 *   1. User sends query → nucleus receives (particle from edge → centre)
 *   2. Nucleus pulses → implants light up (health check)
 *   3. Agent mesh activates → QUOX delegates to 3 agents
 *   4. Agents execute → tasks orbit in execution layer
 *   5. Tasks complete → knowledge crystallises in memory lattice
 *   6. Result flows back → response particle exits
 *
 * This demonstrates the FULL cognitive pipeline in one component.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const CYCLE = 30 // seconds per full loop
const R_NUCLEUS = 0
const R_IMPLANTS = 5
const R_AGENTS = 10
const R_EXECUTION = 16
const R_MEMORY = 22

// 5 zone labels
const ZONES = [
  { r: R_NUCLEUS, name: 'NUCLEUS', color: PALETTE.indigo },
  { r: R_IMPLANTS, name: 'IMPLANTS', color: PALETTE.violet },
  { r: R_AGENTS, name: 'AGENTS', color: PALETTE.thinking },
  { r: R_EXECUTION, name: 'EXECUTION', color: PALETTE.executing },
  { r: R_MEMORY, name: 'MEMORY', color: '#ec4899' },
]

const AGENT_NAMES = ['WARDEN', 'DAEDALUS', 'CIPHER']
const AGENT_ANGLES = [0, Math.PI * 2 / 3, Math.PI * 4 / 3]

function ZoneRingsViz() {
  return (
    <group>
      {[R_IMPLANTS, R_AGENTS, R_EXECUTION, R_MEMORY].map((r, i) => {
        const points = []
        for (let j = 0; j <= 64; j++) {
          const a = (j / 64) * Math.PI * 2
          points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))
        }
        return (
          <line key={i} geometry={new THREE.BufferGeometry().setFromPoints(points)}>
            <lineBasicMaterial color={ZONES[i + 1]?.color || '#fff'} transparent opacity={0.06} />
          </line>
        )
      })}
      {ZONES.map((z, i) => (
        <Billboard key={i} position={[0, 0.6, z.r || 0.5]}>
          <Text fontSize={0.25} color={z.color} anchorX="center" fillOpacity={0.2} outlineWidth={0.015} outlineColor="#000">
            {z.name}
          </Text>
        </Billboard>
      ))}
    </group>
  )
}

function NucleusViz({ phase }) {
  const ref = useRef()
  const ringRef = useRef()
  const timeRef = useRef(0)
  const isReceiving = phase === 'receive'
  const isPulsing = phase === 'pulse'

  useFrame((_, delta) => {
    timeRef.current += delta
    if (ref.current) {
      const base = isPulsing ? 1.15 : isReceiving ? 1.05 : 1.0
      const breathe = base + Math.sin(timeRef.current * (isPulsing ? 3 : 0.8)) * 0.03
      ref.current.scale.setScalar(breathe)
    }
    if (ringRef.current) ringRef.current.rotation.z += delta * 0.4
  })

  const col = isPulsing ? '#fff' : isReceiving ? PALETTE.cyan : PALETTE.indigo

  return (
    <group>
      <mesh ref={ref}>
        <sphereGeometry args={[1.5, 16, 16]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isPulsing ? 1.2 : 0.5} transparent opacity={0.3} />
      </mesh>
      <mesh ref={ref} scale={0.8}>
        <sphereGeometry args={[1.5, 16, 16]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isPulsing ? 0.8 : 0.4} transparent opacity={0.5} />
      </mesh>
      <group ref={ringRef}>
        <mesh><torusGeometry args={[2.5, 0.02, 8, 48]} /><meshBasicMaterial color={col} transparent opacity={0.3} /></mesh>
      </group>
    </group>
  )
}

function AgentNodeViz({ angle, name, active }) {
  const ref = useRef()
  const wireRef = useRef()
  const timeRef = useRef(Math.random() * 50)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (wireRef.current) wireRef.current.rotation.y += delta * (active ? 0.4 : 0.1)
    if (ref.current) ref.current.position.y = Math.sin(timeRef.current * 0.6) * 0.1
  })

  const pos = [Math.cos(angle) * R_AGENTS, 0, Math.sin(angle) * R_AGENTS]
  const col = active ? PALETTE.executing : PALETTE.idle

  return (
    <group ref={ref} position={pos}>
      <mesh ref={wireRef} scale={NODE_SCALES.specialist}>
        <octahedronGeometry args={[1, 0]} /><meshBasicMaterial color={col} wireframe transparent opacity={active ? 0.4 : 0.15} />
      </mesh>
      <mesh scale={NODE_SCALES.specialist * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={col} emissive={col} emissiveIntensity={active ? 0.8 : 0.15} transparent opacity={active ? 0.8 : 0.4} roughness={0.3} metalness={0.05} />
      </mesh>
      <Billboard position={[0, 1, 0]}>
        <Text fontSize={0.22} color="white" anchorX="center" outlineWidth={0.015} outlineColor="#000" fillOpacity={active ? 0.8 : 0.3}>{name}</Text>
      </Billboard>
      {active && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
          <circleGeometry args={[0.8, 12]} />
          <meshBasicMaterial color={col} transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  )
}

function TravelParticle({ from, to, progress, color, size = 0.12 }) {
  if (progress < 0 || progress > 1) return null
  const x = from[0] + (to[0] - from[0]) * progress
  const y = from[1] + (to[1] - from[1]) * progress + Math.sin(progress * Math.PI) * 1.5
  const z = from[2] + (to[2] - from[2]) * progress

  return (
    <mesh position={[x, y, z]} scale={size}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} transparent opacity={0.8} />
    </mesh>
  )
}

function ExpandingRipple({ progress, color, maxR }) {
  if (progress < 0 || progress > 1) return null
  const r = progress * maxR
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} scale={[r, r, r]}>
      <torusGeometry args={[1, 0.02, 8, 48]} />
      <meshBasicMaterial color={color} transparent opacity={(1 - progress) * 0.15} depthWrite={false} blending={THREE.AdditiveBlending} />
    </mesh>
  )
}

function PhaseLabel({ text, color }) {
  return (
    <Billboard position={[0, 6, 0]}>
      <Text fontSize={0.4} color={color} anchorX="center" fillOpacity={0.6} outlineWidth={0.025} outlineColor="#000" fontWeight={700}>
        {text}
      </Text>
    </Billboard>
  )
}

export default function SimulationRunner() {
  const timeRef = useRef(0)
  const [t, setT] = useState(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    setT(timeRef.current % CYCLE)
  })

  // Phase determination
  const phase =
    t < 3 ? 'idle' :
    t < 5 ? 'receive' :       // Query arrives at nucleus
    t < 7 ? 'pulse' :         // Nucleus broadcasts
    t < 10 ? 'delegate' :     // QUOX → agents
    t < 18 ? 'execute' :      // Tasks running
    t < 22 ? 'crystallise' :  // Memory forming
    t < 25 ? 'respond' :      // Response exits
    'idle'

  const phaseLabels = {
    idle: ['Cognitive Core — Idle', PALETTE.idle],
    receive: ['Query Received', PALETTE.cyan],
    pulse: ['Processing — Implant Check', PALETTE.violet],
    delegate: ['Delegating to Agents', PALETTE.indigo],
    execute: ['Tasks Executing', PALETTE.executing],
    crystallise: ['Knowledge Forming', '#ec4899'],
    respond: ['Response Ready', PALETTE.executing],
  }

  const agentsActive = phase === 'delegate' || phase === 'execute'

  // Inbound query particle (r=25 → nucleus)
  const inboundProgress = phase === 'receive' ? (t - 3) / 2 : -1

  // Delegation arcs (nucleus → agents)
  const delegateProgress = phase === 'delegate' ? (t - 7) / 3 : -1

  // Outbound crystal (execution → memory)
  const crystalProgress = phase === 'crystallise' ? (t - 18) / 4 : -1

  // Response particle (nucleus → edge)
  const responseProgress = phase === 'respond' ? (t - 22) / 3 : -1

  // Ripple on pulse
  const rippleProgress = phase === 'pulse' ? (t - 5) / 2 : -1

  return (
    <group>
      <ZoneRingsViz />

      {/* Phase label */}
      <PhaseLabel text={phaseLabels[phase]?.[0] || ''} color={phaseLabels[phase]?.[1] || '#fff'} />

      {/* Nucleus */}
      <NucleusViz phase={phase} />

      {/* Agents */}
      {AGENT_NAMES.map((name, i) => (
        <AgentNodeViz key={name} angle={AGENT_ANGLES[i]} name={name} active={agentsActive} />
      ))}

      {/* Execution ring markers (visible during execute phase) */}
      {phase === 'execute' && [0, 1, 2, 3, 4].map(i => {
        const a = (i / 5) * Math.PI * 2 + t * 0.3
        return (
          <mesh key={i} position={[Math.cos(a) * R_EXECUTION, Math.sin(a * 0.7) * 0.5, Math.sin(a) * R_EXECUTION]} scale={0.2}>
            <octahedronGeometry args={[1, 0]} />
            <meshStandardMaterial color={i < 3 ? PALETTE.executing : PALETTE.thinking} emissive={i < 3 ? PALETTE.executing : PALETTE.thinking} emissiveIntensity={0.7} transparent opacity={0.7} />
          </mesh>
        )
      })}

      {/* Ripple */}
      <ExpandingRipple progress={rippleProgress} color={PALETTE.violet} maxR={R_AGENTS + 2} />

      {/* Inbound query particle */}
      <TravelParticle from={[0, 2, 25]} to={[0, 0, 0]} progress={inboundProgress} color={PALETTE.cyan} size={0.15} />

      {/* Delegation particles to each agent */}
      {AGENT_NAMES.map((_, i) => (
        <TravelParticle
          key={`del-${i}`}
          from={[0, 0, 0]}
          to={[Math.cos(AGENT_ANGLES[i]) * R_AGENTS, 0, Math.sin(AGENT_ANGLES[i]) * R_AGENTS]}
          progress={delegateProgress > 0 ? Math.max(0, delegateProgress - i * 0.15) : -1}
          color={PALETTE.indigo}
          size={0.1}
        />
      ))}

      {/* Crystal forming — particle from execution to memory */}
      <TravelParticle from={[R_EXECUTION, 0, 0]} to={[R_MEMORY, 0, 0]} progress={crystalProgress} color="#ec4899" size={0.12} />

      {/* Response particle — nucleus outward */}
      <TravelParticle from={[0, 0, 0]} to={[0, 2, -25]} progress={responseProgress} color={PALETTE.executing} size={0.15} />

      {/* Timeline bar at bottom */}
      <Billboard position={[0, -3, 0]}>
        <Text fontSize={0.18} color="rgba(255,255,255,0.3)" anchorX="center" fillOpacity={0.4}>
          {`${Math.floor(t)}s / ${CYCLE}s — ${phase.toUpperCase()}`}
        </Text>
      </Billboard>
    </group>
  )
}
