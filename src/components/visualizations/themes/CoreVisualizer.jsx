import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'
import { COGNITIVE_IMPLANTS } from '../../../config/cognitiveImplants.js'

/**
 * CoreVisualizer - COREY's unique visualization
 *
 * Represents the CORE self-awareness system:
 * - Central nucleus (pulsing core showing overall health)
 * - 5 orbital rings (the 5 CORE layers)
 * - Implant nodes (cognitive implants positioned around rings)
 * - Neural connections between elements
 * - Live datapoints counter with cross-tab sync
 *
 * States: idle, listening, speaking, thinking, error
 * Audio-reactive for pulse and glow effects
 */

// The 5 CORE layers with their configuration
const CORE_LAYERS = [
  { name: 'QuoxCORE_IDENTITY', label: 'Identity', radius: 0.25, speed: 0.0008, alpha: 0.9 },
  { name: 'QuoxAgent_DOCUMENTATION', label: 'QuoxAgent Docs', radius: 0.35, speed: 0.0012, alpha: 0.7 },
  { name: 'DYNAMIC_STATE', label: 'Live State', radius: 0.50, speed: 0.0018, alpha: 0.6 },
  { name: 'ASSISTANT_SELF', label: 'Self-Knowledge', radius: 0.65, speed: 0.0022, alpha: 0.5 },
  { name: 'TOOL_CONTEXT', label: 'Tools + User', radius: 0.80, speed: 0.0028, alpha: 0.4 }
]

// TRUST-GATE 1.18c — implant ids/labels are derived from the canonical
// COGNITIVE_IMPLANTS registry (src/config/cognitiveImplants.js), the same
// module reflectionService.js and mirrorIndex.js consume. The previous
// hand-maintained list silently dropped 3 implants (quox-sense,
// quox-nucleus, quox-predict). Layer index (0-4, into CORE_LAYERS), angle,
// and color are purely decorative placement — not a factual claim — so
// they're assigned deterministically rather than hand-tuned per id.
const IMPLANT_COLORS = ['#ef476f', '#9d4edd', '#8b5cf6', '#ef4444', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#0ea5e9']
export const IMPLANT_IDS = Object.keys(COGNITIVE_IMPLANTS)
const IMPLANTS = IMPLANT_IDS.map((id, i) => ({
  id,
  label: COGNITIVE_IMPLANTS[id].name,
  layer: (i % 4) + 1,
  angle: (i / IMPLANT_IDS.length) * Math.PI * 2,
  color: IMPLANT_COLORS[i % IMPLANT_COLORS.length],
}))

function CoreVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const timeRef = useRef(0)
  const layerAnglesRef = useRef(CORE_LAYERS.map(() => Math.random() * Math.PI * 2))
  const [dimensions, setDimensions] = useState({ width: 500, height: 500 })

  // Datapoints counter with animated display
  // Temporarily disabled to debug navigation issue
  const [datapoints, setDatapoints] = useState(0)
  const [displayCount, setDisplayCount] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)

  // Subscribe to datapoints changes - DISABLED FOR DEBUGGING
  // useEffect(() => {
  //   const unsubscribe = subscribeToDatapoints((count, delta) => {
  //     setDatapoints(count)
  //     if (delta !== 0) {
  //       setIsAnimating(true)
  //       setTimeout(() => setIsAnimating(false), 600)
  //     }
  //   })
  //   return unsubscribe
  // }, [])

  // Animate count changes
  useEffect(() => {
    if (displayCount === datapoints) return

    const diff = datapoints - displayCount
    const step = Math.max(1, Math.abs(Math.ceil(diff / 20)))
    const direction = diff > 0 ? 1 : -1

    const interval = setInterval(() => {
      setDisplayCount(prev => {
        const next = prev + (step * direction)
        if ((direction > 0 && next >= datapoints) || (direction < 0 && next <= datapoints)) {
          clearInterval(interval)
          return datapoints
        }
        return next
      })
    }, 30)

    return () => clearInterval(interval)
  }, [datapoints, displayCount])

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // COREY's teal base hue (170)
  const baseHue = config?.stateColors?.idle ?? 170

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          const size = Math.min(width, height)
          setDimensions({ width: size, height: size })
        }
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Update canvas size when dimensions change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  // Helper to get audio average
  const getAudioAverage = useCallback(() => {
    if (!audioData || !audioData.length) return 0
    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i]
    }
    return sum / audioData.length
  }, [audioData])

  // Get color based on state
  const getColor = useCallback((alpha = 1, hueOffset = 0) => {
    const hue = (stateConfig.hue + hueOffset) % 360
    return `hsla(${hue}, 80%, 50%, ${alpha})`
  }, [stateConfig.hue])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const { width, height } = dimensions
    const cx = width / 2
    const cy = height / 2
    const maxRadius = Math.min(width, height) * 0.45

    const draw = () => {
      timeRef.current += 1
      const time = timeRef.current

      // Get energy from audio or default pulse
      const energy = getAudioAverage() / 255
      const normEnergy = energy * stateConfig.sensitivity
      const pulse = 0.5 + Math.sin(time * 0.05) * 0.1

      // Speed multiplier based on state
      const speedMult = 1 + stateConfig.speed

      // Update layer rotation angles
      CORE_LAYERS.forEach((layer, i) => {
        layerAnglesRef.current[i] += layer.speed * speedMult
      })

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      // ===== DRAW CENTRAL NUCLEUS =====
      const coreRadius = maxRadius * 0.12 * stateConfig.scale
      const corePulse = coreRadius * (1 + normEnergy * 0.3 + pulse * 0.1)

      // Outer glow
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, corePulse * 2)
      gradient.addColorStop(0, getColor(0.8))
      gradient.addColorStop(0.5, getColor(0.3))
      gradient.addColorStop(1, getColor(0))

      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0, corePulse * 2), 0, Math.PI * 2)
      ctx.fill()

      // Core sphere
      const coreGradient = ctx.createRadialGradient(
        cx - corePulse * 0.3, cy - corePulse * 0.3, 0,
        cx, cy, corePulse
      )
      coreGradient.addColorStop(0, getColor(1, 20))
      coreGradient.addColorStop(0.7, getColor(0.9))
      coreGradient.addColorStop(1, getColor(0.6, -20))

      ctx.fillStyle = coreGradient
      ctx.shadowBlur = 20 * stateConfig.scale
      ctx.shadowColor = getColor(0.8)
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0, corePulse), 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0

      // ===== DRAW ORBITAL RINGS (5 CORE LAYERS) =====
      CORE_LAYERS.forEach((layer, layerIndex) => {
        const ringRadius = maxRadius * layer.radius
        const ringAngle = layerAnglesRef.current[layerIndex]

        // Ring line
        ctx.strokeStyle = getColor(layer.alpha * 0.6, layerIndex * 15)
        ctx.lineWidth = 1.5 * stateConfig.scale
        ctx.setLineDash([5, 10])
        ctx.beginPath()
        ctx.arc(cx, cy, Math.max(0, ringRadius), 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])

        // Ring marker (rotating dot)
        const markerX = cx + Math.cos(ringAngle) * ringRadius
        const markerY = cy + Math.sin(ringAngle) * ringRadius
        const markerSize = 3 * stateConfig.scale

        ctx.fillStyle = getColor(layer.alpha, layerIndex * 15)
        ctx.beginPath()
        ctx.arc(markerX, markerY, Math.max(0, markerSize), 0, Math.PI * 2)
        ctx.fill()
      })

      // ===== DRAW NEURAL CONNECTIONS TO IMPLANTS =====
      IMPLANTS.forEach((implant) => {
        const layerConfig = CORE_LAYERS[implant.layer]
        const ringRadius = maxRadius * layerConfig.radius
        const implantAngle = implant.angle + layerAnglesRef.current[implant.layer] * 0.2
        const implantX = cx + Math.cos(implantAngle) * ringRadius
        const implantY = cy + Math.sin(implantAngle) * ringRadius

        // Connection line to core
        const lineGradient = ctx.createLinearGradient(cx, cy, implantX, implantY)
        lineGradient.addColorStop(0, getColor(0.1))
        lineGradient.addColorStop(0.5, `${implant.color}40`)
        lineGradient.addColorStop(1, `${implant.color}80`)

        ctx.strokeStyle = lineGradient
        ctx.lineWidth = 1 * stateConfig.scale
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(implantX, implantY)
        ctx.stroke()
      })

      // ===== DRAW IMPLANT NODES =====
      IMPLANTS.forEach((implant, index) => {
        const layerConfig = CORE_LAYERS[implant.layer]
        const ringRadius = maxRadius * layerConfig.radius
        const implantAngle = implant.angle + layerAnglesRef.current[implant.layer] * 0.2
        const implantX = cx + Math.cos(implantAngle) * ringRadius
        const implantY = cy + Math.sin(implantAngle) * ringRadius

        const nodeSize = 8 * stateConfig.scale
        const nodePulse = nodeSize * (1 + normEnergy * 0.2)

        // Node glow
        ctx.shadowBlur = 12 * stateConfig.scale
        ctx.shadowColor = implant.color

        // Node circle
        const nodeGradient = ctx.createRadialGradient(
          implantX - nodePulse * 0.2, implantY - nodePulse * 0.2, 0,
          implantX, implantY, nodePulse
        )
        nodeGradient.addColorStop(0, '#ffffff')
        nodeGradient.addColorStop(0.3, implant.color)
        nodeGradient.addColorStop(1, `${implant.color}80`)

        ctx.fillStyle = nodeGradient
        ctx.beginPath()
        ctx.arc(implantX, implantY, Math.max(0, nodePulse), 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0

        // Node border
        ctx.strokeStyle = implant.color
        ctx.lineWidth = 1.5 * stateConfig.scale
        ctx.stroke()
      })

      // ===== DRAW SIGNAL PARTICLES (when speaking/thinking) =====
      if (state === 'speaking' || state === 'thinking') {
        const particleCount = state === 'thinking' ? 15 : 8
        for (let i = 0; i < particleCount; i++) {
          const angle = (time * 0.02 + i * (Math.PI * 2 / particleCount)) % (Math.PI * 2)
          const radiusOscillation = Math.sin(time * 0.03 + i) * 0.1
          const particleRadius = maxRadius * (0.3 + radiusOscillation + (i % 5) * 0.1)
          const px = cx + Math.cos(angle) * particleRadius
          const py = cy + Math.sin(angle) * particleRadius
          const pSize = 2 + normEnergy * 3

          ctx.fillStyle = getColor(0.7 + normEnergy * 0.3, i * 20)
          ctx.shadowBlur = 6
          ctx.shadowColor = getColor(0.8, i * 20)
          ctx.beginPath()
          ctx.arc(px, py, pSize, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.shadowBlur = 0
      }

      // ===== DRAW DATA FLOW LINES (when listening) =====
      if (state === 'listening') {
        for (let i = 0; i < 6; i++) {
          const flowAngle = layerAnglesRef.current[0] + i * (Math.PI / 3)
          const innerR = maxRadius * 0.15
          const outerR = maxRadius * 0.85
          const progress = ((time * 0.02 + i * 0.3) % 1)
          const flowR = innerR + (outerR - innerR) * progress
          const fx = cx + Math.cos(flowAngle) * flowR
          const fy = cy + Math.sin(flowAngle) * flowR

          ctx.fillStyle = getColor(0.6 * (1 - progress))
          ctx.beginPath()
          ctx.arc(fx, fy, 3 + normEnergy * 4, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // ===== ERROR STATE INDICATOR =====
      if (state === 'error') {
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)'
        ctx.lineWidth = 3
        const errorPulse = Math.sin(time * 0.1) * 0.1
        ctx.setLineDash([10, 5])
        ctx.beginPath()
        ctx.arc(cx, cy, Math.max(0, maxRadius * (0.9 + errorPulse)), 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, stateConfig, dimensions, getAudioAverage, getColor])

  return (
    <div
      ref={containerRef}
      className="core-visualizer"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        gap: '8px'
      }}
    >
      <canvas
        ref={canvasRef}
        className="core-canvas"
        style={{ display: 'block' }}
      />
      {datapoints > 0 && (
        <div
          className={`core-datapoints ${isAnimating ? 'core-datapoints--pulse' : ''}`}
          style={{
            fontSize: '10px',
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 500,
            letterSpacing: '0.1em',
            color: 'rgba(255, 255, 255, 0.4)',
            textTransform: 'uppercase',
            transition: 'color 0.3s ease, transform 0.3s ease',
            transform: isAnimating ? 'scale(1.05)' : 'scale(1)'
          }}
        >
          <span style={{ color: 'rgba(255, 255, 255, 0.25)' }}>Datapoints</span>{' '}
          <span style={{
            color: isAnimating ? 'rgba(56, 189, 248, 0.8)' : 'rgba(167, 139, 250, 0.6)',
            fontWeight: 600,
            transition: 'color 0.3s ease'
          }}>
            {displayCount.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  )
}

// Metadata for the visualizer registry
CoreVisualizer.displayName = 'Core'
CoreVisualizer.description = 'CORE system visualization - 5 layers and 10 cognitive implants'
CoreVisualizer.features = ['orbital rings', 'implant nodes', 'data flow', 'audio reactive']

export default CoreVisualizer
