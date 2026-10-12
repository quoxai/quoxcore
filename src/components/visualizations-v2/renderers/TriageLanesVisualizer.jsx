import { useEffect, useMemo, useRef, useState } from 'react'

const LANE_META = [
  { key: 'urgent', label: 'URGENT', hue: 6, weight: 0.82 },
  { key: 'reply', label: 'REPLY', hue: 34, weight: 1 },
  { key: 'waiting', label: 'WAITING', hue: 198, weight: 0.74 },
  { key: 'fyi', label: 'FYI', hue: 148, weight: 0.58 }
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

function ease(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - ((-2 * value + 2) ** 3) / 2
}

function getAudioEnergy(audioData) {
  if (!audioData?.length) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i += 1) sum += audioData[i]
  return sum / audioData.length / 255
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function pointOnQuadratic(ax, ay, cx, cy, bx, by, t) {
  const mt = 1 - t
  return {
    x: mt * mt * ax + 2 * mt * t * cx + t * t * bx,
    y: mt * mt * ay + 2 * mt * t * cy + t * t * by
  }
}

function getBasePreset(presetId) {
  if (presetId === 'night-shift') {
    return {
      global: { backdrop: 0.9, bloom: 1.08, noise: 0.07, laneSpread: 0.92, reviewFocus: 1.12 },
      states: {
        idle: { hue: 212, accentHue: 292, energy: 0.22, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.14, barGain: 0.18, particleDensity: 82, orbitCount: 7, jitter: 0.02, queueDepth: 0.34, sortSnap: 0.56 },
        listening: { hue: 200, accentHue: 306, energy: 0.4, pulse: 0.22, ringSpeed: 0.12, scannerSpeed: 0.24, barGain: 0.26, particleDensity: 96, orbitCount: 8, jitter: 0.02, queueDepth: 0.58, sortSnap: 0.72 },
        thinking: { hue: 228, accentHue: 316, energy: 0.74, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.2, barGain: 0.34, particleDensity: 110, orbitCount: 9, jitter: 0.03, queueDepth: 0.88, sortSnap: 0.98 },
        speaking: { hue: 194, accentHue: 284, energy: 0.98, pulse: 0.74, ringSpeed: 0.24, scannerSpeed: 0.2, barGain: 0.46, particleDensity: 118, orbitCount: 10, jitter: 0.03, queueDepth: 0.78, sortSnap: 1.02 },
        error: { hue: 0, accentHue: 336, energy: 1.14, pulse: 0.88, ringSpeed: 0.12, scannerSpeed: 0.36, barGain: 0.56, particleDensity: 126, orbitCount: 8, jitter: 0.16, queueDepth: 1.18, sortSnap: 0.42 }
      }
    }
  }

  return {
    global: { backdrop: 0.82, bloom: 0.96, noise: 0.04, laneSpread: 1, reviewFocus: 0.84 },
    states: {
      idle: { hue: 202, accentHue: 172, energy: 0.18, pulse: 0.1, ringSpeed: 0.06, scannerSpeed: 0.12, barGain: 0.16, particleDensity: 72, orbitCount: 6, jitter: 0.01, queueDepth: 0.28, sortSnap: 0.48 },
      listening: { hue: 192, accentHue: 164, energy: 0.32, pulse: 0.18, ringSpeed: 0.1, scannerSpeed: 0.22, barGain: 0.24, particleDensity: 88, orbitCount: 7, jitter: 0.01, queueDepth: 0.52, sortSnap: 0.62 },
      thinking: { hue: 216, accentHue: 48, energy: 0.62, pulse: 0.28, ringSpeed: 0.16, scannerSpeed: 0.18, barGain: 0.3, particleDensity: 104, orbitCount: 8, jitter: 0.02, queueDepth: 0.82, sortSnap: 0.92 },
      speaking: { hue: 184, accentHue: 28, energy: 0.9, pulse: 0.72, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.42, particleDensity: 112, orbitCount: 9, jitter: 0.02, queueDepth: 0.72, sortSnap: 0.96 },
      error: { hue: 0, accentHue: 18, energy: 1.08, pulse: 0.82, ringSpeed: 0.12, scannerSpeed: 0.34, barGain: 0.52, particleDensity: 122, orbitCount: 7, jitter: 0.14, queueDepth: 1.12, sortSnap: 0.38 }
    }
  }
}

export function getTriageLanesConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function buildCards(count) {
  const lanePattern = [1, 2, 1, 3, 0, 1, 2, 1, 3, 0, 1, 2]
  return new Array(count).fill(null).map((_, index) => ({
    laneIndex: lanePattern[index % lanePattern.length],
    offset: (index * 0.109) % 1,
    seed: index * 17.73,
    size: 0.82 + (index % 4) * 0.18,
    needsReview: index % 9 === 0,
    rail: index % 6
  }))
}

function getLaneLayout(width, height, laneSpread) {
  const panelX = width * 0.66
  const panelWidth = width * 0.24
  const laneHeight = height * 0.125
  const gap = height * 0.04 * laneSpread
  const totalHeight = laneHeight * LANE_META.length + gap * (LANE_META.length - 1)
  const top = (height - totalHeight) / 2

  return LANE_META.map((lane, index) => {
    const y = top + index * (laneHeight + gap)
    return {
      ...lane,
      x: panelX,
      y,
      width: panelWidth,
      height: laneHeight,
      centerY: y + laneHeight / 2
    }
  })
}

export default function TriageLanesVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'priority-router'
  const { global, state: stateConfig } = useMemo(
    () => getTriageLanesConfig(presetId, assignment?.overrides, state),
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

  const queueDepth = clamp(stateConfig.queueDepth ?? 0.6, 0.2, 1.6)
  const lanes = useMemo(
    () => getLaneLayout(size.width, size.height, clamp(global.laneSpread ?? 1, 0.76, 1.24)),
    [global.laneSpread, size.height, size.width]
  )
  const cards = useMemo(
    () => buildCards(Math.max(18, Math.round((stateConfig.particleDensity || 88) * (0.22 + queueDepth * 0.28)))),
    [queueDepth, stateConfig.particleDensity]
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
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.85)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const minDim = Math.min(width, height)
      const audioKick = getAudioEnergy(audioData) * 0.95
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const sortSnap = clamp(stateConfig.sortSnap ?? 0.6, 0.2, 1.4)
      const reviewFocus = clamp(global.reviewFocus ?? 0.84, 0.2, 1.4)

      const intakeX = width * 0.12
      const scanX = width * 0.42 + Math.sin(time * (0.36 + stateConfig.scannerSpeed * 0.18)) * minDim * 0.008
      const scanY = height * 0.5 + Math.cos(time * (0.42 + stateConfig.ringSpeed * 0.22)) * minDim * 0.006
      const reviewX = width * 0.575
      const reviewY = height * 0.18 + Math.sin(time * 0.7) * minDim * 0.008

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(4, 8, 14, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const scanGlow = ctx.createRadialGradient(scanX, scanY, 0, scanX, scanY, minDim * 0.52)
      scanGlow.addColorStop(0, hsl(stateConfig.accentHue, 100, 72, 0.05 + global.bloom * 0.05))
      scanGlow.addColorStop(0.35, hsl(stateConfig.hue, 96, 52, 0.06 + global.bloom * 0.04))
      scanGlow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = scanGlow
      ctx.fillRect(0, 0, width, height)

      const laneGlow = ctx.createLinearGradient(width * 0.58, 0, width, 0)
      laneGlow.addColorStop(0, 'rgba(0,0,0,0)')
      laneGlow.addColorStop(0.3, hsl(stateConfig.hue, 92, 42, 0.03 + global.bloom * 0.02))
      laneGlow.addColorStop(1, hsl(stateConfig.accentHue, 90, 48, 0.05 + global.bloom * 0.04))
      ctx.fillStyle = laneGlow
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalAlpha = 0.08 + global.noise * 0.08
      ctx.strokeStyle = hsl(stateConfig.hue, 70, 74, 0.14)
      ctx.lineWidth = 1
      for (let x = width * 0.1; x < width; x += 42) {
        ctx.beginPath()
        ctx.moveTo(x + 0.5, height * 0.12)
        ctx.lineTo(x + 0.5, height * 0.88)
        ctx.stroke()
      }
      for (let y = height * 0.14; y < height * 0.88; y += 30) {
        ctx.beginPath()
        ctx.moveTo(width * 0.08, y + 0.5)
        ctx.lineTo(width * 0.92, y + 0.5)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = hsl(stateConfig.hue, 84, 72, 0.18)
      ctx.lineWidth = 4 + stateConfig.barGain * 5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(width * 0.08, scanY)
      ctx.lineTo(scanX - minDim * 0.08, scanY)
      ctx.stroke()
      ctx.strokeStyle = hsl(stateConfig.accentHue, 96, 76, 0.24 + listening * 0.12)
      for (let i = 0; i < 3; i += 1) {
        const pulse = ((time * (0.42 + stateConfig.scannerSpeed * 0.36)) + i * 0.28) % 1
        const x = mix(width * 0.08, scanX - minDim * 0.08, pulse)
        ctx.beginPath()
        ctx.moveTo(x - minDim * 0.025, scanY)
        ctx.lineTo(x + minDim * 0.025, scanY)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 78, 0.24 + thinking * 0.14)
      ctx.lineWidth = 1.2
      ctx.setLineDash([5, 7])
      ctx.beginPath()
      ctx.moveTo(scanX + minDim * 0.05, scanY - minDim * 0.02)
      ctx.quadraticCurveTo(width * 0.5, height * 0.2, reviewX - minDim * 0.05, reviewY)
      ctx.stroke()
      ctx.restore()

      lanes.forEach((lane, index) => {
        const laneHue = errorMode && index < 2 ? (index === 0 ? 4 : 18) : lane.hue
        const laneLoad = clamp(
          lane.weight * (2.8 + queueDepth * 6 + audioKick * 3 + speaking * 2 + thinking * 1.4 + errorMode * (index < 2 ? 3 : 1.2)),
          1,
          14
        )

        ctx.save()
        roundedRectPath(ctx, lane.x, lane.y, lane.width, lane.height, 18)
        const panel = ctx.createLinearGradient(lane.x, lane.y, lane.x + lane.width, lane.y + lane.height)
        panel.addColorStop(0, hsl(laneHue, 90, 18, 0.16 + global.backdrop * 0.06))
        panel.addColorStop(1, hsl(stateConfig.hue, 66, 12, 0.34 + global.backdrop * 0.06))
        ctx.fillStyle = panel
        ctx.fill()
        ctx.strokeStyle = hsl(laneHue, 100, 74, 0.28 + stateConfig.energy * 0.08)
        ctx.lineWidth = 1
        ctx.stroke()

        ctx.globalCompositeOperation = 'screen'
        const laneAura = ctx.createLinearGradient(lane.x, lane.centerY, lane.x + lane.width, lane.centerY)
        laneAura.addColorStop(0, hsl(laneHue, 100, 72, 0.03))
        laneAura.addColorStop(0.5, hsl(laneHue, 100, 70, 0.1 + stateConfig.pulse * 0.08))
        laneAura.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = laneAura
        roundedRectPath(ctx, lane.x + 1, lane.y + 1, lane.width - 2, lane.height - 2, 17)
        ctx.fill()
        ctx.restore()

        const barCount = Math.round(laneLoad)
        const barWidth = (lane.width - 92) / 14
        for (let i = 0; i < barCount; i += 1) {
          const barX = lane.x + 72 + i * (barWidth + 2)
          const barHeight = 12 + (i % 4) * 4 + stateConfig.barGain * 18
          const barY = lane.centerY - barHeight / 2
          ctx.fillStyle = hsl(laneHue, 100, 72, 0.14 + i * 0.014)
          roundedRectPath(ctx, barX, barY, barWidth, barHeight, 4)
          ctx.fill()
        }

        ctx.fillStyle = hsl(laneHue, 100, 82, 0.92)
        ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(lane.label, lane.x + 16, lane.y + 18)
        ctx.fillStyle = hsl(laneHue, 90, 78, 0.78)
        ctx.font = '700 13px "IBM Plex Mono", ui-monospace, monospace'
        ctx.textAlign = 'right'
        ctx.fillText(String(Math.round(laneLoad * 3)).padStart(2, '0'), lane.x + lane.width - 16, lane.y + 18)
        ctx.textAlign = 'left'

        ctx.save()
        ctx.strokeStyle = hsl(laneHue, 96, 72, 0.18 + speaking * 0.08)
        ctx.lineWidth = 1.1 + (index === 0 ? thinking * 0.5 : 0)
        ctx.beginPath()
        ctx.moveTo(scanX + minDim * 0.025, scanY)
        ctx.quadraticCurveTo(
          mix(scanX, lane.x, 0.48),
          mix(scanY, lane.centerY, 0.5) + (index - 1.5) * minDim * 0.05,
          lane.x - 8,
          lane.centerY
        )
        ctx.stroke()
        ctx.restore()

        if (errorMode && index < 2) {
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.fillStyle = hsl(0, 100, 60, 0.08 + index * 0.04)
          roundedRectPath(ctx, lane.x - 6, lane.y - 4, lane.width + 12, lane.height + 8, 20)
          ctx.fill()
          ctx.restore()
        }
      })

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const ringRadius = minDim * (0.055 + stateConfig.energy * 0.012)
      const ringGlow = ctx.createRadialGradient(scanX, scanY, 0, scanX, scanY, ringRadius * 2.8)
      ringGlow.addColorStop(0, hsl(stateConfig.accentHue, 100, 74, 0.18 + global.bloom * 0.08))
      ringGlow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = ringGlow
      ctx.beginPath()
      ctx.arc(scanX, scanY, ringRadius * 2.8, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.lineWidth = 2.1
      ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 78, 0.72)
      ctx.beginPath()
      ctx.arc(scanX, scanY, ringRadius, time * (0.5 + stateConfig.ringSpeed), time * (0.5 + stateConfig.ringSpeed) + Math.PI * 1.24)
      ctx.stroke()
      ctx.strokeStyle = hsl(stateConfig.hue, 100, 78, 0.44)
      ctx.beginPath()
      ctx.arc(scanX, scanY, ringRadius * 0.72, -time * (0.6 + stateConfig.ringSpeed), -time * (0.6 + stateConfig.ringSpeed) + Math.PI * 1.42)
      ctx.stroke()
      ctx.setLineDash([4, 6])
      ctx.strokeStyle = hsl(stateConfig.hue, 86, 74, 0.32 + thinking * 0.14)
      ctx.beginPath()
      ctx.arc(scanX, scanY, ringRadius * (1.18 + (stateConfig.orbitCount || 6) * 0.006), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      ctx.fillStyle = hsl(stateConfig.accentHue, 90, 82, 0.84)
      ctx.font = '600 10px "IBM Plex Sans", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('SCAN', scanX, scanY - ringRadius - 14)
      ctx.textAlign = 'left'

      ctx.save()
      const reviewRadius = minDim * (0.043 + reviewFocus * 0.012)
      const reviewGlow = ctx.createRadialGradient(reviewX, reviewY, 0, reviewX, reviewY, reviewRadius * 2.8)
      reviewGlow.addColorStop(0, hsl(stateConfig.accentHue, 100, 72, 0.1 + reviewFocus * 0.08))
      reviewGlow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = reviewGlow
      ctx.beginPath()
      ctx.arc(reviewX, reviewY, reviewRadius * 2.8, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 80, 0.44 + thinking * 0.18 + speaking * 0.14)
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(reviewX, reviewY, reviewRadius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([4, 5])
      ctx.strokeStyle = hsl(stateConfig.hue, 88, 74, 0.24 + reviewFocus * 0.08)
      ctx.beginPath()
      ctx.arc(reviewX, reviewY, reviewRadius * 1.34, time, time + Math.PI * 1.6)
      ctx.stroke()
      ctx.restore()

      roundedRectPath(ctx, reviewX - 16, reviewY - 10, 32, 20, 6)
      ctx.fillStyle = hsl(0, 0, 100, 0.88)
      ctx.fill()
      ctx.fillStyle = hsl(stateConfig.accentHue, 90, 18, 0.82)
      roundedRectPath(ctx, reviewX - 13, reviewY - 7, 26, 14, 5)
      ctx.fill()
      ctx.fillStyle = hsl(stateConfig.accentHue, 100, 82, 0.88)
      ctx.font = '600 9px "IBM Plex Sans", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('HITL', reviewX, reviewY + reviewRadius + 16)
      ctx.textAlign = 'left'

      cards.forEach((card, index) => {
        const lane = lanes[(errorMode && index % 13 === 0) ? (card.laneIndex + 1) % lanes.length : card.laneIndex]
        const laneHue = errorMode && index % 13 === 0 ? 0 : lane.hue
        const speed = 0.12 + stateConfig.scannerSpeed * 0.26 + stateConfig.barGain * 0.04 + card.rail * 0.004
        const progress = (time * speed + card.offset) % 1
        const startY = mix(height * 0.24, height * 0.76, (Math.sin(card.seed * 1.17) + 1) * 0.5)
        const gatherDuration = clamp(0.38 + listening * 0.1 - sortSnap * 0.08, 0.22, 0.46)
        const holdDuration = clamp(0.08 + listening * 0.08 + thinking * 0.08 - sortSnap * 0.04, 0.04, 0.2)
        const routeStart = gatherDuration + holdDuration
        const jammed = errorMode && card.rail % 5 === 0 && progress > gatherDuration * 0.6 && progress < routeStart + 0.12
        let x
        let y
        let alpha = 0.52 + audioKick * 0.12

        if (progress < gatherDuration) {
          const local = ease(progress / gatherDuration)
          x = mix(intakeX, scanX - minDim * 0.065, local)
          y = mix(startY, scanY + (card.laneIndex - 1.5) * minDim * 0.018, local) + Math.sin(card.seed + time * 1.8) * minDim * 0.004
          if (listening) alpha += 0.12
        } else if (progress < routeStart || jammed) {
          const local = jammed
            ? clamp((progress - gatherDuration * 0.6) / 0.16, 0, 1)
            : (progress - gatherDuration) / Math.max(0.01, holdDuration)
          const orbit = ringRadius * (0.42 + card.size * 0.12)
          x = scanX + Math.cos(card.seed * 0.9 + time * (1.1 + stateConfig.scannerSpeed)) * orbit * (0.8 + thinking * 0.2)
          y = scanY + Math.sin(card.seed * 1.2 + time * (1 + stateConfig.scannerSpeed * 0.8)) * orbit * (0.8 + thinking * 0.2)
          if (jammed) {
            x = mix(x, scanX - minDim * 0.022, local)
            y = mix(y, scanY + Math.sin(card.seed * 3) * minDim * 0.02, local)
            alpha *= 0.72
          } else {
            alpha += thinking * 0.14
          }
        } else {
          const local = ease((progress - routeStart) / (1 - routeStart))
          const point = pointOnQuadratic(
            scanX,
            scanY,
            mix(scanX, lane.x, 0.44),
            mix(scanY, lane.centerY, 0.5) + (card.laneIndex - 1.5) * minDim * 0.05 * (1.12 - sortSnap * 0.14),
            lane.x + lane.width * 0.54,
            lane.centerY + Math.sin(card.seed + time * 1.7) * lane.height * 0.08,
            local
          )
          x = point.x
          y = point.y
          alpha += speaking * 0.14
        }

        const cardWidth = (16 + card.size * 6 + stateConfig.barGain * 4) * (1 + speaking * 0.08)
        const cardHeight = 8 + card.size * 4
        const glowRadius = cardWidth * (1.6 + stateConfig.energy * 0.1)
        const flicker = errorMode && card.rail % 7 === 0 && Math.sin(time * 12 + card.seed) > 0.3
        if (flicker) return

        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius)
        glow.addColorStop(0, hsl(laneHue, 100, 74, alpha * 0.2))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(x, y, glowRadius, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        roundedRectPath(ctx, x - cardWidth / 2, y - cardHeight / 2, cardWidth, cardHeight, 4)
        ctx.fillStyle = hsl(stateConfig.hue, 46, 92, 0.84)
        ctx.fill()
        ctx.strokeStyle = hsl(laneHue, 100, 68, 0.72)
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = hsl(laneHue, 100, 64, 0.92)
        roundedRectPath(ctx, x - cardWidth / 2 + 2, y - cardHeight / 2 + 2, 4, cardHeight - 4, 2)
        ctx.fill()

        if (card.needsReview && progress > gatherDuration * 0.7 && progress < routeStart + 0.08) {
          ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 72, 0.42 + reviewFocus * 0.1)
          ctx.lineWidth = 1
          roundedRectPath(ctx, x - cardWidth / 2 - 2, y - cardHeight / 2 - 2, cardWidth + 4, cardHeight + 4, 5)
          ctx.stroke()
        }
      })

      if (speaking) {
        const focusLane = lanes[0]
        const cardX = focusLane.x + focusLane.width * 0.58
        const cardY = height * 0.14
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const beam = ctx.createLinearGradient(reviewX, reviewY, cardX, cardY)
        beam.addColorStop(0, hsl(stateConfig.accentHue, 100, 80, 0.12))
        beam.addColorStop(1, hsl(focusLane.hue, 100, 74, 0.24))
        ctx.strokeStyle = beam
        ctx.lineWidth = 3 + audioKick * 3
        ctx.beginPath()
        ctx.moveTo(reviewX, reviewY)
        ctx.quadraticCurveTo(width * 0.64, height * 0.08, cardX, cardY)
        ctx.stroke()
        ctx.restore()

        roundedRectPath(ctx, cardX - 44, cardY - 18, 88, 36, 10)
        ctx.fillStyle = hsl(focusLane.hue, 90, 20, 0.84)
        ctx.fill()
        ctx.strokeStyle = hsl(focusLane.hue, 100, 72, 0.82)
        ctx.lineWidth = 1.2
        ctx.stroke()
        ctx.fillStyle = hsl(focusLane.hue, 100, 82, 0.88)
        ctx.font = '600 10px "IBM Plex Sans", system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('SUMMARY', cardX, cardY - 3)
        ctx.font = '700 12px "IBM Plex Mono", ui-monospace, monospace'
        ctx.fillText('U-01', cardX, cardY + 10)
        ctx.textAlign = 'left'
      }

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        for (let i = 0; i < 6; i += 1) {
          const y = height * (0.2 + i * 0.1) + Math.sin(time * 9 + i) * minDim * 0.018
          ctx.strokeStyle = hsl(i % 2 === 0 ? 0 : 16, 100, 60, 0.08 + i * 0.018)
          ctx.lineWidth = 1 + (i % 3) * 0.6
          ctx.beginPath()
          ctx.moveTo(width * 0.08, y)
          ctx.lineTo(width * 0.56, y + Math.cos(time * 6 + i * 1.4) * minDim * 0.014)
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, cards, global, lanes, queueDepth, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
