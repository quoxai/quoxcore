/**
 * InfraLayer — Multi-layer infrastructure tower below the core.
 *
 * Stacked rings forming a downward tower, each layer = one infra source:
 *   y=-10: Docker Containers (REAL — polls /collector/docker/containers)
 *   y=-16: Physical Hosts (from hosts.js registry / bastion)
 *   y=-22: Uptime Kuma Monitors (placeholder until API wired)
 *   y=-28: QuoxAgent Fleet VMs (REAL — polls /api/v1/agents; honest empty when unreachable)
 *
 * Same entity appearing in multiple layers gets connection lines between.
 * Each layer has its own ring colour and label.
 */
import { useRef, useMemo, useState, useEffect, useCallback } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useDisposable } from '../lib/useDisposable'

const FONT_STACK = "'JetBrains Mono', monospace"
const STATUS_COLORS = { healthy: '#22c55e', running: '#22c55e', unhealthy: '#f59e0b', exited: '#ef4444', unknown: '#555570', offline: '#ef4444', degraded: '#f59e0b' }
const NODE_SCALE = 0.25

function getStatusFromDocker(status) {
  if (!status) return { state: 'unknown', color: STATUS_COLORS.unknown }
  const lower = status.toLowerCase()
  if (lower.includes('healthy')) return { state: 'healthy', color: STATUS_COLORS.healthy }
  if (lower.includes('unhealthy')) return { state: 'unhealthy', color: STATUS_COLORS.unhealthy }
  if (lower.includes('up')) return { state: 'running', color: STATUS_COLORS.running }
  if (lower.includes('exited')) return { state: 'exited', color: STATUS_COLORS.exited }
  return { state: 'unknown', color: STATUS_COLORS.unknown }
}

// ─── Layer definition ───────────────────────────────────
const LAYERS = [
  { id: 'docker',  label: 'DOCKER CONTAINERS', y: -10, radius: 15, color: '#06b6d4', ringColor: '#06b6d4' },
  { id: 'hosts',   label: 'PHYSICAL HOSTS',    y: -16, radius: 12, color: '#8b5cf6', ringColor: '#8b5cf6' },
  { id: 'kuma',    label: 'UPTIME MONITORS',   y: -22, radius: 10, color: '#22c55e', ringColor: '#22c55e' },
  { id: 'fleet',   label: 'QUOXAGENT FLEET',   y: -28, radius: 13, color: '#f59e0b', ringColor: '#f59e0b' },
]

// Known physical hosts (illustrative fleet topology — fictional addresses)
const KNOWN_HOSTS = [
  { id: 'gw-01', name: 'gw-01 (Bastion)', role: 'bastion', ip: '198.51.100.247', status: 'healthy' },
  { id: 'control', name: 'control (Workstation)', role: 'workstation', ip: '198.51.100.126', status: 'healthy' },
  { id: 'hyp-01', name: 'hyp-01 (Proxmox)', role: 'proxmox', ip: '203.0.113.10', status: 'unknown' },
  { id: 'hyp-02', name: 'hyp-02 (Proxmox)', role: 'proxmox', ip: '203.0.113.11', status: 'unknown' },
  { id: 'hyp-03', name: 'hyp-03 (Proxmox)', role: 'proxmox', ip: '203.0.113.12', status: 'unknown' },
  { id: 'edge-01', name: 'edge-01', role: 'docker', ip: '203.0.113.101', status: 'unknown' },
  { id: 'edge-02', name: 'edge-02', role: 'docker', ip: '203.0.113.102', status: 'unknown' },
  { id: 'edge-03', name: 'edge-03', role: 'docker', ip: '203.0.113.103', status: 'unknown' },
  { id: 'edge-04', name: 'edge-04', role: 'docker', ip: '203.0.113.104', status: 'unknown' },
  { id: 'hetzner', name: 'hetzner (quox.ai)', role: 'external', ip: '203.0.113.191', status: 'unknown' },
]

// ─── Infra Node ─────────────────────────────────────────
function InfraNode({ position, name, status, statusColor, detail, layerColor, onSelect }) {
  const wireRef = useRef()
  const [hovered, setHovered] = useState(false)
  const nodeColor = useMemo(() => new THREE.Color(statusColor || layerColor), [statusColor, layerColor])

  useFrame((_, delta) => {
    try { if (wireRef.current) wireRef.current.rotation.y += delta * 0.08 } catch {}
  })

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({ type: 'host', id: name, name, role: 'infrastructure', state: status, color: statusColor || layerColor, description: detail, position })
  }, [name, status, statusColor, layerColor, detail, position, onSelect])

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={NODE_SCALE * (hovered ? 1.2 : 1)}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={nodeColor} wireframe transparent opacity={hovered ? 0.5 : 0.25} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh scale={NODE_SCALE * 0.6}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={nodeColor} emissive={nodeColor} emissiveIntensity={0.4} transparent opacity={0.6} roughness={0.3} />
      </mesh>
      <Billboard position={[0, NODE_SCALE * 1.3, 0]}>
        <Text fontSize={0.12} color="white" anchorX="center" anchorY="middle"
          outlineWidth={0.008} outlineColor="#000000" fillOpacity={hovered ? 0.85 : 0.4}>
          {name}
        </Text>
        {hovered && detail && (
          <Text fontSize={0.09} color={statusColor || layerColor} anchorX="center" anchorY="middle"
            position={[0, -0.16, 0]} fillOpacity={0.6}>
            {detail}
          </Text>
        )}
      </Billboard>
      <mesh scale={NODE_SCALE * 2.5}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
        onClick={handleClick} visible={false}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

// ─── Layer Ring + Label ─────────────────────────────────
function LayerRing({ layer, nodeCount }) {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, layer.y, 0]}>
        <torusGeometry args={[layer.radius, 0.015, 8, 64]} />
        <meshBasicMaterial color={layer.ringColor} transparent opacity={0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <Billboard position={[0, layer.y + 0.6, layer.radius + 1]}>
        <Text fontSize={0.18} color={layer.color} anchorX="center" anchorY="middle"
          fillOpacity={0.3} outlineWidth={0.008} outlineColor="#000000" letterSpacing={0.08}>
          {`${layer.label} \u00B7 ${nodeCount}`}
        </Text>
      </Billboard>
    </>
  )
}

// ─── Connection Line (same entity across layers) ────────
function CrossLayerLine({ from, to, color }) {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...from, ...to]), 3))
    return g
  }, [from, to])
  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.08} depthWrite={false} />
    </line>
  )
}

// ─── Vertical mast connecting all layers ────────────────
function TowerMast() {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -8, 0, 0, -30, 0]), 3))
    return g
  }, [])
  return (
    <line geometry={geometry}>
      <lineBasicMaterial color="#8b5cf6" transparent opacity={0.04} depthWrite={false} />
    </line>
  )
}

// ─── Main Component ─────────────────────────────────────
export default function InfraLayer({ settings = {}, onSelect }) {
  const [containers, setContainers] = useState([])
  const [fleetAgents, setFleetAgents] = useState(null)
  const [fleetSummary, setFleetSummary] = useState(null)

  // Poll real Docker containers
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/collector/docker/containers', { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          if (mounted && data.containers) {
            const seen = new Set()
            const unique = data.containers.filter(c => {
              if (seen.has(c.name)) return false
              seen.add(c.name)
              return true
            })
            setContainers(unique)
          }
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  // Poll real fleet agents from collector API
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/api/v1/agents', { credentials: 'include', signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = await res.json()
          if (mounted && Array.isArray(data)) {
            setFleetAgents(data.map(a => ({
              id: a.host_id || a.id,
              name: a.host_id || a.id,
              role: `fleet-${a.host_id || 'agent'}`,
              status: a.connection_status || 'unknown',
              detail: `${a.connection_status || '?'} · ${a.version || '?'} · ${a.os || ''}`,
            })))
          }
        }
      } catch {
        // Fleet API not reachable — keep fallback
      }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  // Poll fleet summary for aggregate health
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/api/v1/fleet/summary', { credentials: 'include', signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = await res.json()
          if (mounted) setFleetSummary(data)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  // Build nodes for each layer
  const { dockerNodes, hostNodes, kumaNodes, fleetNodes, crossLinks } = useMemo(() => {
    const dockerLayer = LAYERS[0]
    const hostLayer = LAYERS[1]
    const kumaLayer = LAYERS[2]
    const fleetLayer = LAYERS[3]

    // Docker containers
    const dn = containers.map((c, i) => {
      const angle = (i / Math.max(containers.length, 1)) * Math.PI * 2
      const { state, color } = getStatusFromDocker(c.status)
      return {
        key: c.name, name: c.name, status: state, color,
        detail: `${c.status} \u00B7 ${c.image?.split(':').pop() || ''}`,
        layerColor: dockerLayer.color,
        position: [Math.cos(angle) * dockerLayer.radius, dockerLayer.y, Math.sin(angle) * dockerLayer.radius],
      }
    })

    // Physical hosts — infer health from fleet summary + container data
    const hasContainers = dn.length > 0
    const hasFleet = fleetSummary?.connected > 0
    const hn = KNOWN_HOSTS.map((h, i) => {
      const angle = (i / KNOWN_HOSTS.length) * Math.PI * 2
      // Infer status: if containers are running, docker hosts are up.
      // If fleet is connected, fleet-related hosts are reachable.
      let inferredStatus = h.status
      if (h.role === 'docker' && hasContainers) inferredStatus = 'healthy'
      if (h.role === 'workstation') inferredStatus = 'healthy' // we're running on it
      if (h.role === 'bastion' && (hasContainers || hasFleet)) inferredStatus = 'healthy'
      if (h.role === 'external' && hasContainers) inferredStatus = 'healthy' // website serves from same stack
      return {
        key: h.id, name: h.name, status: inferredStatus, color: STATUS_COLORS[inferredStatus] || STATUS_COLORS.unknown,
        detail: `${h.ip} \u00B7 ${h.role}${inferredStatus !== h.status ? ' (inferred)' : ''}`,
        layerColor: hostLayer.color,
        position: [Math.cos(angle) * hostLayer.radius, hostLayer.y, Math.sin(angle) * hostLayer.radius],
      }
    })

    // Kuma / monitoring layer — show fleet summary stats if available
    const kn = fleetSummary ? [
      { key: 'fleet-connected', name: `${fleetSummary.connected || 0} Connected`, status: 'healthy', color: STATUS_COLORS.healthy,
        detail: `${fleetSummary.connected || 0} agents online`, layerColor: kumaLayer.color,
        position: [-kumaLayer.radius * 0.5, kumaLayer.y, kumaLayer.radius * 0.87] },
      { key: 'fleet-stale', name: `${fleetSummary.stale || 0} Stale`, status: fleetSummary.stale > 0 ? 'degraded' : 'healthy',
        color: fleetSummary.stale > 0 ? STATUS_COLORS.degraded : STATUS_COLORS.healthy,
        detail: `${fleetSummary.stale || 0} stale agents`, layerColor: kumaLayer.color,
        position: [kumaLayer.radius * 0.5, kumaLayer.y, kumaLayer.radius * 0.87] },
      { key: 'fleet-dead', name: `${fleetSummary.dead || 0} Dead`, status: fleetSummary.dead > 0 ? 'offline' : 'healthy',
        color: fleetSummary.dead > 0 ? STATUS_COLORS.offline : STATUS_COLORS.healthy,
        detail: `${fleetSummary.dead || 0} dead agents`, layerColor: kumaLayer.color,
        position: [0, kumaLayer.y, -kumaLayer.radius] },
    ] : [
      { key: 'kuma-api', name: 'Fleet Monitor', status: 'unknown', color: STATUS_COLORS.unknown,
        detail: 'API not connected', layerColor: kumaLayer.color,
        position: [0, kumaLayer.y, kumaLayer.radius] },
    ]

    // Fleet VMs — real data from /api/v1/agents only. Honest empty when
    // unreachable (no fabricated VM list — see anti-mock cleanup).
    const fleetSource = fleetAgents || []
    const fn = fleetSource.map((v, i) => {
      const angle = (i / fleetSource.length) * Math.PI * 2
      const status = v.status === 'connected' ? 'healthy' : v.status === 'stale' ? 'degraded' : v.status === 'dead' ? 'offline' : v.status
      return {
        key: v.id, name: v.name, status, color: STATUS_COLORS[status] || STATUS_COLORS.unknown,
        detail: v.detail || `${v.role} \u00B7 ${status}`,
        layerColor: fleetLayer.color,
        position: [Math.cos(angle) * fleetLayer.radius, fleetLayer.y, Math.sin(angle) * fleetLayer.radius],
      }
    })

    // Cross-layer connections: docker hosts ↔ physical hosts
    const links = []
    // docker01-04 containers → physical docker01-04 hosts
    const dockerHostMap = { 'docker01': 'docker01', 'docker02': 'docker02', 'docker03': 'docker03', 'docker04': 'docker04' }
    hn.forEach(host => {
      const hostKey = host.key
      if (hostKey === 'control') {
        // Control workstation runs the local Docker stack
        const localDocker = dn.find(d => d.name === 'quox-dashboard')
        if (localDocker) {
          links.push({ from: localDocker.position, to: host.position, color: '#8b5cf6' })
        }
      }
    })

    return { dockerNodes: dn, hostNodes: hn, kumaNodes: kn, fleetNodes: fn, crossLinks: links }
  }, [containers, fleetAgents, fleetSummary])

  return (
    <group>
      <TowerMast />

      {/* Layer rings + labels */}
      <LayerRing layer={LAYERS[0]} nodeCount={dockerNodes.length} />
      <LayerRing layer={LAYERS[1]} nodeCount={hostNodes.length} />
      <LayerRing layer={LAYERS[2]} nodeCount={kumaNodes.length} />
      <LayerRing layer={LAYERS[3]} nodeCount={fleetNodes.length} />

      {/* Docker containers (REAL DATA) */}
      {dockerNodes.map(n => (
        <InfraNode key={n.key} position={n.position} name={n.name} status={n.status}
          statusColor={n.color} detail={n.detail} layerColor={n.layerColor} onSelect={onSelect} />
      ))}

      {/* Physical hosts */}
      {hostNodes.map(n => (
        <InfraNode key={n.key} position={n.position} name={n.name} status={n.status}
          statusColor={n.color} detail={n.detail} layerColor={n.layerColor} onSelect={onSelect} />
      ))}

      {/* Kuma monitors */}
      {kumaNodes.map(n => (
        <InfraNode key={n.key} position={n.position} name={n.name} status={n.status}
          statusColor={n.color} detail={n.detail} layerColor={n.layerColor} onSelect={onSelect} />
      ))}

      {/* Fleet VMs */}
      {fleetNodes.map(n => (
        <InfraNode key={n.key} position={n.position} name={n.name} status={n.status}
          statusColor={n.color} detail={n.detail} layerColor={n.layerColor} onSelect={onSelect} />
      ))}

      {/* Cross-layer connections */}
      {crossLinks.map((link, i) => (
        <CrossLayerLine key={`cl-${i}`} from={link.from} to={link.to} color={link.color} />
      ))}
    </group>
  )
}
