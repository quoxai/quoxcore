import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { getAudioAverage, getStateConfig } from '../core/BaseVisualizer'

/**
 * Ripple concentric rings visualizer
 * Ported from ai-visualizer/js/visualizers/ripple.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 */
function RippleVisualizer({ state = 'idle', audioData = null, config = {} }) {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  // Animation state
  const timeRef = useRef(0)

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])
  const rings = 10 // Number of concentric rings

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const { width, height } = dimensions

    ctx.clearRect(0, 0, width, height)

    // Use per-state config values
    const S = stateConfig.scale
    const cx = width / 2
    const cy = height / 2

    // Update time (per-state speed)
    timeRef.current += 0.01 * (1 + stateConfig.speed)

    // Get hue for current state (per-state)
    const hue = stateConfig.hue

    // Calculate audio energy (per-state sensitivity)
    const energy = audioData ? getAudioAverage(audioData) / 255 : 0
    const effectiveEnergy = energy * (stateConfig.sensitivity * 5)

    // Set line width
    ctx.lineWidth = 2 * S

    // Maximum radius
    const maxRadius = Math.min(width, height) * 0.4 * S

    // Draw rings
    for (let i = 0; i < rings; i++) {
      const baseR = (i / rings) * maxRadius

      // Wave motion offset
      const offset = (timeRef.current * 2) + i
      const wave = Math.sin(offset) * 10 * S

      let r = baseR + wave

      // Audio reactivity during speaking
      if (state === 'speaking') {
        r += effectiveEnergy * 50 * S * (1 - i / rings) // Inner rings react more
      }

      // Ensure radius is positive
      r = Math.max(0, r)

      // Opacity decreases for outer rings
      const opacity = 1 - (i / rings)

      // Draw ring
      ctx.beginPath()
      ctx.strokeStyle = `hsla(${hue}, 100%, 50%, ${opacity})`
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()

      // Add rotating dots during thinking state
      if (state === 'thinking' && r > 0) {
        const dotAngle = timeRef.current * (i % 2 === 0 ? 1 : -1) + i
        const dotX = cx + Math.cos(dotAngle) * r
        const dotY = cy + Math.sin(dotAngle) * r

        ctx.fillStyle = `hsla(${hue}, 100%, 50%, 1)`
        ctx.beginPath()
        ctx.arc(dotX, dotY, 4 * S, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Draw center dot
    ctx.beginPath()
    ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.8)`
    ctx.arc(cx, cy, 6 * S, 0, Math.PI * 2)
    ctx.fill()

    // Draw state indicator
    ctx.font = '12px monospace'
    ctx.fillStyle = `hsla(${hue}, 100%, 50%, 0.8)`
    ctx.textAlign = 'center'
    ctx.fillText(state.toUpperCase(), cx, height - 20)

    animationRef.current = requestAnimationFrame(draw)
  }, [state, audioData, dimensions, stateConfig, rings])

  // Handle resize
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setDimensions({ width, height })
        }
      }
    })

    resizeObserver.observe(canvas.parentElement)

    return () => resizeObserver.disconnect()
  }, [])

  // Update canvas dimensions
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = dimensions.width
      canvas.height = dimensions.height
    }
  }, [dimensions])

  // Animation loop
  useEffect(() => {
    animationRef.current = requestAnimationFrame(draw)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [draw])

  return (
    <div className="ripple-visualizer" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="ripple-canvas"
        style={{
          width: '100%',
          height: '100%',
          display: 'block'
        }}
      />
    </div>
  )
}

export default RippleVisualizer
