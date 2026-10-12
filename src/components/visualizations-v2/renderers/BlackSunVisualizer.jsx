import { useEffect, useMemo, useRef, useState } from 'react'

const TROPICAL_PALETTE = {
  hue: 200,
  accentHue: 109
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
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

function getBasePreset(presetId) {
  if (presetId === 'blood-crown') {
    return {
      global: { backdrop: 0.94, bloom: 1.22, noise: 0.04 },
      states: {
        idle: { hue: 228, accentHue: 10, energy: 0.2, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 132, orbitCount: 5, jitter: 0.01 },
        listening: { hue: 210, accentHue: 24, energy: 0.34, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.16, barGain: 0.12, particleDensity: 146, orbitCount: 6, jitter: 0.01 },
        thinking: { hue: 248, accentHue: 18, energy: 0.74, pulse: 0.32, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.12, particleDensity: 166, orbitCount: 8, jitter: 0.02 },
        speaking: { hue: 196, accentHue: 6, energy: 1.06, pulse: 0.82, ringSpeed: 0.22, scannerSpeed: 0.12, barGain: 0.34, particleDensity: 162, orbitCount: 7, jitter: 0.02 },
        error: { hue: 356, accentHue: 16, energy: 1.2, pulse: 1.02, ringSpeed: 0.12, scannerSpeed: 0.32, barGain: 0.3, particleDensity: 156, orbitCount: 6, jitter: 0.12 }
      }
    }
  }

  if (presetId === 'gaia-lens') {
    return {
      global: { backdrop: 0.96, bloom: 1.24, noise: 0.03 },
      states: {
        idle: { hue: 200, accentHue: 109, energy: 0.24, pulse: 0.14, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 138, orbitCount: 5, jitter: 0.01 },
        listening: { hue: 200, accentHue: 109, energy: 0.4, pulse: 0.2, ringSpeed: 0.14, scannerSpeed: 0.16, barGain: 0.12, particleDensity: 152, orbitCount: 6, jitter: 0.01 },
        thinking: { hue: 200, accentHue: 109, energy: 0.84, pulse: 0.38, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.14, particleDensity: 172, orbitCount: 8, jitter: 0.02 },
        speaking: { hue: 200, accentHue: 109, energy: 1.16, pulse: 0.9, ringSpeed: 0.24, scannerSpeed: 0.12, barGain: 0.36, particleDensity: 168, orbitCount: 7, jitter: 0.02 },
        error: { hue: 12, accentHue: 109, energy: 1.14, pulse: 0.96, ringSpeed: 0.12, scannerSpeed: 0.3, barGain: 0.28, particleDensity: 160, orbitCount: 6, jitter: 0.11 }
      }
    }
  }

  if (presetId === 'tropical-iris') {
    return {
      global: { backdrop: 0.96, bloom: 1.2, noise: 0.03 },
      states: {
        idle: { hue: 200, accentHue: 109, energy: 0.22, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 136, orbitCount: 5, jitter: 0.01 },
        listening: { hue: 200, accentHue: 109, energy: 0.36, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.16, barGain: 0.12, particleDensity: 150, orbitCount: 6, jitter: 0.01 },
        thinking: { hue: 200, accentHue: 109, energy: 0.78, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.12, particleDensity: 170, orbitCount: 8, jitter: 0.02 },
        speaking: { hue: 200, accentHue: 109, energy: 1.12, pulse: 0.86, ringSpeed: 0.24, scannerSpeed: 0.12, barGain: 0.34, particleDensity: 166, orbitCount: 7, jitter: 0.02 },
        error: { hue: 200, accentHue: 109, energy: 1.18, pulse: 0.96, ringSpeed: 0.12, scannerSpeed: 0.3, barGain: 0.28, particleDensity: 160, orbitCount: 6, jitter: 0.11 }
      }
    }
  }

  return {
    global: { backdrop: 0.96, bloom: 1.18, noise: 0.03 },
    states: {
      idle: { hue: 206, accentHue: 40, energy: 0.22, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 136, orbitCount: 5, jitter: 0.01 },
      listening: { hue: 194, accentHue: 176, energy: 0.36, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.16, barGain: 0.12, particleDensity: 150, orbitCount: 6, jitter: 0.01 },
      thinking: { hue: 218, accentHue: 50, energy: 0.78, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.12, particleDensity: 170, orbitCount: 8, jitter: 0.02 },
      speaking: { hue: 188, accentHue: 20, energy: 1.12, pulse: 0.86, ringSpeed: 0.24, scannerSpeed: 0.12, barGain: 0.34, particleDensity: 166, orbitCount: 7, jitter: 0.02 },
      error: { hue: 0, accentHue: 26, energy: 1.18, pulse: 0.96, ringSpeed: 0.12, scannerSpeed: 0.3, barGain: 0.28, particleDensity: 160, orbitCount: 6, jitter: 0.11 }
    }
  }
}

export function getBlackSunConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  const global = { ...base.global, ...(overrides?.global || {}) }
  const baseState = { ...(base.states[state] || base.states.idle) }
  const stateOverride = overrides?.states?.[state] || {}
  const merged = { ...baseState, ...stateOverride }

  if (presetId === 'tropical-iris') {
    merged.hue = TROPICAL_PALETTE.hue
    merged.accentHue = TROPICAL_PALETTE.accentHue
  }

  return { global, state: merged }
}

export default function BlackSunVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const sparksRef = useRef([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'event-horizon'
  const { global, state: stateConfig } = useMemo(
    () => getBlackSunConfig(presetId, assignment?.overrides, state),
    [assignment, presetId, state]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const parent = canvas.parentElement
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect?.width && rect?.height) {
        setSize({ width: rect.width, height: rect.height })
      }
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = Math.max(120, Math.round((stateConfig.particleDensity || 136) * 2.4))
    if (sparksRef.current.length === target) return
    const width = size.width || 800
    const height = size.height || 800
    const cx = width / 2
    const cy = height / 2
    const minR = Math.min(width, height) * 0.14
    const maxR = Math.min(width, height) * 0.44
    sparksRef.current = new Array(target).fill(null).map((_, index) => {
      const angle = Math.random() * Math.PI * 2
      const radial = minR + Math.random() * (maxR - minR)
      return {
        x: cx + Math.cos(angle) * radial,
        y: cy + Math.sin(angle) * radial,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        seed: Math.random() * 1000,
        depth: Math.random(),
        lane: index % 12,
        charge: Math.random() > 0.5 ? 1 : -1
      }
    })
  }, [size.height, size.width, stateConfig.particleDensity])

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
      const cx = width / 2
      const cy = height / 2
      const minDim = Math.min(width, height)
      const energy = getAudioEnergy(audioData)
      const audioKick = energy * 0.9
      const tropical = presetId === 'tropical-iris'
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const listening = state === 'listening' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const idleMode = state === 'idle' ? 1 : 0

      const idleTargets = [
        { x: -0.022, y: -0.01 },
        { x: 0.028, y: -0.024 },
        { x: -0.032, y: -0.018 },
        { x: 0.018, y: -0.012 }
      ]
      const idlePhase = time * 0.12
      const idleIndex = ((Math.floor(idlePhase) % idleTargets.length) + idleTargets.length) % idleTargets.length
      const nextIndex = (idleIndex + 1) % idleTargets.length
      const idleTravel = clamp((idlePhase % 1 - 0.62) / 0.38, 0, 1)
      const idleBlend = 0.5 - Math.cos(idleTravel * Math.PI) * 0.5
      const idleTarget = {
        x: idleTargets[idleIndex].x + (idleTargets[nextIndex].x - idleTargets[idleIndex].x) * idleBlend,
        y: idleTargets[idleIndex].y + (idleTargets[nextIndex].y - idleTargets[idleIndex].y) * idleBlend
      }
      const thinkingSign = Math.sign(Math.sin(time * 0.72)) || 1
      const errorStepX = Math.sign(Math.sin(time * 2.2)) * minDim * 0.02
      const errorStepY = Math.sign(Math.cos(time * 2.8)) * minDim * 0.012
      const gazeX = cx + (tropical && idleMode ? idleTarget.x * minDim : 0) + (tropical && thinking ? thinkingSign * minDim * 0.024 : 0) + (tropical && errorMode ? errorStepX : 0)
      const gazeY = cy + (tropical && idleMode ? idleTarget.y * minDim : 0) - (tropical && thinking ? minDim * 0.032 : 0) - (tropical && errorMode ? minDim * 0.012 : 0) + (tropical && errorMode ? errorStepY : 0)
      const coreRadius = minDim * (0.12 + stateConfig.energy * 0.03) * (tropical && errorMode ? 0.92 : 1)
      const coronaRadius = coreRadius * (1.52 + stateConfig.pulse * 0.24) * (tropical && errorMode ? 0.88 : 1)
      const outerRadius = minDim * 0.46

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const backdrop = ctx.createRadialGradient(cx, cy, coreRadius * 0.2, cx, cy, outerRadius * 1.1)
      backdrop.addColorStop(0, hsl(stateConfig.accentHue, 98, 54, 0.03))
      backdrop.addColorStop(0.32, hsl(stateConfig.hue, 96, 36, 0.03 + global.bloom * 0.03))
      backdrop.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = backdrop
      ctx.beginPath()
      ctx.arc(cx, cy, outerRadius * 1.1, 0, Math.PI * 2)
      ctx.fill()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < 5; i += 1) {
        const arcRadius = coronaRadius * (1 + i * 0.17) + Math.sin(time * (0.8 + i * 0.1) + i) * 10
        ctx.strokeStyle = hsl(i % 2 === 0 ? stateConfig.accentHue : stateConfig.hue, 98, 72, 0.04 + i * 0.018 + audioKick * 0.03)
        ctx.lineWidth = 1 + i * 0.3
        ctx.beginPath()
        ctx.arc(cx, cy, arcRadius, time * 0.14 + i, time * 0.14 + i + Math.PI * (0.26 + speaking * 0.08))
        ctx.stroke()
      }
      ctx.restore()

      const swirlBase = 0.003 + stateConfig.ringSpeed * 0.004
      const pullBase = 0.0016 + stateConfig.energy * 0.0018
      const maxSpeed = 0.82 + stateConfig.energy * 1.2
      const sparks = sparksRef.current
      for (let i = 0; i < sparks.length; i += 1) {
        const spark = sparks[i]
        const dx = spark.x - gazeX
        const dy = spark.y - gazeY
        const dist = Math.max(1, Math.hypot(dx, dy))
        const nx = dx / dist
        const ny = dy / dist
        const tangentX = -ny
        const tangentY = nx
        const shellTarget =
          coronaRadius * (1.18 + spark.depth * 0.8) +
          Math.sin(time * (1.2 + stateConfig.pulse * 1.8) + spark.seed) * (8 + stateConfig.pulse * 16) +
          thinking * Math.sin(time * 2.8 + spark.seed * 0.4) * 18
        const shellError = dist - shellTarget
        spark.vx -= nx * shellError * pullBase
        spark.vy -= ny * shellError * pullBase

        const swirl = swirlBase * (1 + spark.depth * 0.7 + speaking * 0.8 + audioKick * 0.6) * spark.charge
        spark.vx += tangentX * swirl
        spark.vy += tangentY * swirl

        if (listening) {
          const leanX = gazeX - width * 0.08
          const leanY = gazeY - coreRadius * 0.12
          spark.vx += (leanX - spark.x) * 0.00035
          spark.vy += (leanY - spark.y) * 0.00035
        }
        if (speaking) {
          const eruption = Math.sin(time * 6.2 + spark.seed * 0.8) * (0.008 + stateConfig.barGain * 0.04 + audioKick * 0.05)
          spark.vx += nx * eruption
          spark.vy += ny * eruption
        }
        if (thinking) {
          const recursion = Math.sin(time * 2.4 + spark.seed * 1.4) * 0.012
          spark.vx += tangentX * recursion
          spark.vy += tangentY * recursion
        }
        if (errorMode) {
          spark.vx += (Math.random() - 0.5) * stateConfig.jitter * 0.22
          spark.vy += (Math.random() - 0.5) * stateConfig.jitter * 0.22
        }

        spark.vx += Math.sin(spark.seed * 1.7 + time * (1 + stateConfig.scannerSpeed * 1.5)) * 0.006
        spark.vy += Math.cos(spark.seed * 1.3 - time * (0.9 + stateConfig.ringSpeed * 1.2)) * 0.006
        spark.vx *= 0.928
        spark.vy *= 0.928

        const speed = Math.hypot(spark.vx, spark.vy)
        if (speed > maxSpeed) {
          spark.vx = (spark.vx / speed) * maxSpeed
          spark.vy = (spark.vy / speed) * maxSpeed
        }

        spark.x += spark.vx
        spark.y += spark.vy

        const newDx = spark.x - gazeX
        const newDy = spark.y - gazeY
        const newDist = Math.max(1, Math.hypot(newDx, newDy))
        if (newDist < coreRadius * 1.08) {
          spark.x = gazeX + (newDx / newDist) * coreRadius * 1.08
          spark.y = gazeY + (newDy / newDist) * coreRadius * 1.08
          spark.vx += (newDx / newDist) * 0.06
          spark.vy += (newDy / newDist) * 0.06
        } else if (newDist > outerRadius) {
          spark.x = gazeX + (newDx / newDist) * outerRadius
          spark.y = gazeY + (newDy / newDist) * outerRadius
          spark.vx *= 0.8
          spark.vy *= 0.8
        }
      }

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < 14; i += 1) {
        const angle = time * (0.16 + i * 0.006) + (i / 14) * Math.PI * 2
        const startR = coreRadius * (1.06 + (i % 3) * 0.06)
        const endR = coronaRadius * (1.55 + (i % 4) * 0.16) + speaking * 24 + Math.sin(time * 3.2 + i) * 14
        const ctrlR = (startR + endR) * 0.56
        const c1x = gazeX + Math.cos(angle + Math.sin(time * 1.2 + i) * 0.22) * ctrlR
        const c1y = gazeY + Math.sin(angle + Math.sin(time * 1.2 + i) * 0.22) * ctrlR
        const c2x = gazeX + Math.cos(angle + 0.42 + Math.cos(time * 1.6 + i) * 0.3) * (ctrlR * 1.18)
        const c2y = gazeY + Math.sin(angle + 0.42 + Math.cos(time * 1.6 + i) * 0.3) * (ctrlR * 1.18)
        const sx = gazeX + Math.cos(angle) * startR
        const sy = gazeY + Math.sin(angle) * startR
        const ex = gazeX + Math.cos(angle + Math.sin(time * 0.9 + i) * 0.26) * endR
        const ey = gazeY + Math.sin(angle + Math.sin(time * 0.9 + i) * 0.26) * endR
        ctx.strokeStyle = hsl(i % 2 === 0 ? stateConfig.accentHue : stateConfig.hue, 100, 72, 0.08 + speaking * 0.05 + audioKick * 0.04)
        ctx.lineWidth = 0.9 + (i % 3) * 0.45
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey)
        ctx.stroke()
      }
      ctx.restore()

      if (tropical) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const striationCount = 34
        for (let i = 0; i < striationCount; i += 1) {
          const angle = (i / striationCount) * Math.PI * 2 + Math.sin(time * 0.22 + i * 0.7) * 0.08
          const startR = coreRadius * (1.05 + (i % 3) * 0.02)
          const midR = coreRadius * (1.4 + (i % 4) * 0.08)
          const endR = coronaRadius * (1.02 + (i % 5) * 0.06)
          const bend = Math.sin(time * 1.1 + i * 0.6) * 0.12
          ctx.strokeStyle = hsl(i % 4 === 0 ? stateConfig.accentHue : stateConfig.hue, 100, 74, 0.07 + audioKick * 0.04 + thinking * 0.03)
          ctx.lineWidth = 0.9 + (i % 3) * 0.25
          ctx.beginPath()
          ctx.moveTo(gazeX + Math.cos(angle) * startR, gazeY + Math.sin(angle) * startR)
          ctx.quadraticCurveTo(
            gazeX + Math.cos(angle + bend) * midR,
            gazeY + Math.sin(angle + bend) * midR,
            gazeX + Math.cos(angle) * endR,
            gazeY + Math.sin(angle) * endR
          )
          ctx.stroke()
        }
        ctx.restore()
      }

      const sorted = sparks.slice().sort((a, b) => a.depth - b.depth)
      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < sorted.length; i += 1) {
        const spark = sorted[i]
        const dx = spark.x - cx
        const dy = spark.y - cy
        const distRatio = clamp(Math.hypot(dx, dy) / outerRadius, 0, 1.2)
        const edgeBias = 1 - Math.abs(distRatio - 0.45)
        const hue = spark.depth > 0.76 || spark.lane % 5 === 0 ? stateConfig.accentHue : stateConfig.hue
        const sizeFactor = 0.42 + spark.depth * 1.18 + edgeBias * 0.6 + audioKick * 0.26
        const alpha = 0.03 + spark.depth * 0.14 + edgeBias * 0.05
        ctx.fillStyle = hsl(hue, 100, 72, alpha * 0.12)
        ctx.beginPath()
        ctx.arc(spark.x, spark.y, sizeFactor * 3.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = hsl(hue, 100, 70, alpha * 0.28)
        ctx.beginPath()
        ctx.arc(spark.x, spark.y, sizeFactor * 1.8, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = hsl(hue, 98, 86, Math.min(0.92, alpha * 1.3))
        ctx.beginPath()
        ctx.arc(spark.x, spark.y, Math.max(0.32, sizeFactor * 0.48), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < 6; i += 1) {
        const radius = coronaRadius * (1.08 + i * 0.18) + Math.sin(time * 2.6 - i) * (10 + i * 2)
        const alpha = 0.018 + i * 0.012 + speaking * 0.02 + audioKick * 0.03
        ctx.strokeStyle = hsl(i % 2 === 0 ? stateConfig.accentHue : stateConfig.hue, 100, 74, alpha)
        ctx.lineWidth = 1.1 + i * 0.26
        ctx.beginPath()
        ctx.arc(gazeX, gazeY, radius, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()

      if (speaking || listening) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const rayCount = speaking ? 26 : 18
        for (let i = 0; i < rayCount; i += 1) {
          const angle = (i / rayCount) * Math.PI * 2 + Math.sin(time * 1.8 + i) * 0.03
          const inner = coreRadius * 1.1
          const outer = coronaRadius * (2.1 + (speaking ? 0.55 : 0.2)) + Math.sin(time * 5.2 + i * 0.4) * 18
          ctx.strokeStyle = hsl(speaking ? stateConfig.accentHue : stateConfig.hue, 100, 72, 0.03 + audioKick * 0.06 + (speaking ? 0.05 : 0.02))
          ctx.lineWidth = speaking ? 1.2 + (i % 3) * 0.35 : 0.8
          ctx.beginPath()
          ctx.moveTo(gazeX + Math.cos(angle) * inner, gazeY + Math.sin(angle) * inner)
          ctx.lineTo(gazeX + Math.cos(angle) * outer, gazeY + Math.sin(angle) * outer)
          ctx.stroke()
        }
        ctx.restore()
      }

      ctx.save()
      const umbra = ctx.createRadialGradient(gazeX, gazeY, 0, gazeX, gazeY, coreRadius * 1.6)
      umbra.addColorStop(0, 'rgba(0, 0, 0, 1)')
      umbra.addColorStop(0.7, 'rgba(0, 0, 0, 0.98)')
      umbra.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = umbra
      ctx.beginPath()
      ctx.arc(gazeX, gazeY, coreRadius * 1.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(0,0,0,1)'
      ctx.beginPath()
      ctx.arc(gazeX, gazeY, coreRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const corona = ctx.createRadialGradient(gazeX, gazeY, coreRadius * 0.96, gazeX, gazeY, coreRadius * 1.9)
      corona.addColorStop(0, 'rgba(0, 0, 0, 0)')
      corona.addColorStop(0.3, hsl(stateConfig.accentHue, 100, 76, 0.18 + audioKick * 0.1))
      corona.addColorStop(0.55, hsl(stateConfig.hue, 98, 58, 0.06 + thinking * 0.03))
      corona.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = corona
      ctx.beginPath()
      ctx.arc(gazeX, gazeY, coreRadius * 1.9, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      if (tropical) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const innerLift = ctx.createRadialGradient(gazeX, gazeY, coreRadius * 0.94, gazeX, gazeY, coreRadius * 2.35)
        innerLift.addColorStop(0, 'rgba(0, 0, 0, 0)')
        innerLift.addColorStop(0.24, hsl(stateConfig.hue, 100, 58, 0.18 + audioKick * 0.06))
        innerLift.addColorStop(0.46, hsl(stateConfig.accentHue, 100, 50, 0.14 + thinking * 0.03))
        innerLift.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = innerLift
        ctx.beginPath()
        ctx.arc(gazeX, gazeY, coreRadius * 2.35, 0, Math.PI * 2)
        ctx.fill()

        const catchlight = ctx.createRadialGradient(gazeX - coreRadius * 0.36, gazeY - coreRadius * 0.46, 0, gazeX - coreRadius * 0.36, gazeY - coreRadius * 0.46, coreRadius * 0.9)
        catchlight.addColorStop(0, 'rgba(255,255,255,0.18)')
        catchlight.addColorStop(0.32, hsl(stateConfig.hue, 100, 86, 0.11))
        catchlight.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = catchlight
        ctx.beginPath()
        ctx.arc(gazeX - coreRadius * 0.28, gazeY - coreRadius * 0.34, coreRadius * 0.7, 0, Math.PI * 2)
        ctx.fill()

        const catchlight2 = ctx.createRadialGradient(gazeX + coreRadius * 0.18, gazeY + coreRadius * 0.08, 0, gazeX + coreRadius * 0.18, gazeY + coreRadius * 0.08, coreRadius * 0.5)
        catchlight2.addColorStop(0, 'rgba(255,255,255,0.1)')
        catchlight2.addColorStop(0.42, hsl(stateConfig.accentHue, 100, 84, 0.08))
        catchlight2.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = catchlight2
        ctx.beginPath()
        ctx.ellipse(gazeX + coreRadius * 0.16, gazeY + coreRadius * 0.1, coreRadius * 0.28, coreRadius * 0.18, 0.24, 0, Math.PI * 2)
        ctx.fill()

        const cornealSheen = ctx.createLinearGradient(gazeX - coronaRadius * 1.1, gazeY - coronaRadius * 0.8, gazeX + coronaRadius * 1.1, gazeY + coronaRadius * 0.8)
        cornealSheen.addColorStop(0, 'rgba(255,255,255,0)')
        cornealSheen.addColorStop(0.28, 'rgba(255,255,255,0.045)')
        cornealSheen.addColorStop(0.5, hsl(stateConfig.hue, 100, 90, 0.075))
        cornealSheen.addColorStop(0.72, 'rgba(255,255,255,0.03)')
        cornealSheen.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.strokeStyle = cornealSheen
        ctx.lineWidth = coreRadius * 0.18
        ctx.beginPath()
        ctx.ellipse(gazeX, gazeY, coronaRadius * 1.18, coronaRadius * 0.82, 0.18, Math.PI * 1.1, Math.PI * 1.82)
        ctx.stroke()

        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.ellipse(gazeX - coreRadius * 0.08, gazeY - coreRadius * 0.12, coronaRadius * 0.72, coronaRadius * 0.42, -0.22, Math.PI * 1.16, Math.PI * 1.8)
        ctx.stroke()

        ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 66, 0.12)
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(gazeX, gazeY, coreRadius * 1.18, 0, Math.PI * 2)
        ctx.stroke()

        ctx.strokeStyle = hsl(stateConfig.hue, 100, 68, 0.08)
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.arc(gazeX, gazeY, coreRadius * 1.34, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }

      if (errorMode) {
        ctx.save()
        ctx.globalAlpha = 0.26
        for (let i = 0; i < 11; i += 1) {
          const y = height * (i / 11) + Math.sin(time * 9.2 + i) * 18
          ctx.fillStyle = hsl(i % 2 === 0 ? stateConfig.hue : stateConfig.accentHue, 92, 56, 0.05)
          ctx.fillRect(width * 0.12, y, width * 0.76, 2 + (i % 4))
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global.backdrop, global.bloom, presetId, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
