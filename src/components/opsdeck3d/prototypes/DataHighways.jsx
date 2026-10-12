/**
 * DataHighways — Persistent particle streams showing data flow between zones.
 *
 * Not delegation arcs (one-shot). These are always-on rivers of data:
 *   Nucleus → Implants (health checks)
 *   Implants → Agents (capability feed)
 *   Agents → Execution (task assignment)
 *   Execution → Memory (knowledge crystallisation)
 *
 * Each highway is a CatmullRom spline with continuously flowing particles.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const HIGHWAYS = [
  {
    name: 'Health Pulse',
    color: PALETTE.violet,
    points: [[0, 0, 0], [3, 1, 4], [6, 0.5, 6], [8, 0, 0]],
    speed: 0.8,
    width: 0.4,
    particleCount: 20,
  },
  {
    name: 'Capability Feed',
    color: PALETTE.indigo,
    points: [[8, 0, 0], [10, 1.5, 5], [12, 0, 10], [15, -0.5, 0]],
    speed: 0.6,
    width: 0.3,
    particleCount: 18,
  },
  {
    name: 'Task Stream',
    color: PALETTE.executing,
    points: [[15, 0, 0], [18, 2, 8], [22, 0, 12], [28, 0, 0]],
    speed: 1.0,
    width: 0.5,
    particleCount: 25,
  },
  {
    name: 'Knowledge Flow',
    color: '#ec4899',
    points: [[28, 0, 0], [32, 3, -8], [38, 1, -12], [44, 0, 0]],
    speed: 0.4,
    width: 0.3,
    particleCount: 15,
  },
]

function Highway({ highway }) {
  const pointsRef = useRef()
  const timeRef = useRef(Math.random() * 100)

  const { curve, positions, sizes } = useMemo(() => {
    const pts = highway.points.map(p => new THREE.Vector3(...p))
    const curve = new THREE.CatmullRomCurve3(pts)
    return {
      curve,
      positions: new Float32Array(highway.particleCount * 3),
      sizes: new Float32Array(highway.particleCount),
    }
  }, [highway])

  // Visible spline path
  const pathPoints = useMemo(() => curve.getPoints(50), [curve])

  useFrame((_, delta) => {
    timeRef.current += delta * highway.speed

    if (pointsRef.current) {
      const posAttr = pointsRef.current.geometry.attributes.position
      const sizeAttr = pointsRef.current.geometry.attributes.size

      for (let i = 0; i < highway.particleCount; i++) {
        const t = ((timeRef.current * 0.3 + i / highway.particleCount) % 1)
        const p = curve.getPoint(t)

        // Slight jitter for width
        const jx = (Math.sin(timeRef.current * 3 + i * 7) * 0.5) * highway.width * 0.3
        const jy = (Math.cos(timeRef.current * 2 + i * 11) * 0.5) * highway.width * 0.3

        posAttr.array[i * 3] = p.x + jx
        posAttr.array[i * 3 + 1] = p.y + jy
        posAttr.array[i * 3 + 2] = p.z + jx * 0.5

        // Size: larger in middle of stream, smaller at edges
        const edgeFade = Math.sin(t * Math.PI) // 0 at ends, 1 at middle
        sizeAttr.array[i] = 0.04 + edgeFade * 0.08
      }
      posAttr.needsUpdate = true
      sizeAttr.needsUpdate = true
    }
  })

  const col = new THREE.Color(highway.color)

  return (
    <group>
      {/* Visible spline path — the highway track */}
      <line geometry={new THREE.BufferGeometry().setFromPoints(pathPoints)}>
        <lineBasicMaterial color={highway.color} transparent opacity={0.06} />
      </line>

      {/* Flowing particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={positions} count={highway.particleCount} itemSize={3} />
          <bufferAttribute attach="attributes-size" array={sizes} count={highway.particleCount} itemSize={1} />
        </bufferGeometry>
        <pointsMaterial
          size={0.08}
          color={col}
          transparent
          opacity={0.6}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Highway label at midpoint */}
      <Billboard position={curve.getPoint(0.5).toArray().map((v, i) => i === 1 ? v + 0.6 : v)}>
        <Text fontSize={0.15} color={highway.color} anchorX="center" fillOpacity={0.2} outlineWidth={0.01} outlineColor="#000">
          {highway.name}
        </Text>
      </Billboard>
    </group>
  )
}

export default function DataHighways() {
  return (
    <group>
      {HIGHWAYS.map((hw, i) => (
        <Highway key={i} highway={hw} />
      ))}

      {/* Zone markers at highway endpoints */}
      {[
        { pos: [0, -0.5, 0], label: 'NUCLEUS', color: PALETTE.indigo },
        { pos: [8, -0.5, 0], label: 'IMPLANTS', color: PALETTE.violet },
        { pos: [15, -0.5, 0], label: 'AGENTS', color: PALETTE.indigo },
        { pos: [28, -0.5, 0], label: 'EXECUTION', color: PALETTE.executing },
        { pos: [44, -0.5, 0], label: 'MEMORY', color: '#ec4899' },
      ].map((z, i) => (
        <Billboard key={i} position={z.pos}>
          <Text fontSize={0.2} color={z.color} anchorX="center" fillOpacity={0.3} outlineWidth={0.015} outlineColor="#000">
            {z.label}
          </Text>
        </Billboard>
      ))}
    </group>
  )
}
