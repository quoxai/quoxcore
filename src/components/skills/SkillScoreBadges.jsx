/**
 * SkillScoreBadges — QSKL-7.7b
 *
 * Small pill-badges showing success_rate_30d and avg_latency_ms
 * from a scoreboard row. Uses glass-design-system qx-pill classes only.
 */

export default function SkillScoreBadges({ scoreboard }) {
  if (!scoreboard) return null

  const { success_rate_30d, avg_latency_ms } = scoreboard
  const successPct = success_rate_30d != null
    ? `${Math.round(Number(success_rate_30d) * 100)}%`
    : null
  const latency = avg_latency_ms != null
    ? `${Math.round(Number(avg_latency_ms))}ms`
    : null

  if (!successPct && !latency) return null

  const successClass = success_rate_30d != null && Number(success_rate_30d) >= 0.9
    ? 'qx-pill qx-pill--sm qx-pill--success'
    : success_rate_30d != null && Number(success_rate_30d) >= 0.7
      ? 'qx-pill qx-pill--sm qx-pill--degraded'
      : 'qx-pill qx-pill--sm qx-pill--danger'

  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {successPct && (
        <span className={successClass} title="30-day success rate">
          {successPct}
        </span>
      )}
      {latency && (
        <span className="qx-pill qx-pill--sm qx-pill--ghost" title="avg latency">
          {latency}
        </span>
      )}
    </span>
  )
}
