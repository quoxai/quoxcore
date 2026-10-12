/**
 * ImplantsRing — N cognitive implant nodes arranged at r=8.
 *
 * Dynamic: reads whatever implants are passed as props.
 * Each implant is a flat octahedron (squished Y) with 3-layer structure:
 *   outer wireframe + inner solid core + ground glow disc.
 * Health ring arc, billboard labels, hover tooltips, click handler.
 * Locked implants render grey at low opacity with lock icon.
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const RADIUS = 7  // Fibonacci layout: implants at r=7
const LAYER_Y_OFFSETS = {
  sensory: 0,
  cortical: 0.6,
  consolidative: -0.6,
}
const LOCKED_COLOR = new THREE.Color('#555570')
const LOCKED_OPACITY = 0.15

function healthToColor(health, baseColor, locked) {
  if (locked) return LOCKED_COLOR
  if (health > 80) return new THREE.Color(baseColor)
  if (health > 30) return new THREE.Color(PALETTE.waiting)
  if (health > 0) return new THREE.Color(PALETTE.blocked)
  return new THREE.Color('#1a1a2e')
}

function ImplantNode({ implant, angle, index, onSelect }) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(index * 1.7)
  const [hovered, setHovered] = useState(false)

  const yOffset = LAYER_Y_OFFSETS[implant.layer] || 0

  const pos = useMemo(() => [
    Math.cos(angle) * RADIUS,
    yOffset,
    Math.sin(angle) * RADIUS,
  ], [angle, yOffset])

  const hColor = useMemo(
    () => healthToColor(implant.health, implant.color, implant.locked),
    [implant.health, implant.color, implant.locked]
  )

  const isDegraded = !implant.locked && implant.health > 0 && implant.health <= 80
  const isOffline = !implant.locked && implant.health === 0
  const isLocked = !!implant.locked

  useFrame((_, delta) => {
    try {
      timeRef.current += delta

      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.1
      }

      if (groupRef.current) {
        if (isDegraded) {
          const pulse = 0.5 + Math.sin(timeRef.current * 3) * 0.3
          if (innerRef.current) innerRef.current.material.emissiveIntensity = pulse
        }
        if (isOffline) {
          const flicker = Math.random() > 0.85 ? 0.4 : 0.05
          if (innerRef.current) innerRef.current.material.emissiveIntensity = flicker
        }
        if (!isLocked) {
          groupRef.current.position.y = yOffset + Math.sin(timeRef.current * 0.5 + index) * 0.15
        }
      }
    } catch { /* ref not ready */ }
  })

  const scale = 0.5
  const healthPct = `${implant.health}%`
  const labelColor = isLocked
    ? 'rgba(255,255,255,0.35)'
    : implant.health > 80 ? implant.color : implant.health > 0 ? PALETTE.waiting : PALETTE.blocked
  const wireOpacity = isLocked ? LOCKED_OPACITY : (hovered ? 0.5 : 0.25)
  const innerOpacity = isLocked ? LOCKED_OPACITY : (isOffline ? 0.2 : 0.7)

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({ ...implant, position: pos })
  }, [implant, pos, onSelect])

  return (
    <group ref={groupRef} position={pos}>
      {/* Outer wireframe — flat octahedron (squished Y = lens shape) */}
      <mesh ref={wireRef} scale={[scale, scale * 0.4, scale]}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={hColor} wireframe transparent opacity={wireOpacity} />
      </mesh>

      {/* Inner core */}
      <mesh ref={innerRef} scale={[scale * 0.6, scale * 0.25, scale * 0.6]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={hColor}
          emissive={hColor}
          emissiveIntensity={isLocked ? 0.1 : (implant.health > 80 ? 0.5 : 0.3)}
          transparent
          opacity={innerOpacity}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.3, 0]}>
        <circleGeometry args={[scale * 0.8, 12]} />
        <meshBasicMaterial
          color={hColor}
          transparent
          opacity={isLocked ? 0.01 : (isOffline ? 0.02 : 0.08)}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Health ring — thin torus arc proportional to health */}
      {implant.health > 0 && !isLocked && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[scale * 1.2, 0.012, 8, 32, Math.PI * 2 * (implant.health / 100)]} />
          <meshBasicMaterial color={hColor} transparent opacity={0.4} />
        </mesh>
      )}

      {/* Billboard label */}
      <Billboard position={[0, scale * 0.8, 0]}>
        <Text
          fontSize={0.18}
          color="white"
          anchorX="center"
          outlineWidth={0.015}
          outlineColor="#000"
          fillOpacity={hovered ? 1 : (isLocked ? 0.3 : 0.6)}
        >
          {isLocked ? `\u{1F512} ${implant.name}` : implant.name}
        </Text>
        <Text
          fontSize={0.14}
          color={labelColor}
          anchorX="center"
          position={[0, -0.2, 0]}
          fillOpacity={hovered ? 0.9 : (isLocked ? 0.25 : 0.6)}
          fontWeight={700}
        >
          {isLocked ? 'LOCKED' : isOffline ? 'OFFLINE' : healthPct}
        </Text>
      </Billboard>

      {/* Hover tooltip */}
      {hovered && (
        <Html position={[scale * 1.5, 0.3, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[20, 0]}>
          <div style={{
            background: 'rgba(5,5,16,0.94)',
            border: `1px solid ${isLocked ? 'rgba(255,255,255,0.15)' : `${implant.color}40`}`,
            borderRadius: 6,
            padding: '8px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            minWidth: 140,
          }}>
            <div style={{ fontWeight: 700, color: isLocked ? 'rgba(255,255,255,0.5)' : implant.color, marginBottom: 4 }}>
              {implant.name}
            </div>
            {!isLocked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
                  <div style={{
                    width: `${implant.health}%`,
                    height: '100%',
                    borderRadius: 2,
                    background: implant.health > 80 ? implant.color : implant.health > 0 ? PALETTE.waiting : PALETTE.blocked,
                  }} />
                </div>
                <span style={{
                  color: implant.health > 80 ? implant.color : PALETTE.waiting,
                  fontWeight: 600,
                }}>{healthPct}</span>
              </div>
            )}
            {isLocked && <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, marginTop: 4 }}>Premium implant — not activated</div>}
            {isDegraded && <div style={{ color: PALETTE.waiting, fontSize: 9, marginTop: 4 }}>Degraded: performance reduced</div>}
            {isOffline && <div style={{ color: PALETTE.blocked, fontSize: 9, marginTop: 4 }}>Offline — service unavailable</div>}
          </div>
        </Html>
      )}

      {/* Hitbox */}
      <mesh
        scale={scale * 2}
        visible={false}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={handleClick}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

/**
 * NerveFibre — line from implant to nucleus. Pulses when active, grey when locked.
 */
function NerveFibre({ from, to, color, opacity = 0.1, dashed = false, pulse = false }) {
  const lineRef = useRef()
  const timeRef = useRef(Math.random() * 10)

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      if (lineRef.current && pulse) {
        lineRef.current.material.opacity = opacity + Math.sin(timeRef.current * 2) * opacity * 0.5
      }
    } catch { /* ref not ready */ }
  })

  const geo = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...from),
      new THREE.Vector3(...to),
    ])
  }, [from, to])

  return (
    <line ref={lineRef} geometry={geo}>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
      />
    </line>
  )
}

export default function ImplantsRing({ implants = [], settings = {}, onSelect }) {
  const groupRef = useRef()

  useFrame((_, delta) => {
    try {
      if (groupRef.current) groupRef.current.rotation.y += delta * 0.015
    } catch { /* ref not ready */ }
  })

  const orbitRings = useMemo(() => {
    const radii = [RADIUS - 0.3, RADIUS, RADIUS + 0.3]
    return radii.map((r) => {
      const points = []
      for (let j = 0; j <= 64; j++) {
        const a = (j / 64) * Math.PI * 2
        points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r))
      }
      return { r, geo: new THREE.BufferGeometry().setFromPoints(points) }
    })
  }, [])

  const N = implants.length
  if (N === 0) return null

  return (
    <group ref={groupRef}>
      {/* Triple orbit rings */}
      {orbitRings.map(({ r, geo }, i) => (
        <line key={r} geometry={geo}>
          <lineBasicMaterial color={PALETTE.violet} transparent opacity={i === 1 ? 0.08 : 0.03} />
        </line>
      ))}

      {/* Zone label */}
      <Billboard position={[0, 1.2, RADIUS + 0.5]}>
        <Text
          fontSize={0.35}
          color={PALETTE.violet}
          anchorX="center"
          fillOpacity={settings.zoneLabelOpacity || 0.3}
          outlineWidth={0.02}
          outlineColor="#000"
        >
          IMPLANTS
        </Text>
      </Billboard>

      {/* Nerve fibres — lines from each implant to the nucleus */}
      {implants.map((implant, i) => {
        const angle = (i / N) * Math.PI * 2 - Math.PI / 2
        const yOff = LAYER_Y_OFFSETS[implant.layer] || 0
        const ix = Math.cos(angle) * RADIUS
        const iz = Math.sin(angle) * RADIUS
        const isLocked = implant.locked
        const isActive = !isLocked && implant.health > 30
        return (
          <NerveFibre
            key={`nerve-${implant.id}`}
            from={[ix, yOff, iz]}
            to={[0, 0, 0]}
            color={isLocked ? '#555570' : implant.color}
            opacity={isLocked ? 0.03 : isActive ? 0.12 : 0.05}
            dashed={isLocked}
            pulse={isActive}
          />
        )
      })}

      {/* Dynamic implant nodes */}
      {implants.map((implant, i) => (
        <ImplantNode
          key={implant.id}
          implant={implant}
          angle={(i / N) * Math.PI * 2 - Math.PI / 2}
          index={i}
          onSelect={onSelect}
        />
      ))}
    </group>
  )
}
