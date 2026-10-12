/**
 * DelegationArc — Animated cyan particle comet from point A to point B
 * along a CatmullRom spline curve. Head bright, tail fades.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export default function DelegationArc({
  from = [0, 0, 0],
  to = [10, 0, 0],
  color = '#06b6d4',
  duration = 1.5,
  onComplete,
}) {
  const pointsRef = useRef()
  const progressRef = useRef(0)
  const [alive, setAlive] = useState(true)

  // Build a curved spline between the two points
  const { curve, particleCount } = useMemo(() => {
    const mid = [
      (from[0] + to[0]) / 2 + (Math.random() - 0.5) * 5,
      (from[1] + to[1]) / 2 + 3 + Math.random() * 4,
      (from[2] + to[2]) / 2 + (Math.random() - 0.5) * 5,
    ]

    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(...from),
      new THREE.Vector3(...mid),
      new THREE.Vector3(...to),
    ])

    return { curve, particleCount: 30 }
  }, [from, to])

  const positions = useMemo(() => new Float32Array(particleCount * 3), [particleCount])
  const sizes = useMemo(() => new Float32Array(particleCount), [particleCount])

  useFrame((_, delta) => {
    try {
      if (!alive) return
      progressRef.current += delta / duration

      if (progressRef.current >= 1.2) {
        setAlive(false)
        onComplete?.()
        return
      }

      if (pointsRef.current) {
        const posAttr = pointsRef.current.geometry.attributes.position
        const sizeAttr = pointsRef.current.geometry.attributes.size

        for (let i = 0; i < particleCount; i++) {
          const t = progressRef.current - (i / particleCount) * 0.3
          if (t < 0 || t > 1) {
            posAttr.array[i * 3] = -9999
            posAttr.array[i * 3 + 1] = -9999
            posAttr.array[i * 3 + 2] = -9999
            sizeAttr.array[i] = 0
            continue
          }

          const p = curve.getPoint(Math.min(t, 1))
          posAttr.array[i * 3] = p.x
          posAttr.array[i * 3 + 1] = p.y
          posAttr.array[i * 3 + 2] = p.z

          // Head is larger, tail shrinks
          sizeAttr.array[i] = (1 - i / particleCount) * 0.3 + 0.05
        }

        posAttr.needsUpdate = true
        sizeAttr.needsUpdate = true
      }
    } catch { /* ref not ready */ }
  })

  if (!alive) return null

  const c = new THREE.Color(color)

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={particleCount} itemSize={3} />
        <bufferAttribute attach="attributes-size" array={sizes} count={particleCount} itemSize={1} />
      </bufferGeometry>
      <pointsMaterial
        size={0.2}
        color={c}
        transparent
        opacity={0.8}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}
