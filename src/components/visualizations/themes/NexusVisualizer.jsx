import { useRef, useEffect, useCallback, useMemo } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * NexusVisualizer - Connected particle network
 * Ported from particulate.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Updated 2026-01-21: Converted from window resize to ResizeObserver
 */
function NexusVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const particlesRef = useRef([])
  const angleRef = useRef(0)
  const dimensionsRef = useRef({ width: 0, height: 0 })
  const mouseRef = useRef({ x: null, y: null, active: false })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config
  const particleCount = config?.particleCount ?? 60
  const connectionDistance = config?.connectionDistance ?? 150

  // Initialize particles in 3D space
  const initParticles = useCallback(() => {
    const particles = []
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: (Math.random() - 0.5) * 400,
        y: (Math.random() - 0.5) * 400,
        z: (Math.random() - 0.5) * 400,
        baseSize: Math.random() * 2 + 1,
        velocity: Math.random() * 0.02 + 0.01,
        offset: Math.random() * Math.PI * 2
      })
    }
    return particles
  }, [particleCount])

  // Get audio energy level (uses per-state sensitivity)
  const getAudioEnergy = useCallback(() => {
    if (!audioData || audioData.length === 0) return 0

    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i]
    }
    return (sum / audioData.length / 255) * stateConfig.sensitivity * 3
  }, [audioData, stateConfig.sensitivity])

  // Project 3D point to 2D with rotation
  const project3D = useCallback((p, angle, cx, cy, focalLength = 500) => {
    // Rotate around Y axis
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)

    const rotatedX = p.x * cosA - p.z * sinA
    const rotatedZ = p.x * sinA + p.z * cosA

    // Simple perspective projection
    const perspective = focalLength / (focalLength + rotatedZ)

    return {
      x: cx + rotatedX * perspective,
      y: cy + p.y * perspective,
      z: rotatedZ,
      scale: perspective
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const parent = canvas.parentElement
    if (!parent) return

    // Initialize particles
    if (particlesRef.current.length === 0) {
      particlesRef.current = initParticles()
    }

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

    // Mouse/touch handlers
    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect()
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        active: true
      }
    }

    const handleMouseLeave = () => {
      mouseRef.current.active = false
    }

    const handleTouchMove = (e) => {
      if (e.touches.length > 0) {
        const rect = canvas.getBoundingClientRect()
        mouseRef.current = {
          x: e.touches[0].clientX - rect.left,
          y: e.touches[0].clientY - rect.top,
          active: true
        }
      }
    }

    const handleTouchEnd = () => {
      mouseRef.current.active = false
    }

    canvas.addEventListener('mousemove', handleMouseMove)
    canvas.addEventListener('mouseleave', handleMouseLeave)
    canvas.addEventListener('touchmove', handleTouchMove)
    canvas.addEventListener('touchend', handleTouchEnd)

    const draw = () => {
      const { width, height } = dimensionsRef.current
      if (width === 0 || height === 0) {
        animationRef.current = requestAnimationFrame(draw)
        return
      }

      const cx = width / 2
      const cy = height / 2

      // Get audio energy
      const energy = getAudioEnergy()

      // State behavior (uses per-state speed)
      let radiusExpansion = 0
      let shake = 0
      const speedMultiplier = 1 + (stateConfig.speed * 2)

      if (state === 'listening') {
        radiusExpansion = 50 * energy
      } else if (state === 'speaking') {
        radiusExpansion = 150 * energy
        shake = energy * 5
      } else if (state === 'thinking') {
        angleRef.current += 0.05 // Spin faster
        shake = 2
      }

      // Base rotation
      angleRef.current += 0.005 * speedMultiplier

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      // Colors (uses per-state hue)
      const hue = stateConfig.hue
      const color = `hsla(${hue}, 80%, 60%, 1)`
      const faintColor = `hsla(${hue}, 80%, 60%, 0.15)`

      ctx.lineWidth = 1

      // Project all particles to 2D
      const projected = particlesRef.current.map((p, idx) => {
        // Apply shake
        const shakeX = shake ? (Math.random() - 0.5) * shake : 0
        const shakeY = shake ? (Math.random() - 0.5) * shake : 0

        // Apply radius expansion based on audio
        const expansionFactor = 1 + radiusExpansion / 400
        const expandedP = {
          x: p.x * expansionFactor + shakeX,
          y: p.y * expansionFactor + shakeY,
          z: p.z * expansionFactor
        }

        const proj = project3D(expandedP, angleRef.current, cx, cy)

        // Mouse interaction - attract particles toward mouse
        if (mouseRef.current.active) {
          const dx = mouseRef.current.x - proj.x
          const dy = mouseRef.current.y - proj.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 150 && dist > 0) {
            const force = (150 - dist) / 150 * 0.1
            proj.x += dx * force
            proj.y += dy * force
          }
        }

        return {
          ...proj,
          index: idx,
          baseSize: p.baseSize
        }
      })

      // Sort by z for proper depth rendering
      projected.sort((a, b) => a.z - b.z)

      // Draw connections
      ctx.strokeStyle = faintColor
      ctx.beginPath()

      for (let i = 0; i < projected.length; i++) {
        for (let j = i + 1; j < projected.length; j++) {
          const p1 = projected[i]
          const p2 = projected[j]
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < connectionDistance * stateConfig.scale) {
            // Alpha based on distance
            const alpha = (1 - dist / (connectionDistance * stateConfig.scale)) * 0.3
            ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
            ctx.stroke()
          }
        }
      }

      // Draw nodes (uses per-state scale)
      projected.forEach(p => {
        const size = p.baseSize * p.scale * stateConfig.scale * (1 + energy * 0.5)

        // Depth-based alpha
        const depthAlpha = 0.3 + (p.scale * 0.7)

        ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${depthAlpha})`

        // Glow effect
        ctx.shadowBlur = 10 * stateConfig.scale
        ctx.shadowColor = color

        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0, size), 0, Math.PI * 2)
        ctx.fill()
      })

      ctx.shadowBlur = 0

      // Draw center rings (JARVIS style)
      const effectiveEnergy = energy

      // Outer ring
      ctx.beginPath()
      ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.3)`
      ctx.lineWidth = 2 * stateConfig.scale
      const ringRadius = (150 + effectiveEnergy * 50) * stateConfig.scale
      ctx.arc(cx, cy, Math.max(0, ringRadius), 0, Math.PI * 2)
      ctx.stroke()

      // Inner ring
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(0, ringRadius * 0.7), 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.1)`
      ctx.stroke()

      // Pulsing core ring when active
      if (state !== 'idle') {
        ctx.beginPath()
        const coreRadius = 30 + Math.sin(angleRef.current * 10) * 10
        ctx.arc(cx, cy, Math.max(0, coreRadius * stateConfig.scale), 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${hue}, 80%, 70%, ${0.3 + effectiveEnergy * 0.3})`
        ctx.lineWidth = 3 * stateConfig.scale
        ctx.stroke()
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('mousemove', handleMouseMove)
      canvas.removeEventListener('mouseleave', handleMouseLeave)
      canvas.removeEventListener('touchmove', handleTouchMove)
      canvas.removeEventListener('touchend', handleTouchEnd)
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, getAudioEnergy, project3D, initParticles, stateConfig, connectionDistance])

  return (
    <div className="nexus-visualizer" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          background: '#000',
          cursor: 'crosshair'
        }}
      />
    </div>
  )
}

export default NexusVisualizer
