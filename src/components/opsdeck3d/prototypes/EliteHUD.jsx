/**
 * EliteHUD — Cockpit-style frame around the 3D viewport.
 *
 * Inspired by Elite: Dangerous. Angular bezels, scan lines,
 * readouts along the edges, a proper spaceship windshield feel.
 * This wraps the entire viewport — it's the "cockpit" you view
 * the Cognitive Core from.
 *
 * Pure HTML/CSS overlay — no 3D. Layer on top of the Canvas.
 */
import { useState, useEffect, useRef } from 'react'
import { PALETTE } from '../lib/design-system'

const FONT = "'JetBrains Mono', 'Fira Code', monospace"
const BRAND = '#8b5cf6'
const CYAN = '#06b6d4'
const GREEN = '#22c55e'
const AMBER = '#f59e0b'
const RED = '#ef4444'

export default function EliteHUD({
  fps = 60,
  agentsActive = 6,
  agentsTotal = 16,
  objectivesRunning = 2,
  tasksTotal = 12,
  tasksComplete = 5,
  systemHealth = 91,
  memoryCount = 8247,
  openLoops = 3,
  zone = 'AGENT MESH',
  connectionState = 'connected',
}) {
  const [time, setTime] = useState(new Date())
  const [scanline, setScanline] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // Slow scanline sweep
  useEffect(() => {
    let raf
    let pos = 0
    const tick = () => {
      pos = (pos + 0.15) % 100
      setScanline(pos)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const healthColor = systemHealth > 85 ? GREEN : systemHealth > 60 ? AMBER : RED
  const connColor = connectionState === 'connected' ? GREEN : connectionState === 'connecting' ? AMBER : RED

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 30, fontFamily: FONT }}>

      {/* ═══ TOP BEZEL ═══ */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 44,
        background: 'linear-gradient(180deg, rgba(5,5,16,0.95) 0%, rgba(5,5,16,0.7) 80%, transparent 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: `1px solid ${BRAND}15`,
      }}>
        {/* Left cluster */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: BRAND, strokeWidth: 1.5 }}>
              <polygon points="12,2 22,8 22,16 12,22 2,16 2,8" />
              <circle cx="12" cy="12" r="3" fill={BRAND} fillOpacity="0.3" />
            </svg>
            <span style={{ fontSize: 12, fontWeight: 800, color: BRAND, letterSpacing: 2 }}>COGNITIVE CORE</span>
          </div>
          {/* Connection */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: connColor, boxShadow: `0 0 6px ${connColor}` }} />
            <span style={{ fontSize: 8, color: connColor }}>{connectionState.toUpperCase()}</span>
          </div>
        </div>

        {/* Centre — Zone indicator */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 9, letterSpacing: '0.15em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' }}>Current Zone</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>{zone}</div>
        </div>

        {/* Right cluster */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 10, color: fps > 30 ? GREEN : fps > 20 ? AMBER : RED }}>{fps} FPS</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{timeStr}</span>
        </div>
      </div>

      {/* ═══ LEFT BEZEL — System Status ═══ */}
      <div style={{
        position: 'absolute', top: 60, left: 0, bottom: 40, width: 50,
        background: 'linear-gradient(90deg, rgba(5,5,16,0.8) 0%, transparent 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: 10, gap: 12,
      }}>
        {/* Health gauge */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 6, color: 'rgba(255,255,255,0.2)', letterSpacing: 1 }}>HLTH</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: healthColor }}>{systemHealth}</div>
          <div style={{ width: 3, height: 30, borderRadius: 1.5, background: 'rgba(255,255,255,0.04)', marginTop: 3 }}>
            <div style={{ width: '100%', height: `${systemHealth}%`, borderRadius: 1.5, background: healthColor, opacity: 0.7 }} />
          </div>
        </div>

        {/* Agent count */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 6, color: 'rgba(255,255,255,0.2)', letterSpacing: 1 }}>AGNT</div>
          <div style={{ fontSize: 10, fontWeight: 700, color: PALETTE.indigo }}>{agentsActive}</div>
          <div style={{ fontSize: 7, color: 'rgba(255,255,255,0.2)' }}>/{agentsTotal}</div>
        </div>

        {/* Objectives */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 6, color: 'rgba(255,255,255,0.2)', letterSpacing: 1 }}>OBJ</div>
          <div style={{ fontSize: 10, fontWeight: 700, color: GREEN }}>{objectivesRunning}</div>
        </div>

        {/* Tasks */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 6, color: 'rgba(255,255,255,0.2)', letterSpacing: 1 }}>TASK</div>
          <div style={{ fontSize: 10, fontWeight: 700, color: CYAN }}>{tasksComplete}/{tasksTotal}</div>
        </div>

        {/* Memory */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 6, color: 'rgba(255,255,255,0.2)', letterSpacing: 1 }}>MEM</div>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#ec4899' }}>{(memoryCount / 1000).toFixed(1)}K</div>
        </div>

        {/* Open loops */}
        {openLoops > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 6, color: AMBER, letterSpacing: 1 }}>LOOP</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: AMBER }}>{openLoops}</div>
          </div>
        )}
      </div>

      {/* ═══ RIGHT BEZEL — Mini readouts ═══ */}
      <div style={{
        position: 'absolute', top: 60, right: 0, bottom: 40, width: 50,
        background: 'linear-gradient(270deg, rgba(5,5,16,0.8) 0%, transparent 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        paddingTop: 10, gap: 8,
      }}>
        {/* Vertical zone markers */}
        {['NUC', 'IMP', 'AGT', 'EXC', 'MEM', 'SHL'].map((z, i) => (
          <div key={z} style={{
            fontSize: 7, fontWeight: 600, textAlign: 'center', padding: '3px 0',
            color: zone.startsWith(z.slice(0, 3)) ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.12)',
            borderLeft: zone.startsWith(z.slice(0, 3)) ? `2px solid ${BRAND}` : '2px solid transparent',
            paddingLeft: 4, width: '100%',
          }}>
            {z}
          </div>
        ))}
      </div>

      {/* ═══ BOTTOM BEZEL ═══ */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: 36,
        background: 'linear-gradient(0deg, rgba(5,5,16,0.95) 0%, rgba(5,5,16,0.7) 70%, transparent 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 20px', gap: 24,
        borderTop: `1px solid ${BRAND}10`,
      }}>
        {[
          { l: 'SCROLL', v: 'zoom' },
          { l: 'DRAG', v: 'orbit' },
          { l: 'CLICK', v: 'select' },
          { l: '1-5', v: 'zones' },
          { l: 'F', v: 'fly' },
          { l: 'H', v: 'HUD' },
          { l: 'ESC', v: 'close' },
        ].map(k => (
          <div key={k.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontSize: 8, fontWeight: 700, color: 'rgba(255,255,255,0.4)',
              padding: '1px 5px', borderRadius: 3,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
            }}>{k.l}</span>
            <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)' }}>{k.v}</span>
          </div>
        ))}
      </div>

      {/* ═══ CORNER BRACKETS — the Elite signature ═══ */}
      {/* Top-left */}
      <svg style={{ position: 'absolute', top: 44, left: 50, width: 40, height: 40, pointerEvents: 'none' }}>
        <path d="M 0 30 L 0 5 Q 0 0 5 0 L 30 0" fill="none" stroke={BRAND} strokeWidth="0.5" opacity="0.2" />
      </svg>
      {/* Top-right */}
      <svg style={{ position: 'absolute', top: 44, right: 50, width: 40, height: 40, pointerEvents: 'none' }}>
        <path d="M 40 30 L 40 5 Q 40 0 35 0 L 10 0" fill="none" stroke={BRAND} strokeWidth="0.5" opacity="0.2" />
      </svg>
      {/* Bottom-left */}
      <svg style={{ position: 'absolute', bottom: 36, left: 50, width: 40, height: 40, pointerEvents: 'none' }}>
        <path d="M 0 10 L 0 35 Q 0 40 5 40 L 30 40" fill="none" stroke={BRAND} strokeWidth="0.5" opacity="0.2" />
      </svg>
      {/* Bottom-right */}
      <svg style={{ position: 'absolute', bottom: 36, right: 50, width: 40, height: 40, pointerEvents: 'none' }}>
        <path d="M 40 10 L 40 35 Q 40 40 35 40 L 10 40" fill="none" stroke={BRAND} strokeWidth="0.5" opacity="0.2" />
      </svg>

      {/* ═══ SCANLINE ═══ */}
      <div style={{
        position: 'absolute', top: `${scanline}%`, left: 50, right: 50,
        height: 1,
        background: `linear-gradient(90deg, transparent 0%, ${BRAND}08 30%, ${BRAND}12 50%, ${BRAND}08 70%, transparent 100%)`,
        pointerEvents: 'none',
      }} />

      {/* ═══ CROSSHAIR (centre) ═══ */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 20, height: 20, pointerEvents: 'none',
      }}>
        <div style={{ position: 'absolute', top: 0, left: '50%', width: 1, height: 6, background: 'rgba(255,255,255,0.06)', transform: 'translateX(-50%)' }} />
        <div style={{ position: 'absolute', bottom: 0, left: '50%', width: 1, height: 6, background: 'rgba(255,255,255,0.06)', transform: 'translateX(-50%)' }} />
        <div style={{ position: 'absolute', left: 0, top: '50%', width: 6, height: 1, background: 'rgba(255,255,255,0.06)', transform: 'translateY(-50%)' }} />
        <div style={{ position: 'absolute', right: 0, top: '50%', width: 6, height: 1, background: 'rgba(255,255,255,0.06)', transform: 'translateY(-50%)' }} />
      </div>
    </div>
  )
}
