import { useRef, useEffect, useCallback, useMemo } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * HoloFieldVisualizer - Holographic expanding MFCC rings
 * Ported from holo-field.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Updated 2026-01-21: Converted from window resize to ResizeObserver
 */
function HoloFieldVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const historyRef = useRef([])
  const angleRef = useRef(0)
  const dimensionsRef = useRef({ width: 0, height: 0 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config
  const maxHistory = config?.maxHistory ?? 100

  // State-based colors (uses per-state hue)
  const getColor = useCallback((alpha = 1) => {
    const h = stateConfig.hue
    return `hsla(${h}, 80%, 60%, ${alpha})`
  }, [stateConfig.hue])

  // Extract MFCC-like features from audio data
  const extractMFCC = useCallback(() => {
    if (!audioData || audioData.length === 0) {
      return new Array(13).fill(0)
    }

    // Simulate MFCC by analyzing frequency bands
    // Real MFCC would require FFT, but we approximate with band analysis
    const mfcc = []
    const bandSize = Math.floor(audioData.length / 13)

    for (let i = 0; i < 13; i++) {
      let bandEnergy = 0
      const startIdx = i * bandSize
      const endIdx = Math.min(startIdx + bandSize, audioData.length)

      for (let j = startIdx; j < endIdx; j++) {
        bandEnergy += Math.abs(audioData[j] - 128)
      }

      // Normalize and apply sensitivity (per-state)
      mfcc.push((bandEnergy / bandSize) * stateConfig.sensitivity * 0.5)
    }

    return mfcc
  }, [audioData, stateConfig.sensitivity])

  // Calculate RMS energy
  const getRMSEnergy = useCallback(() => {
    if (!audioData || audioData.length === 0) return 0

    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      const normalized = (audioData[i] - 128) / 128
      sum += normalized * normalized
    }

    return Math.sqrt(sum / audioData.length) * stateConfig.sensitivity
  }, [audioData, stateConfig.sensitivity])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const parent = canvas.parentElement
    if (!parent) return

    // Handle resize using ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          canvas.width = width
          canvas.height = height
          dimensionsRef.current = { width, height }
        }
      }
    })

    resizeObserver.observe(parent)

    // Initial size setup
    const { clientWidth, clientHeight } = parent
    if (clientWidth > 0 && clientHeight > 0) {
      canvas.width = clientWidth
      canvas.height = clientHeight
      dimensionsRef.current = { width: clientWidth, height: clientHeight }
    }

    const draw = () => {
      const { width, height } = dimensionsRef.current
      if (width === 0 || height === 0) {
        animationRef.current = requestAnimationFrame(draw)
        return
      }

      // Update rotation (per-state speed)
      angleRef.current += 0.005 * (1 + stateConfig.speed)

      // Update history with current features
      const mfcc = extractMFCC()
      const energy = getRMSEnergy()
      const isSpeech = state === 'speaking' || state === 'listening'

      historyRef.current.unshift({
        mfcc,
        energy,
        isSpeech
      })

      if (historyRef.current.length > maxHistory) {
        historyRef.current.pop()
      }

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      const cx = width / 2
      const cy = height / 2

      ctx.lineWidth = 2 * stateConfig.scale

      // State-based modifiers (uses per-state scale)
      let radiusBase = 50 * stateConfig.scale
      let expansionRate = 5 * stateConfig.scale
      let twistFactor = 0.02

      if (state === 'listening') {
        radiusBase = 60 * stateConfig.scale
        expansionRate = 8 * stateConfig.scale // Wider tunnel
      } else if (state === 'thinking') {
        twistFactor = 0.1 // High twist
        radiusBase = 40 * stateConfig.scale // Tighter core
      } else if (state === 'speaking') {
        expansionRate = 12 * stateConfig.scale // Explosive projection
      }

      // Draw cylindrical projection
      for (let i = 0; i < historyRef.current.length; i++) {
        const row = historyRef.current[i]
        const ageInfo = 1 - (i / maxHistory) // 1.0 = new, 0.0 = old

        const radius = radiusBase + (i * expansionRate)
        const alpha = ageInfo

        const color = getColor(alpha * (row.energy * 2 + 0.2)) // +0.2 for base visibility
        ctx.strokeStyle = color

        // Glow effect for speech
        if (row.isSpeech) {
          ctx.shadowBlur = 15 * stateConfig.scale
          ctx.shadowColor = color
        } else {
          if (state === 'thinking') {
            ctx.shadowBlur = 5 * stateConfig.scale
            ctx.shadowColor = getColor(0.5)
          } else {
            ctx.shadowBlur = 0
          }
        }

        ctx.beginPath()

        const points = row.mfcc.length
        const angleStep = (Math.PI * 2) / (points * 2)

        for (let j = 0; j < points * 2; j++) {
          const valIndex = j % points
          let val = row.mfcc[valIndex]

          // Normalize MFCC magnitude (per-state scale)
          let mag = Math.abs(val) * (2 * stateConfig.scale)

          // State modulation on magnitude
          if (state === 'idle') mag *= 0.5
          if (state === 'listening') mag *= 0.8
          if (state === 'speaking') mag *= 1.5

          const curAngle = (j * angleStep) + angleRef.current + (i * twistFactor)
          const r = radius + mag

          const x = cx + Math.cos(curAngle) * r
          const y = cy + Math.sin(curAngle) * r

          if (j === 0) {
            ctx.moveTo(x, y)
          } else {
            ctx.lineTo(x, y)
          }
        }

        ctx.closePath()
        ctx.stroke()
      }

      // Reset shadow
      ctx.shadowBlur = 0

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      resizeObserver.disconnect()
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, extractMFCC, getRMSEnergy, getColor, maxHistory, stateConfig])

  return (
    <div className="holo-field-visualizer" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          background: '#000'
        }}
      />
    </div>
  )
}

export default HoloFieldVisualizer
