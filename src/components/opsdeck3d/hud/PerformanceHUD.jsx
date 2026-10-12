/**
 * PerformanceHUD — Debug FPS overlay with preset/zone/layer info.
 *
 * Extracted from CognitiveCore3DView.jsx (Phase CC-10 refactor).
 */

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const GLASS_BG = 'var(--cc3d-glass-bg, rgba(5, 5, 16, 0.88))'

export default function PerformanceHUD({ fps, presetName, zoneName, visibleCount, glInfo }) {
  const drawCalls = glInfo?.render?.calls ?? '?'
  const triangles = glInfo?.render?.triangles ?? '?'
  const drawCallWarn = typeof drawCalls === 'number' && drawCalls > 120
  const triWarn = typeof triangles === 'number' && triangles > 250000

  return (
    <div style={{
      position: 'fixed', top: 44, right: 16, zIndex: 35,
      padding: '8px 12px', borderRadius: 5,
      background: GLASS_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      border: '1px solid rgba(139, 92, 246, 0.2)',
      fontFamily: FONT_STACK, fontSize: 9, letterSpacing: '0.04em',
      color: 'rgba(255,255,255,0.6)', lineHeight: 1.7,
    }}>
      <div><span style={{ color: fps < 20 ? '#ef4444' : fps < 30 ? '#f59e0b' : '#22c55e' }}>{fps}</span> FPS</div>
      <div>DRAW: <span style={{ color: drawCallWarn ? '#ef4444' : 'rgba(255,255,255,0.85)' }}>{drawCalls}</span> calls</div>
      <div>TRIS: <span style={{ color: triWarn ? '#ef4444' : 'rgba(255,255,255,0.85)' }}>{typeof triangles === 'number' ? (triangles / 1000).toFixed(1) + 'K' : triangles}</span></div>
      <div>PRESET: <span style={{ color: 'rgba(255,255,255,0.85)' }}>{presetName || 'Custom'}</span></div>
      <div>ZONE: <span style={{ color: 'rgba(255,255,255,0.85)' }}>{zoneName}</span></div>
      <div>LAYERS: <span style={{ color: 'rgba(255,255,255,0.85)' }}>{visibleCount}</span></div>
    </div>
  )
}
