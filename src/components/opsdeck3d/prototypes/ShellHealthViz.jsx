/**
 * ShellHealthViz — Core shell with health readouts.
 *
 * Icosahedron wireframe with 12 segments coloured by health value.
 * Billboard labels per segment, central nucleus with overall health.
 * Degraded segment pulses amber, offline segment flickers red.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const SEGMENTS = [
  { name: 'quox-sense', health: 95 },
  { name: 'memory-service', health: 88 },
  { name: 'quox-executive', health: 92 },
  { name: 'delegation', health: 97 },
  { name: 'collector', health: 85 },
  { name: 'auth-service', health: 91 },
  { name: 'workflow-engine', health: 89 },
  { name: 'vector-store', health: 45 },  // degraded
  { name: 'monitoring', health: 93 },
  { name: 'ssh-bastion', health: 0 },    // offline
  { name: 'plugin-runtime', health: 87 },
  { name: 'event-bus', health: 94 },
]

function healthColor(h) {
  if (h <= 0) return PALETTE.blocked
  if (h < 50) return PALETTE.waiting
  if (h < 80) return PALETTE.waiting
  return PALETTE.executing
}

function SegmentFace({ vertices, health, name, labelPos }) {
  const meshRef = useRef()
  const timeRef = useRef(Math.random() * 100)
  const color = healthColor(health)
  const isDegraded = health > 0 && health < 50
  const isOffline = health <= 0

  useFrame((_, delta) => {
    timeRef.current += delta
    if (meshRef.current) {
      if (isDegraded) {
        meshRef.current.material.opacity = 0.15 + Math.sin(timeRef.current * 3) * 0.1
        meshRef.current.material.emissiveIntensity = 0.5 + Math.sin(timeRef.current * 3) * 0.3
      } else if (isOffline) {
        // Flicker
        const flicker = Math.random() > 0.85 ? 0.4 : 0.05
        meshRef.current.material.opacity = flicker
        meshRef.current.material.emissiveIntensity = flicker * 2
      }
    }
  })

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(vertices.length * 3)
    vertices.forEach((v, i) => {
      positions[i * 3] = v.x
      positions[i * 3 + 1] = v.y
      positions[i * 3 + 2] = v.z
    })
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.computeVertexNormals()
    return geo
  }, [vertices])

  return (
    <group>
      <mesh ref={meshRef} geometry={geometry}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isDegraded ? 0.5 : isOffline ? 0.1 : 0.3}
          transparent
          opacity={health > 80 ? 0.18 : health > 0 ? 0.15 : 0.05}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <Billboard position={labelPos}>
        <Text
          fontSize={0.22}
          color={color}
          anchorX="center"
          anchorY="middle"
          fillOpacity={0.7}
          outlineWidth={0.015}
          outlineColor="#000000"
        >
          {`${name} ${health}%`}
        </Text>
      </Billboard>
    </group>
  )
}

export default function ShellHealthViz() {
  const shellRef = useRef()
  const labelsRef = useRef()
  const timeRef = useRef(0)

  // Build icosahedron faces
  const { faces, labelPositions } = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(12, 0)
    const posArr = geo.attributes.position.array
    const faceList = []
    const labels = []

    // Each face is 3 vertices (non-indexed after IcosahedronGeometry default)
    const faceCount = Math.min(posArr.length / 9, SEGMENTS.length)
    for (let i = 0; i < faceCount; i++) {
      const base = i * 9
      const v0 = new THREE.Vector3(posArr[base], posArr[base + 1], posArr[base + 2])
      const v1 = new THREE.Vector3(posArr[base + 3], posArr[base + 4], posArr[base + 5])
      const v2 = new THREE.Vector3(posArr[base + 6], posArr[base + 7], posArr[base + 8])
      faceList.push([v0, v1, v2])

      // Label just outside the face centre
      const centre = new THREE.Vector3().addVectors(v0, v1).add(v2).divideScalar(3)
      const labelDir = centre.clone().normalize()
      labels.push(labelDir.multiplyScalar(14).toArray())
    }
    geo.dispose()
    return { faces: faceList, labelPositions: labels }
  }, [])

  // Overall health
  const overallHealth = useMemo(() => {
    const active = SEGMENTS.filter(s => s.health > 0)
    return Math.round(active.reduce((s, seg) => s + seg.health, 0) / active.length)
  }, [])

  useFrame((_, delta) => {
    timeRef.current += delta
    // Shell slowly rotates
    if (shellRef.current) {
      shellRef.current.rotation.y += delta * 0.03
      shellRef.current.rotation.x += delta * 0.008
    }
  })

  return (
    <group>
      {/* Shell group (rotates) */}
      <group ref={shellRef}>
        {/* Wireframe shell */}
        <mesh>
          <icosahedronGeometry args={[12, 0]} />
          <meshBasicMaterial
            color={PALETTE.shell}
            wireframe
            transparent
            opacity={0.08}
          />
        </mesh>

        {/* Segment faces */}
        {faces.map((verts, i) => {
          const seg = SEGMENTS[i]
          if (!seg) return null
          return (
            <SegmentFace
              key={i}
              vertices={verts}
              health={seg.health}
              name={seg.name}
              labelPos={labelPositions[i]}
            />
          )
        })}
      </group>

      {/* Central nucleus (stationary) */}
      <group>
        {/* Inner sphere */}
        <mesh>
          <sphereGeometry args={[1.5, 16, 16]} />
          <meshStandardMaterial
            color={PALETTE.indigo}
            emissive={PALETTE.indigo}
            emissiveIntensity={0.6}
            transparent
            opacity={0.6}
            roughness={0.3}
          />
        </mesh>
        {/* Outer glow sphere */}
        <mesh>
          <sphereGeometry args={[2.0, 16, 16]} />
          <meshBasicMaterial
            color={PALETTE.indigo}
            transparent
            opacity={0.05}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        {/* Centre label */}
        <Billboard position={[0, 0, 0]}>
          <Text
            fontSize={0.35}
            color="white"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.03}
            outlineColor="#000000"
            fillOpacity={0.9}
          >
            SYSTEM HEALTH
          </Text>
          <Text
            fontSize={0.55}
            color={overallHealth > 80 ? PALETTE.executing : PALETTE.waiting}
            anchorX="center"
            anchorY="middle"
            position={[0, -0.6, 0]}
            outlineWidth={0.03}
            outlineColor="#000000"
            fillOpacity={0.95}
          >
            {`${overallHealth}%`}
          </Text>
        </Billboard>
      </group>
    </group>
  )
}
