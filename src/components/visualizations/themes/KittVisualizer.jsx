import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { getAudioAverage, getStateConfig } from '../core/BaseVisualizer'

/**
 * KITT-style scanner bar visualizer
 * Ported from ai-visualizer/js/visualizers/kitt.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 */
function KittVisualizer({ state = 'idle', audioData = null, config = {} }) {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 400, height: 200 })

  // Animation state refs
  const scannerPosRef = useRef(0.5)
  const scannerDirRef = useRef(1)

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])
  const bars = 20 // Number of LED segments

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

    // Get hue for current state (per-state)
    const hue = stateConfig.hue

    // Update scanner position (per-state speed)
    const speed = 0.01 + (stateConfig.speed * 0.04)
    scannerPosRef.current += speed * scannerDirRef.current

    if (scannerPosRef.current > 1 || scannerPosRef.current < 0) {
      scannerDirRef.current *= -1
      scannerPosRef.current = Math.max(0, Math.min(1, scannerPosRef.current))
    }

    // Calculate bar dimensions
    const barWidth = Math.min(width * 0.8, 600 * S)
    const barHeight = 40 * S
    const startX = cx - barWidth / 2
    const startY = cy - barHeight / 2

    // Background container
    ctx.fillStyle = '#110000'
    ctx.fillRect(startX - 10 * S, startY - 10 * S, barWidth + 20 * S, barHeight + 20 * S)

    // Draw segments
    const segmentWidth = barWidth / bars

    for (let i = 0; i < bars; i++) {
      const segX = startX + (i * segmentWidth)
      const segCenter = i / (bars - 1) // 0 to 1

      // Distance from scanner head
      const dist = Math.abs(segCenter - scannerPosRef.current)

      // Tail effect with sharp falloff
      let alpha = Math.max(0.1, 1 - (dist * 4))

      // Audio reactivity when speaking
      if (state === 'speaking' && audioData) {
        const energy = getAudioAverage(audioData) / 255
        alpha += energy * 0.5
      }

      alpha = Math.min(1, alpha)

      // Draw segment with small gap
      ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${alpha})`
      ctx.fillRect(segX + 2 * S, startY, segmentWidth - 4 * S, barHeight)

      // Add glow effect for bright segments
      if (alpha > 0.5) {
        ctx.save()
        ctx.shadowBlur = 20 * S
        ctx.shadowColor = `hsla(${hue}, 100%, 50%, 1)`
        ctx.fillRect(segX + 2 * S, startY, segmentWidth - 4 * S, barHeight)
        ctx.restore()
      }
    }

    // Draw state indicator
    ctx.font = '12px monospace'
    ctx.fillStyle = `hsla(${hue}, 100%, 50%, 0.8)`
    ctx.textAlign = 'center'
    ctx.fillText(state.toUpperCase(), cx, height - 20)

    animationRef.current = requestAnimationFrame(draw)
  }, [state, audioData, dimensions, stateConfig, bars])

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
    <div className="kitt-visualizer" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="kitt-canvas"
        style={{
          width: '100%',
          height: '100%',
          display: 'block'
        }}
      />
    </div>
  )
}

export default KittVisualizer
