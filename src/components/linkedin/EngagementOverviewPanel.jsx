/**
 * EngagementOverviewPanel — 30-day totals, per-post bars, top post.
 */

import './linkedin.css'

function MiniBar({ value, max }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="li-minibar">
      <div className="li-minibar__fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function EngagementOverviewPanel({ posts, engagement }) {
  const postIds = posts.map(p => p.id).filter(Boolean)
  const engagementData = postIds.map(id => engagement[id] || { reactions: 0, comments: 0, total_engagement: 0 })

  const totalReactions = engagementData.reduce((sum, e) => sum + (e.reactions || 0), 0)
  const totalComments = engagementData.reduce((sum, e) => sum + (e.comments || 0), 0)
  const totalEngagement = totalReactions + totalComments

  const maxEngagement = Math.max(...engagementData.map(e => e.total_engagement || 0), 1)

  const topPostIdx = engagementData.reduce((best, e, i) =>
    (e.total_engagement || 0) > (engagementData[best]?.total_engagement || 0) ? i : best, 0)
  const topPost = posts[topPostIdx]
  const topEng = engagementData[topPostIdx]

  return (
    <div className="li-panel">
      <div className="li-panel__header">
        <h3 className="li-panel__title">
          {'\u{1F4CA}'} Engagement
        </h3>
      </div>
      <div className="li-panel__body">
        <div className="li-engagement">
          <div className="li-engagement__totals">
            <div className="li-engagement__stat">
              <span className="li-engagement__number">{totalReactions}</span>
              <span className="li-engagement__label">Reactions</span>
            </div>
            <div className="li-engagement__stat">
              <span className="li-engagement__number">{totalComments}</span>
              <span className="li-engagement__label">Comments</span>
            </div>
            <div className="li-engagement__stat">
              <span className="li-engagement__number">{totalEngagement}</span>
              <span className="li-engagement__label">Total</span>
            </div>
          </div>

          {engagementData.length > 0 && (
            <div className="li-engagement__bars">
              <div className="li-engagement__bars-label">Per-post engagement</div>
              {engagementData.slice(0, 10).map((e, i) => (
                <div key={i} className="li-engagement__bar-row" title={`${e.total_engagement || 0} total`}>
                  <span className="li-engagement__bar-idx">{i + 1}</span>
                  <MiniBar value={e.total_engagement || 0} max={maxEngagement} />
                  <span className="li-engagement__bar-val">{e.total_engagement || 0}</span>
                </div>
              ))}
            </div>
          )}

          {topPost && (topEng?.total_engagement || 0) > 0 && (
            <div className="li-engagement__top">
              <div className="li-engagement__top-label">Top Performing Post</div>
              <div className="li-engagement__top-text">
                {(topPost.text || topPost.commentary || '').slice(0, 120)}
                {(topPost.text || topPost.commentary || '').length > 120 ? '...' : ''}
              </div>
              <div className="li-engagement__top-stats">
                {topEng.reactions} reactions, {topEng.comments} comments
              </div>
            </div>
          )}

          {posts.length === 0 && (
            <div className="li-empty">
              <p>No engagement data yet. Publish posts to see metrics here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
