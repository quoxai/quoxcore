/**
 * CrystalField — Memory crystal field on 3 tilted orbital tracks.
 *
 * 30 crystals (stretched octahedrons) drifting on tilted orbits.
 * Open-loop crystals pulse. Relationship threads connect related crystals.
 * Focus beam highlights one crystal. Legend at bottom.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, MEMORY_VARIANTS } from '../lib/design-system'

const ORBIT_TRACKS = [
  { radius: 8, tilt: 15 * Math.PI / 180, count: 8 },
  { radius: 11, tilt: 35 * Math.PI / 180, count: 12 },
  { radius: 14, tilt: 55 * Math.PI / 180, count: 10 },
]

const CRYSTAL_TYPES = ['entity', 'fact', 'decision', 'preference', 'openLoop', 'error']
const CRYSTAL_LABELS = [
  'entity: docker01', 'fact: nginx port 443', 'decision: use SQLite',
  'entity: hyp-01', 'preference: verbose logs', 'openLoop: SSL cert expiry',
  'fact: 16 agents', 'entity: gw-01', 'decision: flat hierarchy',
  'entity: kuma01', 'fact: bastion SSH', 'preference: UK English',
  'openLoop: backup audit', 'entity: docker02', 'decision: QuoxFlow',
  'fact: memory 3-tier', 'entity: collector', 'preference: dark theme',
  'openLoop: cert renewal', 'fact: 50 hosts', 'entity: docker03',
  'decision: OAuth primary', 'entity: hyp-02', 'fact: FTS5 search',
  'preference: concise replies', 'openLoop: DNS config', 'entity: docker04',
  'decision: additive blend', 'fact: 18 plugins', 'entity: hyp-03',
]

// Pre-generate relationships (indices of crystals that share tags)
const RELATIONSHIPS = [
  [0, 3], [0, 9], [3, 9], [1, 10], [2, 8],
  [5, 12], [5, 18], [12, 25], [6, 15], [7, 16],
  [4, 11], [14, 21], [20, 26],
]

function Crystal({ position, type, label, index, focusIndex, timeOffset }) {
  const meshRef = useRef()
  const wireRef = useRef()
  const variant = MEMORY_VARIANTS[type] || MEMORY_VARIANTS.entity
  const isOpenLoop = type === 'openLoop'
  const isFocused = index === focusIndex
  const timeRef = useRef(timeOffset)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.15
      meshRef.current.rotation.x += delta * 0.05
      if (isOpenLoop) {
        const pulse = 1 + Math.sin(timeRef.current * 3) * 0.15
        meshRef.current.scale.set(0.4 * pulse, 0.4 * variant.scaleY * pulse, 0.4 * pulse)
      }
    }
    if (wireRef.current) {
      wireRef.current.rotation.y += delta * 0.2
    }
  })

  const scale = 0.4

  return (
    <group position={position}>
      {/* Wireframe */}
      <mesh ref={wireRef} scale={[scale, scale * variant.scaleY, scale]}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={variant.color} wireframe transparent opacity={0.35} />
      </mesh>

      {/* Inner core */}
      <mesh ref={meshRef} scale={[scale * 0.65, scale * variant.scaleY * 0.65, scale * 0.65]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={variant.color}
          emissive={variant.color}
          emissiveIntensity={isOpenLoop ? 1.0 : isFocused ? 0.9 : 0.5}
          transparent
          opacity={isOpenLoop ? 0.9 : 0.7}
          roughness={0.2}
        />
      </mesh>

      {/* Ground glow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.6, 0]}>
        <circleGeometry args={[scale * 0.8, 12]} />
        <meshBasicMaterial
          color={variant.color}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Label */}
      <Billboard position={[0, scale * variant.scaleY + 0.4, 0]}>
        <Text
          fontSize={0.18}
          color={variant.color}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.55}
          outlineWidth={0.015}
          outlineColor="#000000"
        >
          {label}
        </Text>
      </Billboard>
    </group>
  )
}

function OrbitTrack({ radius, tilt, color = PALETTE.memory, opacity = 0.06, segments = 96 }) {
  const geometry = useMemo(() => {
    const points = []
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      points.push(new THREE.Vector3(
        Math.cos(a) * radius,
        Math.sin(a) * radius * Math.sin(tilt),
        Math.sin(a) * radius * Math.cos(tilt),
      ))
    }
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [radius, tilt, segments])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

function RelationshipThread({ from, to, color = PALETTE.memory }) {
  const geometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from),
      new THREE.Vector3(...to),
    ])
  }, [from, to])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.04} depthWrite={false} />
    </line>
  )
}

function LegendItem({ position, type, label }) {
  const variant = MEMORY_VARIANTS[type] || MEMORY_VARIANTS.entity
  return (
    <group position={position}>
      <mesh scale={[0.2, 0.2 * variant.scaleY, 0.2]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={variant.color}
          emissive={variant.color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.8}
        />
      </mesh>
      <Billboard position={[0, -0.4, 0]}>
        <Text fontSize={0.13} color={variant.color} anchorX="center" fillOpacity={0.7}>
          {label}
        </Text>
      </Billboard>
    </group>
  )
}

export default function CrystalField() {
  const groupRef = useRef()
  const timeRef = useRef(0)
  const focusIndex = 5 // The openLoop: SSL cert expiry crystal

  // Pre-compute crystal data
  const crystals = useMemo(() => {
    const result = []
    let idx = 0
    ORBIT_TRACKS.forEach((track) => {
      for (let i = 0; i < track.count; i++) {
        const baseAngle = (i / track.count) * Math.PI * 2
        result.push({
          track,
          baseAngle,
          type: CRYSTAL_TYPES[idx % CRYSTAL_TYPES.length],
          label: CRYSTAL_LABELS[idx] || `crystal ${idx}`,
          index: idx,
          timeOffset: Math.random() * 100,
        })
        idx++
      }
    })
    return result
  }, [])

  // Animated positions
  const positionsRef = useRef(crystals.map(() => [0, 0, 0]))

  useFrame((_, delta) => {
    timeRef.current += delta
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.02
    }
    // Update crystal positions
    crystals.forEach((c, i) => {
      const a = c.baseAngle + timeRef.current * 0.05
      const r = c.track.radius
      const tilt = c.track.tilt
      positionsRef.current[i] = [
        Math.cos(a) * r,
        Math.sin(a) * r * Math.sin(tilt),
        Math.sin(a) * r * Math.cos(tilt),
      ]
    })
  })

  return (
    <group ref={groupRef}>
      {/* Orbit tracks */}
      {ORBIT_TRACKS.map((track, i) => (
        <OrbitTrack key={i} radius={track.radius} tilt={track.tilt} />
      ))}

      {/* Crystals */}
      {crystals.map((c) => (
        <Crystal
          key={c.index}
          position={positionsRef.current[c.index]}
          type={c.type}
          label={c.label}
          index={c.index}
          focusIndex={focusIndex}
          timeOffset={c.timeOffset}
        />
      ))}

      {/* Relationship threads */}
      {RELATIONSHIPS.map(([a, b], i) => (
        <RelationshipThread
          key={i}
          from={positionsRef.current[a] || [0, 0, 0]}
          to={positionsRef.current[b] || [0, 0, 0]}
        />
      ))}

      {/* Focus beam — faint cylinder from centre to focus crystal */}
      <mesh
        position={[0, 0, 0]}
        rotation={[0, 0, 0]}
      >
        <cylinderGeometry args={[0.02, 0.02, 1, 8]} />
        <meshBasicMaterial
          color={PALETTE.indigo}
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Legend at bottom */}
      <group position={[-4, -8, 0]}>
        <Billboard position={[3.5, 1, 0]}>
          <Text fontSize={0.2} color="white" anchorX="center" fillOpacity={0.5}>
            MEMORY TYPES
          </Text>
        </Billboard>
        {['entity', 'fact', 'decision', 'preference', 'openLoop', 'error'].map((type, i) => (
          <LegendItem
            key={type}
            position={[i * 1.4, 0, 0]}
            type={type}
            label={type === 'openLoop' ? 'open loop' : type}
          />
        ))}
      </group>
    </group>
  )
}
