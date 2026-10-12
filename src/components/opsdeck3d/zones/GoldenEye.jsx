/**
 * GOLDENEYE — The autonomous watchdog agent.
 *
 * Visual: HAL 9000-style eye, golden instead of red. Mounted on an
 * articulated hinged neck above the nucleus. Continuously scans the
 * scene, locks onto anomalies with a laser beam.
 *
 * Structure:
 *   Base (y=5) — anchor point on top of nucleus
 *   Lower neck segment — tilts ±30°, fixed length
 *   Upper neck segment — tilts ±45°, extends when tracking
 *   Eye housing — HAL-style lens with concentric golden rings
 *   Scanning ring — torus that orbits the eye
 *   Laser beam — from eye to current watch target
 *
 * Behavior:
 *   IDLE:    Slow figure-8 patrol, scanning ring sweeps
 *   ALERT:   Neck snaps to anomaly, extends, laser locks on
 *   PATROL:  Systematic zone-by-zone sweep
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

// ─── Constants ──────────────────────────────────────────
const GOLD = '#d4a017'
const GOLD_BRIGHT = '#f0c040'
const GOLD_DIM = '#8a7020'
const GOLD_GLOW = '#fde68a'
const ARM_CHROME = '#b8b8c0'  // Cool silver-chrome for the arm

const BASE_Y = 6          // Anchor point (above nucleus horns at y=3.9)
const LOWER_SEG_LEN = 3.0 // Lower neck segment length
const UPPER_SEG_LEN = 2.5 // Upper neck segment (extends to 4.0)
const UPPER_SEG_EXTEND = 4.0 // Extended length when tracking
const EYE_RADIUS = 0.8    // Eye housing radius — big enough to see from default camera
const SCAN_RING_R = 1.8   // Scanning ring orbit radius

// Anomaly detection thresholds
const STUCK_AGENT_MS = 45000    // 45s stuck = anomaly
const STALLED_OBJ_MS = 120000   // 2min stalled = anomaly

// ─── Eye Housing (spherical eyeball in golden robotic casing) ─────
function EyeHousing({ alertLevel = 0 }) {
  const irisRef = useRef()
  const pupilRef = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    const t = timeRef.current
    // Iris pulse — faster when alert
    if (irisRef.current) {
      const speed = 1 + alertLevel * 2
      const pulse = 0.5 + Math.sin(t * speed) * 0.25
      irisRef.current.material.emissiveIntensity = pulse
    }
    // Pupil subtle throb
    if (pupilRef.current) {
      const throb = 1 + Math.sin(t * 2) * 0.05
      pupilRef.current.scale.setScalar(throb)
    }
  })

  const R = EYE_RADIUS
  const CASING_MAT = { color: ARM_CHROME, metalness: 0.95, roughness: 0.06 }
  const CASING_TRIM = { color: GOLD, emissive: GOLD_DIM, emissiveIntensity: 0.2, metalness: 0.95, roughness: 0.05 }

  return (
    <group>
      {/* === CASING — golden shell, open at front === */}
      {/* Back hemisphere (closed) */}
      <mesh position={[0, 0, -R * 0.15]} rotation={[0, Math.PI, 0]}>
        <sphereGeometry args={[R * 1.1, 16, 16, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
        <meshStandardMaterial {...CASING_MAT} side={THREE.DoubleSide} />
      </mesh>

      {/* Top cowl (covers top of eyeball) */}
      <mesh position={[0, R * 0.3, -R * 0.1]} rotation={[0.4, 0, 0]}>
        <sphereGeometry args={[R * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.35]} />
        <meshStandardMaterial {...CASING_MAT} side={THREE.DoubleSide} />
      </mesh>

      {/* Rim ring — gold accent on the aperture */}
      <mesh>
        <torusGeometry args={[R * 0.9, R * 0.08, 8, 24]} />
        <meshStandardMaterial {...CASING_TRIM} />
      </mesh>

      {/* === EYEBALL — white sphere with golden iris === */}
      {/* Sclera (white of the eye) */}
      <mesh>
        <sphereGeometry args={[R * 0.85, 16, 16]} />
        <meshStandardMaterial color="#1a1a2e" roughness={0.3} metalness={0.1} />
      </mesh>

      {/* Iris — golden ring on front face */}
      <mesh ref={irisRef} position={[0, 0, R * 0.55]}>
        <torusGeometry args={[R * 0.35, R * 0.12, 8, 24]} />
        <meshStandardMaterial
          color={GOLD_BRIGHT}
          emissive={GOLD}
          emissiveIntensity={0.6}
          metalness={0.4}
          roughness={0.15}
        />
      </mesh>

      {/* Inner iris detail ring */}
      <mesh position={[0, 0, R * 0.6]}>
        <torusGeometry args={[R * 0.2, R * 0.04, 8, 16]} />
        <meshBasicMaterial color={GOLD_BRIGHT} transparent opacity={0.7} />
      </mesh>

      {/* Pupil — bright golden centre */}
      <mesh ref={pupilRef} position={[0, 0, R * 0.7]}>
        <sphereGeometry args={[R * 0.15, 12, 12]} />
        <meshStandardMaterial
          color={GOLD_GLOW}
          emissive={GOLD_BRIGHT}
          emissiveIntensity={0.8 + alertLevel * 0.5}
          roughness={0.05}
          metalness={0.2}
        />
      </mesh>

      {/* Lens highlight — specular catch */}
      <mesh position={[R * 0.15, R * 0.15, R * 0.75]}>
        <sphereGeometry args={[R * 0.06, 8, 8]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.4} />
      </mesh>

      {/* Glow disc — soft additive bloom behind eye */}
      <mesh position={[0, 0, R * 0.3]}>
        <circleGeometry args={[R * 2.0, 16]} />
        <meshBasicMaterial
          color={GOLD}
          transparent
          opacity={0.1 + alertLevel * 0.12}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Point light — the eye emits golden light */}
      <pointLight color={GOLD} intensity={0.6 + alertLevel * 0.8} distance={20} decay={2} position={[0, 0, R * 0.5]} />
    </group>
  )
}

// ─── Scanning Ring (orbits the eye) ─────────────────────
function ScanningRing({ active = true }) {
  const ringRef = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    if (!ringRef.current) return
    timeRef.current += delta
    // Orbit: tilted circle around the eye
    ringRef.current.rotation.x = Math.sin(timeRef.current * 0.7) * 0.3
    ringRef.current.rotation.y += delta * (active ? 2.0 : 0.5)
    ringRef.current.rotation.z = Math.cos(timeRef.current * 0.5) * 0.2
  })

  return (
    <group ref={ringRef}>
      <mesh>
        <torusGeometry args={[SCAN_RING_R, 0.015, 6, 32]} />
        <meshBasicMaterial
          color={GOLD}
          transparent
          opacity={active ? 0.3 : 0.1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Scanner dot on ring */}
      <mesh position={[SCAN_RING_R, 0, 0]} scale={0.05}>
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial color={GOLD_BRIGHT} transparent opacity={0.8} />
      </mesh>
    </group>
  )
}

// ─── Laser Beam (from eye to target) ────────────────────
function LaserBeam({ target, active }) {
  const groupRef = useRef()
  const beamRef = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    if (!active || !target || !groupRef.current) return
    timeRef.current += delta
    if (beamRef.current) {
      beamRef.current.material.opacity = 0.15 + Math.sin(timeRef.current * 4) * 0.05
    }
  })

  if (!active || !target) return null

  const dir = new THREE.Vector3(...target).normalize()
  const length = new THREE.Vector3(...target).length()
  const mid = new THREE.Vector3(...target).multiplyScalar(0.5)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)

  return (
    <group ref={groupRef}>
      <mesh position={mid} quaternion={quat} ref={beamRef}>
        <cylinderGeometry args={[0.015, 0.015, length, 4, 1, true]} />
        <meshBasicMaterial
          color={GOLD_BRIGHT}
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Impact dot at target */}
      <mesh position={target} scale={0.1}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial color={GOLD_BRIGHT} transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}

// ─── Neck Segment (cylinder with joint) ─────────────────
// Arm segment — chrome/steel robotic arm, tapered
function ArmSegment({ length, radiusTop = 0.06, radiusBottom = 0.08 }) {
  return (
    <group>
      {/* Main cylinder — brushed chrome */}
      <mesh position={[0, length / 2, 0]}>
        <cylinderGeometry args={[radiusTop, radiusBottom, length, 8]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.08} />
      </mesh>
      {/* Gold accent ridge at midpoint */}
      <mesh position={[0, length / 2, 0]}>
        <torusGeometry args={[(radiusTop + radiusBottom) / 2 + 0.01, 0.008, 6, 12]} />
        <meshStandardMaterial color={GOLD} emissive={GOLD_DIM} emissiveIntensity={0.2} metalness={0.95} roughness={0.05} />
      </mesh>
    </group>
  )
}

// Hinge joint — chrome disc with gold axle, robotic arm pivot
function HingeJoint({ radius = 0.1 }) {
  return (
    <group>
      {/* Hinge disc — polished chrome */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius, radius, 0.04, 12]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.06} />
      </mesh>
      {/* Gold axle through centre */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius * 0.25, radius * 0.25, 0.08, 6]} />
        <meshStandardMaterial color={GOLD} emissive={GOLD_DIM} emissiveIntensity={0.15} metalness={0.95} roughness={0.05} />
      </mesh>
      {/* Rivet dots — gold accent */}
      {[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((a, i) => (
        <mesh key={i} position={[Math.cos(a) * radius * 0.7, 0, Math.sin(a) * radius * 0.7]}>
          <sphereGeometry args={[0.012, 4, 4]} />
          <meshStandardMaterial color={GOLD} metalness={0.9} roughness={0.1} />
        </mesh>
      ))}
    </group>
  )
}

// ─── Anomaly Scanner (the brain) ────────────────────────
function useAnomalyScanner(agents, objectives, implants) {
  const anomalies = useMemo(() => {
    const found = []

    // Blocked agents
    agents?.forEach(a => {
      if (a.state === 'blocked') {
        found.push({ type: 'blocked-agent', id: a.id, name: a.name, severity: 'high', position: null })
      }
    })

    // Stalled objectives (running with no task progress)
    objectives?.forEach(o => {
      if (o.status === 'running') {
        const runningTasks = (o.tasks || []).filter(t => t.status === 'running')
        if (runningTasks.length === 0 && (o.tasks || []).some(t => t.status === 'pending')) {
          found.push({ type: 'stalled-objective', id: o.id, name: o.title, severity: 'medium', position: null })
        }
      }
    })

    // Degraded implants
    implants?.forEach(i => {
      if (i.health < 30 && !i.locked) {
        found.push({ type: 'degraded-implant', id: i.id, name: i.name, severity: i.health < 10 ? 'high' : 'medium', position: null })
      }
    })

    return found
  }, [agents, objectives, implants])

  return anomalies
}

// ─── Target Resolver (anomaly → world position) ─────────
function resolveTargetPosition(anomaly, agents, implants) {
  if (!anomaly) return null

  if (anomaly.type === 'blocked-agent') {
    const idx = agents?.findIndex(a => a.id === anomaly.id) ?? -1
    if (idx >= 0) {
      const total = agents.length
      const role = agents[idx].role || 'specialist'
      const r = role === 'orchestrator' ? 0 : (role === 'manager' || role === 'analyst') ? 17 : 25
      const angle = (idx / total) * Math.PI * 2
      return [Math.cos(angle) * r, 0.5, Math.sin(angle) * r]
    }
  }

  if (anomaly.type === 'stalled-objective') {
    // Objectives at r=80
    return [0, 0, 80]
  }

  if (anomaly.type === 'degraded-implant') {
    const idx = implants?.findIndex(i => i.id === anomaly.id) ?? -1
    if (idx >= 0) {
      const angle = (idx / implants.length) * Math.PI * 2
      return [Math.cos(angle) * 7, 0, Math.sin(angle) * 7]
    }
  }

  return null
}

// ─── Patrol Pattern (figure-8 when idle) ────────────────
function getPatrolTarget(time) {
  // Figure-8 lemniscate at different radii, looking outward
  const t = time * 0.15
  const r = 15 + Math.sin(t * 0.3) * 10
  const x = Math.sin(t) * r
  const z = Math.sin(t * 2) * r * 0.5
  return [x, -2, z] // Look slightly downward
}

// ─── Main Component ─────────────────────────────────────
export default function GoldenEye({
  agents = [],
  objectives = [],
  implants = [],
  onAlert,
  onSelect,
}) {
  const groupRef = useRef()
  const lowerJointRef = useRef()
  const upperJointRef = useRef()
  const eyeGroupRef = useRef()
  const timeRef = useRef(0)
  const [currentTarget, setCurrentTarget] = useState(null)
  const [alertLevel, setAlertLevel] = useState(0) // 0=idle, 0.5=watching, 1=alert
  const prevAnomalyCountRef = useRef(0)

  const anomalies = useAnomalyScanner(agents, objectives, implants)

  // Select highest-priority target
  const targetAnomaly = anomalies.length > 0 ? anomalies[0] : null
  const targetPos = resolveTargetPosition(targetAnomaly, agents, implants)

  // Notify on new anomalies
  if (anomalies.length > prevAnomalyCountRef.current && anomalies.length > 0) {
    onAlert?.(anomalies[0])
  }
  prevAnomalyCountRef.current = anomalies.length

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      // Determine look target: anomaly position or patrol pattern
      const lookTarget = targetPos || getPatrolTarget(t)
      const targetAlert = targetPos ? 1 : 0

      // Smooth alert level transition
      setAlertLevel(prev => prev + (targetAlert - prev) * Math.min(1, delta * 3))

      // Calculate look direction from eye position (approx BASE_Y + segments)
      const eyeY = BASE_Y + LOWER_SEG_LEN + UPPER_SEG_LEN
      const lookDir = new THREE.Vector3(
        lookTarget[0], lookTarget[1] - eyeY, lookTarget[2]
      ).normalize()

      // ── Neck IK: two-segment inverse kinematics ──

      // Lower joint: pitch (tilt forward/back) + yaw (rotate)
      if (lowerJointRef.current) {
        const targetYaw = Math.atan2(lookDir.x, lookDir.z)
        const targetPitch = Math.asin(Math.max(-0.5, Math.min(0.5, lookDir.y))) * -0.6

        const currentRot = lowerJointRef.current.rotation
        currentRot.y += (targetYaw - currentRot.y) * Math.min(1, delta * 2.5)
        currentRot.x += (targetPitch - currentRot.x) * Math.min(1, delta * 2.0)
      }

      // Upper joint: additional pitch for fine-aiming
      if (upperJointRef.current) {
        const finePitch = Math.asin(Math.max(-0.7, Math.min(0.3, lookDir.y))) * -0.8
        const currentRot = upperJointRef.current.rotation
        currentRot.x += (finePitch - currentRot.x) * Math.min(1, delta * 3.0)

        // Extend upper segment when tracking anomaly
        const targetLen = targetPos ? UPPER_SEG_EXTEND : UPPER_SEG_LEN
        const currentLen = upperJointRef.current.position?.y ?? LOWER_SEG_LEN
        // Position upper joint at top of lower segment
      }

      // Eye faces the target directly
      if (eyeGroupRef.current && lookTarget) {
        const eyePos = eyeGroupRef.current.getWorldPosition(new THREE.Vector3())
        const targetVec = new THREE.Vector3(...lookTarget)
        const dir = targetVec.sub(eyePos).normalize()
        // Create quaternion to face the direction
        const up = new THREE.Vector3(0, 1, 0)
        const quat = new THREE.Quaternion()
        const mat = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up)
        quat.setFromRotationMatrix(mat)
        eyeGroupRef.current.quaternion.slerp(quat, Math.min(1, delta * 3))
      }

      // Update current target for laser beam (relative to eye)
      if (targetPos && eyeGroupRef.current) {
        const eyeWorld = eyeGroupRef.current.getWorldPosition(new THREE.Vector3())
        setCurrentTarget([
          targetPos[0] - eyeWorld.x,
          targetPos[1] - eyeWorld.y,
          targetPos[2] - eyeWorld.z,
        ])
      } else {
        setCurrentTarget(null)
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group ref={groupRef} position={[0, BASE_Y, 0]}>
      {/* Base mount — shoulder hinge */}
      <HingeJoint radius={0.12} />

      {/* Lower arm segment */}
      <group ref={lowerJointRef}>
        <ArmSegment length={LOWER_SEG_LEN} radiusTop={0.06} radiusBottom={0.09} />

        {/* Elbow hinge */}
        <group position={[0, LOWER_SEG_LEN, 0]}>
          <HingeJoint radius={0.09} />

          {/* Upper arm segment */}
          <group ref={upperJointRef}>
            <ArmSegment length={UPPER_SEG_LEN} radiusTop={0.045} radiusBottom={0.065} />

            {/* Wrist hinge + eye mount */}
            <group position={[0, UPPER_SEG_LEN, 0]}>
              <HingeJoint radius={0.07} />

              {/* Eye — faces target */}
              <group ref={eyeGroupRef}>
                <EyeHousing alertLevel={alertLevel} />
                <ScanningRing active={anomalies.length > 0} />
                <LaserBeam target={currentTarget} active={!!targetPos} />
              </group>

              {/* Clickable hitbox */}
              <mesh
                scale={1.5}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect?.({
                    type: 'agent', id: 'goldeneye', name: 'GOLDENEYE',
                    role: 'specialist', state: anomalies.length > 0 ? 'alert' : 'watching',
                    color: GOLD, description: `Autonomous watchdog. ${anomalies.length} anomalies detected.`,
                    tools: ['spatial_search', 'health_scan', 'guided_tour'],
                    capabilities: ['anomaly_detection', 'guided_tour', 'evidence_witness'],
                    position: [0, BASE_Y + LOWER_SEG_LEN + UPPER_SEG_LEN, 0],
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

      {/* Tether beam — chrome line from base to nucleus centre */}
      <mesh position={[0, -BASE_Y / 2, 0]}>
        <cylinderGeometry args={[0.025, 0.025, BASE_Y, 6]} />
        <meshStandardMaterial color={ARM_CHROME} metalness={0.95} roughness={0.08} transparent opacity={0.6} />
      </mesh>

      {/* Status label */}
      <Billboard position={[0, LOWER_SEG_LEN + UPPER_SEG_LEN + 1.5, 0]}>
        <Text
          fontSize={0.2}
          color={anomalies.length > 0 ? GOLD_BRIGHT : GOLD_DIM}
          anchorX="center"
          anchorY="middle"
          fillOpacity={anomalies.length > 0 ? 0.7 : 0.25}
          outlineWidth={0.015}
          outlineColor="#000000"
          letterSpacing={0.12}
        >
          {anomalies.length > 0
            ? `GOLDENEYE \u00B7 ${anomalies.length} ANOMAL${anomalies.length === 1 ? 'Y' : 'IES'}`
            : 'GOLDENEYE \u00B7 WATCHING'
          }
        </Text>
      </Billboard>

      {/* Alert pulse ring — expands when new anomaly detected */}
      {alertLevel > 0.5 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, LOWER_SEG_LEN + UPPER_SEG_LEN, 0]}>
          <torusGeometry args={[1.5 + alertLevel, 0.02, 6, 24]} />
          <meshBasicMaterial
            color={GOLD}
            transparent
            opacity={0.1 * alertLevel}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
    </group>
  )
}

// Export anomaly scanner for tests
export { useAnomalyScanner }
