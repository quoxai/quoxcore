/**
 * ScannerDisc — Flat XZ-plane radar, mirror of the holo radar.
 *
 * The disc IS the horizontal plane. Center = camera position.
 * Forward (camera look direction) = up on disc.
 * Entities project onto XZ plane at their world position relative to camera.
 * Flagpoles show Y offset (above/below camera): up = above, down = below.
 *
 * Scale adapts to camera distance — zoom in = spread, zoom out = cluster.
 * Think fighter pilot: tall flag at 9 o'clock = bogey above-left.
 * Inverted flag at 4 o'clock = bogey below-right.
 *
 * All entities from visible layers are represented.
 */
import { useRef, useEffect, useCallback } from 'react'
import { SCANNER_RANGE_RINGS } from '../lib/scanner-projection'

const DISC_BG = 'rgba(5, 5, 16, 0.85)'
const GRID_COLOR = 'rgba(99, 102, 241, 0.06)'
const RING_COLOR = 'rgba(99, 102, 241, 0.1)'
const FONT = '7px "JetBrains Mono", "Fira Code", monospace'

export default function ScannerDisc({ entities = [], selectedId, onSelect, size = 440, camera }) {
  const canvasRef = useRef(null)
  const entitiesRef = useRef(entities)
  const selectedRef = useRef(selectedId)
  const cameraRef = useRef(camera)
  const rafRef = useRef(null)

  entitiesRef.current = entities
  selectedRef.current = selectedId
  cameraRef.current = camera

  const discRadius = size / 2 - 14
  const cx = size / 2
  const cy = size / 2

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size, size)

    // Disc background
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, discRadius + 4)
    grad.addColorStop(0, 'rgba(10, 10, 25, 0.88)')
    grad.addColorStop(0.85, 'rgba(5, 5, 16, 0.9)')
    grad.addColorStop(1, 'rgba(5, 5, 16, 0.2)')
    ctx.beginPath()
    ctx.arc(cx, cy, discRadius + 2, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()

    // Outer ring
    ctx.beginPath()
    ctx.arc(cx, cy, discRadius, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.2)'
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Get camera data for dynamic scale
    const cam = cameraRef.current
    // Dynamic scan range: based on camera distance from origin
    // Close camera = small range (objects spread), far = large range (objects cluster)
    const camDist = cam ? Math.sqrt(cam.position[0] ** 2 + cam.position[1] ** 2 + cam.position[2] ** 2) : 60
    const scanRange = Math.max(30, camDist * 2.5) // auto-range: see ~2.5x your distance
    const scale = discRadius / scanRange

    // Grid spokes (8)
    ctx.strokeStyle = GRID_COLOR
    ctx.lineWidth = 0.5
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(angle) * discRadius, cy + Math.sin(angle) * discRadius)
      ctx.stroke()
    }

    // Range rings — adapt to current scale
    for (const ringR of SCANNER_RANGE_RINGS) {
      const pr = ringR * scale
      if (pr > discRadius || pr < 3) continue
      ctx.beginPath()
      ctx.arc(cx, cy, pr, 0, Math.PI * 2)
      ctx.strokeStyle = RING_COLOR
      ctx.lineWidth = 0.6
      ctx.stroke()
    }

    // Centre crosshair
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy)
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5)
    ctx.stroke()

    // Forward indicator triangle
    ctx.fillStyle = 'rgba(99, 102, 241, 0.4)'
    ctx.beginPath()
    ctx.moveTo(cx, cy - discRadius + 3)
    ctx.lineTo(cx - 4, cy - discRadius + 9)
    ctx.lineTo(cx + 4, cy - discRadius + 9)
    ctx.closePath()
    ctx.fill()

    if (!cam) {
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    const [cpx, cpy, cpz] = cam.position
    const [cdx, , cdz] = cam.direction

    // Camera heading on XZ plane
    const fwdLen = Math.sqrt(cdx * cdx + cdz * cdz) || 1
    const fwdX = cdx / fwdLen
    const fwdZ = cdz / fwdLen
    const rightX = -fwdZ
    const rightZ = fwdX

    const now = Date.now()
    const currentEntities = entitiesRef.current
    const currentSelected = selectedRef.current

    // Flagpole scale: same as XZ scale so 1 unit of height = 1 unit lateral on disc
    const flagScale = scale * 0.6

    for (const entity of currentEntities) {
      if (!entity.position) continue
      const [wx, wy, wz] = entity.position

      // XZ offset from camera (world space)
      const dx = wx - cpx
      const dy = wy - cpy  // Y offset = height above/below camera
      const dz = wz - cpz

      // Rotate into camera frame (forward = up on disc, right = right on disc)
      const lateral = dx * rightX + dz * rightZ   // right on disc
      const depth = dx * fwdX + dz * fwdZ         // forward on disc

      // Linear XZ projection onto disc (flat map, like holo radar from above)
      let discX = lateral * scale
      let discY = -depth * scale  // forward = up on disc (negative canvas Y)

      // Clamp to disc boundary
      const discDist = Math.sqrt(discX * discX + discY * discY)
      if (discDist > discRadius - 4) {
        const clamp = (discRadius - 4) / discDist
        discX *= clamp
        discY *= clamp
      }

      const dotX = cx + discX
      const dotY = cy + discY
      const isSelected = entity.id === currentSelected
      const color = entity.color || '#6366f1'

      // Flagpole: Y offset from camera plane
      // Positive dy = above camera → flag goes UP on screen (toward top of disc)
      // Negative dy = below camera → flag goes DOWN on screen (toward bottom of disc)
      const flagH = dy * flagScale
      const hasFlag = Math.abs(flagH) > 1.2

      if (hasFlag) {
        // Flagpole line
        ctx.beginPath()
        ctx.moveTo(dotX, dotY)
        ctx.lineTo(dotX, dotY - flagH) // subtract: +Y world = up on screen
        ctx.strokeStyle = hexToRgba(color, isSelected ? 0.6 : 0.3)
        ctx.lineWidth = isSelected ? 1.5 : 0.7
        ctx.stroke()

        // Base dot on the XZ plane (where entity's shadow would be)
        ctx.beginPath()
        ctx.arc(dotX, dotY, 1.2, 0, Math.PI * 2)
        ctx.fillStyle = hexToRgba(color, 0.2)
        ctx.fill()
      }

      // Pinhead dot at tip of flagpole (or on disc if no flag)
      const pinX = dotX
      const pinY = hasFlag ? dotY - flagH : dotY
      const dotSize = isSelected ? 3.5 : 2

      ctx.beginPath()
      ctx.arc(pinX, pinY, dotSize, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      // Glow ring
      ctx.beginPath()
      ctx.arc(pinX, pinY, dotSize + 0.8, 0, Math.PI * 2)
      ctx.strokeStyle = hexToRgba(color, 0.25)
      ctx.lineWidth = 0.6
      ctx.stroke()

      // Selected: pulsing ring + label
      if (isSelected) {
        const pulse = 0.6 + 0.4 * Math.sin(now * 0.004)
        ctx.beginPath()
        ctx.arc(pinX, pinY, dotSize + 4, 0, Math.PI * 2)
        ctx.strokeStyle = hexToRgba(color, pulse)
        ctx.lineWidth = 1.2
        ctx.stroke()

        if (entity.name) {
          ctx.font = FONT
          ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
          ctx.textAlign = 'left'
          ctx.fillText(entity.name, pinX + dotSize + 5, pinY + 3)
        }
      }
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [size, cx, cy, discRadius])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [draw])

  // Click handler
  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current
    const cam = cameraRef.current
    if (!canvas || !cam) return
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (size / rect.width)
    const my = (e.clientY - rect.top) * (size / rect.height)

    const [cpx, cpy, cpz] = cam.position
    const [cdx, , cdz] = cam.direction
    const fwdLen = Math.sqrt(cdx * cdx + cdz * cdz) || 1
    const fwdX = cdx / fwdLen
    const fwdZ = cdz / fwdLen
    const rightX = -fwdZ
    const rightZ = fwdX

    const camDist = Math.sqrt(cpx * cpx + cpy * cpy + cpz * cpz)
    const scanRange = Math.max(30, camDist * 2.5)
    const scale = discRadius / scanRange
    const flagScale = scale * 0.6

    let closest = null
    let closestDist = 16

    for (const entity of entitiesRef.current) {
      if (!entity.position) continue
      const [wx, wy, wz] = entity.position
      const dx = wx - cpx, dy = wy - cpy, dz = wz - cpz
      const lateral = dx * rightX + dz * rightZ
      const depth = dx * fwdX + dz * fwdZ
      let discX = lateral * scale
      let discY = -depth * scale
      const dd = Math.sqrt(discX * discX + discY * discY)
      if (dd > discRadius - 4) { const c = (discRadius - 4) / dd; discX *= c; discY *= c }
      const dotX = cx + discX
      const dotY = cy + discY
      const flagH = dy * flagScale
      const pinY = Math.abs(flagH) > 1.2 ? dotY - flagH : dotY
      const d = Math.sqrt((mx - dotX) ** 2 + (my - pinY) ** 2)
      if (d < closestDist) { closestDist = d; closest = entity }
    }
    if (closest && onSelect) onSelect(closest)
  }, [discRadius, cx, cy, onSelect, size])

  return (
    <div style={{
      position: 'absolute',
      bottom: 8,
      left: '50%',
      transform: 'translateX(-50%) perspective(500px) rotateX(30deg)',
      transformOrigin: 'center bottom',
      zIndex: 15,
      pointerEvents: 'auto',
    }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{
          width: size,
          height: size,
          cursor: 'pointer',
          borderRadius: '50%',
          filter: 'drop-shadow(0 0 10px rgba(99, 102, 241, 0.15))',
        }}
      />
    </div>
  )
}

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#') return `rgba(100,100,200,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
