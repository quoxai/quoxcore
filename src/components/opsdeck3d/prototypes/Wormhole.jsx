/**
 * Wormhole — Portal to another Quox instance.
 *
 * A swirling vortex at the edge of the core shell that represents
 * a connection to another tenant/org's Cognitive Core.
 * Multi-tenant visualised as traversable gateways.
 *
 * Visual: spinning torus with particle vortex funnel,
 * label showing the destination org name, connection health.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

export default function Wormhole({
  position = [50, 0, 0],
  destination = 'Quox LTD',
  color = '#06b6d4',
  health = 'active', // active | degraded | closed
  size = 3,
}) {
  const groupRef = useRef()
  const ring1Ref = useRef()
  const ring2Ref = useRef()
  const ring3Ref = useRef()
  const vortexRef = useRef()
  const timeRef = useRef(Math.random() * 100)

  const col = useMemo(() => new THREE.Color(color), [color])
  const isActive = health === 'active'
  const isDegraded = health === 'degraded'

  // Vortex particles
  const vortexCount = 60
  const vortexPositions = useMemo(() => new Float32Array(vortexCount * 3), [])

  useFrame((_, delta) => {
    timeRef.current += delta

    // Spinning rings at different speeds and tilts
    if (ring1Ref.current) ring1Ref.current.rotation.z += delta * (isActive ? 1.5 : 0.3)
    if (ring2Ref.current) ring2Ref.current.rotation.z -= delta * (isActive ? 1.0 : 0.2)
    if (ring3Ref.current) ring3Ref.current.rotation.x += delta * (isActive ? 0.8 : 0.15)

    // Group wobble
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(timeRef.current * 0.3) * 0.1
      groupRef.current.rotation.x = Math.cos(timeRef.current * 0.2) * 0.05
    }

    // Vortex funnel particles — spiral inward
    if (vortexRef.current) {
      const posAttr = vortexRef.current.geometry.attributes.position
      for (let i = 0; i < vortexCount; i++) {
        const t = (timeRef.current * 0.8 + i / vortexCount * 4) % 4
        const depth = t * 2 // How deep into the portal
        const radius = size * 1.2 * (1 - t / 4) // Spiral inward
        const angle = timeRef.current * 3 + i * 0.5 + depth * 2

        posAttr.array[i * 3] = Math.cos(angle) * radius
        posAttr.array[i * 3 + 1] = Math.sin(angle) * radius
        posAttr.array[i * 3 + 2] = -depth // Into the portal
      }
      posAttr.needsUpdate = true
    }
  })

  return (
    <group ref={groupRef} position={position}>
      {/* Outer event horizon ring */}
      <group ref={ring1Ref}>
        <mesh>
          <torusGeometry args={[size, 0.08, 12, 48]} />
          <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isActive ? 0.8 : 0.2} transparent opacity={isActive ? 0.6 : 0.2} />
        </mesh>
      </group>

      {/* Inner ring — counter-rotating */}
      <group ref={ring2Ref} rotation={[0.3, 0, 0]}>
        <mesh>
          <torusGeometry args={[size * 0.75, 0.05, 12, 48]} />
          <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isActive ? 0.6 : 0.15} transparent opacity={isActive ? 0.5 : 0.15} />
        </mesh>
      </group>

      {/* Innermost ring */}
      <group ref={ring3Ref} rotation={[0.6, 0.2, 0]}>
        <mesh>
          <torusGeometry args={[size * 0.45, 0.03, 8, 32]} />
          <meshStandardMaterial color={col} emissive={col} emissiveIntensity={isActive ? 0.5 : 0.1} transparent opacity={isActive ? 0.4 : 0.1} />
        </mesh>
      </group>

      {/* Centre glow — the actual portal */}
      <mesh>
        <circleGeometry args={[size * 0.5, 24]} />
        <meshBasicMaterial
          color={col}
          transparent
          opacity={isActive ? 0.15 : 0.03}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Vortex particles */}
      {isActive && (
        <points ref={vortexRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" array={vortexPositions} count={vortexCount} itemSize={3} />
          </bufferGeometry>
          <pointsMaterial size={0.06} color={col} transparent opacity={0.5} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
        </points>
      )}

      {/* Destination label */}
      <Billboard position={[0, size + 1.2, 0]}>
        <Text fontSize={0.35} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.7}>
          {destination}
        </Text>
        <Text fontSize={0.18} color={color} anchorX="center" position={[0, -0.35, 0]} fillOpacity={0.5}>
          {health === 'active' ? 'PORTAL ACTIVE' : health === 'degraded' ? 'UNSTABLE' : 'CLOSED'}
        </Text>
      </Billboard>

      {/* Ground glow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -size * 0.8, 0]}>
        <circleGeometry args={[size * 1.5, 16]} />
        <meshBasicMaterial color={col} transparent opacity={isActive ? 0.05 : 0.01} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}
