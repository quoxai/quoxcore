/**
 * LLMProviderDots — LLM provider dots orbiting near the nucleus.
 *
 * Phase CC-13: Additional Data Layers.
 * Derives unique providers from assistants.js llm config.
 * Each provider = a larger octahedron at r=3 (just outside nucleus).
 * Currently all Anthropic, but ready for multi-provider future.
 */
import { useRef, useMemo, useState, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { assistants } from '../../../config/assistants'

const RING_RADIUS = 3
const DOT_SCALE = 0.25
const ORBIT_SPEED = 0.02

const PROVIDER_COLORS = {
  anthropic: '#cc785c',
  openai: '#10a37f',
  google: '#4285f4',
  meta: '#0668E1',
  local: '#f59e0b',
}

const PROVIDER_NAMES = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  meta: 'Meta',
  local: 'Local Inference',
}

function ProviderNode({ provider, position, onSelect }) {
  const wireRef = useRef()
  const [hovered, setHovered] = useState(false)
  const color = useMemo(() => new THREE.Color(provider.color), [provider.color])

  useFrame((_, delta) => {
    try {
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.15
        wireRef.current.rotation.x += delta * 0.05
      }
    } catch {}
  })

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'llm-provider',
      id: provider.id,
      name: provider.name,
      role: 'provider',
      state: 'active',
      color: provider.color,
      description: `${provider.models.length} model${provider.models.length > 1 ? 's' : ''}: ${provider.models.join(', ')}`,
      position,
    })
  }, [provider, position, onSelect])

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={DOT_SCALE * (hovered ? 1.2 : 1)}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh scale={DOT_SCALE * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} transparent opacity={0.7} roughness={0.2} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -DOT_SCALE * 0.6, 0]}>
        <circleGeometry args={[DOT_SCALE * 0.8, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
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
      <Billboard position={[0, DOT_SCALE * 1.2, 0]}>
        <Text fontSize={0.12} color="white" anchorX="center" anchorY="middle"
          outlineWidth={0.01} outlineColor="#000000" fillOpacity={hovered ? 0.85 : 0.4}>
          {provider.name}
        </Text>
      </Billboard>
    </group>
  )
}

export default function LLMProviderDots({ onSelect }) {
  const groupRef = useRef()

  // Extract unique providers and their models from assistants config
  const providers = useMemo(() => {
    const providerMap = new Map()

    Object.values(assistants).forEach(a => {
      if (!a?.llm?.provider) return
      const pid = a.llm.provider
      if (!providerMap.has(pid)) {
        providerMap.set(pid, { id: pid, models: new Set() })
      }
      if (a.llm.model) providerMap.get(pid).models.add(a.llm.model)
    })

    return Array.from(providerMap.values()).map((p, i) => {
      const angle = (i / Math.max(providerMap.size, 1)) * Math.PI * 2
      const models = Array.from(p.models)
      return {
        id: p.id,
        name: PROVIDER_NAMES[p.id] || p.id,
        color: PROVIDER_COLORS[p.id] || '#8b5cf6',
        models,
        position: [
          Math.cos(angle) * RING_RADIUS,
          0.5,
          Math.sin(angle) * RING_RADIUS,
        ],
      }
    })
  }, [])

  useFrame((_, delta) => {
    try {
      if (groupRef.current) groupRef.current.rotation.y += ORBIT_SPEED * delta
    } catch {}
  })

  if (providers.length === 0) return null

  return (
    <group ref={groupRef}>
      {providers.map(p => (
        <ProviderNode key={p.id} provider={p} position={p.position} onSelect={onSelect} />
      ))}
    </group>
  )
}
