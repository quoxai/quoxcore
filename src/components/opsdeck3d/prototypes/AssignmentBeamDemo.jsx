/**
 * AssignmentBeamDemo — Task-to-agent assignment beams crossing space.
 *
 * 3 agents on the left, 1 objective with 5 orbiting tasks on the right.
 * Dashed beams connect assigned tasks to agents. Arrow particles travel
 * beams. Tasks complete and dissolve periodically.
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES, STATE_VISUALS } from '../lib/design-system'

const AGENTS = [
  { id: 'sentinel', name: 'WARDEN', color: PALETTE.executing, y: 4 },
  { id: 'cipher', name: 'CIPHER', color: PALETTE.thinking, y: 0 },
  { id: 'atlas', name: 'HYPERION', color: PALETTE.reading, y: -4 },
]

const TASK_LABELS = ['port scan', 'auth audit', 'log parse', 'cert check', 'dns verify']
const ASSIGNMENTS = [
  { taskIdx: 0, agentIdx: 0 },
  { taskIdx: 1, agentIdx: 1 },
  { taskIdx: 2, agentIdx: 2 },
]

function OctNode({ position, scale, color, wireOpacity = 0.3, coreOpacity = 0.7, glow = 0.7 }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(Math.random() * 100)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (wireRef.current) {
      wireRef.current.rotation.y += delta * 0.12
      wireRef.current.rotation.x += delta * 0.04
    }
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.08
    }
  })

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={wireOpacity} />
      </mesh>
      <mesh ref={innerRef} scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={glow}
          transparent
          opacity={coreOpacity}
          roughness={0.2}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.8, 0]}>
        <circleGeometry args={[scale * 1.0, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

function BeamParticle({ from, to, color, active }) {
  const meshRef = useRef()
  const progressRef = useRef(Math.random())

  useFrame((_, delta) => {
    if (!meshRef.current || !active) return
    progressRef.current += delta * 0.4
    if (progressRef.current > 1) progressRef.current = 0

    const t = progressRef.current
    meshRef.current.position.x = from[0] + (to[0] - from[0]) * t
    meshRef.current.position.y = from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * 1.5
    meshRef.current.position.z = from[2] + (to[2] - from[2]) * t
  })

  if (!active) return null

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.1, 8, 8]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.9}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

function DashedBeam({ from, to, color, opacity = 0.12 }) {
  const geometry = useMemo(() => {
    const points = []
    const segments = 40
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      points.push(new THREE.Vector3(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * 1.5,
        from[2] + (to[2] - from[2]) * t,
      ))
    }
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [from, to])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

export default function AssignmentBeamDemo() {
  const timeRef = useRef(0)
  const [completedTasks, setCompletedTasks] = useState(new Set())
  const lastCompleteRef = useRef(0)

  // Task positions (orbiting around objective at x=8)
  const taskPositions = useMemo(() => {
    return TASK_LABELS.map((_, i) => {
      const angle = (i / TASK_LABELS.length) * Math.PI * 2
      const r = 3
      return [8 + Math.cos(angle) * r, Math.sin(angle) * r * 0.4, Math.sin(angle) * r]
    })
  }, [])

  useFrame((_, delta) => {
    timeRef.current += delta

    // Every 5s, complete a random non-completed assigned task
    if (timeRef.current - lastCompleteRef.current > 5) {
      lastCompleteRef.current = timeRef.current
      const available = ASSIGNMENTS
        .map(a => a.taskIdx)
        .filter(idx => !completedTasks.has(idx))
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)]
        setCompletedTasks(prev => new Set([...prev, pick]))
      } else {
        // Reset after all done
        setCompletedTasks(new Set())
      }
    }
  })

  return (
    <group>
      {/* Agents on the left */}
      {AGENTS.map((agent, i) => (
        <group key={agent.id}>
          <OctNode
            position={[-8, agent.y, 0]}
            scale={NODE_SCALES.specialist}
            color={agent.color}
          />
          <Billboard position={[-8, agent.y + 1.2, 0]}>
            <Text fontSize={0.28} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.8}>
              {agent.name}
            </Text>
          </Billboard>
        </group>
      ))}

      {/* Objective on the right */}
      <OctNode position={[8, 0, 0]} scale={NODE_SCALES.objective} color={PALETTE.indigo} glow={0.9} />
      <Billboard position={[8, 2.2, 0]}>
        <Text fontSize={0.3} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.7}>
          SECURITY SCAN
        </Text>
      </Billboard>

      {/* Task nodes orbiting */}
      {TASK_LABELS.map((label, i) => {
        const completed = completedTasks.has(i)
        const pos = taskPositions[i]
        // Completed tasks drift outward
        const driftPos = completed
          ? [pos[0] + 1.5, pos[1] + 1, pos[2]]
          : pos
        return (
          <group key={i}>
            <OctNode
              position={driftPos}
              scale={NODE_SCALES.task}
              color={completed ? PALETTE.done : PALETTE.indigo}
              wireOpacity={completed ? 0.1 : 0.3}
              coreOpacity={completed ? 0.2 : 0.7}
              glow={completed ? 0.2 : 0.6}
            />
            <Billboard position={[driftPos[0], driftPos[1] + 0.6, driftPos[2]]}>
              <Text fontSize={0.16} color={completed ? PALETTE.done : 'white'} anchorX="center" fillOpacity={completed ? 0.3 : 0.6}>
                {label}
              </Text>
            </Billboard>
          </group>
        )
      })}

      {/* Assignment beams + particles */}
      {ASSIGNMENTS.map(({ taskIdx, agentIdx }) => {
        if (completedTasks.has(taskIdx)) return null
        const from = taskPositions[taskIdx]
        const to = [-8, AGENTS[agentIdx].y, 0]
        return (
          <group key={`beam-${taskIdx}-${agentIdx}`}>
            <DashedBeam from={from} to={to} color={AGENTS[agentIdx].color} />
            <BeamParticle from={from} to={to} color={AGENTS[agentIdx].color} active />
          </group>
        )
      })}

      {/* Orbit track around objective */}
      {(() => {
        const pts = []
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2
          pts.push(new THREE.Vector3(8 + Math.cos(a) * 3, Math.sin(a) * 1.2, Math.sin(a) * 3))
        }
        return (
          <line geometry={new THREE.BufferGeometry().setFromPoints(pts)}>
            <lineBasicMaterial color={PALETTE.indigo} transparent opacity={0.06} />
          </line>
        )
      })()}
    </group>
  )
}
