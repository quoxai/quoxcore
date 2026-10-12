import { useRef, useEffect, useState, useMemo } from 'react'
import { getStateConfig } from '../visualizations/core/BaseVisualizer'

/**
 * Convert HSL hue to color objects for state rendering
 * @param {number} hue - Hue value 0-360
 * @returns {object} Color object with primary, secondary, glow
 */
function hueToStateColors(hue) {
  const h = hue % 360
  return {
    primary: `hsl(${h}, 100%, 50%)`,
    secondary: `hsl(${h}, 100%, 65%)`,
    glow: `hsla(${h}, 100%, 50%, 0.4)`
  }
}

/**
 * Default colors for each state (used when no config provided)
 */
const DEFAULT_STATE_COLORS = {
  idle: { primary: '#38bdf8', secondary: '#60d0ff', glow: 'rgba(56, 189, 248, 0.4)', hue: 195 },
  listening: { primary: '#3090ff', secondary: '#60a0ff', glow: 'rgba(48, 144, 255, 0.4)', hue: 210 },
  thinking: { primary: '#ff9030', secondary: '#ffb060', glow: 'rgba(255, 144, 48, 0.4)', hue: 30 },
  speaking: { primary: '#30ff90', secondary: '#60ffb0', glow: 'rgba(48, 255, 144, 0.4)', hue: 145 },
  error: { primary: '#f87171', secondary: '#ff6060', glow: 'rgba(248, 113, 113, 0.6)', hue: 0 }
}

/**
 * HAL-9000 style eye visualizer with audio reactivity
 * Now accepts config prop for per-state customization
 */
function HALVisualizer({ state = 'idle', audioData = null, config = {} }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  // Handle resize - adapt to container size like premium visualizers
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

  // Get per-state config values (speed, scale, sensitivity, hue)
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Get colors for current state - use config hue if available, otherwise defaults
  const stateColors = useMemo(() => {
    // Build color map for all states based on config
    const colors = {}
    const states = ['idle', 'listening', 'thinking', 'speaking', 'error']

    for (const s of states) {
      const sConfig = getStateConfig(config, s)
      if (sConfig.hue !== undefined && sConfig.hue !== null) {
        colors[s] = hueToStateColors(sConfig.hue)
      } else {
        colors[s] = DEFAULT_STATE_COLORS[s]
      }
    }

    return colors
  }, [config])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const centerX = dimensions.width / 2
    const centerY = dimensions.height / 2
    // Apply scale from config
    const scaleFactor = stateConfig.scale || 1.0
    const baseRadius = Math.min(dimensions.width, dimensions.height) * 0.35 * scaleFactor

    let frame = 0
    let pulsePhase = 0

    const draw = () => {
      ctx.clearRect(0, 0, dimensions.width, dimensions.height)

      const colors = stateColors[state] || stateColors.idle

      // Calculate pulse based on audio or default animation
      // Apply sensitivity from config
      const sensitivity = stateConfig.sensitivity || 0.5
      let intensity = 0.5
      if (audioData && audioData.length > 0) {
        // Use audio data for intensity (scaled by sensitivity)
        const avg = audioData.reduce((a, b) => a + b, 0) / audioData.length
        intensity = Math.min(1, (avg / 128) * (sensitivity * 2))
      } else {
        // Default pulsing animation
        intensity = 0.5 + Math.sin(pulsePhase) * 0.2
      }

      const pulseRadius = baseRadius * (0.9 + intensity * 0.2)

      // Outer glow
      const glowGradient = ctx.createRadialGradient(
        centerX, centerY, pulseRadius * 0.5,
        centerX, centerY, pulseRadius * 2
      )
      glowGradient.addColorStop(0, colors.glow)
      glowGradient.addColorStop(1, 'transparent')
      ctx.fillStyle = glowGradient
      ctx.fillRect(0, 0, dimensions.width, dimensions.height)

      // Outer ring
      ctx.beginPath()
      ctx.arc(centerX, centerY, pulseRadius, 0, Math.PI * 2)
      ctx.strokeStyle = colors.secondary
      ctx.lineWidth = 3
      ctx.stroke()

      // Inner gradient eye
      const eyeGradient = ctx.createRadialGradient(
        centerX - pulseRadius * 0.2, centerY - pulseRadius * 0.2, 0,
        centerX, centerY, pulseRadius
      )
      eyeGradient.addColorStop(0, colors.secondary)
      eyeGradient.addColorStop(0.5, colors.primary)
      eyeGradient.addColorStop(1, '#0a1628')

      ctx.beginPath()
      ctx.arc(centerX, centerY, pulseRadius * 0.9, 0, Math.PI * 2)
      ctx.fillStyle = eyeGradient
      ctx.fill()

      // Pupil (darker center)
      const pupilGradient = ctx.createRadialGradient(
        centerX, centerY, 0,
        centerX, centerY, pulseRadius * 0.4
      )
      pupilGradient.addColorStop(0, '#000000')
      pupilGradient.addColorStop(0.7, '#050d18')
      pupilGradient.addColorStop(1, 'transparent')

      ctx.beginPath()
      ctx.arc(centerX, centerY, pulseRadius * 0.4, 0, Math.PI * 2)
      ctx.fillStyle = pupilGradient
      ctx.fill()

      // Highlight reflection
      ctx.beginPath()
      ctx.arc(
        centerX - pulseRadius * 0.25,
        centerY - pulseRadius * 0.25,
        pulseRadius * 0.15,
        0, Math.PI * 2
      )
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx.fill()

      // Audio reactive rings (when speaking or listening)
      if ((state === 'speaking' || state === 'listening') && audioData) {
        const rings = 3
        for (let i = 0; i < rings; i++) {
          const ringRadius = pulseRadius * (1.2 + i * 0.15)
          const alpha = (1 - i / rings) * intensity * 0.5
          ctx.beginPath()
          ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2)
          // Handle both hsl() and hex color formats for alpha injection
          let strokeColor = colors.primary
          if (strokeColor.startsWith('hsl(')) {
            strokeColor = strokeColor.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`)
          } else if (strokeColor.startsWith('#')) {
            // Convert hex to rgba
            const r = parseInt(strokeColor.slice(1, 3), 16)
            const g = parseInt(strokeColor.slice(3, 5), 16)
            const b = parseInt(strokeColor.slice(5, 7), 16)
            strokeColor = `rgba(${r}, ${g}, ${b}, ${alpha})`
          } else {
            strokeColor = strokeColor.replace(')', `, ${alpha})`).replace('rgb', 'rgba')
          }
          ctx.strokeStyle = strokeColor
          ctx.lineWidth = 2 - i * 0.5
          ctx.stroke()
        }
      }

      // State indicator text
      ctx.font = '12px monospace'
      ctx.fillStyle = colors.primary
      ctx.textAlign = 'center'
      ctx.fillText(state.toUpperCase(), centerX, dimensions.height - 20)

      frame++
      // Apply speed from config (higher speed = faster pulse)
      const speed = stateConfig.speed || 0.5
      const baseSpeed = state === 'thinking' ? 0.15 : 0.03
      pulsePhase += baseSpeed * (1 + speed)
      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, dimensions, stateColors, stateConfig])

  return (
    <div
      ref={containerRef}
      className="hal-visualizer"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent'
      }}
    >
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="hal-canvas"
        style={{ display: 'block' }}
      />
    </div>
  )
}

export default HALVisualizer
