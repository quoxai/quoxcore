/**
 * IntegrationDots — Active integration/connector dots on NestedShells surface.
 *
 * Phase CC-13: Additional Data Layers.
 * Polls /connectors/status every 20s. Each active connector = a dot at r=135
 * (CORE shell surface). Renders nothing when no connectors are configured or
 * the API is unreachable — no mock connector list is substituted.
 */
import { useRef, useMemo, useState, useEffect, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const SHELL_RADIUS = 135  // CORE shell from NestedShells
const DOT_SCALE = 0.35
const ORBIT_SPEED = 0.005

const CATEGORY_COLORS = {
  development: '#818cf8',
  project: '#22c55e',
  knowledge: '#f59e0b',
  communication: '#06b6d4',
  security: '#ef4444',
}

// Shared geometry
const octGeo = new THREE.OctahedronGeometry(1, 0)

function IntegrationNode({ connector, position, onSelect }) {
  const wireRef = useRef()
  const [hovered, setHovered] = useState(false)
  const color = useMemo(() => new THREE.Color(connector.color), [connector.color])
  const isActive = connector.active !== false

  useFrame((_, delta) => {
    try {
      if (wireRef.current) wireRef.current.rotation.y += delta * 0.1
    } catch {}
  })

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'integration',
      id: connector.id,
      name: connector.name,
      role: 'connector',
      state: isActive ? 'active' : 'inactive',
      color: connector.color,
      description: `${connector.category || 'unknown'} connector${connector.toolCount ? ` · ${connector.toolCount} tools` : ''}`,
      position,
    })
  }, [connector, position, isActive, onSelect])

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={DOT_SCALE * (hovered ? 1.2 : 1)} geometry={octGeo}>
        <meshBasicMaterial color={color} wireframe transparent opacity={isActive ? 0.35 : 0.12} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh scale={DOT_SCALE * 0.6} geometry={octGeo}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isActive ? 0.5 : 0.15} transparent opacity={isActive ? 0.6 : 0.2} roughness={0.3} />
      </mesh>
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
      {hovered && (
        <Billboard position={[0, DOT_SCALE * 1.5, 0]}>
          <Text fontSize={0.5} color="white" anchorX="center" anchorY="middle"
            outlineWidth={0.03} outlineColor="#000000" fillOpacity={0.85}>
            {connector.name}
          </Text>
        </Billboard>
      )}
    </group>
  )
}

export default function IntegrationDots({ onSelect }) {
  const groupRef = useRef()
  const [connectors, setConnectors] = useState(null)

  // Poll connector status
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/connectors/status', { credentials: 'include', signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = await res.json()
          if (mounted && data.connectors) {
            setConnectors(data.connectors.map(c => ({
              id: c.id,
              name: c.name || c.id,
              category: c.category || 'unknown',
              color: CATEGORY_COLORS[c.category] || '#8b5cf6',
              active: c.active !== false,
              toolCount: c.toolCount || c.tools?.length || 0,
            })))
          }
        }
      } catch {
        // API not reachable — leave connectors empty (honest state, no mock substitution)
      }
    }
    poll()
    const interval = setInterval(poll, 20000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  const displayConnectors = connectors || []

  // Position dots on CORE shell surface (equatorial band)
  const nodes = useMemo(() => {
    if (displayConnectors.length === 0) return []
    return displayConnectors.map((c, i) => {
      const angle = (i / displayConnectors.length) * Math.PI * 2
      const yJitter = Math.sin(i * 2.1) * 2
      return {
        connector: c,
        position: [
          Math.cos(angle) * SHELL_RADIUS,
          yJitter,
          Math.sin(angle) * SHELL_RADIUS,
        ],
      }
    })
  }, [displayConnectors])

  useFrame((_, delta) => {
    try {
      if (groupRef.current) groupRef.current.rotation.y += ORBIT_SPEED * delta
    } catch {}
  })

  if (displayConnectors.length === 0) return null

  return (
    <group ref={groupRef}>
      <Billboard position={[0, 4, SHELL_RADIUS]}>
        <Text fontSize={0.8} color="rgba(255,255,255,0.2)" anchorX="center" anchorY="middle" letterSpacing={0.12}>
          INTEGRATIONS
        </Text>
      </Billboard>

      {nodes.map(({ connector, position }) => (
        <IntegrationNode key={connector.id} connector={connector} position={position} onSelect={onSelect} />
      ))}
    </group>
  )
}
