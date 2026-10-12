/**
 * ThreeDLabView — Fullscreen 3D Component Laboratory
 *
 * Unified design language: all nodes are octahedrons at different scales.
 * Role = scale. State = colour + glow. Every object belongs to one family.
 * Hover = tooltip. Click = info panel. Settings sliders = live tuning.
 *
 * This is the prototype lab AND the component reference for production OpsDeck3D.
 */
import { useState, useCallback, Suspense, useRef, useEffect, useMemo, createContext, useContext } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html, Billboard, Text } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'

// Zones
import HoloGrid from '../../components/opsdeck3d/zones/HoloGrid'
import Nucleus from '../../components/opsdeck3d/zones/Nucleus'
import CoreShell from '../../components/opsdeck3d/zones/CoreShell'
import AgentNode from '../../components/opsdeck3d/zones/AgentNode'

// Effects
import AmbientParticles from '../../components/opsdeck3d/effects/AmbientParticles'
import DelegationArc from '../../components/opsdeck3d/effects/DelegationArc'
import ShockwaveRipple from '../../components/opsdeck3d/effects/ShockwaveRipple'

// Zones — structural
import ZoneRings, { TaskOrbitPath, MemoryOrbitPath } from '../../components/opsdeck3d/zones/ZoneRings'

// Lib
import { fibonacciSphere } from '../../components/opsdeck3d/lib/fibonacci-sphere'
import { DEFAULTS, PALETTE, STATE_VISUALS, NODE_SCALES, MEMORY_VARIANTS, SLIDER_DEFS, nodeMaterial } from '../../components/opsdeck3d/lib/design-system'

// ─── Mock Data ───────────────────────────────────────────
// Forward-looking: these match the real data shapes from agentRegistry + objectivesClient

const MOCK_AGENTS = [
  { id: 'quox', name: 'QUOX', role: 'orchestrator', color: '#38bdf8', state: 'active', description: 'Orchestrator: routes queries, delegates to specialists', tools: ['task_routing', 'delegation'], capabilities: ['orchestration', 'routing'] },
  { id: 'sentinel', name: 'WARDEN', role: 'manager', color: '#3090ff', state: 'executing', description: 'Security: threat detection, port scanning, audit', tools: ['ssh_exec', 'security_audit', 'port_scan'], capabilities: ['security', 'monitoring'] },
  { id: 'cipher', name: 'CIPHER', role: 'manager', color: '#9d4edd', state: 'thinking', description: 'Network: DNS, firewall, routing, connectivity', tools: ['ssh_exec', 'dns_lookup', 'traceroute'], capabilities: ['network', 'infrastructure'] },
  { id: 'nova', name: 'DAEDALUS', role: 'manager', color: '#30ff90', state: 'executing', description: 'DevOps: deployments, containers, CI/CD', tools: ['docker_exec', 'deploy', 'rollback'], capabilities: ['devops', 'deployment'] },
  { id: 'prism', name: 'PRISM', role: 'analyst', color: '#4285f4', state: 'thinking', description: 'Analytics: data patterns, trends, anomalies', tools: ['query_metrics', 'analyze'], capabilities: ['analytics', 'patterns'] },
  { id: 'atlas', name: 'HYPERION', role: 'specialist', color: '#ff8c00', state: 'idle', description: 'Infrastructure: hosts, VMs, storage, compute', tools: ['ssh_exec', 'host_info'], capabilities: ['infrastructure'] },
  { id: 'metrics', name: 'METRICS', role: 'specialist', color: '#e6522c', state: 'idle', description: 'Metrics: CPU, memory, disk, network stats', tools: ['query_metrics', 'alert_check'], capabilities: ['monitoring', 'metrics'] },
  { id: 'insight', name: 'INSIGHT', role: 'specialist', color: '#f46800', state: 'idle', description: 'Dashboards: visualisation, charts, reports', tools: ['dashboard_query'], capabilities: ['visualization'] },
  { id: 'scholar', name: 'SCHOLAR', role: 'specialist', color: '#20b2aa', state: 'reading', description: 'Research: documentation, learning, knowledge', tools: ['web_search', 'memory_search'], capabilities: ['research'] },
  { id: 'beacon', name: 'VIGIL', role: 'specialist', color: '#00c853', state: 'idle', description: 'Health: uptime monitoring, heartbeats, alerts', tools: ['health_check', 'ping'], capabilities: ['monitoring', 'health'] },
  { id: 'forge', name: 'VULCAN', role: 'specialist', color: '#8b5cf6', state: 'idle', description: 'Builder: code generation, file operations', tools: ['file_write', 'code_gen'], capabilities: ['development'] },
  { id: 'corey', name: 'COREY', role: 'specialist', color: '#00d4aa', state: 'idle', description: 'Self-awareness: reflection, cognitive topology', tools: ['reflect', 'introspect'], capabilities: ['cognition'] },
  { id: 'keeper', name: 'KEEPER', role: 'specialist', color: '#14b8a6', state: 'idle', description: 'Memory: storage, retrieval, entity management', tools: ['memory_save', 'memory_search'], capabilities: ['memory'] },
  { id: 'tester', name: 'TESTER', role: 'specialist', color: '#22c55e', state: 'idle', description: 'Testing: unit tests, integration, validation', tools: ['run_tests', 'validate'], capabilities: ['testing'] },
  { id: 'imagesq', name: 'ImagesQ', role: 'specialist', color: '#f59e0b', state: 'idle', description: 'Creative: image generation, visual content', tools: ['generate_image'], capabilities: ['creative'] },
  { id: 'perplexity', name: 'PERPLEXITY', role: 'specialist', color: '#1fb8cd', state: 'idle', description: 'Web research: search, fact-finding, citations', tools: ['web_search', 'cite'], capabilities: ['research', 'web'] },
]

const MOCK_OBJECTIVES = [
  {
    id: 'obj-1', title: 'Deploy v2.1 to Production', status: 'running',
    tasks: [
      { id: 't1', title: 'Run test suite', status: 'completed', agentId: 'tester' },
      { id: 't2', title: 'Build Docker images', status: 'completed', agentId: 'nova' },
      { id: 't3', title: 'Security audit', status: 'running', agentId: 'sentinel' },
      { id: 't4', title: 'Deploy to staging', status: 'running', agentId: 'nova' },
      { id: 't5', title: 'Smoke test', status: 'pending', agentId: 'tester' },
      { id: 't6', title: 'Deploy to production', status: 'pending', agentId: 'nova' },
    ],
  },
]

const MOCK_MEMORIES = [
  { id: 'm1', type: 'entity', content: 'edge-01: Docker host, 203.0.113.101', age: 0.2 },
  { id: 'm2', type: 'entity', content: 'hyp-01: Proxmox node, 203.0.113.10', age: 0.3 },
  { id: 'm3', type: 'entity', content: 'nginx: Reverse proxy on edge-01', age: 0.5 },
  { id: 'm4', type: 'fact', content: 'Auth service runs on port 3101', age: 0.1 },
  { id: 'm5', type: 'fact', content: 'Collector caches keys for 30s', age: 0.4 },
  { id: 'm6', type: 'fact', content: 'QuoxFlow uses 429 tests', age: 0.6 },
  { id: 'm7', type: 'decision', content: 'OAuth preferred over API keys', age: 0.3 },
  { id: 'm8', type: 'decision', content: 'n8n fully decoupled, QuoxFlow primary', age: 0.7 },
  { id: 'm9', type: 'preference', content: 'User prefers terse responses', age: 0.2 },
  { id: 'm10', type: 'openLoop', content: 'SSL cert renewal for quox.ai due soon', age: 0.1 },
  { id: 'm11', type: 'openLoop', content: 'Backup coverage audit pending', age: 0.4 },
  { id: 'm12', type: 'entity', content: 'gw-01: SSH bastion, 198.51.100.247', age: 0.8 },
]

// ─── Unified Scene Components ────────────────────────────

function AgentMesh({ agents, settings, onSelect }) {
  // Structured positioning: agents sit ON the zone ring at r=15
  // Orchestrator at centre, managers on inner band, specialists on outer band
  const positions = useMemo(() => {
    const map = {}
    const managers = agents.filter(a => a.role === 'manager' || a.role === 'analyst')
    const specialists = agents.filter(a => a.role === 'specialist')
    const plugins = agents.filter(a => a.role === 'plugin')

    // QUOX at nucleus
    map['quox'] = [0, 1.5, 0]

    // Managers: inner ring at r=11, evenly spaced, slight Y variation
    managers.forEach((a, i) => {
      const angle = (i / managers.length) * Math.PI * 2 - Math.PI / 2
      map[a.id] = [Math.cos(angle) * 11, 0.5, Math.sin(angle) * 11]
    })

    // Specialists: main ring at r=15, evenly spaced
    specialists.forEach((a, i) => {
      const angle = (i / specialists.length) * Math.PI * 2
      map[a.id] = [Math.cos(angle) * 15, -0.3 + (i % 3) * 0.6, Math.sin(angle) * 15]
    })

    // Plugin agents: outer band at r=18
    plugins.forEach((a, i) => {
      const angle = (i / Math.max(plugins.length, 1)) * Math.PI * 2
      map[a.id] = [Math.cos(angle) * 18, -1, Math.sin(angle) * 18]
    })

    return map
  }, [agents])

  // Connection lines from QUOX to managers
  const lines = useMemo(() => {
    return agents
      .filter(a => a.role === 'manager' || a.role === 'analyst')
      .map(a => ({ from: positions['quox'] || [0, 1.5, 0], to: positions[a.id] }))
      .filter(l => l.to)
  }, [agents, positions])

  return (
    <group>
      {agents.map(agent => (
        <AgentNode
          key={agent.id}
          position={positions[agent.id] || [0, 0, 15]}
          agentId={agent.id}
          name={agent.name}
          role={agent.role}
          state={agent.state}
          color={agent.color}
          description={agent.description}
          tools={agent.tools}
          capabilities={agent.capabilities}
          showLabel
          settings={settings}
          onSelect={onSelect}
        />
      ))}
      {/* Connection threads */}
      {lines.map((l, i) => (
        <line key={i}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={new Float32Array([...l.from, ...l.to])}
              count={2}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#6366f1" transparent opacity={settings.connectionOpacity ?? 0.08} />
        </line>
      ))}
    </group>
  )
}

function ObjectiveCluster({ objective, position = [28, 0, 0], settings, onSelect }) {
  const coreRef = useRef()
  const timeRef = useRef(0)
  const [hovered, setHovered] = useState(false)

  const tasks = objective.tasks || []
  const completed = tasks.filter(t => t.status === 'completed').length
  const progress = tasks.length > 0 ? completed / tasks.length : 0

  useFrame((_, delta) => {
    timeRef.current += delta
    if (coreRef.current) {
      coreRef.current.rotation.y += delta * 0.2
    }
  })

  return (
    <group position={position}>
      {/* Objective core — octahedron, larger scale */}
      <mesh
        ref={coreRef}
        scale={NODE_SCALES.objective}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'objective', ...objective, position }) }}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={PALETTE.indigo}
          emissive={PALETTE.indigo}
          emissiveIntensity={0.7 * (hovered ? 1.3 : 1)}
          transparent
          opacity={0.8}
          roughness={0.35}
          metalness={0.05}
        />
      </mesh>

      {/* Label */}
      <Billboard position={[0, NODE_SCALES.objective + 0.8, 0]}>
        <Text fontSize={0.35} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000000" fillOpacity={0.7}>
          {objective.title?.slice(0, 25) || 'Objective'}
        </Text>
        <Text fontSize={0.2} color={PALETTE.executing} anchorX="center" position={[0, -0.35, 0]} fillOpacity={0.6}>
          {completed}/{tasks.length} tasks
        </Text>
      </Billboard>

      {/* Hover tooltip */}
      {hovered && (
        <Html position={[2.5, 0.5, 0]} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[20, 0]}>
          <div style={{
            background: 'rgba(5,5,16,0.92)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, padding: '8px 12px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(12px)', minWidth: 160,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{objective.title}</div>
            <div style={{ color: PALETTE.executing, fontSize: 10 }}>{objective.status?.toUpperCase()}</div>
            <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
              {tasks.map(t => (
                <div key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ color: t.status === 'completed' ? PALETTE.executing : t.status === 'running' ? PALETTE.thinking : 'rgba(255,255,255,0.3)' }}>
                    {t.status === 'completed' ? '✓' : t.status === 'running' ? '▸' : '○'}
                  </span>
                  <span>{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        </Html>
      )}

      {/* Visible orbit paths for tasks */}
      {tasks.map((_, i) => (
        <TaskOrbitPath
          key={`orbit-${i}`}
          radius={3.5 + (i % 3) * 0.8}
          color={PALETTE.indigo}
          opacity={settings.taskOrbitOpacity ?? 0.06}
          tilt={(i * 0.3) - 0.45}
          position={[0, 0, 0]}
        />
      ))}

      {/* Task orbit nodes — all octahedrons */}
      {tasks.map((task, i) => (
        <TaskOrbitNode key={task.id} task={task} index={i} total={tasks.length} settings={settings} onSelect={onSelect} />
      ))}
    </group>
  )
}

function TaskOrbitNode({ task, index, total, settings, onSelect }) {
  const meshRef = useRef()
  const timeRef = useRef(index * (Math.PI * 2 / total))
  const [hovered, setHovered] = useState(false)

  const statusColor = task.status === 'completed' ? PALETTE.executing
    : task.status === 'running' ? PALETTE.thinking
    : task.status === 'failed' ? PALETTE.blocked
    : PALETTE.idle

  const speed = task.status === 'running' ? 0.6 : task.status === 'completed' ? 0.05 : 0.15
  const opacity = task.status === 'pending' ? 0.35 : task.status === 'completed' ? 0.5 : 0.8

  useFrame((_, delta) => {
    timeRef.current += delta * speed * (settings.taskOrbitSpeed ?? 0.5)
    if (meshRef.current) {
      const r = 3.5 + (index % 3) * 0.8
      const incl = (index * 0.3) - 0.45
      meshRef.current.position.x = Math.cos(timeRef.current) * r
      meshRef.current.position.z = Math.sin(timeRef.current) * r * Math.cos(incl)
      meshRef.current.position.y = Math.sin(timeRef.current) * r * Math.sin(incl)
      meshRef.current.rotation.y += delta * 0.3
    }
  })

  return (
    <mesh
      ref={meshRef}
      scale={NODE_SCALES.task * (hovered ? 1.3 : 1)}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'task', ...task }) }}
    >
      <octahedronGeometry args={[1, 0]} />
      <meshStandardMaterial
        color={statusColor}
        emissive={statusColor}
        emissiveIntensity={(settings.taskGlow ?? 0.6) * (hovered ? 1.3 : 1)}
        transparent
        opacity={opacity}
        roughness={0.35}
        metalness={0.05}
      />
    </mesh>
  )
}

function MemoryLattice({ memories, settings, onSelect }) {
  const groupRef = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.008
  })

  return (
    <group ref={groupRef}>
      {memories.map((mem, i) => (
        <MemoryCrystalNode key={mem.id} memory={mem} index={i} total={memories.length} settings={settings} onSelect={onSelect} />
      ))}
    </group>
  )
}

function MemoryCrystalNode({ memory, index, total, settings, onSelect }) {
  const meshRef = useRef()
  const timeRef = useRef(index * 3.7)
  const [hovered, setHovered] = useState(false)

  const variant = MEMORY_VARIANTS[memory.type] || MEMORY_VARIANTS.entity
  const scale = (settings.crystalScale ?? 1.0) * NODE_SCALES.memory
  const isOpenLoop = memory.type === 'openLoop'

  // Position on tilted orbital track
  const orbitRadius = 42 + memory.age * 8 // Recent = closer (r=42), old = further (r=50)
  const orbitPlane = (index % 3) * 0.35 // 3 tilted planes
  const driftSpeed = settings.crystalDriftSpeed ?? 0.05

  useFrame((_, delta) => {
    timeRef.current += delta * driftSpeed
    if (meshRef.current) {
      const t = timeRef.current
      meshRef.current.position.x = Math.cos(t + index) * orbitRadius
      meshRef.current.position.z = Math.sin(t + index) * orbitRadius * Math.cos(orbitPlane)
      meshRef.current.position.y = Math.sin(t + index) * orbitRadius * Math.sin(orbitPlane)
      meshRef.current.rotation.y += delta * 0.1

      if (isOpenLoop) {
        const pulse = 1 + Math.sin(timeRef.current * 2) * 0.12
        meshRef.current.scale.set(scale, scale * variant.scaleY * pulse, scale)
      }
    }
  })

  return (
    <group>
      <mesh
        ref={meshRef}
        scale={[scale, scale * variant.scaleY, scale]}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
        onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'memory', ...memory }) }}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={variant.color}
          emissive={variant.color}
          emissiveIntensity={(settings.crystalGlow ?? 0.5) * (hovered ? 1.4 : 1) * (isOpenLoop ? 1.3 : 1)}
          transparent
          opacity={hovered ? 0.85 : 0.6 - memory.age * 0.2}
          roughness={0.25}
          metalness={0.1}
        />
      </mesh>

      {/* Hover: show memory content */}
      {hovered && meshRef.current && (
        <Html
          position={[meshRef.current.position.x + 1.5, meshRef.current.position.y + 0.5, meshRef.current.position.z]}
          style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}
          zIndexRange={[20, 0]}
        >
          <div style={{
            background: 'rgba(5,5,16,0.92)', border: `1px solid ${variant.color}33`,
            borderRadius: 6, padding: '8px 12px', maxWidth: 220,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(12px)', whiteSpace: 'normal',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ color: variant.color, fontWeight: 700, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {memory.type === 'openLoop' ? 'open loop' : memory.type}
              </span>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.75)', lineHeight: 1.4 }}>{memory.content}</div>
          </div>
        </Html>
      )}
    </group>
  )
}

function DelegationArcLoop({ settings }) {
  const [arcs, setArcs] = useState([])
  const timerRef = useRef(0)
  const idRef = useRef(0)
  const positions = useMemo(() => fibonacciSphere(MOCK_AGENTS.length, 15), [])
  const interval = settings.arcInterval ?? 4

  useFrame((_, delta) => {
    timerRef.current += delta
    if (timerRef.current > interval) {
      timerRef.current = 0
      const count = 1 + Math.floor(Math.random() * 2)
      const newArcs = []
      for (let i = 0; i < count; i++) {
        const toIdx = 1 + Math.floor(Math.random() * (MOCK_AGENTS.length - 1))
        newArcs.push({ id: idRef.current++, from: [0, 2, 0], to: positions[toIdx] })
      }
      setArcs(prev => [...prev, ...newArcs])
    }
  })

  return <>{arcs.map(arc => (
    <DelegationArc key={arc.id} from={arc.from} to={arc.to}
      onComplete={() => setArcs(prev => prev.filter(a => a.id !== arc.id))} />
  ))}</>
}

function HeartbeatPulse({ settings }) {
  const [ripples, setRipples] = useState([])
  const timerRef = useRef(0)
  const idRef = useRef(0)
  const interval = settings.heartbeatInterval ?? 5

  useFrame((_, delta) => {
    timerRef.current += delta
    if (timerRef.current > interval) {
      timerRef.current = 0
      setRipples(prev => [...prev, { id: idRef.current++ }])
    }
  })

  const opacity = settings.heartbeatOpacity ?? 0.06

  return <>{ripples.map(r => (
    <ShockwaveRipple key={r.id} color={PALETTE.indigo} maxRadius={45} duration={4}
      maxOpacity={opacity}
      onComplete={() => setRipples(prev => prev.filter(x => x.id !== r.id))} />
  ))}</>
}

// ─── Main Scene ──────────────────────────────────────────

function Scene({ visible, systemState, settings, onSelect }) {
  return (
    <>
      <ambientLight intensity={settings.ambientIntensity ?? 0.15} />
      <pointLight position={[10, 20, 10]} color="#6366f1" intensity={0.5} />
      <pointLight position={[-15, -10, 15]} color="#06b6d4" intensity={0.3} />

      <fog attach="fog" args={['#050510', settings.fogDensity ?? 0.008]} />

      {visible.grid && <HoloGrid sonarInterval={settings.sonarSpeed ?? 10} />}
      {visible.zones && <ZoneRings settings={settings} />}
      {visible.zones && <>
        <MemoryOrbitPath radius={43} tilt={0.25} color="#ec4899" opacity={settings.memoryOrbitOpacity ?? 0.04} />
        <MemoryOrbitPath radius={46} tilt={0.5} color="#ec4899" opacity={settings.memoryOrbitOpacity ?? 0.03} />
        <MemoryOrbitPath radius={48} tilt={0.75} color="#ec4899" opacity={settings.memoryOrbitOpacity ?? 0.02} />
      </>}
      {visible.nucleus && <Nucleus systemState={systemState} />}
      {visible.shell && <CoreShell />}
      {visible.agents && <AgentMesh agents={MOCK_AGENTS} settings={settings} onSelect={onSelect} />}
      {visible.execution && MOCK_OBJECTIVES.map(obj => (
        <ObjectiveCluster key={obj.id} objective={obj} settings={settings} onSelect={onSelect} />
      ))}
      {visible.memory && <MemoryLattice memories={MOCK_MEMORIES} settings={settings} onSelect={onSelect} />}
      {visible.particles && <AmbientParticles count={400} />}
      {visible.arcs && <DelegationArcLoop settings={settings} />}
      {visible.heartbeat && <HeartbeatPulse settings={settings} />}

      <OrbitControls makeDefault enableDamping dampingFactor={0.05} minDistance={3} maxDistance={80} />

      <EffectComposer>
        <Bloom
          luminanceThreshold={settings.bloomThreshold ?? 0.5}
          luminanceSmoothing={settings.bloomSmoothing ?? 0.9}
          intensity={settings.bloomIntensity ?? 0.8}
          mipmapBlur
        />
        <Vignette eskil={false} offset={0.1} darkness={settings.vignetteStrength ?? 0.7} />
      </EffectComposer>
    </>
  )
}

// ─── HUD Components ──────────────────────────────────────

const FONT = "'JetBrains Mono', 'Fira Code', monospace"

const TOGGLE_ITEMS = [
  { key: 'grid', label: 'Holo Grid', icon: '▦' },
  { key: 'zones', label: 'Zone Rings', icon: '○' },
  { key: 'nucleus', label: 'Nucleus', icon: '◉' },
  { key: 'shell', label: 'Core Shell', icon: '⬡' },
  { key: 'agents', label: 'Agent Mesh', icon: '◇' },
  { key: 'execution', label: 'Execution', icon: '◎' },
  { key: 'memory', label: 'Memory Lattice', icon: '◈' },
  { key: 'particles', label: 'Particles', icon: '·' },
  { key: 'arcs', label: 'Delegation Arcs', icon: '⤴' },
  { key: 'heartbeat', label: 'Heartbeat', icon: '♡' },
]

const STATE_OPTIONS = ['idle', 'active', 'error']

function ToggleButton({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', borderRadius: 5, cursor: 'pointer', width: '100%',
      background: active ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.03)',
      color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)',
      fontSize: 11, fontFamily: FONT,
      border: active ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.04)',
      transition: 'all 0.15s',
    }}>
      <span style={{ width: 14, textAlign: 'center', fontSize: 13 }}>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function InfoPanel({ selected, onClose }) {
  if (!selected) return null

  const s = selected
  const typeColors = { agent: s.color || PALETTE.indigo, objective: PALETTE.indigo, task: PALETTE.thinking, memory: MEMORY_VARIANTS[s.type]?.color || PALETTE.memory }
  const accent = typeColors[s.type] || PALETTE.indigo

  return (
    <div style={{
      position: 'absolute', top: 44, right: 0, bottom: 0, width: 300,
      background: 'rgba(5,5,16,0.92)', borderLeft: '1px solid rgba(255,255,255,0.06)',
      backdropFilter: 'blur(16px)', zIndex: 15, padding: '16px',
      fontFamily: FONT, fontSize: 11, color: 'rgba(255,255,255,0.8)',
      overflow: 'auto', transition: 'transform 0.2s', transform: 'translateX(0)',
    }}>
      {/* Close */}
      <button onClick={onClose} style={{
        position: 'absolute', top: 10, right: 10,
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 4, color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
      }}>✕</button>

      {/* Type badge */}
      <div style={{
        fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em',
        color: accent, marginBottom: 4, fontWeight: 600,
      }}>{s.type}</div>

      {/* Name */}
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#fff' }}>
        {s.name || s.title || s.content?.slice(0, 30) || 'Unknown'}
      </div>

      {/* Agent details */}
      {s.type === 'agent' && <>
        <div style={{ marginBottom: 8 }}>
          <Label>Role</Label>
          <Value>{s.role}</Value>
        </div>
        <div style={{ marginBottom: 8 }}>
          <Label>State</Label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATE_VISUALS[s.state]?.color || '#555', boxShadow: `0 0 6px ${STATE_VISUALS[s.state]?.color || '#555'}` }} />
            <Value>{s.state?.replace(/_/g, ' ')}</Value>
          </div>
        </div>
        {s.description && <div style={{ marginBottom: 12 }}>
          <Label>Description</Label>
          <div style={{ color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>{s.description}</div>
        </div>}
        {s.tools?.length > 0 && <div style={{ marginBottom: 12 }}>
          <Label>Tools ({s.tools.length})</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {s.tools.map(t => <Badge key={t} color={accent}>{t}</Badge>)}
          </div>
        </div>}
        {s.capabilities?.length > 0 && <div style={{ marginBottom: 12 }}>
          <Label>Capabilities</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {s.capabilities.map(c => <Badge key={c} color="rgba(255,255,255,0.3)">{c}</Badge>)}
          </div>
        </div>}
      </>}

      {/* Objective details */}
      {s.type === 'objective' && <>
        <div style={{ marginBottom: 8 }}>
          <Label>Status</Label>
          <Value>{s.status}</Value>
        </div>
        {s.tasks && <div style={{ marginBottom: 12 }}>
          <Label>Tasks ({s.tasks.filter(t=>t.status==='completed').length}/{s.tasks.length})</Label>
          {/* Progress bar */}
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', marginBottom: 8, marginTop: 4 }}>
            <div style={{ height: '100%', borderRadius: 2, background: PALETTE.executing, width: `${(s.tasks.filter(t=>t.status==='completed').length / s.tasks.length) * 100}%`, transition: 'width 0.3s' }} />
          </div>
          {s.tasks.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 10 }}>
              <span style={{ color: t.status === 'completed' ? PALETTE.executing : t.status === 'running' ? PALETTE.thinking : t.status === 'failed' ? PALETTE.blocked : 'rgba(255,255,255,0.3)' }}>
                {t.status === 'completed' ? '✓' : t.status === 'running' ? '▸' : t.status === 'failed' ? '✕' : '○'}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t.title}</span>
              <span style={{ marginLeft: 'auto', color: 'rgba(255,255,255,0.25)', fontSize: 9 }}>{t.agentId}</span>
            </div>
          ))}
        </div>}
      </>}

      {/* Task details */}
      {s.type === 'task' && <>
        <div style={{ marginBottom: 8 }}><Label>Status</Label><Value>{s.status}</Value></div>
        <div style={{ marginBottom: 8 }}><Label>Assigned Agent</Label><Value>{s.agentId}</Value></div>
      </>}

      {/* Memory details */}
      {s.type === 'memory' && <>
        <div style={{ marginBottom: 8 }}>
          <Label>Type</Label>
          <Badge color={MEMORY_VARIANTS[s.type]?.color || PALETTE.memory}>{s.type === 'openLoop' ? 'Open Loop' : s.type}</Badge>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Label>Content</Label>
          <div style={{ color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>{s.content}</div>
        </div>
      </>}
    </div>
  )
}

function Label({ children }) {
  return <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', marginBottom: 3 }}>{children}</div>
}

function Value({ children }) {
  return <div style={{ color: 'rgba(255,255,255,0.8)' }}>{children}</div>
}

function Badge({ children, color }) {
  return <span style={{
    fontSize: 9, padding: '2px 6px', borderRadius: 3,
    background: `${color}15`, border: `1px solid ${color}30`, color: `${color}cc`,
  }}>{children}</span>
}

// ─── Settings Panel ──────────────────────────────────────

function SettingsPanel({ settings, setSettings, open }) {
  if (!open) return null

  const groups = {}
  SLIDER_DEFS.forEach(d => {
    if (!groups[d.group]) groups[d.group] = []
    groups[d.group].push(d)
  })

  return (
    <div style={{
      position: 'absolute', top: 44, right: 0, bottom: 0, width: 260,
      background: 'rgba(5,5,16,0.92)', borderLeft: '1px solid rgba(255,255,255,0.06)',
      backdropFilter: 'blur(16px)', zIndex: 20, padding: '12px',
      fontFamily: FONT, fontSize: 10, color: 'rgba(255,255,255,0.7)',
      overflowY: 'auto',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', marginBottom: 10 }}>TUNING</div>

      {/* Reset */}
      <button onClick={() => setSettings({ ...DEFAULTS })} style={{
        width: '100%', padding: '4px 8px', marginBottom: 12, borderRadius: 4,
        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
        color: 'rgba(239,68,68,0.7)', cursor: 'pointer', fontFamily: FONT, fontSize: 10,
      }}>Reset All to Defaults</button>

      {Object.entries(groups).map(([group, sliders]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.3)', marginBottom: 6 }}>{group}</div>
          {sliders.map(s => (
            <div key={s.key} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ color: 'rgba(255,255,255,0.5)' }}>{s.label}</span>
                <span style={{ color: '#8b5cf6', fontWeight: 600 }}>{(settings[s.key] ?? DEFAULTS[s.key]).toFixed(s.step < 0.01 ? 4 : s.step < 0.1 ? 2 : 1)}</span>
              </div>
              <input
                type="range"
                min={s.min} max={s.max} step={s.step}
                value={settings[s.key] ?? DEFAULTS[s.key]}
                onChange={(e) => setSettings(prev => ({ ...prev, [s.key]: parseFloat(e.target.value) }))}
                style={{ width: '100%', accentColor: '#8b5cf6', height: 3 }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Main Export ──────────────────────────────────────────

// ─── DATA HOOK TEST ──────────────────────────────────────
// useCogCore3DState CRASHES outside AuthProvider context (useAuth → useRef not a function)
// Both /3d-lab and /cogcore3d are standalone routes without AppShell/AuthProvider.
// The fix: useCogCore3DState must NOT use useOpsDeckState (which calls useAuth).
// Instead, it should call APIs directly without auth context, or these routes need AuthProvider.
// For now: no data hook. Mock data only.

export default function ThreeDLabView() {
  const [visible, setVisible] = useState({
    grid: true, zones: true, nucleus: true, shell: true, agents: true,
    execution: true, memory: true, particles: true, arcs: true, heartbeat: true,
  })
  const [panelOpen, setPanelOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [systemState, setSystemState] = useState('idle')
  const [settings, setSettings] = useState({ ...DEFAULTS })
  const [selected, setSelected] = useState(null)
  const [fps, setFps] = useState(0)

  const toggle = useCallback((key) => setVisible(prev => ({ ...prev, [key]: !prev[key] })), [])
  const toggleAll = useCallback((on) => setVisible(prev => { const n = {}; Object.keys(prev).forEach(k => n[k] = on); return n }), [])
  const handleSelect = useCallback((node) => { setSelected(node); setSettingsOpen(false) }, [])

  useEffect(() => {
    let fc = 0, lt = performance.now(), id
    const tick = () => { fc++; const n = performance.now(); if (n - lt >= 1000) { setFps(fc); fc = 0; lt = n }; id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [])

  // Esc closes panels
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { setSelected(null); setSettingsOpen(false) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050510', fontFamily: FONT }}>
      <Canvas
        camera={{ position: [0, 8, 30], fov: 60, near: 0.1, far: 200 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'default' }}
        style={{ background: '#050510' }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.2 }}
      >
        <Suspense fallback={null}>
          <Scene visible={visible} systemState={systemState} settings={settings} onSelect={handleSelect} />
        </Suspense>
      </Canvas>

      {/* ─── Top Bar ─── */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: 'rgba(5,5,16,0.85)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        backdropFilter: 'blur(12px)', zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#8b5cf6', fontWeight: 700, fontSize: 13, letterSpacing: 1 }}>OPSDECK3D</span>
          <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>Prototype Lab</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: fps > 30 ? '#22c55e' : fps > 20 ? '#f59e0b' : '#ef4444', fontSize: 10 }}>{fps} FPS</span>
          <button onClick={() => { setSettingsOpen(p => !p); setSelected(null) }} style={{
            background: settingsOpen ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.05)',
            border: settingsOpen ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4, padding: '3px 10px', color: settingsOpen ? '#a78bfa' : 'rgba(255,255,255,0.5)',
            cursor: 'pointer', fontFamily: FONT, fontSize: 10,
          }}>⚙ Tuning</button>
          <a href="/glass-concept" style={{ color: '#818cf8', fontSize: 10, textDecoration: 'none' }}>← Glass</a>
        </div>
      </div>

      {/* ─── Left Panel ─── */}
      <div style={{
        position: 'absolute', top: 44, left: 0, bottom: 0,
        width: panelOpen ? 190 : 36,
        background: 'rgba(5,5,16,0.88)', borderRight: '1px solid rgba(255,255,255,0.05)',
        backdropFilter: 'blur(12px)', zIndex: 10, transition: 'width 0.2s', overflow: 'hidden',
      }}>
        <button onClick={() => setPanelOpen(p => !p)} style={{
          width: '100%', padding: '6px', border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.4)',
          fontSize: 10, textAlign: panelOpen ? 'right' : 'center', fontFamily: FONT,
        }}>{panelOpen ? '◂' : '▸'}</button>

        {panelOpen && (
          <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
              <button onClick={() => toggleAll(true)} style={{
                flex: 1, padding: '3px', borderRadius: 3, border: '1px solid rgba(34,197,94,0.15)',
                background: 'rgba(34,197,94,0.08)', color: 'rgba(34,197,94,0.7)',
                cursor: 'pointer', fontFamily: FONT, fontSize: 9,
              }}>All ON</button>
              <button onClick={() => toggleAll(false)} style={{
                flex: 1, padding: '3px', borderRadius: 3, border: '1px solid rgba(239,68,68,0.15)',
                background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.7)',
                cursor: 'pointer', fontFamily: FONT, fontSize: 9,
              }}>All OFF</button>
            </div>

            {TOGGLE_ITEMS.map(item => (
              <ToggleButton key={item.key} active={visible[item.key]} onClick={() => toggle(item.key)} icon={item.icon} label={item.label} />
            ))}

            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.05em', marginBottom: 4 }}>System State</div>
              <div style={{ display: 'flex', gap: 3 }}>
                {STATE_OPTIONS.map(s => (
                  <button key={s} onClick={() => setSystemState(s)} style={{
                    flex: 1, padding: '3px', borderRadius: 3, cursor: 'pointer', fontFamily: FONT, fontSize: 9,
                    background: systemState === s ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.03)',
                    color: systemState === s ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
                    border: systemState === s ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.04)',
                  }}>{s}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 9, lineHeight: 1.5 }}>
                Hover objects for info. Click for details. Scroll to zoom. Drag to orbit. Esc to close panels.
              </div>
            </div>

            {/* Data hook test removed — crashes outside AuthProvider context */}
          </div>
        )}
      </div>

      {/* ─── Info Panel (right) ─── */}
      {selected && !settingsOpen && <InfoPanel selected={selected} onClose={() => setSelected(null)} />}

      {/* ─── Settings Panel (right) ─── */}
      <SettingsPanel settings={settings} setSettings={setSettings} open={settingsOpen} />

      {/* ─── Bottom Bar ─── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '5px 16px', background: 'rgba(5,5,16,0.7)',
        borderTop: '1px solid rgba(255,255,255,0.03)', zIndex: 10,
      }}>
        <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 9 }}>
          {MOCK_AGENTS.length} agents · {MOCK_OBJECTIVES.reduce((n, o) => n + o.tasks.length, 0)} tasks · {MOCK_MEMORIES.length} memories · All objects: octahedron · Scale = role · Colour = state
        </span>
      </div>
    </div>
  )
}
