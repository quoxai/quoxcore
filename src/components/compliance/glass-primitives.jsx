/**
 * CRP Glass Primitives — reusable glass design system components
 * for the Compliance Command Center.
 */

import { useState } from 'react'

export const M = "'JetBrains Mono','Fira Code',monospace"
export const F = "'Inter',system-ui,sans-serif"

export const COLORS = {
  purple: '#a855f7',
  cyan: '#38bdf8',
  green: '#30ff90',
  amber: '#f59e0b',
  red: '#ef4444',
  teal: '#06b6d4',
  indigo: '#6366f1',
  white: '#fff',
  dimText: 'rgba(255,255,255,0.75)',
  subtleText: 'rgba(255,255,255,0.75)',
}

export const STATUS_COLORS = {
  compliant: COLORS.green,
  partial: COLORS.amber,
  'non-compliant': COLORS.red,
  not_measured: 'rgba(255,255,255,0.75)',
  gap: COLORS.red,
  pass: COLORS.green,
  fail: COLORS.red,
  warn: COLORS.amber,
  pending: COLORS.cyan,
}

export const PROTOCOL_COLORS = {
  AEE: '#38bdf8',
  AOCL: '#a855f7',
  VOLT: '#30ff90',
  WARD: '#06b6d4',
}

/** Glass Panel — the core container */
export function GlassPanel({ children, style = {}, highlight, onClick, hoverable = false }) {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)

  const baseStyle = {
    backdropFilter: 'var(--glass-blur-strong)',
    WebkitBackdropFilter: 'var(--glass-blur-strong)',
    background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
    borderTop: `1px solid ${highlight ? `${highlight}50` : 'rgba(255,255,255,0.40)'}`,
    borderLeft: `1px solid ${highlight ? `${highlight}30` : 'rgba(255,255,255,0.31)'}`,
    borderRight: '1px solid transparent',
    borderBottom: '1px solid transparent',
    borderRadius: 12,
    boxShadow: highlight
      ? `0 0 30px ${highlight}15, 0 5px 19px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.08)`
      : '0 5px 19px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.08)',
    position: 'relative',
    overflow: 'hidden',
    padding: 16,
    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
    ...(hoverable && hovered ? {
      transform: 'translateY(-2px) scale(1.008)',
      boxShadow: '0 8px 25px rgba(0,0,0,0.4), 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.12)',
    } : {}),
    ...(hoverable && pressed ? {
      transform: 'translateY(1px) scale(0.995)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3), inset 0 2px 4px rgba(0,0,0,0.15)',
    } : {}),
    ...(onClick ? { cursor: 'pointer' } : {}),
    ...style,
  }

  return (
    <div
      style={baseStyle}
      onClick={onClick}
      onMouseEnter={hoverable ? () => setHovered(true) : undefined}
      onMouseLeave={hoverable ? () => { setHovered(false); setPressed(false) } : undefined}
      onMouseDown={hoverable ? () => setPressed(true) : undefined}
      onMouseUp={hoverable ? () => setPressed(false) : undefined}
    >
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
        background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)',
      }} />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}

/** Glass Pill — small status/tag badges */
export function GlassPill({ children, color = COLORS.white, style = {} }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 6,
      background: `${color}12`, border: `1px solid ${color}25`,
      fontFamily: M, fontSize: 9, fontWeight: 600, color,
      ...style,
    }}>
      {children}
    </span>
  )
}

/** Glass Tab Bar — top-level tab navigation */
export function GlassTabBar({ tabs, activeTab, onTabChange }) {
  return (
    <div style={{
      display: 'flex', gap: 2, padding: 3, borderRadius: 10,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {tabs.map(tab => {
        const active = tab.id === activeTab
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none',
              fontFamily: M, fontSize: 11, fontWeight: active ? 700 : 500,
              color: active ? '#fff' : 'rgba(255,255,255,0.75)',
              background: active
                ? 'linear-gradient(145deg, rgba(168,85,247,0.15) 0%, rgba(56,189,248,0.06) 100%)'
                : 'transparent',
              boxShadow: active
                ? 'inset 0 1px 2px rgba(168,85,247,0.15), 0 0 20px rgba(168,85,247,0.08)'
                : 'none',
              borderTop: active ? '1px solid rgba(168,85,247,0.3)' : '1px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              letterSpacing: 0.5,
            }}
          >
            {tab.icon && <span style={{ marginRight: 6 }}>{tab.icon}</span>}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/** Section Header */
export function SectionHeader({ title, subtitle, action }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <div>
        <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, letterSpacing: 1.5, textTransform: 'uppercase' }}>{title}</div>
        {subtitle && <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  )
}

/** Progress Ring — reusable SVG ring */
export function ProgressRing({ value, size = 72, strokeWidth = 5, color, label }) {
  const r = (size - strokeWidth) / 2
  const circ = 2 * Math.PI * r
  const dash = (value / 100) * circ
  const c = color || (value > 90 ? COLORS.green : value >= 60 ? COLORS.amber : COLORS.red)

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c} strokeWidth={strokeWidth}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * 0.25} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s cubic-bezier(0.4, 0, 0.2, 1)' }} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontFamily: M, fontSize: size > 60 ? 16 : 12, fontWeight: 800, color: c }}>{Math.round(value)}%</span>
        {label && <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>{label}</span>}
      </div>
    </div>
  )
}

/** Mini Sparkline — tiny inline trend */
export function Sparkline({ data = [], color = COLORS.cyan, width = 60, height = 20 }) {
  if (data.length < 2) return null
  const max = Math.max(...data), min = Math.min(...data)
  const range = max - min || 1
  const points = data.map((v, i) =>
    `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`
  ).join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
    </svg>
  )
}

/** Glass Button — unified action button (GLV-3) */
export function GlassButton({
  children, onClick, disabled = false,
  variant = 'default', size = 'md',
  title, style: extraStyle = {}, type = 'button',
}) {
  const variants = {
    default: {
      bg: 'rgba(255,255,255,0.04)',
      bgHover: 'rgba(255,255,255,0.08)',
      border: 'rgba(255,255,255,0.12)',
      color: '#fff',
    },
    primary: {
      bg: `${COLORS.purple}22`, bgHover: `${COLORS.purple}33`,
      border: `${COLORS.purple}4d`, color: COLORS.purple,
    },
    cyan: {
      bg: `${COLORS.cyan}22`, bgHover: `${COLORS.cyan}33`,
      border: `${COLORS.cyan}4d`, color: COLORS.cyan,
    },
    success: {
      bg: `${COLORS.green}22`, bgHover: `${COLORS.green}33`,
      border: `${COLORS.green}4d`, color: COLORS.green,
    },
    danger: {
      bg: `${COLORS.red}1f`, bgHover: `${COLORS.red}33`,
      border: `${COLORS.red}4d`, color: COLORS.red,
    },
    warn: {
      bg: `${COLORS.amber}22`, bgHover: `${COLORS.amber}33`,
      border: `${COLORS.amber}4d`, color: COLORS.amber,
    },
  }
  const sizes = {
    sm: { padding: '4px 10px', fontSize: 10 },
    md: { padding: '6px 14px', fontSize: 11 },
    lg: { padding: '8px 16px', fontSize: 12 },
  }
  const v = variants[variant] || variants.default
  const s = sizes[size] || sizes.md
  const [hover, setHover] = useState(false)
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontFamily: M, fontWeight: 600, letterSpacing: 0.3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: s.padding, fontSize: s.fontSize,
        borderRadius: 8, border: `1px solid ${v.border}`,
        background: disabled ? v.bg : hover ? v.bgHover : v.bg,
        color: v.color,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        ...extraStyle,
      }}
    >
      {children}
    </button>
  )
}

/** Loading skeleton — glass shimmer placeholder */
export function GlassSkeleton({ height = 120, style = {} }) {
  return (
    <GlassPanel style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }}>
      <div style={{
        fontFamily: M, fontSize: 11, color: COLORS.subtleText,
        animation: 'pulse 1.5s ease-in-out infinite',
      }}>
        Loading...
      </div>
    </GlassPanel>
  )
}

/** Error state */
export function GlassError({ message, onRetry }) {
  return (
    <GlassPanel highlight={COLORS.red} style={{ textAlign: 'center', padding: 24 }}>
      <div style={{ fontFamily: M, fontSize: 12, color: COLORS.red, marginBottom: 8 }}>Failed to load data</div>
      <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginBottom: 12 }}>{message}</div>
      {onRetry && (
        <GlassPanel hoverable onClick={onRetry} style={{ display: 'inline-block', padding: '6px 16px', cursor: 'pointer' }}>
          <span style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>Retry</span>
        </GlassPanel>
      )}
    </GlassPanel>
  )
}
