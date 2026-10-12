/**
 * TeamClusters — Agentic team hub+satellite clusters.
 *
 * Fibonacci layout:
 *   Core teams (secops, software-dev, etc.):  r=38
 *   Plugin/chief teams:                       r=59
 *
 * Each team renders as:
 *   - Hub node: the team orchestrator (larger octahedron, team accent colour)
 *   - Satellite nodes: member agents as small octahedrons orbiting the hub
 *     at 3-5 unit radius, laid out in a mini Fibonacci ring
 *   - Faint connection lines from hub to each satellite
 *   - Billboard label above hub
 *
 * Reads team definitions from the static team registry (no auth context).
 */
import { useRef, useMemo, useState, useCallback, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { useDisposable } from '../lib/useDisposable'

import { getBuiltInTeams } from '../../../config/teams/index'
import { assistants } from '../../../config/assistants'

// Fibonacci ring radii
const R_CORE_TEAMS = 38
const R_PLUGIN_TEAMS = 59
const RING_Y = 0.3

// Satellite orbit radius — generous spacing so clusters don't overlap
const SAT_RADIUS_BASE = 4
const SAT_RADIUS_PER_MEMBER = 0.5
const COLLAPSED_RADIUS = 1.5

// Core team IDs (everything else = plugin/chief)
const CORE_TEAM_IDS = new Set([
  'quoxcore', 'secops', 'startup-ops', 'growth-ops',
  'content-research', 'software-dev',
])

// ─── Satellite node (small member agent) ────────────────
function SatelliteNode({ agentId, position, worldPosition, color, name, onSelect }) {
  const wireRef = useRef()
  const [hovered, setHovered] = useState(false)

  useFrame((_, delta) => {
    try {
      if (wireRef.current) wireRef.current.rotation.y += delta * 0.15
    } catch { /* ref not ready */ }
  })

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'agent', id: agentId, name, role: 'team-member',
      state: 'idle', color, position: worldPosition,
    })
  }, [agentId, name, color, worldPosition, onSelect])

  const col = useMemo(() => new THREE.Color(color), [color])
  const scale = hovered ? 0.38 : 0.3

  return (
    <group position={position}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={col} wireframe transparent opacity={hovered ? 0.5 : 0.25} />
      </mesh>
      <mesh scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={col} emissive={col} emissiveIntensity={0.4}
          transparent opacity={0.6} roughness={0.3}
        />
      </mesh>
      {/* Label on hover */}
      {hovered && (
        <Billboard position={[0, 0.6, 0]}>
          <Text fontSize={0.18} color="white" anchorX="center" anchorY="middle"
            fillOpacity={0.85} outlineWidth={0.01} outlineColor="#000000">
            {name}
          </Text>
        </Billboard>
      )}
      {/* Hitbox */}
      <mesh scale={0.6}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
        onClick={handleClick}
        visible={false}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

// ─── Connection line (hub → satellite) ──────────────────
function ThinLine({ from, to, color, opacity = 0.06 }) {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([...from, ...to]), 3
    ))
    return g
  }, [from, to])
  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </line>
  )
}

// ─── Team Hub (orchestrator) ────────────────────────────
function TeamHub({ team, position, worldPosition, onSelect }) {
  const wireRef = useRef()
  const innerRef = useRef()
  const [hovered, setHovered] = useState(false)

  const color = useMemo(() => new THREE.Color(team.color), [team.color])
  const HUB_SCALE = 0.6

  useFrame((_, delta) => {
    try {
      if (wireRef.current) { wireRef.current.rotation.y += delta * 0.1; wireRef.current.rotation.x += delta * 0.03 }
      if (innerRef.current) innerRef.current.rotation.y -= delta * 0.06
    } catch { /* ref not ready */ }
  })

  const handleClick = useCallback((e) => {
    e.stopPropagation()
    onSelect?.({
      type: 'team', id: team.id, name: team.name, role: 'team',
      state: 'active', color: team.color,
      description: `Orchestrator: ${team.orchestratorName}\n${team.memberCount} agents`,
      memberCount: team.memberCount, position: worldPosition || position,
    })
  }, [team, position, onSelect])

  const hm = hovered ? 1.12 : 1

  return (
    <group position={position}>
      {/* Outer wireframe */}
      <mesh ref={wireRef} scale={HUB_SCALE * hm}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.35 * (hovered ? 1.5 : 1)} />
      </mesh>
      {/* Inner core */}
      <mesh ref={innerRef} scale={HUB_SCALE * 0.65 * hm}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5 * (hovered ? 1.4 : 1)}
          transparent opacity={0.7} roughness={0.2} metalness={0.1} />
      </mesh>
      {/* Ground glow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -HUB_SCALE * 0.7, 0]}>
        <circleGeometry args={[HUB_SCALE * 1.2, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.1}
          side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight color={color} intensity={0.2} distance={5} decay={2} />
      {/* Label */}
      <Billboard position={[0, HUB_SCALE * 1.6, 0]}>
        <Text fontSize={0.26} color="white" anchorX="center" anchorY="middle"
          outlineWidth={0.015} outlineColor="#000000" fillOpacity={hovered ? 0.9 : 0.55}>
          {team.name}
        </Text>
        <Text fontSize={0.15} color={team.color} anchorX="center" anchorY="middle"
          position={[0, -0.3, 0]} fillOpacity={hovered ? 0.7 : 0.35}>
          {`${team.orchestratorName} + ${team.memberCount - 1}`}
        </Text>
      </Billboard>
      {/* Hitbox */}
      <mesh scale={HUB_SCALE * 2}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
        onClick={handleClick} visible={false}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </group>
  )
}

// ─── Team Cluster (hub + satellites with expand/collapse) ─
function TeamCluster({ team, hubPosition, onSelect, expanded: forceExpand }) {
  const memberCount = team.members.length
  const collapsedRadius = COLLAPSED_RADIUS
  const expandedRadius = SAT_RADIUS_BASE + memberCount * SAT_RADIUS_PER_MEMBER
  const [expanded, setExpanded] = useState(false)
  const currentRadiusRef = useRef(collapsedRadius)
  const isExpanded = expanded || forceExpand

  // Animate radius
  useFrame((_, delta) => {
    try {
      const target = isExpanded ? expandedRadius : collapsedRadius
      currentRadiusRef.current += (target - currentRadiusRef.current) * Math.min(1, delta * 4)
    } catch {}
  })

  const handleHubClick = useCallback((e) => {
    setExpanded(p => !p)
  }, [])

  // Place satellites in a ring — radius animates
  const satellites = useMemo(() => {
    return team.members.map((m, i) => {
      const angle = (i / memberCount) * Math.PI * 2
      const yOffset = Math.sin(i * 1.3) * 0.4
      return {
        agentId: m.agentId,
        name: m.displayName || m.agentId.toUpperCase(),
        color: m.color || team.color,
        angle,
        yOffset,
      }
    })
  }, [team, memberCount])

  return (
    <group position={hubPosition}>
      <TeamHub team={team} position={[0, 0, 0]} worldPosition={hubPosition} onSelect={(item) => { handleHubClick(); onSelect?.(item) }} />

      {/* Satellite members — positions animate with radius */}
      {satellites.map(sat => {
        const r = currentRadiusRef.current
        const localPos = [
          Math.cos(sat.angle) * r,
          sat.yOffset * (isExpanded ? 1 : 0.3),
          Math.sin(sat.angle) * r,
        ]
        return (
        <SatelliteNode
          key={sat.agentId}
          agentId={sat.agentId}
          position={localPos}
          worldPosition={[
            hubPosition[0] + localPos[0],
            hubPosition[1] + localPos[1],
            hubPosition[2] + localPos[2],
          ]}
          color={sat.color}
          name={sat.name}
          onSelect={onSelect}
        />
        )
      })}

      {/* Connection lines: hub to each satellite */}
      {satellites.map(sat => {
        const r = currentRadiusRef.current
        const localPos = [Math.cos(sat.angle) * r, sat.yOffset * (isExpanded ? 1 : 0.3), Math.sin(sat.angle) * r]
        return (
        <ThinLine
          key={`line-${sat.agentId}`}
          from={[0, 0, 0]}
          to={localPos}
          color={team.color}
          opacity={isExpanded ? 0.1 : 0.04}
        />
        )
      })}

      {/* Faint orbit ring — visible when expanded */}
      {isExpanded && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
          <torusGeometry args={[expandedRadius, 0.015, 8, 32]} />
          <meshBasicMaterial color={team.color} transparent opacity={0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
    </group>
  )
}

// ─── Main Component ─────────────────────────────────────
export default function TeamClusters({ onSelect, objectives = [] }) {
  // Determine which teams have running objectives (for auto-expand)
  const activeTeamIds = useMemo(() => {
    const ids = new Set()
    objectives.forEach(obj => {
      if (obj.status !== 'running') return
      ;(obj.tasks || []).forEach(t => {
        if (t.status === 'running' && t.agentId) ids.add(t.agentId)
      })
    })
    return ids
  }, [objectives])
  const { coreTeams, pluginTeams } = useMemo(() => {
    const raw = getBuiltInTeams()
    const core = []
    const plugin = []

    Object.values(raw).forEach(t => {
      // Look up orchestrator display name
      const orch = assistants[t.orchestrator?.agentId]
      const orchestratorName = orch?.name || t.orchestrator?.agentId?.toUpperCase() || '?'

      // Look up member display names and colours
      const members = (t.members || []).map(m => {
        const a = assistants[m.agentId]
        return {
          agentId: m.agentId,
          role: m.role,
          displayName: a?.name || m.agentId.toUpperCase(),
          color: a?.color || t.accentColor || '#8b5cf6',
        }
      })

      const teamData = {
        id: t.id,
        name: t.displayName,
        color: t.accentColor || '#8b5cf6',
        orchestratorId: t.orchestrator?.agentId,
        orchestratorName,
        memberCount: members.length + 1,
        members,
      }

      if (CORE_TEAM_IDS.has(t.id)) {
        core.push(teamData)
      } else {
        plugin.push(teamData)
      }
    })

    return { coreTeams: core, pluginTeams: plugin }
  }, [])

  return (
    <group>
      {/* Core teams ring at r=38 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, RING_Y, 0]}>
        <torusGeometry args={[R_CORE_TEAMS, 0.02, 8, 64]} />
        <meshBasicMaterial color="#8b5cf6" transparent opacity={0.08} />
      </mesh>

      {coreTeams.map((team, i) => {
        const angle = (i / coreTeams.length) * Math.PI * 2
        const x = Math.cos(angle) * R_CORE_TEAMS
        const z = Math.sin(angle) * R_CORE_TEAMS
        // Auto-expand if any team member has a running objective
        const hasActivity = team.members.some(m => activeTeamIds.has(m.agentId)) || activeTeamIds.has(team.orchestratorId)
        return (
          <TeamCluster
            key={team.id}
            team={team}
            hubPosition={[x, RING_Y, z]}
            onSelect={onSelect}
            expanded={hasActivity}
          />
        )
      })}

      {/* Plugin/chief teams ring at r=59 */}
      {pluginTeams.length > 0 && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, RING_Y, 0]}>
            <torusGeometry args={[R_PLUGIN_TEAMS, 0.02, 8, 64]} />
            <meshBasicMaterial color="#8b5cf6" transparent opacity={0.06} />
          </mesh>

          {pluginTeams.map((team, i) => {
            const angle = (i / pluginTeams.length) * Math.PI * 2
            const x = Math.cos(angle) * R_PLUGIN_TEAMS
            const z = Math.sin(angle) * R_PLUGIN_TEAMS
            const hasActivity = team.members.some(m => activeTeamIds.has(m.agentId)) || activeTeamIds.has(team.orchestratorId)
            return (
              <TeamCluster
                key={team.id}
                team={team}
                hubPosition={[x, RING_Y, z]}
                onSelect={onSelect}
                expanded={hasActivity}
              />
            )
          })}
        </>
      )}
    </group>
  )
}
