/**
 * ImplantsRing — 12 cognitive implant nodes arranged at r=8 between
 * the nucleus (r=0-5) and agent mesh (r=12-18).
 *
 * Each implant is a flat octahedron (squished Y) with health-driven glow.
 * Degraded implants pulse amber. Offline flicker red.
 * Labels show implant name + health %.
 * This is the architectural layer the first version was missing.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const IMPLANTS = [
  { id: 'quox-sense',        name: 'QuoxSense',         health: 95, color: '#a78bfa', icon: '◉' },
  { id: 'quox-memory',       name: 'QuoxMemory',        health: 88, color: '#ec4899', icon: '◈' },
  { id: 'quox-executive',    name: 'QuoxExecutive',     health: 92, color: '#818cf8', icon: '△' },
  { id: 'quox-temporal',     name: 'QuoxTemporal',      health: 97, color: '#22c55e', icon: '◎' },
  { id: 'quox-focus',        name: 'QuoxFocus',         health: 91, color: '#06b6d4', icon: '◇' },
  { id: 'quox-value',        name: 'QuoxValue',         health: 85, color: '#3b82f6', icon: '⚙' },
  { id: 'quox-insight',      name: 'QuoxInsight',       health: 45, color: '#f59e0b', icon: '⧉' },  // degraded
  { id: 'quox-guard',        name: 'QuoxGuard',         health: 96, color: '#22c55e', icon: '♦' },
  { id: 'quox-dream',        name: 'QuoxDream',         health: 90, color: '#818cf8', icon: '⚓' },
  { id: 'quox-reflect',      name: 'QuoxReflect',       health: 94, color: '#a78bfa', icon: '⛊' },
  { id: 'quox-learn',        name: 'QuoxLearn',         health: 0,  color: '#ef4444', icon: '▤' },  // offline
  { id: 'quox-predict',      name: 'QuoxPredict',       health: 87, color: '#3b82f6', icon: '▧' },
]

const RADIUS = 8

function ImplantNode({ implant, angle, index }) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(index * 1.7)
  const [hovered, setHovered] = useState(false)

  const pos = useMemo(() => [
    Math.cos(angle) * RADIUS,
    0,
    Math.sin(angle) * RADIUS,
  ], [angle])

  const healthColor = useMemo(() => {
    if (implant.health > 80) return new THREE.Color(implant.color)
    if (implant.health > 30) return new THREE.Color('#f59e0b')
    if (implant.health > 0) return new THREE.Color('#ef4444')
    return new THREE.Color('#1a1a2e')
  }, [implant])

  const isDegraded = implant.health > 0 && implant.health <= 80
  const isOffline = implant.health === 0

  useFrame((_, delta) => {
    timeRef.current += delta

    if (wireRef.current) {
      wireRef.current.rotation.y += delta * 0.1
    }

    if (groupRef.current) {
      // Degraded: amber pulse
      if (isDegraded) {
        const pulse = 0.5 + Math.sin(timeRef.current * 3) * 0.3
        if (innerRef.current) innerRef.current.material.emissiveIntensity = pulse
      }
      // Offline: red flicker
      if (isOffline) {
        const flicker = Math.random() > 0.85 ? 0.4 : 0.05
        if (innerRef.current) innerRef.current.material.emissiveIntensity = flicker
      }
      // Gentle float
      groupRef.current.position.y = Math.sin(timeRef.current * 0.5 + index) * 0.15
    }
  })

  const scale = 0.5
  const healthPct = `${implant.health}%`

  return (
    <group ref={groupRef} position={pos}>
      {/* Outer wireframe — flat octahedron (squished Y = lens shape) */}
      <mesh ref={wireRef} scale={[scale, scale * 0.4, scale]}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={healthColor} wireframe transparent opacity={hovered ? 0.5 : 0.25} />
      </mesh>

      {/* Inner core */}
      <mesh ref={innerRef} scale={[scale * 0.6, scale * 0.25, scale * 0.6]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={healthColor}
          emissive={healthColor}
          emissiveIntensity={implant.health > 80 ? 0.5 : 0.3}
          transparent
          opacity={isOffline ? 0.2 : 0.7}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>

      {/* Ground disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.3, 0]}>
        <circleGeometry args={[scale * 0.8, 12]} />
        <meshBasicMaterial
          color={healthColor}
          transparent
          opacity={isOffline ? 0.02 : 0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Health ring — thin torus showing health as arc */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[scale * 1.2, 0.012, 8, 32, Math.PI * 2 * (implant.health / 100)]} />
        <meshBasicMaterial color={healthColor} transparent opacity={0.4} />
      </mesh>

      {/* Label */}
      <Billboard position={[0, scale * 0.8, 0]}>
        <Text fontSize={0.18} color="white" anchorX="center" outlineWidth={0.015} outlineColor="#000" fillOpacity={hovered ? 1 : 0.4}>
          {implant.name}
        </Text>
        <Text fontSize={0.14} color={implant.health > 80 ? implant.color : implant.health > 0 ? '#f59e0b' : '#ef4444'} anchorX="center" position={[0, -0.2, 0]} fillOpacity={hovered ? 0.9 : 0.5} fontWeight={700}>
          {isOffline ? 'OFFLINE' : healthPct}
        </Text>
      </Billboard>

      {/* Hover tooltip */}
      {hovered && (
        <Html position={[scale * 1.5, 0.3, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[20, 0]}>
          <div style={{
            background: 'rgba(5,5,16,0.94)', border: `1px solid ${implant.color}40`,
            borderRadius: 6, padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10, color: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(16px)', minWidth: 140,
          }}>
            <div style={{ fontWeight: 700, color: implant.color, marginBottom: 4 }}>{implant.icon} {implant.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
                <div style={{ width: `${implant.health}%`, height: '100%', borderRadius: 2, background: implant.health > 80 ? implant.color : implant.health > 0 ? '#f59e0b' : '#ef4444' }} />
              </div>
              <span style={{ color: implant.health > 80 ? implant.color : '#f59e0b', fontWeight: 600 }}>{healthPct}</span>
            </div>
            {isDegraded && <div style={{ color: '#f59e0b', fontSize: 9, marginTop: 4 }}>Degraded: performance reduced</div>}
            {isOffline && <div style={{ color: '#ef4444', fontSize: 9, marginTop: 4 }}>Offline — service unavailable</div>}
          </div>
        </Html>
      )}

      {/* Hitbox */}
      <mesh
        scale={scale * 2}
        visible={false}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

export default function ImplantsRing() {
  const groupRef = useRef()

  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.015
  })

  return (
    <group ref={groupRef}>
      {/* Orbit ring for this layer */}
      {[RADIUS - 0.3, RADIUS, RADIUS + 0.3].map((r, i) => {
        const points = []
        for (let j = 0; j <= 64; j++) {
          const a = (j / 64) * Math.PI * 2
          points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))
        }
        return (
          <line key={i} geometry={new THREE.BufferGeometry().setFromPoints(points)}>
            <lineBasicMaterial color={PALETTE.violet} transparent opacity={i === 1 ? 0.08 : 0.03} />
          </line>
        )
      })}

      {/* Zone label */}
      <Billboard position={[0, 0.8, RADIUS]}>
        <Text fontSize={0.35} color={PALETTE.violet} anchorX="center" fillOpacity={0.25} outlineWidth={0.02} outlineColor="#000">
          IMPLANTS
        </Text>
      </Billboard>

      {/* 12 implant nodes */}
      {IMPLANTS.map((implant, i) => (
        <ImplantNode
          key={implant.id}
          implant={implant}
          angle={(i / IMPLANTS.length) * Math.PI * 2 - Math.PI / 2}
          index={i}
        />
      ))}
    </group>
  )
}
