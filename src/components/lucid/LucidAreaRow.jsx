/** One area: a tile (full) or a row (compact). Tiles grow with their content, never clip. */
import { useState } from 'react'
import { dur, fmtWhen } from '../../services/lucid'
import { STATE_GLYPH, sub, Svg } from './lucidUi'

const CLAMP = {
  display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden',
}

export default function LucidAreaRow({ area, now, compact, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false)
  const st = STATE_GLYPH[area.state] || STATE_GLYPH.unknown
  const muted = area.state === 'unknown'
  const headline = muted ? 'Not connected yet' : area.L0
  const last = !muted && area.last
    ? `Last: ${area.last.L0} · ${dur(now - area.last.ts)} ago${compact ? '' : ` (${fmtWhen(area.last.ts)})`}`
    : null

  if (compact) {
    return (
      <div role="row" style={{
        display: 'grid', gridTemplateColumns: '64px 1fr', columnGap: 8, rowGap: 1,
        fontSize: 12, lineHeight: 1.4, opacity: muted ? 0.7 : 1,
      }}>
        <span role="cell" style={{ fontWeight: 600 }}>{area.label}</span>
        <span role="cell" title={st.t} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <span style={{ color: st.c, marginRight: 4 }} aria-label={st.t}>{st.g}</span>{headline}
        </span>
        {last && <span role="cell" style={{ ...sub, gridColumn: '2' }}>{last}</span>}
      </div>
    )
  }

  const long = (headline || '').length + (last || '').length > 140
  const clamp = long && !expanded ? CLAMP : null
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.() } }

  return (
    <div role="button" tabIndex={0} aria-pressed={!!selected} onClick={onSelect} onKeyDown={onKey}
      className={`qx-card qx-card--compact qx-card--lift`}
      style={{ cursor: 'pointer', opacity: muted ? 0.75 : 1, display: 'flex', flexDirection: 'column', gap: 8, height: 'auto', flexShrink: 0,
        outline: selected ? '2px solid rgba(56,189,248,0.7)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: st.c, fontSize: 16, lineHeight: 1 }} aria-label={st.t} title={st.t}>{st.g}</span>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }}>{area.label}</span>
        <span style={{ ...sub, flex: 'none' }}>{st.t}</span>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.45, overflowWrap: 'anywhere', ...clamp }}>{headline}</div>
      {last && <div style={{ ...sub, ...clamp }}>{last}</div>}
      {long && (
        <button type="button" className="glass-btn" aria-expanded={expanded}
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11 }}>
          <Svg>{expanded ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}</Svg>
          <span>{expanded ? 'Show less' : 'Show more'}</span>
        </button>
      )}
    </div>
  )
}
