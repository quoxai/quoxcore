import { useEffect, useMemo, useRef, useState } from 'react'

// Quantum Q — an accretion field around the INVISIBLE Quox sigil.
// The Q icon (public/favicon.svg) is a ring + dark core + center dot. That
// geometry is never drawn — it only exists as an attractor field. Particles
// orbit the ring radius, are repelled from the hollow core disk, and a
// fraction spiral in toward the center dot where they flash-capture and
// slingshot back out. The Q *emerges* from particle density and motion.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function mix(a, b, amount) {
  return a + (b - a) * amount
}

function hsl(h, s, l, alpha = 1) {
  return `hsla(${((h % 360) + 360) % 360} ${s}% ${l}% / ${alpha})`
}

function getAudioEnergy(audioData) {
  if (!audioData?.length) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i += 1) sum += audioData[i]
  return sum / audioData.length / 255
}

function getBasePreset(presetId) {
  if (presetId === 'storm') {
    return {
      global: { backdrop: 0.86, bloom: 1.34 },
      states: {
        idle: { hue: 199, accentHue: 262, energy: 0.32, pulse: 0.2, ringSpeed: 0.12, scannerSpeed: 0.16, barGain: 0.3, orbitCount: 7, jitter: 0.03, particleDensity: 118, gravityStrength: 0.62, captureRate: 0.26 },
        listening: { hue: 199, accentHue: 262, energy: 0.46, pulse: 0.24, ringSpeed: 0.16, scannerSpeed: 0.22, barGain: 0.38, orbitCount: 8, jitter: 0.03, particleDensity: 134, gravityStrength: 0.68, captureRate: 0.32 },
        thinking: { hue: 206, accentHue: 268, energy: 0.78, pulse: 0.32, ringSpeed: 0.22, scannerSpeed: 0.3, barGain: 0.48, orbitCount: 10, jitter: 0.05, particleDensity: 156, gravityStrength: 0.82, captureRate: 0.5 },
        speaking: { hue: 196, accentHue: 258, energy: 1.08, pulse: 0.5, ringSpeed: 0.28, scannerSpeed: 0.26, barGain: 0.68, orbitCount: 10, jitter: 0.05, particleDensity: 168, gravityStrength: 0.76, captureRate: 0.4 },
        error: { hue: 6, accentHue: 258, energy: 1.16, pulse: 0.56, ringSpeed: 0.2, scannerSpeed: 0.44, barGain: 0.6, orbitCount: 8, jitter: 0.32, particleDensity: 150, gravityStrength: 0.58, captureRate: 0.3 }
      }
    }
  }

  if (presetId === 'singularity') {
    return {
      global: { backdrop: 0.97, bloom: 1.5 },
      states: {
        idle: { hue: 202, accentHue: 256, energy: 0.18, pulse: 0.08, ringSpeed: 0.045, scannerSpeed: 0.03, barGain: 0.2, orbitCount: 5, jitter: 0.008, particleDensity: 62, gravityStrength: 1.02, captureRate: 0.52 },
        listening: { hue: 202, accentHue: 256, energy: 0.28, pulse: 0.12, ringSpeed: 0.06, scannerSpeed: 0.05, barGain: 0.28, orbitCount: 6, jitter: 0.01, particleDensity: 72, gravityStrength: 1.1, captureRate: 0.6 },
        thinking: { hue: 208, accentHue: 264, energy: 0.5, pulse: 0.18, ringSpeed: 0.08, scannerSpeed: 0.09, barGain: 0.4, orbitCount: 7, jitter: 0.015, particleDensity: 84, gravityStrength: 1.28, captureRate: 0.82 },
        speaking: { hue: 198, accentHue: 250, energy: 0.86, pulse: 0.3, ringSpeed: 0.1, scannerSpeed: 0.08, barGain: 0.62, orbitCount: 7, jitter: 0.015, particleDensity: 90, gravityStrength: 1.2, captureRate: 0.68 },
        error: { hue: 4, accentHue: 250, energy: 0.94, pulse: 0.36, ringSpeed: 0.07, scannerSpeed: 0.2, barGain: 0.56, orbitCount: 6, jitter: 0.2, particleDensity: 82, gravityStrength: 0.96, captureRate: 0.5 }
      }
    }
  }

  // calm-orbit (default)
  return {
    global: { backdrop: 0.92, bloom: 1.08 },
    states: {
      idle: { hue: 199, accentHue: 258, energy: 0.22, pulse: 0.12, ringSpeed: 0.07, scannerSpeed: 0.05, barGain: 0.18, orbitCount: 6, jitter: 0.01, particleDensity: 72, gravityStrength: 0.56, captureRate: 0.18 },
      listening: { hue: 199, accentHue: 258, energy: 0.34, pulse: 0.16, ringSpeed: 0.1, scannerSpeed: 0.09, barGain: 0.26, orbitCount: 7, jitter: 0.01, particleDensity: 84, gravityStrength: 0.62, captureRate: 0.24 },
      thinking: { hue: 205, accentHue: 262, energy: 0.56, pulse: 0.22, ringSpeed: 0.13, scannerSpeed: 0.14, barGain: 0.34, orbitCount: 8, jitter: 0.02, particleDensity: 98, gravityStrength: 0.76, captureRate: 0.42 },
      speaking: { hue: 196, accentHue: 255, energy: 0.82, pulse: 0.34, ringSpeed: 0.17, scannerSpeed: 0.12, barGain: 0.5, orbitCount: 8, jitter: 0.02, particleDensity: 102, gravityStrength: 0.68, captureRate: 0.3 },
      error: { hue: 8, accentHue: 255, energy: 0.9, pulse: 0.4, ringSpeed: 0.12, scannerSpeed: 0.26, barGain: 0.46, orbitCount: 6, jitter: 0.22, particleDensity: 92, gravityStrength: 0.5, captureRate: 0.2 }
    }
  }
}

export function getQuantumQConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function makeParticle(cx, cy, ringRadius, index) {
  const angle = Math.random() * Math.PI * 2
  const depth = Math.random() * 2 - 1
  const radial = ringRadius * (0.82 + Math.random() * 0.5)
  return {
    x: cx + Math.cos(angle) * radial,
    y: cy + Math.sin(angle) * radial,
    vx: 0,
    vy: 0,
    seed: Math.random() * 1000,
    depth,
    lane: index % 9,
    charge: Math.random() > 0.14 ? 1 : -1,
    mode: 'orbit',
    modeTimer: 0,
    cooldown: Math.random() * 90,
    trail: []
  }
}

export default function QuantumQVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const particlesRef = useRef([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'calm-orbit'
  const { global, state: stateConfig } = useMemo(
    () => getQuantumQConfig(presetId, assignment?.overrides, state),
    [assignment, presetId, state]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const parent = canvas.parentElement
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect?.width && rect?.height) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = clamp(Math.round((stateConfig.particleDensity || 80) * 1.4), 60, 190)
    if (particlesRef.current.length === target) return
    const width = size.width || 800
    const height = size.height || 800
    const cx = width / 2
    const cy = height / 2
    const ringRadius = Math.min(width, height) * 0.27
    particlesRef.current = new Array(target).fill(null).map((_, index) => makeParticle(cx, cy, ringRadius, index))
  }, [size.height, size.width, stateConfig.particleDensity])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    let cancelled = false

    const render = () => {
      if (cancelled) return
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.9)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const cx = width / 2
      const cy = height / 2
      const minDim = Math.min(width, height)

      const energy = getAudioEnergy(audioData)
      const audioKick = energy * (state === 'speaking' ? 1.4 : 0.6)
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const listening = state === 'listening' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0

      const breathing = 1 + Math.sin(time * (0.5 + stateConfig.pulse * 0.6)) * (0.03 + stateConfig.pulse * 0.05)
      const ringRadius = minDim * 0.27 * breathing * (1 + audioKick * 0.06)
      const holeRadius = ringRadius * 0.52
      const coreRadius = ringRadius * 0.19

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(3, 5, 12, ${(0.95 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      // Ambient atmosphere — depth, not the icon itself.
      const ambient = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.65)
      ambient.addColorStop(0, hsl(stateConfig.hue, 90, 58, 0.05 + global.bloom * 0.03))
      ambient.addColorStop(0.4, hsl(stateConfig.accentHue, 85, 46, 0.035 + global.bloom * 0.02))
      ambient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = ambient
      ctx.fillRect(0, 0, width, height)

      const swirlBase = 0.0026 + stateConfig.ringSpeed * 0.0032
      const pullBase = 0.0017 + stateConfig.gravityStrength * 0.0014
      const turbStrength = 0.006 + stateConfig.scannerSpeed * 0.01 + errorMode * stateConfig.jitter * 0.4
      const maxSpeed = 0.9 + stateConfig.energy * 1.3
      const particles = particlesRef.current

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i]

        if (p.mode === 'orbit') {
          if (p.cooldown > 0) {
            p.cooldown -= 1
          } else if (Math.random() < stateConfig.captureRate * 0.0007) {
            p.mode = 'infall'
          }
        }

        const dx = p.x - cx
        const dy = p.y - cy
        const dist = Math.max(1, Math.hypot(dx, dy))
        const nx = dx / dist
        const ny = dy / dist
        const tx = -ny
        const ty = nx

        if (p.mode === 'infall') {
          // Spiral toward the hidden center dot.
          p.vx -= nx * 0.05
          p.vy -= ny * 0.05
          p.vx += tx * swirlBase * 6 * p.charge
          p.vy += ty * swirlBase * 6 * p.charge
          if (dist < coreRadius * 0.55) {
            p.mode = 'flash'
            p.modeTimer = 9
          }
        } else if (p.mode === 'flash') {
          p.modeTimer -= 1
          p.vx *= 0.7
          p.vy *= 0.7
          if (p.modeTimer <= 0) {
            const angle = Math.random() * Math.PI * 2
            p.x = cx + Math.cos(angle) * ringRadius * (1.05 + Math.random() * 0.2)
            p.y = cy + Math.sin(angle) * ringRadius * (1.05 + Math.random() * 0.2)
            const outAngle = Math.atan2(p.y - cy, p.x - cx)
            const kick = maxSpeed * (0.7 + Math.random() * 0.5)
            p.vx = Math.cos(outAngle) * kick + Math.cos(outAngle + Math.PI / 2) * kick * 0.6
            p.vy = Math.sin(outAngle) * kick + Math.sin(outAngle + Math.PI / 2) * kick * 0.6
            p.mode = 'orbit'
            p.cooldown = 70 + Math.random() * 60
          }
        } else {
          // Orbit: spring toward the ring shell, tangential swirl, avoid the hole.
          const shellTarget = ringRadius * (1 + p.depth * 0.2) +
            Math.sin(time * (1 + stateConfig.pulse * 1.6) + p.seed) * (ringRadius * 0.035)
          const shellError = dist - shellTarget
          p.vx -= nx * shellError * pullBase
          p.vy -= ny * shellError * pullBase

          const swirl = swirlBase * (1 + Math.abs(p.depth) * 0.5 + speaking * 0.6) * p.charge
          p.vx += tx * swirl
          p.vy += ty * swirl

          if (dist < holeRadius) {
            const repel = (holeRadius - dist) * 0.01
            p.vx += nx * repel
            p.vy += ny * repel
          }

          // Cheap curl-noise style flow-field turbulence.
          const flow = Math.sin(p.x * 0.012 + time * 0.4) * Math.cos(p.y * 0.012 - time * 0.32 + p.seed * 0.01)
          p.vx += Math.cos(flow * Math.PI) * turbStrength
          p.vy += Math.sin(flow * Math.PI) * turbStrength

          if (listening) {
            const leanAngle = time * 0.2
            p.vx += Math.cos(leanAngle) * 0.003
            p.vy += Math.sin(leanAngle) * 0.003
          }
          if (speaking) {
            const eruption = Math.sin(time * 5.4 + p.seed) * (0.006 + stateConfig.barGain * 0.02 + audioKick * 0.05)
            p.vx += nx * eruption
            p.vy += ny * eruption
          }
          if (errorMode) {
            p.vx += (Math.random() - 0.5) * stateConfig.jitter * 0.3
            p.vy += (Math.random() - 0.5) * stateConfig.jitter * 0.3
          }
        }

        p.vx *= 0.93
        p.vy *= 0.93
        const speed = Math.hypot(p.vx, p.vy)
        if (speed > maxSpeed) {
          p.vx = (p.vx / speed) * maxSpeed
          p.vy = (p.vy / speed) * maxSpeed
        }
        p.x += p.vx
        p.y += p.vy

        p.trail.push(p.x, p.y)
        if (p.trail.length > 12) p.trail.splice(0, p.trail.length - 12)
      }

      // Draw trails + particles with additive glow.
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i]
        const hue = p.lane % 3 === 0 ? stateConfig.accentHue : stateConfig.hue
        const isFlash = p.mode === 'flash'
        const isInfall = p.mode === 'infall'
        const baseAlpha = 0.22 + stateConfig.barGain * 0.5 + global.bloom * 0.06

        const segments = p.trail.length / 2
        for (let s = 1; s < segments; s += 1) {
          const t = s / segments
          const ax = p.trail[(s - 1) * 2]
          const ay = p.trail[(s - 1) * 2 + 1]
          const bx = p.trail[s * 2]
          const by = p.trail[s * 2 + 1]
          ctx.strokeStyle = hsl(hue, 92, isFlash ? 92 : 66, baseAlpha * t * t * (isInfall ? 0.7 : 1))
          ctx.lineWidth = isFlash ? 2.2 : 1 + t * 1.2
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.stroke()
        }

        const dotRadius = isFlash ? 4.4 : isInfall ? 2 : 1.3 + Math.abs(p.depth) * 0.8
        const glowRadius = dotRadius * (isFlash ? 5 : 3.2)
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius)
        glow.addColorStop(0, hsl(hue, 95, isFlash ? 95 : 72, 0.5 + global.bloom * 0.1))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = hsl(hue, 95, isFlash ? 98 : 82, 0.85)
        ctx.beginPath()
        ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      // Bright dense core hint — where the center dot lives, never drawn as a shape.
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const corePulse = 0.5 + Math.sin(time * 1.6) * 0.5
      const coreGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * (2.4 + stateConfig.energy * 1.2))
      coreGlow.addColorStop(0, hsl(stateConfig.hue, 100, 82, 0.16 + corePulse * 0.08 + audioKick * 0.1 + thinking * 0.05))
      coreGlow.addColorStop(0.5, hsl(stateConfig.accentHue, 100, 62, 0.08 + corePulse * 0.05))
      coreGlow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = coreGlow
      ctx.beginPath()
      ctx.arc(cx, cy, coreRadius * (2.4 + stateConfig.energy * 1.2), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (let i = 0; i < 5; i += 1) {
          const a = time * 3 + i * 1.3
          const r = ringRadius * (0.9 + i * 0.05)
          ctx.strokeStyle = hsl(0, 90, 60, 0.05 + stateConfig.jitter * 0.1)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(cx + Math.sin(a) * 3, cy + Math.cos(a) * 3, r, a, a + 0.6)
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(render)
    }

    render()
    return () => {
      cancelled = true
      cancelAnimationFrame(frameRef.current)
    }
  }, [audioData, global, presetId, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
