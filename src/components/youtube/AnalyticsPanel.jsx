/**
 * AnalyticsPanel — Video/channel analytics with period selector and bar chart.
 *
 * Props: { analytics, loading, error, onRefresh, onPeriodChange }
 */

import { useState } from 'react'

const PERIODS = [
  { label: '7d', days: 7 },
  { label: '28d', days: 28 },
  { label: '90d', days: 90 },
]

function formatNumber(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

function minutesToHours(mins) {
  if (mins == null) return '—'
  const hrs = (Number(mins) / 60).toFixed(1)
  return `${Number(hrs).toLocaleString()}h`
}

export default function AnalyticsPanel({ analytics, loading, error, onRefresh, onPeriodChange }) {
  const [activePeriod, setActivePeriod] = useState(28)

  const handlePeriodChange = (days) => {
    setActivePeriod(days)
    if (onPeriodChange) onPeriodChange(days)
  }

  // Loading skeleton
  if (loading) {
    return (
      <div className="yt-panel yt-analytics">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4C8}'}</span> Analytics
          </h3>
        </div>
        <div className="yt-panel__body">
          <div className="yt-analytics__period-row">
            {PERIODS.map(p => (
              <div key={p.days} className="yt-skeleton" style={{ width: 48, height: 28, borderRadius: 6 }} />
            ))}
          </div>
          <div className="yt-stats-grid" style={{ marginTop: 12 }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="yt-skeleton yt-skeleton--stat" />
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="yt-skeleton" style={{ height: 140 }} />
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="yt-panel yt-analytics">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4C8}'}</span> Analytics
          </h3>
        </div>
        <div className="yt-panel__body yt-panel__body--center">
          <div className="yt-error-cta">
            <p className="yt-error-cta__text">{error}</p>
            <button className="yt-error-cta__btn" onClick={onRefresh}>{'\u21BB'} Retry</button>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (!analytics) {
    return (
      <div className="yt-panel yt-analytics">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4C8}'}</span> Analytics
          </h3>
        </div>
        <div className="yt-panel__body yt-panel__body--center">
          <div className="yt-empty">
            <p>No analytics data available. Connect your channel to get started.</p>
          </div>
        </div>
      </div>
    )
  }

  const { totalViews, watchTimeMinutes, avgDurationSeconds, subscribersGained, dailyViews } = analytics
  const avgDurationFormatted = avgDurationSeconds != null
    ? `${Math.floor(avgDurationSeconds / 60)}:${String(Math.round(avgDurationSeconds % 60)).padStart(2, '0')}`
    : '—'

  const days = dailyViews || []
  const maxViews = Math.max(1, ...days.map(d => d.views || 0))

  return (
    <div className="yt-panel yt-analytics">
      <div className="yt-panel__header">
        <h3 className="yt-panel__title">
          <span style={{ fontSize: 16 }}>{'\u{1F4C8}'}</span> Analytics
        </h3>
        <button className="yt-panel__action" onClick={onRefresh} title="Refresh analytics">
          {'\u21BB'}
        </button>
      </div>
      <div className="yt-panel__body yt-panel__body--scroll">
        {/* Period selector */}
        <div className="yt-analytics__period-row">
          {PERIODS.map(p => (
            <button
              key={p.days}
              className={`yt-period-btn ${activePeriod === p.days ? 'yt-period-btn--active' : ''}`}
              onClick={() => handlePeriodChange(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Stats grid */}
        <div className="yt-stats-grid" style={{ marginTop: 12 }}>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">{formatNumber(totalViews)}</span>
            <span className="yt-stats-grid__label">Total Views</span>
          </div>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">{minutesToHours(watchTimeMinutes)}</span>
            <span className="yt-stats-grid__label">Watch Time</span>
          </div>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">{avgDurationFormatted}</span>
            <span className="yt-stats-grid__label">Avg Duration</span>
          </div>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">{formatNumber(subscribersGained)}</span>
            <span className="yt-stats-grid__label">Subs Gained</span>
          </div>
        </div>

        {/* Daily views bar chart */}
        {days.length > 0 && (
          <div className="yt-bar-chart" style={{ marginTop: 16 }}>
            <div className="yt-bar-chart__container">
              {days.map((d, i) => {
                const pct = ((d.views || 0) / maxViews) * 100
                return (
                  <div key={i} className="yt-bar-chart__col">
                    <div className="yt-bar-chart__bar-wrap">
                      <div
                        className="yt-bar-chart__bar"
                        style={{ height: `${Math.max(pct, 2)}%` }}
                        title={`${d.date}: ${formatNumber(d.views)} views`}
                      />
                    </div>
                    <span className="yt-bar-chart__label">{d.date ? d.date.slice(-5) : ''}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
