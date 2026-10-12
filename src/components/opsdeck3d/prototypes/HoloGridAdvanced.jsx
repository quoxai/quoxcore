/**
 * HoloGridAdvanced — Enhanced holo-grid with hex cells and data readouts.
 *
 * Pointy-top hexagonal grid. Activation wave sweeps across every 6s.
 * Some cells have tiny Billboard data readouts. Optional radar sweep line.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

// Generate pointy-top hex vertices
function hexVertices(cx, cz, size) {
  const verts = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6 // pointy-top
    verts.push([cx + size * Math.cos(angle), cz + size * Math.sin(angle)])
  }
  return verts
}

// Generate hex grid positions (axial coordinates)
function generateHexGrid(radius, hexSize) {
  const cells = []
  const spacing = hexSize * 1.75
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) > radius) continue
      const x = spacing * (q + r * 0.5)
      const z = spacing * r * (Math.sqrt(3) / 2)
      cells.push({ q, r, x, z })
    }
  }
  return cells
}

function HexCell({ x, z, size, activeRef, index, hasData, dataValue }) {
  const meshRef = useRef()
  const timeRef = useRef(Math.random() * 10)

  const geometry = useMemo(() => {
    const verts = hexVertices(0, 0, size)
    const shape = new THREE.Shape()
    shape.moveTo(verts[0][0], verts[0][1])
    for (let i = 1; i < 6; i++) shape.lineTo(verts[i][0], verts[i][1])
    shape.closePath()
    const geo = new THREE.ShapeGeometry(shape)
    return geo
  }, [size])

  useFrame((_, delta) => {
    timeRef.current += delta
    if (meshRef.current) {
      const isActive = activeRef.current[index] > 0
      const baseOpacity = isActive ? 0.12 + activeRef.current[index] * 0.08 : 0.02
      meshRef.current.material.opacity = baseOpacity
      meshRef.current.material.emissiveIntensity = isActive ? 0.4 + activeRef.current[index] * 0.3 : 0.05
    }
  })

  return (
    <group position={[x, 0, z]}>
      <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} geometry={geometry}>
        <meshStandardMaterial
          color={PALETTE.indigo}
          emissive={PALETTE.indigo}
          emissiveIntensity={0.05}
          transparent
          opacity={0.02}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Hex border */}
      {(() => {
        const verts = hexVertices(0, 0, size)
        const points = verts.map(v => new THREE.Vector3(v[0], 0, v[1]))
        points.push(points[0].clone())
        return (
          <line geometry={new THREE.BufferGeometry().setFromPoints(points)} rotation={[0, 0, 0]} position={[0, 0.01, 0]}>
            <lineBasicMaterial color={PALETTE.indigo} transparent opacity={0.06} />
          </line>
        )
      })()}
      {/* Data readout */}
      {hasData && (
        <Billboard position={[0, 0.3, 0]}>
          <Text fontSize={0.12} color={PALETTE.indigo} anchorX="center" fillOpacity={0.5}>
            {dataValue}
          </Text>
        </Billboard>
      )}
    </group>
  )
}

function RadarSweep({ radius, speed = 1 }) {
  const lineRef = useRef()
  const timeRef = useRef(0)

  const geometry = useMemo(() => {
    const points = [new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(radius, 0.05, 0)]
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [radius])

  useFrame((_, delta) => {
    timeRef.current += delta * speed
    if (lineRef.current) {
      lineRef.current.rotation.y = timeRef.current * 0.5
    }
  })

  return (
    <group ref={lineRef}>
      <line geometry={geometry}>
        <lineBasicMaterial
          color={PALETTE.cyan}
          transparent
          opacity={0.25}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </line>
      {/* Sweep glow */}
      <mesh position={[radius / 2, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[radius, 0.3]} />
        <meshBasicMaterial
          color={PALETTE.cyan}
          transparent
          opacity={0.04}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

export default function HoloGridAdvanced({ gridRadius = 8, hexSize = 0.8 }) {
  const cells = useMemo(() => generateHexGrid(gridRadius, hexSize), [gridRadius, hexSize])
  const activeRef = useRef(cells.map(() => 0))
  const timeRef = useRef(0)
  const sweepAngle = useRef(0)

  // Determine which cells get data readouts
  const cellData = useMemo(() => {
    return cells.map((cell, i) => ({
      hasData: Math.random() < 0.08,
      dataValue: (Math.random() * 100).toFixed(0),
    }))
  }, [cells])

  useFrame((_, delta) => {
    timeRef.current += delta

    // Sweep wave every 6s
    const cycle = timeRef.current % 6
    const sweepProgress = cycle / 3 // 0 to 2, wave takes 3s

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      const dist = Math.sqrt(cell.x * cell.x + cell.z * cell.z)
      const maxDist = gridRadius * hexSize * 1.75
      const normalizedDist = dist / maxDist

      // Wave activation
      const waveFront = sweepProgress
      const distFromWave = Math.abs(normalizedDist - waveFront)

      if (distFromWave < 0.15 && sweepProgress < 1.2) {
        activeRef.current[i] = Math.max(activeRef.current[i], 1 - distFromWave / 0.15)
      } else {
        activeRef.current[i] = Math.max(0, activeRef.current[i] - delta * 1.5)
      }
    }
  })

  return (
    <group>
      {cells.map((cell, i) => (
        <HexCell
          key={i}
          x={cell.x}
          z={cell.z}
          size={hexSize}
          activeRef={activeRef}
          index={i}
          hasData={cellData[i].hasData}
          dataValue={cellData[i].dataValue}
        />
      ))}

      {/* Radar sweep */}
      <RadarSweep radius={gridRadius * hexSize * 1.75} speed={0.8} />

      {/* Centre marker */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.3, 0.35, 16]} />
        <meshBasicMaterial
          color={PALETTE.cyan}
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Grid label */}
      <Billboard position={[0, 2, 0]}>
        <Text fontSize={0.25} color={PALETTE.indigo} anchorX="center" fillOpacity={0.5}>
          HOLO-GRID
        </Text>
        <Text fontSize={0.13} color={PALETTE.cyan} anchorX="center" position={[0, -0.25, 0]} fillOpacity={0.35}>
          {`${cells.length} cells`}
        </Text>
      </Billboard>
    </group>
  )
}
