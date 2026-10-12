/**
 * CommsAnalytics — Server-side delivery analytics dashboard.
 *
 * Layout:
 *   1. Time range toggle (7d / 30d)
 *   2. Stats cards row
 *   3. Channel breakdown bar chart
 *   4. Daily volume time series
 *   5. Scope breakdown table
 */

import { useAnalytics } from '../../hooks/useAnalytics'
import BarChart from './charts/BarChart'
import TimeSeriesChart from './charts/TimeSeriesChart'
import ScopeBreakdownTable from './charts/ScopeBreakdownTable'
import './comms-layout.css'

const CHANNEL_COLORS = {
  telegram: '#0088cc',
  slack: '#e01e5a',
  email: '#ea4335',
  discord: '#5865f2',
  webhook: '#3b82f6',
  msteams: '#5059c9',
  'twilio-sms': '#10b981',
  pagerduty: '#06ac38',
  opsgenie: '#2684ff',
  mattermost: '#0072c6',
  ntfy: '#10b981',
  pushover: '#249df1',
  'google-chat': '#1a73e8',
  gotify: '#34d058',
  rocketchat: '#f5455c',
  line: '#06c755',
}

export default function CommsAnalytics() {
  const { analytics, loading, error, days, setDays } = useAnalytics(7)

  if (loading) {
    return (
      <div className="comms-loading">
        <svg className="corecomms-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
        </svg>
        Loading analytics...
      </div>
    )
  }

  if (error) {
    return (
      <div className="comms-empty">
        <p style={{ color: 'var(--ui-red, #ef4444)' }}>{error}</p>
      </div>
    )
  }

  const summary = analytics?.summary || { total: 0, sent: 0, failed: 0, pending: 0, delivery_rate: 0 }
  const byChannel = analytics?.by_channel || []
  const byDay = analytics?.by_day || []
  const byScope = analytics?.by_scope || []

  // Stats card color logic
  const rateClass = summary.delivery_rate >= 90
    ? 'comms-stat__value--success'
    : summary.delivery_rate >= 50
      ? 'comms-stat__value--neutral'
      : 'comms-stat__value--error'

  // Channel bar chart data
  const channelBarData = byChannel.map(ch => ({
    label: ch.channel_type,
    value: ch.total,
    color: CHANNEL_COLORS[ch.channel_type] || '#3b82f6'
  }))

  return (
    <div className="comms-analytics">
      {/* Header */}
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          Delivery Analytics
        </h2>

        {/* Time range toggle */}
        <div className="comms-time-toggle">
          <button
            className={`comms-time-toggle__btn${days === 7 ? ' comms-time-toggle__btn--active' : ''}`}
            onClick={() => setDays(7)}
          >
            7d
          </button>
          <button
            className={`comms-time-toggle__btn${days === 30 ? ' comms-time-toggle__btn--active' : ''}`}
            onClick={() => setDays(30)}
          >
            30d
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="comms-analytics__cards">
        <div className="comms-analytics__card">
          <div className="comms-analytics__card-value comms-stat__value--success">
            {summary.sent || 0}
          </div>
          <div className="comms-analytics__card-label">Sent</div>
        </div>
        <div className="comms-analytics__card">
          <div className={`comms-analytics__card-value ${rateClass}`}>
            {summary.total > 0 ? `${summary.delivery_rate}%` : '—'}
          </div>
          <div className="comms-analytics__card-label">Delivery Rate</div>
        </div>
        <div className="comms-analytics__card">
          <div className="comms-analytics__card-value comms-stat__value--error">
            {summary.failed || 0}
          </div>
          <div className="comms-analytics__card-label">Failed</div>
        </div>
        <div className="comms-analytics__card">
          <div className="comms-analytics__card-value" style={{ color: 'var(--ui-blue, #3b82f6)' }}>
            {summary.most_used_channel || '—'}
          </div>
          <div className="comms-analytics__card-label">Top Channel</div>
        </div>
      </div>

      {/* Charts grid */}
      <div className="comms-analytics__grid">
        {/* Channel Breakdown */}
        <div className="comms-analytics__section">
          <h3 className="comms-analytics__section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
            Channel Breakdown
          </h3>
          {channelBarData.length > 0 ? (
            <BarChart data={channelBarData} />
          ) : (
            <div className="comms-chart comms-chart--empty">
              <span>No channel data for this period</span>
            </div>
          )}
        </div>

        {/* Daily Volume */}
        <div className="comms-analytics__section">
          <h3 className="comms-analytics__section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Daily Volume
          </h3>
          <TimeSeriesChart data={byDay} height={220} />
        </div>
      </div>

      {/* Scope Breakdown */}
      <div className="comms-analytics__section" style={{ marginTop: 20 }}>
        <h3 className="comms-analytics__section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
          </svg>
          Top Scopes by Volume
        </h3>
        <ScopeBreakdownTable data={byScope} />
      </div>
    </div>
  )
}
