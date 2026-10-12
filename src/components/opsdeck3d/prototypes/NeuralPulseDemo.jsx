/**
 * NeuralPulseDemo — Nucleus broadcasting a thought outward.
 *
 * Nucleus at centre (3 layered spheres + 3 orbital rings). Every 4s it
 * flares white, a spherical ripple expands outward, agents flash as the
 * ripple passes. One agent receives a delegation arc, spins, then completes.
 * 12s loop.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const AGENT_COUNT = 8
const AGENT_R = 8
const AGENT_NAMES = ['WARDEN', 'CIPHER', 'HYPERION', 'DAEDALUS', 'METRICS', 'INSIGHT', 'VIGIL', 'CODEX']
const AGENT_COLORS = [
  PALETTE.executing, PALETTE.thinking, PALETTE.reading, PALETTE.violet,
  PALETTE.cyan, PALETTE.active, PALETTE.done, PALETTE.waiting,
]

function NucleusCore() {
  const ring1Ref = useRef()
  const ring2Ref = useRef()
  const ring3Ref = useRef()
  const sphere1Ref = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    const t = timeRef.current
    if (ring1Ref.current) ring1Ref.current.rotation.z += delta * 0.3
    if (ring2Ref.current) ring2Ref.current.rotation.x += delta * 0.25
    if (ring3Ref.current) ring3Ref.current.rotation.y += delta * 0.2
    if (sphere1Ref.current) {
      const breathe = 1 + Math.sin(t * 0.8) * 0.03
      sphere1Ref.current.scale.setScalar(breathe)
    }
  })

  return (
    <group>
      {/* Inner sphere */}
      <mesh ref={sphere1Ref}>
        <sphereGeometry args={[0.8, 16, 16]} />
        <meshStandardMaterial
          color={PALETTE.indigo}
          emissive={PALETTE.indigo}
          emissiveIntensity={0.8}
          transparent
          opacity={0.7}
          roughness={0.3}
        />
      </mesh>
      {/* Mid sphere */}
      <mesh>
        <sphereGeometry args={[1.2, 16, 16]} />
        <meshBasicMaterial
          color={PALETTE.indigo}
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Outer sphere */}
      <mesh>
        <sphereGeometry args={[1.6, 16, 16]} />
        <meshBasicMaterial
          color={PALETTE.violet}
          transparent
          opacity={0.04}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Orbital rings */}
      <group ref={ring1Ref}>
        <mesh>
          <torusGeometry args={[2.0, 0.015, 8, 48]} />
          <meshBasicMaterial color={PALETTE.indigo} transparent opacity={0.4} />
        </mesh>
      </group>
      <group ref={ring2Ref} rotation={[Math.PI / 3, 0, 0]}>
        <mesh>
          <torusGeometry args={[2.2, 0.012, 8, 48]} />
          <meshBasicMaterial color={PALETTE.violet} transparent opacity={0.3} />
        </mesh>
      </group>
      <group ref={ring3Ref} rotation={[0, Math.PI / 4, Math.PI / 3]}>
        <mesh>
          <torusGeometry args={[2.5, 0.01, 8, 48]} />
          <meshBasicMaterial color={PALETTE.cyan} transparent opacity={0.2} />
        </mesh>
      </group>
    </group>
  )
}

function AgentNodeSmall({ position, color, name, flashRef, spinningRef, index }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const ringRef = useRef()
  const timeRef = useRef(Math.random() * 100)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (wireRef.current) wireRef.current.rotation.y += delta * 0.12
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.08
      const flash = flashRef.current[index] || 0
      innerRef.current.material.emissiveIntensity = 0.5 + flash * 0.8
    }
    if (ringRef.current && spinningRef.current === index) {
      ringRef.current.rotation.z += delta * 1.5
      ringRef.current.rotation.x += delta * 0.45
    }
  })

  const scale = NODE_SCALES.specialist
  return (
    <group position={position}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
      </mesh>
      <mesh ref={innerRef} scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.7}
          roughness={0.2}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.7, 0]}>
        <circleGeometry args={[scale * 0.9, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <group ref={ringRef} rotation={[0.5, 0.3, 0]}>
        <mesh>
          <torusGeometry args={[scale * 1.4, 0.01, 8, 32]} />
          <meshBasicMaterial color={color} transparent opacity={spinningRef.current === index ? 0.4 : 0.1} />
        </mesh>
      </group>
      <Billboard position={[0, scale * 1.2, 0]}>
        <Text fontSize={0.2} color="white" anchorX="center" outlineWidth={0.015} outlineColor="#000" fillOpacity={0.6}>
          {name}
        </Text>
      </Billboard>
    </group>
  )
}

export default function NeuralPulseDemo() {
  const timeRef = useRef(0)
  const cycleRef = useRef(0)
  const rippleRef = useRef()
  const rippleProgress = useRef(-1)
  const nucleusFlashRef = useRef()
  const agentFlashes = useRef(Array(AGENT_COUNT).fill(0))
  const spinningAgent = useRef(-1)
  const delegationArcRef = useRef()
  const delegationTarget = useRef(-1)
  const delegationProgress = useRef(-1)
  const completionFlash = useRef(-1)

  const agentPositions = useMemo(() =>
    Array.from({ length: AGENT_COUNT }, (_, i) => {
      const a = (i / AGENT_COUNT) * Math.PI * 2
      return [Math.cos(a) * AGENT_R, 0, Math.sin(a) * AGENT_R]
    }),
  [])

  const delegationCurve = useMemo(() => {
    // Will be recreated each cycle
    return { current: null }
  }, [])

  useFrame((_, delta) => {
    timeRef.current += delta
    cycleRef.current += delta
    const cycle = cycleRef.current % 12

    // Reset at cycle start
    if (cycleRef.current > 12) {
      cycleRef.current -= 12
      spinningAgent.current = -1
      completionFlash.current = -1
    }

    // T+0-0.3: Nucleus flares
    if (cycle < 0.3) {
      if (nucleusFlashRef.current) {
        nucleusFlashRef.current.material.emissiveIntensity = 2 * (1 - cycle / 0.3)
      }
    }

    // T+0.3: Fire ripple
    if (cycle >= 0.3 && rippleProgress.current < 0) {
      rippleProgress.current = 0
    }

    // Expand ripple
    if (rippleProgress.current >= 0 && rippleProgress.current < 1) {
      rippleProgress.current += delta / 2.5
      if (rippleRef.current) {
        const r = rippleProgress.current * 15
        rippleRef.current.scale.set(r, r, r)
        rippleRef.current.material.opacity = (1 - rippleProgress.current) * 0.3
        rippleRef.current.visible = true
      }

      // Flash agents as ripple passes them
      const rippleR = rippleProgress.current * 15
      agentPositions.forEach((pos, i) => {
        const dist = Math.sqrt(pos[0] * pos[0] + pos[2] * pos[2])
        if (Math.abs(rippleR - dist) < 1.5) {
          agentFlashes.current[i] = 1
        }
      })
    } else if (rippleRef.current) {
      rippleRef.current.visible = false
    }

    // Decay agent flashes
    for (let i = 0; i < AGENT_COUNT; i++) {
      agentFlashes.current[i] = Math.max(0, agentFlashes.current[i] - delta * 3)
    }

    // T+4: Fire delegation arc to random agent
    if (cycle >= 4 && delegationTarget.current < 0) {
      delegationTarget.current = Math.floor(Math.random() * AGENT_COUNT)
      delegationProgress.current = 0
      const tp = agentPositions[delegationTarget.current]
      delegationCurve.current = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(tp[0] / 2, 3, tp[2] / 2),
        new THREE.Vector3(tp[0], tp[1], tp[2]),
      ])
    }

    // Animate delegation arc
    if (delegationProgress.current >= 0 && delegationProgress.current < 1) {
      delegationProgress.current += delta / 1.2
      if (delegationArcRef.current && delegationCurve.current) {
        const t = Math.min(delegationProgress.current, 1)
        const p = delegationCurve.current.getPoint(t)
        delegationArcRef.current.position.set(p.x, p.y, p.z)
        delegationArcRef.current.visible = true
      }
    } else if (delegationArcRef.current) {
      delegationArcRef.current.visible = false
    }

    // T+5.2: Delegation arrives, agent starts spinning
    if (cycle >= 5.2 && delegationTarget.current >= 0 && spinningAgent.current < 0) {
      spinningAgent.current = delegationTarget.current
      agentFlashes.current[delegationTarget.current] = 1
    }

    // T+8.2: Agent completes
    if (cycle >= 8.2 && completionFlash.current < 0 && spinningAgent.current >= 0) {
      completionFlash.current = spinningAgent.current
      agentFlashes.current[spinningAgent.current] = 1
    }

    // T+9: Reset for next cycle
    if (cycle >= 9) {
      rippleProgress.current = -1
      delegationTarget.current = -1
      delegationProgress.current = -1
    }
  })

  return (
    <group>
      {/* Nucleus */}
      <NucleusCore />

      {/* Nucleus flash overlay */}
      <mesh ref={nucleusFlashRef}>
        <sphereGeometry args={[1.8, 16, 16]} />
        <meshStandardMaterial
          color="white"
          emissive="white"
          emissiveIntensity={0}
          transparent
          opacity={0.15}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Ripple ring */}
      <mesh ref={rippleRef} rotation={[Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[1, 0.04, 8, 64]} />
        <meshBasicMaterial
          color={PALETTE.indigo}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Agent nodes */}
      {AGENT_NAMES.map((name, i) => (
        <AgentNodeSmall
          key={name}
          position={agentPositions[i]}
          color={completionFlash.current === i ? PALETTE.done : AGENT_COLORS[i]}
          name={name}
          flashRef={agentFlashes}
          spinningRef={spinningAgent}
          index={i}
        />
      ))}

      {/* Delegation arc particle */}
      <mesh ref={delegationArcRef} visible={false}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial
          color={PALETTE.delegation}
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Centre label */}
      <Billboard position={[0, 3, 0]}>
        <Text fontSize={0.3} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.7}>
          NEURAL PULSE
        </Text>
        <Text fontSize={0.15} color={PALETTE.indigo} anchorX="center" position={[0, -0.3, 0]} fillOpacity={0.4}>
          thought propagation
        </Text>
      </Billboard>
    </group>
  )
}
