/**
 * SearchBeacons — Vertical light columns at search result positions.
 *
 * V2-NAV-5: Spatial Search.
 * When SearchOverlay has results, beacon beams appear in the 3D scene
 * at each matching entity's world position. Visible from any distance
 * via additive blending + tall geometry. Active result pulses brighter.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const BEAM_HEIGHT = 200 // tall enough to see from any distance
const BEAM_RADIUS = 0.08
const PULSE_SPEED = 3

function Beacon({ position, color, name, active, index }) {
  const beamRef = useRef()
  const glowRef = useRef()
  const timeRef = useRef(Math.random() * 10)

  const beamColor = useMemo(() => new THREE.Color(color || '#8b5cf6'), [color])

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current
      const baseOpacity = active ? 0.25 : 0.1
      const pulse = active ? baseOpacity + Math.sin(t * PULSE_SPEED) * 0.1 : baseOpacity

      if (beamRef.current) beamRef.current.material.opacity = pulse
      if (glowRef.current) {
        glowRef.current.material.opacity = pulse * 0.4
        glowRef.current.scale.x = 1 + Math.sin(t * 2) * 0.15
        glowRef.current.scale.z = 1 + Math.sin(t * 2) * 0.15
      }
    } catch {}
  })

  if (!position || !Array.isArray(position)) return null

  return (
    <group position={position}>
      {/* Core beam — thin vertical cylinder */}
      <mesh ref={beamRef} position={[0, BEAM_HEIGHT / 2, 0]}>
        <cylinderGeometry args={[BEAM_RADIUS, BEAM_RADIUS, BEAM_HEIGHT, 6, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.15}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Glow beam — wider, fainter */}
      <mesh ref={glowRef} position={[0, BEAM_HEIGHT / 2, 0]}>
        <cylinderGeometry args={[BEAM_RADIUS * 4, BEAM_RADIUS * 4, BEAM_HEIGHT, 6, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.04}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Ground ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.8, 0.04, 8, 24]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={active ? 0.3 : 0.1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Label — name + index number */}
      <Billboard position={[0, 3, 0]}>
        <Text
          fontSize={0.4}
          color={active ? '#ffffff' : color || '#8b5cf6'}
          anchorX="center"
          anchorY="middle"
          fillOpacity={active ? 0.9 : 0.5}
          outlineWidth={0.03}
          outlineColor="#000000"
        >
          {`${index + 1}. ${name?.length > 18 ? name.slice(0, 18) + '\u2026' : name || '?'}`}
        </Text>
      </Billboard>
    </group>
  )
}

/**
 * SearchBeacons — renders beacon beams for search results.
 * @param {Array} results — search result entities with { id, name, position, color }
 * @param {number} activeIndex — index of currently highlighted result (-1 for none)
 */
export default function SearchBeacons({ results = [], activeIndex = -1 }) {
  if (results.length === 0) return null

  return (
    <group>
      {results.map((r, i) => (
        <Beacon
          key={r.id || i}
          position={r.position}
          color={r.color}
          name={r.name}
          active={i === activeIndex}
          index={i}
        />
      ))}
    </group>
  )
}
