import { useEffect, useMemo, useRef, useState } from 'react'

const SPECTRUM_HUES = [0, 22, 46, 110, 178, 222, 278]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function hsl(h, s, l, alpha = 1) {
  return `hsla(${h} ${s}% ${l}% / ${alpha})`
}

function mix(a, b, amount) {
  return a + (b - a) * amount
}

function scalePoint(origin, point, amount) {
  return {
    x: mix(origin.x, point.x, amount),
    y: mix(origin.y, point.y, amount)
  }
}

function getAudioEnergy(audioData) {
  if (!audioData?.length) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i += 1) sum += audioData[i]
  return sum / audioData.length / 255
}

function rotatePoint(x, y, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos
  }
}

function createPrismGeometry(cx, cy, size, tilt) {
  const points = {
    top: rotatePoint(0, -size, tilt),
    left: rotatePoint(-size * 0.92, size * 0.64, tilt),
    right: rotatePoint(size * 0.92, size * 0.64, tilt)
  }

  return {
    top: { x: cx + points.top.x, y: cy + points.top.y },
    left: { x: cx + points.left.x, y: cy + points.left.y },
    right: { x: cx + points.right.x, y: cy + points.right.y }
  }
}

function pointOnEdge(a, b, t) {
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t)
  }
}

function getTriangleCentroid(top, left, right) {
  return {
    x: (top.x + left.x + right.x) / 3,
    y: (top.y + left.y + right.y) / 3
  }
}

function traceTriangle(ctx, top, left, right) {
  ctx.beginPath()
  ctx.moveTo(top.x, top.y)
  ctx.lineTo(left.x, left.y)
  ctx.lineTo(right.x, right.y)
  ctx.closePath()
}

function drawBeam(ctx, start, end, startWidth, endWidth, colorStops) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const nx = -dy / length
  const ny = dx / length
  const startHalf = startWidth / 2
  const endHalf = endWidth / 2
  const gradient = ctx.createLinearGradient(start.x, start.y, end.x, end.y)

  colorStops.forEach(stop => {
    gradient.addColorStop(stop.offset, stop.color)
  })

  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.moveTo(start.x + nx * startHalf, start.y + ny * startHalf)
  ctx.lineTo(end.x + nx * endHalf, end.y + ny * endHalf)
  ctx.lineTo(end.x - nx * endHalf, end.y - ny * endHalf)
  ctx.lineTo(start.x - nx * startHalf, start.y - ny * startHalf)
  ctx.closePath()
  ctx.fill()
}

function getBasePreset(presetId) {
  if (presetId === 'spectral-storm') {
    return {
      global: { backdrop: 0.98, bloom: 1.22, noise: 0.08, vibrance: 1.18, glass: 1.08 },
      states: {
        idle: { hue: 228, accentHue: 314, energy: 0.24, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.1, barGain: 0.22, particleDensity: 112, orbitCount: 7, jitter: 0.02, sourceDrift: 0.32, refraction: 0.72 },
        listening: { hue: 212, accentHue: 302, energy: 0.4, pulse: 0.22, ringSpeed: 0.14, scannerSpeed: 0.2, barGain: 0.28, particleDensity: 126, orbitCount: 8, jitter: 0.02, sourceDrift: 0.48, refraction: 0.84 },
        thinking: { hue: 244, accentHue: 320, energy: 0.72, pulse: 0.36, ringSpeed: 0.2, scannerSpeed: 0.16, barGain: 0.34, particleDensity: 142, orbitCount: 9, jitter: 0.03, sourceDrift: 0.66, refraction: 1.02 },
        speaking: { hue: 196, accentHue: 334, energy: 1.08, pulse: 0.84, ringSpeed: 0.24, scannerSpeed: 0.18, barGain: 0.52, particleDensity: 152, orbitCount: 10, jitter: 0.03, sourceDrift: 0.56, refraction: 1.16 },
        error: { hue: 0, accentHue: 336, energy: 1.2, pulse: 0.96, ringSpeed: 0.12, scannerSpeed: 0.36, barGain: 0.6, particleDensity: 140, orbitCount: 8, jitter: 0.16, sourceDrift: 0.4, refraction: 1.22 }
      }
    }
  }

  return {
    global: { backdrop: 0.96, bloom: 1.08, noise: 0.04, vibrance: 0.94, glass: 0.84 },
    states: {
      idle: { hue: 206, accentHue: 188, energy: 0.18, pulse: 0.08, ringSpeed: 0.06, scannerSpeed: 0.08, barGain: 0.18, particleDensity: 84, orbitCount: 6, jitter: 0.01, sourceDrift: 0.18, refraction: 0.46 },
      listening: { hue: 198, accentHue: 176, energy: 0.32, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.16, barGain: 0.24, particleDensity: 94, orbitCount: 7, jitter: 0.01, sourceDrift: 0.28, refraction: 0.58 },
      thinking: { hue: 220, accentHue: 210, energy: 0.6, pulse: 0.3, ringSpeed: 0.16, scannerSpeed: 0.12, barGain: 0.3, particleDensity: 104, orbitCount: 8, jitter: 0.02, sourceDrift: 0.46, refraction: 0.74 },
      speaking: { hue: 184, accentHue: 168, energy: 0.98, pulse: 0.76, ringSpeed: 0.22, scannerSpeed: 0.14, barGain: 0.46, particleDensity: 112, orbitCount: 9, jitter: 0.02, sourceDrift: 0.36, refraction: 0.92 },
      error: { hue: 0, accentHue: 206, energy: 1.12, pulse: 0.82, ringSpeed: 0.12, scannerSpeed: 0.32, barGain: 0.52, particleDensity: 106, orbitCount: 7, jitter: 0.12, sourceDrift: 0.22, refraction: 1.02 }
    }
  }
}

export function getPrismConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

export default function PrismVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'white-split'
  const { global, state: stateConfig } = useMemo(
    () => getPrismConfig(presetId, assignment?.overrides, state),
    [assignment, presetId, state]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect?.width && rect?.height) {
        setSize({ width: rect.width, height: rect.height })
      }
    })
    observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const render = () => {
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.8)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const cy = height / 2
      const minDim = Math.min(width, height)
      const audioKick = getAudioEnergy(audioData) * 0.95
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const sourceDrift = clamp(stateConfig.sourceDrift ?? 0.24, 0, 1.4)
      const refraction = clamp(stateConfig.refraction ?? 0.56, 0.1, 1.5)
      const vibrance = clamp(global.vibrance ?? 0.94, 0.2, 1.6)
      const glass = clamp(global.glass ?? 0.84, 0.2, 1.4)
      const driftRadius = minDim * (0.01 + sourceDrift * 0.04)
      const sourceX = width * (0.08 + sourceDrift * 0.018)
        + Math.sin(time * (0.34 + sourceDrift * 0.32 + stateConfig.scannerSpeed * 0.18)) * driftRadius * 1.2
        + thinking * Math.cos(time * 0.72) * driftRadius * 0.54
        + errorMode * Math.sin(time * 8.6) * stateConfig.jitter * minDim * 0.016
      const sourceY = cy
        - listening * minDim * 0.012
        + Math.sin(time * (0.8 + stateConfig.scannerSpeed * 1.4)) * minDim * (0.004 + sourceDrift * 0.005)
        + Math.cos(time * (0.42 + sourceDrift * 0.56)) * driftRadius * 0.34
        + thinking * Math.cos(time * 0.9) * minDim * 0.012
        + errorMode * Math.sin(time * 11) * stateConfig.jitter * minDim * 0.03
      const prismX = width * 0.48 + thinking * Math.sin(time * 0.4) * minDim * 0.014
      const prismY = cy + speaking * Math.sin(time * 1.2) * minDim * 0.008
      const prismSize = minDim * (0.15 + stateConfig.energy * 0.03 + glass * 0.008)
      const prismTilt =
        -0.08 +
        Math.sin(time * (0.32 + stateConfig.ringSpeed * 0.25)) * 0.026 +
        thinking * Math.sin(time * 0.7) * 0.038 +
        errorMode * Math.sin(time * 7.2) * stateConfig.jitter * 0.08

      const prism = createPrismGeometry(prismX, prismY, prismSize, prismTilt)
      const prismBackShift = rotatePoint(prismSize * 0.12 * glass, -prismSize * 0.1 * glass, prismTilt + 0.18)
      const prismBack = createPrismGeometry(prismX + prismBackShift.x, prismY + prismBackShift.y, prismSize * (0.9 + glass * 0.02), prismTilt)
      const prismCentroid = getTriangleCentroid(prism.top, prism.left, prism.right)
      const entryPoint = pointOnEdge(prism.left, prism.top, 0.53)
      const exitPoint = pointOnEdge(prism.top, prism.right, 0.57)
      const sourcePoint = { x: sourceX, y: sourceY }
      const internalMid = {
        x: mix(entryPoint.x, exitPoint.x, 0.48) + Math.sin(time * (0.5 + refraction * 0.35)) * prismSize * 0.04 * refraction,
        y: mix(entryPoint.y, exitPoint.y, 0.48) - thinking * prismSize * 0.12 - refraction * prismSize * 0.04
      }
      const beamWidth = minDim * (0.01 + stateConfig.barGain * 0.016 + audioKick * 0.012 + refraction * 0.004)
      const dispersion = clamp(
        minDim * (0.07 + stateConfig.energy * 0.06 + refraction * 0.14 + thinking * 0.05 + speaking * 0.04),
        minDim * 0.08,
        minDim * 0.36
      )
      const beamReach = width * 0.94
      const sourceGlowRadius = clamp(
        minDim * (0.14 + global.bloom * 0.1 + audioKick * 0.1 + sourceDrift * 0.05),
        minDim * 0.14,
        minDim * 0.34
      )
      const shardCount = Math.max(5, Math.round(stateConfig.orbitCount + refraction * 2))
      const glassLayers = clamp(Math.round(3 + glass * 3), 3, 7)

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.95 + global.backdrop * 0.03) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const sourceWash = ctx.createLinearGradient(sourceX, sourceY, prismX, prismY)
      sourceWash.addColorStop(0, hsl(stateConfig.hue, 90, 76, 0.06 + vibrance * 0.04))
      sourceWash.addColorStop(0.6, hsl(stateConfig.accentHue, 92, 58, 0.03 + glass * 0.02))
      sourceWash.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = sourceWash
      ctx.fillRect(0, 0, width, height)

      const backdrop = ctx.createRadialGradient(prismX, prismY, prismSize * 0.1, prismX, prismY, minDim * 0.82)
      backdrop.addColorStop(0, hsl(stateConfig.accentHue, 96, 58, 0.03 + global.bloom * 0.02 + vibrance * 0.015))
      backdrop.addColorStop(0.42, hsl(stateConfig.hue, 96, 40, 0.03 + global.bloom * 0.03 + glass * 0.01))
      backdrop.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const sourceGlow = ctx.createRadialGradient(sourceX, sourceY, 0, sourceX, sourceY, sourceGlowRadius)
      sourceGlow.addColorStop(0, 'rgba(255,255,255,0.95)')
      sourceGlow.addColorStop(0.14, hsl(stateConfig.hue, 90, 78, 0.24 + audioKick * 0.12 + vibrance * 0.06))
      sourceGlow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = sourceGlow
      ctx.beginPath()
      ctx.arc(sourceX, sourceY, sourceGlowRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.72)'
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.moveTo(sourceX - sourceGlowRadius * 0.42, sourceY)
      ctx.lineTo(sourceX + sourceGlowRadius * 0.42, sourceY)
      ctx.moveTo(sourceX, sourceY - sourceGlowRadius * 0.24)
      ctx.lineTo(sourceX, sourceY + sourceGlowRadius * 0.24)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      drawBeam(ctx, sourcePoint, entryPoint, beamWidth * (3.6 + sourceDrift * 0.8), beamWidth * (2.1 + refraction * 0.3), [
        { offset: 0, color: 'rgba(255,255,255,0.04)' },
        { offset: 0.32, color: `rgba(255,255,255,${0.18 + vibrance * 0.06})` },
        { offset: 1, color: `rgba(255,255,255,${0.12 + glass * 0.04})` }
      ])
      drawBeam(ctx, sourcePoint, entryPoint, beamWidth * 1.3, beamWidth * 1.05, [
        { offset: 0, color: 'rgba(255,255,255,0.96)' },
        { offset: 0.78, color: 'rgba(255,255,255,0.92)' },
        { offset: 1, color: 'rgba(255,255,255,0.72)' }
      ])
      ctx.restore()

      ctx.save()
      traceTriangle(ctx, prismBack.top, prismBack.left, prismBack.right)
      ctx.fillStyle = hsl(stateConfig.accentHue, 70, 70, 0.035 + glass * 0.04)
      ctx.fill()
      ctx.strokeStyle = hsl(stateConfig.hue, 96, 82, 0.1 + glass * 0.04)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.strokeStyle = hsl(stateConfig.accentHue, 96, 82, 0.08 + glass * 0.06)
      ctx.lineWidth = 0.9
      ctx.beginPath()
      ctx.moveTo(prism.top.x, prism.top.y)
      ctx.lineTo(prismBack.top.x, prismBack.top.y)
      ctx.moveTo(prism.left.x, prism.left.y)
      ctx.lineTo(prismBack.left.x, prismBack.left.y)
      ctx.moveTo(prism.right.x, prism.right.y)
      ctx.lineTo(prismBack.right.x, prismBack.right.y)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      traceTriangle(ctx, prism.top, prism.left, prism.right)
      const prismFill = ctx.createLinearGradient(prism.left.x, prism.top.y, prism.right.x, prism.right.y)
      prismFill.addColorStop(0, `rgba(255,255,255,${0.02 + glass * 0.03})`)
      prismFill.addColorStop(0.34, hsl(stateConfig.hue, 74, 72, 0.05 + glass * 0.04))
      prismFill.addColorStop(0.62, hsl(stateConfig.accentHue, 84, 72, 0.08 + vibrance * 0.04))
      prismFill.addColorStop(1, hsl(stateConfig.accentHue, 84, 66, 0.04 + glass * 0.03))
      ctx.fillStyle = prismFill
      ctx.fill()
      ctx.restore()

      ctx.save()
      traceTriangle(ctx, prism.top, prism.left, prism.right)
      ctx.clip()
      ctx.globalCompositeOperation = 'screen'
      drawBeam(ctx, entryPoint, internalMid, beamWidth * 0.8, beamWidth * (0.62 + refraction * 0.08), [
        { offset: 0, color: 'rgba(255,255,255,0.72)' },
        { offset: 1, color: 'rgba(255,255,255,0.24)' }
      ])
      drawBeam(ctx, internalMid, exitPoint, beamWidth * (0.6 + refraction * 0.08), beamWidth * (0.46 + refraction * 0.08), [
        { offset: 0, color: 'rgba(255,255,255,0.46)' },
        { offset: 1, color: hsl(stateConfig.accentHue, 90, 76, 0.26 + refraction * 0.08) }
      ])

      for (let i = 0; i < glassLayers; i += 1) {
        const depth = 1 - i / Math.max(1, glassLayers - 1)
        const layerTop = scalePoint(prismCentroid, prism.top, 1 - i * 0.08)
        const layerLeft = scalePoint(prismCentroid, prism.left, 1 - i * 0.08)
        const layerRight = scalePoint(prismCentroid, prism.right, 1 - i * 0.08)
        const layerFill = ctx.createLinearGradient(layerLeft.x, layerTop.y, layerRight.x, layerRight.y)
        layerFill.addColorStop(0, hsl(stateConfig.hue, 82, 78, 0.015 + depth * 0.04 * glass))
        layerFill.addColorStop(0.54, `rgba(255,255,255,${0.02 + depth * 0.03 * vibrance})`)
        layerFill.addColorStop(1, hsl(stateConfig.accentHue, 90, 76, 0.02 + depth * 0.035 * glass))
        traceTriangle(ctx, layerTop, layerLeft, layerRight)
        ctx.fillStyle = layerFill
        ctx.fill()
      }

      const sheenGradient = ctx.createLinearGradient(
        prism.left.x - prismSize * 0.3,
        prism.top.y - prismSize * 0.1,
        prism.right.x + prismSize * 0.22,
        prism.right.y + prismSize * 0.14
      )
      sheenGradient.addColorStop(0, 'rgba(255,255,255,0)')
      sheenGradient.addColorStop(0.28, `rgba(255,255,255,${0.06 + glass * 0.05})`)
      sheenGradient.addColorStop(0.42, `rgba(255,255,255,${0.14 + vibrance * 0.04})`)
      sheenGradient.addColorStop(0.54, `rgba(255,255,255,${0.04 + glass * 0.03})`)
      sheenGradient.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = sheenGradient
      ctx.fillRect(prism.left.x - prismSize, prism.top.y - prismSize, prismSize * 2.5, prismSize * 2.3)

      const sweepX = prism.left.x + (Math.sin(time * (0.42 + sourceDrift * 0.24)) * 0.5 + 0.5) * (prism.right.x - prism.left.x)
      const sweep = ctx.createLinearGradient(
        sweepX - prismSize * 0.68,
        prism.top.y - prismSize * 0.24,
        sweepX + prismSize * 0.54,
        prism.right.y + prismSize * 0.24
      )
      sweep.addColorStop(0, 'rgba(255,255,255,0)')
      sweep.addColorStop(0.44, `rgba(255,255,255,${0.04 + glass * 0.03})`)
      sweep.addColorStop(0.5, `rgba(255,255,255,${0.16 + glass * 0.06})`)
      sweep.addColorStop(0.56, `rgba(255,255,255,${0.04 + glass * 0.03})`)
      sweep.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = sweep
      ctx.fillRect(prism.left.x - prismSize, prism.top.y - prismSize, prismSize * 2.4, prismSize * 2.2)

      ctx.strokeStyle = hsl(stateConfig.hue, 100, 84, 0.16 + glass * 0.05)
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.moveTo(mix(prism.top.x, prism.left.x, 0.16), mix(prism.top.y, prism.left.y, 0.16))
      ctx.lineTo(mix(prism.left.x, prism.right.x, 0.52), mix(prism.left.y, prism.right.y, 0.52))
      ctx.lineTo(mix(prism.top.x, prism.right.x, 0.24), mix(prism.top.y, prism.right.y, 0.24))
      ctx.stroke()

      for (let i = 0; i < shardCount; i += 1) {
        const ratio = shardCount === 1 ? 0.5 : i / (shardCount - 1)
        const start = pointOnEdge(prism.left, prism.right, 0.16 + ratio * 0.24)
        const end = pointOnEdge(prism.top, prism.right, 0.18 + ratio * 0.46)
        ctx.strokeStyle = hsl(
          i % 2 === 0 ? stateConfig.hue : stateConfig.accentHue,
          96,
          74,
          0.05 + ratio * 0.07 + thinking * 0.05
        )
        ctx.lineWidth = 0.8 + ratio * 1.2
        ctx.beginPath()
        ctx.moveTo(start.x, start.y)
        ctx.lineTo(end.x, end.y)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.3
      traceTriangle(ctx, prism.top, prism.left, prism.right)
      ctx.stroke()

      ctx.strokeStyle = hsl(stateConfig.accentHue, 96, 72, 0.18 + global.bloom * 0.06 + vibrance * 0.03)
      ctx.lineWidth = 4.6
      traceTriangle(ctx, prism.top, prism.left, prism.right)
      ctx.stroke()

      ctx.strokeStyle = `rgba(255,255,255,${0.12 + glass * 0.08})`
      ctx.lineWidth = 7.4
      traceTriangle(ctx, prism.top, prism.left, prism.right)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      SPECTRUM_HUES.forEach((baseHue, index) => {
        const ratio = SPECTRUM_HUES.length === 1 ? 0.5 : index / (SPECTRUM_HUES.length - 1)
        const centered = ratio - 0.5
        const hue = baseHue + (stateConfig.hue - 200) * 0.04
        const bandStart = {
          x: exitPoint.x + centered * beamWidth * (0.4 + refraction * 0.18),
          y: exitPoint.y + centered * beamWidth * (1.3 + refraction * 0.4)
        }
        const verticalDrift =
          centered * dispersion +
          Math.sin(time * (0.85 + stateConfig.scannerSpeed * 1.1) + index * 0.72) * minDim * 0.006 +
          refraction * Math.cos(time * 1.2 + index * 0.62) * minDim * 0.01 +
          speaking * Math.sin(time * 4.8 + index * 0.9) * minDim * 0.008 +
          errorMode * Math.sin(time * 9.2 + index * 1.3) * stateConfig.jitter * minDim * 0.028
        const bandEnd = {
          x: beamReach,
          y: prismY + verticalDrift * (1 + audioKick * 0.12 + refraction * 0.16)
        }
        const glowWidth = beamWidth * (1.8 + Math.abs(centered) * 0.9 + stateConfig.barGain * 1.1 + refraction * 0.36)
        const coreWidth = beamWidth * (0.68 + Math.abs(centered) * 0.42 + stateConfig.barGain * 0.36 + refraction * 0.14)
        const alphaScale = errorMode && index % 3 === 0 ? 0.5 : 1

        drawBeam(ctx, bandStart, bandEnd, beamWidth * 0.44, glowWidth, [
          { offset: 0, color: hsl(hue, 100, 74, (0.14 + vibrance * 0.04) * alphaScale) },
          { offset: 0.28, color: hsl(hue, 100, 68, (0.24 + global.bloom * 0.08 + refraction * 0.08) * alphaScale) },
          { offset: 1, color: hsl(hue, 100, 56, 0) }
        ])

        drawBeam(ctx, bandStart, bandEnd, beamWidth * 0.16, coreWidth, [
          { offset: 0, color: hsl(hue, 100, 82, (0.72 + speaking * 0.1 + vibrance * 0.08) * alphaScale) },
          { offset: 0.62, color: hsl(hue, 100, 68, (0.52 + audioKick * 0.12 + refraction * 0.08) * alphaScale) },
          { offset: 1, color: hsl(hue, 100, 62, 0.02) }
        ])

        drawBeam(ctx, bandStart, bandEnd, beamWidth * 0.06, beamWidth * (0.22 + refraction * 0.08), [
          { offset: 0, color: hsl(hue, 100, 94, 0.24 + vibrance * 0.08) },
          { offset: 0.72, color: hsl(hue, 100, 82, 0.1 + refraction * 0.06) },
          { offset: 1, color: hsl(hue, 100, 68, 0) }
        ])
      })
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const splitGlow = ctx.createRadialGradient(
        exitPoint.x + minDim * 0.18,
        exitPoint.y,
        0,
        exitPoint.x + minDim * 0.18,
        exitPoint.y,
        minDim * (0.34 + global.bloom * 0.14)
      )
      splitGlow.addColorStop(0, hsl(stateConfig.accentHue, 100, 76, 0.16 + speaking * 0.08))
      splitGlow.addColorStop(0.4, hsl(stateConfig.hue, 100, 64, 0.08 + global.bloom * 0.06))
      splitGlow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = splitGlow
      ctx.beginPath()
      ctx.arc(exitPoint.x + minDim * 0.18, exitPoint.y, minDim * (0.34 + global.bloom * 0.14), 0, Math.PI * 2)
      ctx.fill()

      for (let i = 0; i < glassLayers + 2; i += 1) {
        const ratio = i / Math.max(1, glassLayers + 1)
        const fanStart = {
          x: exitPoint.x + ratio * minDim * 0.02,
          y: exitPoint.y + (ratio - 0.5) * beamWidth * 1.2
        }
        const fanEnd = {
          x: exitPoint.x + minDim * (0.1 + refraction * 0.12),
          y: exitPoint.y + (ratio - 0.5) * dispersion * 0.32
        }
        drawBeam(ctx, fanStart, fanEnd, beamWidth * 0.05, beamWidth * (0.2 + refraction * 0.08), [
          { offset: 0, color: hsl(SPECTRUM_HUES[i % SPECTRUM_HUES.length], 100, 86, 0.18 + vibrance * 0.05) },
          { offset: 1, color: hsl(SPECTRUM_HUES[(i + 1) % SPECTRUM_HUES.length], 100, 66, 0) }
        ])
      }
      ctx.restore()

      const dustCount = 24 + Math.round((stateConfig.particleDensity || 84) * 0.18)
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < dustCount; i += 1) {
        const travel = (i / dustCount + time * (0.018 + stateConfig.scannerSpeed * 0.018)) % 1
        const shimmer = Math.sin(i * 12.9 + time * 2.1) * 0.5 + 0.5
        const px = sourceX + (beamReach - sourceX) * travel
        const py = cy + (Math.sin(i * 4.2) * 0.5 + centeredDust(i)) * minDim * (0.03 + travel * 0.13)
        const size = 0.5 + shimmer * 1.6
        ctx.fillStyle = hsl(
          i % 5 === 0 ? stateConfig.accentHue : stateConfig.hue,
          90,
          78,
          0.02 + shimmer * 0.08 + global.noise * 0.04
        )
        ctx.beginPath()
        ctx.arc(px, py, size, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        for (let i = 0; i < 6; i += 1) {
          const y = prismY + Math.sin(time * 7.2 + i * 1.4) * minDim * 0.24
          ctx.strokeStyle = hsl(0, 100, 62, 0.08 + i * 0.018)
          ctx.lineWidth = 1 + i * 0.35
          ctx.beginPath()
          ctx.moveTo(exitPoint.x - minDim * 0.04, y)
          ctx.lineTo(width, y + Math.sin(time * 12 + i) * minDim * 0.02)
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(render)
    }

    function centeredDust(index) {
      return ((Math.sin(index * 9.37) * 0.5 + 0.5) - 0.5) * 2
    }

    render()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
