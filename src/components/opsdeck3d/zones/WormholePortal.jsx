/**
 * WormholePortal — Simplified gateway portal at the Core Shell boundary.
 *
 * Two concentric torus rings spinning in opposite directions.
 * Positioned at r=50 on the shell surface. Subtle — not distracting.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const CYAN = '#06b6d4'

export default function WormholePortal({ position = [54, 0, 0] }) {
  const ring1Ref = useRef()
  const ring2Ref = useRef()

  useFrame((_, delta) => {
    try {
      if (ring1Ref.current) ring1Ref.current.rotation.z += delta * 0.8
      if (ring2Ref.current) ring2Ref.current.rotation.z -= delta * 0.6
    } catch { /* ref not ready */ }
  })

  return (
    <group position={position}>
      {/* Outer ring */}
      <group ref={ring1Ref}>
        <mesh>
          <torusGeometry args={[2, 0.04, 8, 32]} />
          <meshStandardMaterial
            color={CYAN}
            emissive={CYAN}
            emissiveIntensity={0.4}
            transparent
            opacity={0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {/* Inner ring — counter-rotating, tilted */}
      <group ref={ring2Ref} rotation={[0.4, 0, 0]}>
        <mesh>
          <torusGeometry args={[1.5, 0.03, 8, 32]} />
          <meshStandardMaterial
            color={CYAN}
            emissive={CYAN}
            emissiveIntensity={0.3}
            transparent
            opacity={0.25}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {/* Centre glow disc */}
      <mesh>
        <circleGeometry args={[1.2, 16]} />
        <meshBasicMaterial
          color={CYAN}
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Label */}
      <Billboard position={[0, 3, 0]}>
        <Text
          fontSize={0.22}
          color={CYAN}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.3}
          outlineWidth={0.01}
          outlineColor="#000000"
          font={undefined}
        >
          {'GATEWAY \u2192 TAILNET'}
        </Text>
      </Billboard>
    </group>
  )
}
