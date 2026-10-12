/**
 * HelicalSpine — Downward DNA double-helix protocol backbone.
 *
 * The helix grows DOWNWARD from the nucleus (y=0) to y=-15,
 * like roots/foundation beneath the core. This leaves space
 * above the nucleus for future GOLDENEYE mast.
 *
 * Protocol sections are proportional to typical event counts:
 *   AEE  (top, closest to nucleus) — 40% of helix
 *   AOCL — 25%
 *   VOLT — 20%
 *   WARD (bottom, fewest events) — 15%
 *
 * The helix is a scaffold waiting for real data — no mock dots.
 * Two interleaved strands of octahedron nodes with cross-rungs.
 */
import { useRef, useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useDisposable } from '../lib/useDisposable'

// ─── Protocol Zones (top to bottom, proportional lengths) ──
const Y_TOP = 0
const Y_BOTTOM = -15
const Y_RANGE = Math.abs(Y_BOTTOM - Y_TOP) // 15

// Proportional sections: AEE 40%, AOCL 25%, VOLT 20%, WARD 15%
const PROTOCOLS = [
  { id: 'aee',  label: 'AEE',  color: '#38bdf8', yMin: Y_TOP - Y_RANGE * 0.00, yMax: Y_TOP - Y_RANGE * 0.40, desc: 'envelopes' },
  { id: 'aocl', label: 'AOCL', color: '#a855f7', yMin: Y_TOP - Y_RANGE * 0.40, yMax: Y_TOP - Y_RANGE * 0.65, desc: 'control layers' },
  { id: 'volt', label: 'VOLT', color: '#06b6d4', yMin: Y_TOP - Y_RANGE * 0.65, yMax: Y_TOP - Y_RANGE * 0.85, desc: 'evidence chain' },
  { id: 'ward', label: 'WARD', color: '#14b8a6', yMin: Y_TOP - Y_RANGE * 0.85, yMax: Y_TOP - Y_RANGE * 1.00, desc: 'witness receipts' },
]

const HELIX_RADIUS = 1.5
const NODES_PER_STRAND = 40
const TURNS = 3
const NODE_SCALE = 0.1
const RUNG_INTERVAL = 4
const ROTATION_SPEED = 0.03

// ─── Precompute Geometry ────────────────────────────────

function getProtocolColor(y) {
  // Protocols are ordered top-to-bottom; yMin > yMax (going downward)
  for (const proto of PROTOCOLS) {
    if (y <= proto.yMin && y > proto.yMax) return proto.color
  }
  return PROTOCOLS[PROTOCOLS.length - 1].color
}

function buildHelixNodes() {
  const strandA = []
  const strandB = []

  for (let i = 0; i < NODES_PER_STRAND; i++) {
    const t = i / (NODES_PER_STRAND - 1)
    const y = Y_TOP - t * Y_RANGE  // 0 to -15
    const angle = t * TURNS * Math.PI * 2
    const color = getProtocolColor(y)

    strandA.push({
      position: [
        Math.cos(angle) * HELIX_RADIUS,
        y,
        Math.sin(angle) * HELIX_RADIUS,
      ],
      color,
      index: i,
    })

    strandB.push({
      position: [
        Math.cos(angle + Math.PI) * HELIX_RADIUS,
        y,
        Math.sin(angle + Math.PI) * HELIX_RADIUS,
      ],
      color,
      index: i,
    })
  }

  return { strandA, strandB }
}

function buildRungs(strandA, strandB) {
  const rungs = []
  for (let i = 0; i < NODES_PER_STRAND; i += RUNG_INTERVAL) {
    rungs.push({
      from: strandA[i].position,
      to: strandB[i].position,
      color: strandA[i].color,
    })
  }
  return rungs
}

// ─── Cross-Rung Line ────────────────────────────────────

function Rung({ from, to, color }) {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    const positions = new Float32Array([...from, ...to])
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [from, to])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.12} depthWrite={false} />
    </line>
  )
}

// ─── Octahedron Node ────────────────────────────────────

function HelixNode({ position, color, scale = NODE_SCALE, glowIntensity = 0.3 }) {
  const threeColor = useMemo(() => new THREE.Color(color), [color])

  return (
    <group position={position}>
      {/* Wireframe outer */}
      <mesh scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          color={threeColor}
          wireframe
          transparent
          opacity={0.2}
          depthWrite={false}
        />
      </mesh>
      {/* Solid inner */}
      <mesh scale={scale * 0.6}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={threeColor}
          emissive={threeColor}
          emissiveIntensity={glowIntensity}
          transparent
          opacity={0.5}
          roughness={0.3}
          metalness={0.05}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

// ─── Main Component ─────────────────────────────────────

export default function HelicalSpine({ envelopes = [], voltRuns = [], aoclStats = [], onSelect }) {
  const groupRef = useRef()

  // Build all geometry once
  const { strandA, strandB } = useMemo(buildHelixNodes, [])
  const rungs = useMemo(() => buildRungs(strandA, strandB), [strandA, strandB])

  // Slow rotation
  useFrame((_, delta) => {
    try {
      if (groupRef.current) {
        groupRef.current.rotation.y += delta * ROTATION_SPEED
      }
    } catch { /* ref not ready */ }
  })

  // Centre mast line geometry (y=0 to y=-15)
  const mastGeometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    const positions = new Float32Array([0, 0, 0, 0, -15, 0])
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [])

  return (
    <group ref={groupRef}>
      {/* Centre mast — GOLDENEYE's future perch */}
      <line geometry={mastGeometry}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.04} depthWrite={false} />
      </line>

      {/* Strand A nodes */}
      {strandA.map((node, i) => (
        <HelixNode
          key={`a-${i}`}
          position={node.position}
          color={node.color}
          scale={NODE_SCALE}
          glowIntensity={0.3}
        />
      ))}

      {/* Strand B nodes */}
      {strandB.map((node, i) => (
        <HelixNode
          key={`b-${i}`}
          position={node.position}
          color={node.color}
          scale={NODE_SCALE}
          glowIntensity={0.3}
        />
      ))}

      {/* Cross-rungs */}
      {rungs.map((rung, i) => (
        <Rung key={`r-${i}`} from={rung.from} to={rung.to} color={rung.color} />
      ))}

      {/* Protocol zone labels — positioned at the midpoint of each section */}
      {PROTOCOLS.map((proto) => {
        const midY = (proto.yMin + proto.yMax) / 2
        return (
          <Billboard
            key={proto.id}
            position={[HELIX_RADIUS + 1.2, midY, 0]}
          >
            <Text
              fontSize={0.22}
              color={proto.color}
              anchorX="left"
              anchorY="middle"
              fillOpacity={0.3}
              outlineWidth={0.012}
              outlineColor="#000000"
              letterSpacing={0.1}
            >
              {proto.label}
            </Text>
          </Billboard>
        )
      })}

      {/* Protocol section boundary rings — thin coloured rings at each section edge */}
      {PROTOCOLS.map((proto) => (
        <group key={`ring-${proto.id}`}>
          {/* Ring at section start */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, proto.yMin, 0]}>
            <torusGeometry args={[HELIX_RADIUS + 0.5, 0.01, 6, 24]} />
            <meshBasicMaterial color={proto.color} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
          {/* Ring at section end */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, proto.yMax, 0]}>
            <torusGeometry args={[HELIX_RADIUS + 0.5, 0.01, 6, 24]} />
            <meshBasicMaterial color={proto.color} transparent opacity={0.12} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      ))}

      {/* Real AEE envelope event dots — spiral around AEE section */}
      {envelopes.slice(0, 30).map((env, i) => {
        // Position along AEE section of helix (top portion)
        const t = i / Math.max(envelopes.length, 1) * 0.4 // 0-40% of helix (AEE zone)
        const y = Y_TOP - t * Y_RANGE
        const angle = t * TURNS * Math.PI * 2 + Math.PI * 0.5 // offset from strand
        const r = HELIX_RADIUS * 0.7
        const intentColor = env.intent?.startsWith('quox.chat') ? '#38bdf8'
          : env.intent?.startsWith('quox.action') ? '#22c55e'
          : env.intent?.startsWith('quox.memory') ? '#ec4899'
          : '#a855f7'

        return (
          <group
            key={env.id || i}
            position={[Math.cos(angle) * r, y, Math.sin(angle) * r]}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.({
                type: 'envelope',
                id: env.id,
                name: env.intent || 'AEE Envelope',
                role: 'protocol',
                state: env.type || 'event',
                color: intentColor,
                description: `${env.type || '?'} from ${env.from || '?'} → ${env.to || '?'}\n${env.ts || ''}`,
                position: [Math.cos(angle) * r, y, Math.sin(angle) * r],
              })
            }}
          >
            <mesh scale={0.06}>
              <octahedronGeometry args={[1, 0]} />
              <meshBasicMaterial
                color={intentColor}
                transparent
                opacity={0.6}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>
        )
      })}

      {/* Real AOCL layer stats — spiral around AOCL section (40-65% of helix) */}
      {aoclStats.slice(0, 10).map((layer, i) => {
        const t = 0.40 + (i / Math.max(aoclStats.length, 1)) * 0.25
        const y = Y_TOP - t * Y_RANGE
        const angle = t * TURNS * Math.PI * 2 + Math.PI * 0.7
        const r = HELIX_RADIUS * 0.7
        const layerColor = layer.color || '#a855f7'

        return (
          <group
            key={layer.layerId || i}
            position={[Math.cos(angle) * r, y, Math.sin(angle) * r]}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.({
                type: 'aocl-layer',
                id: layer.layerId,
                name: `AOCL: ${layer.label || layer.layerId}`,
                role: 'protocol',
                state: layer.bypasses > 0 ? 'warning' : 'active',
                color: layerColor,
                description: `${layer.starts || 0} starts · ${layer.completes || 0} completes · ${layer.bypasses || 0} bypasses`,
                position: [Math.cos(angle) * r, y, Math.sin(angle) * r],
              })
            }}
          >
            <mesh scale={0.07}>
              <octahedronGeometry args={[1, 0]} />
              <meshBasicMaterial color={layerColor} transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} />
            </mesh>
          </group>
        )
      })}

      {/* AOCL count label */}
      {aoclStats.length > 0 && (
        <Billboard position={[HELIX_RADIUS + 1.2, Y_TOP - Y_RANGE * 0.52, 0]}>
          <Text fontSize={0.15} color="#a855f7" anchorX="left" anchorY="middle"
            fillOpacity={0.4} outlineWidth={0.008} outlineColor="#000000">
            {`${aoclStats.length} layers`}
          </Text>
        </Billboard>
      )}

      {/* Real VOLT run dots — spiral around VOLT section (65-85% of helix) */}
      {voltRuns.slice(0, 20).map((run, i) => {
        const t = 0.65 + (i / Math.max(voltRuns.length, 1)) * 0.20 // 65-85% of helix (VOLT zone)
        const y = Y_TOP - t * Y_RANGE
        const angle = t * TURNS * Math.PI * 2 + Math.PI * 0.3
        const r = HELIX_RADIUS * 0.7
        const statusColor = run.status === 'complete' ? '#06b6d4'
          : run.status === 'active' ? '#22c55e'
          : '#f59e0b'

        return (
          <group
            key={run.run_id || i}
            position={[Math.cos(angle) * r, y, Math.sin(angle) * r]}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.({
                type: 'volt-run',
                id: run.run_id,
                name: `VOLT Run ${run.run_id?.slice(0, 8) || i}`,
                role: 'protocol',
                state: run.status || 'unknown',
                color: statusColor,
                description: `${run.status || '?'} · ${run.events?.length || 0} events · started ${run.started_at || '?'}`,
                position: [Math.cos(angle) * r, y, Math.sin(angle) * r],
              })
            }}
          >
            <mesh scale={0.08}>
              <octahedronGeometry args={[1, 0]} />
              <meshBasicMaterial
                color={statusColor}
                transparent
                opacity={0.6}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>
        )
      })}

      {/* Envelope count label */}
      {envelopes.length > 0 && (
        <Billboard position={[HELIX_RADIUS + 1.2, Y_TOP - 0.5, 0]}>
          <Text fontSize={0.15} color="#38bdf8" anchorX="left" anchorY="middle"
            fillOpacity={0.4} outlineWidth={0.008} outlineColor="#000000">
            {`${envelopes.length} envelopes`}
          </Text>
        </Billboard>
      )}

      {/* VOLT run count label */}
      {voltRuns.length > 0 && (
        <Billboard position={[HELIX_RADIUS + 1.2, Y_TOP - Y_RANGE * 0.75, 0]}>
          <Text fontSize={0.15} color="#06b6d4" anchorX="left" anchorY="middle"
            fillOpacity={0.4} outlineWidth={0.008} outlineColor="#000000">
            {`${voltRuns.length} evidence runs`}
          </Text>
        </Billboard>
      )}
    </group>
  )
}
