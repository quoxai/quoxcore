/**
 * CoreShell — Triple-line neon wireframe at r=130.
 *
 * Three layers per shell (neon sign effect):
 *   1. Hot core line — thin, nearly white (pale violet), very bright
 *   2. Main colour line — medium, full saturation
 *   3. Outer bloom — wide, soft glow
 *
 * Second shell at r=134 counter-rotating for parallax depth.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const HOT_COLOR = '#e0d0ff'    // pale violet-white (hot core)
const SHELL_COLOR = '#8b5cf6'  // full violet
const GLOW_COLOR = '#a78bfa'   // soft violet bloom

export default function CoreShell({ settings = {} }) {
  const shellOpacity = settings.shellOpacity ?? 0.15
  const rotSpeed = settings.shellRotationSpeed ?? 0.0003
  const hotRef = useRef()
  const mainRef = useRef()
  const glowRef = useRef()
  const shell2Ref = useRef()
  const hot2Ref = useRef()

  useFrame((_, delta) => {
    try {
      if (hotRef.current) hotRef.current.rotation.y += rotSpeed
      if (mainRef.current) mainRef.current.rotation.y += rotSpeed
      if (glowRef.current) glowRef.current.rotation.y += rotSpeed
      if (shell2Ref.current) shell2Ref.current.rotation.y -= rotSpeed * 0.5
      if (hot2Ref.current) hot2Ref.current.rotation.y -= rotSpeed * 0.5
    } catch { /* ref not ready */ }
  })

  return (
    <group>
      {/* Layer 1: Hot core line — thin, bright, nearly white */}
      <mesh ref={hotRef}>
        <icosahedronGeometry args={[130, 2]} />
        <meshBasicMaterial
          wireframe
          color={HOT_COLOR}
          transparent
          opacity={shellOpacity * 3.0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Layer 2: Main colour line — full saturation */}
      <mesh ref={mainRef} scale={1.003}>
        <icosahedronGeometry args={[130, 2]} />
        <meshBasicMaterial
          wireframe
          color={SHELL_COLOR}
          transparent
          opacity={shellOpacity * 2.0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Layer 3: Outer bloom — wide, soft glow */}
      <mesh ref={glowRef} scale={1.012}>
        <icosahedronGeometry args={[130, 1]} />
        <meshBasicMaterial
          wireframe
          color={GLOW_COLOR}
          transparent
          opacity={shellOpacity * 0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Second shell — counter-rotating with its own hot line */}
      <mesh ref={shell2Ref}>
        <icosahedronGeometry args={[134, 1]} />
        <meshBasicMaterial
          wireframe
          color={SHELL_COLOR}
          transparent
          opacity={shellOpacity * 0.6}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={hot2Ref}>
        <icosahedronGeometry args={[134, 1]} />
        <meshBasicMaterial
          wireframe
          color={HOT_COLOR}
          transparent
          opacity={shellOpacity * 1.0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}
