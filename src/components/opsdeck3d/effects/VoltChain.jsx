/**
 * VoltChain — VOLT evidence chain visualisation.
 *
 * A DNA-like double helix orbiting the execution zone at r=32,
 * slowly rotating. Each "rung" is an evidence envelope node.
 * Faint connection lines link adjacent nodes (hash chain).
 *
 * Renders real VOLT records passed via the `records` prop. No caller in
 * this scene currently wires a real records feed in — until one does,
 * this renders an empty helix (no fabricated evidence nodes) rather than
 * painting mock records as real.
 */
import { useRef, useMemo, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Line } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const VOLT_COLOR = '#06b6d4'
const NODE_SCALE = 0.15
const HELIX_RADIUS = 2  // helix strand radius
const ORBIT_RADIUS = 32 // distance from scene centre
const NODE_COUNT = 12    // total nodes (6 per strand)
const ROTATION_SPEED = 0.02

// ─── Single Helix Node ─────────────────────────────────────
function HelixNode({ position, record, onSelect }) {
  const wireRef = useRef()
  const innerRef = useRef()

  const color = useMemo(() => new THREE.Color(VOLT_COLOR), [])

  const handleClick = useCallback(() => {
    if (record) {
      onSelect?.({ type: 'volt', id: record.id, hash: record.hash, action: record.action, agent: record.agent })
    }
  }, [onSelect, record])

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
    <group position={position}>
      {/* Invisible hitbox for click detection */}
      {record && (
        <mesh
          onClick={handleClick}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer' }}
          onPointerOut={() => { document.body.style.cursor = 'auto' }}
          visible={false}
        >
          <sphereGeometry args={[NODE_SCALE * 2.5, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>
      )}

      {/* Outer wireframe */}
      <mesh ref={wireRef} scale={NODE_SCALE}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={0.3}
        />
      </mesh>

      {/* Inner solid core */}
      <mesh ref={innerRef} scale={NODE_SCALE * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.7}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -NODE_SCALE * 0.5, 0]}>
        <circleGeometry args={[NODE_SCALE * 0.6, 8]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

// ─── VoltChain (group) ──────────────────────────────────────
export default function VoltChain({ settings = {}, onSelect, records = [] }) {
  const groupRef = useRef()

  // Compute helix positions for both strands
  const { strand1, strand2, links } = useMemo(() => {
    const s1 = []
    const s2 = []
    const lk = []

    for (let i = 0; i < NODE_COUNT; i++) {
      const t = i / NODE_COUNT
      const angle = t * Math.PI * 4 // 2 full rotations
      const y = (t - 0.5) * 8       // spread vertically -4 to +4

      // Strand 1
      const x1 = Math.cos(angle) * HELIX_RADIUS + ORBIT_RADIUS
      const z1 = Math.sin(angle) * HELIX_RADIUS
      s1.push([x1, y, z1])

      // Strand 2 (offset by PI)
      const x2 = Math.cos(angle + Math.PI) * HELIX_RADIUS + ORBIT_RADIUS
      const z2 = Math.sin(angle + Math.PI) * HELIX_RADIUS
      s2.push([x2, y, z2])

      // Cross-link between strands at this level
      lk.push({ from: [x1, y, z1], to: [x2, y, z2] })
    }

    return { strand1: s1, strand2: s2, links: lk }
  }, [])

  // Chain links along each strand
  const strandLinks1 = useMemo(() => {
    const pts = []
    for (let i = 0; i < strand1.length - 1; i++) {
      pts.push({ from: strand1[i], to: strand1[i + 1] })
    }
    return pts
  }, [strand1])

  const strandLinks2 = useMemo(() => {
    const pts = []
    for (let i = 0; i < strand2.length - 1; i++) {
      pts.push({ from: strand2[i], to: strand2[i + 1] })
    }
    return pts
  }, [strand2])

  // Slow rotation of the whole helix
  useFrame((_, delta) => {
    try {
      if (groupRef.current) {
        groupRef.current.rotation.y += delta * ROTATION_SPEED
      }
    } catch { /* ref not ready */ }
  })

  const lineColor = new THREE.Color(VOLT_COLOR)

  return (
    <group ref={groupRef}>
      {/* Strand 1 nodes — only rendered against real VOLT records */}
      {records.length > 0 && strand1.map((pos, i) => (
        <HelixNode key={`s1-${i}`} position={pos} record={records[i % records.length]} onSelect={onSelect} />
      ))}

      {/* Strand 2 nodes — only rendered against real VOLT records */}
      {records.length > 0 && strand2.map((pos, i) => (
        <HelixNode key={`s2-${i}`} position={pos} record={records[i % records.length]} onSelect={onSelect} />
      ))}

      {/* Strand 1 chain links */}
      {strandLinks1.map((link, i) => (
        <Line
          key={`l1-${i}`}
          points={[link.from, link.to]}
          color={lineColor}
          lineWidth={0.5}
          transparent
          opacity={0.12}
        />
      ))}

      {/* Strand 2 chain links */}
      {strandLinks2.map((link, i) => (
        <Line
          key={`l2-${i}`}
          points={[link.from, link.to]}
          color={lineColor}
          lineWidth={0.5}
          transparent
          opacity={0.12}
        />
      ))}

      {/* Cross-links (rungs) */}
      {links.map((link, i) => (
        <Line
          key={`rung-${i}`}
          points={[link.from, link.to]}
          color={lineColor}
          lineWidth={0.3}
          transparent
          opacity={0.06}
        />
      ))}

      {/* Zone label */}
      <Billboard position={[ORBIT_RADIUS, 5.5, 0]}>
        <Text
          fontSize={0.28}
          color={VOLT_COLOR}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.018}
          outlineColor="#000000"
          fillOpacity={settings.zoneLabelOpacity ?? 0.3}
          letterSpacing={0.15}
        >
          VOLT CHAIN
        </Text>
      </Billboard>
    </group>
  )
}
