import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * DnaVisualizer - Rotating double helix structure
 * Ported from ai-visualizer/js/visualizers/dna.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Uses ResizeObserver for responsive sizing
 */
function DnaVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const angleRef = useRef(0)
  const [dimensions, setDimensions] = useState({ width: 400, height: 600 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config
  const basePairs = config?.basePairs ?? 40

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setDimensions({ width, height })
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
      // Use per-state config values
      const S = stateConfig.scale
      const cx = width / 2
      const cy = height / 2

      // Update rotation (per-state speed)
      const energy = getAudioAverage() / 255
      let speed = 0.01 + (stateConfig.speed * 0.02)
      angleRef.current += speed + (energy * 0.05)

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      const normEnergy = energy * stateConfig.sensitivity
      const color = getPrimaryColor(1)

      ctx.lineWidth = 2 * S

      // Helix Params
      const helixHeight = 500 * S
      const helixWidth = 120 * S + (normEnergy * 100 * S)
      const spacing = helixHeight / basePairs
      const startY = cy - helixHeight / 2

      for (let i = 0; i < basePairs; i++) {
        const y = startY + (i * spacing)

        // Twist offset
        const offset = (i * 0.2) + angleRef.current

        // 3D projection of two strands
        const x1 = cx + Math.sin(offset) * helixWidth
        const x2 = cx + Math.sin(offset + Math.PI) * helixWidth // Opposite side

        // Depth for scaling/opacity (simple z-sort fake)
        const z1 = Math.cos(offset) // -1 to 1
        const z2 = Math.cos(offset + Math.PI)

        // Draw Connection (Base Pair)
        ctx.strokeStyle = getPrimaryColor(0.2 + (normEnergy * 0.5))
        ctx.beginPath()
        ctx.moveTo(x1, y)
        ctx.lineTo(x2, y)
        ctx.stroke()

        // Draw Strand Points
        // Point 1
        const r1 = (4 * S) + (z1 * 2 * S)
        ctx.fillStyle = color
        ctx.globalAlpha = 0.5 + (z1 * 0.5) // Fades when in back
        ctx.beginPath()
        ctx.arc(x1, y, Math.max(0, r1), 0, Math.PI * 2)
        ctx.fill()

        // Point 2
        const r2 = (4 * S) + (z2 * 2 * S)
        ctx.fillStyle = color
        ctx.globalAlpha = 0.5 + (z2 * 0.5)
        ctx.beginPath()
        ctx.arc(x2, y, Math.max(0, r2), 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalAlpha = 1.0 // Reset

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, stateConfig, dimensions, basePairs, getPrimaryColor, getAudioAverage])

  return (
    <div
      ref={containerRef}
      className="dna-visualizer"
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <canvas
        ref={canvasRef}
        className="dna-canvas"
        style={{ display: 'block' }}
      />
    </div>
  )
}

export default DnaVisualizer
