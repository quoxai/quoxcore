import { useRef, useEffect, useCallback, useMemo } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * FluidVisualizer - Flowing particle system with physics
 * Ported from neuro-fluid.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Updated 2026-01-21: Converted from window resize to ResizeObserver
 */
function FluidVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const particlesRef = useRef([])
  const lastTimeRef = useRef(Date.now())
  const dimensionsRef = useRef({ width: 0, height: 0 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config
  const numParticles = config?.numParticles ?? 200

  // State-based colors (uses per-state hue)
  const getColor = useCallback((alpha = 1) => {
    const h = stateConfig.hue
    return `hsla(${h}, 80%, 60%, ${alpha})`
  }, [stateConfig.hue])

  // Initialize particles
  const initParticles = useCallback((width, height) => {
    const particles = []
    for (let i = 0; i < numParticles; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: 0,
        vy: 0,
        size: Math.random() * 3 + 1,
        life: Math.random()
      })
    }
    return particles
  }, [numParticles])

  // Extract audio features (uses per-state sensitivity)
  const getAudioFeatures = useCallback(() => {
    if (!audioData || audioData.length === 0) {
      return { zcr: 0, energy: 0 }
    }

    // Calculate zero-crossing rate approximation and energy
    let zcr = 0
    let energy = 0
    const len = audioData.length

    for (let i = 1; i < len; i++) {
      if ((audioData[i] >= 128) !== (audioData[i - 1] >= 128)) {
        zcr++
      }
      energy += Math.abs(audioData[i] - 128)
    }

    zcr = zcr / len
    energy = (energy / len) / 128 * stateConfig.sensitivity

    return { zcr, energy }
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

          // Reinitialize particles if dimensions changed significantly
          if (particlesRef.current.length === 0) {
            particlesRef.current = initParticles(width, height)
          }
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
      if (particlesRef.current.length === 0) {
        particlesRef.current = initParticles(clientWidth, clientHeight)
      }
    }

    const draw = () => {
      const now = Date.now()
      const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1) // Cap dt for stability
      lastTimeRef.current = now

      const { width, height } = dimensionsRef.current
      if (width === 0 || height === 0) {
        animationRef.current = requestAnimationFrame(draw)
        return
      }

      const features = getAudioFeatures()
      const time = now * 0.001 * (1 + stateConfig.speed)

      // State-based physics parameters
      let turbulence = features.zcr * 50
      let baseSpeed = 2
      let attractionStrength = 0

      if (state === 'idle') {
        baseSpeed = 1
        turbulence *= 0.5
      } else if (state === 'listening') {
        baseSpeed = 3
        attractionStrength = 0.05 // Gentle pull to center
      } else if (state === 'thinking') {
        baseSpeed = 4
        turbulence *= 2 // Chaotic movement
        attractionStrength = 0.2 // Strong pull (vortex effect)
      } else if (state === 'speaking') {
        baseSpeed = 6
        attractionStrength = -0.1 // Push outward (expressive)
      }

      const cx = width / 2
      const cy = height / 2

      // Update particles
      particlesRef.current.forEach(p => {
        // Simple Perlin-ish noise for flow field
        const angle = (Math.sin(p.x * 0.01 + time) + Math.cos(p.y * 0.01 + time)) * Math.PI

        const effectiveSpeed = (baseSpeed + turbulence) * (dt * 60)

        p.vx += Math.cos(angle) * 0.1
        p.vy += Math.sin(angle) * 0.1

        // Attraction/Repulsion from center
        if (attractionStrength !== 0) {
          const dx = cx - p.x
          const dy = cy - p.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > 0) {
            p.vx += (dx / dist) * attractionStrength
            p.vy += (dy / dist) * attractionStrength
          }
        }

        // Apply drag
        p.vx *= 0.95
        p.vy *= 0.95

        // Move particle
        p.x += p.vx * effectiveSpeed
        p.y += p.vy * effectiveSpeed

        // Wrap around edges
        if (p.x < 0) p.x = width
        if (p.x > width) p.x = 0
        if (p.y < 0) p.y = height
        if (p.y > height) p.y = 0

        // Life cycle
        p.life -= dt
        if (p.life <= 0) p.life = 1
      })

      // Draw with trail effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)'
      ctx.fillRect(0, 0, width, height)

      const color = getColor(1)
      ctx.fillStyle = color

      particlesRef.current.forEach(p => {
        let size = p.size * stateConfig.scale

        // State-based size modulation
        if (state === 'speaking') size *= 2
        if (state === 'thinking') size *= 0.5 // Fine particles

        // Life-based alpha
        const alpha = Math.min(1, p.life)
        ctx.fillStyle = getColor(alpha)

        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0, size), 0, Math.PI * 2)
        ctx.fill()
      })

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      resizeObserver.disconnect()
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, getAudioFeatures, getColor, initParticles, stateConfig])

  return (
    <div className="fluid-visualizer" style={{ width: '100%', height: '100%' }}>
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

export default FluidVisualizer
