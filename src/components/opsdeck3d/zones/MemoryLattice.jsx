/**
 * MemoryLattice — Container managing all memory crystals on orbital tracks
 *
 * 3 tilted orbital tracks (electron shell pattern):
 *   Track 0: r=43, tilt=15deg (0.262 rad) — inner
 *   Track 1: r=46, tilt=35deg (0.611 rad) — middle
 *   Track 2: r=48, tilt=55deg (0.960 rad) — outer
 *
 * The whole lattice slowly rotates (0.008 rad/s).
 * Memories are distributed across tracks by index.
 *
 * Includes optional relationship threads (faint lines between same-type memories).
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { MemoryOrbitPath } from './ZoneRings'
import MemoryCrystal from './MemoryCrystal'
import { PALETTE } from '../lib/design-system'

const TRACKS = [
  { radius: 98,  tilt: 0.262 },  // Fibonacci layout: memory at r=105 (inner track)
  { radius: 105, tilt: 0.611 },  // mid track
  { radius: 112, tilt: 0.960 },  // outer track
]

const ROSE = '#ec4899'

export default function MemoryLattice({ memories = [], settings = {}, onSelect }) {
  const groupRef = useRef()

  // Distribute memories across 3 tracks
  const trackAssignments = useMemo(() => {
    const assignments = [[], [], []]
    memories.forEach((mem, i) => {
      assignments[i % 3].push({ memory: mem, trackIndex: i % 3 })
    })
    return assignments
  }, [memories])

  // Slow lattice rotation
  useFrame((_, delta) => {
    try {
      if (groupRef.current) {
        groupRef.current.rotation.y += delta * 0.008
      }
    } catch { /* ref not ready */ }
  })

  return (
    <group ref={groupRef}>
      {/* === 3 VISIBLE ORBITAL TRACKS === */}
      {TRACKS.map((track, i) => (
        <MemoryOrbitPath
          key={`track-${i}`}
          radius={track.radius}
          tilt={track.tilt}
          color={ROSE}
          opacity={settings.memoryOrbitOpacity ?? 0.04}
        />
      ))}

      {/* === ZONE LABEL — Billboard at r=45 === */}
      <Billboard position={[0, 0.5, 105]}>
        <Text
          fontSize={0.6}
          color={ROSE}
          anchorX="center"
          anchorY="middle"
          fillOpacity={settings.zoneLabelOpacity ?? 0.3}
          outlineWidth={0.03}
          outlineColor="#000000"
        >
          MEMORY LATTICE
        </Text>
        <Text
          fontSize={0.25}
          color={ROSE}
          anchorX="center"
          anchorY="middle"
          position={[0, -0.5, 0]}
          fillOpacity={(settings.zoneLabelOpacity ?? 0.3) * 0.5}
        >
          {memories.length} crystals
        </Text>
      </Billboard>

      {/* === MEMORY CRYSTALS — distributed across tracks === */}
      {TRACKS.map((track, trackIdx) => (
        <group key={`crystals-${trackIdx}`}>
          {trackAssignments[trackIdx].map(({ memory }, indexInTrack) => (
            <MemoryCrystal
              key={memory.id}
              memory={memory}
              orbitRadius={track.radius}
              orbitTilt={track.tilt}
              index={indexInTrack}
              total={trackAssignments[trackIdx].length}
              settings={settings}
              onSelect={onSelect}
            />
          ))}
        </group>
      ))}

      {/* === RELATIONSHIP THREADS — faint lines between same-type memories === */}
      <RelationshipThreads memories={memories} tracks={TRACKS} trackAssignments={trackAssignments} />
    </group>
  )
}

/**
 * RelationshipThreads — Faint connection lines between memories sharing a type.
 * Very low opacity (0.03) to avoid visual clutter.
 * Uses a single BufferGeometry with line segments for performance.
 */
function RelationshipThreads({ memories, tracks, trackAssignments }) {
  const linesRef = useRef()

  // Group memories by type, store their track/index for position calculation
  const lineSegments = useMemo(() => {
    const byType = {}
    memories.forEach((mem, globalIdx) => {
      const trackIdx = globalIdx % 3
      const indexInTrack = Math.floor(globalIdx / 3)
      if (!byType[mem.type]) byType[mem.type] = []
      byType[mem.type].push({ trackIdx, indexInTrack, total: trackAssignments[trackIdx].length })
    })

    // Only connect types with 2+ entries, max 3 connections per type to keep it sparse
    const segments = []
    Object.values(byType).forEach(group => {
      if (group.length < 2) return
      const maxConnections = Math.min(group.length - 1, 3)
      for (let i = 0; i < maxConnections; i++) {
        segments.push([group[i], group[i + 1]])
      }
    })
    return segments
  }, [memories, trackAssignments])

  // We don't animate these positions — they provide static structure
  // The positions are computed at initial angle only (t=0)
  const geometry = useMemo(() => {
    if (lineSegments.length === 0) return null

    const points = []
    lineSegments.forEach(([a, b]) => {
      const trackA = tracks[a.trackIdx]
      const trackB = tracks[b.trackIdx]
      const angleA = (a.indexInTrack / Math.max(a.total, 1)) * Math.PI * 2
      const angleB = (b.indexInTrack / Math.max(b.total, 1)) * Math.PI * 2

      points.push(
        new THREE.Vector3(
          Math.cos(angleA) * trackA.radius,
          Math.sin(angleA) * trackA.radius * Math.sin(trackA.tilt),
          Math.sin(angleA) * trackA.radius * Math.cos(trackA.tilt),
        ),
        new THREE.Vector3(
          Math.cos(angleB) * trackB.radius,
          Math.sin(angleB) * trackB.radius * Math.sin(trackB.tilt),
          Math.sin(angleB) * trackB.radius * Math.cos(trackB.tilt),
        ),
      )
    })

    const geo = new THREE.BufferGeometry().setFromPoints(points)
    return geo
  }, [lineSegments, tracks])

  if (!geometry) return null

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={ROSE} transparent opacity={0.03} depthWrite={false} />
    </lineSegments>
  )
}
