/**
 * StatsHUD — Pure HTML/CSS HUD overlay component.
 *
 * Glass strip with agent state counts, objective progress, memory stats,
 * FPS sparkline, and zone indicator. Not 3D — this is the HUD design.
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { PALETTE } from '../lib/design-system'

const STATE_COLORS = {
  thinking: PALETTE.thinking,
  executing: PALETTE.executing,
  blocked: PALETTE.blocked,
  idle: PALETTE.idle,
}

const ZONE_COLORS = {
  'AGENT MESH': PALETTE.indigo,
  'EXECUTION': PALETTE.executing,
  'MEMORY LATTICE': PALETTE.memory,
  'NUCLEUS': PALETTE.nucleus,
}

function Sparkline({ data, width = 80, height = 16 }) {
  const max = Math.max(...data, 1)
  const barWidth = Math.max(1, Math.floor(width / data.length) - 1)

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {data.map((val, i) => {
        const h = (val / max) * height
        const color = val < 30 ? PALETTE.blocked : val < 50 ? PALETTE.waiting : PALETTE.executing
        return (
          <rect
            key={i}
            x={i * (barWidth + 1)}
            y={height - h}
            width={barWidth}
            height={h}
            fill={color}
            opacity={0.7}
          />
        )
      })}
    </svg>
  )
}

function StatBadge({ count, label, color }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
    }}>
      <span style={{
        color,
        fontWeight: 700,
        fontSize: 13,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {count}
      </span>
      <span style={{
        color: 'rgba(255,255,255,0.45)',
        fontSize: 10,
        fontWeight: 400,
      }}>
        {label}
      </span>
    </span>
  )
}

function ProgressBar({ progress, color, width = 80 }) {
  return (
    <div style={{
      width,
      height: 4,
      background: 'rgba(255,255,255,0.08)',
      borderRadius: 2,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${progress * 100}%`,
        height: '100%',
        background: color,
        borderRadius: 2,
        transition: 'width 0.3s ease',
        boxShadow: `0 0 8px ${color}40`,
      }} />
    </div>
  )
}

export default function StatsHUD({
  thinking = 4,
  executing = 2,
  blocked = 1,
  idle = 9,
  objectiveCount = 1,
  objectiveProgress = 0.67,
  memoryCount = 12,
  openLoops = 3,
  zone = 'AGENT MESH',
}) {
  const [fpsData, setFpsData] = useState(Array(20).fill(60))
  const frameRef = useRef(0)
  const lastTimeRef = useRef(performance.now())

  // Simulate FPS sampling
  useEffect(() => {
    let rafId
    const tick = () => {
      frameRef.current++
      const now = performance.now()
      if (now - lastTimeRef.current >= 500) {
        const fps = Math.round(frameRef.current * 1000 / (now - lastTimeRef.current))
        setFpsData(prev => [...prev.slice(1), Math.min(fps, 120)])
        frameRef.current = 0
        lastTimeRef.current = now
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const zoneColor = ZONE_COLORS[zone] || PALETTE.indigo
  const avgFps = useMemo(() => Math.round(fpsData.reduce((a, b) => a + b, 0) / fpsData.length), [fpsData])

  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '8px 20px',
      background: 'rgba(5, 5, 20, 0.6)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid rgba(99, 102, 241, 0.15)',
      borderRadius: 12,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      fontSize: 11,
      color: 'rgba(255,255,255,0.7)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      zIndex: 100,
      boxShadow: '0 4px 30px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {/* Agent states */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatBadge count={thinking} label="thinking" color={STATE_COLORS.thinking} />
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>{'\u00B7'}</span>
        <StatBadge count={executing} label="executing" color={STATE_COLORS.executing} />
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>{'\u00B7'}</span>
        <StatBadge count={blocked} label="blocked" color={STATE_COLORS.blocked} />
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>{'\u00B7'}</span>
        <StatBadge count={idle} label="idle" color={STATE_COLORS.idle} />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)' }} />

      {/* Objective */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatBadge count={objectiveCount} label="objective" color={PALETTE.indigo} />
        <span style={{ color: PALETTE.indigo, fontSize: 10, fontWeight: 600 }}>
          ({Math.round(objectiveProgress * 100)}%)
        </span>
        <ProgressBar progress={objectiveProgress} color={PALETTE.indigo} />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)' }} />

      {/* Memory */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatBadge count={memoryCount} label="memories" color={PALETTE.memory} />
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>{'\u00B7'}</span>
        <StatBadge count={openLoops} label="loops" color={PALETTE.openLoop} />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)' }} />

      {/* FPS sparkline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkline data={fpsData} />
        <span style={{
          fontSize: 9,
          color: avgFps > 50 ? PALETTE.executing : avgFps > 30 ? PALETTE.waiting : PALETTE.blocked,
          fontWeight: 600,
        }}>
          {avgFps} FPS
        </span>
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)' }} />

      {/* Zone indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        background: `${zoneColor}15`,
        border: `1px solid ${zoneColor}30`,
        borderRadius: 6,
      }}>
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: zoneColor,
          boxShadow: `0 0 8px ${zoneColor}`,
        }} />
        <span style={{
          color: zoneColor,
          fontWeight: 600,
          fontSize: 10,
          letterSpacing: '0.5px',
        }}>
          {zone}
        </span>
      </div>
    </div>
  )
}
