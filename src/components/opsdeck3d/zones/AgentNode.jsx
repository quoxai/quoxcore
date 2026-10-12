/**
 * AgentNode v3 — Substantial 3D node with depth
 *
 * Structure per node:
 *  1. Outer wireframe octahedron (edge definition)
 *  2. Inner solid octahedron (core mass, emissive)
 *  3. Ground glow disc (spatial grounding)
 *  4. Scanning ring (state activity)
 *  5. Billboard label (always readable)
 *  6. Hover tooltip (rich info)
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'
import { STATE_VISUALS, NODE_SCALES, PALETTE } from '../lib/design-system'

export default function AgentNode({
  position = [0, 0, 0],
  agentId,
  name = 'AGENT',
  role = 'specialist',
  state = 'idle',
  color = '#6366f1',
  description = '',
  tools = [],
  capabilities = [],
  showLabel = true,
  opacity: overlayOpacity,
  settings = {},
  onSelect,
}) {
  const groupRef = useRef()
  const innerRef = useRef()
  const wireRef = useRef()
  const ringRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const [hovered, setHovered] = useState(false)

  const sv = STATE_VISUALS[state] || STATE_VISUALS.idle
  const stateColor = useMemo(() => new THREE.Color(sv.color), [sv.color])
  const agentColor = useMemo(() => new THREE.Color(color), [color])
  const scale = NODE_SCALES[role] || 0.7
  const glowMult = settings.agentGlow ?? 0.7
  const floatAmp = settings.agentFloatAmp ?? 0.08
  const ringSpeedMult = settings.agentRingSpeed ?? 1.0
  const labelOpacity = settings.agentLabelOpacity ?? 0.8
  const wireOpacity = settings.nodeWireOpacity ?? 0.3
  const innerScale = settings.nodeInnerScale ?? 0.65
  const groundGlow = settings.nodeGroundGlow ?? 0.15

  const displayColor = state === 'idle' || state === 'done' ? agentColor : stateColor
  const isActive = sv.ringSpeed > 0
  const effectiveOpacity = overlayOpacity != null ? overlayOpacity : 1

  // Functional pulse: frequency encodes severity
  // idle=0 (no pulse), executing=1.5Hz, thinking=2Hz, blocked=4Hz (urgent)
  const pulseFreq = state === 'blocked' ? 4 : state === 'executing' ? 1.5 : state === 'thinking' ? 2 : state === 'reading' ? 1 : 0

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      if (groupRef.current) {
        // Float
        if (sv.animate === 'shake') {
          groupRef.current.position.x = position[0] + Math.sin(t * 20) * 0.03
          groupRef.current.position.z = position[2] + Math.cos(t * 25) * 0.03
          groupRef.current.position.y = position[1]
        } else {
          groupRef.current.position.y = position[1] + Math.sin(t * 0.6) * floatAmp
        }
      }

      // Outer wireframe: slow rotation
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.12
        wireRef.current.rotation.x += delta * 0.04
      }

      // Inner core: counter-rotate + pulse scale by frequency
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.08
        // Functional pulse: scale oscillates at frequency encoding severity
        if (pulseFreq > 0) {
          const pulse = 1 + Math.sin(t * pulseFreq * Math.PI * 2) * 0.08
          innerRef.current.scale.setScalar(scale * innerScale * hoverScale * pulse)
        }
      }

      // Scanning ring
      if (ringRef.current && sv.ringSpeed > 0) {
        ringRef.current.rotation.z += delta * sv.ringSpeed * ringSpeedMult
        ringRef.current.rotation.x += delta * sv.ringSpeed * ringSpeedMult * 0.3
      }
    } catch { /* ref not ready */ }
  })

  const ringSize = scale * 1.6
  const hoverScale = hovered ? 1.1 : 1

  return (
    <group ref={groupRef} position={position}>
      {/* === OUTER WIREFRAME — edge definition, gives 3D read === */}
      <mesh ref={wireRef} scale={scale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={displayColor}
          wireframe
          transparent
          opacity={wireOpacity * (hovered ? 1.5 : 1) * effectiveOpacity}
        />
      </mesh>

      {/* === INNER SOLID CORE — mass, emissive glow === */}
      <mesh ref={innerRef} scale={scale * innerScale * hoverScale}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={displayColor}
          emissive={displayColor}
          emissiveIntensity={sv.glow * glowMult * (hovered ? 1.4 : 1)}
          transparent
          opacity={(state === 'idle' ? 0.5 : 0.8) * effectiveOpacity}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* === ACTIVE AGENT POINT LIGHT — non-idle agents glow into surroundings === */}
      {state !== 'idle' && state !== 'done' && state !== 'stale' && (
        <pointLight color={displayColor} intensity={0.3} distance={4} decay={2} />
      )}

      {/* === GROUND GLOW DISC — spatial grounding === */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.8, 0]}>
        <circleGeometry args={[scale * 1.2, 16]} />
        <meshBasicMaterial
          color={displayColor}
          transparent
          opacity={groundGlow * (isActive ? 1.5 : 0.6) * effectiveOpacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* === SCANNING RING — activity indicator === */}
      {isActive && (
        <group ref={ringRef} rotation={[0.5, 0.3, 0]}>
          <mesh>
            <torusGeometry args={[ringSize, 0.015, 8, 48]} />
            <meshBasicMaterial
              color={displayColor}
              transparent
              opacity={0.5}
            />
          </mesh>
          {/* Second ring for depth */}
          <mesh rotation={[0.8, 0.4, 0]}>
            <torusGeometry args={[ringSize * 0.85, 0.01, 8, 48]} />
            <meshBasicMaterial
              color={displayColor}
              transparent
              opacity={0.25}
            />
          </mesh>
        </group>
      )}

      {/* === LABEL === */}
      {showLabel && (
        <Billboard position={[0, scale * 1.3, 0]}>
          <Text
            fontSize={0.32}
            color="white"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.025}
            outlineColor="#000000"
            fillOpacity={hovered ? 1 : labelOpacity * 0.5}
          >
            {name}
          </Text>
          <Text
            fontSize={0.16}
            color={color}
            anchorX="center"
            anchorY="middle"
            position={[0, -0.3, 0]}
            fillOpacity={hovered ? 0.7 : labelOpacity * 0.25}
          >
            {state === 'idle' ? role : state.replace(/_/g, ' ')}
          </Text>
        </Billboard>
      )}

      {/* === HOVER TOOLTIP === */}
      {hovered && (
        <Html
          position={[scale * 1.5, 0.5, 0]}
          style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          zIndexRange={[20, 0]}
        >
          <div style={{
            background: 'rgba(5,5,16,0.94)',
            border: `1px solid ${color}40`,
            borderRadius: 6,
            padding: '8px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            minWidth: 150,
            boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 15px ${color}15`,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color }}>{name}</div>
            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, marginBottom: 6 }}>{role.toUpperCase()} · {agentId}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: sv.color, boxShadow: `0 0 8px ${sv.color}` }} />
              <span style={{ color: sv.color, fontWeight: 600 }}>{state.replace(/_/g, ' ')}</span>
            </div>
            {description && <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, marginTop: 4, lineHeight: 1.4 }}>{description}</div>}
            {tools.length > 0 && <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 8, marginTop: 6 }}>{tools.length} tools</div>}
            <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 8, marginTop: 4 }}>Click for details</div>
          </div>
        </Html>
      )}

      {/* === HITBOX — invisible larger sphere for easy clicking === */}
      <mesh
        scale={scale * 1.8}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'agent', id: agentId, name, role, state, color, description, tools, capabilities, position }) }}
        visible={false}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}
