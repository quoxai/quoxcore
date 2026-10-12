/**
 * HORUS — The All-Seeing Eye. Autonomous watchdog agent.
 *
 * Visual reference: Oblivion (2013) drone eye.
 * Large reflective chrome sphere with a golden lens deep-set inside.
 * Concentric rings around the aperture. Golden backlight glow.
 * Mounted on a chrome robotic arm above the nucleus.
 *
 * Comparable in size to the nucleus core but slightly smaller.
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

// ─── Palette ────────────────────────────────────────────
const GOLD = '#d4a017'
const GOLD_BRIGHT = '#f0c040'
const GOLD_DIM = '#8a7020'
const GOLD_GLOW = '#fde68a'
const ARM_CHROME = '#c0c0c8'  // Bright chrome — NOT dark

// ─── Dimensions (comparable to nucleus ~1.5, but slightly smaller) ──
const BASE_Y = 6
const LOWER_ARM = 3.0
const UPPER_ARM = 2.5
const SPHERE_RADIUS = 1.1    // The main sphere — large, dominant
const LENS_DEPTH = 0.3       // How deep the lens sits inside
const SCAN_RING_R = 1.8

// Default eye colour — red like HAL, configurable via settings
const DEFAULT_EYE_COLOR = '#ef4444' // red (HAL 9000)

// ─── Chrome Sphere with Lens (the Oblivion drone look) ──
function HorusEye({ alertLevel = 0, eyeColor = DEFAULT_EYE_COLOR }) {
  const pupilRef = useRef()
  const timeRef = useRef(0)

  const lensColor = useMemo(() => new THREE.Color(eyeColor), [eyeColor])

  useFrame((_, delta) => {
    timeRef.current += delta
    const t = timeRef.current
    if (pupilRef.current) {
      const speed = 1.5 + alertLevel * 3
      const pulse = 0.6 + Math.sin(t * speed) * 0.3
      pupilRef.current.material.emissiveIntensity = pulse
    }
  })

  const R = SPHERE_RADIUS

  return (
    <group>
      {/* === MAIN SPHERE — polished chrome, reflective === */}
      <mesh>
        <sphereGeometry args={[R, 24, 24]} />
        <meshStandardMaterial
          color="#2a2a30"
          metalness={0.95}
          roughness={0.05}
          envMapIntensity={1.5}
        />
      </mesh>

      {/* Chrome highlight ring at equator */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[R * 1.01, 0.015, 8, 32]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.05} />
      </mesh>

      {/* === VIBRANT EYE — HAL visualiser style, fills the front face === */}

      {/* Outer iris glow — large, vivid, like HAL's radial gradient */}
      <mesh position={[0, 0, R * 0.72]}>
        <circleGeometry args={[R * 0.7, 32]} />
        <meshBasicMaterial
          color={eyeColor}
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Iris ring 1 — bright outer ring */}
      <mesh position={[0, 0, R * 0.73]}>
        <torusGeometry args={[R * 0.65, 0.025, 8, 32]} />
        <meshBasicMaterial color={eyeColor} transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* Iris ring 2 — mid ring, slightly dimmer */}
      <mesh position={[0, 0, R * 0.74]}>
        <torusGeometry args={[R * 0.45, 0.02, 8, 28]} />
        <meshBasicMaterial color={eyeColor} transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* Iris ring 3 — inner ring */}
      <mesh position={[0, 0, R * 0.75]}>
        <torusGeometry args={[R * 0.28, 0.015, 8, 24]} />
        <meshBasicMaterial color={eyeColor} transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {/* Dark pupil — black centre void */}
      <mesh position={[0, 0, R * 0.71]}>
        <circleGeometry args={[R * 0.2, 24]} />
        <meshBasicMaterial color="#000000" />
      </mesh>

      {/* Pupil glow — faint colour in the void */}
      <mesh ref={pupilRef} position={[0, 0, R * 0.715]}>
        <circleGeometry args={[R * 0.12, 16]} />
        <meshBasicMaterial
          color={eyeColor}
          transparent
          opacity={0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Specular highlight — the "alive" catch */}
      <mesh position={[R * 0.15, R * 0.12, R * 0.78]}>
        <circleGeometry args={[R * 0.06, 8]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.4} depthWrite={false} />
      </mesh>

      {/* === GLOW — surrounds the entire sphere === */}

      {/* Front glow — vibrant, eye colour */}
      <mesh position={[0, 0, R * 0.5]}>
        <circleGeometry args={[R * 2.0, 16]} />
        <meshBasicMaterial color={eyeColor} transparent opacity={0.1 + alertLevel * 0.12} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* Rear backlight — golden warmth */}
      <mesh position={[0, 0, -R * 0.5]}>
        <circleGeometry args={[R * 1.5, 16]} />
        <meshBasicMaterial color={GOLD_GLOW} transparent opacity={0.04 + alertLevel * 0.05} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>

      {/* Point light — eye colour illuminates surroundings */}
      <pointLight color={eyeColor} intensity={0.8 + alertLevel * 1.0} distance={25} decay={2} position={[0, 0, R * 0.5]} />
    </group>
  )
}

// ─── Scanning Ring ──────────────────────────────────────
function ScanningRing({ active = true, color = GOLD }) {
  const ringRef = useRef()
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (!ringRef.current) return
    timeRef.current += delta
    ringRef.current.rotation.x = Math.sin(timeRef.current * 0.7) * 0.3
    ringRef.current.rotation.y += delta * (active ? 2.0 : 0.5)
    ringRef.current.rotation.z = Math.cos(timeRef.current * 0.5) * 0.2
  })
  return (
    <group ref={ringRef}>
      <mesh>
        <torusGeometry args={[SCAN_RING_R, 0.015, 6, 32]} />
        <meshBasicMaterial color={color} transparent opacity={active ? 0.3 : 0.1} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh position={[SCAN_RING_R, 0, 0]} scale={0.05}>
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial color={GOLD_BRIGHT} transparent opacity={0.8} />
      </mesh>
    </group>
  )
}

// ─── Laser Beam ─────────────────────────────────────────
function LaserBeam({ target, active, color = GOLD_BRIGHT }) {
  const beamRef = useRef()
  const timeRef = useRef(0)
  useFrame((_, delta) => {
    if (!active || !target) return
    timeRef.current += delta
    if (beamRef.current) beamRef.current.material.opacity = 0.15 + Math.sin(timeRef.current * 4) * 0.05
  })
  if (!active || !target) return null
  const dir = new THREE.Vector3(...target).normalize()
  const length = new THREE.Vector3(...target).length()
  const mid = new THREE.Vector3(...target).multiplyScalar(0.5)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  return (
    <group>
      <mesh position={mid} quaternion={quat} ref={beamRef}>
        <cylinderGeometry args={[0.015, 0.015, length, 4, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={target} scale={0.1}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}

// ─── Chrome Arm Segment ─────────────────────────────────
function ArmSegment({ length, radiusTop = 0.06, radiusBottom = 0.08 }) {
  return (
    <group>
      <mesh position={[0, length / 2, 0]}>
        <cylinderGeometry args={[radiusTop, radiusBottom, length, 8]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.08} />
      </mesh>
      <mesh position={[0, length / 2, 0]}>
        <torusGeometry args={[(radiusTop + radiusBottom) / 2 + 0.01, 0.008, 6, 12]} />
        <meshStandardMaterial color={GOLD} emissive={GOLD_DIM} emissiveIntensity={0.2} metalness={0.95} roughness={0.05} />
      </mesh>
    </group>
  )
}

// ─── Chrome Hinge Joint ─────────────────────────────────
function HingeJoint({ radius = 0.1 }) {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius, radius, 0.04, 12]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.06} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius * 0.25, radius * 0.25, 0.08, 6]} />
        <meshStandardMaterial color={GOLD} emissive={GOLD_DIM} emissiveIntensity={0.15} metalness={0.95} roughness={0.05} />
      </mesh>
    </group>
  )
}

// ─── Anomaly Scanner ────────────────────────────────────
function useAnomalyScanner(agents, objectives, implants) {
  return useMemo(() => {
    const found = []
    agents?.forEach(a => { if (a.state === 'blocked') found.push({ type: 'blocked-agent', id: a.id, name: a.name, severity: 'high' }) })
    objectives?.forEach(o => {
      if (o.status === 'running') {
        const running = (o.tasks || []).filter(t => t.status === 'running')
        if (running.length === 0 && (o.tasks || []).some(t => t.status === 'pending'))
          found.push({ type: 'stalled-objective', id: o.id, name: o.title, severity: 'medium' })
      }
    })
    implants?.forEach(i => { if (i.health < 30 && !i.locked) found.push({ type: 'degraded-implant', id: i.id, name: i.name, severity: i.health < 10 ? 'high' : 'medium' }) })
    return found
  }, [agents, objectives, implants])
}

function resolveTargetPosition(anomaly, agents, implants) {
  if (!anomaly) return null
  if (anomaly.type === 'blocked-agent') {
    const idx = agents?.findIndex(a => a.id === anomaly.id) ?? -1
    if (idx >= 0) { const r = 25; const angle = (idx / agents.length) * Math.PI * 2; return [Math.cos(angle) * r, 0.5, Math.sin(angle) * r] }
  }
  if (anomaly.type === 'stalled-objective') return [0, 0, 80]
  if (anomaly.type === 'degraded-implant') {
    const idx = implants?.findIndex(i => i.id === anomaly.id) ?? -1
    if (idx >= 0) { const angle = (idx / implants.length) * Math.PI * 2; return [Math.cos(angle) * 7, 0, Math.sin(angle) * 7] }
  }
  return null
}

function getPatrolTarget(time) {
  const t = time * 0.15
  const r = 15 + Math.sin(t * 0.3) * 10
  return [Math.sin(t) * r, -2, Math.sin(t * 2) * r * 0.5]
}

// ─── Main Component ─────────────────────────────────────
export default function Horus({ agents = [], objectives = [], implants = [], onAlert, onSelect, eyeColor, selectedTarget = null }) {
  const groupRef = useRef()
  const lowerJointRef = useRef()
  const upperJointRef = useRef()
  const eyeGroupRef = useRef()
  const timeRef = useRef(0)
  const [currentTarget, setCurrentTarget] = useState(null)
  const [alertLevel, setAlertLevel] = useState(0)
  const prevAnomalyCountRef = useRef(0)

  const anomalies = useAnomalyScanner(agents, objectives, implants)
  const targetAnomaly = anomalies.length > 0 ? anomalies[0] : null
  const targetPos = resolveTargetPosition(targetAnomaly, agents, implants)

  if (anomalies.length > prevAnomalyCountRef.current && anomalies.length > 0) onAlert?.(anomalies[0])
  prevAnomalyCountRef.current = anomalies.length

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current
      // Priority: user selection > anomaly > patrol
      const activeTarget = selectedTarget || targetPos
      const lookTarget = activeTarget || getPatrolTarget(t)
      const targetAlert = targetPos ? 1 : selectedTarget ? 0.5 : 0
      setAlertLevel(prev => prev + (targetAlert - prev) * Math.min(1, delta * 3))

      const eyeY = BASE_Y + LOWER_ARM + UPPER_ARM
      const lookDir = new THREE.Vector3(lookTarget[0], lookTarget[1] - eyeY, lookTarget[2]).normalize()

      if (lowerJointRef.current) {
        const yaw = Math.atan2(lookDir.x, lookDir.z)
        const pitch = Math.asin(Math.max(-0.5, Math.min(0.5, lookDir.y))) * -0.6
        lowerJointRef.current.rotation.y += (yaw - lowerJointRef.current.rotation.y) * Math.min(1, delta * 2.5)
        lowerJointRef.current.rotation.x += (pitch - lowerJointRef.current.rotation.x) * Math.min(1, delta * 2.0)
      }
      if (upperJointRef.current) {
        const fine = Math.asin(Math.max(-0.7, Math.min(0.3, lookDir.y))) * -0.8
        upperJointRef.current.rotation.x += (fine - upperJointRef.current.rotation.x) * Math.min(1, delta * 3.0)
      }
      if (eyeGroupRef.current && lookTarget) {
        const eyePos = eyeGroupRef.current.getWorldPosition(new THREE.Vector3())
        const dir = new THREE.Vector3(...lookTarget).sub(eyePos).normalize()
        const quat = new THREE.Quaternion()
        quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0)))
        eyeGroupRef.current.quaternion.slerp(quat, Math.min(1, delta * 3))
      }
      // Laser target: selection or anomaly
      if (activeTarget && eyeGroupRef.current) {
        const w = eyeGroupRef.current.getWorldPosition(new THREE.Vector3())
        setCurrentTarget([activeTarget[0] - w.x, activeTarget[1] - w.y, activeTarget[2] - w.z])
      } else { setCurrentTarget(null) }
    } catch {}
  })

  return (
    <group ref={groupRef} position={[0, BASE_Y, 0]}>
      {/* Shoulder hinge */}
      <HingeJoint radius={0.12} />

      {/* Lower arm */}
      <group ref={lowerJointRef}>
        <ArmSegment length={LOWER_ARM} radiusTop={0.06} radiusBottom={0.09} />

        {/* Elbow hinge */}
        <group position={[0, LOWER_ARM, 0]}>
          <HingeJoint radius={0.09} />

          {/* Upper arm */}
          <group ref={upperJointRef}>
            <ArmSegment length={UPPER_ARM} radiusTop={0.045} radiusBottom={0.065} />

            {/* Wrist hinge */}
            <group position={[0, UPPER_ARM, 0]}>
              <HingeJoint radius={0.07} />

              {/* THE EYE — faces target */}
              <group ref={eyeGroupRef}>
                <HorusEye alertLevel={alertLevel} eyeColor={eyeColor || DEFAULT_EYE_COLOR} />
                <ScanningRing active={anomalies.length > 0} color={eyeColor || GOLD} />
                <LaserBeam target={currentTarget} active={!!currentTarget} color={eyeColor || GOLD_BRIGHT} />
              </group>

              {/* Clickable hitbox */}
              <mesh
                scale={SPHERE_RADIUS * 1.5}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect?.({
                    type: 'agent', id: 'horus', name: 'HORUS',
                    role: 'specialist', state: anomalies.length > 0 ? 'alert' : 'watching',
                    color: GOLD, description: `The All-Seeing Eye. ${anomalies.length} anomalies detected.`,
                    tools: ['spatial_search', 'health_scan', 'guided_tour'],
                    capabilities: ['anomaly_detection', 'guided_tour', 'evidence_witness'],
                    position: [0, BASE_Y + LOWER_ARM + UPPER_ARM, 0],
                  })
                }}
                onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer' }}
                onPointerOut={() => { document.body.style.cursor = 'default' }}
                visible={false}
              >
                <sphereGeometry args={[1, 8, 8]} />
                <meshBasicMaterial transparent opacity={0} />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* Tether — chrome rod to nucleus */}
      <mesh position={[0, -BASE_Y / 2, 0]}>
        <cylinderGeometry args={[0.025, 0.025, BASE_Y, 6]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.08} transparent opacity={0.6} />
      </mesh>

      {/* Status label */}
      <Billboard position={[0, LOWER_ARM + UPPER_ARM + 2.5, 0]}>
        <Text fontSize={0.25} color={anomalies.length > 0 ? GOLD_BRIGHT : GOLD_DIM} anchorX="center" anchorY="middle"
          fillOpacity={anomalies.length > 0 ? 0.7 : 0.25} outlineWidth={0.018} outlineColor="#000000" letterSpacing={0.15}>
          {anomalies.length > 0 ? `HORUS \u00B7 ${anomalies.length} ANOMAL${anomalies.length === 1 ? 'Y' : 'IES'}` : 'HORUS \u00B7 WATCHING'}
        </Text>
      </Billboard>

      {alertLevel > 0.5 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, LOWER_ARM + UPPER_ARM, 0]}>
          <torusGeometry args={[1.5 + alertLevel, 0.02, 6, 24]} />
          <meshBasicMaterial color={GOLD} transparent opacity={0.1 * alertLevel} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  )
}

export { useAnomalyScanner }
