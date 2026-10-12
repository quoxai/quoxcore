/**
 * ZoneRings — Visible orbital rings that define the spatial zones.
 * Each zone gets a labelled ring at its radius. Gives the scene structure.
 *
 * Zones:
 *   Agent Mesh:      r=15  (indigo)
 *   Execution Layer:  r=30  (emerald)
 *   Memory Lattice:   r=45  (rose)
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const ZONES = [
  { name: 'AGENT MESH', radius: 15, color: '#6366f1', labelPos: [0, 0.5, 15], y: 0 },
  { name: 'EXECUTION', radius: 30, color: '#22c55e', labelPos: [0, 0.5, 30], y: 0 },
  { name: 'MEMORY LATTICE', radius: 45, color: '#ec4899', labelPos: [0, 0.5, 45], y: 0 },
]

function OrbitRing({ radius, color, opacity = 0.08, dashed = false, segments = 128, y = 0 }) {
  const points = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      y,
      Math.sin(angle) * radius,
    ))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

export default function ZoneRings({ settings = {} }) {
  const zoneOpacity = settings.zoneRingOpacity ?? 0.1
  const labelOpacity = settings.zoneLabelOpacity ?? 0.3
  const showLabels = settings.zoneLabels !== false

  return (
    <group>
      {ZONES.map(zone => (
        <group key={zone.name}>
          {/* Main orbit ring */}
          <OrbitRing
            radius={zone.radius}
            color={zone.color}
            opacity={zoneOpacity}
            y={zone.y}
          />
          {/* Secondary ring slightly offset for depth */}
          <OrbitRing
            radius={zone.radius}
            color={zone.color}
            opacity={zoneOpacity * 0.4}
            y={zone.y + 0.3}
          />
          <OrbitRing
            radius={zone.radius}
            color={zone.color}
            opacity={zoneOpacity * 0.4}
            y={zone.y - 0.3}
          />

          {/* Zone label at the ring */}
          {showLabels && (
            <Billboard position={zone.labelPos}>
              <Text
                fontSize={0.6}
                color={zone.color}
                anchorX="center"
                anchorY="middle"
                fillOpacity={labelOpacity}
                outlineWidth={0.03}
                outlineColor="#000000"
              >
                {zone.name}
              </Text>
              <Text
                fontSize={0.25}
                color={zone.color}
                anchorX="center"
                anchorY="middle"
                position={[0, -0.5, 0]}
                fillOpacity={labelOpacity * 0.5}
              >
                r={zone.radius}
              </Text>
            </Billboard>
          )}
        </group>
      ))}
    </group>
  )
}

/**
 * TaskOrbitPath — visible elliptical orbit line around an objective cluster
 */
export function TaskOrbitPath({ radius = 4, color = '#6366f1', opacity = 0.06, tilt = 0, segments = 64, position = [0, 0, 0] }) {
  const points = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius * Math.sin(tilt),
      Math.sin(angle) * radius * Math.cos(tilt),
    ))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)

  return (
    <line geometry={geometry} position={position}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}

/**
 * MemoryOrbitPath — tilted elliptical orbit for memory crystals
 */
export function MemoryOrbitPath({ radius = 45, tilt = 0.3, color = '#ec4899', opacity = 0.04, segments = 96 }) {
  const points = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius * Math.sin(tilt),
      Math.sin(angle) * radius * Math.cos(tilt),
    ))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </line>
  )
}
