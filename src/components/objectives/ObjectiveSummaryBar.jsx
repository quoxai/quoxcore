/**
 * ObjectiveSummaryBar — Completion summary for an objective's tasks
 *
 * Shows "✓ 28/30 completed, ✗ 1 failed, ⊘ 1 skipped" with colour-coded counts.
 * Renders nothing when there are no tasks.
 */

const STATUS_GROUPS = [
  { key: 'completed', label: 'completed', icon: '✓', color: 'var(--m-success, #4ade80)' },
  { key: 'running',   label: 'running',   icon: '◉', color: 'var(--m-quox-primary, #38bdf8)' },
  { key: 'failed',    label: 'failed',    icon: '✕', color: 'var(--m-error, #f87171)' },
  { key: 'skipped',   label: 'skipped',   icon: '⊘', color: 'var(--m-text-tertiary, #71717a)' },
]

export default function ObjectiveSummaryBar({ tasks }) {
  if (!tasks || tasks.length === 0) return null

  const counts = {}
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1
  }
  const total = tasks.length

  return (
    <div role="status" aria-label="Task completion summary" style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 12px',
      background: 'var(--m-bg-elevated, rgba(255,255,255,0.02))',
      borderRadius: 'var(--m-radius-md, 6px)',
      fontSize: 12,
      marginBottom: 12,
    }}>
      {STATUS_GROUPS.map(({ key, label, icon, color }) => {
        const count = counts[key] || 0
        if (count === 0) return null
        return (
          <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, color }}>
            <span>{icon}</span>
            <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {key === 'completed' ? `${count}/${total}` : count}
            </span>
            <span style={{ opacity: 0.8 }}>{label}</span>
          </span>
        )
      })}
    </div>
  )
}
