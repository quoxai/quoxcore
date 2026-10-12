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

const PRESETS = {
  'jarvis-command-hud': {
    defaultPresetId: 'jarvis-prime',
    presets: {
      'jarvis-prime': {
        global: { backdrop: 0.62, bloom: 0.84, noise: 0.2 },
        states: {
          idle: { hue: 198, accentHue: 34, energy: 0.34, pulse: 0.22, ringSpeed: 0.18, scannerSpeed: 0.24, barGain: 0.18, particleDensity: 44, orbitCount: 4, jitter: 0.02 },
          listening: { hue: 191, accentHue: 165, energy: 0.65, pulse: 0.42, ringSpeed: 0.64, scannerSpeed: 1.12, barGain: 0.72, particleDensity: 84, orbitCount: 7, jitter: 0.03 },
          thinking: { hue: 46, accentHue: 274, energy: 0.74, pulse: 0.48, ringSpeed: 0.86, scannerSpeed: 0.4, barGain: 0.36, particleDensity: 124, orbitCount: 11, jitter: 0.05 },
          speaking: { hue: 182, accentHue: 30, energy: 1.04, pulse: 0.92, ringSpeed: 1.14, scannerSpeed: 0.8, barGain: 1.05, particleDensity: 110, orbitCount: 9, jitter: 0.04 },
          error: { hue: 356, accentHue: 18, energy: 0.92, pulse: 0.68, ringSpeed: 0.36, scannerSpeed: 1.4, barGain: 0.84, particleDensity: 96, orbitCount: 6, jitter: 0.24 }
        }
      },
      'sentinel-glass': {
        global: { backdrop: 0.55, bloom: 0.78, noise: 0.17 },
        states: {
          idle: { hue: 210, accentHue: 197, energy: 0.26, pulse: 0.14, ringSpeed: 0.16, scannerSpeed: 0.2, barGain: 0.12, particleDensity: 30, orbitCount: 3, jitter: 0.01 },
          listening: { hue: 205, accentHue: 170, energy: 0.78, pulse: 0.3, ringSpeed: 0.72, scannerSpeed: 1.4, barGain: 0.92, particleDensity: 102, orbitCount: 8, jitter: 0.02 },
          thinking: { hue: 222, accentHue: 259, energy: 0.62, pulse: 0.34, ringSpeed: 0.72, scannerSpeed: 0.34, barGain: 0.24, particleDensity: 120, orbitCount: 10, jitter: 0.03 },
          speaking: { hue: 196, accentHue: 181, energy: 0.84, pulse: 0.74, ringSpeed: 1.1, scannerSpeed: 0.64, barGain: 0.88, particleDensity: 96, orbitCount: 9, jitter: 0.03 },
          error: { hue: 2, accentHue: 352, energy: 1.12, pulse: 0.62, ringSpeed: 0.2, scannerSpeed: 1.7, barGain: 0.74, particleDensity: 118, orbitCount: 5, jitter: 0.36 }
        }
      }
    }
  },
  'orbital-cathedral': {
    defaultPresetId: 'white-paper',
    presets: {
      'white-paper': {
        global: { backdrop: 0.52, bloom: 0.66, noise: 0.06 },
        states: {
          idle: { hue: 196, accentHue: 215, energy: 0.16, pulse: 0.06, ringSpeed: 0.06, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 12, orbitCount: 2, jitter: 0.0 },
          listening: { hue: 180, accentHue: 195, energy: 0.38, pulse: 0.16, ringSpeed: 0.3, scannerSpeed: 0.46, barGain: 0.36, particleDensity: 22, orbitCount: 4, jitter: 0.01 },
          thinking: { hue: 48, accentHue: 272, energy: 0.54, pulse: 0.24, ringSpeed: 0.42, scannerSpeed: 0.14, barGain: 0.12, particleDensity: 34, orbitCount: 6, jitter: 0.01 },
          speaking: { hue: 164, accentHue: 28, energy: 0.64, pulse: 0.34, ringSpeed: 0.56, scannerSpeed: 0.18, barGain: 0.44, particleDensity: 28, orbitCount: 5, jitter: 0.01 },
          error: { hue: 2, accentHue: 354, energy: 0.82, pulse: 0.28, ringSpeed: 0.1, scannerSpeed: 0.54, barGain: 0.3, particleDensity: 18, orbitCount: 3, jitter: 0.08 }
        }
      },
      boardroom: {
        global: { backdrop: 0.46, bloom: 0.58, noise: 0.03 },
        states: {
          idle: { hue: 198, accentHue: 38, energy: 0.14, pulse: 0.05, ringSpeed: 0.04, scannerSpeed: 0.04, barGain: 0.02, particleDensity: 8, orbitCount: 1, jitter: 0 },
          listening: { hue: 193, accentHue: 168, energy: 0.32, pulse: 0.12, ringSpeed: 0.2, scannerSpeed: 0.36, barGain: 0.28, particleDensity: 18, orbitCount: 3, jitter: 0.01 },
          thinking: { hue: 226, accentHue: 280, energy: 0.46, pulse: 0.18, ringSpeed: 0.34, scannerSpeed: 0.1, barGain: 0.08, particleDensity: 26, orbitCount: 5, jitter: 0.01 },
          speaking: { hue: 188, accentHue: 28, energy: 0.58, pulse: 0.28, ringSpeed: 0.44, scannerSpeed: 0.12, barGain: 0.36, particleDensity: 22, orbitCount: 4, jitter: 0.01 },
          error: { hue: 0, accentHue: 18, energy: 0.72, pulse: 0.24, ringSpeed: 0.06, scannerSpeed: 0.42, barGain: 0.24, particleDensity: 16, orbitCount: 2, jitter: 0.06 }
        }
      }
    }
  },
  'signal-bloom': {
    defaultPresetId: 'bloom-core',
    presets: {
      'bloom-core': {
        global: { backdrop: 0.68, bloom: 1.08, noise: 0.18 },
        states: {
          idle: { hue: 194, accentHue: 308, energy: 0.24, pulse: 0.12, ringSpeed: 0.12, scannerSpeed: 0.08, barGain: 0.06, particleDensity: 56, orbitCount: 3, jitter: 0.01 },
          listening: { hue: 178, accentHue: 212, energy: 0.52, pulse: 0.28, ringSpeed: 0.36, scannerSpeed: 0.56, barGain: 0.74, particleDensity: 88, orbitCount: 5, jitter: 0.02 },
          thinking: { hue: 42, accentHue: 276, energy: 0.74, pulse: 0.42, ringSpeed: 0.48, scannerSpeed: 0.18, barGain: 0.22, particleDensity: 116, orbitCount: 7, jitter: 0.03 },
          speaking: { hue: 170, accentHue: 24, energy: 1.18, pulse: 1.04, ringSpeed: 0.78, scannerSpeed: 0.28, barGain: 1.24, particleDensity: 124, orbitCount: 6, jitter: 0.03 },
          error: { hue: 356, accentHue: 12, energy: 1.02, pulse: 0.84, ringSpeed: 0.12, scannerSpeed: 0.92, barGain: 0.92, particleDensity: 110, orbitCount: 4, jitter: 0.2 }
        }
      },
      'velvet-alarm': {
        global: { backdrop: 0.72, bloom: 1.12, noise: 0.24 },
        states: {
          idle: { hue: 232, accentHue: 325, energy: 0.18, pulse: 0.1, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 48, orbitCount: 2, jitter: 0.01 },
          listening: { hue: 182, accentHue: 200, energy: 0.46, pulse: 0.22, ringSpeed: 0.28, scannerSpeed: 0.44, barGain: 0.62, particleDensity: 72, orbitCount: 4, jitter: 0.02 },
          thinking: { hue: 30, accentHue: 286, energy: 0.62, pulse: 0.34, ringSpeed: 0.42, scannerSpeed: 0.14, barGain: 0.18, particleDensity: 102, orbitCount: 6, jitter: 0.03 },
          speaking: { hue: 170, accentHue: 16, energy: 1.06, pulse: 0.92, ringSpeed: 0.68, scannerSpeed: 0.22, barGain: 1.12, particleDensity: 118, orbitCount: 6, jitter: 0.03 },
          error: { hue: 0, accentHue: 26, energy: 1.18, pulse: 1.04, ringSpeed: 0.1, scannerSpeed: 1.08, barGain: 1.02, particleDensity: 132, orbitCount: 4, jitter: 0.28 }
        }
      }
    }
  },
  'mind-swarm': {
    defaultPresetId: 'overmind',
    presets: {
      overmind: {
        global: { backdrop: 0.76, bloom: 1.16, noise: 0.28 },
        states: {
          idle: { hue: 192, accentHue: 226, energy: 0.28, pulse: 0.16, ringSpeed: 0.14, scannerSpeed: 0.08, barGain: 0.08, particleDensity: 220, orbitCount: 5, jitter: 0.01 },
          listening: { hue: 182, accentHue: 164, energy: 0.54, pulse: 0.28, ringSpeed: 0.34, scannerSpeed: 0.42, barGain: 0.22, particleDensity: 260, orbitCount: 6, jitter: 0.02 },
          thinking: { hue: 48, accentHue: 286, energy: 0.92, pulse: 0.48, ringSpeed: 0.62, scannerSpeed: 0.2, barGain: 0.14, particleDensity: 320, orbitCount: 8, jitter: 0.03 },
          speaking: { hue: 170, accentHue: 24, energy: 1.18, pulse: 0.92, ringSpeed: 0.44, scannerSpeed: 0.12, barGain: 0.34, particleDensity: 300, orbitCount: 7, jitter: 0.02 },
          error: { hue: 356, accentHue: 8, energy: 1.08, pulse: 0.84, ringSpeed: 0.16, scannerSpeed: 0.8, barGain: 0.3, particleDensity: 280, orbitCount: 6, jitter: 0.14 }
        }
      },
      'oracle-mesh': {
        global: { backdrop: 0.7, bloom: 1.04, noise: 0.22 },
        states: {
          idle: { hue: 206, accentHue: 266, energy: 0.22, pulse: 0.12, ringSpeed: 0.1, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 200, orbitCount: 4, jitter: 0.01 },
          listening: { hue: 190, accentHue: 160, energy: 0.46, pulse: 0.22, ringSpeed: 0.26, scannerSpeed: 0.32, barGain: 0.16, particleDensity: 240, orbitCount: 5, jitter: 0.02 },
          thinking: { hue: 58, accentHue: 272, energy: 0.86, pulse: 0.44, ringSpeed: 0.58, scannerSpeed: 0.16, barGain: 0.1, particleDensity: 340, orbitCount: 9, jitter: 0.03 },
          speaking: { hue: 182, accentHue: 28, energy: 1.02, pulse: 0.8, ringSpeed: 0.36, scannerSpeed: 0.1, barGain: 0.28, particleDensity: 290, orbitCount: 6, jitter: 0.02 },
          error: { hue: 0, accentHue: 22, energy: 1.12, pulse: 0.92, ringSpeed: 0.12, scannerSpeed: 0.72, barGain: 0.26, particleDensity: 260, orbitCount: 5, jitter: 0.18 }
        }
      }
    }
  },
  'living-ink': {
    defaultPresetId: 'venom-oracle',
    presets: {
      'venom-oracle': {
        global: { backdrop: 0.86, bloom: 0.96, noise: 0.14 },
        states: {
          idle: { hue: 188, accentHue: 220, energy: 0.22, pulse: 0.16, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.02, particleDensity: 420, orbitCount: 4, jitter: 0.01 },
          listening: { hue: 174, accentHue: 198, energy: 0.38, pulse: 0.22, ringSpeed: 0.14, scannerSpeed: 0.08, barGain: 0.04, particleDensity: 480, orbitCount: 5, jitter: 0.01 },
          thinking: { hue: 44, accentHue: 282, energy: 0.74, pulse: 0.34, ringSpeed: 0.2, scannerSpeed: 0.06, barGain: 0.05, particleDensity: 560, orbitCount: 6, jitter: 0.02 },
          speaking: { hue: 168, accentHue: 10, energy: 1.02, pulse: 0.7, ringSpeed: 0.22, scannerSpeed: 0.08, barGain: 0.08, particleDensity: 540, orbitCount: 6, jitter: 0.02 },
          error: { hue: 356, accentHue: 20, energy: 1.1, pulse: 0.86, ringSpeed: 0.12, scannerSpeed: 0.18, barGain: 0.08, particleDensity: 500, orbitCount: 5, jitter: 0.08 }
        }
      },
      'ghost-mouth': {
        global: { backdrop: 0.82, bloom: 1.02, noise: 0.1 },
        states: {
          idle: { hue: 198, accentHue: 264, energy: 0.2, pulse: 0.14, ringSpeed: 0.06, scannerSpeed: 0.04, barGain: 0.02, particleDensity: 400, orbitCount: 4, jitter: 0.01 },
          listening: { hue: 182, accentHue: 206, energy: 0.34, pulse: 0.2, ringSpeed: 0.12, scannerSpeed: 0.06, barGain: 0.03, particleDensity: 460, orbitCount: 5, jitter: 0.01 },
          thinking: { hue: 56, accentHue: 292, energy: 0.68, pulse: 0.32, ringSpeed: 0.18, scannerSpeed: 0.06, barGain: 0.04, particleDensity: 540, orbitCount: 6, jitter: 0.02 },
          speaking: { hue: 174, accentHue: 18, energy: 0.96, pulse: 0.74, ringSpeed: 0.2, scannerSpeed: 0.08, barGain: 0.08, particleDensity: 520, orbitCount: 6, jitter: 0.02 },
          error: { hue: 0, accentHue: 22, energy: 1.08, pulse: 0.94, ringSpeed: 0.1, scannerSpeed: 0.18, barGain: 0.08, particleDensity: 500, orbitCount: 5, jitter: 0.1 }
        }
      },
      'chroma-beast': {
        global: { backdrop: 0.8, bloom: 1.08, noise: 0.12 },
        states: {
          idle: { hue: 168, accentHue: 208, energy: 0.24, pulse: 0.18, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.02, particleDensity: 430, orbitCount: 4, jitter: 0.01 },
          listening: { hue: 156, accentHue: 188, energy: 0.42, pulse: 0.22, ringSpeed: 0.1, scannerSpeed: 0.08, barGain: 0.04, particleDensity: 500, orbitCount: 5, jitter: 0.01 },
          thinking: { hue: 34, accentHue: 286, energy: 0.8, pulse: 0.38, ringSpeed: 0.14, scannerSpeed: 0.06, barGain: 0.04, particleDensity: 590, orbitCount: 6, jitter: 0.02 },
          speaking: { hue: 174, accentHue: 12, energy: 1.08, pulse: 0.76, ringSpeed: 0.16, scannerSpeed: 0.08, barGain: 0.08, particleDensity: 560, orbitCount: 6, jitter: 0.02 },
          error: { hue: 348, accentHue: 26, energy: 1.14, pulse: 0.9, ringSpeed: 0.1, scannerSpeed: 0.16, barGain: 0.08, particleDensity: 520, orbitCount: 5, jitter: 0.1 }
        }
      }
    }
  },
  'gaia-eye': {
    defaultPresetId: 'blue-marble',
    presets: {
      'blue-marble': {
        global: { backdrop: 0.95, bloom: 1.16, noise: 0.03 },
        states: {
          idle: { hue: 198, accentHue: 148, energy: 0.24, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 134, orbitCount: 6, jitter: 0.01 },
          listening: { hue: 190, accentHue: 162, energy: 0.4, pulse: 0.18, ringSpeed: 0.14, scannerSpeed: 0.18, barGain: 0.12, particleDensity: 148, orbitCount: 7, jitter: 0.01 },
          thinking: { hue: 206, accentHue: 136, energy: 0.82, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.12, particleDensity: 168, orbitCount: 8, jitter: 0.02 },
          speaking: { hue: 184, accentHue: 130, energy: 1.06, pulse: 0.82, ringSpeed: 0.22, scannerSpeed: 0.12, barGain: 0.32, particleDensity: 160, orbitCount: 8, jitter: 0.02 },
          error: { hue: 12, accentHue: 164, energy: 1.08, pulse: 0.94, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.24, particleDensity: 154, orbitCount: 7, jitter: 0.1 }
        }
      },
      'emerald-tide': {
        global: { backdrop: 0.92, bloom: 1.22, noise: 0.04 },
        states: {
          idle: { hue: 186, accentHue: 122, energy: 0.22, pulse: 0.14, ringSpeed: 0.08, scannerSpeed: 0.04, barGain: 0.04, particleDensity: 136, orbitCount: 6, jitter: 0.01 },
          listening: { hue: 176, accentHue: 138, energy: 0.38, pulse: 0.2, ringSpeed: 0.14, scannerSpeed: 0.18, barGain: 0.12, particleDensity: 150, orbitCount: 7, jitter: 0.01 },
          thinking: { hue: 198, accentHue: 110, energy: 0.76, pulse: 0.34, ringSpeed: 0.18, scannerSpeed: 0.1, barGain: 0.12, particleDensity: 170, orbitCount: 8, jitter: 0.02 },
          speaking: { hue: 170, accentHue: 116, energy: 1.02, pulse: 0.78, ringSpeed: 0.22, scannerSpeed: 0.12, barGain: 0.3, particleDensity: 162, orbitCount: 8, jitter: 0.02 },
          error: { hue: 8, accentHue: 150, energy: 1.06, pulse: 0.92, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.24, particleDensity: 156, orbitCount: 7, jitter: 0.1 }
        }
      }
    }
  }
}

export function getPrototypeConfig(rendererId, presetId, overrides, state) {
  const family = PRESETS[rendererId]
  const resolvedPresetId = presetId && family?.presets?.[presetId] ? presetId : family?.defaultPresetId
  const preset = family?.presets?.[resolvedPresetId]
  if (!preset) {
    return {
      global: { backdrop: 0.7, bloom: 0.9, noise: 0.1 },
      state: { hue: 200, accentHue: 150, energy: 0.4, pulse: 0.2, ringSpeed: 0.2, scannerSpeed: 0.2, barGain: 0.2, particleDensity: 60, orbitCount: 4, jitter: 0.02 }
    }
  }
  return {
    global: { ...preset.global, ...(overrides?.global || {}) },
    state: {
      ...(preset.states[state] || preset.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function drawBackground(ctx, width, height, globalConfig, time, hue = 198) {
  const vignette = ctx.createRadialGradient(width / 2, height / 2, width * 0.08, width / 2, height / 2, width * 0.55)
  vignette.addColorStop(0, `rgba(10, 24, 32, ${0.2 + globalConfig.backdrop * 0.1})`)
  vignette.addColorStop(1, `rgba(2, 8, 12, ${0.92 - globalConfig.backdrop * 0.14})`)
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.globalAlpha = 0.1 + globalConfig.backdrop * 0.18
  ctx.strokeStyle = hsl(hue, 60, 70, 0.14)
  ctx.lineWidth = 1
  for (let y = 0; y < height; y += 28) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
    ctx.stroke()
  }
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
    ctx.stroke()
  }
  ctx.restore()

  const sweep = (Math.sin(time * 0.13) * 0.5 + 0.5) * width
  const gradient = ctx.createLinearGradient(sweep - 160, 0, sweep + 160, 0)
  gradient.addColorStop(0, 'rgba(118, 216, 255, 0)')
  gradient.addColorStop(0.5, hsl(hue, 92, 72, 0.03 + globalConfig.backdrop * 0.08))
  gradient.addColorStop(1, 'rgba(118, 216, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
}

function drawParticles(ctx, width, height, stateConfig, time, globalConfig, scale = 1) {
  const density = Math.max(8, Math.round(stateConfig.particleDensity * scale))
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  for (let i = 0; i < density; i += 1) {
    const seed = i * 12.9898
    const px = ((Math.sin(seed + time * (0.06 + stateConfig.ringSpeed * 0.14)) + 1) * 0.5) * width
    const py = ((Math.cos(seed * 1.9 + time * (0.04 + stateConfig.scannerSpeed * 0.08)) + 1) * 0.5) * height
    const size = 0.4 + (i % 3) * 0.45 + stateConfig.energy * 0.3
    const alpha = 0.03 + (i % 5) * 0.01 + globalConfig.noise * 0.04
    ctx.fillStyle = hsl(i % 2 === 0 ? stateConfig.hue : stateConfig.accentHue, 88, 72, alpha)
    ctx.beginPath()
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawSegmentedRing(ctx, x, y, radius, segments, time, stateConfig, alpha, width = 2) {
  ctx.save()
  ctx.lineWidth = width
  ctx.strokeStyle = hsl(stateConfig.hue, 92, 70, alpha)
  const offset = time * stateConfig.ringSpeed * 0.25
  for (let i = 0; i < segments; i += 1) {
    const start = offset + (i / segments) * Math.PI * 2
    const end = start + Math.PI * 2 / segments * 0.62
    ctx.beginPath()
    ctx.arc(x, y, radius, start, end)
    ctx.stroke()
  }
  ctx.restore()
}

function getSwarmAttractors(width, height, stateConfig, time, state) {
  const cx = width / 2
  const cy = height / 2
  const base = Math.min(width, height) * 0.11
  const thinkingSpread = base * (0.8 + stateConfig.energy * 0.5)

  if (state === 'idle') {
    return [
      { x: cx, y: cy, strength: 1.18, swirl: 0.28 },
      { x: cx + Math.cos(time * 0.18) * base * 0.55, y: cy + Math.sin(time * 0.22) * base * 0.35, strength: 0.52, swirl: -0.12 }
    ]
  }
  if (state === 'listening') {
    return [
      { x: cx, y: cy - base * 0.2, strength: 0.88, swirl: 0.22 },
      { x: cx - base * 1.35, y: cy, strength: 0.62, swirl: 0.42 },
      { x: cx + base * 1.35, y: cy, strength: 0.62, swirl: -0.42 }
    ]
  }
  if (state === 'thinking') {
    return [
      { x: cx + Math.cos(time * 0.4) * thinkingSpread, y: cy + Math.sin(time * 0.32) * thinkingSpread * 0.58, strength: 0.9, swirl: 0.54 },
      { x: cx + Math.cos(time * 0.31 + 2.1) * thinkingSpread * 1.1, y: cy + Math.sin(time * 0.26 + 1.4) * thinkingSpread * 0.92, strength: 0.86, swirl: -0.44 },
      { x: cx + Math.cos(time * 0.36 + 4.2) * thinkingSpread * 1.24, y: cy + Math.sin(time * 0.29 + 3.2) * thinkingSpread * 0.72, strength: 0.82, swirl: 0.38 },
      { x: cx, y: cy, strength: 0.74, swirl: 0.18 }
    ]
  }
  if (state === 'speaking') {
    return [
      { x: cx, y: cy, strength: 0.92, swirl: 0.18 },
      { x: cx, y: cy - base * 0.9, strength: 0.74, swirl: 0.06 },
      { x: cx - base * 0.85, y: cy + base * 0.22, strength: 0.66, swirl: -0.22 },
      { x: cx + base * 0.85, y: cy + base * 0.22, strength: 0.66, swirl: 0.22 }
    ]
  }
  return [
    { x: cx, y: cy, strength: 0.44, swirl: 0.02 },
    { x: cx - base * 1.6, y: cy + Math.sin(time * 0.9) * base * 0.42, strength: 0.54, swirl: 0.72 },
    { x: cx + base * 1.6, y: cy + Math.cos(time * 1.1) * base * 0.48, strength: 0.54, swirl: -0.72 }
  ]
}

export default function PrototypeVisualizer({ rendererId, state = 'idle', audioData = null, assignment }) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const swarmRef = useRef([])
  const liquidRef = useRef([])
  const eyeRef = useRef([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  const { global, state: stateConfig } = useMemo(
    () => getPrototypeConfig(rendererId, assignment?.presetId, assignment?.overrides, state),
    [assignment?.overrides, assignment?.presetId, rendererId, state]
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
    if (rendererId !== 'mind-swarm' || !size.width || !size.height) return
    const targetCount = 1400 + Math.round((stateConfig.particleDensity || 160) * 5.2)
    if (swarmRef.current.length === targetCount) return
    const particles = new Array(targetCount)
    const centerX = size.width / 2
    const centerY = size.height / 2
    const spawnRadius = Math.min(size.width, size.height) * 0.16
    for (let i = 0; i < targetCount; i += 1) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.sqrt(Math.random()) * spawnRadius
      particles[i] = {
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        seed: Math.random() * 1000,
        cluster: i % 7,
        z: Math.random(),
        phase: Math.random() * Math.PI * 2
      }
    }
    swarmRef.current = particles
  }, [rendererId, size.height, size.width, stateConfig.particleDensity])

  useEffect(() => {
    if (rendererId !== 'living-ink' || !size.width || !size.height) return
    const targetCount = 1900 + Math.round((stateConfig.particleDensity || 420) * 1.3)
    if (liquidRef.current.length === targetCount) return
    const particles = new Array(targetCount)
    const cx = size.width / 2
    const cy = size.height / 2
    const rx = Math.min(size.width, size.height) * 0.22
    const ry = Math.min(size.width, size.height) * 0.28
    for (let i = 0; i < targetCount; i += 1) {
      const angle = Math.random() * Math.PI * 2
      const radial = Math.sqrt(Math.random())
      particles[i] = {
        x: cx + Math.cos(angle) * rx * radial,
        y: cy + Math.sin(angle) * ry * radial,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        seed: Math.random() * 1000,
        depth: Math.random(),
        lane: i % 9
      }
    }
    liquidRef.current = particles
  }, [rendererId, size.height, size.width, stateConfig.particleDensity])

  useEffect(() => {
    if (rendererId !== 'gaia-eye' || !size.width || !size.height) return
    const targetCount = 1300 + Math.round((stateConfig.particleDensity || 140) * 5)
    if (eyeRef.current.length === targetCount) return
    const motes = new Array(targetCount)
    const cx = size.width / 2
    const cy = size.height / 2
    const irisRx = Math.min(size.width, size.height) * 0.28
    const irisRy = Math.min(size.width, size.height) * 0.18
    for (let i = 0; i < targetCount; i += 1) {
      const angle = Math.random() * Math.PI * 2
      const radial = Math.sqrt(Math.random())
      motes[i] = {
        x: cx + Math.cos(angle) * irisRx * radial,
        y: cy + Math.sin(angle) * irisRy * radial,
        vx: (Math.random() - 0.5) * 0.24,
        vy: (Math.random() - 0.5) * 0.24,
        seed: Math.random() * 1000,
        depth: Math.random(),
        lane: i % 14
      }
    }
    eyeRef.current = motes
  }, [rendererId, size.height, size.width, stateConfig.particleDensity])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(size.width * dpr)
    canvas.height = Math.floor(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const render = () => {
      phaseRef.current += 0.016
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const cx = width / 2
      const cy = height / 2
      const minDim = Math.min(width, height)
      const energyScalar = getAudioEnergy(audioData) * 1.1

      if (rendererId === 'jarvis-command-hud') {
        const jitterOffset = stateConfig.jitter * 10
        const x = width / 2 + Math.sin(time * 18) * jitterOffset
        const y = height / 2 + Math.cos(time * 15) * jitterOffset * 0.7
        const radius = minDim * 0.16
        drawBackground(ctx, width, height, global, time, stateConfig.hue)
        drawParticles(ctx, width, height, stateConfig, time, global, 1)
        const angle = time * (0.6 + stateConfig.scannerSpeed) * 0.7
        ctx.save()
        const scanner = ctx.createRadialGradient(x, y, radius * 0.1, x, y, radius * 1.5)
        scanner.addColorStop(0, 'rgba(255,255,255,0)')
        scanner.addColorStop(1, hsl(stateConfig.accentHue, 100, 64, 0.12))
        ctx.fillStyle = scanner
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.arc(x, y, radius * 1.45, angle - 0.14, angle + 0.14)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
        drawSegmentedRing(ctx, x, y, radius * 1.05, 7, time, stateConfig, 0.9, 2.4)
        drawSegmentedRing(ctx, x, y, radius * 1.42, 12, time * 1.2, stateConfig, 0.32, 1.2)
        drawSegmentedRing(ctx, x, y, radius * 1.76, 20, -time * 1.1, stateConfig, 0.18, 1)
        ctx.save()
        ctx.lineCap = 'round'
        const bars = 56
        for (let i = 0; i < bars; i += 1) {
          const barAngle = (i / bars) * Math.PI * 2
          const wave = Math.sin(time * 3.4 + i * 0.45) * 0.5 + 0.5
          const noise = Math.sin(time * 5.8 + i * 0.15 + stateConfig.hue * 0.02) * 0.5 + 0.5
          const barLength = (12 + wave * 40 + noise * 18) * stateConfig.barGain * (0.6 + energyScalar * 0.8)
          const inner = radius + 18
          const outer = inner + barLength
          ctx.strokeStyle = hsl(stateConfig.accentHue, 96, 72, 0.34 + wave * 0.42)
          ctx.lineWidth = 1.2 + wave * 2.6
          ctx.beginPath()
          ctx.moveTo(x + Math.cos(barAngle) * inner, y + Math.sin(barAngle) * inner)
          ctx.lineTo(x + Math.cos(barAngle) * outer, y + Math.sin(barAngle) * outer)
          ctx.stroke()
        }
        ctx.restore()
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * (1.4 + global.bloom * 0.8))
        halo.addColorStop(0, hsl(stateConfig.hue, 95, 72, 0.55 + global.bloom * 0.22))
        halo.addColorStop(0.45, hsl(stateConfig.hue, 92, 56, 0.12 + global.bloom * 0.1))
        halo.addColorStop(1, hsl(stateConfig.hue, 92, 40, 0))
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(x, y, radius * (1.4 + global.bloom * 0.8), 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      } else if (rendererId === 'orbital-cathedral') {
        const radius = minDim * 0.14
        drawBackground(ctx, width, height, global, time * 0.7, stateConfig.hue)
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const ambient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 3.2)
        ambient.addColorStop(0, hsl(stateConfig.hue, 82, 68, 0.12 + global.bloom * 0.08))
        ambient.addColorStop(1, hsl(stateConfig.hue, 82, 40, 0))
        ctx.fillStyle = ambient
        ctx.beginPath()
        ctx.arc(cx, cy, radius * 3.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        drawSegmentedRing(ctx, cx, cy, radius * 0.9, 6, time * 0.45, stateConfig, 0.8, 1.6)
        drawSegmentedRing(ctx, cx, cy, radius * 1.3, 8, -time * 0.35, stateConfig, 0.56, 1.4)
        drawSegmentedRing(ctx, cx, cy, radius * 1.72, 12, time * 0.22, stateConfig, 0.28, 1.1)
        drawSegmentedRing(ctx, cx, cy, radius * 2.2, 24, -time * 0.1, stateConfig, 0.12, 1)
        const petalCount = 6 + Math.round(stateConfig.barGain * 6)
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(time * 0.08)
        for (let i = 0; i < petalCount; i += 1) {
          ctx.rotate((Math.PI * 2) / petalCount)
          ctx.strokeStyle = hsl(stateConfig.accentHue, 86, 72, 0.18 + stateConfig.pulse * 0.16)
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.moveTo(0, radius * 0.28)
          ctx.quadraticCurveTo(radius * 0.24, radius * 1.04, 0, radius * 1.84)
          ctx.quadraticCurveTo(-radius * 0.24, radius * 1.04, 0, radius * 0.28)
          ctx.stroke()
        }
        ctx.restore()
      } else if (rendererId === 'signal-bloom') {
        const radius = minDim * 0.17
        drawBackground(ctx, width, height, global, time * 0.9, stateConfig.hue)
        drawParticles(ctx, width, height, stateConfig, time, global, 1.2)
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.8)
        bloom.addColorStop(0, hsl(stateConfig.hue, 100, 76, 0.2 + stateConfig.energy * 0.12))
        bloom.addColorStop(0.4, hsl(stateConfig.accentHue, 94, 66, 0.1 + global.bloom * 0.08))
        bloom.addColorStop(1, hsl(stateConfig.hue, 92, 40, 0))
        ctx.fillStyle = bloom
        ctx.beginPath()
        ctx.arc(cx, cy, radius * 2.8, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        ctx.save()
        for (let layer = 0; layer < 4; layer += 1) {
          ctx.beginPath()
          const steps = 96
          for (let i = 0; i <= steps; i += 1) {
            const angle = (i / steps) * Math.PI * 2
            const wave1 = Math.sin(angle * (2 + layer) + time * (0.8 + stateConfig.ringSpeed * 0.7)) * stateConfig.pulse * radius * 0.12
            const wave2 = Math.cos(angle * (3 + layer) - time * (0.5 + stateConfig.scannerSpeed * 0.6)) * stateConfig.barGain * radius * 0.08
            const localRadius = radius * (0.64 + layer * 0.22) + wave1 + wave2
            const px = cx + Math.cos(angle) * localRadius
            const py = cy + Math.sin(angle) * localRadius
            if (i === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          }
          ctx.closePath()
          ctx.strokeStyle = hsl(layer % 2 === 0 ? stateConfig.hue : stateConfig.accentHue, 96, 72, 0.18 + layer * 0.1)
          ctx.lineWidth = 1.4 + layer * 0.35
          ctx.stroke()
        }
        ctx.restore()
      } else if (rendererId === 'mind-swarm') {
        drawBackground(ctx, width, height, global, time * 0.55, stateConfig.hue)
        const particles = swarmRef.current
        const attractors = getSwarmAttractors(width, height, stateConfig, time, state)
        const outerLimit = minDim * 0.48
        const cohesion = 0.0012 + stateConfig.energy * 0.0022
        const damping = 0.9 - stateConfig.energy * 0.04
        const noiseScale = 0.12 + stateConfig.jitter * 0.44
        const speaking = state === 'speaking' ? 1 : 0
        const thinking = state === 'thinking' ? 1 : 0
        const listeningCompression = state === 'listening' ? 0.72 : 1
        const desiredShell = minDim * (0.1 + stateConfig.energy * 0.08) + Math.sin(time * (0.8 + stateConfig.pulse * 1.6)) * minDim * (0.012 + stateConfig.pulse * 0.02)
        const maxSpeed = 0.8 + stateConfig.energy * 1.6
        for (let i = 0; i < particles.length; i += 1) {
          const particle = particles[i]
          const attractor = attractors[particle.cluster % attractors.length]
          const dx = attractor.x - particle.x
          const dy = attractor.y - particle.y
          const dist = Math.max(14, Math.hypot(dx, dy))
          const nx = dx / dist
          const ny = dy / dist
          const tangentX = -ny
          const tangentY = nx
          const shellError = dist - desiredShell
          particle.vx += nx * shellError * cohesion * attractor.strength
          particle.vy += ny * shellError * cohesion * attractor.strength
          particle.vx += tangentX * attractor.swirl * (0.006 + stateConfig.ringSpeed * 0.006)
          particle.vy += tangentY * attractor.swirl * (0.006 + stateConfig.ringSpeed * 0.006)
          if (thinking) {
            const recursive = Math.sin(time * 0.9 + particle.phase + particle.cluster) * 0.014
            particle.vx += tangentX * recursive
            particle.vy += tangentY * recursive
          }
          particle.vx += Math.sin(particle.seed * 2.7 + time * (0.7 + stateConfig.scannerSpeed * 1.8)) * noiseScale * 0.01
          particle.vy += Math.cos(particle.seed * 1.9 - time * (0.6 + stateConfig.ringSpeed * 1.4)) * noiseScale * 0.01
          if (speaking) {
            const cdX = particle.x - cx
            const cdY = particle.y - cy
            const cDist = Math.max(1, Math.hypot(cdX, cdY))
            particle.vx += (cdX / cDist) * (0.0018 + stateConfig.pulse * 0.002)
            particle.vy += (cdY / cDist) * (0.0018 + stateConfig.pulse * 0.002)
          }
          particle.vx *= damping
          particle.vy *= damping
          const speed = Math.hypot(particle.vx, particle.vy)
          if (speed > maxSpeed) {
            particle.vx = (particle.vx / speed) * maxSpeed
            particle.vy = (particle.vy / speed) * maxSpeed
          }
          particle.x += particle.vx
          particle.y += particle.vy
          const fromCenterX = particle.x - cx
          const fromCenterY = (particle.y - cy) / listeningCompression
          const centerDist = Math.hypot(fromCenterX, fromCenterY)
          if (centerDist > outerLimit) {
            particle.vx -= (fromCenterX / centerDist) * 0.04
            particle.vy -= (fromCenterY / centerDist) * 0.04
          }
        }
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const sorted = particles.slice().sort((a, b) => a.z - b.z)
        for (let i = 0; i < sorted.length; i += 1) {
          const particle = sorted[i]
          const px = particle.x
          const py = cy + (particle.y - cy) * listeningCompression
          const alpha = 0.025 + particle.z * 0.18
          const size = 0.3 + (0.5 + particle.z * 0.9) * 1.1 + energyScalar * 0.18
          ctx.fillStyle = hsl(particle.cluster % 4 === 0 ? stateConfig.accentHue : stateConfig.hue, 94, 72, alpha)
          ctx.beginPath()
          ctx.arc(px, py, size, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      } else if (rendererId === 'living-ink') {
        const particles = liquidRef.current
        const bgAlpha = global.backgroundOpacity ?? 1
        ctx.fillStyle = `rgba(2, 4, 9, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
        ctx.fillRect(0, 0, width, height)
        const shellRx = minDim * (0.21 + stateConfig.energy * 0.05)
        const shellRy = minDim * (0.29 + stateConfig.pulse * 0.03)
        const maxSpeed = 0.42 + stateConfig.energy * 0.8
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, shellRy * 2.8)
        glow.addColorStop(0, hsl(stateConfig.hue, 100, 56, 0.08))
        glow.addColorStop(0.42, hsl(stateConfig.accentHue, 96, 48, 0.08 + global.bloom * 0.04))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.ellipse(cx, cy, shellRx * 1.8, shellRy * 1.9, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        for (let i = 0; i < particles.length; i += 1) {
          const p = particles[i]
          const dx = p.x - cx
          const dy = p.y - cy
          const angle = Math.atan2(dy, dx)
          const ellDist = Math.hypot(dx / shellRx, dy / shellRy)
          const localPhase = time * (0.8 + stateConfig.ringSpeed) + p.seed
          const curl = (Math.sin(localPhase * 1.6) * 0.5 + 0.5) * (0.005 + stateConfig.pulse * 0.012)
          p.vx += Math.cos(angle + Math.PI / 2) * curl
          p.vy += Math.sin(angle + Math.PI / 2) * curl
          p.vx += Math.sin(p.seed * 1.8 + time) * 0.004
          p.vy += Math.cos(p.seed * 1.4 - time * 0.8) * 0.004
          if (ellDist > 1) {
            p.vx -= (dx / Math.max(1, Math.hypot(dx, dy))) * 0.06
            p.vy -= (dy / Math.max(1, Math.hypot(dx, dy))) * 0.06
          } else {
            p.vx += (Math.cos(angle) * (0.002 + stateConfig.energy * 0.0028) * (0.45 + ellDist * 0.9))
            p.vy += (Math.sin(angle) * (0.002 + stateConfig.energy * 0.0028) * (0.45 + ellDist * 0.9))
          }
          if (state === 'error') {
            p.vx += (Math.random() - 0.5) * stateConfig.jitter * 0.1
            p.vy += (Math.random() - 0.5) * stateConfig.jitter * 0.1
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
        }
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const sorted = particles.slice().sort((a, b) => a.depth - b.depth)
        for (let i = 0; i < sorted.length; i += 1) {
          const p = sorted[i]
          const dx = p.x - cx
          const dy = p.y - cy
          const radial = clamp(Math.hypot(dx / shellRx, dy / shellRy), 0, 1.2)
          const hue = i % 5 === 0 ? stateConfig.accentHue : stateConfig.hue
          const size = 0.45 + p.depth * 1.1 + (1 - radial) * 0.7
          const alpha = 0.02 + p.depth * 0.12 + (1 - radial) * 0.05
          ctx.fillStyle = hsl(hue, 100, 68, alpha * 0.14)
          ctx.beginPath()
          ctx.arc(p.x, p.y, size * 3.4, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = hsl(hue, 100, 76, alpha * 0.3)
          ctx.beginPath()
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      } else if (rendererId === 'gaia-eye') {
        const motes = eyeRef.current
        const blink = state === 'listening' ? 0.92 : 1
        const thinking = state === 'thinking' ? 1 : 0
        const speaking = state === 'speaking' ? 1 : 0
        const errorMode = state === 'error' ? 1 : 0
        const irisRx = minDim * (0.3 + stateConfig.energy * 0.02)
        const irisRy = minDim * (0.19 + stateConfig.pulse * 0.015) * blink
        const pupilRx = irisRx * (0.18 + (state === 'listening' ? 0.06 : 0))
        const pupilRy = irisRy * (0.22 + (state === 'listening' ? 0.07 : 0))
        const audioKick = energyScalar * 0.85
        const maxSpeed = 0.64 + stateConfig.energy * 0.9
        ctx.fillStyle = 'rgba(0, 0, 0, 0.985)'
        ctx.fillRect(0, 0, width, height)
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, irisRx * 1.8)
        aura.addColorStop(0, hsl(stateConfig.accentHue, 98, 56, 0.03))
        aura.addColorStop(0.42, hsl(stateConfig.hue, 98, 38, 0.05 + global.bloom * 0.03))
        aura.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = aura
        ctx.beginPath()
        ctx.ellipse(cx, cy, irisRx * 1.95, irisRy * 2.35, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
        for (let i = 0; i < motes.length; i += 1) {
          const mote = motes[i]
          const angle = Math.atan2(mote.y - cy, mote.x - cx)
          const radialNorm = Math.hypot((mote.x - cx) / irisRx, (mote.y - cy) / irisRy)
          const strandWave = Math.sin(angle * (7 + mote.lane * 0.12) + time * (0.8 + stateConfig.ringSpeed * 1.1) + mote.seed) * (10 + stateConfig.pulse * 16)
          const targetX = cx + Math.cos(angle + thinking * Math.sin(time * 0.9 + mote.seed) * 0.06) * (irisRx * clamp(radialNorm, 0.14, 0.98) + strandWave * 0.22)
          const targetY = cy + Math.sin(angle + thinking * Math.sin(time * 0.7 + mote.seed) * 0.08) * (irisRy * clamp(radialNorm, 0.14, 0.98) + strandWave * 0.12)
          mote.vx += (targetX - mote.x) * 0.0018
          mote.vy += (targetY - mote.y) * 0.0018
          const tangent = angle + Math.PI / 2
          const swirl = (0.002 + stateConfig.ringSpeed * 0.003 + audioKick * 0.002) * (0.4 + radialNorm)
          mote.vx += Math.cos(tangent) * swirl
          mote.vy += Math.sin(tangent) * swirl
          if (speaking) {
            const flare = Math.sin(time * 5.4 + mote.seed * 0.8) * (0.01 + stateConfig.barGain * 0.03 + audioKick * 0.05)
            mote.vx += Math.cos(angle) * flare
            mote.vy += Math.sin(angle) * flare * 0.8
          }
          if (errorMode) {
            mote.vx += (Math.random() - 0.5) * stateConfig.jitter * 0.16
            mote.vy += (Math.random() - 0.5) * stateConfig.jitter * 0.16
          }
          mote.vx *= 0.935
          mote.vy *= 0.935
          const speed = Math.hypot(mote.vx, mote.vy)
          if (speed > maxSpeed) {
            mote.vx = (mote.vx / speed) * maxSpeed
            mote.vy = (mote.vy / speed) * maxSpeed
          }
          mote.x += mote.vx
          mote.y += mote.vy
        }
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        const irisField = ctx.createRadialGradient(cx, cy, pupilRx * 0.5, cx, cy, irisRx * 1.04)
        irisField.addColorStop(0, hsl(stateConfig.hue, 100, 38, 0.14))
        irisField.addColorStop(0.36, hsl(stateConfig.hue, 100, 44, 0.12))
        irisField.addColorStop(0.62, hsl(stateConfig.accentHue, 96, 42, 0.12))
        irisField.addColorStop(1, hsl(stateConfig.hue, 94, 24, 0))
        ctx.fillStyle = irisField
        ctx.beginPath()
        ctx.ellipse(cx, cy, irisRx, irisRy, 0, 0, Math.PI * 2)
        ctx.fill()
        const sorted = motes.slice().sort((a, b) => a.depth - b.depth)
        for (let i = 0; i < sorted.length; i += 1) {
          const mote = sorted[i]
          const dx = mote.x - cx
          const dy = mote.y - cy
          const radial = clamp(Math.hypot(dx / irisRx, dy / irisRy), 0, 1.2)
          const hue = radial > 0.68 || i % 11 === 0 ? stateConfig.accentHue : stateConfig.hue
          const size = 0.34 + mote.depth * 1.04 + (1 - radial) * 0.8 + audioKick * 0.18
          const alpha = 0.03 + mote.depth * 0.12 + (1 - radial) * 0.08
          ctx.fillStyle = hsl(hue, 100, 72, alpha * 0.14)
          ctx.beginPath()
          ctx.arc(mote.x, mote.y, size * 3.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = hsl(hue, 100, 70, alpha * 0.3)
          ctx.beginPath()
          ctx.arc(mote.x, mote.y, size, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
        ctx.fillStyle = 'rgba(0,0,0,1)'
        ctx.beginPath()
        ctx.ellipse(cx, cy, pupilRx, pupilRy, 0, 0, Math.PI * 2)
        ctx.fill()
      }

      frameRef.current = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(frameRef.current)
  }, [audioData, global, rendererId, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
