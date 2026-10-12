/**
 * ContentFeedPanel — chronological post list with engagement summary.
 */

import { useState } from 'react'
import './linkedin.css'

function PostCard({ post, engagement, onExpand }) {
  const eng = engagement || {}
  const reactions = eng.reactions || 0
  const comments = eng.comments || 0

  return (
    <div className="li-post-card" onClick={() => onExpand?.(post)}>
      <div className="li-post-card__text">
        {post.text || post.commentary || '(No text)'}
      </div>
      <div className="li-post-card__meta">
        <span className="li-post-card__date">
          {post.created_at ? new Date(post.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
        </span>
        <span className="li-post-card__engagement">
          {reactions > 0 && <span title="Reactions">{'\u{1F44D}'} {reactions}</span>}
          {comments > 0 && <span title="Comments">{'\u{1F4AC}'} {comments}</span>}
        </span>
        {post.has_media && <span className="li-post-card__badge">IMG</span>}
        {post.has_article && <span className="li-post-card__badge">LINK</span>}
      </div>
    </div>
  )
}

export default function ContentFeedPanel({ posts, engagement, loading }) {
  const [expandedPost, setExpandedPost] = useState(null)

  if (loading) {
    return (
      <div className="li-panel">
        <div className="li-panel__header">
          <h3 className="li-panel__title">
            {'\u{1F4F0}'} Content Feed
          </h3>
        </div>
        <div className="li-panel__body li-panel__body--center">
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>Loading posts...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="li-panel">
      <div className="li-panel__header">
        <h3 className="li-panel__title">
          {'\u{1F4F0}'} Content Feed
        </h3>
        <span className="li-panel__count">{posts.length} posts</span>
      </div>
      <div className="li-panel__body li-panel__body--scroll">
        {posts.length === 0 ? (
          <div className="li-empty">
            <p>No posts found. Publish your first post using the compose panel or chat with the LinkedIn agent.</p>
          </div>
        ) : (
          posts.map((post, i) => (
            <PostCard
              key={post.id || i}
              post={post}
              engagement={engagement[post.id]}
              onExpand={setExpandedPost}
            />
          ))
        )}
      </div>

      {expandedPost && (
        <div className="li-modal-overlay" onClick={() => setExpandedPost(null)}>
          <div className="li-modal" onClick={e => e.stopPropagation()}>
            <div className="li-modal__header">
              <h4>Post Detail</h4>
              <button className="li-modal__close" onClick={() => setExpandedPost(null)}>{'\u2715'}</button>
            </div>
            <div className="li-modal__body">
              <p className="li-modal__text">{expandedPost.text || expandedPost.commentary}</p>
              <div className="li-modal__meta">
                <span>Visibility: {expandedPost.visibility || 'PUBLIC'}</span>
                <span>Created: {expandedPost.created_at ? new Date(expandedPost.created_at).toLocaleString() : 'Unknown'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
