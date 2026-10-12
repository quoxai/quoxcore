/**
 * ShockwaveRipple — Expanding ring that radiates from a point.
 * Used for objective start/complete events.
 */
import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export default function ShockwaveRipple({
  position = [0, 0, 0],
  color = '#6366f1',
  maxRadius = 40,
  duration = 2.0,
  maxOpacity = 0.4,
  onComplete,
}) {
  const meshRef = useRef()
  const progressRef = useRef(0)
  const [alive, setAlive] = useState(true)

  useFrame((_, delta) => {
    try {
      if (!alive) return
      progressRef.current += delta / duration

      if (progressRef.current >= 1) {
        setAlive(false)
        onComplete?.()
        return
      }

      if (meshRef.current) {
        const p = progressRef.current
        const radius = p * maxRadius
        meshRef.current.scale.set(radius, radius, radius)
        meshRef.current.material.opacity = (1 - p) * maxOpacity
      }
    } catch { /* ref not ready */ }
  })

  if (!alive) return null

  return (
    <mesh ref={meshRef} position={position} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1, 0.03, 8, 64]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.4}
        side={THREE.DoubleSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}
