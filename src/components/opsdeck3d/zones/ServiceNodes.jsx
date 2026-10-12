/**
 * ServiceNodes — Infrastructure service nodes inside the Core Shell.
 *
 * Clustered in a tight ring at r=6 (between nucleus and implants).
 * Each node is a small 3-layer octahedron with status colouring.
 * A faint ring at r=6 represents the service mesh.
 *
 * Mock data only — not wired to real APIs.
 */
import { useRef, useMemo, useCallback, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

// Service definitions — health checks go through collector proxy where possible
const SERVICE_DEFS = [
  { id: 'collector', name: 'Collector', port: 9848, healthUrl: '/collector/health' },
  { id: 'quoxflow', name: 'QuoxFlow', port: 3200, healthUrl: '/quoxflow/health' },
  { id: 'auth', name: 'Auth', port: 3101, healthUrl: '/collector/internal/service-health?service=auth' },
  { id: 'memory', name: 'Memory', port: 3103, healthUrl: '/collector/internal/service-health?service=memory' },
  { id: 'tasks', name: 'Tasks', port: 3104, healthUrl: '/collector/internal/service-health?service=tasks' },
  { id: 'orchestrator', name: 'Orchestrator', port: 3100, healthUrl: null },
  { id: 'files', name: 'Files', port: 3102, healthUrl: null },
  { id: 'postgres', name: 'Postgres', port: 5432, healthUrl: null },
  { id: 'qdrant', name: 'Qdrant', port: 6333, healthUrl: null },
  { id: 'screencap', name: 'ScreenCap', port: 3300, healthUrl: null },
  { id: 'dashboard', name: 'Dashboard', port: 3000, healthUrl: null },
]

const STATUS_COLORS = { healthy: '#22c55e', degraded: '#f59e0b', down: '#ef4444', unknown: '#555570' }

const RING_RADIUS = 4  // Fibonacci layout: services at r=4
const NODE_SCALE = 0.3

// ─── Single Service Node ────────────────────────────────────
function ServiceNode({ service, position, onSelect }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const [hovered, setHovered] = useState(false)

  const nodeColor = useMemo(() => new THREE.Color(service.color), [service.color])
  const isDegraded = service.status === 'degraded'
  const isDown = service.status === 'down'

  useFrame((_, delta) => {
    try {
      timeRef.current += delta
      const t = timeRef.current

      // Slow wireframe rotation
      if (wireRef.current) {
        wireRef.current.rotation.y += delta * 0.15
        wireRef.current.rotation.x += delta * 0.05
      }
      if (innerRef.current) {
        innerRef.current.rotation.y -= delta * 0.1

        // Degraded nodes pulse amber
        if (isDegraded) {
          const pulse = 0.4 + Math.sin(t * 3) * 0.3
          innerRef.current.material.emissiveIntensity = pulse
        }
      }
    } catch { /* ref not ready */ }
  })

  const baseGlow = isDown ? 0.15 : isDegraded ? 0.5 : 0.4

  const handleClick = useCallback(() => {
    onSelect?.({ type: 'service', id: service.id, name: service.name, role: 'service', port: service.port, status: service.status, color: service.color, position })
  }, [onSelect, service, position])

  return (
    <group position={position}>
      {/* Invisible hitbox for click detection */}
      <mesh
        onClick={handleClick}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
        visible={false}
      >
        <sphereGeometry args={[NODE_SCALE * 1.5, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* Outer wireframe octahedron */}
      <mesh ref={wireRef} scale={NODE_SCALE}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={nodeColor}
          wireframe
          transparent
          opacity={0.3}
        />
      </mesh>

      {/* Inner solid core */}
      <mesh ref={innerRef} scale={NODE_SCALE * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={nodeColor}
          emissive={nodeColor}
          emissiveIntensity={baseGlow}
          transparent
          opacity={isDown ? 0.3 : 0.7}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -NODE_SCALE * 0.6, 0]}>
        <circleGeometry args={[NODE_SCALE * 0.8, 12]} />
        <meshBasicMaterial
          color={nodeColor}
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Billboard label: name + port + detail */}
      <Billboard position={[0, NODE_SCALE * 1.1, 0]}>
        <Text
          fontSize={0.15}
          color="white"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.012}
          outlineColor="#000000"
          fillOpacity={hovered ? 0.85 : 0.5}
        >
          {`${service.name} :${service.port}`}
        </Text>
        {hovered && service.detail && (
          <Text
            fontSize={0.1}
            color={service.color || '#22c55e'}
            anchorX="center"
            anchorY="middle"
            position={[0, -0.18, 0]}
            fillOpacity={0.6}
          >
            {service.detail}
          </Text>
        )}
      </Billboard>
    </group>
  )
}

// ─── Health polling hook ──────────────────────────────────────
function useServiceHealth() {
  const [services, setServices] = useState(() =>
    SERVICE_DEFS.map(s => ({ ...s, status: 'unknown', color: STATUS_COLORS.unknown, detail: null }))
  )

  useEffect(() => {
    let mounted = true

    async function poll() {
      // First, check collector health — it has uptime + version + agent count
      let collectorHealthy = false
      let collectorData = null
      try {
        const res = await fetch('/collector/health', { credentials: 'include', signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          collectorData = await res.json()
          collectorHealthy = true
        }
      } catch {}

      // Check quoxflow health
      let quoxflowData = null
      try {
        const res = await fetch('/quoxflow/health', { credentials: 'include', signal: AbortSignal.timeout(3000) })
        if (res.ok) quoxflowData = await res.json()
      } catch {}

      const results = SERVICE_DEFS.map(svc => {
        if (svc.id === 'collector') {
          if (collectorData) {
            const upH = Math.floor(collectorData.uptime_seconds / 3600)
            const upM = Math.floor((collectorData.uptime_seconds % 3600) / 60)
            return { ...svc, status: 'healthy', color: STATUS_COLORS.healthy,
              detail: `v${collectorData.version} \u00B7 ${upH}h${upM}m \u00B7 ${collectorData.agents_connected} agents` }
          }
          return { ...svc, status: 'down', color: STATUS_COLORS.down, detail: null }
        }
        if (svc.id === 'quoxflow') {
          if (quoxflowData) {
            return { ...svc, status: 'healthy', color: STATUS_COLORS.healthy,
              detail: `v${quoxflowData.version} \u00B7 ${quoxflowData.activeSchedules} schedules` }
          }
          return { ...svc, status: collectorHealthy ? 'unknown' : 'down', color: collectorHealthy ? STATUS_COLORS.unknown : STATUS_COLORS.down, detail: null }
        }
        if (svc.id === 'dashboard') {
          // We're running, so dashboard is healthy
          return { ...svc, status: 'healthy', color: STATUS_COLORS.healthy, detail: 'This instance' }
        }
        // For all other services: if collector is healthy, they're likely up
        // (collector depends on auth, which depends on postgres)
        if (collectorHealthy) {
          return { ...svc, status: 'healthy', color: STATUS_COLORS.healthy, detail: `Inferred from collector` }
        }
        return { ...svc, status: 'unknown', color: STATUS_COLORS.unknown, detail: null }
      })

      if (mounted) setServices(results)
    }

    poll()
    const interval = setInterval(poll, 15000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  return services
}

// ─── ServiceNodes (group) ───────────────────────────────────
export default function ServiceNodes({ settings = {}, onSelect }) {
  const ringRef = useRef()
  const services = useServiceHealth()

  // Position services evenly around ring
  const nodePositions = useMemo(() => {
    return services.map((service, i) => {
      const angle = (i / services.length) * Math.PI * 2
      return {
        service,
        position: [
          Math.cos(angle) * RING_RADIUS,
          0,
          Math.sin(angle) * RING_RADIUS,
        ],
      }
    })
  }, [services])

  return (
    <group>
      {/* Service mesh ring — faint connecting ring at r=6 */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[RING_RADIUS, 0.012, 8, 64]} />
        <meshBasicMaterial
          color={new THREE.Color(PALETTE.cyan)}
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Service nodes */}
      {nodePositions.map(({ service, position }) => (
        <ServiceNode
          key={service.id}
          service={service}
          position={position}
          onSelect={onSelect}
        />
      ))}

      {/* Zone label */}
      <Billboard position={[0, 2.5, RING_RADIUS + 1.5]}>
        <Text
          fontSize={0.22}
          color={PALETTE.cyan}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.015}
          outlineColor="#000000"
          fillOpacity={settings.zoneLabelOpacity ?? 0.3}
          letterSpacing={0.15}
        >
          SERVICES
        </Text>
      </Billboard>
    </group>
  )
}
