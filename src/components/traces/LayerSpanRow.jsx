/**
 * TRV-3/UX: LayerSpanRow — single row in the waterfall
 * Shows: badge | name | inline summary | ---[===TIME BAR===]--- | duration | VOLT
 */

import { M, F, COLORS } from '../compliance/glass-primitives'

const OUTCOME_STYLES = {
  allow:    { barColor: `${COLORS.green}33`, badgeText: 'ALLOW', badgeBg: `${COLORS.green}66` },
  deny:     { barColor: `${COLORS.red}33`,   badgeText: 'DENY',  badgeBg: `${COLORS.red}66` },
  hitl:     { barColor: `${COLORS.amber}33`, badgeText: 'HITL',  badgeBg: `${COLORS.amber}66` },
  bypass:   { barColor: 'rgba(255,255,255,0.08)', badgeText: 'SKIP',  badgeBg: 'rgba(255,255,255,0.15)' },
  halt:     { barColor: `${COLORS.red}4D`,   badgeText: 'HALT',  badgeBg: `${COLORS.red}80` },
  complete: { barColor: `${COLORS.cyan}33`,  badgeText: null,    badgeBg: null },
}

const LAYER_COLORS = {
  L0: '#6366f1', L1: '#8b5cf6', L2: '#a855f7', L3: '#ec4899',
  L4: '#f43f5e', L5: '#f97316', L6: '#eab308', L7: '#22c55e',
  L8: '#14b8a6', L9: '#06b6d4', L10: '#3b82f6',
}

export default function LayerSpanRow({
  layer, traceDuration, selected, onClick, mode = 'compliance', dimmed = false
}) {
  if (!layer) return null

  const style = OUTCOME_STYLES[layer.outcome] || OUTCOME_STYLES.complete
  const leftPct = traceDuration > 0 ? (layer.started_ms / traceDuration * 100) : 0
  const widthPct = traceDuration > 0 ? Math.max(layer.duration_ms / traceDuration * 100, 0.5) : 100
  const layerColor = LAYER_COLORS[layer.layer_id] || COLORS.cyan
  const summaryText = layer.layer_summary?.text || ''

  return (
    <div
      onClick={onClick}
      role="row"
      aria-selected={selected}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 80px minmax(80px, 180px) 1fr 55px 20px',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        opacity: dimmed ? 0.3 : 1,
        background: selected ? 'rgba(168,85,247,0.08)' : 'transparent',
        borderLeft: selected ? `2px solid ${COLORS.purple}` : '2px solid transparent',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      {/* Badge: layer number in circle */}
      <div style={{
        width: 26, height: 26, borderRadius: '50%',
        background: `${layerColor}20`,
        border: `1.5px solid ${layerColor}60`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: M, fontSize: 9, fontWeight: 700,
        color: layerColor,
      }}>
        {layer.layer_id}
      </div>

      {/* Layer name */}
      <span style={{
        fontFamily: mode === 'compliance' ? F : M,
        fontSize: 11,
        color: COLORS.white,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {mode === 'compliance' ? layer.layer_label : `${layer.layer_id}: ${layer.layer_name}`}
      </span>

      {/* Inline summary — the key insight for this layer */}
      <span style={{
        fontFamily: M, fontSize: 9,
        color: COLORS.subtleText,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {summaryText}
      </span>

      {/* Time bar area */}
      <div style={{ position: 'relative', height: 22, borderRadius: 4, background: 'rgba(255,255,255,0.02)' }}>
        {/* The bar */}
        <div style={{
          position: 'absolute',
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          top: 2, bottom: 2,
          borderRadius: 3,
          background: style.barColor,
          border: `1px solid ${layerColor}40`,
          transition: 'all 0.2s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* Decision badge on the bar */}
          {style.badgeText && (
            <span style={{
              fontFamily: M, fontSize: 8, fontWeight: 700,
              color: '#fff',
              background: style.badgeBg,
              padding: '1px 5px', borderRadius: 3,
              whiteSpace: 'nowrap',
            }}>
              {style.badgeText}
            </span>
          )}
        </div>
      </div>

      {/* Duration */}
      <span style={{
        fontFamily: M, fontSize: 10, color: COLORS.dimText,
        textAlign: 'right',
      }}>
        {formatDuration(layer.duration_ms)}
      </span>

      {/* VOLT indicator */}
      <div style={{
        width: 16, height: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {layer.volt_event_ids?.length > 0 ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        ) : (
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
        )}
      </div>
    </div>
  )
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
