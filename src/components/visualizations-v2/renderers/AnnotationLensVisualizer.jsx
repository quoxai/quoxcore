import { useEffect, useMemo, useRef, useState } from 'react'

const TRACE_META = [
  { seed: 1.2, offset: -0.24, width: 1.24, hueShift: 0 },
  { seed: 2.8, offset: -0.08, width: 1.08, hueShift: -12 },
  { seed: 4.6, offset: 0.1, width: 0.98, hueShift: 18 },
  { seed: 6.1, offset: 0.28, width: 0.9, hueShift: 34 }
]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function mix(a, b, amount) {
  return a + (b - a) * amount
}

function hsl(h, s, l, alpha = 1) {
  return `hsla(${h} ${s}% ${l}% / ${alpha})`
}

function getAudioEnergy(audioData) {
  if (!audioData?.length) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i += 1) sum += audioData[i]
  return sum / audioData.length / 255
}

function buildAnnotationMeta(density) {
  const count = clamp(Math.round(density * 0.14), 8, 22)
  return new Array(count).fill(null).map((_, index) => ({
    traceIndex: index % TRACE_META.length,
    offset: 0.12 + (index / Math.max(1, count - 1)) * 0.76,
    seed: 4.8 + index * 0.91,
    side: index % 2 === 0 ? -1 : 1
  }))
}

function getBasePreset(presetId) {
  if (presetId === 'threshold-glass') {
    return {
      global: { backdrop: 0.86, bloom: 1.06, noise: 0.07, lensDepth: 1.08, annotationGlow: 1.12 },
      states: {
        idle: { hue: 24, accentHue: 188, energy: 0.22, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.12, barGain: 0.18, particleDensity: 82, orbitCount: 7, jitter: 0.02, traceSpread: 0.56, annotationDensity: 0.54 },
        listening: { hue: 26, accentHue: 176, energy: 0.38, pulse: 0.22, ringSpeed: 0.12, scannerSpeed: 0.26, barGain: 0.26, particleDensity: 94, orbitCount: 8, jitter: 0.02, traceSpread: 0.68, annotationDensity: 0.7 },
        thinking: { hue: 18, accentHue: 50, energy: 0.7, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.22, barGain: 0.34, particleDensity: 108, orbitCount: 9, jitter: 0.03, traceSpread: 0.92, annotationDensity: 1.04 },
        speaking: { hue: 20, accentHue: 44, energy: 0.98, pulse: 0.72, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.44, particleDensity: 116, orbitCount: 10, jitter: 0.03, traceSpread: 0.84, annotationDensity: 0.88 },
        error: { hue: 4, accentHue: 18, energy: 1.14, pulse: 0.86, ringSpeed: 0.1, scannerSpeed: 0.32, barGain: 0.56, particleDensity: 118, orbitCount: 8, jitter: 0.14, traceSpread: 1.1, annotationDensity: 1.18 }
      }
    }
  }

  return {
    global: { backdrop: 0.8, bloom: 0.94, noise: 0.04, lensDepth: 0.92, annotationGlow: 0.84 },
    states: {
      idle: { hue: 28, accentHue: 178, energy: 0.18, pulse: 0.1, ringSpeed: 0.06, scannerSpeed: 0.1, barGain: 0.16, particleDensity: 72, orbitCount: 6, jitter: 0.01, traceSpread: 0.48, annotationDensity: 0.44 },
      listening: { hue: 24, accentHue: 168, energy: 0.32, pulse: 0.18, ringSpeed: 0.1, scannerSpeed: 0.22, barGain: 0.24, particleDensity: 86, orbitCount: 7, jitter: 0.01, traceSpread: 0.6, annotationDensity: 0.62 },
      thinking: { hue: 18, accentHue: 46, energy: 0.62, pulse: 0.3, ringSpeed: 0.16, scannerSpeed: 0.18, barGain: 0.3, particleDensity: 98, orbitCount: 8, jitter: 0.02, traceSpread: 0.86, annotationDensity: 0.92 },
      speaking: { hue: 22, accentHue: 42, energy: 0.92, pulse: 0.7, ringSpeed: 0.22, scannerSpeed: 0.16, barGain: 0.42, particleDensity: 110, orbitCount: 9, jitter: 0.02, traceSpread: 0.76, annotationDensity: 0.78 },
      error: { hue: 2, accentHue: 16, energy: 1.08, pulse: 0.82, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.52, particleDensity: 112, orbitCount: 7, jitter: 0.12, traceSpread: 1.04, annotationDensity: 1.08 }
    }
  }
}

export function getAnnotationLensConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function buildTracePoints(width, height, lens, traceSpread, stateConfig, time, audioKick, errorMode) {
  const samples = 40
  return TRACE_META.map((trace) => {
    const baseY = lens.y + lens.radius * trace.offset * (1.1 + traceSpread * 0.5)
    const amplitude = height * (0.028 + trace.width * 0.008 + traceSpread * 0.024 + stateConfig.energy * 0.008 + audioKick * 0.012)
    return {
      ...trace,
      points: new Array(samples).fill(null).map((_, sampleIndex) => {
        const ratio = sampleIndex / (samples - 1)
        const x = mix(width * 0.06, width * 0.94, ratio)
        const focus = Math.exp(-((x - lens.x) ** 2) / ((lens.radius * 1.22) ** 2))
        const primaryWave = Math.sin(ratio * (7.2 + stateConfig.ringSpeed * 1.6) - time * (0.8 + stateConfig.scannerSpeed * 0.55) + trace.seed) * amplitude
        const secondaryWave = Math.cos(ratio * 17 - time * 1.5 + trace.seed * 1.7) * amplitude * (0.18 + stateConfig.barGain * 0.12)
        const lensLift = Math.sin(time * 1.2 + ratio * 11 + trace.seed * 0.8) * amplitude * focus * (0.34 + stateConfig.pulse * 0.2)
        const errorSpike = errorMode
          ? Math.sin(ratio * 52 + time * 5 + trace.seed * 2.1) * amplitude * 0.18 * clamp(focus * 1.2, 0, 1)
          : 0
        return {
          x,
          y: baseY + primaryWave + secondaryWave + lensLift + errorSpike
        }
      })
    }
  })
}

function drawSmoothPath(ctx, points) {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2)
  }
  const tail = points[points.length - 1]
  ctx.lineTo(tail.x, tail.y)
}

function getPointOnTrace(points, offset) {
  const index = clamp(Math.floor(offset * (points.length - 1)), 0, points.length - 2)
  const local = offset * (points.length - 1) - index
  return {
    x: mix(points[index].x, points[index + 1].x, local),
    y: mix(points[index].y, points[index + 1].y, local)
  }
}

export default function AnnotationLensVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'pattern-lens'
  const { global, state: stateConfig } = useMemo(
    () => getAnnotationLensConfig(presetId, assignment?.overrides, state),
    [assignment, presetId, state]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect?.width && rect?.height) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(canvas.parentElement)
    return () => observer.disconnect()
  }, [])

  const annotations = useMemo(
    () => buildAnnotationMeta(stateConfig.particleDensity || 80),
    [stateConfig.particleDensity]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const draw = () => {
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.82)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const minDim = Math.min(width, height)
      const audioKick = getAudioEnergy(audioData) * 0.96
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const lensDepth = clamp(global.lensDepth ?? 1, 0.7, 1.4)
      const annotationGlow = clamp(global.annotationGlow ?? 0.84, 0.2, 1.4)
      const traceSpread = clamp(stateConfig.traceSpread ?? 0.6, 0.2, 1.4)
      const visibleAnnotations = clamp(
        Math.round(annotations.length * clamp(stateConfig.annotationDensity ?? 0.7, 0.2, 1.4)),
        0,
        annotations.length
      )
      const lens = {
        x: width * 0.43,
        y: height * 0.5,
        radius: minDim * (0.25 + lensDepth * 0.02)
      }
      const traces = buildTracePoints(width, height, lens, traceSpread, stateConfig, time, audioKick, errorMode)

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(5, 8, 14, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const ambient = ctx.createRadialGradient(lens.x, lens.y, 0, lens.x, lens.y, minDim * 0.75)
      ambient.addColorStop(0, hsl(stateConfig.hue, 96, 54, 0.06 + global.bloom * 0.04))
      ambient.addColorStop(0.32, hsl(stateConfig.accentHue, 96, 56, 0.07 + global.bloom * 0.04))
      ambient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = ambient
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalAlpha = 0.08 + global.noise * 0.08
      ctx.strokeStyle = hsl(stateConfig.hue, 72, 74, 0.18)
      ctx.lineWidth = 1
      for (let x = width * 0.06; x < width * 0.96; x += 42) {
        ctx.beginPath()
        ctx.moveTo(x + 0.5, height * 0.14)
        ctx.lineTo(x + 0.5, height * 0.86)
        ctx.stroke()
      }
      for (let y = height * 0.16; y < height * 0.86; y += 28) {
        ctx.beginPath()
        ctx.moveTo(width * 0.05, y + 0.5)
        ctx.lineTo(width * 0.95, y + 0.5)
        ctx.stroke()
      }
      ctx.restore()

      for (let index = 0; index < 3; index += 1) {
        const thresholdY = lens.y + lens.radius * (-0.54 + index * 0.54) + Math.sin(time * 0.8 + index) * minDim * 0.004
        ctx.strokeStyle = hsl(errorMode ? 8 : stateConfig.accentHue, 96, errorMode ? 58 : 70, 0.12 + index * 0.02 + errorMode * 0.08)
        ctx.lineWidth = index === 1 ? 1.4 : 1
        ctx.setLineDash([8, 10])
        ctx.beginPath()
        ctx.moveTo(width * 0.07, thresholdY)
        ctx.lineTo(width * 0.93, thresholdY)
        ctx.stroke()
      }
      ctx.setLineDash([])

      const lensShadow = ctx.createRadialGradient(lens.x, lens.y, lens.radius * 0.2, lens.x, lens.y, lens.radius * 1.35)
      lensShadow.addColorStop(0, 'rgba(0,0,0,0)')
      lensShadow.addColorStop(1, 'rgba(0,0,0,0.36)')
      ctx.fillStyle = lensShadow
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius * 1.36, 0, Math.PI * 2)
      ctx.fill()

      ctx.save()
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      ctx.clip()
      const lensFill = ctx.createLinearGradient(lens.x - lens.radius, lens.y - lens.radius, lens.x + lens.radius, lens.y + lens.radius)
      lensFill.addColorStop(0, hsl(stateConfig.hue, 46, 18, 0.44))
      lensFill.addColorStop(0.5, hsl(stateConfig.accentHue, 54, 14, 0.22))
      lensFill.addColorStop(1, hsl(stateConfig.hue, 58, 10, 0.5))
      ctx.fillStyle = lensFill
      ctx.fillRect(lens.x - lens.radius, lens.y - lens.radius, lens.radius * 2, lens.radius * 2)

      const scanX = mix(lens.x - lens.radius * 0.86, lens.x + lens.radius * 0.86, (Math.sin(time * (0.7 + stateConfig.scannerSpeed * 0.7)) + 1) * 0.5)
      const scan = ctx.createLinearGradient(scanX - 90, 0, scanX + 90, 0)
      scan.addColorStop(0, 'rgba(0,0,0,0)')
      scan.addColorStop(0.5, hsl(stateConfig.accentHue, 100, 78, 0.06 + listening * 0.12))
      scan.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = scan
      ctx.fillRect(lens.x - lens.radius, lens.y - lens.radius, lens.radius * 2, lens.radius * 2)

      traces.forEach((trace, index) => {
        const hue = errorMode && index === 2 ? 6 : trace.hueShift + (index % 2 === 0 ? stateConfig.hue : stateConfig.accentHue)
        const baseWidth = 2.2 + trace.width * 1.8 + stateConfig.barGain * 2.8 + audioKick * 2.4
        drawSmoothPath(ctx, trace.points)
        ctx.strokeStyle = hsl(hue, 100, 64, 0.08 + global.bloom * 0.04 + speaking * 0.04)
        ctx.lineWidth = baseWidth * 4.2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()

        drawSmoothPath(ctx, trace.points)
        ctx.strokeStyle = hsl(hue, 94, 72, 0.24 + trace.width * 0.08 + thinking * 0.05)
        ctx.lineWidth = baseWidth * 1.85
        ctx.stroke()

        drawSmoothPath(ctx, trace.points)
        ctx.strokeStyle = hsl(hue, 100, 84, 0.74 + speaking * 0.08 + audioKick * 0.08)
        ctx.lineWidth = baseWidth
        ctx.stroke()
      })

      for (let index = 0; index < visibleAnnotations; index += 1) {
        const annotation = annotations[index]
        if (!annotation) continue
        const trace = traces[annotation.traceIndex]
        if (!trace) continue
        const wobble = Math.sin(time * 0.9 + annotation.seed) * 0.03
        const point = getPointOnTrace(trace.points, clamp(annotation.offset + wobble, 0.06, 0.94))
        const anchorY = point.y + annotation.side * (-26 - annotationGlow * 10 - Math.sin(time * 1.4 + annotation.seed) * 4)
        const hue = errorMode && index % 4 === 0 ? 8 : trace.hueShift + (annotation.traceIndex % 2 === 0 ? stateConfig.accentHue : stateConfig.hue)

        ctx.strokeStyle = hsl(hue, 100, 76, 0.34 + annotationGlow * 0.12)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(point.x, point.y)
        ctx.lineTo(point.x, anchorY)
        ctx.stroke()

        ctx.fillStyle = hsl(hue, 100, 76, 0.16 + annotationGlow * 0.08)
        ctx.beginPath()
        ctx.arc(point.x, point.y, 7 + annotationGlow * 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = hsl(hue, 100, 82, 0.94)
        ctx.beginPath()
        ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2)
        ctx.fill()

        const markerWidth = 8 + annotationGlow * 5
        const markerHeight = 4 + annotationGlow * 2
        ctx.strokeStyle = hsl(hue, 100, 80, 0.52)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(point.x - markerWidth, anchorY - markerHeight)
        ctx.lineTo(point.x - markerWidth, anchorY + markerHeight)
        ctx.lineTo(point.x - markerWidth * 0.32, anchorY + markerHeight)
        ctx.moveTo(point.x + markerWidth, anchorY - markerHeight)
        ctx.lineTo(point.x + markerWidth, anchorY + markerHeight)
        ctx.lineTo(point.x + markerWidth * 0.32, anchorY + markerHeight)
        ctx.stroke()
      }
      ctx.restore()

      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      const rim = ctx.createLinearGradient(lens.x - lens.radius, lens.y - lens.radius, lens.x + lens.radius, lens.y + lens.radius)
      rim.addColorStop(0, hsl(stateConfig.accentHue, 100, 82, 0.28 + lensDepth * 0.08))
      rim.addColorStop(0.55, hsl(stateConfig.hue, 90, 72, 0.18 + lensDepth * 0.06))
      rim.addColorStop(1, hsl(stateConfig.accentHue, 100, 88, 0.44 + lensDepth * 0.1))
      ctx.strokeStyle = rim
      ctx.lineWidth = 2 + lensDepth * 1.8
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius * 0.84, Math.PI * 0.8, Math.PI * 1.95)
      ctx.strokeStyle = hsl(stateConfig.hue, 92, 86, 0.16 + lensDepth * 0.08)
      ctx.lineWidth = 1.4
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(lens.x - lens.radius * 0.18, lens.y - lens.radius * 0.14, lens.radius * 0.7, Math.PI * 1.02, Math.PI * 1.58)
      ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 92, 0.2 + lensDepth * 0.1)
      ctx.lineWidth = 1.1
      ctx.stroke()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const reflection = ctx.createLinearGradient(lens.x - lens.radius * 0.82, lens.y - lens.radius * 0.86, lens.x + lens.radius * 0.32, lens.y + lens.radius * 0.12)
      reflection.addColorStop(0, hsl(stateConfig.accentHue, 100, 92, 0.24))
      reflection.addColorStop(0.45, hsl(stateConfig.hue, 100, 88, 0.08))
      reflection.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = reflection
      ctx.beginPath()
      ctx.ellipse(lens.x - lens.radius * 0.18, lens.y - lens.radius * 0.22, lens.radius * 0.84, lens.radius * 0.42, -0.68, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      traces.forEach((trace, index) => {
        const swatchX = width * 0.08
        const swatchY = height * (0.28 + index * 0.08)
        const hue = trace.hueShift + (index % 2 === 0 ? stateConfig.hue : stateConfig.accentHue)
        ctx.fillStyle = hsl(hue, 100, 76, 0.72)
        ctx.fillRect(swatchX, swatchY, 18, 2)
        ctx.fillStyle = hsl(hue, 100, 84, 0.5)
        ctx.beginPath()
        ctx.arc(swatchX + 28, swatchY + 1, 1.6, 0, Math.PI * 2)
        ctx.fill()
      })

      if (thinking) {
        ctx.save()
        ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 80, 0.28 + audioKick * 0.1)
        ctx.lineWidth = 1.1
        ctx.setLineDash([5, 7])
        for (let index = 0; index < 3; index += 1) {
          const fromTrace = traces[index]
          const toTrace = traces[index + 1]
          const from = getPointOnTrace(fromTrace.points, 0.34 + index * 0.12)
          const to = getPointOnTrace(toTrace.points, 0.48 + index * 0.1)
          ctx.beginPath()
          ctx.moveTo(from.x, from.y)
          ctx.quadraticCurveTo(lens.x + lens.radius * 0.08, mix(from.y, to.y, 0.5) - lens.radius * 0.18, to.x, to.y)
          ctx.stroke()
        }
        ctx.restore()
      }

      if (speaking) {
        const focus = getPointOnTrace(traces[1].points, 0.72)
        const focusX = width * 0.79
        const focusY = height * 0.26
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const beam = ctx.createLinearGradient(focus.x, focus.y, focusX, focusY)
        beam.addColorStop(0, hsl(stateConfig.accentHue, 100, 82, 0.1))
        beam.addColorStop(1, hsl(stateConfig.hue, 100, 78, 0.28))
        ctx.strokeStyle = beam
        ctx.lineWidth = 3 + audioKick * 2.8
        ctx.beginPath()
        ctx.moveTo(focus.x, focus.y)
        ctx.quadraticCurveTo(width * 0.66, height * 0.16, focusX - 26, focusY + 6)
        ctx.stroke()
        const focusGlow = ctx.createRadialGradient(focusX, focusY, 0, focusX, focusY, 42 + audioKick * 10)
        focusGlow.addColorStop(0, hsl(stateConfig.accentHue, 100, 82, 0.22))
        focusGlow.addColorStop(0.5, hsl(stateConfig.hue, 100, 72, 0.1))
        focusGlow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = focusGlow
        ctx.beginPath()
        ctx.arc(focusX, focusY, 42 + audioKick * 10, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        ctx.save()
        ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 82, 0.62)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(focusX, focusY, 26 + Math.sin(time * 2.4) * 1.8, -0.54, Math.PI * 1.56)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(focusX, focusY, 16 + Math.cos(time * 2.8) * 1.4, 0.12, Math.PI * 1.92)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(focusX - 12, focusY - 20)
        ctx.lineTo(focusX - 12, focusY + 20)
        ctx.moveTo(focusX + 12, focusY - 20)
        ctx.lineTo(focusX + 12, focusY + 20)
        ctx.stroke()
        ctx.restore()

        ctx.save()
        ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 78, 0.16 + stateConfig.pulse * 0.12)
        ctx.lineWidth = 1.1
        for (let ring = 0; ring < 3; ring += 1) {
          ctx.beginPath()
          ctx.arc(lens.x, lens.y, lens.radius * (1.08 + ring * 0.12) + Math.sin(time * 2.2 + ring) * 2, -0.24, 0.42)
          ctx.stroke()
        }
        ctx.restore()
      }

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        for (let index = 0; index < 5; index += 1) {
          const y = height * (0.2 + index * 0.12) + Math.sin(time * 8 + index * 1.4) * minDim * 0.016
          ctx.strokeStyle = hsl(index % 2 === 0 ? 4 : 18, 100, 60, 0.08 + index * 0.018)
          ctx.lineWidth = 1 + (index % 3) * 0.6
          ctx.beginPath()
          ctx.moveTo(width * 0.06, y)
          ctx.lineTo(width * 0.92, y + Math.cos(time * 6 + index) * minDim * 0.012)
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frameRef.current)
  }, [annotations, audioData, global, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
