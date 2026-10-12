/**
 * Nucleus v5 — LOD-driven codebase visualisation.
 *
 * Stream QN Phase QN-6.
 *
 * LOD 0 (distance > 50): Original glowing orb + horns (identical to v4)
 * LOD 1 (distance 20-50): Semi-transparent sphere with 13 repo clusters inside
 * LOD 2 (distance 8-20): File-level nodes via instancedMesh + edge lines
 *
 * Falls back to LOD 0 permanently if graph data fails to load.
 */
import { useRef, useMemo, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { SHARED_OCTA } from '../lib/sharedGeometry'

const GRAPH_DATA_URL = '/graph-data.json'

const STATE_COLORS = {
  idle: '#6366f1',
  active: '#818cf8',
  error: '#ef4444',
}

const PULSE_SPEEDS = {
  idle: 5.0,
  active: 2.0,
  error: 0.7,
}

const REPO_COLORS = {
  'quox-website': '#ff6b6b', 'quox-dashboard': '#a855f7', 'quoxflow': '#06b6d4',
  'QuoxBastion': '#f59e0b', 'quoxagent': '#10b981', 'quoxmcp': '#ec4899',
  'quoxterminal': '#3b82f6', 'quox-memory': '#8b5cf6', 'quox-plugin-sdk': '#14b8a6',
  'aee': '#f97316', 'aocl': '#ef4444', 'volt': '#eab308', 'ward': '#22d3ee',
}
const DEFAULT_COLOR = '#6366f1'

// ── Utilities ────────────────────────────────────────────────────────

function hashCode(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/** Fibonacci sphere distribution for N cluster centers */
function fibonacciSphere(n, radius) {
  const points = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2 // -1 to 1
    const r = Math.sqrt(1 - y * y)
    const theta = goldenAngle * i
    points.push(new THREE.Vector3(
      Math.cos(theta) * r * radius,
      y * radius,
      Math.sin(theta) * r * radius,
    ))
  }
  return points
}

function nodeScale(degree) {
  if (degree >= 50) return 0.05 + Math.min(0.03, (degree - 50) * 0.0005)
  if (degree >= 10) return 0.03 + (degree - 10) * 0.0005
  if (degree >= 1) return 0.02 + degree * 0.002
  return 0.02
}

function lerp(a, b, t) {
  return a + (b - a) * Math.min(1, Math.max(0, t))
}

// ── Horn (unchanged from v4) ─────────────────────────────────────────

function Horn({ side = 1, color }) {
  const nodes = [
    { y: 1.6, x: side * 0.15, s: 0.18, op: 0.25 },
    { y: 2.5, x: side * 0.6, s: 0.13, op: 0.2 },
    { y: 3.3, x: side * 1.1, s: 0.09, op: 0.15 },
    { y: 3.9, x: side * 1.6, s: 0.06, op: 0.1 },
  ]

  return (
    <group>
      {nodes.map((n, i) => (
        <mesh key={i} position={[n.x, n.y, 0]} scale={n.s}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={n.op} />
        </mesh>
      ))}
      <line geometry={new THREE.BufferGeometry().setFromPoints(
        nodes.map(n => new THREE.Vector3(n.x, n.y, 0))
      )}>
        <lineBasicMaterial color={color} transparent opacity={0.08} />
      </line>
    </group>
  )
}

// ── LOD 1: Repo Clusters (instanced) ────────────────────────────────

function RepoClusters({ repos, opacity }) {
  const meshRef = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])

  const { count, positions, colors } = useMemo(() => {
    if (!repos || repos.length === 0) return { count: 0, positions: [], colors: [] }

    const centers = fibonacciSphere(repos.length, 1.0)
    const POINTS_PER_REPO = 8
    const total = repos.length * POINTS_PER_REPO
    const pos = []
    const col = []
    const tmpColor = new THREE.Color()

    repos.forEach((repo, ri) => {
      const center = centers[ri]
      tmpColor.set(REPO_COLORS[repo] || DEFAULT_COLOR)

      for (let j = 0; j < POINTS_PER_REPO; j++) {
        const h = hashCode(`${repo}-${j}`)
        const r = ((h & 0xffff) / 0xffff) * 0.3
        const a = ((h >> 8 & 0xffff) / 0xffff) * Math.PI * 2
        const elev = (((h >> 16 & 0xff) / 0xff) - 0.5) * 0.3

        pos.push(
          center.x + Math.cos(a) * r,
          center.y + elev,
          center.z + Math.sin(a) * r,
        )
        col.push(tmpColor.r, tmpColor.g, tmpColor.b)
      }
    })

    return { count: total, positions: pos, colors: col }
  }, [repos])

  useEffect(() => {
    if (!meshRef.current || count === 0) return
    for (let i = 0; i < count; i++) {
      dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      dummy.scale.setScalar(0.06)
      dummy.updateMatrix()
      meshRef.current.setMatrixAt(i, dummy.matrix)
      meshRef.current.setColorAt(i, new THREE.Color(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]))
    }
    meshRef.current.instanceMatrix.needsUpdate = true
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true
  }, [count, positions, colors, dummy])

  if (count === 0) return null

  return (
    <instancedMesh ref={meshRef} args={[SHARED_OCTA, null, count]}>
      <meshBasicMaterial transparent opacity={opacity} toneMapped={false} />
    </instancedMesh>
  )
}

// ── LOD 2: File Nodes (instanced) ────────────────────────────────────

function FileNodes({ graphData, opacity }) {
  const meshRef = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])

  const { nodeCount, linePositions, lineCount } = useMemo(() => {
    if (!graphData) return { nodeCount: 0, linePositions: null, lineCount: 0 }

    const nodes = graphData.nodes
    const edges = graphData.edges
    const repos = [...new Set(nodes.map(n => n.repo))]
    const centers = fibonacciSphere(repos.length, 1.0)
    const repoCenter = {}
    repos.forEach((r, i) => { repoCenter[r] = centers[i] })

    // Build node index
    const indexMap = new Map()
    nodes.forEach((n, i) => { indexMap.set(n.id, i) })

    // Compute positions and set instance matrices/colors
    const positions = new Float32Array(nodes.length * 3)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const c = repoCenter[node.repo] || new THREE.Vector3()
      const h = hashCode(node.id)
      const r = ((h & 0xffff) / 0xffff) * 0.4
      const a = ((h >> 8 & 0xffff) / 0xffff) * Math.PI * 2
      const elev = (((h >> 16 & 0xff) / 0xff) - 0.5) * 0.4

      positions[i * 3] = c.x + Math.cos(a) * r
      positions[i * 3 + 1] = c.y + elev
      positions[i * 3 + 2] = c.z + Math.sin(a) * r
    }

    // Edge lines
    const validEdges = edges.filter(e => indexMap.has(e.source) && indexMap.has(e.target))
    // Limit edges for performance (show top ~2000)
    const edgeLimit = Math.min(validEdges.length, 2000)
    const linePosArr = new Float32Array(edgeLimit * 6)
    for (let i = 0; i < edgeLimit; i++) {
      const si = indexMap.get(validEdges[i].source)
      const ti = indexMap.get(validEdges[i].target)
      linePosArr[i * 6] = positions[si * 3]
      linePosArr[i * 6 + 1] = positions[si * 3 + 1]
      linePosArr[i * 6 + 2] = positions[si * 3 + 2]
      linePosArr[i * 6 + 3] = positions[ti * 3]
      linePosArr[i * 6 + 4] = positions[ti * 3 + 1]
      linePosArr[i * 6 + 5] = positions[ti * 3 + 2]
    }

    // Set instance matrices and colors on next frame
    requestAnimationFrame(() => {
      if (!meshRef.current) return
      const tmpColor = new THREE.Color()
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const scale = nodeScale(node.degree || 0)
        dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
        dummy.scale.setScalar(scale)
        dummy.updateMatrix()
        meshRef.current.setMatrixAt(i, dummy.matrix)
        tmpColor.set(REPO_COLORS[node.repo] || DEFAULT_COLOR)
        meshRef.current.setColorAt(i, tmpColor)
      }
      meshRef.current.instanceMatrix.needsUpdate = true
      if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true
    })

    return {
      nodeCount: nodes.length,
      linePositions: linePosArr,
      lineCount: edgeLimit * 2,
    }
  }, [graphData, dummy])

  if (nodeCount === 0) return null

  return (
    <group>
      <instancedMesh ref={meshRef} args={[SHARED_OCTA, null, nodeCount]}>
        <meshBasicMaterial transparent opacity={opacity} toneMapped={false} />
      </instancedMesh>

      {linePositions && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              array={linePositions}
              count={lineCount}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#a855f7" transparent opacity={opacity * 0.06} />
        </lineSegments>
      )}
    </group>
  )
}

// ── Main Nucleus Component ───────────────────────────────────────────

export default function Nucleus({ systemState = 'idle', activeImplantCount = 6, settings = {} }) {
  const groupRef = useRef()
  const lightRef = useRef()
  const sphereMatRef = useRef()
  const timeRef = useRef(0)
  const lodRef = useRef(0)
  const lodOpacityRef = useRef({ lod0: 1, lod1: 0, lod2: 0 })

  const [graphData, setGraphData] = useState(null)
  const [graphFailed, setGraphFailed] = useState(false)
  const [currentLod, setCurrentLod] = useState(0)
  const [lod1Opacity, setLod1Opacity] = useState(0)
  const [lod2Opacity, setLod2Opacity] = useState(0)

  const breathAmp = settings.nucleusBreathAmp ?? 0.03
  const nucleusGlow = settings.nucleusGlow ?? 0.6

  const color = useMemo(() => new THREE.Color(STATE_COLORS[systemState] || STATE_COLORS.idle), [systemState])
  const pulseSpeed = PULSE_SPEEDS[systemState] || PULSE_SPEEDS.idle
  const growthScale = 0.7 + (activeImplantCount / 13) * 0.5

  // Fetch graph data once
  useEffect(() => {
    const controller = new AbortController()
    fetch(GRAPH_DATA_URL, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(data => setGraphData(data))
      .catch(err => {
        if (err.name !== 'AbortError') setGraphFailed(true)
      })
    return () => controller.abort()
  }, [])

  // Extract repo list for LOD 1
  const repos = useMemo(() => {
    if (!graphData) return []
    return [...new Set(graphData.nodes.map(n => n.repo))]
  }, [graphData])

  // Frame loop: breath animation + LOD detection + opacity crossfade
  useFrame(({ camera }) => {
    try {
      timeRef.current += 1 / 60 // approximate delta

      // Breath animation (always)
      if (groupRef.current) {
        const breathe = systemState === 'error'
          ? 1.0 + Math.sin(timeRef.current * 9) * (breathAmp * 0.13)
          : 1.0 + Math.sin(timeRef.current * (Math.PI * 2) / pulseSpeed) * (breathAmp * 0.4)
        groupRef.current.scale.setScalar(breathe)

        if (lightRef.current) {
          lightRef.current.intensity = 0.8 + (breathe - 1.0) * 20
        }
      }

      // LOD detection
      const dist = camera.position.length()
      let targetLod = 0
      if (!graphFailed && graphData) {
        if (dist < 20) targetLod = 2
        else if (dist < 50) targetLod = 1
      }

      if (targetLod !== lodRef.current) {
        lodRef.current = targetLod
        setCurrentLod(targetLod)
      }

      // Smooth crossfade (lerp opacity refs)
      const speed = 3.0 // crossfade speed
      const dt = 1 / 60
      const op = lodOpacityRef.current
      op.lod0 = lerp(op.lod0, targetLod === 0 ? 0.3 : 0.08, speed * dt)
      op.lod1 = lerp(op.lod1, targetLod === 1 ? 0.7 : 0, speed * dt)
      op.lod2 = lerp(op.lod2, targetLod === 2 ? 0.8 : 0, speed * dt)

      // Update sphere material opacity
      if (sphereMatRef.current) {
        sphereMatRef.current.opacity = op.lod0
      }

      // Batch state updates (only when values change significantly)
      if (Math.abs(op.lod1 - lod1Opacity) > 0.01) setLod1Opacity(op.lod1)
      if (Math.abs(op.lod2 - lod2Opacity) > 0.01) setLod2Opacity(op.lod2)
    } catch { /* ref not ready */ }
  })

  return (
    <group ref={groupRef}>
      {/* The orb (LOD 0 — always present, opacity varies) */}
      <mesh scale={growthScale}>
        <sphereGeometry args={[1.5, 32, 32]} />
        <meshStandardMaterial
          ref={sphereMatRef}
          color={color}
          emissive={color}
          emissiveIntensity={nucleusGlow}
          transparent
          opacity={0.3}
          depthWrite={false}
        />
      </mesh>

      {/* Soft light */}
      <pointLight ref={lightRef} color={color} intensity={1.0} distance={12} decay={2} />

      {/* Horns (always visible) */}
      <Horn side={1} color={color} />
      <Horn side={-1} color={color} />

      {/* LOD 1: Repo clusters */}
      {currentLod >= 1 && repos.length > 0 && (
        <RepoClusters repos={repos} opacity={lod1Opacity} />
      )}

      {/* LOD 2: File-level detail */}
      {currentLod >= 2 && graphData && (
        <FileNodes graphData={graphData} opacity={lod2Opacity} />
      )}
    </group>
  )
}
