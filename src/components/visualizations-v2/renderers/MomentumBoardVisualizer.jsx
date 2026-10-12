import { useEffect, useMemo, useRef, useState } from 'react'

const LANE_META = [
  { key: 'todo', label: 'TODO', hue: 38, accentHue: 18, bias: -0.12 },
  { key: 'doing', label: 'DOING', hue: 196, accentHue: 214, bias: 0 },
  { key: 'done', label: 'DONE', hue: 142, accentHue: 156, bias: 0.12 }
]

const DELEGATE_META = [
  { label: 'IN', hue: 284, x: 0.88, y: 0.28 },
  { label: 'FG', hue: 258, x: 0.91, y: 0.5 },
  { label: 'ST', hue: 6, x: 0.86, y: 0.74 }
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
  for (let index = 0; index < audioData.length; index += 1) sum += audioData[index]
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

function pointOnQuadratic(ax, ay, cx, cy, bx, by, t) {
  const mt = 1 - t
  return {
    x: mt * mt * ax + 2 * mt * t * cx + t * t * bx,
    y: mt * mt * ay + 2 * mt * t * cy + t * t * by
  }
}

function buildCards(count) {
  const lanePattern = [0, 1, 0, 2, 1, 0, 1, 2, 0, 1, 2, 1]
  const priorityPattern = ['urgent', 'high', 'medium', 'high', 'medium', 'low']
  return new Array(count).fill(null).map((_, index) => ({
    laneIndex: lanePattern[index % lanePattern.length],
    offset: (index * 0.083 + (index % 5) * 0.017) % 1,
    size: 0.84 + (index % 4) * 0.1,
    priority: priorityPattern[index % priorityPattern.length],
    due: index % 5 === 0,
    delegated: index % 7 === 0,
    pulseSeed: index * 0.37,
    rail: index % 3
  }))
}

function getBasePreset(presetId) {
  if (presetId === 'sprint-planner') {
    return {
      global: { backdrop: 0.88, bloom: 1.04, noise: 0.05, laneFlow: 0.82, streakGlow: 1.06, glassBoard: 1.04 },
      states: {
        idle: { hue: 152, accentHue: 42, energy: 0.2, pulse: 0.12, ringSpeed: 0.08, scannerSpeed: 0.08, barGain: 0.18, particleDensity: 82, orbitCount: 6, jitter: 0.01, cardDensity: 0.64, priorityHeat: 0.8, delegateThreads: 0.4 },
        listening: { hue: 154, accentHue: 42, energy: 0.34, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.26, barGain: 0.24, particleDensity: 96, orbitCount: 7, jitter: 0.01, cardDensity: 0.82, priorityHeat: 0.96, delegateThreads: 0.52 },
        thinking: { hue: 160, accentHue: 48, energy: 0.6, pulse: 0.28, ringSpeed: 0.16, scannerSpeed: 0.22, barGain: 0.34, particleDensity: 112, orbitCount: 8, jitter: 0.02, cardDensity: 1.06, priorityHeat: 1.12, delegateThreads: 0.78 },
        speaking: { hue: 150, accentHue: 36, energy: 0.88, pulse: 0.72, ringSpeed: 0.22, scannerSpeed: 0.16, barGain: 0.46, particleDensity: 118, orbitCount: 9, jitter: 0.02, cardDensity: 0.94, priorityHeat: 1.08, delegateThreads: 0.66 },
        error: { hue: 4, accentHue: 14, energy: 1.1, pulse: 0.88, ringSpeed: 0.12, scannerSpeed: 0.32, barGain: 0.56, particleDensity: 104, orbitCount: 7, jitter: 0.16, cardDensity: 0.8, priorityHeat: 1.24, delegateThreads: 0.34 }
      }
    }
  }

  if (presetId === 'relay-deck') {
    return {
      global: { backdrop: 0.92, bloom: 1.14, noise: 0.06, laneFlow: 1.08, streakGlow: 0.88, glassBoard: 1.12 },
      states: {
        idle: { hue: 166, accentHue: 204, energy: 0.18, pulse: 0.1, ringSpeed: 0.08, scannerSpeed: 0.06, barGain: 0.18, particleDensity: 76, orbitCount: 7, jitter: 0.01, cardDensity: 0.58, priorityHeat: 0.7, delegateThreads: 0.74 },
        listening: { hue: 170, accentHue: 196, energy: 0.32, pulse: 0.16, ringSpeed: 0.12, scannerSpeed: 0.24, barGain: 0.24, particleDensity: 90, orbitCount: 8, jitter: 0.01, cardDensity: 0.74, priorityHeat: 0.88, delegateThreads: 0.92 },
        thinking: { hue: 178, accentHue: 212, energy: 0.62, pulse: 0.24, ringSpeed: 0.18, scannerSpeed: 0.24, barGain: 0.34, particleDensity: 108, orbitCount: 9, jitter: 0.02, cardDensity: 0.96, priorityHeat: 0.98, delegateThreads: 1.18 },
        speaking: { hue: 168, accentHue: 188, energy: 0.84, pulse: 0.68, ringSpeed: 0.24, scannerSpeed: 0.18, barGain: 0.46, particleDensity: 114, orbitCount: 10, jitter: 0.02, cardDensity: 0.88, priorityHeat: 1.02, delegateThreads: 1.04 },
        error: { hue: 4, accentHue: 10, energy: 1.06, pulse: 0.84, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.54, particleDensity: 102, orbitCount: 7, jitter: 0.14, cardDensity: 0.76, priorityHeat: 1.18, delegateThreads: 0.58 }
      }
    }
  }

  return {
    global: { backdrop: 0.86, bloom: 1.08, noise: 0.05, laneFlow: 0.96, streakGlow: 1, glassBoard: 1.08 },
    states: {
      idle: { hue: 158, accentHue: 38, energy: 0.18, pulse: 0.1, ringSpeed: 0.08, scannerSpeed: 0.08, barGain: 0.18, particleDensity: 78, orbitCount: 6, jitter: 0.01, cardDensity: 0.6, priorityHeat: 0.76, delegateThreads: 0.46 },
      listening: { hue: 160, accentHue: 42, energy: 0.34, pulse: 0.18, ringSpeed: 0.12, scannerSpeed: 0.28, barGain: 0.26, particleDensity: 94, orbitCount: 7, jitter: 0.01, cardDensity: 0.8, priorityHeat: 0.94, delegateThreads: 0.56 },
      thinking: { hue: 164, accentHue: 202, energy: 0.66, pulse: 0.28, ringSpeed: 0.16, scannerSpeed: 0.24, barGain: 0.36, particleDensity: 112, orbitCount: 8, jitter: 0.02, cardDensity: 1.04, priorityHeat: 1.08, delegateThreads: 0.82 },
      speaking: { hue: 156, accentHue: 34, energy: 0.92, pulse: 0.76, ringSpeed: 0.22, scannerSpeed: 0.18, barGain: 0.48, particleDensity: 118, orbitCount: 9, jitter: 0.02, cardDensity: 0.92, priorityHeat: 1.02, delegateThreads: 0.68 },
      error: { hue: 6, accentHue: 12, energy: 1.1, pulse: 0.9, ringSpeed: 0.12, scannerSpeed: 0.34, barGain: 0.58, particleDensity: 106, orbitCount: 7, jitter: 0.16, cardDensity: 0.78, priorityHeat: 1.22, delegateThreads: 0.3 }
    }
  }
}

export function getMomentumBoardConfig(presetId, overrides, state) {
  const base = getBasePreset(presetId)
  return {
    global: { ...base.global, ...(overrides?.global || {}) },
    state: {
      ...(base.states[state] || base.states.idle),
      ...(overrides?.states?.[state] || {})
    }
  }
}

function createLaneGeometry(board, lane, index, time, laneFlow, stateConfig, renderState) {
  const yBase = board.y + board.h * (0.22 + index * 0.26)
  const wave = Math.sin(time * (0.42 + index * 0.08) + index * 1.4) * board.h * 0.014 * laneFlow
  const jitter = renderState.errorMode ? Math.sign(Math.sin(time * (4.2 + index))) * board.h * 0.004 * stateConfig.jitter : 0
  return {
    ...lane,
    startX: board.x + board.w * 0.06,
    startY: yBase + wave + jitter,
    controlX: board.x + board.w * mix(0.42, 0.52, laneFlow - 0.4),
    controlY: yBase + board.h * lane.bias * (0.8 + laneFlow * 0.25) + Math.cos(time * (0.36 + index * 0.08) + index) * board.h * 0.02,
    endX: board.x + board.w * 0.94,
    endY: yBase - wave * 0.45 - jitter * 0.6
  }
}

function pointOnLane(lane, t) {
  return pointOnQuadratic(lane.startX, lane.startY, lane.controlX, lane.controlY, lane.endX, lane.endY, t)
}

function drawLane(ctx, lane, board, stateConfig, renderState, isFocused) {
  const { hue, audioKick, listening, thinking, speaking, errorMode } = renderState
  const laneWidth = board.h * 0.085
  const pulse = 0.5 + Math.sin(renderState.time * (1 + stateConfig.ringSpeed * 0.4) + lane.bias * 3) * 0.5

  ctx.save()
  ctx.lineCap = 'round'

  const underGlow = ctx.createLinearGradient(lane.startX, lane.startY, lane.endX, lane.endY)
  underGlow.addColorStop(0, hsl(lane.hue, 88, 56, 0.08 + renderState.global.glassBoard * 0.03))
  underGlow.addColorStop(0.55, hsl(lane.hue, 96, 60, 0.18 + stateConfig.energy * 0.08 + pulse * 0.08))
  underGlow.addColorStop(1, hsl(lane.accentHue, 100, 70, 0.08 + speaking * 0.06))
  ctx.strokeStyle = underGlow
  ctx.lineWidth = laneWidth + (isFocused ? 6 : 0)
  ctx.beginPath()
  ctx.moveTo(lane.startX, lane.startY)
  ctx.quadraticCurveTo(lane.controlX, lane.controlY, lane.endX, lane.endY)
  ctx.stroke()

  const laneCore = ctx.createLinearGradient(lane.startX, lane.startY, lane.endX, lane.endY)
  laneCore.addColorStop(0, hsl(lane.hue, 94, 72, 0.32))
  laneCore.addColorStop(0.5, hsl(isFocused ? hue : lane.hue, 100, 82, 0.44 + audioKick * 0.16 + thinking * 0.08))
  laneCore.addColorStop(1, hsl(lane.accentHue, 100, 76, 0.32 + speaking * 0.08))
  ctx.strokeStyle = laneCore
  ctx.lineWidth = laneWidth * 0.48 + stateConfig.barGain * 4
  ctx.beginPath()
  ctx.moveTo(lane.startX, lane.startY)
  ctx.quadraticCurveTo(lane.controlX, lane.controlY, lane.endX, lane.endY)
  ctx.stroke()

  if (listening || thinking) {
    const scannerT = ((Math.sin(renderState.time * (0.9 + stateConfig.scannerSpeed * 0.35) + lane.bias * 2.4) + 1) * 0.5)
    const scanner = pointOnLane(lane, scannerT)
    const glow = ctx.createRadialGradient(scanner.x, scanner.y, 0, scanner.x, scanner.y, laneWidth * 1.5)
    glow.addColorStop(0, hsl(renderState.accentHue, 100, 86, 0.22 + listening * 0.12 + thinking * 0.08))
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(scanner.x, scanner.y, laneWidth * 1.4, 0, Math.PI * 2)
    ctx.fill()
  }

  const labelPoint = pointOnLane(lane, 0.08)
  const pillW = board.w * 0.09
  const pillH = board.h * 0.07
  drawRoundedRect(ctx, labelPoint.x - pillW * 0.5, labelPoint.y - pillH * 0.5, pillW, pillH, pillH * 0.48, hsl(lane.hue, 80, 18, 0.28))
  strokeRoundedRect(ctx, labelPoint.x - pillW * 0.5, labelPoint.y - pillH * 0.5, pillW, pillH, pillH * 0.48, hsl(lane.hue, 96, 72, 0.24), 1)
  ctx.fillStyle = hsl(lane.hue, 100, 86, 0.88)
  ctx.font = `${Math.round(pillH * 0.33)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(lane.label, labelPoint.x, labelPoint.y + 0.5)

  if (errorMode && lane.key !== 'done') {
    const blockPoint = pointOnLane(lane, 0.58)
    ctx.strokeStyle = hsl(4, 100, 72, 0.48)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(blockPoint.x - 12, blockPoint.y - 10)
    ctx.lineTo(blockPoint.x + 12, blockPoint.y + 10)
    ctx.moveTo(blockPoint.x - 12, blockPoint.y + 10)
    ctx.lineTo(blockPoint.x + 12, blockPoint.y - 10)
    ctx.stroke()
  }

  ctx.restore()
}

function drawGlassBoard(ctx, board, stateConfig, renderState) {
  const { hue, accentHue, global, time } = renderState
  ctx.save()
  ctx.shadowColor = hsl(hue, 80, 10, 0.34)
  ctx.shadowBlur = 42 * global.glassBoard
  drawRoundedRect(ctx, board.x, board.y, board.w, board.h, board.w * 0.035, hsl(hue, 28, 8, 0.78))
  ctx.shadowBlur = 0

  const shell = ctx.createLinearGradient(board.x, board.y, board.x + board.w, board.y + board.h)
  shell.addColorStop(0, hsl(hue, 36, 12, 0.78 + global.backdrop * 0.08))
  shell.addColorStop(0.48, hsl(accentHue, 44, 10, 0.54))
  shell.addColorStop(1, hsl(hue, 32, 8, 0.88))
  drawRoundedRect(ctx, board.x, board.y, board.w, board.h, board.w * 0.035, shell)

  const wash = ctx.createLinearGradient(board.x, board.y, board.x + board.w * 0.8, board.y + board.h)
  wash.addColorStop(0, hsl(hue, 80, 96, 0.06 + global.glassBoard * 0.02))
  wash.addColorStop(0.35, hsl(accentHue, 100, 92, 0.04 + stateConfig.energy * 0.02))
  wash.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = wash
  roundedRectPath(ctx, board.x, board.y, board.w, board.h, board.w * 0.035)
  ctx.fill()

  strokeRoundedRect(ctx, board.x, board.y, board.w, board.h, board.w * 0.035, hsl(hue, 88, 86, 0.14), 1.2)

  ctx.globalAlpha = 0.08 + global.noise * 0.08
  ctx.strokeStyle = hsl(accentHue, 70, 72, 0.18)
  ctx.lineWidth = 1
  for (let x = board.x + board.w * 0.08; x < board.x + board.w * 0.94; x += board.w * 0.08) {
    ctx.beginPath()
    ctx.moveTo(x + Math.sin(time + x * 0.004) * 1.5, board.y + board.h * 0.08)
    ctx.lineTo(x + Math.cos(time * 0.7 + x * 0.004) * 1.5, board.y + board.h * 0.92)
    ctx.stroke()
  }
  for (let y = board.y + board.h * 0.14; y < board.y + board.h * 0.88; y += board.h * 0.12) {
    ctx.beginPath()
    ctx.moveTo(board.x + board.w * 0.06, y + 0.5)
    ctx.lineTo(board.x + board.w * 0.94, y + 0.5)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const headerH = board.h * 0.11
  drawRoundedRect(ctx, board.x + board.w * 0.03, board.y + board.h * 0.04, board.w * 0.94, headerH, headerH * 0.45, hsl(hue, 34, 10, 0.44))
  strokeRoundedRect(ctx, board.x + board.w * 0.03, board.y + board.h * 0.04, board.w * 0.94, headerH, headerH * 0.45, hsl(accentHue, 90, 82, 0.12), 1)

  const chips = [
    { label: 'FOCUS', hue: accentHue },
    { label: 'STREAK', hue: 36 },
    { label: 'DELEGATE', hue: 268 }
  ]
  chips.forEach((chip, index) => {
    const chipW = board.w * 0.11
    const chipH = headerH * 0.5
    const chipX = board.x + board.w * (0.06 + index * 0.13)
    const chipY = board.y + board.h * 0.072
    drawRoundedRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.5, hsl(chip.hue, 86, 58, 0.14))
    ctx.fillStyle = hsl(chip.hue, 100, 84, 0.72)
    ctx.font = `${Math.round(chipH * 0.42)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(chip.label, chipX + chipW / 2, chipY + chipH / 2 + 0.5)
  })

  ctx.restore()
}

function drawMomentumCore(ctx, core, stateConfig, renderState) {
  const { hue, accentHue, audioKick, thinking, speaking, errorMode, global, time } = renderState
  const ringPulse = 0.5 + Math.sin(time * (1.2 + stateConfig.ringSpeed * 0.35)) * 0.5
  const streakGlow = clamp(global.streakGlow ?? 1, 0.2, 1.6)

  ctx.save()
  const halo = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, core.radius * 2.4)
  halo.addColorStop(0, hsl(hue, 100, 78, 0.18 + streakGlow * 0.06 + speaking * 0.08))
  halo.addColorStop(0.5, hsl(accentHue, 100, 76, 0.1 + audioKick * 0.08 + thinking * 0.06))
  halo.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(core.x, core.y, core.radius * 2.4, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = hsl(errorMode ? 6 : hue, 96, errorMode ? 70 : 76, 0.18 + streakGlow * 0.1)
  ctx.lineWidth = 16 * (0.82 + streakGlow * 0.12)
  ctx.beginPath()
  ctx.arc(core.x, core.y, core.radius * 1.26, Math.PI * 0.78, Math.PI * 2.26)
  ctx.stroke()

  ctx.strokeStyle = hsl(36, 100, 66, 0.22 + streakGlow * 0.08 + speaking * 0.08)
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(core.x, core.y, core.radius * 1.52, Math.PI * 0.9, Math.PI * (0.9 + 0.34 + ringPulse * 0.08))
  ctx.stroke()

  for (let index = 0; index < Math.max(8, stateConfig.orbitCount || 6); index += 1) {
    const angle = (index / Math.max(8, stateConfig.orbitCount || 6)) * Math.PI * 2 + time * 0.12
    const tickInner = core.radius * 1.68
    const tickOuter = core.radius * 1.88 + (index % 3 === 0 ? 6 : 0)
    ctx.strokeStyle = hsl(index % 4 === 0 ? 36 : hue, 100, 84, 0.18 + ringPulse * 0.12)
    ctx.lineWidth = index % 4 === 0 ? 2 : 1.2
    ctx.beginPath()
    ctx.moveTo(core.x + Math.cos(angle) * tickInner, core.y + Math.sin(angle) * tickInner)
    ctx.lineTo(core.x + Math.cos(angle) * tickOuter, core.y + Math.sin(angle) * tickOuter)
    ctx.stroke()
  }

  const body = ctx.createRadialGradient(core.x - core.radius * 0.24, core.y - core.radius * 0.28, 0, core.x, core.y, core.radius * 1.06)
  body.addColorStop(0, hsl(hue, 86, 88, 0.18))
  body.addColorStop(0.45, hsl(hue, 74, 28, 0.74))
  body.addColorStop(1, hsl(hue, 62, 12, 0.94))
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.arc(core.x, core.y, core.radius, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = hsl(accentHue, 100, 90, 0.3 + speaking * 0.12)
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.arc(core.x, core.y, core.radius, 0, Math.PI * 2)
  ctx.stroke()

  ctx.strokeStyle = hsl(36, 100, 72, 0.28 + streakGlow * 0.06)
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.arc(core.x - core.radius * 0.12, core.y - core.radius * 0.08, core.radius * 0.72, Math.PI * 1.02, Math.PI * 1.54)
  ctx.stroke()

  ctx.lineCap = 'round'
  ctx.strokeStyle = errorMode ? hsl(4, 100, 72, 0.9) : hsl(hue, 100, 92, 0.92)
  ctx.lineWidth = Math.max(4, core.radius * 0.11)
  ctx.beginPath()
  ctx.moveTo(core.x - core.radius * 0.28, core.y + core.radius * 0.04)
  ctx.lineTo(core.x - core.radius * 0.06, core.y + core.radius * 0.28)
  ctx.lineTo(core.x + core.radius * 0.36, core.y - core.radius * 0.24)
  ctx.stroke()

  ctx.fillStyle = hsl(accentHue, 100, 88, 0.74)
  ctx.font = `${Math.round(core.radius * 0.22)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('AQ', core.x, core.y + core.radius * 0.56)
  ctx.restore()
}

function drawCard(ctx, lane, point, angle, card, board, stateConfig, renderState) {
  const priorityHeat = clamp(stateConfig.priorityHeat ?? 0.8, 0.2, 1.5)
  const width = board.w * 0.082 * card.size
  const height = board.h * 0.07 * card.size
  const priorityColor = card.priority === 'urgent'
    ? hsl(4, 100, 68, 0.82)
    : card.priority === 'high'
      ? hsl(38, 100, 66, 0.8)
      : card.priority === 'medium'
        ? hsl(196, 100, 72, 0.72)
        : hsl(0, 0, 96, 0.2)
  const alpha = 0.7 + Math.sin(renderState.time * 1.1 + card.pulseSeed) * 0.08 + renderState.audioKick * 0.06

  ctx.save()
  ctx.translate(point.x, point.y)
  ctx.rotate(angle)

  const fill = ctx.createLinearGradient(-width / 2, -height / 2, width / 2, height / 2)
  fill.addColorStop(0, hsl(renderState.hue, 56, 12, 0.78 * alpha))
  fill.addColorStop(0.5, hsl(lane.hue, 62, 18, 0.64 * alpha))
  fill.addColorStop(1, hsl(renderState.accentHue, 58, 14, 0.58 * alpha))
  drawRoundedRect(ctx, -width / 2, -height / 2, width, height, height * 0.3, fill)
  strokeRoundedRect(ctx, -width / 2, -height / 2, width, height, height * 0.3, hsl(lane.hue, 100, 82, 0.26 + priorityHeat * 0.06), 1.1)

  drawRoundedRect(ctx, -width / 2, -height / 2, Math.max(4, width * 0.06), height, height * 0.26, priorityColor)
  drawRoundedRect(ctx, -width * 0.28, -height * 0.18, width * 0.46, height * 0.12, height * 0.08, hsl(lane.hue, 100, 94, 0.38))
  drawRoundedRect(ctx, -width * 0.28, height * 0.02, width * 0.3, height * 0.1, height * 0.08, hsl(renderState.hue, 20, 100, 0.18))

  if (card.due) {
    ctx.fillStyle = hsl(4, 100, 72, 0.84)
    ctx.beginPath()
    ctx.arc(width * 0.26, -height * 0.1, height * 0.09 * priorityHeat, 0, Math.PI * 2)
    ctx.fill()
  }

  if (card.delegated && (stateConfig.delegateThreads ?? 0) > 0.28) {
    ctx.strokeStyle = hsl(272, 100, 78, 0.4)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(width * 0.18, 0)
    ctx.lineTo(width * 0.36, 0)
    ctx.stroke()
    ctx.fillStyle = hsl(272, 100, 80, 0.58)
    ctx.beginPath()
    ctx.arc(width * 0.42, 0, height * 0.07, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawDelegationField(ctx, board, core, cards, lanes, stateConfig, renderState) {
  const delegateThreads = clamp(stateConfig.delegateThreads ?? 0.4, 0, 1.5)
  if (delegateThreads < 0.1) return

  const satellites = DELEGATE_META.map((node, index) => ({
    ...node,
    x: board.x + board.w * node.x,
    y: board.y + board.h * (node.y + Math.sin(renderState.time * (0.7 + index * 0.08) + index) * 0.01)
  }))

  ctx.save()
  satellites.forEach((satellite, index) => {
    const sourceCard = cards.find((card) => card.delegated && (card.indexHint % satellites.length) === index)
    const lane = lanes[(sourceCard?.laneIndex ?? 1)]
    const source = sourceCard?.point || pointOnLane(lane, 0.62)

    ctx.strokeStyle = hsl(satellite.hue, 100, 76, 0.12 + delegateThreads * 0.14 + renderState.thinking * 0.06)
    ctx.lineWidth = 1.2 + delegateThreads * 0.4
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.quadraticCurveTo(
      mix(source.x, satellite.x, 0.45),
      mix(source.y, satellite.y, 0.22) - board.h * 0.06,
      satellite.x,
      satellite.y
    )
    ctx.stroke()

    const halo = ctx.createRadialGradient(satellite.x, satellite.y, 0, satellite.x, satellite.y, board.w * 0.06)
    halo.addColorStop(0, hsl(satellite.hue, 100, 72, 0.18 + delegateThreads * 0.08))
    halo.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(satellite.x, satellite.y, board.w * 0.05, 0, Math.PI * 2)
    ctx.fill()

    drawRoundedRect(ctx, satellite.x - board.w * 0.04, satellite.y - board.h * 0.035, board.w * 0.08, board.h * 0.07, board.h * 0.02, hsl(satellite.hue, 72, 18, 0.5))
    strokeRoundedRect(ctx, satellite.x - board.w * 0.04, satellite.y - board.h * 0.035, board.w * 0.08, board.h * 0.07, board.h * 0.02, hsl(satellite.hue, 100, 74, 0.24), 1)
    ctx.fillStyle = hsl(satellite.hue, 100, 84, 0.9)
    ctx.font = `${Math.round(board.h * 0.02)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(satellite.label, satellite.x, satellite.y + 0.5)
  })

  if (renderState.speaking) {
    const chipW = board.w * 0.16
    const chipH = board.h * 0.08
    const chipX = core.x + core.radius * 1.2
    const chipY = core.y - board.h * 0.18
    drawRoundedRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.5, hsl(renderState.accentHue, 86, 56, 0.16))
    strokeRoundedRect(ctx, chipX, chipY, chipW, chipH, chipH * 0.5, hsl(renderState.accentHue, 100, 84, 0.18), 1)
    ctx.fillStyle = hsl(renderState.accentHue, 100, 90, 0.88)
    ctx.font = `${Math.round(chipH * 0.34)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('NEXT MOVE', chipX + chipW / 2, chipY + chipH / 2 + 0.5)
  }

  ctx.restore()
}

export default function MomentumBoardVisualizer({
  state = 'idle',
  audioData = null,
  assignment
}) {
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const phaseRef = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const presetId = assignment?.presetId || 'flow-state'
  const { global, state: stateConfig } = useMemo(
    () => getMomentumBoardConfig(presetId, assignment?.overrides, state),
    [assignment, presetId, state]
  )

  const cardCount = clamp(
    Math.round((stateConfig.particleDensity || 90) * 0.16 * clamp(stateConfig.cardDensity ?? 0.8, 0.3, 1.6)),
    12,
    28
  )
  const cards = useMemo(() => buildCards(cardCount), [cardCount])

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
      phaseRef.current += 0.016 * (1 + stateConfig.ringSpeed * 0.7)
      const time = phaseRef.current
      const width = size.width
      const height = size.height
      const minDim = Math.min(width, height)
      const audioKick = getAudioEnergy(audioData) * 0.98
      const listening = state === 'listening' ? 1 : 0
      const thinking = state === 'thinking' ? 1 : 0
      const speaking = state === 'speaking' ? 1 : 0
      const errorMode = state === 'error' ? 1 : 0
      const laneFlow = clamp(global.laneFlow ?? 1, 0.4, 1.5)
      const glassBoard = clamp(global.glassBoard ?? 1, 0.6, 1.5)
      const hue = stateConfig.hue ?? 160
      const accentHue = stateConfig.accentHue ?? 42

      const renderState = {
        time,
        hue,
        accentHue,
        audioKick,
        listening,
        thinking,
        speaking,
        errorMode,
        global,
        stateConfig
      }

      const board = {
        x: width * 0.08,
        y: height * 0.16,
        w: width * 0.84,
        h: height * 0.68
      }
      const core = {
        x: board.x + board.w * 0.48,
        y: board.y + board.h * 0.52,
        radius: minDim * 0.09 * (0.92 + glassBoard * 0.08)
      }

      const bgAlpha = global.backgroundOpacity ?? 1
      ctx.clearRect(0, 0, width, height)
      const bg = ctx.createLinearGradient(0, 0, width, height)
      bg.addColorStop(0, hsl(hue, 44, 8, 0.96 * bgAlpha))
      bg.addColorStop(0.48, hsl(accentHue, 30, 6, 0.96 * bgAlpha))
      bg.addColorStop(1, hsl(hue, 38, 4, 0.98 * bgAlpha))
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)

      const field = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, minDim * 0.78)
      field.addColorStop(0, hsl(hue, 100, 38, 0.12 + global.bloom * 0.05))
      field.addColorStop(0.42, hsl(accentHue, 100, 44, 0.05 + audioKick * 0.04 + speaking * 0.05))
      field.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = field
      ctx.fillRect(0, 0, width, height)

      drawGlassBoard(ctx, board, stateConfig, renderState)

      const lanes = LANE_META.map((lane, index) => createLaneGeometry(board, lane, index, time, laneFlow, stateConfig, renderState))
      const focusLaneIndex = listening ? 0 : speaking ? 2 : 1
      lanes.forEach((lane, index) => drawLane(ctx, lane, board, stateConfig, renderState, index === focusLaneIndex))

      const cardPoints = []
      cards.forEach((card, index) => {
        const lane = lanes[card.laneIndex]
        const baseSpeed = 0.028 + stateConfig.energy * 0.018 + laneFlow * 0.008
        const laneBias = card.laneIndex === 0 ? listening * 0.016 : card.laneIndex === 1 ? thinking * 0.014 : speaking * 0.018
        let t = (card.offset + time * (baseSpeed + laneBias) + card.rail * 0.032) % 1

        if (errorMode && card.laneIndex !== 2 && t > 0.48 && t < 0.66) {
          t = mix(t, 0.56 + Math.sin(time * 5 + index) * 0.012, 0.75)
        }

        const point = pointOnLane(lane, t)
        const ahead = pointOnLane(lane, clamp(t + 0.02, 0, 1))
        const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x)
        const pointData = { ...card, point, indexHint: index }
        cardPoints.push(pointData)
        drawCard(ctx, lane, point, angle, card, board, stateConfig, renderState)
      })

      drawMomentumCore(ctx, core, stateConfig, renderState)
      drawDelegationField(ctx, board, core, cardPoints, lanes, stateConfig, renderState)

      if (listening) {
        const intakeY = lanes[0].startY
        ctx.strokeStyle = hsl(accentHue, 100, 82, 0.34)
        ctx.lineWidth = 2.4 + stateConfig.barGain * 3
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(board.x - board.w * 0.03, intakeY)
        ctx.lineTo(board.x + board.w * 0.03, intakeY)
        ctx.lineTo(core.x - core.radius * 1.2, core.y - core.radius * 0.68)
        ctx.stroke()
      }

      if (thinking) {
        const scanX = board.x + board.w * (0.32 + (Math.sin(time * (0.8 + stateConfig.scannerSpeed * 0.2)) + 1) * 0.18)
        const scan = ctx.createLinearGradient(scanX - 24, board.y, scanX + 24, board.y)
        scan.addColorStop(0, 'rgba(255,255,255,0)')
        scan.addColorStop(0.5, hsl(accentHue, 100, 86, 0.14 + stateConfig.barGain * 0.08))
        scan.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = scan
        ctx.fillRect(board.x, board.y + board.h * 0.16, board.w, board.h * 0.66)
      }

      if (speaking) {
        const doneTarget = pointOnLane(lanes[2], 0.84)
        ctx.strokeStyle = hsl(36, 100, 72, 0.28 + audioKick * 0.16)
        ctx.lineWidth = 2.2
        ctx.beginPath()
        ctx.moveTo(core.x + core.radius * 0.8, core.y + core.radius * 0.34)
        ctx.quadraticCurveTo(core.x + board.w * 0.1, core.y + board.h * 0.12, doneTarget.x, doneTarget.y)
        ctx.stroke()

        for (let index = 0; index < clamp(Math.round((stateConfig.particleDensity || 90) * 0.08), 8, 16); index += 1) {
          const spread = (index / 16) * Math.PI * 2
          const distance = 10 + (index % 4) * 8 + Math.sin(time * 4 + index) * 4
          const x = doneTarget.x + Math.cos(spread + time * 3) * distance
          const y = doneTarget.y + Math.sin(spread + time * 2.6) * distance
          ctx.fillStyle = hsl(index % 3 === 0 ? 36 : index % 3 === 1 ? 142 : 196, 100, 72, 0.48)
          ctx.fillRect(x, y, 4, 4)
        }
      }

      if (errorMode) {
        ctx.strokeStyle = hsl(4, 100, 68, 0.36)
        ctx.lineWidth = 1.4
        for (let index = 0; index < 4; index += 1) {
          const x = board.x + board.w * (0.22 + index * 0.14)
          const y = board.y + board.h * (0.34 + (index % 2) * 0.16)
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x + 22, y - 10)
          ctx.lineTo(x + 34, y + 8)
          ctx.stroke()
        }
      }

      frameRef.current = window.requestAnimationFrame(draw)
    }

    frameRef.current = window.requestAnimationFrame(draw)
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current)
    }
  }, [audioData, cards, global, size.height, size.width, state, stateConfig])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
