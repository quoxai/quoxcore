/**
 * AssignmentBeams — Faint dashed lines connecting running tasks to assigned agents.
 *
 * Neural pathways crossing space — shows which agent is working on which task.
 * Only renders beams for tasks with status='running'.
 * Uses state colours: running=indigo, completed=green, failed=red.
 *
 * Props:
 *   objectives: array of objectives with tasks
 *   agentPositions: Map of agentId -> [x,y,z]
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

// State-based beam colours
const STATE_COLORS = {
  running: PALETTE.indigo,
  completed: '#22c55e',
  failed: '#ef4444',
}

// ─── Arrow particle travelling along beam ──────────────
function BeamArrow({ from, to, color }) {
  const meshRef = useRef()
  const progressRef = useRef(Math.random())

  useFrame((_, delta) => {
    try {
      if (!meshRef.current) return
      progressRef.current += delta * 0.5
      if (progressRef.current > 1) progressRef.current = 0

      const t = progressRef.current
      meshRef.current.position.x = from[0] + (to[0] - from[0]) * t
      meshRef.current.position.y = from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * 3.0
      meshRef.current.position.z = from[2] + (to[2] - from[2]) * t

      // Fade at ends
      const edgeFade = Math.sin(t * Math.PI)
      meshRef.current.material.opacity = edgeFade * 0.9
    } catch { /* ref not ready */ }
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.2, 6, 6]} />
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

// ─── Dashed beam line (curved) ──────────────────────────
function DashedBeamLine({ from, to, color, opacity = 0.15 }) {
  const geometry = useMemo(() => {
    const points = []
    const segments = 30
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      points.push(new THREE.Vector3(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * 3.0,
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

// ─── Mock data detection ────────────────────────────────
const MOCK_IDS = new Set(['obj-1', 'obj-2', 'obj-3'])

function isMockData(objectives) {
  if (objectives.length === 0) return false
  return objectives.every(o => MOCK_IDS.has(o.id))
}

// ─── Main component ─────────────────────────────────────
export default function AssignmentBeams({ objectives = [], agentPositions = {} }) {
  // Collect all running tasks with their approximate positions and agent assignments
  const beams = useMemo(() => {
    // Skip rendering for mock data — beams are meaningless without real assignments
    if (isMockData(objectives)) return []

    const result = []
    const count = objectives.length

    objectives.forEach((obj, objIdx) => {
      // Compute objective cluster position (mirrors ExecutionLayer layout at r=34)
      let objPos
      if (count === 1) objPos = [34, 0, 0]
      else if (count === 2) objPos = objIdx === 0 ? [34, 0, 0] : [-34, 0, 0]
      else {
        const angle = (objIdx / count) * Math.PI * 2
        objPos = [Math.cos(angle) * 34, 0, Math.sin(angle) * 34]
      }

      const tasks = obj.tasks || []
      tasks.forEach((task) => {
        if (!task.agentId) return
        // Only show beams for running, completed, or failed tasks
        if (!['running', 'completed', 'failed'].includes(task.status)) return
        const agentPos = agentPositions[task.agentId]
        if (!agentPos) return

        // Use state-based colour
        const beamColor = STATE_COLORS[task.status] || PALETTE.indigo

        result.push({
          id: `${obj.id}-${task.id}`,
          from: objPos,
          to: agentPos,
          color: beamColor,
          status: task.status,
        })
      })
    })

    return result
  }, [objectives, agentPositions])

  if (beams.length === 0) return null

  return (
    <group>
      {beams.map((beam) => (
        <group key={beam.id}>
          <DashedBeamLine from={beam.from} to={beam.to} color={beam.color} opacity={0.3} />
          <BeamArrow from={beam.from} to={beam.to} color={beam.color} />
        </group>
      ))}
    </group>
  )
}
