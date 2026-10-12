/**
 * SkillCoverageBar — QSKL-7.7b
 *
 * Single horizontal bar split into Crystal-served (left) and LLM-served (right).
 * Width 100%, inline label "X% Crystal-served / Y% LLM-served".
 * Uses only inline styles — no new CSS file.
 */

export default function SkillCoverageBar({ crystalHitRate = 0 }) {
  const crystalPct = Math.round(Math.min(1, Math.max(0, crystalHitRate)) * 100)
  const llmPct = 100 - crystalPct

  return (
    <div>
      {/* Bar track */}
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.08)',
        }}
        aria-label={`${crystalPct}% Crystal-served, ${llmPct}% LLM-served`}
        role="img"
      >
        {crystalPct > 0 && (
          <div
            style={{
              width: `${crystalPct}%`,
              background: 'rgba(56,189,248,0.75)',
              borderRadius: '3px 0 0 3px',
            }}
          />
        )}
        {llmPct > 0 && (
          <div
            style={{
              width: `${llmPct}%`,
              background: 'rgba(168,85,247,0.5)',
              borderRadius: crystalPct === 0 ? '3px' : '0 3px 3px 0',
            }}
          />
        )}
      </div>
      {/* Label */}
      <p style={{ margin: '4px 0 0 0', fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
        <span style={{ color: 'rgba(56,189,248,0.85)' }}>{crystalPct}%</span>
        {' '}Crystal-served
        {' / '}
        <span style={{ color: 'rgba(168,85,247,0.85)' }}>{llmPct}%</span>
        {' '}LLM-served
      </p>
    </div>
  )
}
