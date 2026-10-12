/**
 * TaskLifecycle — Full task lifecycle demo in a single objective cluster.
 *
 * Central objective octahedron with progress ring, 6 orbiting tasks.
 * Auto-plays a 20s lifecycle demonstrating materialise, start, complete,
 * fail (fragment), final shockwave, and reset.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const TASK_NAMES = ['Build image', 'Run tests', 'Lint check', 'Deploy staging', 'Health check', 'Notify team']

// Timeline events: [time, taskIndex, action]
const TIMELINE = [
  // T+3: task 1 starts
  [3, 0, 'start'],
  // T+5: task 1 completes
  [5, 0, 'complete'],
  // T+6: tasks 2+3 start
  [6, 1, 'start'],
  [6, 2, 'start'],
  // T+9: task 2 completes, task 3 fails
  [9, 1, 'complete'],
  [9, 2, 'fail'],
  // T+11: tasks 4+5+6 start
  [11, 3, 'start'],
  [11, 4, 'start'],
  [11, 5, 'start'],
  // T+16: all complete
  [16, 3, 'complete'],
  [16, 4, 'complete'],
  [16, 5, 'complete'],
]

function FragmentParticles({ position, color }) {
  const ref = useRef()
  const velocities = useMemo(() =>
    Array.from({ length: 4 }, () => [
      (Math.random() - 0.5) * 3,
      Math.random() * 2 + 1,
      (Math.random() - 0.5) * 3,
    ]),
  [])
  const lifetimeRef = useRef(0)

  const positions = useMemo(() => new Float32Array(4 * 3), [])

  useFrame((_, delta) => {
    lifetimeRef.current += delta
    if (!ref.current || lifetimeRef.current > 2) return
    const posAttr = ref.current.geometry.attributes.position
    for (let i = 0; i < 4; i++) {
      posAttr.array[i * 3] = position[0] + velocities[i][0] * lifetimeRef.current
      posAttr.array[i * 3 + 1] = position[1] + velocities[i][1] * lifetimeRef.current - 2 * lifetimeRef.current * lifetimeRef.current
      posAttr.array[i * 3 + 2] = position[2] + velocities[i][2] * lifetimeRef.current
    }
    posAttr.needsUpdate = true
    ref.current.material.opacity = Math.max(0, 1 - lifetimeRef.current / 2) * 0.8
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={4} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        size={0.2}
        color={color}
        transparent
        opacity={0.8}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

function ShockwaveRing({ active }) {
  const meshRef = useRef()
  const progressRef = useRef(0)

  useFrame((_, delta) => {
    if (!active || !meshRef.current) return
    progressRef.current += delta / 2
    if (progressRef.current > 1) {
      progressRef.current = 0
      return
    }
    const r = progressRef.current * 15
    meshRef.current.scale.set(r, r, r)
    meshRef.current.material.opacity = (1 - progressRef.current) * 0.4
  })

  if (!active) return null
  return (
    <mesh ref={meshRef} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1, 0.03, 8, 64]} />
      <meshBasicMaterial
        color={PALETTE.done}
        transparent
        opacity={0.4}
        side={THREE.DoubleSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

export default function TaskLifecycle() {
  const timeRef = useRef(0)
  const cycleTime = useRef(0)
  const objectiveRef = useRef()
  const objectiveWireRef = useRef()

  const [taskStates, setTaskStates] = useState(Array(6).fill('hidden'))
  const [objectiveVisible, setObjectiveVisible] = useState(false)
  const [objectiveScale, setObjectiveScale] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)
  const [fragments, setFragments] = useState([])
  const [shockwave, setShockwave] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const lastEventIndex = useRef(-1)

  const taskOrbitPositions = useMemo(() => {
    return TASK_NAMES.map((_, i) => {
      const angle = (i / TASK_NAMES.length) * Math.PI * 2
      const r = 3.5
      return [Math.cos(angle) * r, 0, Math.sin(angle) * r]
    })
  }, [])

  // Reset everything
  const reset = () => {
    setTaskStates(Array(6).fill('hidden'))
    setObjectiveVisible(false)
    setObjectiveScale(0)
    setCompletedCount(0)
    setFragments([])
    setShockwave(false)
    setAllDone(false)
    lastEventIndex.current = -1
    cycleTime.current = 0
  }

  useFrame((_, delta) => {
    timeRef.current += delta
    cycleTime.current += delta
    const t = cycleTime.current

    // T+0: Objective materialises
    if (t >= 0 && !objectiveVisible) {
      setObjectiveVisible(true)
    }

    // Scale up objective 0->1 over 1s
    if (objectiveVisible && objectiveScale < 1) {
      setObjectiveScale(s => Math.min(1, s + delta))
    }

    // T+1-2: Tasks pop in (100ms stagger)
    if (t >= 1 && t < 2) {
      const taskIdx = Math.floor((t - 1) * 10) // 0-5 over 0.6s
      if (taskIdx < 6) {
        setTaskStates(prev => {
          const next = [...prev]
          for (let i = 0; i <= Math.min(taskIdx, 5); i++) {
            if (next[i] === 'hidden') next[i] = 'idle'
          }
          return next
        })
      }
    }

    // Process timeline events
    TIMELINE.forEach((evt, evtIdx) => {
      if (evtIdx <= lastEventIndex.current) return
      if (t >= evt[0]) {
        lastEventIndex.current = evtIdx
        const [, taskIdx, action] = evt
        setTaskStates(prev => {
          const next = [...prev]
          if (action === 'start') next[taskIdx] = 'active'
          else if (action === 'complete') {
            next[taskIdx] = 'complete'
            setCompletedCount(c => c + 1)
          } else if (action === 'fail') {
            next[taskIdx] = 'failed'
            setFragments(f => [...f, { pos: taskOrbitPositions[taskIdx], key: Date.now() }])
          }
          return next
        })
      }
    })

    // T+17: Objective complete — shockwave
    if (t >= 17 && !allDone) {
      setAllDone(true)
      setShockwave(true)
    }

    // T+20: Reset
    if (t >= 20) {
      reset()
    }

    // Animate objective
    if (objectiveRef.current) {
      objectiveRef.current.rotation.y -= delta * 0.06
      const s = objectiveScale * NODE_SCALES.objective * (allDone ? 1.3 : 1)
      objectiveRef.current.scale.setScalar(s * 0.65)
    }
    if (objectiveWireRef.current) {
      objectiveWireRef.current.rotation.y += delta * 0.1
      objectiveWireRef.current.rotation.x += delta * 0.03
      const s = objectiveScale * NODE_SCALES.objective * (allDone ? 1.3 : 1)
      objectiveWireRef.current.scale.setScalar(s)
    }
  })

  const progress = completedCount / 6

  return (
    <group>
      {/* Objective node */}
      {objectiveVisible && (
        <group>
          <mesh ref={objectiveWireRef} scale={NODE_SCALES.objective}>
            <octahedronGeometry args={[1, 0]} />
            <meshBasicMaterial
              color={allDone ? PALETTE.done : PALETTE.indigo}
              wireframe
              transparent
              opacity={0.3}
            />
          </mesh>
          <mesh ref={objectiveRef} scale={NODE_SCALES.objective * 0.65}>
            <octahedronGeometry args={[1, 0]} />
            <meshStandardMaterial
              color={allDone ? PALETTE.done : PALETTE.indigo}
              emissive={allDone ? PALETTE.done : PALETTE.indigo}
              emissiveIntensity={allDone ? 1.2 : 0.8}
              transparent
              opacity={0.8}
              roughness={0.2}
            />
          </mesh>

          {/* Ground disc */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -NODE_SCALES.objective * 0.8, 0]}>
            <circleGeometry args={[NODE_SCALES.objective * 1.2, 24]} />
            <meshBasicMaterial
              color={PALETTE.indigo}
              transparent
              opacity={0.1}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* Progress ring track */}
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <torusGeometry args={[NODE_SCALES.objective * 1.6, 0.03, 8, 128]} />
            <meshBasicMaterial
              color={PALETTE.indigo}
              transparent
              opacity={0.06}
              depthWrite={false}
            />
          </mesh>

          {/* Progress ring fill (simple arc approximation) */}
          {progress > 0 && (() => {
            const segments = Math.max(4, Math.floor(128 * progress))
            const points = []
            for (let i = 0; i <= segments; i++) {
              const a = (i / 128) * Math.PI * 2
              const r = NODE_SCALES.objective * 1.6
              points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))
            }
            return (
              <line geometry={new THREE.BufferGeometry().setFromPoints(points)} rotation={[-Math.PI / 2, 0, 0]}>
                <lineBasicMaterial
                  color={allDone ? PALETTE.done : PALETTE.indigo}
                  transparent
                  opacity={0.6}
                />
              </line>
            )
          })()}

          <Billboard position={[0, NODE_SCALES.objective * 2, 0]}>
            <Text fontSize={0.35} color="white" anchorX="center" outlineWidth={0.03} outlineColor="#000" fillOpacity={0.85}>
              Deploy v2.4
            </Text>
            <Text
              fontSize={0.2}
              color={allDone ? PALETTE.done : PALETTE.indigo}
              anchorX="center"
              position={[0, -0.35, 0]}
              fillOpacity={0.6}
            >
              {allDone ? 'COMPLETE' : `${completedCount}/6 tasks`}
            </Text>
          </Billboard>
        </group>
      )}

      {/* Orbit track */}
      {objectiveVisible && (() => {
        const pts = []
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2
          pts.push(new THREE.Vector3(Math.cos(a) * 3.5, 0, Math.sin(a) * 3.5))
        }
        return (
          <line geometry={new THREE.BufferGeometry().setFromPoints(pts)}>
            <lineBasicMaterial color={PALETTE.indigo} transparent opacity={0.06} />
          </line>
        )
      })()}

      {/* Task nodes */}
      {TASK_NAMES.map((name, i) => {
        const state = taskStates[i]
        if (state === 'hidden') return null
        if (state === 'failed') return null // fragments replace it

        const pos = taskOrbitPositions[i]
        const isComplete = state === 'complete'
        const isActive = state === 'active'
        const color = isComplete ? PALETTE.done : isActive ? PALETTE.executing : PALETTE.idle
        const driftPos = isComplete ? [pos[0] * 1.4, pos[1] + 1, pos[2] * 1.4] : pos
        const scale = NODE_SCALES.task

        return (
          <group key={i} position={driftPos}>
            <mesh scale={scale}>
              <octahedronGeometry args={[1, 0]} />
              <meshBasicMaterial color={color} wireframe transparent opacity={isComplete ? 0.15 : 0.3} />
            </mesh>
            <mesh scale={scale * 0.65}>
              <octahedronGeometry args={[1, 0]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={isActive ? 0.9 : isComplete ? 0.3 : 0.4}
                transparent
                opacity={isComplete ? 0.3 : 0.7}
                roughness={0.2}
              />
            </mesh>
            <Billboard position={[0, scale * 1.2, 0]}>
              <Text fontSize={0.14} color={color} anchorX="center" fillOpacity={isComplete ? 0.3 : 0.6}>
                {name}
              </Text>
            </Billboard>
          </group>
        )
      })}

      {/* Fragment particles for failed tasks */}
      {fragments.map(f => (
        <FragmentParticles key={f.key} position={f.pos} color={PALETTE.blocked} />
      ))}

      {/* Shockwave */}
      <ShockwaveRing active={shockwave} />
    </group>
  )
}
