/**
 * HudPrimaryStat — "Shape of Quox" HUD widget.
 *
 * A single glass-card headline: 24h success rate inside a CircularProgress,
 * plus a small rail of supporting platform stats.
 *
 * Props:
 *   healthData: { summary: { healthy, total } } | undefined
 *   analyticsData: { overview: { success_rate, total_conversations } } | undefined
 *   workflows: { deployed: Array } | undefined
 *   analyticsLoading: boolean
 *   serverStats: { success_rate, total_conversations } | undefined
 *   attentionCount: number | undefined
 */
import { CircularProgress } from '../../ui'
import './hud-widgets.css'

function ringColorFor(value) {
  if (value == null) return 'rgba(255, 255, 255, 0.25)'
  if (value >= 90) return '#30ff90'
  if (value >= 70) return '#fbbf24'
  return '#f87171'
}

export default function HudPrimaryStat({
  healthData,
  analyticsData,
  workflows,
  analyticsLoading,
  serverStats,
  attentionCount,
} = {}) {
  const successRate = serverStats?.success_rate ?? analyticsData?.overview?.success_rate ?? null
  const ringValue = successRate == null ? 0 : successRate
  const ringDisplay = successRate == null ? (analyticsLoading ? '…' : '—') : `${Math.round(successRate)}%`

  const summary = healthData?.summary
  const uptimeDisplay =
    summary && summary.total > 0
      ? `${Math.round((summary.healthy / summary.total) * 100)}%`
      : '—'

  const workflowsActive = workflows?.deployed?.length || 0

  const conversations =
    serverStats?.total_conversations ?? analyticsData?.overview?.total_conversations ?? null
  const conversationsDisplay =
    conversations == null ? (analyticsLoading ? '…' : '—') : conversations

  const attentionDisplay = attentionCount ?? '—'

  return (
    <div className="qx-card hud-widget hud-primary-stat-card">
      <div className="hud-primary-stat">
        <div className="hud-primary-stat__ring">
          <CircularProgress
            value={ringValue}
            size={120}
            strokeWidth={10}
            color={ringColorFor(successRate)}
            showValue={false}
          />
          <div className="hud-primary-stat__ring-value">
            <span>{ringDisplay}</span>
            <span className="hud-primary-stat__ring-label">Success 24h</span>
          </div>
        </div>

        <div className="hud-primary-stat__tiles">
          <div className="qx-stat">
            <div className="qx-stat__head">Platform Uptime</div>
            <div className="qx-stat__value">{uptimeDisplay}</div>
          </div>
          <div className="qx-stat">
            <div className="qx-stat__head">Workflows Active</div>
            <div className="qx-stat__value">{workflowsActive}</div>
          </div>
          <div className="qx-stat">
            <div className="qx-stat__head">Conversations 24h</div>
            <div className="qx-stat__value">{conversationsDisplay}</div>
          </div>
          <div className="qx-stat">
            <div className="qx-stat__head">Attention</div>
            <div className="qx-stat__value">{attentionDisplay}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
