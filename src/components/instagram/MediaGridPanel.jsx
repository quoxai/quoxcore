/**
 * MediaGridPanel — recent Instagram media grid with thumbnails
 * (media_url/permalink), IG-3. Mirrors the shape of
 * src/components/facebook/ContentFeedPanel.jsx but as a thumbnail grid,
 * since Instagram's surface is visual media rather than text posts.
 */

import { useState } from 'react'
import './instagram.css'

function MediaTile({ item, onExpand }) {
  const isVideo = item.media_type === 'VIDEO' || item.media_type === 'REELS'
  return (
    <div className="ig-media-tile" onClick={() => onExpand?.(item)}>
      {item.media_url ? (
        isVideo
          ? <video src={item.media_url} muted />
          : <img src={item.media_url} alt={item.caption || 'Instagram media'} loading="lazy" />
      ) : (
        <div className="ig-media-tile__no-image">No preview</div>
      )}
      {item.media_type && <span className="ig-media-tile__badge">{item.media_type}</span>}
      <div className="ig-media-tile__stats">
        {item.likes != null && <span title="Likes">{'\u{2764}'} {item.likes}</span>}
        {item.comments != null && <span title="Comments">{'\u{1F4AC}'} {item.comments}</span>}
      </div>
    </div>
  )
}

export default function MediaGridPanel({ media = [], loading }) {
  const [expanded, setExpanded] = useState(null)

  if (loading) {
    return (
      <div className="ig-panel">
        <div className="ig-panel__header">
          <h3 className="ig-panel__title">{'\u{1F4F8}'} Recent Media</h3>
        </div>
        <div className="ig-panel__body ig-panel__body--center">
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>Loading media...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ig-panel">
      <div className="ig-panel__header">
        <h3 className="ig-panel__title">{'\u{1F4F8}'} Recent Media</h3>
        <span className="ig-panel__count">{media.length} items</span>
      </div>
      <div className="ig-panel__body ig-panel__body--scroll">
        {media.length === 0 ? (
          <div className="ig-empty">
            <p>No media found. Publish your first post using the Publish tab or chat with the Instagram agent.</p>
          </div>
        ) : (
          <div className="ig-media-grid">
            {media.map((item, i) => (
              <MediaTile key={item.id || i} item={item} onExpand={setExpanded} />
            ))}
          </div>
        )}
      </div>

      {expanded && (
        <div className="ig-modal-overlay" onClick={() => setExpanded(null)}>
          <div className="ig-modal" onClick={e => e.stopPropagation()}>
            <div className="ig-modal__header">
              <h4>Media Detail</h4>
              <button className="ig-modal__close" onClick={() => setExpanded(null)}>{'✕'}</button>
            </div>
            <div className="ig-modal__body">
              {expanded.media_url && (
                expanded.media_type === 'VIDEO' || expanded.media_type === 'REELS'
                  ? <video src={expanded.media_url} controls style={{ width: '100%', borderRadius: 8, marginBottom: 12 }} />
                  : <img src={expanded.media_url} alt="" style={{ width: '100%', borderRadius: 8, marginBottom: 12 }} />
              )}
              <p className="ig-modal__text">{expanded.caption || '(no caption)'}</p>
              <div className="ig-modal__meta">
                <span>Posted: {expanded.timestamp ? new Date(expanded.timestamp).toLocaleString() : 'Unknown'}</span>
                {expanded.permalink && (
                  <a href={expanded.permalink} target="_blank" rel="noopener noreferrer">View on Instagram</a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
