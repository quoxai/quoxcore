/**
 * ContentFeedPanel — recent Page posts with engagement counts. FB-3,
 * mirrors src/components/linkedin/ContentFeedPanel.jsx.
 */

import { useState } from 'react'
import './facebook.css'

function PostCard({ post, onExpand }) {
  return (
    <div className="fb-post-card" onClick={() => onExpand?.(post)}>
      <div className="fb-post-card__text">
        {post.message || '(No text)'}
      </div>
      <div className="fb-post-card__meta">
        <span className="fb-post-card__date">
          {post.created_time ? new Date(post.created_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
        </span>
        <span className="fb-post-card__engagement">
          {post.likes > 0 && <span title="Likes">{'\u{1F44D}'} {post.likes}</span>}
          {post.comments > 0 && <span title="Comments">{'\u{1F4AC}'} {post.comments}</span>}
          {post.shares > 0 && <span title="Shares">{'\u{1F501}'} {post.shares}</span>}
        </span>
      </div>
    </div>
  )
}

export default function ContentFeedPanel({ posts, loading }) {
  const [expandedPost, setExpandedPost] = useState(null)

  if (loading) {
    return (
      <div className="fb-panel">
        <div className="fb-panel__header">
          <h3 className="fb-panel__title">
            {'\u{1F4F0}'} Recent Posts
          </h3>
        </div>
        <div className="fb-panel__body fb-panel__body--center">
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>Loading posts...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="fb-panel">
      <div className="fb-panel__header">
        <h3 className="fb-panel__title">
          {'\u{1F4F0}'} Recent Posts
        </h3>
        <span className="fb-panel__count">{posts.length} posts</span>
      </div>
      <div className="fb-panel__body fb-panel__body--scroll">
        {posts.length === 0 ? (
          <div className="fb-empty">
            <p>No posts found. Publish your first post using the compose panel or chat with the Facebook agent.</p>
          </div>
        ) : (
          posts.map((post, i) => (
            <PostCard
              key={post.id || i}
              post={post}
              onExpand={setExpandedPost}
            />
          ))
        )}
      </div>

      {expandedPost && (
        <div className="fb-modal-overlay" onClick={() => setExpandedPost(null)}>
          <div className="fb-modal" onClick={e => e.stopPropagation()}>
            <div className="fb-modal__header">
              <h4>Post Detail</h4>
              <button className="fb-modal__close" onClick={() => setExpandedPost(null)}>{'✕'}</button>
            </div>
            <div className="fb-modal__body">
              <p className="fb-modal__text">{expandedPost.message}</p>
              <div className="fb-modal__meta">
                <span>Created: {expandedPost.created_time ? new Date(expandedPost.created_time).toLocaleString() : 'Unknown'}</span>
                {expandedPost.permalink_url && (
                  <a href={expandedPost.permalink_url} target="_blank" rel="noopener noreferrer">View on Facebook</a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
