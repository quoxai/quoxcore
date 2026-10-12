/**
 * DataHighway — A single persistent particle stream between two zones.
 *
 * Particles flow continuously along a CatmullRom spline with a mid-point
 * bulge. When inactive, particles fade out but the faint path line remains.
 *
 * CC-6: Data Highways
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// ─── Helpers ─────────────────────────────────────────────

/** Build a CatmullRom curve from `from` to `to` with a mid-point Y offset. */
function buildSpline(from, to, midYOffset = 3) {
  const mid = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2 + midYOffset,
    (from[2] + to[2]) / 2,
  ]
  return new THREE.CatmullRomCurve3([
    new THREE.Vector3(...from),
    new THREE.Vector3(...mid),
    new THREE.Vector3(...to),
  ])
}

/** Per-particle perpendicular jitter so the stream has width. */
function jitterOffset(curve, t, spread = 0.35) {
  const tangent = curve.getTangentAt(t).normalize()
  // Cross with world-up to get a perpendicular axis
  const up = new THREE.Vector3(0, 1, 0)
  const perp = new THREE.Vector3().crossVectors(tangent, up).normalize()
  const perp2 = new THREE.Vector3().crossVectors(tangent, perp).normalize()
  const a = (Math.random() - 0.5) * spread
  const b = (Math.random() - 0.5) * spread
  return perp.multiplyScalar(a).add(perp2.multiplyScalar(b))
}

// ─── Component ───────────────────────────────────────────

export default function DataHighway({
  from = [0, 0, 0],
  to = [15, 0, 0],
  color = '#6366f1',
  particleCount = 20,
  speed = 0.5,
  active = true,
  midYOffset = 3,
}) {
  const pointsRef = useRef()
  const lineRef = useRef()

  // Build spline once (or when endpoints change)
  const curve = useMemo(
    () => buildSpline(from, to, midYOffset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from[0], from[1], from[2], to[0], to[1], to[2], midYOffset],
  )

  // Seed per-particle data: progress (0-1), jitter offsets
  const particleData = useMemo(() => {
    const data = []
    for (let i = 0; i < particleCount; i++) {
      const t = i / particleCount
      const jitter = jitterOffset(curve, t)
      data.push({ progress: t, jitterX: jitter.x, jitterY: jitter.y, jitterZ: jitter.z })
    }
    return data
  }, [curve, particleCount])

  // Pre-allocate positions buffer
  const positions = useMemo(
    () => new Float32Array(particleCount * 3),
    [particleCount],
  )

  // Faint spline path line (always visible)
  const linePoints = useMemo(() => curve.getPoints(48), [curve])

  const threeColor = useMemo(() => new THREE.Color(color), [color])

  // Target opacity for smooth transitions
  const opacityRef = useRef(active ? 0.75 : 0)

  useFrame((_, delta) => {
    try {
      // Smooth opacity transition
      const target = active ? 0.75 : 0
      opacityRef.current += (target - opacityRef.current) * Math.min(delta * 3, 1)

      // Advance particles along spline
      const tmp = new THREE.Vector3()
      for (let i = 0; i < particleData.length; i++) {
        const p = particleData[i]
        p.progress += speed * delta * 0.15
        if (p.progress > 1) {
          p.progress -= 1
          // Re-jitter on loop
          const jitter = jitterOffset(curve, p.progress)
          p.jitterX = jitter.x
          p.jitterY = jitter.y
          p.jitterZ = jitter.z
        }
        curve.getPointAt(p.progress, tmp)
        positions[i * 3] = tmp.x + p.jitterX
        positions[i * 3 + 1] = tmp.y + p.jitterY
        positions[i * 3 + 2] = tmp.z + p.jitterZ
      }

      if (pointsRef.current) {
        pointsRef.current.geometry.attributes.position.needsUpdate = true
        pointsRef.current.material.opacity = opacityRef.current
      }

      // Faint path line opacity — hide when inactive
      if (lineRef.current) {
        lineRef.current.material.opacity = active ? 0.06 : 0
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group>
      {/* Faint guide line along spline */}
      <line ref={lineRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={linePoints.length}
            array={new Float32Array(linePoints.flatMap((p) => [p.x, p.y, p.z]))}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={color} transparent opacity={0.06} />
      </line>

      {/* Flowing particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={particleCount}
            array={positions}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          color={threeColor}
          size={0.1}
          transparent
          opacity={0.75}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          sizeAttenuation
        />
      </points>
    </group>
  )
}
