import { useEffect, useMemo, useRef, useState } from 'react'

const BRAND_CYAN = [56, 189, 248]
const BRAND_INDIGO = [99, 102, 241]
const BRAND_VIOLET = [168, 85, 247]

const HORNED_Q_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 740">
    <defs>
      <linearGradient id="cqGrad" x1="0" y1="0" x2="620" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#38bdf8" />
        <stop offset="55%" stop-color="#6366f1" />
        <stop offset="100%" stop-color="#a855f7" />
      </linearGradient>
    </defs>
    <g transform="translate(96,30) scale(0.72)">
      <path d="M450.532 359.603L400.532 273C565.532 211.001 473.032 164 488.532 94.5C504.032 25 546.032 0 546.032 0C546.032 0 521.173 49.0536 522.532 85.5C524.38 135.078 577.449 175.548 576.032 227.5C573.947 303.958 450.532 359.603 450.532 359.603Z" fill="url(#cqGrad)"/>
      <path d="M125.528 359.603L175.528 273C10.5279 211.001 103.028 164 87.5279 94.5C72.0279 25 30.0279 0 30.0279 0C30.0279 0 54.8869 49.0536 53.5279 85.5C51.6792 135.078 -1.38893 175.548 0.0278679 227.5C2.113 303.958 125.528 359.603 125.528 359.603Z" fill="url(#cqGrad)"/>
    </g>
    <g transform="translate(50,200)">
      <path d="M262.181 1.92871C284.097 2.34428 321.484 3.59138 348.179 7.35156C400.234 14.6836 431.354 36.4934 464.679 77.9629C511.474 136.194 506.182 266.278 506.179 266.352H506.035C506.405 278.968 508.307 382.893 472.884 441.409L537.178 497.719L529.178 566.719H427.178L377.932 517.592C368.718 520.411 358.808 522.563 347.994 524.086C321.446 527.825 284.325 529.078 262.361 529.501V529.719C262.361 529.719 258.937 529.716 253.178 529.646C247.426 529.716 244.003 529.719 243.994 529.719V529.501C222.03 529.078 184.909 527.825 158.361 524.086C106.307 516.754 75.1863 494.944 41.8611 453.475C-2.24106 398.594 -0.0773581 279.892 0.320081 266.352H0.181409C0.178448 266.279 -5.11349 136.194 41.6814 77.9629C75.0066 36.4934 106.127 14.6836 158.181 7.35156C184.877 3.59139 222.263 2.34428 244.179 1.92871V1.71875C244.188 1.71875 247.539 1.72075 253.18 1.78809C258.829 1.72067 262.181 1.71875 262.181 1.71875V1.92871ZM253.18 84.8887C211.412 85.2342 162.416 88.5837 138.181 112.352C112.356 137.68 106.629 202.685 106.68 265.086H106.861C106.732 327.871 112.361 393.586 138.361 419.086C162.56 442.819 211.449 446.192 253.178 446.546C269.601 446.407 287.132 445.8 303.832 443.668L234.178 374.181V316.719H330.511L389.933 368.762C395.717 338.812 396.569 301.457 396.494 265.086H396.68C396.771 202.685 394.005 137.68 368.179 112.352C343.945 88.5837 294.949 85.2342 253.18 84.8887Z" fill="url(#cqGrad)"/>
    </g>
  </svg>
`

const HORNED_Q_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(HORNED_Q_SVG)}`

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function mix(a, b, amount) {
  return a + (b - a) * amount
}

function rgba([r, g, b], alpha = 1) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`
}

function mixColor(a, b, amount) {
  return [
    mix(a[0], b[0], amount),
    mix(a[1], b[1], amount),
    mix(a[2], b[2], amount)
  ]
}

function brandColorAt(position, alpha = 1) {
  const t = ((position % 1) + 1) % 1
  if (t < 0.5) return rgba(mixColor(BRAND_CYAN, BRAND_INDIGO, t * 2), alpha)
  return rgba(mixColor(BRAND_INDIGO, BRAND_VIOLET, (t - 0.5) * 2), alpha)
}

function getAudioEnergy(audioData) {
  if (!audioData?.length) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i += 1) sum += audioData[i]
  return sum / audioData.length / 255
}

function getAudioSample(audioData, normalized) {
  if (!audioData?.length) return 0
  const index = Math.floor(clamp(normalized, 0, 0.9999) * (audioData.length - 1))
  return (audioData[index] || 0) / 255
}

function addBrandStops(gradient, alpha = 1) {
  gradient.addColorStop(0, brandColorAt(0, alpha))
  gradient.addColorStop(0.52, brandColorAt(0.52, alpha))
  gradient.addColorStop(1, brandColorAt(1, alpha))
  return gradient
}

function getBasePreset(presetId) {
  if (presetId === 'crown-scope') {
    return {
      global: { backdrop: 0.92, bloom: 1.18, noise: 0.05, crownGlow: 0.82, scopeRadius: 1.14 },
      states: {
        idle: { hue: 197, accentHue: 268, energy: 0.22, pulse: 0.1, ringSpeed: 0.08, scannerSpeed: 0.14, barGain: 0.22, particleDensity: 84, orbitCount: 8, jitter: 0.01, voiceRipple: 0.42, delegation: 0.34 },
        listening: { hue: 197, accentHue: 268, energy: 0.36, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.22, barGain: 0.3, particleDensity: 98, orbitCount: 9, jitter: 0.01, voiceRipple: 0.64, delegation: 0.42 },
        thinking: { hue: 197, accentHue: 268, energy: 0.64, pulse: 0.28, ringSpeed: 0.16, scannerSpeed: 0.18, barGain: 0.38, particleDensity: 110, orbitCount: 10, jitter: 0.02, voiceRipple: 0.58, delegation: 0.74 },
        speaking: { hue: 197, accentHue: 268, energy: 0.94, pulse: 0.76, ringSpeed: 0.22, scannerSpeed: 0.2, barGain: 0.56, particleDensity: 118, orbitCount: 10, jitter: 0.02, voiceRipple: 1.16, delegation: 0.48 },
        error: { hue: 197, accentHue: 268, energy: 1.08, pulse: 0.86, ringSpeed: 0.14, scannerSpeed: 0.34, barGain: 0.62, particleDensity: 116, orbitCount: 8, jitter: 0.14, voiceRipple: 0.92, delegation: 0.42 }
      }
    }
  }

  if (presetId === 'relay-halo') {
    return {
      global: { backdrop: 0.86, bloom: 1.06, noise: 0.06, crownGlow: 0.74, scopeRadius: 1.04 },
      states: {
        idle: { hue: 197, accentHue: 268, energy: 0.2, pulse: 0.1, ringSpeed: 0.06, scannerSpeed: 0.1, barGain: 0.16, particleDensity: 78, orbitCount: 8, jitter: 0.01, voiceRipple: 0.36, delegation: 0.74 },
        listening: { hue: 197, accentHue: 268, energy: 0.34, pulse: 0.18, ringSpeed: 0.1, scannerSpeed: 0.16, barGain: 0.24, particleDensity: 94, orbitCount: 9, jitter: 0.01, voiceRipple: 0.54, delegation: 0.96 },
        thinking: { hue: 197, accentHue: 268, energy: 0.68, pulse: 0.3, ringSpeed: 0.18, scannerSpeed: 0.16, barGain: 0.3, particleDensity: 106, orbitCount: 11, jitter: 0.02, voiceRipple: 0.52, delegation: 1.2 },
        speaking: { hue: 197, accentHue: 268, energy: 0.96, pulse: 0.72, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.42, particleDensity: 114, orbitCount: 11, jitter: 0.02, voiceRipple: 1.02, delegation: 1.08 },
        error: { hue: 197, accentHue: 268, energy: 1.08, pulse: 0.82, ringSpeed: 0.14, scannerSpeed: 0.28, barGain: 0.48, particleDensity: 108, orbitCount: 9, jitter: 0.16, voiceRipple: 0.8, delegation: 0.88 }
      }
    }
  }

  return {
    global: { backdrop: 0.88, bloom: 1.1, noise: 0.04, crownGlow: 0.96, scopeRadius: 0.98 },
    states: {
      idle: { hue: 197, accentHue: 268, energy: 0.18, pulse: 0.08, ringSpeed: 0.06, scannerSpeed: 0.1, barGain: 0.16, particleDensity: 76, orbitCount: 7, jitter: 0.01, voiceRipple: 0.4, delegation: 0.42 },
      listening: { hue: 197, accentHue: 268, energy: 0.32, pulse: 0.16, ringSpeed: 0.1, scannerSpeed: 0.18, barGain: 0.22, particleDensity: 90, orbitCount: 8, jitter: 0.01, voiceRipple: 0.64, delegation: 0.54 },
      thinking: { hue: 197, accentHue: 268, energy: 0.58, pulse: 0.24, ringSpeed: 0.16, scannerSpeed: 0.14, barGain: 0.28, particleDensity: 102, orbitCount: 9, jitter: 0.02, voiceRipple: 0.46, delegation: 0.84 },
      speaking: { hue: 197, accentHue: 268, energy: 0.92, pulse: 0.74, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.4, particleDensity: 110, orbitCount: 9, jitter: 0.02, voiceRipple: 1.18, delegation: 0.62 },
      error: { hue: 197, accentHue: 268, energy: 1.08, pulse: 0.84, ringSpeed: 0.14, scannerSpeed: 0.3, barGain: 0.5, particleDensity: 106, orbitCount: 8, jitter: 0.16, voiceRipple: 0.92, delegation: 0.56 }
    }
  }
}

export function getCommanderSigilConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

export default function CommanderSigilVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const imageRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'sovereign-pulse'
  const { global, state: stateConfig } = useMemo(
    () => getCommanderSigilConfig(presetId, assignment?.overrides, state),
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

  useEffect(() => {
    const image = new Image()
    image.decoding = 'async'
    image.src = HORNED_Q_URL
    imageRef.current = image
    return () => {
      imageRef.current = null
    }
  }, [])

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
      const cx = width / 2
      const cy = height / 2
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const audioKick = getAudioEnergy(audioData) * 0.95
      const crownGlow = clamp(global.crownGlow ?? 0.96, 0.2, 1.4)
      const scopeRadius = clamp(global.scopeRadius ?? 1, 0.76, 1.3)
      const voiceRipple = clamp(stateConfig.voiceRipple ?? 0.64, 0.2, 1.5)
      const delegation = clamp(stateConfig.delegation ?? 0.62, 0.1, 1.5)
      const relayPreset = presetId === 'relay-halo'
      const scopePreset = presetId === 'crown-scope'
      const coreRadius = minDim * (0.12 + stateConfig.energy * 0.018)
      const waveRadius = minDim * (0.29 + (scopeRadius - 1) * 0.08 + (scopePreset ? 0.015 : 0))
      const waveAmplitude = minDim * (0.012 + stateConfig.barGain * 0.018 + audioKick * 0.016 + voiceRipple * 0.008)
      const logoHeight = minDim * (scopePreset ? 0.34 : 0.38) * (1 + stateConfig.energy * 0.04)
      const logoWidth = logoHeight * (620 / 740)
      const logoX = cx - logoWidth / 2
      const logoY = cy - logoHeight / 2 - minDim * 0.02
      const nodeCount = Math.max(6, Math.round(4 + stateConfig.orbitCount * 0.8))
      const orbitRadius = minDim * (0.38 + delegation * 0.045)
      const showRelay = relayPreset || thinking || delegation > 0.72

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(2, 6, 12, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const backdrop = ctx.createRadialGradient(cx, cy, coreRadius * 0.6, cx, cy, minDim * 0.8)
      backdrop.addColorStop(0, brandColorAt(0.42, 0.07 + global.bloom * 0.05))
      backdrop.addColorStop(0.34, brandColorAt(0.06, 0.06 + global.bloom * 0.03))
      backdrop.addColorStop(0.68, brandColorAt(0.86, 0.05 + global.bloom * 0.03))
      backdrop.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalAlpha = 0.06 + global.noise * 0.07
      ctx.strokeStyle = brandColorAt(0.18, 0.18)
      ctx.lineWidth = 1
      for (let ring = 1; ring <= 4; ring += 1) {
        ctx.beginPath()
        ctx.arc(cx, cy, waveRadius + ring * minDim * 0.06, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < 4; i += 1) {
        const ripple = (time * (0.11 + stateConfig.scannerSpeed * 0.07 + speaking * 0.03) + i * 0.24) % 1
        const radius = coreRadius * 0.8 + ripple * minDim * (0.18 + voiceRipple * 0.08)
        const alpha = (1 - ripple) * (0.04 + voiceRipple * 0.06 + listening * 0.05 + speaking * 0.12)
        ctx.strokeStyle = brandColorAt((i * 0.21) + time * 0.02, alpha)
        ctx.lineWidth = 1.2 + (1 - ripple) * (1.8 + stateConfig.pulse * 1.2)
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      const waveGradient = addBrandStops(ctx.createLinearGradient(cx - waveRadius, cy, cx + waveRadius, cy), 0.88)
      ctx.strokeStyle = waveGradient
      ctx.lineWidth = 1.8 + stateConfig.barGain * 1.2 + audioKick * 0.8
      ctx.beginPath()
      for (let i = 0; i <= 180; i += 1) {
        const t = i / 180
        const angle = t * Math.PI * 2 - Math.PI / 2 + time * 0.07 * (0.4 + stateConfig.ringSpeed)
        const sample = getAudioSample(audioData, t)
        const motion = 0.5 + Math.sin(angle * (4 + stateConfig.pulse * 3) + time * (1.2 + stateConfig.scannerSpeed)) * 0.5
        const lift = mix(motion, sample, audioData?.length ? 0.74 : 0.18)
        const radius = waveRadius + lift * waveAmplitude * (0.72 + speaking * 0.5 + listening * 0.18)
        const x = cx + Math.cos(angle) * radius
        const y = cy + Math.sin(angle) * radius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.lineCap = 'round'
      for (let i = 0; i < 88; i += 1) {
        const t = i / 88
        const angle = t * Math.PI * 2 - Math.PI / 2 - time * 0.05
        const sample = getAudioSample(audioData, t)
        const motion = 0.5 + Math.sin(angle * (5 + stateConfig.barGain * 4) + time * (1 + stateConfig.scannerSpeed * 0.8)) * 0.5
        const lift = mix(motion, sample, audioData?.length ? 0.68 : 0.2)
        const start = waveRadius + minDim * 0.016
        const end = start + lift * minDim * (0.022 + stateConfig.barGain * 0.018 + voiceRipple * 0.01 + speaking * 0.014)
        const sx = cx + Math.cos(angle) * start
        const sy = cy + Math.sin(angle) * start
        const ex = cx + Math.cos(angle) * end
        const ey = cy + Math.sin(angle) * end
        ctx.strokeStyle = brandColorAt(t + time * 0.01, 0.14 + lift * 0.42)
        ctx.lineWidth = 1 + lift * 1.6
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(ex, ey)
        ctx.stroke()
      }
      ctx.restore()

      if (showRelay) {
        ctx.save()
        ctx.strokeStyle = brandColorAt(0.3, 0.14 + delegation * 0.06)
        ctx.lineWidth = 1
        ctx.setLineDash([4, 8])
        ctx.beginPath()
        ctx.arc(cx, cy, orbitRadius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()

        for (let i = 0; i < nodeCount; i += 1) {
          const t = i / nodeCount
          const angle = t * Math.PI * 2 - Math.PI / 2 + time * 0.05 * (0.5 + stateConfig.ringSpeed * 0.6)
          const x = cx + Math.cos(angle) * orbitRadius
          const y = cy + Math.sin(angle) * orbitRadius
          const active = i % 3 === 0 || (thinking && i % 2 === 0) || (relayPreset && i % 4 !== 1)
          const pulse = active ? 0.65 + Math.sin(time * 2.1 + i) * 0.18 : 0.28
          const glow = ctx.createRadialGradient(x, y, 0, x, y, minDim * 0.035)
          glow.addColorStop(0, brandColorAt(t, 0.18 + pulse * 0.2))
          glow.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = glow
          ctx.beginPath()
          ctx.arc(x, y, minDim * 0.035, 0, Math.PI * 2)
          ctx.fill()

          ctx.fillStyle = brandColorAt(t, 0.42 + pulse * 0.4)
          ctx.beginPath()
          ctx.arc(x, y, 3.2 + pulse * 1.5, 0, Math.PI * 2)
          ctx.fill()

          if (active) {
            const tracer = (time * (0.18 + stateConfig.scannerSpeed * 0.08) + i * 0.12) % 1
            const tx = mix(cx, x, tracer)
            const ty = mix(cy, y, tracer)
            ctx.strokeStyle = brandColorAt(t, 0.08 + pulse * 0.16)
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(cx, cy)
            ctx.lineTo(x, y)
            ctx.stroke()

            ctx.fillStyle = brandColorAt(t, 0.82)
            ctx.beginPath()
            ctx.arc(tx, ty, 2.1 + pulse, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }

      ctx.save()
      const lens = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * (2.2 + crownGlow * 0.8))
      lens.addColorStop(0, rgba(BRAND_CYAN, 0.06 + crownGlow * 0.05))
      lens.addColorStop(0.5, rgba(BRAND_INDIGO, 0.05 + crownGlow * 0.03))
      lens.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = lens
      ctx.beginPath()
      ctx.arc(cx, cy, coreRadius * (2.2 + crownGlow * 0.8), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      const image = imageRef.current
      if (image?.complete) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        ctx.globalAlpha = 0.58 + crownGlow * 0.08
        ctx.shadowColor = rgba(BRAND_CYAN, 0.85)
        ctx.shadowBlur = logoHeight * (0.15 + crownGlow * 0.06)
        ctx.drawImage(image, logoX, logoY, logoWidth, logoHeight)
        ctx.shadowColor = rgba(BRAND_VIOLET, 0.82)
        ctx.shadowBlur = logoHeight * (0.12 + global.bloom * 0.05)
        ctx.drawImage(image, logoX, logoY, logoWidth, logoHeight)
        ctx.restore()

        ctx.save()
        ctx.globalAlpha = 0.98
        ctx.drawImage(image, logoX, logoY, logoWidth, logoHeight)
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      const hornY = logoY + logoHeight * 0.1
      const leftHornX = cx - logoWidth * 0.27
      const rightHornX = cx + logoWidth * 0.27
      const flareHeight = minDim * (0.03 + crownGlow * 0.01 + thinking * 0.01 + speaking * 0.014)
      ;[leftHornX, rightHornX].forEach((hornX, index) => {
        const flare = ctx.createLinearGradient(hornX, hornY - flareHeight, hornX, hornY + flareHeight * 1.2)
        flare.addColorStop(0, brandColorAt(index === 0 ? 0.08 : 0.9, 0))
        flare.addColorStop(0.42, brandColorAt(index === 0 ? 0.08 : 0.9, 0.24 + crownGlow * 0.12))
        flare.addColorStop(1, brandColorAt(index === 0 ? 0.3 : 0.7, 0))
        ctx.strokeStyle = flare
        ctx.lineWidth = 2 + stateConfig.energy * 1.4
        ctx.beginPath()
        ctx.moveTo(hornX, hornY - flareHeight)
        ctx.lineTo(hornX, hornY + flareHeight * 1.1)
        ctx.stroke()
      })
      ctx.restore()

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        for (let i = 0; i < 6; i += 1) {
          const radius = waveRadius + minDim * (0.03 + i * 0.032)
          ctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 54, 54, 0.12)' : brandColorAt(0.86, 0.08)
          ctx.lineWidth = 1 + (i % 2) * 0.6
          ctx.beginPath()
          ctx.arc(
            cx + Math.sin(time * 8 + i) * stateConfig.jitter * minDim * 0.016,
            cy + Math.cos(time * 7 + i) * stateConfig.jitter * minDim * 0.016,
            radius,
            i * 0.4,
            i * 0.4 + Math.PI * 1.2
          )
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global, presetId, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
