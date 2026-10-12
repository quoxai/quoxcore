/**
 * WorkflowDots — Active workflow indicators near the execution layer.
 *
 * Phase CC-13: Additional Data Layers.
 * Polls /quoxflow/api/executions?status=running every 15s (plain fetch, no auth).
 * Each running workflow = small octahedron at r=33.
 * Renders nothing when there are no running workflows (honest empty state,
 * no mock library fallback).
 * Uses InstancedMesh for minimal draw calls.
 */
import { useRef, useMemo, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

const RING_RADIUS = 90  // Fibonacci layout: workflows after execution (r=80)
const DOT_SCALE = 0.2
const POLL_INTERVAL = 15000

// Shared geometry
const dotGeometry = new THREE.OctahedronGeometry(1, 0)

const COLOR_RUNNING = new THREE.Color('#22c55e')
const COLOR_LIBRARY = new THREE.Color('#555570')

export default function WorkflowDots() {
  const meshRef = useRef()
  const groupRef = useRef()
  const [workflows, setWorkflows] = useState([])
  const [hovered, setHovered] = useState(null)
  const prevCount = useRef(-1)

  // Poll for running workflows
  useEffect(() => {
    let mounted = true

    async function poll() {
      try {
        const res = await fetch('/quoxflow/api/executions?status=running', {
          credentials: 'include',
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          const data = await res.json()
          const running = (Array.isArray(data) ? data : data.executions || [])
            .slice(0, 12) // Cap at 12 to avoid clutter
            .map(ex => ({
              id: ex.id || ex.executionId || `wf-${Math.random()}`,
              name: ex.workflowName || ex.name || 'Workflow',
              running: true,
            }))
          if (mounted) setWorkflows(running)
        }
      } catch {
        // API not available — honest empty state, no mock dots
        if (mounted) setWorkflows([])
      }
    }

    poll()
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => { mounted = false; clearInterval(timer) }
  }, [])

  // Real running workflows only — no mock fallback. Empty when none running.
  const displayWorkflows = workflows

  // Position dots around ring
  const dotData = useMemo(() => {
    return displayWorkflows.map((wf, i) => {
      const angle = (i / Math.max(displayWorkflows.length, 1)) * Math.PI * 2
      const yJitter = Math.sin(i * 1.7) * 0.4
      return {
        ...wf,
        color: wf.running ? COLOR_RUNNING : COLOR_LIBRARY,
        position: [
          Math.cos(angle) * RING_RADIUS,
          yJitter,
          Math.sin(angle) * RING_RADIUS,
        ],
      }
    })
  }, [displayWorkflows])

  // No InstancedMesh — use individual meshes to avoid buffer resize crashes
  // WorkflowDots count is typically <20, instancing overhead not worth the bug risk

  // Gentle pulse for running workflows
  const matRef = useRef()
  useFrame((state) => {
    try {
      if (matRef.current && workflows.length > 0) {
        const pulse = 0.15 + Math.sin(state.clock.elapsedTime * 2) * 0.1
        matRef.current.emissiveIntensity = pulse
      }
    } catch { /* ref not ready */ }
  })

  const handlePointerOver = (e) => {
    e.stopPropagation()
    const idx = e.instanceId
    if (idx != null && dotData[idx]) {
      setHovered(dotData[idx])
      document.body.style.cursor = 'pointer'
    }
  }

  const handlePointerOut = () => {
    setHovered(null)
    document.body.style.cursor = 'auto'
  }

  if (dotData.length === 0) return null

  return (
    <group ref={groupRef}>
      {/* Zone label */}
      <Billboard position={[0, 0.8, RING_RADIUS]}>
        <Text
          fontSize={0.3}
          color="rgba(255,255,255,0.2)"
          anchorX="center"
          anchorY="middle"
          font={undefined}
          letterSpacing={0.12}
        >
          WORKFLOWS
        </Text>
      </Billboard>

      {/* Individual dot meshes — avoids InstancedMesh buffer resize crash */}
      {dotData.map((d, i) => (
        <mesh
          key={d.id || i}
          position={d.position}
          scale={DOT_SCALE}
          rotation={[i * 0.4, i * 0.7, 0]}
        >
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial
            color={`#${Math.round(d.color.r * 255).toString(16).padStart(2, '0')}${Math.round(d.color.g * 255).toString(16).padStart(2, '0')}${Math.round(d.color.b * 255).toString(16).padStart(2, '0')}`}
            emissive={`#${Math.round(d.color.r * 255).toString(16).padStart(2, '0')}${Math.round(d.color.g * 255).toString(16).padStart(2, '0')}${Math.round(d.color.b * 255).toString(16).padStart(2, '0')}`}
            emissiveIntensity={0.3}
            transparent
            opacity={0.4}
            roughness={0.5}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Hover label */}
      {hovered && (
        <Billboard position={[hovered.position[0], hovered.position[1] + 0.6, hovered.position[2]]}>
          <Text
            fontSize={0.22}
            color={hovered.running ? 'rgba(34,197,94,0.9)' : 'rgba(255,255,255,0.6)'}
            anchorX="center"
            anchorY="middle"
            font={undefined}
          >
            {hovered.name.length > 20 ? hovered.name.slice(0, 20) + '...' : hovered.name}
          </Text>
        </Billboard>
      )}
    </group>
  )
}
