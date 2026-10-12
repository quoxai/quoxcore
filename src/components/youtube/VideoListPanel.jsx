/**
 * VideoListPanel — Recent videos in a scrollable list.
 *
 * Each video card shows thumbnail, title, published date, view count, privacy badge.
 * Click to select (calls onSelectVideo with video object).
 */

import { useState } from 'react'
import './youtube.css'

function formatDate(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}

function formatViews(count) {
  if (count == null) return '0 views'
  const n = Number(count)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`
  return `${n.toLocaleString()} views`
}

function privacyClass(status) {
  if (status === 'public') return 'yt-video-card__badge--public'
  if (status === 'unlisted') return 'yt-video-card__badge--unlisted'
  return 'yt-video-card__badge--private'
}

export default function VideoListPanel({ videos, loading, error, onSelectVideo, onRefresh }) {
  const [selectedId, setSelectedId] = useState(null)

  const handleSelect = (video) => {
    setSelectedId(video.id)
    if (onSelectVideo) onSelectVideo(video)
  }

  if (loading) {
    return (
      <div className="yt-panel" style={{ flex: 1 }}>
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">{'\u{1F3AC}'} Videos</h3>
        </div>
        <div className="yt-panel__body yt-panel__body--scroll">
          <div className="yt-skeleton yt-skeleton--card" />
          <div className="yt-skeleton yt-skeleton--card" />
          <div className="yt-skeleton yt-skeleton--card" />
          <div className="yt-skeleton yt-skeleton--card" />
        </div>
      </div>
    )
  }

  return (
    <div className="yt-panel" style={{ flex: 1 }}>
      <div className="yt-panel__header">
        <h3 className="yt-panel__title">
          {'\u{1F3AC}'} Videos
          {videos && videos.length > 0 && (
            <span className="yt-panel__count">({videos.length})</span>
          )}
        </h3>
        <button className="yt-panel__action" onClick={onRefresh} title="Refresh">
          {'\u21BB'}
        </button>
      </div>
      <div className="yt-panel__body yt-panel__body--scroll">
        {error && (
          <div className="yt-error-cta" style={{ marginBottom: 12 }}>
            <p className="yt-error-cta__text">{error}</p>
          </div>
        )}

        {(!videos || videos.length === 0) && !error && (
          <div className="yt-empty">
            <p>No videos yet</p>
          </div>
        )}

        {videos && videos.map((video) => (
          <div
            key={video.id}
            className={`yt-video-card ${selectedId === video.id ? 'yt-video-card--selected' : ''}`}
            onClick={() => handleSelect(video)}
          >
            {video.thumbnail ? (
              <img
                className="yt-video-card__thumb"
                src={video.thumbnail}
                alt={video.title || 'Video'}
              />
            ) : (
              <div className="yt-video-card__thumb-placeholder">
                {'\u25B6'}
              </div>
            )}
            <div className="yt-video-card__info">
              <p className="yt-video-card__title">{video.title || 'Untitled'}</p>
              <div className="yt-video-card__meta">
                <span>{formatDate(video.publishedAt)}</span>
                <span className="yt-video-card__views">
                  {'\u{1F441}'} {formatViews(video.viewCount)}
                </span>
                {video.privacyStatus && (
                  <span className={`yt-video-card__badge ${privacyClass(video.privacyStatus)}`}>
                    {video.privacyStatus}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
