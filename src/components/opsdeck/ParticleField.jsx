/**
 * ParticleField — Ambient drifting particles behind the OpsDeck graph
 *
 * Uses simplex-like noise for organic drift. Purely ambient, no proximity detection.
 * Renders on a canvas behind ReactFlow.
 */

import { useRef, useCallback } from 'react'
import { useResponsiveCanvas } from '../../components/visualizations/hooks/useResponsiveCanvas'
import { useAnimationLoop } from '../../components/visualizations/core/useAnimationLoop'

const PARTICLE_COUNT = 150
const TAU = Math.PI * 2

// Simple 2D gradient noise (hash-based, not true simplex but visually similar)
const PERM = new Uint8Array(512)
for (let i = 0; i < 256; i++) PERM[i] = i
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  const t = PERM[i]; PERM[i] = PERM[j]; PERM[j] = t
}
for (let i = 0; i < 256; i++) PERM[i + 256] = PERM[i]

const GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10) }
function lerp(a, b, t) { return a + t * (b - a) }
function dot2(g, x, y) { return g[0] * x + g[1] * y }

function noise2(x, y) {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const xf = x - Math.floor(x)
  const yf = y - Math.floor(y)
  const u = fade(xf)
  const v = fade(yf)
  const aa = PERM[PERM[X] + Y] & 7
  const ab = PERM[PERM[X] + Y + 1] & 7
  const ba = PERM[PERM[X + 1] + Y] & 7
  const bb = PERM[PERM[X + 1] + Y + 1] & 7
  return lerp(
    lerp(dot2(GRAD[aa], xf, yf), dot2(GRAD[ba], xf - 1, yf), u),
    lerp(dot2(GRAD[ab], xf, yf - 1), dot2(GRAD[bb], xf - 1, yf - 1), u),
    v
  )
}

function initParticles(w, h) {
  const particles = []
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: 0,
      vy: 0,
      size: 0.5 + Math.random() * 1.0,
    })
  }
  return particles
}

export default function ParticleField() {
  const { canvasRef, containerRef, dimensions } = useResponsiveCanvas()
  const particlesRef = useRef(null)
  const timeRef = useRef(0)

  const draw = useCallback((dt) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height } = dimensions
    if (width < 10 || height < 10) return

    // Lazy-init particles
    if (!particlesRef.current || particlesRef.current._w !== width || particlesRef.current._h !== height) {
      particlesRef.current = initParticles(width, height)
      particlesRef.current._w = width
      particlesRef.current._h = height
    }

    timeRef.current += dt

    ctx.clearRect(0, 0, width, height)

    const particles = particlesRef.current
    const time = timeRef.current

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]

      // Noise-driven velocity
      p.vx += noise2(p.x * 0.003, time * 0.0005) * 0.3
      p.vy += noise2(p.y * 0.003, time * 0.0005 + 100) * 0.3

      // Clamp speed
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
      if (speed > 0.8) {
        p.vx = (p.vx / speed) * 0.8
        p.vy = (p.vy / speed) * 0.8
      }

      // Damping
      p.vx *= 0.98
      p.vy *= 0.98

      p.x += p.vx
      p.y += p.vy

      // Wrap edges
      if (p.x < 0) p.x += width
      if (p.x > width) p.x -= width
      if (p.y < 0) p.y += height
      if (p.y > height) p.y -= height

      // Draw
      ctx.fillStyle = `rgba(255, 255, 255, 0.03)`
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, TAU)
      ctx.fill()
    }
  }, [canvasRef, dimensions])

  useAnimationLoop(draw, true, [dimensions])

  return (
    <div ref={containerRef} className="opsdeck-particles">
      <canvas ref={canvasRef} />
    </div>
  )
}
