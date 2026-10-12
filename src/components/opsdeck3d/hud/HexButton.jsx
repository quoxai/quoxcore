/**
 * HexButton — Hexagonal tile button for CC3D cockpit UI.
 *
 * Two variants:
 *   - Toggle: on/off state with LED indicator
 *   - Action: one-shot press (e.g., reset, save)
 *
 * CSS clip-path hexagon with glass background, hover glow, press scale.
 * Designed to tile in panels with small gaps between hexes.
 */
import { useState } from 'react'

const FONT_STACK = "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace"

// Pointy-top hexagon clip path
const HEX_CLIP = 'polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)'

export default function HexButton({
  label,
  icon,        // optional: emoji or character
  active,      // for toggle mode
  onClick,
  color = '#22d3ee',
  size = 38,
  tooltip,
}) {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)

  const isActive = active === true
  const hexH = size * 1.15 // pointy-top hex is taller than wide

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false) }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      title={tooltip || label}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        cursor: 'pointer', userSelect: 'none',
      }}
    >
      {/* Hex tile */}
      <div style={{
        width: size, height: hexH,
        clipPath: HEX_CLIP,
        background: isActive
          ? `linear-gradient(160deg, ${color}30, ${color}15 60%, rgba(0,0,0,0.3))`
          : hovered
            ? 'linear-gradient(160deg, rgba(60,60,80,0.7), rgba(30,30,45,0.8))'
            : 'linear-gradient(160deg, rgba(40,40,55,0.6), rgba(15,15,25,0.8))',
        border: 'none',
        position: 'relative',
        transition: 'all 0.12s ease',
        transform: pressed ? 'scale(0.92)' : hovered ? 'scale(1.06)' : 'scale(1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 1,
      }}>
        {/* Inner hex border (inset) */}
        <div style={{
          position: 'absolute', inset: 2,
          clipPath: HEX_CLIP,
          border: 'none',
          background: 'transparent',
          boxShadow: isActive
            ? `inset 0 0 8px ${color}33`
            : 'inset 0 1px 3px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}>
          {/* Hex outline via pseudo-border trick */}
          <div style={{
            position: 'absolute', inset: 0,
            clipPath: HEX_CLIP,
            outline: `1px solid ${isActive ? color + '66' : hovered ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'}`,
            outlineOffset: -1,
          }} />
        </div>

        {/* LED dot */}
        {active !== undefined && (
          <div style={{
            width: 4, height: 4, borderRadius: '50%',
            background: isActive ? color : 'rgba(255,255,255,0.08)',
            boxShadow: isActive ? `0 0 6px ${color}` : 'none',
            transition: 'all 0.2s ease',
            marginBottom: 1,
          }} />
        )}

        {/* Icon or label inside hex */}
        {icon && (
          <span style={{
            fontSize: size * 0.32, lineHeight: 1,
            color: isActive ? color : hovered ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)',
            transition: 'color 0.15s ease',
          }}>
            {icon}
          </span>
        )}
      </div>

      {/* Label below hex */}
      {label && (
        <span style={{
          fontSize: 6.5, fontFamily: FONT_STACK, fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.05em',
          color: isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)',
          transition: 'color 0.15s ease',
          maxWidth: size + 4, textAlign: 'center', lineHeight: 1.1,
        }}>
          {label}
        </span>
      )}
    </div>
  )
}

/**
 * HexPanel — Container for a group of hex buttons.
 * Glass background with rounded corners, flexible layout.
 */
export function HexPanel({ children, style = {} }) {
  return (
    <div style={{
      display: 'flex', gap: 4, alignItems: 'flex-end',
      padding: '6px 8px',
      background: 'rgba(10, 10, 20, 0.5)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      borderRadius: 8,
      border: '1px solid rgba(255,255,255,0.04)',
      ...style,
    }}>
      {children}
    </div>
  )
}
