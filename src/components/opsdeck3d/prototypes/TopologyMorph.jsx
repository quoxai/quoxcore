/**
 * TopologyMorph — 8 agent nodes smoothly rearranging between 4 topologies.
 *
 * Cycles: star -> hierarchical -> pipeline -> mesh every 4s.
 * Positions lerp using damp3. Connection lines fade in/out per topology.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { damp3 } from 'maath/easing'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const TOPOLOGIES = ['STAR', 'HIERARCHICAL', 'PIPELINE', 'MESH']
const NODE_NAMES = ['QUOX', 'WARDEN', 'CIPHER', 'HYPERION', 'DAEDALUS', 'METRICS', 'INSIGHT', 'VIGIL']
const NODE_COLORS = [
  PALETTE.indigo, PALETTE.executing, PALETTE.thinking, PALETTE.reading,
  PALETTE.violet, PALETTE.cyan, PALETTE.active, PALETTE.done,
]

function getTopologyPositions(topo) {
  const r = 6
  switch (topo) {
    case 'STAR':
      return [
        [0, 0, 0], // centre
        ...Array.from({ length: 7 }, (_, i) => {
          const a = (i / 7) * Math.PI * 2
          return [Math.cos(a) * r, 0, Math.sin(a) * r]
        }),
      ]
    case 'HIERARCHICAL':
      return [
        [0, 4, 0],                            // root
        [-4, 1, 0], [0, 1, 0], [4, 1, 0],     // managers
        [-5, -2, 0], [-2, -2, 0], [2, -2, 0], [5, -2, 0], // leaves
      ]
    case 'PIPELINE':
      return Array.from({ length: 8 }, (_, i) => [
        -7 + i * 2, Math.sin(i * 0.5) * 0.8, 0,
      ])
    case 'MESH':
      return Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2
        return [Math.cos(a) * r, Math.sin(a * 2) * 1.5, Math.sin(a) * r]
      })
    default:
      return Array(8).fill([0, 0, 0])
  }
}

function getTopologyConnections(topo) {
  switch (topo) {
    case 'STAR':
      return Array.from({ length: 7 }, (_, i) => [0, i + 1])
    case 'HIERARCHICAL':
      return [
        [0, 1], [0, 2], [0, 3],
        [1, 4], [1, 5], [3, 6], [3, 7],
      ]
    case 'PIPELINE':
      return Array.from({ length: 7 }, (_, i) => [i, i + 1])
    case 'MESH':
      // All-to-all (limited to keep it readable)
      const conns = []
      for (let i = 0; i < 8; i++) {
        for (let j = i + 1; j < 8; j++) {
          conns.push([i, j])
        }
      }
      return conns
    default:
      return []
  }
}

function OctNode({ positionRef, index, scale, color, name }) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const ringRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const currentPos = useRef([0, 0, 0])

  useFrame((_, delta) => {
    timeRef.current += delta
    if (groupRef.current && positionRef.current[index]) {
      // Smooth lerp to target
      damp3(currentPos.current, positionRef.current[index], 0.15, delta)
      groupRef.current.position.set(
        currentPos.current[0],
        currentPos.current[1] + Math.sin(timeRef.current * 0.6 + index) * 0.08,
        currentPos.current[2],
      )
    }
    if (wireRef.current) wireRef.current.rotation.y += delta * 0.12
    if (innerRef.current) innerRef.current.rotation.y -= delta * 0.08
    if (ringRef.current) {
      ringRef.current.rotation.z += delta * 0.8
      ringRef.current.rotation.x += delta * 0.24
    }
  })

  const ringSize = scale * 1.5

  return (
    <group ref={groupRef}>
      <mesh ref={wireRef} scale={scale}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
      </mesh>
      <mesh ref={innerRef} scale={scale * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.7}
          transparent
          opacity={0.75}
          roughness={0.2}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -scale * 0.7, 0]}>
        <circleGeometry args={[scale * 1.0, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Scanning ring */}
      <group ref={ringRef} rotation={[0.5, 0.3, 0]}>
        <mesh>
          <torusGeometry args={[ringSize, 0.012, 8, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.3} />
        </mesh>
      </group>
      <Billboard position={[0, scale * 1.2, 0]}>
        <Text fontSize={0.22} color="white" anchorX="center" outlineWidth={0.02} outlineColor="#000" fillOpacity={0.7}>
          {name}
        </Text>
      </Billboard>
    </group>
  )
}

function ConnectionLines({ positionsRef, connections, opacity }) {
  const linesRef = useRef([])

  // We draw lines in a single group, updating geometry each frame
  const lineGeos = useMemo(() => {
    return connections.map(() => {
      const geo = new THREE.BufferGeometry()
      const positions = new Float32Array(6)
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      return geo
    })
  }, [connections])

  useFrame(() => {
    connections.forEach(([a, b], i) => {
      const pa = positionsRef.current[a]
      const pb = positionsRef.current[b]
      if (!pa || !pb || !lineGeos[i]) return
      const posAttr = lineGeos[i].attributes.position
      posAttr.array[0] = pa[0]; posAttr.array[1] = pa[1]; posAttr.array[2] = pa[2]
      posAttr.array[3] = pb[0]; posAttr.array[4] = pb[1]; posAttr.array[5] = pb[2]
      posAttr.needsUpdate = true
    })
  })

  return (
    <group>
      {lineGeos.map((geo, i) => (
        <line key={i} geometry={geo}>
          <lineBasicMaterial
            color={PALETTE.connection}
            transparent
            opacity={opacity}
            depthWrite={false}
          />
        </line>
      ))}
    </group>
  )
}

export default function TopologyMorph() {
  const timeRef = useRef(0)
  const [topoIndex, setTopoIndex] = useState(0)
  const [prevTopoIndex, setPrevTopoIndex] = useState(0)
  const [transitionProgress, setTransitionProgress] = useState(1)
  const targetPositions = useRef(getTopologyPositions('STAR'))
  const currentConnections = useRef(getTopologyConnections('STAR'))
  const lineOpacity = useRef(0.08)
  const lastSwitch = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta

    // Cycle every 4s
    if (timeRef.current - lastSwitch.current > 4) {
      lastSwitch.current = timeRef.current
      const next = (topoIndex + 1) % TOPOLOGIES.length
      setPrevTopoIndex(topoIndex)
      setTopoIndex(next)
      setTransitionProgress(0)
      targetPositions.current = getTopologyPositions(TOPOLOGIES[next])
      currentConnections.current = getTopologyConnections(TOPOLOGIES[next])
    }

    // Fade connections
    if (transitionProgress < 1) {
      setTransitionProgress(p => Math.min(1, p + delta / 1.5))
      lineOpacity.current = transitionProgress * 0.08
    } else {
      lineOpacity.current = 0.08
    }
  })

  const topo = TOPOLOGIES[topoIndex]
  const prevTopo = TOPOLOGIES[prevTopoIndex]

  return (
    <group>
      {/* Topology label */}
      <Billboard position={[0, 8, 0]}>
        <Text
          fontSize={0.5}
          color="white"
          anchorX="center"
          outlineWidth={0.03}
          outlineColor="#000"
          fillOpacity={0.85}
        >
          {transitionProgress < 1 ? `${prevTopo} \u2192 ${topo}` : topo}
        </Text>
        <Text
          fontSize={0.2}
          color={PALETTE.indigo}
          anchorX="center"
          position={[0, -0.5, 0]}
          fillOpacity={0.5}
        >
          {`${NODE_NAMES.length} nodes \u00B7 ${currentConnections.current.length} connections`}
        </Text>
      </Billboard>

      {/* Nodes */}
      {NODE_NAMES.map((name, i) => (
        <OctNode
          key={i}
          positionRef={targetPositions}
          index={i}
          scale={i === 0 ? NODE_SCALES.orchestrator : NODE_SCALES.specialist}
          color={NODE_COLORS[i]}
          name={name}
        />
      ))}

      {/* Connection lines */}
      <ConnectionLines
        positionsRef={targetPositions}
        connections={currentConnections.current}
        opacity={lineOpacity.current}
      />
    </group>
  )
}
