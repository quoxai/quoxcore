import { useEffect, useMemo, useRef, useState } from 'react'

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
  if (presetId === 'quorum-ghost') {
    return {
      global: { backdrop: 0.82, bloom: 1.02, noise: 0.04 },
      states: {
        idle: { hue: 210, accentHue: 274, energy: 0.2, pulse: 0.12, ringSpeed: 0.06, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 142, orbitCount: 5, jitter: 0.01 },
        listening: { hue: 186, accentHue: 214, energy: 0.38, pulse: 0.18, ringSpeed: 0.1, scannerSpeed: 0.16, barGain: 0.12, particleDensity: 156, orbitCount: 6, jitter: 0.01 },
        thinking: { hue: 234, accentHue: 302, energy: 0.74, pulse: 0.34, ringSpeed: 0.16, scannerSpeed: 0.1, barGain: 0.14, particleDensity: 176, orbitCount: 8, jitter: 0.02 },
        speaking: { hue: 178, accentHue: 24, energy: 0.96, pulse: 0.72, ringSpeed: 0.18, scannerSpeed: 0.12, barGain: 0.32, particleDensity: 170, orbitCount: 7, jitter: 0.02 },
        error: { hue: 0, accentHue: 320, energy: 1.04, pulse: 0.84, ringSpeed: 0.1, scannerSpeed: 0.28, barGain: 0.26, particleDensity: 160, orbitCount: 6, jitter: 0.1 }
      }
    }
  }

  return {
    global: { backdrop: 0.9, bloom: 1.12, noise: 0.06 },
    states: {
      idle: { hue: 204, accentHue: 42, energy: 0.24, pulse: 0.14, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 150, orbitCount: 6, jitter: 0.01 },
      listening: { hue: 196, accentHue: 162, energy: 0.42, pulse: 0.2, ringSpeed: 0.12, scannerSpeed: 0.18, barGain: 0.12, particleDensity: 168, orbitCount: 7, jitter: 0.01 },
      thinking: { hue: 220, accentHue: 46, energy: 0.82, pulse: 0.38, ringSpeed: 0.18, scannerSpeed: 0.12, barGain: 0.16, particleDensity: 188, orbitCount: 9, jitter: 0.02 },
      speaking: { hue: 188, accentHue: 18, energy: 1.08, pulse: 0.82, ringSpeed: 0.22, scannerSpeed: 0.12, barGain: 0.36, particleDensity: 180, orbitCount: 8, jitter: 0.02 },
      error: { hue: 356, accentHue: 28, energy: 1.1, pulse: 0.9, ringSpeed: 0.1, scannerSpeed: 0.32, barGain: 0.28, particleDensity: 164, orbitCount: 7, jitter: 0.1 }
    }
  }
}

export function getCathedralOfMindsConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

export default function CathedralOfMindsVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const nodesRef = useRef([])
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'black-sun-synod'
  const { global, state: stateConfig } = useMemo(
    () => getCathedralOfMindsConfig(presetId, assignment?.overrides, state),
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
    const clusterCount = Math.max(5, Math.round(stateConfig.orbitCount))
    const density = stateConfig.particleDensity || 150
    const nodesPerCluster = 8 + Math.round(density * 0.16)
    const total = clusterCount * nodesPerCluster
    if (nodesRef.current.length === total) return

    const nodes = []
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      for (let i = 0; i < nodesPerCluster; i += 1) {
        nodes.push({
          cluster,
          seed: Math.random() * 1000,
          orbit: Math.random(),
          depth: Math.random(),
          lane: i % 5
        })
      }
    }
    nodesRef.current = nodes
  }, [stateConfig.orbitCount, stateConfig.particleDensity])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const draw = () => {
      phaseRef.current += 0.014 * (1 + stateConfig.ringSpeed * 0.9)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const cx = width / 2
      const cy = height / 2
      const minDim = Math.min(width, height)
      const audioKick = getAudioEnergy(audioData) * 0.95
      const thinking = state === 'thinking' ? 1 : 0
      const listening = state === 'listening' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.92 + global.backdrop * 0.05) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const eclipseRadius = minDim * (0.11 + stateConfig.energy * 0.035)
      const impossibleLight = ctx.createRadialGradient(cx, cy, eclipseRadius * 0.3, cx, cy, eclipseRadius * 3.2)
      impossibleLight.addColorStop(0, hsl(stateConfig.accentHue, 100, 70, 0.08 + global.bloom * 0.06))
      impossibleLight.addColorStop(0.42, hsl(stateConfig.hue, 96, 48, 0.05 + global.bloom * 0.04))
      impossibleLight.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = impossibleLight
      ctx.beginPath()
      ctx.arc(cx, cy, eclipseRadius * 3.2, 0, Math.PI * 2)
      ctx.fill()

      const clusterCount = Math.max(5, Math.round(stateConfig.orbitCount))
      const baseRadius = minDim * (0.16 + stateConfig.energy * 0.05)
      const clusters = new Array(clusterCount).fill(null).map((_, index) => {
        const ratio = index / clusterCount
        const angle = time * (0.05 + stateConfig.ringSpeed * 0.06) + ratio * Math.PI * 2
        const radialNoise = Math.sin(time * 0.4 + index * 1.7) * baseRadius * 0.22
        const radial = baseRadius + radialNoise + Math.sin(time * 0.17 + index * 0.8) * 24
        const leanX = listening ? Math.cos(-0.38) * baseRadius * 0.42 : 0
        const leanY = listening ? -baseRadius * 0.14 : 0
        const speakLift = speaking ? Math.sin(ratio * Math.PI) * baseRadius * 0.22 : 0
        const fracture = errorMode ? Math.sin(time * 1.2 + index * 2.1) * baseRadius * 0.18 : 0
        return {
          x: cx + Math.cos(angle) * (radial + fracture) + leanX,
          y: cy + Math.sin(angle * (1.1 + thinking * 0.12)) * (radial * 0.68 + speakLift) + leanY,
          radius: 42 + Math.sin(time * 0.7 + index) * 8 + stateConfig.energy * 28 + (index % 3) * 10,
          intensity: 0.55 + Math.sin(time * 0.9 + index * 0.6) * 0.18
        }
      })

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      clusters.forEach((cluster, index) => {
        const glow = ctx.createRadialGradient(cluster.x, cluster.y, 0, cluster.x, cluster.y, cluster.radius * 1.8)
        glow.addColorStop(0, hsl(index % 2 === 0 ? stateConfig.hue : stateConfig.accentHue, 96, 72, 0.14))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(cluster.x, cluster.y, cluster.radius * 1.8, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      ctx.lineWidth = 1
      for (let i = 0; i < clusters.length; i += 1) {
        const a = clusters[i]
        const b = clusters[(i + 1) % clusters.length]
        const alpha = 0.05 + a.intensity * 0.08 + audioKick * 0.05
        ctx.strokeStyle = hsl(stateConfig.accentHue, 95, 72, alpha)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(cx, cy, b.x, b.y)
        ctx.stroke()
      }
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      nodesRef.current.forEach((node, index) => {
        const cluster = clusters[node.cluster % clusters.length]
        const angle = time * (0.16 + stateConfig.scannerSpeed * 0.2) + node.seed * 0.01 + node.orbit * Math.PI * 2
        const localRadius = cluster.radius * (0.28 + node.orbit * 1.18) + thinking * Math.sin(time * 1.8 + node.seed) * 8
        const px = cluster.x + Math.cos(angle) * localRadius
        const py = cluster.y + Math.sin(angle) * localRadius * (0.7 + node.depth * 0.4)
        const hue = node.lane === 0 ? stateConfig.accentHue : stateConfig.hue
        const alpha = 0.08 + node.depth * 0.22 + audioKick * 0.06
        const size = 0.8 + node.depth * 1.6 + stateConfig.barGain * 0.8
        ctx.fillStyle = hsl(hue, 96, 78, alpha)
        ctx.beginPath()
        ctx.arc(px, py, size, 0, Math.PI * 2)
        ctx.fill()

        if (index % 9 === 0) {
          ctx.strokeStyle = hsl(stateConfig.accentHue, 96, 74, 0.06 + audioKick * 0.04)
          ctx.beginPath()
          ctx.moveTo(cluster.x, cluster.y)
          ctx.lineTo(px, py)
          ctx.stroke()
        }
      })
      ctx.restore()

      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,1)'
      ctx.beginPath()
      ctx.arc(cx, cy, eclipseRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = 'screen'
      for (let i = 0; i < 4; i += 1) {
        const radius = eclipseRadius * (1.15 + i * 0.18) + Math.sin(time * (1.6 + i * 0.15)) * (8 + i * 2)
        ctx.strokeStyle = hsl(i % 2 === 0 ? stateConfig.accentHue : stateConfig.hue, 100, 74, 0.06 + i * 0.025)
        ctx.lineWidth = 1.2 + i * 0.35
        ctx.beginPath()
        ctx.arc(cx, cy, radius, time * 0.18 + i, time * 0.18 + i + Math.PI * (0.42 + speaking * 0.08))
        ctx.stroke()
      }
      ctx.restore()

      if (errorMode) {
        ctx.save()
        ctx.globalAlpha = 0.24
        for (let i = 0; i < 12; i += 1) {
          const y = height * (i / 12) + Math.sin(time * 8 + i) * 14
          ctx.fillStyle = hsl(i % 2 === 0 ? stateConfig.hue : stateConfig.accentHue, 92, 58, 0.08)
          ctx.fillRect(0, y, width, 2 + (i % 4))
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global.backdrop, global.bloom, presetId, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
