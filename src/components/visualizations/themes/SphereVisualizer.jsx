import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * SphereVisualizer - Glowing 3D sphere with liquid-like deformation
 * Ported from ai-visualizer/js/visualizers/sphere.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Uses ResizeObserver for responsive sizing
 */
function SphereVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const timeRef = useRef(0)
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config
  const points = config?.points ?? 100

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

  // Helper to get current color based on state (uses per-state hue)
  const getPrimaryColor = useCallback((alpha = 1) => {
    const hue = stateConfig.hue
    return `hsla(${hue}, 100%, 50%, ${alpha})`
  }, [stateConfig.hue])

  // Helper to get audio average
  const getAudioAverage = useCallback(() => {
    if (!audioData || !audioData.length) return 0
    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i]
    }
    return sum / audioData.length
  }, [audioData])

  // Update canvas size when dimensions change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const { width, height } = dimensions

    const draw = () => {
      // Update time (per-state speed)
      timeRef.current += 0.02 * (1 + stateConfig.speed)

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      // Use per-state config values
      const S = stateConfig.scale
      const cx = width / 2
      const cy = height / 2

      const color = getPrimaryColor(1)
      const fill = getPrimaryColor(0.2)

      const energy = getAudioAverage() / 255
      const normEnergy = energy * stateConfig.sensitivity

      const baseRadius = 150 * S

      ctx.beginPath()

      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2

        // Noise / Wave calculation
        // We use simple sine composition to simulate noise/liquid
        let noise = Math.sin((angle * 5) + timeRef.current)
        noise += Math.cos((angle * 3) - timeRef.current * 2) * 0.5
        noise += Math.sin((angle * 10) + timeRef.current * 3) * 0.2

        // Audio impact on deformation
        let deformation = noise * (20 + (normEnergy * 100))

        // Thinking state adds spikes
        if (state === 'thinking') {
          deformation += Math.random() * 20
        }

        const r = baseRadius + deformation

        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r

        if (i === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      }

      ctx.closePath()

      // Fill
      ctx.fillStyle = fill
      ctx.fill()

      // Glow/Stroke
      ctx.shadowBlur = 20 * S
      ctx.shadowColor = color
      ctx.strokeStyle = color
      ctx.lineWidth = 3 * S
      ctx.stroke()
      ctx.shadowBlur = 0

      // Core
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0, baseRadius * 0.5), 0, Math.PI * 2)
      ctx.fillStyle = getPrimaryColor(0.8)
      ctx.fill()

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, stateConfig, dimensions, points, getPrimaryColor, getAudioAverage])

  return (
    <div
      ref={containerRef}
      className="sphere-visualizer"
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <canvas
        ref={canvasRef}
        className="sphere-canvas"
        style={{ display: 'block' }}
      />
    </div>
  )
}

export default SphereVisualizer
