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

function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
  roundedRectPath(ctx, x, y, width, height, radius)
  ctx.fillStyle = fillStyle
  ctx.fill()
}

function strokeRoundedRect(ctx, x, y, width, height, radius, strokeStyle, lineWidth = 1) {
  roundedRectPath(ctx, x, y, width, height, radius)
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

function drawBracketBox(ctx, x, y, width, height, strokeStyle, lineWidth = 1.4, corner = 8) {
  const c = Math.min(corner, width / 2, height / 2)
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(x, y + c)
  ctx.lineTo(x, y)
  ctx.lineTo(x + c, y)
  ctx.moveTo(x + width - c, y)
  ctx.lineTo(x + width, y)
  ctx.lineTo(x + width, y + c)
  ctx.moveTo(x + width, y + height - c)
  ctx.lineTo(x + width, y + height)
  ctx.lineTo(x + width - c, y + height)
  ctx.moveTo(x + c, y + height)
  ctx.lineTo(x, y + height)
  ctx.lineTo(x, y + height - c)
  ctx.stroke()
}

function getBasePreset(presetId) {
  if (presetId === 'deep-scrape') {
    return {
      global: { backdrop: 0.84, bloom: 1.12, noise: 0.06, glassDepth: 1.18, refraction: 1.02, chromeParallax: 0.88 },
      states: {
        idle: { hue: 192, accentHue: 214, energy: 0.22, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.1, barGain: 0.22, particleDensity: 92, orbitCount: 7, jitter: 0.01, selectorDensity: 0.76, focusLock: 0.78 },
        listening: { hue: 188, accentHue: 204, energy: 0.42, pulse: 0.22, ringSpeed: 0.14, scannerSpeed: 0.34, barGain: 0.34, particleDensity: 112, orbitCount: 9, jitter: 0.02, selectorDensity: 1.08, focusLock: 1.02 },
        thinking: { hue: 196, accentHue: 220, energy: 0.76, pulse: 0.36, ringSpeed: 0.18, scannerSpeed: 0.28, barGain: 0.44, particleDensity: 128, orbitCount: 10, jitter: 0.03, selectorDensity: 1.28, focusLock: 1.16 },
        speaking: { hue: 190, accentHue: 214, energy: 0.98, pulse: 0.8, ringSpeed: 0.24, scannerSpeed: 0.22, barGain: 0.58, particleDensity: 124, orbitCount: 9, jitter: 0.03, selectorDensity: 0.94, focusLock: 0.86 },
        error: { hue: 6, accentHue: 18, energy: 1.12, pulse: 0.92, ringSpeed: 0.14, scannerSpeed: 0.38, barGain: 0.64, particleDensity: 118, orbitCount: 8, jitter: 0.16, selectorDensity: 1.1, focusLock: 0.72 }
      }
    }
  }

  if (presetId === 'watchtower') {
    return {
      global: { backdrop: 0.9, bloom: 0.98, noise: 0.04, glassDepth: 1.04, refraction: 0.68, chromeParallax: 1.08 },
      states: {
        idle: { hue: 196, accentHue: 210, energy: 0.18, pulse: 0.08, ringSpeed: 0.06, scannerSpeed: 0.08, barGain: 0.18, particleDensity: 76, orbitCount: 6, jitter: 0.01, selectorDensity: 0.48, focusLock: 0.68 },
        listening: { hue: 192, accentHue: 206, energy: 0.34, pulse: 0.16, ringSpeed: 0.1, scannerSpeed: 0.24, barGain: 0.28, particleDensity: 92, orbitCount: 8, jitter: 0.01, selectorDensity: 0.72, focusLock: 0.96 },
        thinking: { hue: 198, accentHue: 222, energy: 0.6, pulse: 0.26, ringSpeed: 0.14, scannerSpeed: 0.22, barGain: 0.34, particleDensity: 106, orbitCount: 9, jitter: 0.02, selectorDensity: 0.88, focusLock: 1.04 },
        speaking: { hue: 192, accentHue: 208, energy: 0.82, pulse: 0.66, ringSpeed: 0.18, scannerSpeed: 0.16, barGain: 0.44, particleDensity: 100, orbitCount: 8, jitter: 0.02, selectorDensity: 0.66, focusLock: 0.84 },
        error: { hue: 2, accentHue: 16, energy: 1.0, pulse: 0.84, ringSpeed: 0.12, scannerSpeed: 0.32, barGain: 0.58, particleDensity: 96, orbitCount: 7, jitter: 0.14, selectorDensity: 0.9, focusLock: 0.62 }
      }
    }
  }

  return {
    global: { backdrop: 0.86, bloom: 1.06, noise: 0.05, glassDepth: 1.1, refraction: 0.82, chromeParallax: 0.78 },
    states: {
      idle: { hue: 194, accentHue: 214, energy: 0.2, pulse: 0.1, ringSpeed: 0.06, scannerSpeed: 0.08, barGain: 0.2, particleDensity: 82, orbitCount: 6, jitter: 0.01, selectorDensity: 0.58, focusLock: 0.72 },
      listening: { hue: 190, accentHue: 206, energy: 0.38, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.3, particleDensity: 98, orbitCount: 8, jitter: 0.01, selectorDensity: 0.88, focusLock: 0.98 },
      thinking: { hue: 198, accentHue: 220, energy: 0.68, pulse: 0.3, ringSpeed: 0.16, scannerSpeed: 0.24, barGain: 0.38, particleDensity: 116, orbitCount: 9, jitter: 0.02, selectorDensity: 1.04, focusLock: 1.08 },
      speaking: { hue: 192, accentHue: 212, energy: 0.9, pulse: 0.74, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.52, particleDensity: 112, orbitCount: 8, jitter: 0.02, selectorDensity: 0.78, focusLock: 0.84 },
      error: { hue: 4, accentHue: 18, energy: 1.08, pulse: 0.88, ringSpeed: 0.14, scannerSpeed: 0.36, barGain: 0.62, particleDensity: 108, orbitCount: 7, jitter: 0.15, selectorDensity: 0.96, focusLock: 0.66 }
    }
  }
}

export function getBrowserLensConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function getFocusZone(scene, state) {
  const zones = {
    idle: {
      x: scene.contentX + scene.contentW * 0.16,
      y: scene.contentY + scene.contentH * 0.14,
      w: scene.contentW * 0.42,
      h: scene.contentH * 0.18
    },
    listening: {
      x: scene.windowX + scene.windowW * 0.3,
      y: scene.windowY + scene.topBarH * 0.22,
      w: scene.windowW * 0.44,
      h: scene.topBarH * 0.44
    },
    thinking: {
      x: scene.contentX + scene.contentW * 0.2,
      y: scene.contentY + scene.contentH * 0.44,
      w: scene.contentW * 0.44,
      h: scene.contentH * 0.22
    },
    speaking: {
      x: scene.contentX + scene.contentW * 0.7,
      y: scene.contentY + scene.contentH * 0.22,
      w: scene.contentW * 0.22,
      h: scene.contentH * 0.14
    },
    error: {
      x: scene.contentX + scene.contentW * 0.58,
      y: scene.contentY + scene.contentH * 0.05,
      w: scene.contentW * 0.26,
      h: scene.contentH * 0.1
    }
  }
  return zones[state] || zones.idle
}

function drawBrowserWindow(ctx, scene, focusZone, stateConfig, renderState) {
  const {
    time,
    detailBoost,
    blur,
    alpha,
    hue,
    accentHue,
    audioKick,
    global,
    listening,
    thinking,
    speaking,
    errorMode
  } = renderState

  const chromeParallax = clamp(global.chromeParallax ?? 0.8, 0.2, 1.4)
  const selectorDensity = clamp(stateConfig.selectorDensity ?? 0.7, 0.2, 1.6)
  const jitter = stateConfig.jitter ?? 0
  const driftX = Math.sin(time * 0.42) * scene.windowW * 0.008 * chromeParallax
  const driftY = Math.cos(time * 0.36) * scene.windowH * 0.01 * chromeParallax
  const errorOffsetX = errorMode ? Math.sign(Math.sin(time * 3.6)) * scene.windowW * 0.004 * jitter : 0
  const errorOffsetY = errorMode ? Math.sign(Math.cos(time * 4.2)) * scene.windowH * 0.003 * jitter : 0
  const windowX = scene.windowX + driftX + errorOffsetX
  const windowY = scene.windowY + driftY + errorOffsetY
  const contentY = windowY + scene.topBarH
  const contentX = windowX + scene.windowW * 0.03
  const contentW = scene.windowW * 0.94
  const contentH = scene.windowH - scene.topBarH - scene.windowH * 0.04
  const leftW = contentW * 0.66
  const rightX = contentX + leftW + contentW * 0.035
  const rightW = contentW * 0.305
  const lineAlpha = 0.16 + detailBoost * 0.08
  const selectorCount = clamp(Math.round((stateConfig.particleDensity || 90) * 0.08 * selectorDensity), 6, 22)
  const tabCount = clamp(Math.round(3 + (stateConfig.orbitCount || 6) * 0.26), 3, 6)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.filter = blur > 0 ? `blur(${blur}px) saturate(${0.88 + detailBoost * 0.08})` : 'none'

  ctx.shadowColor = hsl(hue, 92, 12, 0.38)
  ctx.shadowBlur = 36 * detailBoost
  drawRoundedRect(ctx, windowX, windowY, scene.windowW, scene.windowH, scene.windowW * 0.035, hsl(hue, 36, 8, 0.78))
  ctx.shadowBlur = 0

  const shellGradient = ctx.createLinearGradient(windowX, windowY, windowX, windowY + scene.windowH)
  shellGradient.addColorStop(0, hsl(hue, 34, 18, 0.88))
  shellGradient.addColorStop(1, hsl(hue, 32, 9, 0.96))
  drawRoundedRect(ctx, windowX, windowY, scene.windowW, scene.windowH, scene.windowW * 0.035, shellGradient)

  const topGradient = ctx.createLinearGradient(windowX, windowY, windowX + scene.windowW, windowY + scene.topBarH)
  topGradient.addColorStop(0, hsl(accentHue, 72, 16, 0.92))
  topGradient.addColorStop(1, hsl(hue, 56, 12, 0.96))
  drawRoundedRect(ctx, windowX, windowY, scene.windowW, scene.topBarH + 2, scene.windowW * 0.035, topGradient)

  const dotColors = ['#fb7185', '#f59e0b', '#22c55e']
  dotColors.forEach((color, index) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(windowX + scene.windowW * (0.055 + index * 0.03), windowY + scene.topBarH * 0.5, scene.topBarH * 0.11, 0, Math.PI * 2)
    ctx.fill()
  })

  for (let index = 0; index < tabCount; index += 1) {
    const active = index === (thinking ? 2 : listening ? 1 : 0)
    const tabW = scene.windowW * 0.14
    const tabX = windowX + scene.windowW * 0.2 + index * (tabW + scene.windowW * 0.015)
    const tabY = windowY + scene.topBarH * 0.18
    drawRoundedRect(
      ctx,
      tabX,
      tabY,
      tabW,
      scene.topBarH * 0.44,
      scene.topBarH * 0.14,
      active
        ? hsl(accentHue, 90, 72, 0.2 + detailBoost * 0.08)
        : hsl(hue, 28, 100, 0.08 + index * 0.01)
    )
    ctx.fillStyle = active ? hsl(accentHue, 92, 86, 0.8) : hsl(hue, 18, 88, 0.32)
    drawRoundedRect(ctx, tabX + tabW * 0.12, tabY + scene.topBarH * 0.11, tabW * 0.46, scene.topBarH * 0.08, scene.topBarH * 0.03, ctx.fillStyle)
    drawRoundedRect(ctx, tabX + tabW * 0.12, tabY + scene.topBarH * 0.23, tabW * 0.26, scene.topBarH * 0.06, scene.topBarH * 0.03, hsl(hue, 12, 100, 0.24))
  }

  const addressX = windowX + scene.windowW * 0.24
  const addressY = windowY + scene.topBarH * 0.56
  const addressW = scene.windowW * 0.44
  const addressH = scene.topBarH * 0.24
  drawRoundedRect(ctx, addressX, addressY, addressW, addressH, addressH * 0.5, hsl(hue, 28, 100, 0.08))
  strokeRoundedRect(ctx, addressX, addressY, addressW, addressH, addressH * 0.5, hsl(accentHue, 92, 84, 0.16 + listening * 0.18), 1.1)
  drawRoundedRect(ctx, addressX + addressW * 0.06, addressY + addressH * 0.32, addressW * 0.16, addressH * 0.14, addressH * 0.06, hsl(accentHue, 82, 82, 0.55))
  drawRoundedRect(ctx, addressX + addressW * 0.26, addressY + addressH * 0.32, addressW * 0.42, addressH * 0.14, addressH * 0.06, hsl(hue, 12, 100, 0.2))
  if (listening || thinking) {
    const scanX = addressX + ((Math.sin(time * (1.4 + stateConfig.scannerSpeed)) + 1) * 0.5) * addressW
    const scanGradient = ctx.createLinearGradient(scanX - 30, addressY, scanX + 30, addressY)
    scanGradient.addColorStop(0, 'rgba(255,255,255,0)')
    scanGradient.addColorStop(0.5, hsl(accentHue, 100, 82, 0.18 + listening * 0.12 + thinking * 0.08))
    scanGradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = scanGradient
    ctx.fillRect(addressX, addressY, addressW, addressH)
  }

  drawRoundedRect(ctx, contentX, contentY, contentW, contentH, scene.windowW * 0.02, hsl(hue, 28, 8, 0.82))
  const pageGradient = ctx.createLinearGradient(contentX, contentY, contentX + contentW, contentY + contentH)
  pageGradient.addColorStop(0, hsl(hue, 46, 16, 0.92))
  pageGradient.addColorStop(0.55, hsl(accentHue, 42, 12, 0.84))
  pageGradient.addColorStop(1, hsl(hue, 36, 8, 0.96))
  drawRoundedRect(ctx, contentX, contentY, contentW, contentH, scene.windowW * 0.02, pageGradient)

  const heroX = contentX + contentW * 0.03
  const heroY = contentY + contentH * 0.05
  const heroW = leftW * 0.95
  const heroH = contentH * 0.28
  const heroGradient = ctx.createLinearGradient(heroX, heroY, heroX + heroW, heroY + heroH)
  heroGradient.addColorStop(0, hsl(accentHue, 86, 56, 0.18 + detailBoost * 0.04))
  heroGradient.addColorStop(0.5, hsl(hue, 78, 44, 0.14 + listening * 0.04))
  heroGradient.addColorStop(1, hsl(accentHue, 90, 74, 0.18 + speaking * 0.06))
  drawRoundedRect(ctx, heroX, heroY, heroW, heroH, scene.windowW * 0.018, heroGradient)
  for (let index = 0; index < 5; index += 1) {
    drawRoundedRect(
      ctx,
      heroX + heroW * 0.06,
      heroY + heroH * (0.12 + index * 0.14),
      heroW * (0.52 - index * 0.05),
      heroH * 0.04,
      heroH * 0.02,
      hsl(index % 2 === 0 ? accentHue : hue, 88, 88, lineAlpha + index * 0.02)
    )
  }

  const heroFocusFill = hsl(accentHue, 100, 86, 0.08 + detailBoost * 0.05 + (listening || thinking) * 0.06)
  drawRoundedRect(ctx, focusZone.x, focusZone.y, focusZone.w, focusZone.h, focusZone.h * 0.18, heroFocusFill)
  drawBracketBox(ctx, focusZone.x, focusZone.y, focusZone.w, focusZone.h, hsl(errorMode ? 8 : accentHue, 100, errorMode ? 72 : 84, 0.34 + detailBoost * 0.16), 1.4 + detailBoost * 0.2)

  const tableX = contentX + contentW * 0.05
  const tableY = contentY + contentH * 0.4
  const tableW = leftW * 0.88
  const tableH = contentH * 0.42
  drawRoundedRect(ctx, tableX, tableY, tableW, tableH, scene.windowW * 0.014, hsl(hue, 22, 100, 0.06))
  for (let row = 0; row < 5; row += 1) {
    const y = tableY + tableH * (0.08 + row * 0.18)
    drawRoundedRect(ctx, tableX + tableW * 0.04, y, tableW * 0.32, tableH * 0.05, tableH * 0.02, hsl(accentHue, 88, 88, 0.16 + row * 0.015))
    drawRoundedRect(ctx, tableX + tableW * 0.44, y, tableW * 0.18, tableH * 0.05, tableH * 0.02, hsl(hue, 10, 100, 0.18))
    drawRoundedRect(ctx, tableX + tableW * 0.72, y, tableW * 0.14, tableH * 0.05, tableH * 0.02, hsl(accentHue, 90, 84, 0.14 + row * 0.015))
  }
  for (let row = 1; row < 5; row += 1) {
    ctx.strokeStyle = hsl(hue, 12, 100, 0.08)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(tableX + tableW * 0.04, tableY + tableH * (0.05 + row * 0.18))
    ctx.lineTo(tableX + tableW * 0.94, tableY + tableH * (0.05 + row * 0.18))
    ctx.stroke()
  }

  for (let card = 0; card < 3; card += 1) {
    const cardY = contentY + contentH * (0.08 + card * 0.22)
    drawRoundedRect(ctx, rightX, cardY, rightW, contentH * 0.16, scene.windowW * 0.016, hsl(accentHue, 42, 18, 0.26))
    drawRoundedRect(ctx, rightX + rightW * 0.08, cardY + contentH * 0.03, rightW * 0.54, contentH * 0.028, contentH * 0.012, hsl(accentHue, 96, 88, 0.22 + card * 0.03))
    drawRoundedRect(ctx, rightX + rightW * 0.08, cardY + contentH * 0.08, rightW * 0.34, contentH * 0.022, contentH * 0.011, hsl(hue, 12, 100, 0.18))
    drawRoundedRect(ctx, rightX + rightW * 0.08, cardY + contentH * 0.115, rightW * 0.22, contentH * 0.018, contentH * 0.009, hsl(accentHue, 92, 80, 0.16))
  }

  const alertY = contentY + contentH * 0.76
  drawRoundedRect(ctx, rightX, alertY, rightW, contentH * 0.12, scene.windowW * 0.016, errorMode ? hsl(8, 82, 34, 0.38) : hsl(accentHue, 48, 20, 0.24))
  drawRoundedRect(ctx, rightX + rightW * 0.08, alertY + contentH * 0.034, rightW * 0.46, contentH * 0.024, contentH * 0.011, errorMode ? hsl(8, 100, 86, 0.38) : hsl(accentHue, 92, 88, 0.18))
  drawRoundedRect(ctx, rightX + rightW * 0.08, alertY + contentH * 0.072, rightW * 0.28, contentH * 0.018, contentH * 0.009, hsl(hue, 12, 100, 0.16))

  for (let index = 0; index < selectorCount; index += 1) {
    const seed = index * 17.37
    const px = contentX + contentW * (0.08 + (((Math.sin(seed + time * 0.18) + 1) * 0.5) * 0.76))
    const py = contentY + contentH * (0.08 + (((Math.cos(seed * 0.83 + time * 0.14) + 1) * 0.5) * 0.74))
    const width = contentW * (0.06 + ((index % 5) * 0.018))
    const height = contentH * (0.028 + ((index % 4) * 0.012))
    const cx = px + width / 2
    const cy = py + height / 2
    const focusX = focusZone.x + focusZone.w / 2
    const focusY = focusZone.y + focusZone.h / 2
    const distance = Math.hypot(cx - focusX, cy - focusY)
    const focusInfluence = 1 - clamp(distance / (contentW * 0.34), 0, 1)
    const alphaBoost = 0.08 + focusInfluence * 0.22 + listening * 0.08 + thinking * 0.1
    const stroke = hsl(errorMode && index % 6 === 0 ? 8 : accentHue, 100, errorMode ? 74 : 82, alphaBoost)
    drawBracketBox(ctx, px, py, width, height, stroke, 1 + focusInfluence * 1.1 * detailBoost, 6 + focusInfluence * 4)
  }

  if (thinking) {
    ctx.strokeStyle = hsl(accentHue, 100, 84, 0.16 + thinking * 0.08)
    ctx.lineWidth = 1.1
    ctx.setLineDash([8, 10])
    for (let line = 0; line < 3; line += 1) {
      const y = contentY + contentH * (0.22 + line * 0.19) + Math.sin(time * 1.2 + line) * contentH * 0.01
      ctx.beginPath()
      ctx.moveTo(contentX + contentW * 0.05, y)
      ctx.lineTo(contentX + contentW * 0.95, y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  if (speaking) {
    for (let chip = 0; chip < 3; chip += 1) {
      const chipX = rightX + rightW * 0.06
      const chipY = contentY + contentH * (0.52 + chip * 0.11)
      const chipW = rightW * (0.72 - chip * 0.1)
      const chipH = contentH * 0.06
      drawRoundedRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.5, hsl(accentHue, 94, 68, 0.16 + chip * 0.04 + audioKick * 0.08))
      drawRoundedRect(ctx, chipX + chipW * 0.08, chipY + chipH * 0.34, chipW * 0.52, chipH * 0.14, chipH * 0.07, hsl(hue, 98, 96, 0.26 + chip * 0.04))
    }
  }

  const scrollX = windowX + scene.windowW * 0.965
  drawRoundedRect(ctx, scrollX, contentY + contentH * 0.02, scene.windowW * 0.01, contentH * 0.96, scene.windowW * 0.005, hsl(hue, 12, 100, 0.08))
  drawRoundedRect(
    ctx,
    scrollX,
    contentY + contentH * (0.18 + Math.sin(time * 0.3 + chromeParallax) * 0.08),
    scene.windowW * 0.01,
    contentH * 0.18,
    scene.windowW * 0.005,
    hsl(accentHue, 96, 84, 0.22 + listening * 0.08 + thinking * 0.05)
  )

  ctx.restore()
}

function drawOrbitTabs(ctx, lens, stateConfig, accentHue, time, speaking, listening) {
  const count = clamp(Math.round(stateConfig.orbitCount || 6), 4, 12)
  const radius = lens.radius * 1.36
  for (let index = 0; index < count; index += 1) {
    const angle = time * (0.18 + stateConfig.ringSpeed * 0.08) + (index / count) * Math.PI * 2
    const x = lens.x + Math.cos(angle) * radius
    const y = lens.y + Math.sin(angle) * radius * 0.78
    const width = lens.radius * 0.18
    const height = lens.radius * 0.07
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle * 0.18)
    drawRoundedRect(ctx, -width / 2, -height / 2, width, height, height * 0.5, hsl(accentHue, 92, 72, 0.12 + listening * 0.06 + speaking * 0.08))
    drawRoundedRect(ctx, -width * 0.26, -height * 0.08, width * 0.42, height * 0.16, height * 0.08, hsl(accentHue, 100, 92, 0.28))
    ctx.restore()
  }
}

function drawLensHandle(ctx, lens, hue, accentHue, glassDepth) {
  const angle = Math.PI / 4
  const handleLength = lens.radius * 1.02
  const handleWidth = lens.radius * 0.24
  const startX = lens.x + Math.cos(angle) * lens.radius * 0.62
  const startY = lens.y + Math.sin(angle) * lens.radius * 0.62
  const endX = startX + Math.cos(angle) * handleLength
  const endY = startY + Math.sin(angle) * handleLength

  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = hsl(hue, 92, 8, 0.52)
  ctx.lineWidth = handleWidth + 8
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(endX, endY)
  ctx.stroke()

  const handleGradient = ctx.createLinearGradient(startX, startY, endX, endY)
  handleGradient.addColorStop(0, hsl(accentHue, 88, 72, 0.34))
  handleGradient.addColorStop(0.5, hsl(hue, 88, 64, 0.22 + glassDepth * 0.06))
  handleGradient.addColorStop(1, hsl(accentHue, 94, 84, 0.42))
  ctx.strokeStyle = handleGradient
  ctx.lineWidth = handleWidth
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(endX, endY)
  ctx.stroke()

  ctx.strokeStyle = hsl(accentHue, 100, 96, 0.22)
  ctx.lineWidth = handleWidth * 0.22
  ctx.beginPath()
  ctx.moveTo(startX - Math.sin(angle) * handleWidth * 0.2, startY + Math.cos(angle) * handleWidth * 0.2)
  ctx.lineTo(endX - Math.sin(angle) * handleWidth * 0.2, endY + Math.cos(angle) * handleWidth * 0.2)
  ctx.stroke()
  ctx.restore()
}

function drawHorns(ctx, lens, accentHue, glassDepth, errorMode) {
  const hornHeight = lens.radius * 0.28 * glassDepth
  const hornWidth = lens.radius * 0.2
  const hornY = lens.y - lens.radius * 0.96
  const baseInset = lens.radius * 0.46

  ;[-1, 1].forEach(direction => {
    const baseX = lens.x + direction * baseInset
    ctx.beginPath()
    ctx.moveTo(baseX, hornY + hornHeight * 0.9)
    ctx.quadraticCurveTo(baseX + direction * hornWidth * 0.22, hornY + hornHeight * 0.26, baseX + direction * hornWidth * 0.18, hornY)
    ctx.quadraticCurveTo(baseX + direction * hornWidth * 0.52, hornY + hornHeight * 0.2, baseX + direction * hornWidth * 0.48, hornY + hornHeight * 0.82)
    ctx.quadraticCurveTo(baseX + direction * hornWidth * 0.08, hornY + hornHeight * 0.82, baseX, hornY + hornHeight * 0.9)
    ctx.closePath()
    const hornGradient = ctx.createLinearGradient(baseX, hornY, baseX, hornY + hornHeight)
    hornGradient.addColorStop(0, hsl(errorMode ? 8 : accentHue, 100, errorMode ? 82 : 92, 0.34))
    hornGradient.addColorStop(1, hsl(accentHue, 86, 68, 0.16))
    ctx.fillStyle = hornGradient
    ctx.fill()
    ctx.strokeStyle = hsl(accentHue, 100, 92, 0.18)
    ctx.lineWidth = 1.2
    ctx.stroke()
  })
}

export default function BrowserLensVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'chrome-scout'
  const { global, state: stateConfig } = useMemo(
    () => getBrowserLensConfig(presetId, assignment?.overrides, state),
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
      const audioKick = getAudioEnergy(audioData) * 0.94
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const glassDepth = clamp(global.glassDepth ?? 1, 0.7, 1.4)
      const refraction = clamp(global.refraction ?? 0.8, 0.2, 1.4)
      const focusLock = clamp(stateConfig.focusLock ?? 0.8, 0.2, 1.4)
      const hue = stateConfig.hue
      const accentHue = stateConfig.accentHue

      const scene = {
        windowX: width * 0.1,
        windowY: height * 0.12,
        windowW: width * 0.8,
        windowH: height * 0.66,
        topBarH: height * 0.09
      }
      scene.contentX = scene.windowX + scene.windowW * 0.03
      scene.contentY = scene.windowY + scene.topBarH
      scene.contentW = scene.windowW * 0.94
      scene.contentH = scene.windowH - scene.topBarH - scene.windowH * 0.04

      const focusZone = getFocusZone(scene, state)
      const focusCenterX = focusZone.x + focusZone.w / 2
      const focusCenterY = focusZone.y + focusZone.h / 2
      const lens = {
        x: width * 0.5,
        y: height * 0.54,
        radius: minDim * (0.22 + (glassDepth - 1) * 0.03)
      }

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = `rgba(3, 8, 16, ${(0.94 + global.backdrop * 0.04) * bgAlpha})`
      ctx.fillRect(0, 0, width, height)

      const backdrop = ctx.createRadialGradient(lens.x, lens.y, lens.radius * 0.2, lens.x, lens.y, minDim * 0.8)
      backdrop.addColorStop(0, hsl(accentHue, 100, 66, 0.07 + global.bloom * 0.05))
      backdrop.addColorStop(0.48, hsl(hue, 96, 48, 0.05 + global.bloom * 0.03))
      backdrop.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = backdrop
      ctx.fillRect(0, 0, width, height)

      ctx.save()
      ctx.globalAlpha = 0.05 + global.noise * 0.08
      ctx.strokeStyle = hsl(hue, 72, 82, 0.12)
      ctx.lineWidth = 1
      for (let x = 0; x < width; x += 34) {
        ctx.beginPath()
        ctx.moveTo(x + 0.5, 0)
        ctx.lineTo(x + 0.5, height)
        ctx.stroke()
      }
      for (let y = 0; y < height; y += 26) {
        ctx.beginPath()
        ctx.moveTo(0, y + 0.5)
        ctx.lineTo(width, y + 0.5)
        ctx.stroke()
      }
      ctx.restore()

      drawBrowserWindow(ctx, scene, focusZone, stateConfig, {
        time,
        detailBoost: 0.94,
        blur: 3.2 + glassDepth * 0.8,
        alpha: 0.92,
        hue,
        accentHue,
        audioKick,
        global,
        listening,
        thinking,
        speaking,
        errorMode
      })

      drawOrbitTabs(ctx, lens, stateConfig, accentHue, time, speaking, listening)

      const scale = 1 + refraction * 0.12 + focusLock * 0.04 + listening * 0.02 + thinking * 0.03
      ctx.save()
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      ctx.clip()
      ctx.translate(lens.x - focusCenterX * scale, lens.y - focusCenterY * scale)
      ctx.scale(scale, scale)
      drawBrowserWindow(ctx, scene, focusZone, stateConfig, {
        time,
        detailBoost: 1.28 + glassDepth * 0.12,
        blur: 0,
        alpha: 1,
        hue,
        accentHue,
        audioKick,
        global,
        listening,
        thinking,
        speaking,
        errorMode
      })
      ctx.restore()

      ctx.save()
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      ctx.clip()

      const scanX = lens.x + Math.sin(time * (0.72 + stateConfig.scannerSpeed * 0.7)) * lens.radius * 0.74
      const scanGradient = ctx.createLinearGradient(scanX - lens.radius * 0.2, lens.y, scanX + lens.radius * 0.2, lens.y)
      scanGradient.addColorStop(0, 'rgba(255,255,255,0)')
      scanGradient.addColorStop(0.5, hsl(accentHue, 100, 82, 0.08 + listening * 0.16 + thinking * 0.08))
      scanGradient.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = scanGradient
      ctx.fillRect(lens.x - lens.radius, lens.y - lens.radius, lens.radius * 2, lens.radius * 2)

      const focusGlow = ctx.createRadialGradient(lens.x, lens.y, 0, lens.x, lens.y, lens.radius * 0.9)
      focusGlow.addColorStop(0, hsl(accentHue, 100, 86, 0.06 + focusLock * 0.06))
      focusGlow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = focusGlow
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius * 0.92, 0, Math.PI * 2)
      ctx.fill()

      const reticleRadius = lens.radius * (0.2 + focusLock * 0.06) + Math.sin(time * (1.2 + stateConfig.pulse)) * lens.radius * 0.018
      ctx.strokeStyle = hsl(errorMode ? 8 : accentHue, 100, errorMode ? 72 : 88, 0.34 + focusLock * 0.2 + speaking * 0.1)
      ctx.lineWidth = 1.6 + focusLock * 0.5
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, reticleRadius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(lens.x - reticleRadius * 1.28, lens.y)
      ctx.lineTo(lens.x - reticleRadius * 0.6, lens.y)
      ctx.moveTo(lens.x + reticleRadius * 0.6, lens.y)
      ctx.lineTo(lens.x + reticleRadius * 1.28, lens.y)
      ctx.moveTo(lens.x, lens.y - reticleRadius * 1.28)
      ctx.lineTo(lens.x, lens.y - reticleRadius * 0.6)
      ctx.moveTo(lens.x, lens.y + reticleRadius * 0.6)
      ctx.lineTo(lens.x, lens.y + reticleRadius * 1.28)
      ctx.stroke()
      ctx.restore()

      const lensFill = ctx.createRadialGradient(lens.x - lens.radius * 0.22, lens.y - lens.radius * 0.28, 0, lens.x, lens.y, lens.radius * 1.18)
      lensFill.addColorStop(0, hsl(hue, 58, 92, 0.12 + glassDepth * 0.04))
      lensFill.addColorStop(0.48, hsl(accentHue, 54, 74, 0.08 + glassDepth * 0.03))
      lensFill.addColorStop(1, hsl(hue, 44, 42, 0.18 + global.backdrop * 0.04))
      ctx.fillStyle = lensFill
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      ctx.fill()

      const rim = ctx.createLinearGradient(lens.x - lens.radius, lens.y - lens.radius, lens.x + lens.radius, lens.y + lens.radius)
      rim.addColorStop(0, hsl(accentHue, 100, 94, 0.34 + glassDepth * 0.08))
      rim.addColorStop(0.5, hsl(hue, 92, 72, 0.2 + glassDepth * 0.05))
      rim.addColorStop(1, hsl(accentHue, 100, 86, 0.42 + glassDepth * 0.08))
      ctx.strokeStyle = rim
      ctx.lineWidth = 3 + glassDepth * 1.8
      ctx.beginPath()
      ctx.arc(lens.x, lens.y, lens.radius, 0, Math.PI * 2)
      ctx.stroke()

      ctx.strokeStyle = hsl(accentHue, 100, 98, 0.26 + glassDepth * 0.08)
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.arc(lens.x - lens.radius * 0.12, lens.y - lens.radius * 0.14, lens.radius * 0.78, Math.PI * 1.02, Math.PI * 1.56)
      ctx.stroke()

      const reflection = ctx.createLinearGradient(lens.x - lens.radius * 0.82, lens.y - lens.radius * 0.86, lens.x + lens.radius * 0.32, lens.y + lens.radius * 0.12)
      reflection.addColorStop(0, hsl(accentHue, 100, 98, 0.24))
      reflection.addColorStop(0.5, hsl(hue, 100, 98, 0.12))
      reflection.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = reflection
      ctx.beginPath()
      ctx.ellipse(lens.x - lens.radius * 0.18, lens.y - lens.radius * 0.2, lens.radius * 0.84, lens.radius * 0.4, -0.66, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = hsl(accentHue, 100, 98, 0.18)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(lens.x + lens.radius * 0.12, lens.y + lens.radius * 0.06, lens.radius * 0.56, -0.12, 0.72)
      ctx.stroke()

      for (let index = 0; index < clamp(Math.round((stateConfig.particleDensity || 82) * 0.1), 8, 18); index += 1) {
        const angle = (index / 18) * Math.PI * 2 + time * 0.08
        const radius = lens.radius * (0.36 + ((index % 5) * 0.09))
        const x = lens.x + Math.cos(angle + index * 0.14) * radius
        const y = lens.y + Math.sin(angle * 1.12 + index * 0.22) * radius * 0.72
        ctx.fillStyle = hsl(index % 3 === 0 ? accentHue : hue, 100, 90, 0.06 + audioKick * 0.1 + speaking * 0.04)
        ctx.beginPath()
        ctx.arc(x, y, 1.2 + (index % 3) * 0.5, 0, Math.PI * 2)
        ctx.fill()
      }

      drawLensHandle(ctx, lens, hue, accentHue, glassDepth)
      drawHorns(ctx, lens, accentHue, glassDepth, errorMode)

      if (speaking) {
        for (let index = 0; index < 3; index += 1) {
          const chipW = lens.radius * (0.56 - index * 0.08)
          const chipH = lens.radius * 0.16
          const chipX = lens.x + lens.radius * 1.02 + index * lens.radius * 0.08
          const chipY = lens.y - lens.radius * 0.26 + index * lens.radius * 0.28
          drawRoundedRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.5, hsl(accentHue, 94, 68, 0.16 + index * 0.04 + audioKick * 0.1))
          drawRoundedRect(ctx, chipX + chipW * 0.12, chipY + chipH * 0.32, chipW * 0.48, chipH * 0.14, chipH * 0.07, hsl(hue, 100, 98, 0.3))
          ctx.strokeStyle = hsl(accentHue, 100, 92, 0.2)
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(lens.x + lens.radius * 0.74, lens.y + index * lens.radius * 0.04)
          ctx.quadraticCurveTo(lens.x + lens.radius * 1.02, chipY + chipH * 0.5, chipX, chipY + chipH * 0.5)
          ctx.stroke()
        }
      }

      if (errorMode) {
        ctx.strokeStyle = hsl(8, 100, 72, 0.42)
        ctx.lineWidth = 1.4
        ;[
          [0.08, -0.22, 0.38, -0.06, 0.54, 0.1],
          [-0.12, -0.1, 0.1, 0.02, 0.28, 0.26],
          [-0.22, -0.28, -0.08, -0.02, 0.08, 0.18]
        ].forEach(([ax, ay, bx, by, cx, cy]) => {
          ctx.beginPath()
          ctx.moveTo(lens.x + lens.radius * ax, lens.y + lens.radius * ay)
          ctx.lineTo(lens.x + lens.radius * bx, lens.y + lens.radius * by)
          ctx.lineTo(lens.x + lens.radius * cx, lens.y + lens.radius * cy)
          ctx.stroke()
        })
      }

      frameRef.current = window.requestAnimationFrame(draw)
    }

    frameRef.current = window.requestAnimationFrame(draw)
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current)
    }
  }, [audioData, global, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
