/**
 * EngagementOverviewPanel — Page Insights summary. FB-3, mirrors
 * src/components/linkedin/EngagementOverviewPanel.jsx (a metric-cards
 * layout rather than a per-post engagement layout, since Facebook's
 * organic surface reports Page-level Insights, not per-post reactions).
 */

import './facebook.css'

function latestValue(metric) {
  const values = metric.values || []
  if (!values.length) return null
  return values[values.length - 1]
}

export default function EngagementOverviewPanel({ insights, posts }) {
  const metrics = insights || []

  return (
    <div className="fb-panel">
      <div className="fb-panel__header">
        <h3 className="fb-panel__title">
          {'\u{1F4CA}'} Insights
        </h3>
      </div>
      <div className="fb-panel__body">
        <div className="fb-engagement">
          {metrics.length > 0 ? (
            <div className="fb-engagement__totals">
              {metrics.slice(0, 3).map((m) => {
                const v = latestValue(m)
                const value = v && typeof v.value === 'object' ? Object.values(v.value).reduce((a, b) => a + (b || 0), 0) : (v?.value ?? 0)
                return (
                  <div className="fb-engagement__stat" key={m.name}>
                    <span className="fb-engagement__number">{value}</span>
                    <span className="fb-engagement__label">{m.title || m.name}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="fb-empty">
              <p>
                {posts && posts.length === 0
                  ? 'No insights data yet. Publish posts to see Page Insights here.'
                  : 'Insights unavailable for this Page (may need read_insights permission or more history).'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
