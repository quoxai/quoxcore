/**
 * VideoGridPanel — recent TikTok videos grid with cover thumbnails and
 * view/like/comment/share counts. TT-4, mirrors
 * src/components/instagram/MediaGridPanel.jsx.
 */

import { useState } from 'react'
import './tiktok.css'

function VideoTile({ item, onExpand }) {
  return (
    <div className="tt-media-tile" onClick={() => onExpand?.(item)}>
      {item.cover_image_url ? (
        <img src={item.cover_image_url} alt={item.title || 'TikTok video'} loading="lazy" />
      ) : (
        <div className="tt-media-tile__no-image">No preview</div>
      )}
      <div className="tt-media-tile__stats">
        {item.views != null && <span title="Views">{'\u{1F441}'} {item.views}</span>}
        {item.likes != null && <span title="Likes">{'\u{2764}'} {item.likes}</span>}
      </div>
    </div>
  )
}

export default function VideoGridPanel({ videos = [], loading }) {
  const [expanded, setExpanded] = useState(null)

  if (loading) {
    return (
      <div className="tt-panel">
        <div className="tt-panel__header">
          <h3 className="tt-panel__title">{'\u{1F3AC}'} Recent Videos</h3>
        </div>
        <div className="tt-panel__body tt-panel__body--center">
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>Loading videos...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="tt-panel">
      <div className="tt-panel__header">
        <h3 className="tt-panel__title">{'\u{1F3AC}'} Recent Videos</h3>
        <span className="tt-panel__count">{videos.length} items</span>
      </div>
      <div className="tt-panel__body tt-panel__body--scroll">
        {videos.length === 0 ? (
          <div className="tt-empty">
            <p>No videos found. Publish your first video using the Publish tab or chat with the TikTok agent.</p>
          </div>
        ) : (
          <div className="tt-media-grid">
            {videos.map((item, i) => (
              <VideoTile key={item.id || i} item={item} onExpand={setExpanded} />
            ))}
          </div>
        )}
      </div>

      {expanded && (
        <div className="tt-modal-overlay" onClick={() => setExpanded(null)}>
          <div className="tt-modal" onClick={e => e.stopPropagation()}>
            <div className="tt-modal__header">
              <h4>Video Detail</h4>
              <button className="tt-modal__close" onClick={() => setExpanded(null)}>{'✕'}</button>
            </div>
            <div className="tt-modal__body">
              {expanded.cover_image_url && (
                <img src={expanded.cover_image_url} alt="" style={{ width: '100%', borderRadius: 8, marginBottom: 12 }} />
              )}
              <p className="tt-modal__text">{expanded.title || '(no title)'}</p>
              <div className="tt-modal__meta">
                <span>Posted: {expanded.create_time ? new Date(expanded.create_time * 1000).toLocaleString() : 'Unknown'}</span>
                {expanded.share_url && (
                  <a href={expanded.share_url} target="_blank" rel="noopener noreferrer">View on TikTok</a>
                )}
              </div>
              <div className="tt-modal__meta">
                <span>{'\u{1F441}'} {expanded.views ?? 0} views</span>
                <span>{'\u{2764}'} {expanded.likes ?? 0} likes</span>
                <span>{'\u{1F4AC}'} {expanded.comments ?? 0} comments</span>
                <span>{'\u{1F501}'} {expanded.shares ?? 0} shares</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
