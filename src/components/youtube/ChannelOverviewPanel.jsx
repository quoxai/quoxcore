/**
 * ChannelOverviewPanel — YouTube channel stats grid.
 *
 * Shows channel name, thumbnail, subscriber count, video count, total views.
 * Handles loading skeleton, error state with vault CTA.
 */

import './youtube.css'

function formatCount(num) {
  if (num == null) return '0'
  const n = Number(num)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function ChannelOverviewPanel({ channel, loading, error, onRefresh }) {
  if (loading) {
    return (
      <div className="yt-panel">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">{'\u25B6'} Channel</h3>
        </div>
        <div className="yt-panel__body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div className="yt-skeleton" style={{ width: 48, height: 48, borderRadius: '50%' }} />
            <div className="yt-skeleton yt-skeleton--header" />
          </div>
          <div className="yt-stats-grid">
            <div className="yt-skeleton yt-skeleton--stat" />
            <div className="yt-skeleton yt-skeleton--stat" />
            <div className="yt-skeleton yt-skeleton--stat" />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="yt-panel">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">{'\u25B6'} Channel</h3>
          <button className="yt-panel__action" onClick={onRefresh} title="Retry">
            {'\u21BB'}
          </button>
        </div>
        <div className="yt-panel__body yt-panel__body--center">
          <div className="yt-error-cta">
            <p className="yt-error-cta__text">{error}</p>
            <button className="yt-error-cta__btn" onClick={onRefresh}>
              {'\u{1F511}'} Check Vault credentials
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="yt-panel">
      <div className="yt-panel__header">
        <h3 className="yt-panel__title">{'\u25B6'} Channel</h3>
        <button className="yt-panel__action" onClick={onRefresh} title="Refresh">
          {'\u21BB'}
        </button>
      </div>
      <div className="yt-panel__body">
        {/* Channel header */}
        <div className="yt-channel-header">
          {channel?.thumbnail ? (
            <img
              className="yt-channel-header__thumb"
              src={channel.thumbnail}
              alt={channel.title || 'Channel'}
            />
          ) : (
            <div className="yt-channel-header__thumb-placeholder">
              {'\u25B6'}
            </div>
          )}
          <div>
            <h4 className="yt-channel-header__name">{channel?.title || 'Your Channel'}</h4>
            {channel?.customUrl && (
              <p className="yt-channel-header__sub">{channel.customUrl}</p>
            )}
          </div>
        </div>

        {/* Stats grid */}
        <div className="yt-stats-grid">
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">
              {formatCount(channel?.subscriberCount)}
            </span>
            <span className="yt-stats-grid__label">Subscribers</span>
          </div>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">
              {formatCount(channel?.videoCount)}
            </span>
            <span className="yt-stats-grid__label">Videos</span>
          </div>
          <div className="yt-stats-grid__item">
            <span className="yt-stats-grid__number">
              {formatCount(channel?.viewCount)}
            </span>
            <span className="yt-stats-grid__label">Total Views</span>
          </div>
        </div>
      </div>
    </div>
  )
}
