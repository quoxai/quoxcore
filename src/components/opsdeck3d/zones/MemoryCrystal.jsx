/**
 * MemoryCrystal — Individual memory crystal on an orbital track
 *
 * Structure (same 3-layer pattern as AgentNode):
 *  1. Outer wireframe octahedron (edge definition, Y-stretched per type)
 *  2. Inner solid octahedron (core mass, emissive)
 *  3. Ground glow disc (spatial grounding, additive blending)
 *  4. Billboard label (type prefix + truncated content)
 *  5. Hover tooltip (glass background, full info)
 *  6. Invisible hitbox for click/hover
 *
 * Open loops pulse amber (scale oscillation 1.0 -> 1.15, 2s cycle).
 * Age-based brightness: recent = bright, old = dim.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'
import { MEMORY_VARIANTS, NODE_SCALES, PALETTE } from '../lib/design-system'

const TYPE_PREFIXES = {
  entity: 'entity',
  fact: 'fact',
  decision: 'decision',
  preference: 'pref',
  openLoop: 'loop',
  error: 'error',
}

const TYPE_BADGE_COLORS = {
  entity: '#ec4899',
  fact: '#818cf8',
  decision: '#a78bfa',
  preference: '#22d3ee',
  openLoop: '#f59e0b',
  error: '#ef4444',
}

function truncate(str, len) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '\u2026' : str
}

export default function MemoryCrystal({
  memory,
  orbitRadius,
  orbitTilt,
  index,
  total,
  settings = {},
  onSelect,
}) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const [hovered, setHovered] = useState(false)
  const { camera } = useThree()

  const variant = MEMORY_VARIANTS[memory.type] || MEMORY_VARIANTS.entity
  const baseScale = (NODE_SCALES.memory || 0.4) * (settings.crystalScale ?? 1.0)
  const crystalColor = useMemo(() => new THREE.Color(variant.color), [variant.color])
  const driftSpeed = settings.crystalDriftSpeed ?? 0.05
  const crystalGlow = settings.crystalGlow ?? 0.5
  const wireOpacity = settings.nodeWireOpacity ?? 0.3
  const innerScale = settings.nodeInnerScale ?? 0.65
  const groundGlow = settings.nodeGroundGlow ?? 0.12

  // Age-based dimming: recent (age<0.3) = bright, old = dim
  const ageBrightness = useMemo(() => {
    const age = memory.age ?? 0.5
    return Math.max(0.25, 1.0 - age * 0.7)
  }, [memory.age])

  // Age-based radius offset: recent near inner edge, older near outer
  const effectiveRadius = useMemo(() => {
    const age = memory.age ?? 0.5
    // Lerp from inner (orbitRadius - 2) to outer (orbitRadius + 2)
    return orbitRadius + (age - 0.5) * 4
  }, [memory.age, orbitRadius])

  const isOpenLoop = memory.type === 'openLoop'

  // Angular offset for distribution around the orbit
  const baseAngle = useMemo(() => (index / Math.max(total, 1)) * Math.PI * 2, [index, total])

  useFrame((state, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      if (groupRef.current) {
        // Elliptical orbit position
        const angle = baseAngle + t * driftSpeed
        const x = Math.cos(angle) * effectiveRadius
        const rawY = Math.sin(angle) * effectiveRadius * Math.sin(orbitTilt)
        const z = Math.sin(angle) * effectiveRadius * Math.cos(orbitTilt)
        groupRef.current.position.set(x, rawY, z)

        // Open loop pulse: scale 1.0 -> 1.15
        if (isOpenLoop) {
          const pulse = 1.0 + 0.15 * (0.5 + 0.5 * Math.sin(t * Math.PI)) // 2s cycle
          groupRef.current.scale.setScalar(pulse)
        }
      }

      // Gentle tumble on wireframe
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.1
        wireRef.current.rotation.x += delta * 0.03
      }

      // Inner counter-rotate
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.06
      }
    } catch { /* ref not ready */ }
  })

  // Check if camera is close enough for labels
  const labelVisible = useMemo(() => true, []) // always render, opacity-controlled below

  const hoverScale = hovered ? 1.15 : 1
  const prefix = TYPE_PREFIXES[memory.type] || memory.type
  const labelText = `${prefix}: ${truncate(memory.content, 20)}`
  const labelColor = isOpenLoop ? '#f59e0b' : 'white'
  const labelBrightness = isOpenLoop ? 0.9 : ageBrightness * 0.6

  return (
    <group ref={groupRef}>
      {/* === OUTER WIREFRAME — Y-stretched octahedron === */}
      <mesh
        ref={wireRef}
        scale={[baseScale * hoverScale, baseScale * variant.scaleY * hoverScale, baseScale * hoverScale]}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={crystalColor}
          wireframe
          transparent
          opacity={wireOpacity * ageBrightness * (hovered ? 1.5 : 1)}
        />
      </mesh>

      {/* === INNER SOLID CORE — emissive glow === */}
      <mesh
        ref={innerRef}
        scale={[
          baseScale * innerScale * hoverScale,
          baseScale * innerScale * variant.scaleY * hoverScale,
          baseScale * innerScale * hoverScale,
        ]}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={crystalColor}
          emissive={crystalColor}
          emissiveIntensity={crystalGlow * ageBrightness * (hovered ? 1.4 : 1)}
          transparent
          opacity={0.6 * ageBrightness}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* === GROUND GLOW DISC — additive blending === */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -baseScale * variant.scaleY * 0.8, 0]}>
        <circleGeometry args={[baseScale * 1.0, 12]} />
        <meshBasicMaterial
          color={crystalColor}
          transparent
          opacity={groundGlow * ageBrightness * (hovered ? 1.5 : 0.8)}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* === BILLBOARD LABEL === */}
      <Billboard position={[0, baseScale * variant.scaleY * 1.3, 0]}>
        <Text
          fontSize={0.22}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
          fillOpacity={hovered ? 0.9 : labelBrightness}
        >
          {labelText}
        </Text>
      </Billboard>

      {/* === HOVER TOOLTIP === */}
      {hovered && (
        <Html
          position={[baseScale * 1.5, 0.5, 0]}
          style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          zIndexRange={[20, 0]}
        >
          <div style={{
            background: 'rgba(5,5,16,0.94)',
            border: `1px solid ${variant.color}40`,
            borderRadius: 6,
            padding: '8px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            minWidth: 160,
            maxWidth: 280,
            boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 15px ${variant.color}15`,
          }}>
            {/* Type badge */}
            <div style={{
              display: 'inline-block',
              padding: '1px 6px',
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              background: `${TYPE_BADGE_COLORS[memory.type] || '#818cf8'}20`,
              color: TYPE_BADGE_COLORS[memory.type] || '#818cf8',
              border: `1px solid ${TYPE_BADGE_COLORS[memory.type] || '#818cf8'}30`,
              marginBottom: 6,
            }}>
              {memory.type === 'openLoop' ? 'open loop' : memory.type}
            </div>

            {/* Content */}
            <div style={{
              color: 'rgba(255,255,255,0.75)',
              fontSize: 10,
              lineHeight: 1.4,
              marginBottom: 6,
              whiteSpace: 'normal',
            }}>
              {memory.content}
            </div>

            {/* Age */}
            <div style={{
              color: 'rgba(255,255,255,0.3)',
              fontSize: 8,
            }}>
              age: {(memory.age * 100).toFixed(0)}%
            </div>

            <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 8, marginTop: 4 }}>
              Click for details
            </div>
          </div>
        </Html>
      )}

      {/* === HITBOX — invisible sphere for interaction === */}
      <mesh
        scale={baseScale * 1.8}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect?.({
            type: 'memory',
            id: memory.id,
            name: `${prefix}: ${truncate(memory.content, 30)}`,
            role: memory.type,
            state: memory.type === 'openLoop' ? 'waiting' : 'idle',
            color: variant.color,
            description: memory.content,
            tools: [],
            capabilities: [],
            position: groupRef.current ? groupRef.current.position.toArray() : [0, 0, 0],
          })
        }}
        visible={false}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}
