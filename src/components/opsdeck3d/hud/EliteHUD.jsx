/**
 * EliteHUD — Cockpit frame with corner brackets, bezels, scanline,
 * left gauges, right zone markers, pulse bar, zone label, and controls hint.
 *
 * Extracted from CognitiveCore3DView.jsx (Phase CC-10 refactor).
 */
import { useState, useEffect } from 'react'
import { ZONE_MARKERS } from '../lib/scanner-projection'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const BRAND_VIOLET = '#8b5cf6'
const GLASS_BG = 'var(--cc3d-glass-bg, rgba(5, 5, 16, 0.88))'
const CONTROLS_FADE_MS = 10000

// ─── Quick Action Button with Tooltip ────────────────────
function QAButton({ label, tooltip, onClick, btnStyle }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      style={{ ...btnStyle, position: 'relative' }}
      onMouseOver={(e) => { setHovered(true); e.currentTarget.style.color = 'rgba(255,255,255,0.85)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,0.4)' }}
      onMouseOut={(e) => { setHovered(false); e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,0.15)' }}
    >
      {label}
      {hovered && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 6, padding: '4px 8px',
          background: 'rgba(5, 5, 16, 0.95)', border: '1px solid rgba(139, 92, 246, 0.3)',
          borderRadius: 3, whiteSpace: 'nowrap', fontSize: 9, fontFamily: FONT_STACK,
          letterSpacing: '0.04em', color: 'rgba(255,255,255,0.8)', pointerEvents: 'none', zIndex: 50,
        }}>{tooltip}</div>
      )}
    </button>
  )
}

// ─── Quick Action Bar (top bar additions) ───────────────
export function QuickActions({ onSearch, onPreset, onToggleHud, onFullscreen }) {
  const btnStyle = {
    padding: '3px 8px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(139, 92, 246, 0.15)',
    borderRadius: 3,
    cursor: 'pointer',
    fontFamily: FONT_STACK,
    fontSize: 9,
    letterSpacing: '0.04em',
    color: 'rgba(255,255,255,0.55)',
    transition: 'all 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    pointerEvents: 'auto',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <QAButton onClick={onPreset} btnStyle={btnStyle} label={<>{'\u{1F4CB}'} Presets</>} tooltip="Cycle layer presets (L)" />
      <QAButton onClick={onSearch} btnStyle={btnStyle} label={<>{'\u{1F50D}'} Search</>} tooltip="Search entities (/)" />
      <QAButton onClick={onToggleHud} btnStyle={btnStyle} label="H Hide HUD" tooltip="Toggle HUD overlay (H)" />
      <QAButton onClick={onFullscreen} btnStyle={btnStyle} label={<>{'\u26F6'} Fullscreen</>} tooltip="Toggle fullscreen (Esc to exit)" />
    </div>
  )
}

// ─── HUD State Colour Logic ─────────────────────────────
function getHudTint(systemState) {
  if (systemState === 'error') return { border: 'rgba(239, 68, 68, 0.5)', bracket: 'rgba(239, 68, 68, 0.6)', bg: 'rgba(239, 68, 68, 0.08)' }
  if (systemState === 'alert') return { border: 'rgba(245, 158, 11, 0.45)', bracket: 'rgba(245, 158, 11, 0.55)', bg: 'rgba(245, 158, 11, 0.06)' }
  return { border: 'rgba(139, 92, 246, 0.25)', bracket: 'rgba(139, 92, 246, 0.5)', bg: 'transparent' }
}

// ─── Left Bezel Gauges ──────────────────────────────────

function gaugeColor(pct) {
  if (pct > 80) return '#22c55e'
  if (pct > 50) return '#f59e0b'
  return '#ef4444'
}

function buildGauges({ agentCount = 0, totalAgents = 0, objectiveCount = 0, memoryCount = 0, implantHealth = 0, taskCount = 0, totalTasks = 0 }) {
  const healthPct = Math.min(100, Math.round(implantHealth))
  const agentPct = totalAgents > 0 ? Math.round((agentCount / totalAgents) * 100) : 0
  const objPct = Math.min(100, objectiveCount * 20) // scale: 5 objectives = 100%
  const taskPct = totalTasks > 0 ? Math.round((taskCount / totalTasks) * 100) : 0
  const memPct = Math.min(100, Math.round((memoryCount / 200) * 100)) // scale: 200 = 100%
  return [
    { key: 'hlth', label: 'HLTH', value: `${healthPct}`, pct: healthPct },
    { key: 'agnt', label: 'AGNT', value: `${agentCount}/${totalAgents}`, pct: agentPct },
    { key: 'obj',  label: 'OBJ',  value: `${objectiveCount}`, pct: objPct },
    { key: 'task', label: 'TASK', value: totalTasks > 0 ? `${taskCount}/${totalTasks}` : `${taskCount}`, pct: taskPct },
    { key: 'mem',  label: 'MEM',  value: memoryCount > 999 ? `${(memoryCount / 1000).toFixed(1)}K` : `${memoryCount}`, pct: memPct },
  ]
}

export function LeftBezelGauges({ gaugeData }) {
  const gauges = buildGauges(gaugeData || {})
  return (
    <div style={{
      position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none',
      fontFamily: FONT_STACK, zIndex: 11,
    }}>
      {gauges.map(g => (
        <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 5, width: 52 }}>
          {/* Vertical bar */}
          <div style={{
            width: 3, height: 28, background: 'rgba(255,255,255,0.06)', borderRadius: 1,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: `${g.pct}%`, background: gaugeColor(g.pct),
              borderRadius: 1, transition: 'height 0.6s ease',
            }} />
          </div>
          {/* Label + value */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em', lineHeight: 1 }}>
              {g.label}
            </span>
            <span style={{ fontSize: 9, color: gaugeColor(g.pct), fontWeight: 700, lineHeight: 1 }}>
              {g.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Right Bezel Zone Markers ───────────────────────────
function RightBezelZones({ activeZone }) {
  return (
    <div style={{
      position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none',
      fontFamily: FONT_STACK, zIndex: 11,
    }}>
      {ZONE_MARKERS.map((zm) => {
        const isActive = activeZone === zm.code
        return (
          <div key={zm.code} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
            borderLeft: isActive ? '2px solid rgba(139, 92, 246, 0.8)' : '2px solid transparent',
            transition: 'all 0.4s ease',
          }}>
            <span style={{
              fontSize: 8, letterSpacing: '0.1em', fontWeight: 600,
              color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)',
              transition: 'color 0.4s ease',
            }}>
              {zm.code}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Elite HUD Frame ────────────────────────────────────
function EliteHUDFrame({ systemState, activeZone, gaugeData }) {
  const tint = getHudTint(systemState)

  const bracketStyle = {
    position: 'absolute',
    width: 40,
    height: 40,
    pointerEvents: 'none',
  }

  const Corner = ({ style, rotate }) => (
    <div style={{ ...bracketStyle, ...style }}>
      <svg
        width="40" height="40" viewBox="0 0 40 40"
        style={{ transform: rotate ? `rotate(${rotate}deg)` : undefined }}
      >
        <path
          d="M2 38 L2 2 L38 2"
          fill="none"
          style={{ stroke: tint.bracket }}
          strokeWidth="1.5"
        />
      </svg>
    </div>
  )

  const bezelH = {
    position: 'absolute',
    left: 60,
    right: 60,
    height: 1,
    background: `linear-gradient(90deg, transparent, ${tint.border} 20%, ${tint.border} 80%, transparent)`,
    pointerEvents: 'none',
  }
  const bezelV = {
    position: 'absolute',
    top: 60,
    bottom: 60,
    width: 1,
    background: `linear-gradient(180deg, transparent, ${tint.border} 20%, ${tint.border} 80%, transparent)`,
    pointerEvents: 'none',
  }

  return (
    <div className="cc3d-elite-hud" style={{
      position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10,
    }}>
      {/* Corners */}
      <Corner style={{ top: 12, left: 12 }} />
      <Corner style={{ top: 12, right: 12 }} rotate={90} />
      <Corner style={{ bottom: 12, right: 12 }} rotate={180} />
      <Corner style={{ bottom: 12, left: 12 }} rotate={270} />

      {/* Bezels */}
      <div style={{ ...bezelH, top: 52 }} />
      <div style={{ ...bezelH, bottom: 52 }} />
      <div style={{ ...bezelV, left: 52 }} />
      <div style={{ ...bezelV, right: 52 }} />

      {/* Scanline sweep */}
      <div className="cc3d-scanline" style={{
        position: 'absolute', left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.04) 30%, rgba(139, 92, 246, 0.04) 70%, transparent)',
        pointerEvents: 'none',
        animation: 'cc3d-scanline-sweep 20s linear infinite',
      }} />

      {/* Left bezel gauges */}
      <LeftBezelGauges gaugeData={gaugeData} />

      {/* Right bezel zone markers */}
      <RightBezelZones activeZone={activeZone} />
    </div>
  )
}

// ─── Pulse Bar ──────────────────────────────────────────
export function PulseBar({ agentCount, objectiveCount, memoryCount, isLive }) {
  const dotColor = isLive ? '#22c55e' : '#f59e0b'
  const statusLabel = isLive ? 'LIVE' : 'MOCK DATA'
  const statusColor = isLive ? 'rgba(34, 197, 94, 0.9)' : 'rgba(245, 158, 11, 0.9)'

  return (
    <div className="cc3d-pulse-bar" style={{
      position: 'fixed',
      top: 14,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 20,
      pointerEvents: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '6px 20px',
      background: GLASS_BG,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderRadius: 4,
      border: '1px solid rgba(139, 92, 246, 0.2)',
      fontFamily: FONT_STACK,
      fontSize: 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: BRAND_VIOLET, opacity: 0.9 }}>Cognitive Core 3D</span>
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>|</span>
      <span className="cc3d-pulse-dot" style={{
        display: 'inline-block',
        width: 6, height: 6,
        borderRadius: '50%',
        background: dotColor,
        boxShadow: `0 0 8px ${dotColor}`,
        marginRight: 4,
      }} />
      <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>|</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{agentCount} agents</span>
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>|</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{objectiveCount} objectives</span>
      <span style={{ color: 'rgba(255,255,255,0.3)' }}>|</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{memoryCount} memories</span>
    </div>
  )
}

// ─── Controls Hint ──────────────────────────────────────
export function ControlsHint() {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), CONTROLS_FADE_MS)
    return () => clearTimeout(t)
  }, [])

  if (!visible) return null

  return (
    <div className="cc3d-controls-hint" style={{
      position: 'fixed',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 20,
      pointerEvents: 'none',
      display: 'flex',
      gap: 16,
      padding: '8px 16px',
      background: GLASS_BG,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderRadius: 4,
      border: '1px solid rgba(139, 92, 246, 0.15)',
      fontFamily: FONT_STACK,
      fontSize: 10,
      letterSpacing: '0.06em',
      color: 'rgba(255,255,255,0.6)',
      opacity: visible ? 1 : 0,
      transition: 'opacity 0.8s ease',
    }}>
      <span>Orbit: Left-drag</span>
      <span style={{ color: 'rgba(255,255,255,0.25)' }}>|</span>
      <span>Pan: Right-drag</span>
      <span style={{ color: 'rgba(255,255,255,0.25)' }}>|</span>
      <span>Zoom: Scroll</span>
      <span style={{ color: 'rgba(255,255,255,0.25)' }}>|</span>
      <span>Exit: Esc</span>
    </div>
  )
}

// ─── Zone Label HUD ─────────────────────────────────────
export const ZONE_LABEL_MAP = {
  NUC: 'NUCLEUS',
  SVC: 'SERVICES',
  IMP: 'IMPLANTS',
  AST: 'ASSISTANTS',
  AGT: 'AGENT MESH',
  ORG: 'ORG STRUCTURE',
  TMC: 'AGENTIC TEAMS',
  TMX: 'TEAMS EXT',
  OBJ: 'OBJECTIVE EXECUTION',
  WFX: 'WORKFLOW EXECUTION',
  MEM: 'MEMORY LATTICE',
  VLT: 'VAULT',
  SHL: 'CORE SHELL',
}

const DEPTH_LABELS = { sky: 'SKY', eq: 'EQ', deep: 'DEEP' }
const DEPTH_COLORS = { sky: '#06b6d4', eq: '#8b5cf6', deep: '#f59e0b' }

export function ZoneLabel({ activeZone, activeDepth = 'eq' }) {
  const label = ZONE_LABEL_MAP[activeZone] || ''
  const depthLabel = DEPTH_LABELS[activeDepth] || 'EQ'
  const depthColor = DEPTH_COLORS[activeDepth] || '#8b5cf6'
  const [displayed, setDisplayed] = useState(label)
  const [opacity, setOpacity] = useState(0.3)

  useEffect(() => {
    setOpacity(0)
    const t = setTimeout(() => {
      setDisplayed(label)
      setOpacity(0.3)
    }, 250)
    return () => clearTimeout(t)
  }, [label])

  return (
    <div style={{
      position: 'fixed', top: 52, left: '50%', transform: 'translateX(-50%)',
      zIndex: 19, pointerEvents: 'none',
      fontFamily: FONT_STACK, fontSize: 10, letterSpacing: '0.15em',
      textTransform: 'uppercase', color: 'rgba(255,255,255,1)',
      opacity, transition: 'opacity 0.5s ease',
      display: 'flex', gap: 8, alignItems: 'center',
    }}>
      <span style={{ color: depthColor, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em' }}>{depthLabel}</span>
      <span style={{ color: 'rgba(255,255,255,0.2)' }}>\u203A</span>
      {displayed}
    </div>
  )
}

// ─── FPS Display (simple overlay) ────────────────────────
export function FpsDisplay({ fps }) {
  return (
    <div style={{
      position: 'fixed',
      top: 16,
      right: 20,
      zIndex: 20,
      pointerEvents: 'none',
      fontFamily: FONT_STACK,
      fontSize: 10,
      letterSpacing: '0.06em',
      color: fps < 20 ? '#ef4444' : fps < 30 ? '#f59e0b' : 'rgba(255,255,255,0.5)',
    }}>
      {fps} FPS
    </div>
  )
}

export default EliteHUDFrame
