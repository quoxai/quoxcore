/**
 * ObjectiveCluster — A single objective with orbiting task nodes.
 *
 * Structure:
 *  - Objective core: 3-layer octahedron (NODE_SCALES.objective = 1.6)
 *  - Progress ring: partial torus arc showing completion %
 *  - Task orbit paths: visible faint rings (TaskOrbitPath)
 *  - Task nodes: small octahedrons orbiting on elliptical paths
 *  - Billboard labels: objective title + progress subtitle
 *  - Hover tooltip on objective core
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'
import { NODE_SCALES, PALETTE } from '../lib/design-system'
import { TaskOrbitPath } from './ZoneRings'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"

// Task status colours
const TASK_COLORS = {
  completed: PALETTE.executing,   // #22c55e
  running: PALETTE.indigo,        // #6366f1
  pending: 'rgba(255,255,255,0.25)',
  failed: PALETTE.blocked,        // #ef4444
}

const TASK_OPACITIES = {
  completed: 0.7,
  running: 0.85,
  pending: 0.25,
  failed: 0.2,
}

// ─── TaskOrbitNode ─────────────────────────────────────────
function TaskOrbitNode({ task, orbitRadius, orbitTilt, orbitOffset, objectivePosition, settings, onSelect }) {
  const groupRef = useRef()
  const innerRef = useRef()
  const wireRef = useRef()
  const timeRef = useRef(orbitOffset * 100) // seed unique phase
  const [hovered, setHovered] = useState(false)
  const driftRef = useRef(0) // for completed tasks drifting outward
  const flashRef = useRef(0) // flash timer

  const scale = NODE_SCALES.task // 0.35
  const wireOpacity = settings.nodeWireOpacity ?? 0.3
  const innerScale = settings.nodeInnerScale ?? 0.65
  const groundGlow = settings.nodeGroundGlow ?? 0.12
  const taskOrbitSpeed = settings.taskOrbitSpeed ?? 0.5
  const taskGlow = settings.taskGlow ?? 0.6

  const statusColor = useMemo(() => {
    const c = TASK_COLORS[task.status] || TASK_COLORS.pending
    return new THREE.Color(c)
  }, [task.status])

  const opacity = TASK_OPACITIES[task.status] || 0.25

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      // Orbit speed by status
      let speed = 0
      if (task.status === 'running') speed = taskOrbitSpeed * 1.5
      else if (task.status === 'pending') speed = taskOrbitSpeed * 0.2
      else if (task.status === 'completed') speed = 0
      else if (task.status === 'failed') speed = 0

      // Completed tasks drift outward
      if (task.status === 'completed') {
        driftRef.current += delta * 0.05
      }

      const angle = t * speed + orbitOffset * Math.PI * 2
      const drift = driftRef.current
      const r = orbitRadius + drift

      if (groupRef.current) {
        groupRef.current.position.x = Math.cos(angle) * r
        groupRef.current.position.y = Math.sin(angle) * r * Math.sin(orbitTilt)
        groupRef.current.position.z = Math.sin(angle) * r * Math.cos(orbitTilt)
      }

      // Slow rotation on wireframe
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.2
        wireRef.current.rotation.x += delta * 0.06
      }
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.12
      }

      // Flash fade (green or red flash on status change)
      if (flashRef.current > 0) {
        flashRef.current = Math.max(0, flashRef.current - delta)
      }
    } catch { /* ref not ready */ }
  })

  // Completed tasks fade over 8 seconds
  const fadeOpacity = task.status === 'completed'
    ? Math.max(0.15, opacity - driftRef.current * 0.08)
    : opacity

  const hoverScale = hovered ? 1.15 : 1

  return (
    <group ref={groupRef}>
      {/* Outer wireframe */}
      <mesh ref={wireRef} scale={scale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={statusColor}
          wireframe
          transparent
          opacity={wireOpacity * fadeOpacity * (hovered ? 1.5 : 1)}
        />
      </mesh>

      {/* Inner solid core */}
      <mesh ref={innerRef} scale={scale * innerScale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={statusColor}
          emissive={statusColor}
          emissiveIntensity={taskGlow * fadeOpacity * (hovered ? 1.4 : 1)}
          transparent
          opacity={fadeOpacity}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.6, 0]}>
        <circleGeometry args={[scale * 0.8, 12]} />
        <meshBasicMaterial
          color={statusColor}
          transparent
          opacity={groundGlow * fadeOpacity * 0.6}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Label — only visible when camera is reasonably close */}
      <Billboard position={[0, scale * 1.1, 0]}>
        <Text
          fontSize={0.18}
          color="white"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.015}
          outlineColor="#000000"
          fillOpacity={hovered ? 0.9 : 0.35}
          maxWidth={3}
        >
          {task.title?.slice(0, 15) || 'Task'}
        </Text>
      </Billboard>

      {/* Hover tooltip */}
      {hovered && (
        <Html
          position={[scale * 1.2, 0.3, 0]}
          style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          zIndexRange={[20, 0]}
        >
          <div style={{
            background: 'rgba(5,5,16,0.94)',
            border: `1px solid ${TASK_COLORS[task.status] || '#555'}40`,
            borderRadius: 6,
            padding: '6px 10px',
            fontFamily: FONT_STACK,
            fontSize: 10,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            minWidth: 120,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 3, color: TASK_COLORS[task.status] || '#fff' }}>
              {task.title || 'Task'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: TASK_COLORS[task.status] || '#555',
                boxShadow: `0 0 6px ${TASK_COLORS[task.status] || '#555'}`,
              }} />
              <span style={{ color: TASK_COLORS[task.status] || '#555', fontWeight: 600, textTransform: 'capitalize' }}>
                {task.status}
              </span>
            </div>
            {task.agentId && (
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 8, marginTop: 2 }}>
                Agent: {task.agentId}
              </div>
            )}
          </div>
        </Html>
      )}

      {/* Hitbox */}
      <mesh
        scale={scale * 2}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={(e) => {
          e.stopPropagation()
          const wp = groupRef.current?.getWorldPosition?.(new THREE.Vector3())
          onSelect?.({ type: 'task', ...task, position: wp ? wp.toArray() : undefined })
        }}
        visible={false}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

// ─── ProgressRing — partial torus arc ─────────────────────
function ProgressRing({ progress, radius, color }) {
  const ref = useRef()

  // Partial torus using arc
  const geometry = useMemo(() => {
    const arc = Math.max(0.01, progress) * Math.PI * 2
    return new THREE.TorusGeometry(radius, 0.025, 8, 64, arc)
  }, [progress, radius])

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} geometry={geometry}>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.4}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

// ─── WARD Receipt Badge ─────────────────────────────────────
function WardBadge({ scale }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const wardColor = useMemo(() => new THREE.Color('#14b8a6'), [])
  const badgeScale = 0.2

  useFrame((_, delta) => {
    try {
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.2
        wireRef.current.rotation.x += delta * 0.07
      }
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.15
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group position={[0, scale * 1.2, 0]}>
      {/* Outer wireframe */}
      <mesh ref={wireRef} scale={badgeScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={wardColor}
          wireframe
          transparent
          opacity={0.35}
        />
      </mesh>

      {/* Inner solid core */}
      <mesh ref={innerRef} scale={badgeScale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={wardColor}
          emissive={wardColor}
          emissiveIntensity={0.5}
          transparent
          opacity={0.75}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -badgeScale * 0.5, 0]}>
        <circleGeometry args={[badgeScale * 0.6, 8]} />
        <meshBasicMaterial
          color={wardColor}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Label */}
      <Billboard position={[0, badgeScale * 0.9, 0]}>
        <Text
          fontSize={0.12}
          color="#14b8a6"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.01}
          outlineColor="#000000"
          fillOpacity={0.6}
        >
          {'WARD \u2713'}
        </Text>
      </Billboard>
    </group>
  )
}

// ─── ObjectiveCluster ────────────────────────────────────
export default function ObjectiveCluster({ objective, position = [0, 0, 0], settings = {}, onSelect }) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const [hovered, setHovered] = useState(false)

  const scale = NODE_SCALES.objective // 1.6
  const wireOpacity = settings.nodeWireOpacity ?? 0.3
  const innerScale = settings.nodeInnerScale ?? 0.65
  const groundGlow = settings.nodeGroundGlow ?? 0.12

  const accentColor = useMemo(() => new THREE.Color(objective.accentColor || PALETTE.indigo), [objective.accentColor])

  const tasks = objective.tasks || []
  const completedCount = tasks.filter(t => t.status === 'completed').length
  const totalCount = tasks.length
  const progress = totalCount > 0 ? completedCount / totalCount : 0

  // Task orbit layout: distribute tasks evenly around core
  const taskLayouts = useMemo(() => {
    return tasks.map((task, i) => {
      const baseRadius = 2.5 + (i % 3) * 0.8 // stagger orbit radii
      const tilt = 0.15 + (i * 0.12) // slight tilt variation
      const offset = i / Math.max(tasks.length, 1)
      return { task, orbitRadius: baseRadius, orbitTilt: tilt, orbitOffset: offset }
    })
  }, [tasks])

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      // Gentle float
      if (groupRef.current) {
        groupRef.current.position.y = position[1] + Math.sin(t * 0.4) * 0.1
      }

      // Outer wireframe rotation
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.08
        wireRef.current.rotation.x += delta * 0.03
      }

      // Inner counter-rotate
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.06
      }
    } catch { /* ref not ready */ }
  })

  const hoverScale = hovered ? 1.08 : 1
  const progressRingRadius = scale * 1.8

  const titleTruncated = (objective.title || 'Objective').slice(0, 25)
  const subtitle = `${completedCount}/${totalCount} tasks`

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'objective',
      id: objective.id,
      name: objective.title,
      role: 'objective',
      state: objective.status,
      color: objective.accentColor || PALETTE.indigo,
      description: `${subtitle} \u2014 ${objective.status}`,
      tools: [],
      capabilities: [],
      position,
    })
  }, [objective, position, onSelect, subtitle])

  return (
    <group ref={groupRef} position={position}>
      {/* === OBJECTIVE CORE: Outer wireframe === */}
      <mesh ref={wireRef} scale={scale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={accentColor}
          wireframe
          transparent
          opacity={wireOpacity * (hovered ? 1.5 : 1)}
        />
      </mesh>

      {/* === OBJECTIVE CORE: Inner solid === */}
      <mesh ref={innerRef} scale={scale * innerScale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={accentColor}
          emissive={accentColor}
          emissiveIntensity={0.7 * (hovered ? 1.4 : 1)}
          transparent
          opacity={0.8}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* === GROUND GLOW DISC === */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.8, 0]}>
        <circleGeometry args={[scale * 1.5, 16]} />
        <meshBasicMaterial
          color={accentColor}
          transparent
          opacity={groundGlow * 1.2}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* === PROGRESS RING — partial arc showing completion === */}
      <ProgressRing
        progress={progress}
        radius={progressRingRadius}
        color={objective.accentColor || PALETTE.executing}
      />
      {/* Background ring (full circle, very faint) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[progressRingRadius, 0.015, 8, 64]} />
        <meshBasicMaterial
          color={accentColor}
          transparent
          opacity={0.06}
          depthWrite={false}
        />
      </mesh>

      {/* === TASK ORBIT PATHS (visible tracks) === */}
      {taskLayouts.map(({ orbitRadius, orbitTilt }, i) => (
        <TaskOrbitPath
          key={`orbit-${i}`}
          radius={orbitRadius}
          tilt={orbitTilt}
          color={objective.accentColor || PALETTE.indigo}
          opacity={settings.taskOrbitOpacity ?? 0.06}
        />
      ))}

      {/* === TASK NODES === */}
      {taskLayouts.map(({ task, orbitRadius, orbitTilt, orbitOffset }) => (
        <TaskOrbitNode
          key={task.id}
          task={task}
          orbitRadius={orbitRadius}
          orbitTilt={orbitTilt}
          orbitOffset={orbitOffset}
          objectivePosition={position}
          settings={settings}
          onSelect={onSelect}
        />
      ))}

      {/* === WARD RECEIPT BADGE (completed objectives only) === */}
      {objective.status === 'completed' && <WardBadge scale={scale} />}

      {/* === BILLBOARD LABEL === */}
      <Billboard position={[0, scale * 1.8, 0]}>
        <Text
          fontSize={0.36}
          color="white"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.025}
          outlineColor="#000000"
          fillOpacity={hovered ? 1 : 0.6}
        >
          {titleTruncated}
        </Text>
        <Text
          fontSize={0.2}
          color={objective.accentColor || PALETTE.indigo}
          anchorX="center"
          anchorY="middle"
          position={[0, -0.35, 0]}
          fillOpacity={hovered ? 0.8 : 0.4}
        >
          {subtitle}
        </Text>
      </Billboard>

      {/* === HOVER TOOLTIP === */}
      {hovered && (
        <Html
          position={[scale * 1.8, 0.5, 0]}
          style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          zIndexRange={[20, 0]}
        >
          <div style={{
            background: 'rgba(5,5,16,0.94)',
            border: `1px solid ${objective.accentColor || PALETTE.indigo}40`,
            borderRadius: 6,
            padding: '8px 12px',
            fontFamily: FONT_STACK,
            fontSize: 11,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            minWidth: 160,
            boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 15px ${objective.accentColor || PALETTE.indigo}15`,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: objective.accentColor || PALETTE.indigo }}>
              {objective.title || 'Objective'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: objective.status === 'completed' ? PALETTE.executing : PALETTE.indigo,
                boxShadow: `0 0 8px ${objective.status === 'completed' ? PALETTE.executing : PALETTE.indigo}`,
              }} />
              <span style={{ fontWeight: 600, textTransform: 'capitalize', color: objective.status === 'completed' ? PALETTE.executing : PALETTE.indigo }}>
                {objective.status}
              </span>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}>
              {completedCount} completed, {tasks.filter(t => t.status === 'running').length} running, {tasks.filter(t => t.status === 'pending').length} pending, {tasks.filter(t => t.status === 'failed').length} failed
            </div>
            <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 8, marginTop: 4 }}>Click for details</div>
          </div>
        </Html>
      )}

      {/* === HITBOX === */}
      <mesh
        scale={scale * 2.2}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={handleClick}
        visible={false}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}
