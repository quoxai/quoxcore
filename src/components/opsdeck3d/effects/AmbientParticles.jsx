/**
 * AmbientParticles — Realistic starfield on a giant shell.
 *
 * 800 stars at r=300 with realistic size/brightness distribution:
 *   - 50% dim dust (small, faint)
 *   - 25% medium stars (moderate glow)
 *   - 15% bright stars (vivid, larger)
 *   - 10% brilliant stars (very large, intense, slight colour tint)
 *
 * Plus 3 dim nebula patches (soft coloured glow spheres) for depth.
 * Subtle twinkling on a handful of stars per frame.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const COUNT = 800
const SHELL_RADIUS = 300

// Pre-generate star colour tints (mostly white, some warm/cool)
function buildColors(count) {
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    let color
    const r = Math.random()
    if (r < 0.6) {
      color = new THREE.Color('#ffffff')  // white
    } else if (r < 0.75) {
      color = new THREE.Color('#cce0ff')  // cool blue-white
    } else if (r < 0.88) {
      color = new THREE.Color('#ffeedd')  // warm yellow-white
    } else if (r < 0.95) {
      color = new THREE.Color('#aaccff')  // blue
    } else {
      color = new THREE.Color('#ffccaa')  // orange
    }
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  return colors
}

export default function AmbientParticles({ count = COUNT }) {
  const pointsRef = useRef()

  const positions = useMemo(() => {
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      // Vary radius slightly for depth (290-310)
      const r = SHELL_RADIUS - 10 + Math.random() * 20
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      pos[i * 3 + 2] = r * Math.cos(phi)
    }
    return pos
  }, [count])

  // Size distribution: realistic — many faint, few brilliant
  const sizes = useMemo(() => {
    const s = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const r = Math.random()
      if (r < 0.50) s[i] = 0.8 + Math.random() * 0.4      // dim dust
      else if (r < 0.75) s[i] = 1.5 + Math.random() * 0.8  // medium
      else if (r < 0.90) s[i] = 2.5 + Math.random() * 1.5  // bright
      else s[i] = 4.0 + Math.random() * 2.0                 // brilliant
    }
    return s
  }, [count])

  const colors = useMemo(() => buildColors(count), [count])

  // Base opacities — brighter stars have higher base opacity
  const baseOpacities = useMemo(() => {
    const o = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const sizeNorm = sizes[i] / 6.0
      o[i] = 0.3 + sizeNorm * 0.6 // 0.3..0.9 scaled by size
    }
    return o
  }, [count, sizes])

  // Twinkle a handful of stars each frame
  useFrame(() => {
    try {
      if (!pointsRef.current) return
      const geo = pointsRef.current.geometry
      const opAttr = geo.getAttribute('aOpacity')
      if (!opAttr) return

      for (let k = 0; k < 12; k++) {
        const idx = Math.floor(Math.random() * count)
        const base = baseOpacities[idx]
        const flicker = base * (0.5 + Math.random() * 1.0)
        opAttr.array[idx] = Math.min(1.0, Math.max(0.1, flicker))
      }
      opAttr.needsUpdate = true
    } catch { /* ref not ready */ }
  })

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aSize;
        attribute float aOpacity;
        attribute vec3 aColor;
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          vOpacity = aOpacity;
          vColor = aColor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          // Soft core with bright center
          float alpha = vOpacity * (1.0 - smoothstep(0.0, 0.5, d));
          // Extra bright center for larger stars
          float core = (1.0 - smoothstep(0.0, 0.15, d)) * vOpacity * 0.5;
          gl_FragColor = vec4(vColor, alpha + core);
        }
      `,
    })
  }, [])

  return (
    <>
      <points ref={pointsRef} material={material}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
          <bufferAttribute attach="attributes-aSize" array={sizes} count={count} itemSize={1} />
          <bufferAttribute attach="attributes-aOpacity" array={baseOpacities} count={count} itemSize={1} />
          <bufferAttribute attach="attributes-aColor" array={colors} count={count} itemSize={3} />
        </bufferGeometry>
      </points>

      {/* Nebula patches — dim coloured glow for depth */}
      <mesh position={[180, 80, -200]}>
        <sphereGeometry args={[60, 16, 16]} />
        <meshBasicMaterial color="#3b1f6e" transparent opacity={0.015} side={THREE.BackSide} depthWrite={false} />
      </mesh>
      <mesh position={[-220, -50, 150]}>
        <sphereGeometry args={[80, 16, 16]} />
        <meshBasicMaterial color="#1a3a4a" transparent opacity={0.012} side={THREE.BackSide} depthWrite={false} />
      </mesh>
      <mesh position={[50, 200, 180]}>
        <sphereGeometry args={[50, 16, 16]} />
        <meshBasicMaterial color="#4a1a2a" transparent opacity={0.01} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </>
  )
}
