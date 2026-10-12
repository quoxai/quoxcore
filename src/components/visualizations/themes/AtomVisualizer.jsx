import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * AtomVisualizer - Orbiting electrons around a glowing nucleus
 * Ported from ai-visualizer/js/visualizers/atom.js
 *
 * Now uses per-state config: each state can have different speed, scale, sensitivity, hue
 * Uses ResizeObserver for responsive sizing
 */
function AtomVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const electronsRef = useRef([])
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

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

  // Initialize electrons on mount
  useEffect(() => {
    const count = 3 // Number of orbits
    electronsRef.current = []
    for (let i = 0; i < count; i++) {
      electronsRef.current.push({
        angle: Math.random() * Math.PI * 2,
        speed: 0.05 + (Math.random() * 0.02),
        radiusX: 100 + (Math.random() * 50),
        radiusY: 40 + (Math.random() * 20),
        tilt: Math.random() * Math.PI, // 3D Tilt
        colorOffset: Math.random() * 20
      })
    }
  }, [])

  // Helper to get current color based on state (now uses per-state hue)
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

      // Update electrons with per-state speed and sensitivity
      const energy = getAudioAverage() / 255
      const normEnergy = energy * stateConfig.sensitivity

      electronsRef.current.forEach(e => {
        let s = e.speed * (1 + stateConfig.speed) * (1 + (normEnergy * 4))
        e.angle += s
      })

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      const color = getPrimaryColor(1)

      // Nucleus - uses per-state sensitivity
      const effectiveEnergy = energy * (stateConfig.sensitivity * 3)
      let nucleusSize = (20 * S) + (effectiveEnergy * 30 * S)

      ctx.shadowBlur = 30 * S
      ctx.shadowColor = color
      ctx.fillStyle = color

      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0, nucleusSize), 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0

      // Orbits
      ctx.lineWidth = 2 * S
      electronsRef.current.forEach(e => {
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(e.tilt)

        // Draw Orbit Path (faint)
        ctx.strokeStyle = getPrimaryColor(0.1)
        ctx.beginPath()
        ctx.ellipse(0, 0, e.radiusX * S, e.radiusY * S, 0, 0, Math.PI * 2)
        ctx.stroke()

        // Draw Electron
        const x = Math.cos(e.angle) * e.radiusX * S
        const y = Math.sin(e.angle) * e.radiusY * S

        ctx.fillStyle = '#ffffff'
        ctx.shadowBlur = 10 * S
        ctx.shadowColor = color

        ctx.beginPath()
        ctx.arc(x, y, 4 * S, 0, Math.PI * 2)
        ctx.fill()

        ctx.restore()
      })

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, stateConfig, dimensions, getPrimaryColor, getAudioAverage])

  return (
    <div
      ref={containerRef}
      className="atom-visualizer"
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <canvas
        ref={canvasRef}
        className="atom-canvas"
        style={{ display: 'block' }}
      />
    </div>
  )
}

export default AtomVisualizer
