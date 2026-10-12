/**
 * SpeechBubble — Floating speech bubble above an agent node.
 *
 * Appears when an agent "speaks" (chat response or event).
 * Auto-fades after 8 seconds. Connected to the agent node by a thin line.
 * Uses Html from drei for crisp text overlay in 3D space.
 */
import { useRef, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const FADE_DURATION = 8000 // ms before auto-dismiss
const FLOAT_HEIGHT = 2.5   // units above node

export default function SpeechBubble({ position, text, agentColor = '#8b5cf6', agentName, onDismiss }) {
  const groupRef = useRef()
  const [opacity, setOpacity] = useState(0)
  const startTime = useRef(Date.now())

  // Fade in
  useEffect(() => {
    const t = setTimeout(() => setOpacity(1), 50)
    return () => clearTimeout(t)
  }, [])

  // Auto-fade and dismiss
  useFrame(() => {
    try {
      const elapsed = Date.now() - startTime.current
      if (elapsed > FADE_DURATION - 1500) {
        // Fade out over last 1.5s
        const fadeProgress = (elapsed - (FADE_DURATION - 1500)) / 1500
        setOpacity(Math.max(0, 1 - fadeProgress))
      }
      if (elapsed > FADE_DURATION) {
        onDismiss?.()
      }
      // Gentle float
      if (groupRef.current) {
        groupRef.current.position.y = FLOAT_HEIGHT + Math.sin(elapsed * 0.002) * 0.1
      }
    } catch {}
  })

  if (!position || !text) return null

  return (
    <group ref={groupRef} position={[position[0], (position[1] || 0) + FLOAT_HEIGHT, position[2]]}>
      {/* Connection line down to agent */}
      <mesh position={[0, -FLOAT_HEIGHT / 2, 0]}>
        <cylinderGeometry args={[0.005, 0.005, FLOAT_HEIGHT, 4]} />
        <meshBasicMaterial color={agentColor} transparent opacity={opacity * 0.2} depthWrite={false} />
      </mesh>

      {/* Speech bubble (HTML overlay) */}
      <Html
        position={[0, 0, 0]}
        style={{
          pointerEvents: 'none',
          opacity,
          transition: 'opacity 0.3s ease',
        }}
        zIndexRange={[40, 0]}
        center
      >
        <div style={{
          padding: '6px 10px',
          background: 'rgba(5, 5, 16, 0.92)',
          backdropFilter: 'blur(12px)',
          border: `1px solid ${agentColor}40`,
          borderRadius: 6,
          maxWidth: 180,
          fontFamily: FONT_STACK,
          fontSize: 9,
          letterSpacing: '0.02em',
          lineHeight: 1.4,
          color: 'rgba(255,255,255,0.8)',
          boxShadow: `0 2px 12px rgba(0,0,0,0.4), 0 0 8px ${agentColor}15`,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {agentName && (
            <div style={{
              fontSize: 7, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: agentColor, marginBottom: 3,
            }}>
              {agentName}
            </div>
          )}
          {text}
        </div>
      </Html>
    </group>
  )
}
