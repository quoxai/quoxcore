/**
 * PluginConstellation — Plugin nodes orbiting the implants ring.
 *
 * Phase CC-13: Additional Data Layers.
 * 32+ plugin dots at r=9.5, coloured by their manifest accentColor.
 * Licensed/active plugins: full colour, 0.6 opacity, emissive glow.
 * Unlicensed plugins: same colour, 0.2 opacity (dim but coloured, not grey).
 * Each node uses the 3-layer octahedron structure (wireframe + inner core + ground disc).
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PLUGINS } from '../../../config/plugins/index.js'

const RING_RADIUS = 12  // Fibonacci layout: plugins at r=12
const DOT_SCALE = 0.2
const ORBIT_SPEED = 0.01 // rad/s

// Default colour if no accentColor in manifest
const DEFAULT_ACCENT = '#8b5cf6'

// Shared geometry
const octGeometry = new THREE.OctahedronGeometry(1, 0)
const discGeometry = new THREE.CircleGeometry(1, 12)

function getPluginColor(manifest) {
  return manifest.accentColor || DEFAULT_ACCENT
}

function PluginNode({ plugin, onSelect }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const [hovered, setHovered] = useState(false)

  const color = useMemo(() => new THREE.Color(plugin.color), [plugin.color])
  const opacity = plugin.isLicensed ? 0.6 : 0.2
  const glowIntensity = plugin.isLicensed ? 0.5 : 0.15

  useFrame((_, delta) => {
    try {
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.12
        wireRef.current.rotation.x += delta * 0.04
      }
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.08
      }
    } catch { /* ref not ready */ }
  })

  const hoverMult = hovered ? 1.2 : 1

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'plugin',
      id: plugin.id,
      name: plugin.name,
      role: 'plugin',
      state: plugin.isLicensed ? 'active' : 'inactive',
      color: plugin.color,
      description: `${plugin.tier} \u00B7 ${plugin.price > 0 ? '$' + plugin.price : 'Free'}`,
      position: plugin.position,
    })
  }, [plugin, onSelect])

  return (
    <group position={plugin.position}>
      {/* Outer wireframe octahedron */}
      <mesh ref={wireRef} scale={DOT_SCALE * hoverMult}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={opacity * 0.6 * (hovered ? 1.5 : 1)}
        />
      </mesh>

      {/* Inner solid core */}
      <mesh ref={innerRef} scale={DOT_SCALE * 0.65 * hoverMult}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={glowIntensity * (hovered ? 1.4 : 1)}
          transparent
          opacity={opacity}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -DOT_SCALE * 0.6, 0]}>
        <circleGeometry args={[DOT_SCALE * 0.8, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity * 0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Hitbox */}
      <mesh
        scale={DOT_SCALE * 2}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
        onClick={handleClick}
        visible={false}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* Hover label */}
      {hovered && (
        <Billboard position={[0, DOT_SCALE * 1.3, 0]}>
          <Text
            fontSize={0.18}
            color="white"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.015}
            outlineColor="#000000"
            fillOpacity={0.85}
          >
            {plugin.name}
          </Text>
          <Text
            fontSize={0.12}
            color={plugin.color}
            anchorX="center"
            anchorY="middle"
            position={[0, -0.2, 0]}
            fillOpacity={0.6}
          >
            {plugin.price > 0 ? `$${plugin.price}` : 'Free'}
          </Text>
        </Billboard>
      )}
    </group>
  )
}

export default function PluginConstellation({ onSelect }) {
  const groupRef = useRef()

  // Build plugin data array from registry
  const pluginData = useMemo(() => {
    const entries = Object.entries(PLUGINS)
    return entries.map(([id, manifest], i) => {
      const angle = (i / entries.length) * Math.PI * 2
      const yJitter = (Math.sin(i * 2.7) * 0.3)
      const rJitter = RING_RADIUS + Math.cos(i * 1.3) * 0.4
      return {
        id,
        name: manifest.displayName || id,
        tier: manifest.tier || 'free',
        price: manifest.price || 0,
        color: getPluginColor(manifest),
        position: [
          Math.cos(angle) * rJitter,
          yJitter,
          Math.sin(angle) * rJitter,
        ],
        isLicensed: manifest.price === 0, // Free plugins always "active"
      }
    })
  }, [])

  // Orbit the whole group slowly
  useFrame((_, delta) => {
    try {
      if (groupRef.current) {
        groupRef.current.rotation.y += ORBIT_SPEED * delta
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group ref={groupRef}>
      {/* Zone label */}
      <Billboard position={[0, 0.6, RING_RADIUS]}>
        <Text
          fontSize={0.25}
          color="rgba(255,255,255,0.25)"
          anchorX="center"
          anchorY="middle"
          font={undefined}
          letterSpacing={0.15}
        >
          PLUGINS
        </Text>
      </Billboard>

      {/* Individual plugin nodes with 3-layer structure */}
      {pluginData.map((plugin) => (
        <PluginNode key={plugin.id} plugin={plugin} onSelect={onSelect} />
      ))}
    </group>
  )
}
