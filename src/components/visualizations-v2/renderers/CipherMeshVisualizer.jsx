import { useEffect, useMemo, useRef, useState } from 'react'

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

function getBasePreset(presetId) {
  if (presetId === 'failover-amber') {
    return {
      global: { backdrop: 0.84, bloom: 1.08, noise: 0.08 },
      states: {
        idle: { hue: 202, accentHue: 42, energy: 0.24, pulse: 0.16, ringSpeed: 0.08, scannerSpeed: 0.16, barGain: 0.16, particleDensity: 94, orbitCount: 7, jitter: 0.02 },
        listening: { hue: 188, accentHue: 46, energy: 0.4, pulse: 0.26, ringSpeed: 0.12, scannerSpeed: 0.24, barGain: 0.26, particleDensity: 104, orbitCount: 8, jitter: 0.02 },
        thinking: { hue: 214, accentHue: 50, energy: 0.74, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.18, barGain: 0.3, particleDensity: 114, orbitCount: 9, jitter: 0.03 },
        speaking: { hue: 176, accentHue: 30, energy: 1.02, pulse: 0.76, ringSpeed: 0.22, scannerSpeed: 0.22, barGain: 0.42, particleDensity: 120, orbitCount: 10, jitter: 0.03 },
        error: { hue: 0, accentHue: 22, energy: 1.14, pulse: 0.88, ringSpeed: 0.12, scannerSpeed: 0.32, barGain: 0.52, particleDensity: 116, orbitCount: 8, jitter: 0.16 }
      }
    }
  }

  return {
    global: { backdrop: 0.8, bloom: 0.96, noise: 0.04 },
    states: {
      idle: { hue: 204, accentHue: 176, energy: 0.18, pulse: 0.12, ringSpeed: 0.06, scannerSpeed: 0.12, barGain: 0.14, particleDensity: 80, orbitCount: 6, jitter: 0.01 },
      listening: { hue: 194, accentHue: 168, energy: 0.32, pulse: 0.18, ringSpeed: 0.1, scannerSpeed: 0.2, barGain: 0.24, particleDensity: 92, orbitCount: 7, jitter: 0.01 },
      thinking: { hue: 220, accentHue: 46, energy: 0.62, pulse: 0.28, ringSpeed: 0.16, scannerSpeed: 0.16, barGain: 0.28, particleDensity: 102, orbitCount: 8, jitter: 0.02 },
      speaking: { hue: 186, accentHue: 28, energy: 0.92, pulse: 0.72, ringSpeed: 0.2, scannerSpeed: 0.2, barGain: 0.38, particleDensity: 112, orbitCount: 9, jitter: 0.02 },
      error: { hue: 0, accentHue: 20, energy: 1.08, pulse: 0.82, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.48, particleDensity: 108, orbitCount: 7, jitter: 0.12 }
    }
  }
}

export function getCipherMeshConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function createNodeShape(ctx, x, y, radius, sides = 6, rotation = 0) {
  ctx.beginPath()
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + (i / sides) * Math.PI * 2
    const px = x + Math.cos(angle) * radius
    const py = y + Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function addEdge(edges, edgeKeys, from, to, type) {
  const key = `${Math.min(from.id, to.id)}:${Math.max(from.id, to.id)}:${type}`
  if (edgeKeys.has(key)) return
  edgeKeys.add(key)
  edges.push({
    from,
    to,
    type,
    seed: from.seed * 0.31 + to.seed * 0.17 + edges.length * 0.73,
    touchesHub: from.hub || to.hub
  })
}

function buildTopology(width, height, orbitCount, jitter) {
  const columns = clamp(Math.round(4 + orbitCount * 0.35), 4, 7)
  const rowsBase = clamp(Math.round(2 + orbitCount * 0.32), 3, 6)
  const marginX = width * 0.12
  const marginY = height * 0.18
  const nodes = []
  let nodeId = 0

  for (let col = 0; col < columns; col += 1) {
    const rowCount = rowsBase + (col % 2 === 1 ? 1 : 0)
    const x = mix(marginX, width - marginX, columns === 1 ? 0.5 : col / (columns - 1))
    for (let row = 0; row < rowCount; row += 1) {
      const ratio = rowCount === 1 ? 0.5 : row / (rowCount - 1)
      const yBase = mix(marginY, height - marginY, ratio)
      const seed = col * 19.27 + row * 7.13
      const offsetX = Math.sin(seed * 1.7) * width * 0.006 * (0.6 + jitter)
      const offsetY = Math.cos(seed * 1.3) * height * 0.012 * (0.6 + jitter)
      nodes.push({
        id: nodeId++,
        col,
        row,
        x: x + offsetX,
        y: yBase + offsetY,
        seed,
        hub: false
      })
    }
  }

  const hub = {
    id: nodeId++,
    col: Math.floor(columns / 2),
    row: rowsBase / 2,
    x: width / 2,
    y: height / 2,
    seed: 997.3,
    hub: true
  }
  nodes.push(hub)

  const edgeKeys = new Set()
  const edges = []

  for (let col = 0; col < columns - 1; col += 1) {
    const current = nodes.filter(node => !node.hub && node.col === col)
    const next = nodes.filter(node => !node.hub && node.col === col + 1)
    current.forEach(node => {
      next
        .slice()
        .sort((a, b) => Math.abs(a.y - node.y) - Math.abs(b.y - node.y))
        .slice(0, col % 2 === 0 ? 2 : 3)
        .forEach(target => addEdge(edges, edgeKeys, node, target, 'forward'))
    })
  }

  for (let col = 0; col < columns; col += 1) {
    const columnNodes = nodes
      .filter(node => !node.hub && node.col === col)
      .sort((a, b) => a.y - b.y)
    for (let i = 0; i < columnNodes.length - 1; i += 1) {
      if (i % 2 === 0 || col === 0 || col === columns - 1) {
        addEdge(edges, edgeKeys, columnNodes[i], columnNodes[i + 1], 'vertical')
      }
    }
  }

  const leftCore = nodes
    .filter(node => !node.hub && node.col === Math.max(0, hub.col - 1))
    .sort((a, b) => Math.abs(a.y - hub.y) - Math.abs(b.y - hub.y))
    .slice(0, 4)
  const rightCore = nodes
    .filter(node => !node.hub && node.col === Math.min(columns - 1, hub.col + 1))
    .sort((a, b) => Math.abs(a.y - hub.y) - Math.abs(b.y - hub.y))
    .slice(0, 4)

  leftCore.forEach(node => addEdge(edges, edgeKeys, node, hub, 'to-hub'))
  rightCore.forEach(node => addEdge(edges, edgeKeys, hub, node, 'from-hub'))

  return { nodes, edges, hub, columns }
}

function buildPackets(edges, density) {
  const count = Math.max(20, Math.round(density * 0.45))
  return new Array(count).fill(null).map((_, index) => ({
    edgeIndex: index % Math.max(1, edges.length),
    offset: (index * 0.127) % 1,
    seed: index * 17.71,
    lane: index % 6
  }))
}

export default function CipherMeshVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'mesh-core'
  const { global, state: stateConfig } = useMemo(
    () => getCipherMeshConfig(presetId, assignment?.overrides, state),
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

  const topology = useMemo(
    () => buildTopology(size.width, size.height, stateConfig.orbitCount || 6, stateConfig.jitter || 0),
    [size.height, size.width, stateConfig.jitter, stateConfig.orbitCount]
  )

  const packets = useMemo(
    () => buildPackets(topology.edges, stateConfig.particleDensity || 80),
    [stateConfig.particleDensity, topology.edges]
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
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.8)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const minDim = Math.min(width, height)
      const energy = getAudioEnergy(audioData)
      const audioKick = energy * 0.95
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const hub = topology.hub

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(4, 7, 12, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const aura = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, minDim * 0.58)
      aura.addColorStop(0, hsl(stateConfig.accentHue, 96, 60, 0.05 + global.bloom * 0.04))
      aura.addColorStop(0.42, hsl(stateConfig.hue, 96, 42, 0.06 + global.bloom * 0.04))
      aura.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = aura
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalAlpha = 0.08 + global.noise * 0.08
      ctx.strokeStyle = hsl(stateConfig.hue, 68, 72, 0.16)
      ctx.lineWidth = 1
      for (let x = width * 0.1; x < width; x += 44) {
        ctx.beginPath()
        ctx.moveTo(x + 0.5, height * 0.12)
        ctx.lineTo(x + 0.5, height * 0.88)
        ctx.stroke()
      }
      for (let y = height * 0.16; y < height * 0.86; y += 34) {
        ctx.beginPath()
        ctx.moveTo(width * 0.08, y + 0.5)
        ctx.lineTo(width * 0.92, y + 0.5)
        ctx.stroke()
      }
      ctx.restore()

      const sweepX = mix(width * 0.12, width * 0.88, (Math.sin(time * (0.28 + stateConfig.scannerSpeed * 0.18)) + 1) * 0.5)
      const sweep = ctx.createLinearGradient(sweepX - 120, 0, sweepX + 120, 0)
      sweep.addColorStop(0, 'rgba(0,0,0,0)')
      sweep.addColorStop(0.5, hsl(stateConfig.accentHue, 100, 74, 0.05 + listening * 0.04))
      sweep.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sweep
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      topology.edges.forEach((edge, index) => {
        const a = edge.from
        const b = edge.to
        const util = Math.sin(time * (0.9 + stateConfig.scannerSpeed * 0.5) + edge.seed) * 0.5 + 0.5
        const isIngress = !edge.touchesHub && a.x < hub.x && b.x <= hub.x
        const isEgress = !edge.touchesHub && a.x >= hub.x
        const isPriority = edge.touchesHub || index % 7 === 0
        const broken = errorMode && ((index + Math.floor(time * 3)) % 9 === 0)
        let alpha = 0.08 + util * 0.12 + global.bloom * 0.04
        if (listening && isIngress) alpha += 0.08
        if (speaking && (edge.type === 'from-hub' || isEgress)) alpha += 0.08
        if (thinking && isPriority) alpha += 0.1
        if (errorMode) alpha *= broken ? 0.22 : 0.74

        const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
        gradient.addColorStop(0, hsl(stateConfig.hue, 94, 70, alpha))
        gradient.addColorStop(0.5, hsl(thinking && isPriority ? stateConfig.accentHue : stateConfig.hue, 100, 76, alpha + 0.06))
        gradient.addColorStop(1, hsl(errorMode && broken ? 4 : stateConfig.accentHue, 94, errorMode && broken ? 58 : 70, alpha))

        ctx.strokeStyle = gradient
        ctx.lineWidth = 1 + util * 1.4 + (edge.touchesHub ? 0.8 : 0) + audioKick * 1.1
        ctx.beginPath()
        if (broken) {
          const mx = mix(a.x, b.x, 0.46)
          const my = mix(a.y, b.y, 0.46)
          const nx = mix(a.x, b.x, 0.58)
          const ny = mix(a.y, b.y, 0.58)
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(mx, my)
          ctx.moveTo(nx, ny)
          ctx.lineTo(b.x, b.y)
        } else {
          const cx = mix(a.x, b.x, 0.5)
          const cy = mix(a.y, b.y, 0.5) + Math.sin(edge.seed + time * 0.4) * minDim * 0.01 * stateConfig.pulse
          ctx.moveTo(a.x, a.y)
          ctx.quadraticCurveTo(cx, cy, b.x, b.y)
        }
        ctx.stroke()
      })
      ctx.restore()

      ctx.save()
      packets.forEach(packet => {
        const edge = topology.edges[packet.edgeIndex]
        if (!edge) return

        const speed = 0.12 + stateConfig.scannerSpeed * 0.32 + stateConfig.barGain * 0.04 + packet.lane * 0.004
        let progress = (time * speed + packet.offset) % 1
        if (listening && edge.type === 'to-hub') progress = 1 - progress
        if (thinking && edge.touchesHub) progress = (time * (speed + 0.06) + packet.offset) % 1

        const a = edge.from
        const b = edge.to
        const x = mix(a.x, b.x, progress)
        const y = mix(a.y, b.y, progress) + Math.sin(packet.seed + time * 1.8) * minDim * 0.002
        const size = 1.4 + stateConfig.barGain * 1.4 + audioKick * 0.8
        const hot = edge.touchesHub || thinking
        const hue = errorMode ? (packet.lane % 2 === 0 ? 6 : 20) : hot ? stateConfig.accentHue : stateConfig.hue
        const alpha = errorMode ? (packet.lane % 3 === 0 ? 0.16 : 0.42) : 0.42 + audioKick * 0.12 + (hot ? 0.18 : 0)

        if (!(errorMode && packet.lane % 7 === 0 && Math.sin(time * 8 + packet.seed) > 0.4)) {
          ctx.fillStyle = hsl(hue, 100, 74, alpha * 0.22)
          ctx.beginPath()
          ctx.arc(x, y, size * 2.8, 0, Math.PI * 2)
          ctx.fill()

          ctx.fillStyle = hsl(hue, 100, 76, alpha)
          ctx.beginPath()
          ctx.arc(x, y, size, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      ctx.restore()

      ctx.save()
      topology.nodes.forEach((node, index) => {
        const hubPulse = node.hub ? 1 + Math.sin(time * (1.8 + stateConfig.pulse * 1.4)) * 0.08 : 1
        const glowRadius = (node.hub ? 18 : 7 + (index % 3)) * hubPulse
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius * 2.4)
        glow.addColorStop(0, hsl(node.hub ? stateConfig.accentHue : stateConfig.hue, 100, 74, node.hub ? 0.24 : 0.14))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(node.x, node.y, glowRadius * 2.4, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.restore()

      topology.nodes.forEach((node, index) => {
        const radius = node.hub ? 12 + stateConfig.energy * 6 : 4 + (index % 3) * 0.6 + stateConfig.energy * 0.5
        const fill = hsl(node.hub ? stateConfig.accentHue : stateConfig.hue, 86, node.hub ? 62 : 56, node.hub ? 0.6 : 0.32)
        const stroke = hsl(node.hub ? stateConfig.hue : stateConfig.accentHue, 100, 82, node.hub ? 0.92 : 0.6)

        ctx.save()
        createNodeShape(ctx, node.x, node.y, radius, node.hub ? 6 : 4, node.hub ? Math.PI / 6 : Math.PI / 4)
        ctx.fillStyle = fill
        ctx.fill()
        ctx.strokeStyle = stroke
        ctx.lineWidth = node.hub ? 1.6 : 1
        ctx.stroke()

        if (node.hub) {
          createNodeShape(ctx, node.x, node.y, radius * 1.65, 6, Math.PI / 6)
          ctx.strokeStyle = hsl(stateConfig.accentHue, 100, 78, 0.34 + thinking * 0.12)
          ctx.lineWidth = 1.1
          ctx.stroke()
        }
        ctx.restore()
      })

      if (errorMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        for (let i = 0; i < 7; i += 1) {
          const y = height * (0.16 + i * 0.1) + Math.sin(time * 8 + i * 1.2) * minDim * 0.018
          ctx.strokeStyle = hsl(i % 2 === 0 ? 0 : 20, 100, 60, 0.08 + i * 0.015)
          ctx.lineWidth = 1 + (i % 3) * 0.5
          ctx.beginPath()
          ctx.moveTo(width * 0.08, y)
          ctx.lineTo(width * 0.92, y + Math.cos(time * 6 + i) * minDim * 0.012)
          ctx.stroke()
        }
        ctx.restore()
      }

      frameRef.current = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global, packets, size.height, size.width, state, stateConfig, topology])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
