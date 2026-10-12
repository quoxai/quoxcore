/**
 * FocusBeam — Thin indigo cylinder from origin toward a target position.
 * Pulsing opacity with flowing particles along the beam.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const PARTICLE_COUNT = 9

export default function FocusBeam({
  targetPosition = [34, 0, 0],
  active = true,
  color = PALETTE.indigo,
}) {
  const groupRef = useRef()
  const cylRef = useRef()
  const pointsRef = useRef()
  const timeRef = useRef(0)
  const fadeRef = useRef(active ? 1 : 0)

  const target = useMemo(() => new THREE.Vector3(...targetPosition), [targetPosition])
  const origin = useMemo(() => new THREE.Vector3(0, 0, 0), [])

  const beamLength = useMemo(() => target.length(), [target])
  const beamDir = useMemo(() => target.clone().normalize(), [target])

  // Midpoint and rotation for the cylinder
  const midpoint = useMemo(() => origin.clone().add(target).multiplyScalar(0.5), [origin, target])

  // Quaternion to orient cylinder along beam direction
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion()
    // CylinderGeometry default axis is Y, we rotate to align with beamDir
    const up = new THREE.Vector3(0, 1, 0)
    q.setFromUnitVectors(up, beamDir)
    return q
  }, [beamDir])

  // Particle positions buffer
  const particlePositions = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), [])
  const particleSizes = useMemo(() => {
    const sizes = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) sizes[i] = 0.06 + Math.random() * 0.04
    return sizes
  }, [])

  const beamColor = useMemo(() => new THREE.Color(color), [color])

  useFrame((_, delta) => {
    try {
      timeRef.current += delta

      // Fade in/out
      const targetFade = active ? 1 : 0
      fadeRef.current += (targetFade - fadeRef.current) * delta * 3
      if (fadeRef.current < 0.001 && !active) {
        if (groupRef.current) groupRef.current.visible = false
        return
      }
      if (groupRef.current) groupRef.current.visible = true

      const t = timeRef.current
      const fade = fadeRef.current

      // Cylinder pulsing opacity
      if (cylRef.current) {
        const pulse = 0.15 + Math.sin(t * Math.PI) * 0.1 // 0.05 to 0.25 range, ~2s cycle
        cylRef.current.material.opacity = pulse * fade
      }

      // Flow particles along the beam
      if (pointsRef.current) {
        const positions = pointsRef.current.geometry.attributes.position.array
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          // Each particle flows from origin to target, staggered
          const progress = ((t * 0.5 + i / PARTICLE_COUNT) % 1)
          const p = origin.clone().lerp(target, progress)
          // Slight perpendicular wobble
          const wobble = Math.sin(t * 3 + i * 2) * 0.05
          positions[i * 3] = p.x + wobble
          positions[i * 3 + 1] = p.y + wobble
          positions[i * 3 + 2] = p.z
        }
        pointsRef.current.geometry.attributes.position.needsUpdate = true
        pointsRef.current.material.opacity = 0.4 * fade
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group ref={groupRef}>
      {/* Beam cylinder */}
      <mesh
        ref={cylRef}
        position={midpoint}
        quaternion={quaternion}
      >
        <cylinderGeometry args={[0.03, 0.03, beamLength, 4, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Flowing particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={PARTICLE_COUNT}
            array={particlePositions}
            itemSize={3}
          />
          <bufferAttribute
            attach="attributes-size"
            count={PARTICLE_COUNT}
            array={particleSizes}
            itemSize={1}
          />
        </bufferGeometry>
        <pointsMaterial
          color={beamColor}
          size={0.1}
          transparent
          opacity={0.4}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>
    </group>
  )
}
