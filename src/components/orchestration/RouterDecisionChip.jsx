/**
 * RouterDecisionChip — Inline chip showing learning router's decision on a task
 *
 * Only appears on tasks where the router made a non-default selection.
 * Exploit = blue (best agent picked). Explore = amber (trying alternative).
 *
 * @param {'exploit'|'explore'} reason
 * @param {string} agentId — selected agent
 * @param {number} score — composite score (0-100)
 * @param {Array} [candidates] — all scored candidates for tooltip
 * @param {number} [confidence] — router confidence (0-1)
 */

export default function RouterDecisionChip({ reason = 'exploit', agentId, score, candidates, confidence }) {
  const isExploit = reason === 'exploit'
  const tint = isExploit ? '#3b82f6' : '#f59e0b'
  const bg = isExploit ? 'rgba(59,130,246,0.1)' : 'rgba(245,158,11,0.1)'
  const border = isExploit ? 'rgba(59,130,246,0.3)' : 'rgba(245,158,11,0.3)'
  const icon = isExploit ? '\u26A1' : '?'

  const tooltip = candidates
    ? `Candidates: ${candidates.map(c => `${c.agentId} (${c.score})`).join(', ')}. Confidence: ${((confidence || 0) * 100).toFixed(0)}%`
    : undefined

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        height: 20,
        paddingLeft: 5,
        paddingRight: 6,
        borderRadius: 4,
        background: bg,
        border: `1px solid ${border}`,
        fontFamily: 'var(--m-font-mono, monospace)',
        fontSize: 10,
        whiteSpace: 'nowrap',
        cursor: tooltip ? 'help' : 'default',
      }}
    >
      <span style={{ fontSize: 9, color: tint, lineHeight: 1 }}>{icon}</span>
      <span style={{ color: tint, fontWeight: 600, lineHeight: 1 }}>
        {isExploit ? score : 'try'}
      </span>
    </span>
  )
}
