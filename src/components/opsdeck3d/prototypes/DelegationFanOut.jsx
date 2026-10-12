/**
 * DelegationFanOut — QUOX fans out to 5 agents simultaneously.
 *
 * QUOX node at centre, 5 agents in a semicircle. Every 5s QUOX expands
 * and fires 5 staggered delegation arcs. Agents flash on arrival, spin
 * scanning rings, then all complete after 3s.
 */
import { useRef, useMemo, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const AGENT_NAMES = ['WARDEN', 'CIPHER', 'HYPERION', 'DAEDALUS', 'METRICS']
const AGENT_COLORS = [PALETTE.executing, PALETTE.thinking, PALETTE.reading, PALETTE.violet, PALETTE.cyan]
const ARC_LABELS = ['port scan', 'auth audit', 'log parse', 'cert check', 'dns verify']
const R = 10
const STAGGER_MS = 0.15 // seconds between each arc

function getAgentPos(index) {
  const angle = Math.PI * 0.2 + (index / (AGENT_NAMES.length - 1)) * Math.PI * 0.6
  return [Math.cos(angle) * R, 0, -Math.sin(angle) * R]
}

function ArcParticle({ from, to, color, delay, onArrive }) {
  const ref = useRef()
  const progressRef = useRef(-delay)
  const arrivedRef = useRef(false)
  const duration = 1.2

  const curve = useMemo(() => {
    const mid = [
      (from[0] + to[0]) / 2 + (Math.random() - 0.5) * 2,
      (from[1] + to[1]) / 2 + 3 + Math.random() * 3,
      (from[2] + to[2]) / 2 + (Math.random() - 0.5) * 2,
    ]
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(...from),
      new THREE.Vector3(...mid),
      new THREE.Vector3(...to),
    ])
  }, [from, to])

  useFrame((_, delta) => {
    progressRef.current += delta
    if (progressRef.current < 0) return
    const t = Math.min(progressRef.current / duration, 1)
    if (ref.current) {
      const p = curve.getPoint(t)
      ref.current.position.set(p.x, p.y, p.z)
      ref.current.visible = t < 1
    }
    if (t >= 1 && !arrivedRef.current) {
      arrivedRef.current = true
      onArrive?.()
    }
  })

  return (
    <mesh ref={ref} visible={false}>
      <sphereGeometry args={[0.15, 8, 8]} />
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

function ArcTrail({ from, to, color, delay }) {
  const trailRef = useRef()
  const progressRef = useRef(-delay)
  const particleCount = 20
  const duration = 1.2

  const curve = useMemo(() => {
    const mid = [
      (from[0] + to[0]) / 2,
      (from[1] + to[1]) / 2 + 4,
      (from[2] + to[2]) / 2,
    ]
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(...from),
      new THREE.Vector3(...mid),
      new THREE.Vector3(...to),
    ])
  }, [from, to])

  const positions = useMemo(() => new Float32Array(particleCount * 3), [particleCount])

  useFrame((_, delta) => {
    progressRef.current += delta
    if (progressRef.current < 0 || !trailRef.current) return
    const head = Math.min(progressRef.current / duration, 1.2)
    const posAttr = trailRef.current.geometry.attributes.position

    for (let i = 0; i < particleCount; i++) {
      const t = head - (i / particleCount) * 0.25
      if (t < 0 || t > 1) {
        posAttr.array[i * 3] = -999
        posAttr.array[i * 3 + 1] = -999
        posAttr.array[i * 3 + 2] = -999
      } else {
        const p = curve.getPoint(t)
        posAttr.array[i * 3] = p.x
        posAttr.array[i * 3 + 1] = p.y
        posAttr.array[i * 3 + 2] = p.z
      }
    }
    posAttr.needsUpdate = true
  })

  return (
    <points ref={trailRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={particleCount} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        size={0.12}
        color={color}
        transparent
        opacity={0.6}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

function AgentOctNode({ position, color, name, flash, spinning }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const ringRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const flashVal = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (flash) flashVal.current = Math.min(1, flashVal.current + delta * 8)
    else flashVal.current = Math.max(0, flashVal.current - delta * 3)

    if (wireRef.current) wireRef.current.rotation.y += delta * 0.12
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.08
      const emissive = 0.7 + flashVal.current * 0.8
      innerRef.current.material.emissiveIntensity = emissive
    }
    if (ringRef.current && spinning) {
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
          emissiveIntensity={0.7}
          transparent
          opacity={0.75}
          roughness={0.2}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.7, 0]}>
        <circleGeometry args={[scale * 1.0, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {spinning && (
        <group ref={ringRef} rotation={[0.5, 0.3, 0]}>
          <mesh>
            <torusGeometry args={[scale * 1.5, 0.012, 8, 32]} />
            <meshBasicMaterial color={color} transparent opacity={0.4} />
          </mesh>
        </group>
      )}
      <Billboard position={[0, scale * 1.3, 0]}>
        <Text fontSize={0.24} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.7}>
          {name}
        </Text>
      </Billboard>
    </group>
  )
}

export default function DelegationFanOut() {
  const quoxRef = useRef()
  const quoxInnerRef = useRef()
  const timeRef = useRef(0)
  const cycleRef = useRef(0)
  const [phase, setPhase] = useState('idle') // idle | firing | active | complete
  const [arrivedCount, setArrivedCount] = useState(0)
  const [agentFlash, setAgentFlash] = useState(Array(5).fill(false))
  const [agentSpinning, setAgentSpinning] = useState(Array(5).fill(false))
  const [showArcs, setShowArcs] = useState(false)
  const quoxScale = useRef(NODE_SCALES.orchestrator)

  const agentPositions = useMemo(() =>
    AGENT_NAMES.map((_, i) => getAgentPos(i)),
  [])

  const handleArrive = (idx) => {
    setArrivedCount(c => c + 1)
    setAgentFlash(prev => { const n = [...prev]; n[idx] = true; return n })
    setAgentSpinning(prev => { const n = [...prev]; n[idx] = true; return n })
    // Flash off after 0.3s
    setTimeout(() => {
      setAgentFlash(prev => { const n = [...prev]; n[idx] = false; return n })
    }, 300)
  }

  useFrame((_, delta) => {
    timeRef.current += delta
    cycleRef.current += delta

    // QUOX breathe
    if (quoxRef.current) {
      const breathe = phase === 'firing'
        ? 1.2
        : 1.0 + Math.sin(timeRef.current * 0.8) * 0.03
      quoxScale.current = NODE_SCALES.orchestrator * breathe
      quoxRef.current.scale.setScalar(quoxScale.current)
    }
    if (quoxInnerRef.current) {
      quoxInnerRef.current.rotation.y -= delta * 0.08
    }

    // State machine
    if (phase === 'idle' && cycleRef.current > 5) {
      setPhase('firing')
      setShowArcs(true)
      setArrivedCount(0)
      cycleRef.current = 0
    }
    if (phase === 'firing' && arrivedCount >= 5) {
      setPhase('active')
      cycleRef.current = 0
    }
    if (phase === 'active' && cycleRef.current > 3) {
      setPhase('complete')
      // All flash green
      setAgentFlash(Array(5).fill(true))
      cycleRef.current = 0
    }
    if (phase === 'complete' && cycleRef.current > 1) {
      setPhase('idle')
      setShowArcs(false)
      setAgentFlash(Array(5).fill(false))
      setAgentSpinning(Array(5).fill(false))
      setArrivedCount(0)
      cycleRef.current = 0
    }
  })

  return (
    <group>
      {/* QUOX centre node */}
      <group position={[0, 0, 0]}>
        <mesh ref={quoxRef} scale={NODE_SCALES.orchestrator}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color={PALETTE.indigo} wireframe transparent opacity={0.35} />
        </mesh>
        <mesh ref={quoxInnerRef} scale={NODE_SCALES.orchestrator * 0.65}>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial
            color={PALETTE.indigo}
            emissive={PALETTE.indigo}
            emissiveIntensity={0.9}
            transparent
            opacity={0.8}
            roughness={0.2}
          />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -NODE_SCALES.orchestrator * 0.8, 0]}>
          <circleGeometry args={[NODE_SCALES.orchestrator * 1.2, 16]} />
          <meshBasicMaterial
            color={PALETTE.indigo}
            transparent
            opacity={0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        <Billboard position={[0, NODE_SCALES.orchestrator * 1.6, 0]}>
          <Text fontSize={0.4} color="white" anchorX="center" outlineWidth={0.03} outlineColor="#000" fillOpacity={0.85}>
            QUOX
          </Text>
          <Text fontSize={0.18} color={PALETTE.indigo} anchorX="center" position={[0, -0.35, 0]} fillOpacity={0.5}>
            orchestrator
          </Text>
        </Billboard>
      </group>

      {/* Agent nodes */}
      {AGENT_NAMES.map((name, i) => (
        <AgentOctNode
          key={name}
          position={agentPositions[i]}
          color={phase === 'complete' ? PALETTE.done : AGENT_COLORS[i]}
          name={name}
          flash={agentFlash[i]}
          spinning={agentSpinning[i]}
        />
      ))}

      {/* Arc labels at midpoints */}
      {showArcs && ARC_LABELS.map((label, i) => {
        const ap = agentPositions[i]
        const mid = [ap[0] / 2, 3.5, ap[2] / 2]
        return (
          <Billboard key={i} position={mid}>
            <Text fontSize={0.16} color={PALETTE.delegation} anchorX="center" fillOpacity={0.5}>
              {label}
            </Text>
          </Billboard>
        )
      })}

      {/* Delegation arcs */}
      {showArcs && AGENT_NAMES.map((_, i) => (
        <group key={`arc-${i}`}>
          <ArcTrail
            from={[0, 0, 0]}
            to={agentPositions[i]}
            color={PALETTE.delegation}
            delay={i * STAGGER_MS}
          />
          <ArcParticle
            from={[0, 0, 0]}
            to={agentPositions[i]}
            color={PALETTE.delegation}
            delay={i * STAGGER_MS}
            onArrive={() => handleArrive(i)}
          />
        </group>
      ))}
    </group>
  )
}
