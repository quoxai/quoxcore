/**
 * NestedShells — Two additional icosahedron wireframe shells beyond CoreShell (r=50).
 *
 * Tailnet Shell (r=70): cyan, opacity 0.06, slow counter-rotation
 * Outer Shell (r=90): amber, opacity 0.04, slow rotation
 *
 * These represent network security boundaries. Very faint — barely perceptible
 * boundary markers, not visual clutter. Default off (opt-in via toggle or Full Core preset).
 *
 * Phase CC-9: Ambient Life + Nested Shells + Performance Pass
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const TAILNET_COLOR = '#06b6d4'
const TAILNET_HOT = '#d0f4ff'    // pale cyan-white
const OUTER_COLOR = '#f59e0b'
const OUTER_HOT = '#fff4d0'      // pale amber-white

// ─── Placeholder octahedron node for zone content ───────
function ZoneNode({ position, color, label, opacity = 0.3, scale = 0.5 }) {
  const wireRef = useRef()
  const innerRef = useRef()

  useFrame((_, delta) => {
    try {
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.1
        wireRef.current.rotation.x += delta * 0.03
      }
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.06
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={opacity * 0.6} />
      </mesh>
      <mesh ref={innerRef} scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.3}
          transparent
          opacity={opacity}
          roughness={0.3}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.6, 0]}>
        <circleGeometry args={[scale * 0.8, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity * 0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <Billboard position={[0, scale * 1.3, 0]}>
        <Text
          fontSize={0.18}
          color={color}
          anchorX="center"
          anchorY="middle"
          fillOpacity={opacity * 0.7}
          outlineWidth={0.01}
          outlineColor="#000000"
          font={undefined}
        >
          {label}
        </Text>
      </Billboard>
    </group>
  )
}

// ─── Tailnet zone placeholders (r=140-160) ──────────────
const TAILNET_NODES = [
  { position: [148, 2, 28], label: 'vpn-relay' },
  { position: [-118, -1, 110], label: 'remote-worker-1' },
  { position: [58, 3, -153], label: 'cloud-proxy' },
  { position: [-141, 0, -82], label: 'cdn-edge' },
]

// ─── External zone placeholders (r=170-200) ─────────────
const EXTERNAL_NODES = [
  { position: [196, 4, 57], label: 'api.openai.com' },
  { position: [-105, -2, 181], label: 'github.com' },
  { position: [81, 1, -200], label: 'quox.ai' },
]

export default function NestedShells({ settings = {}, visible = true }) {
  const tailnetHotRef = useRef()
  const tailnetRef = useRef()
  const tailnetGlowRef = useRef()
  const outerHotRef = useRef()
  const outerRef = useRef()
  const outerGlowRef = useRef()

  useFrame((_, delta) => {
    try {
      // Tailnet rotates opposite to core shell
      const tRefs = [tailnetHotRef, tailnetRef, tailnetGlowRef]
      tRefs.forEach(r => { if (r.current) { r.current.rotation.y -= 0.00015; r.current.rotation.x += 0.00005 } })
      // Outer shell rotates slowly
      const oRefs = [outerHotRef, outerRef, outerGlowRef]
      oRefs.forEach(r => { if (r.current) { r.current.rotation.y += 0.0001; r.current.rotation.z -= 0.00003 } })
    } catch { /* ref not ready */ }
  })

  if (!visible) return null

  return (
    <group>
      {/* Tailnet — Hot core (thin, bright, nearly white) */}
      <mesh ref={tailnetHotRef}>
        <icosahedronGeometry args={[155, 1]} />
        <meshBasicMaterial wireframe color={TAILNET_HOT} transparent opacity={0.35} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Tailnet — Main colour line */}
      <mesh ref={tailnetRef} scale={1.003}>
        <icosahedronGeometry args={[155, 1]} />
        <meshBasicMaterial wireframe color={TAILNET_COLOR} transparent opacity={0.25} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Tailnet — Outer bloom */}
      <mesh ref={tailnetGlowRef} scale={1.01}>
        <icosahedronGeometry args={[155, 1]} />
        <meshBasicMaterial wireframe color="#22d3ee" transparent opacity={0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* Tailnet label */}
      <Billboard position={[0, 5, 155]}>
        <Text
          fontSize={1.8}
          color={TAILNET_COLOR}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.2}
          font={undefined}
        >
          TAILNET
        </Text>
      </Billboard>

      {/* External — Hot core (thin, bright, nearly white) */}
      <mesh ref={outerHotRef}>
        <icosahedronGeometry args={[190, 1]} />
        <meshBasicMaterial wireframe color={OUTER_HOT} transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* External — Main colour line */}
      <mesh ref={outerRef} scale={1.003}>
        <icosahedronGeometry args={[190, 1]} />
        <meshBasicMaterial wireframe color={OUTER_COLOR} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* External — Outer bloom */}
      <mesh ref={outerGlowRef} scale={1.01}>
        <icosahedronGeometry args={[190, 1]} />
        <meshBasicMaterial
          wireframe
          color="#fbbf24"
          transparent
          opacity={0.06}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Outer label */}
      <Billboard position={[0, 5, 190]}>
        <Text
          fontSize={2.0}
          color={OUTER_COLOR}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.15}
          font={undefined}
        >
          EXTERNAL
        </Text>
      </Billboard>

      {/* Tailnet zone content — VPN-connected service placeholders */}
      {TAILNET_NODES.map((node) => (
        <ZoneNode
          key={node.label}
          position={node.position}
          color={TAILNET_COLOR}
          label={node.label}
          opacity={0.3}
          scale={0.5}
        />
      ))}

      {/* External zone content — external service placeholders */}
      {EXTERNAL_NODES.map((node) => (
        <ZoneNode
          key={node.label}
          position={node.position}
          color={OUTER_COLOR}
          label={node.label}
          opacity={0.2}
          scale={0.45}
        />
      ))}
    </group>
  )
}
