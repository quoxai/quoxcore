/**
 * CommentPanel — Recent comments with reply and moderation.
 *
 * Props: { comments, loading, error, onReply, onModerate, onRefresh }
 */

import { useState } from 'react'

function relativeTime(dateStr) {
  if (!dateStr) return ''
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function CommentCard({ comment, onReply, onModerate }) {
  const [expanded, setExpanded] = useState(false)
  const [replying, setReplying] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [moderateOpen, setModerateOpen] = useState(false)

  const handleSendReply = () => {
    if (!replyText.trim()) return
    onReply(comment.id, replyText.trim())
    setReplyText('')
    setReplying(false)
  }

  const handleModerate = (status) => {
    onModerate(comment.id, status)
    setModerateOpen(false)
  }

  return (
    <div className="yt-comment-card">
      <div className="yt-comment-card__header">
        <span className="yt-comment-card__author">{comment.authorName || 'Unknown'}</span>
        <span className="yt-comment-card__date">{relativeTime(comment.publishedAt)}</span>
      </div>

      <div
        className={`yt-comment-card__text ${expanded ? 'yt-comment-card__text--expanded' : ''}`}
        onClick={() => setExpanded(e => !e)}
      >
        {comment.text || ''}
      </div>

      <div className="yt-comment-card__meta">
        <span className="yt-comment-card__badge" title="Likes">
          {'\u2764'} {comment.likeCount || 0}
        </span>
        {(comment.replyCount || 0) > 0 && (
          <span className="yt-comment-card__badge" title="Replies">
            {'\u{1F4AC}'} {comment.replyCount}
          </span>
        )}

        <div className="yt-comment-card__actions">
          <button
            className="yt-comment-card__action-btn"
            onClick={() => setReplying(r => !r)}
          >
            {'\u21A9'} Reply
          </button>

          <div className="yt-comment-card__moderate-wrap">
            <button
              className="yt-comment-card__action-btn"
              onClick={() => setModerateOpen(m => !m)}
            >
              {'\u2699'} Moderate
            </button>
            {moderateOpen && (
              <div className="yt-comment-card__moderate-dropdown">
                <button onClick={() => handleModerate('published')}>Published</button>
                <button onClick={() => handleModerate('heldForReview')}>Held</button>
                <button onClick={() => handleModerate('rejected')}>Rejected</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Inline reply form */}
      {replying && (
        <div className="yt-comment-reply">
          <textarea
            className="yt-comment-reply__textarea"
            placeholder="Write a reply..."
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            rows={2}
          />
          <div className="yt-comment-reply__buttons">
            <button
              className="yt-comment-reply__cancel"
              onClick={() => { setReplying(false); setReplyText('') }}
            >
              Cancel
            </button>
            <button
              className="yt-comment-reply__send"
              onClick={handleSendReply}
              disabled={!replyText.trim()}
            >
              {'\u27A4'} Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function CommentPanel({ comments, loading, error, onReply, onModerate, onRefresh }) {
  // Loading skeleton
  if (loading) {
    return (
      <div className="yt-panel yt-comments">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4AC}'}</span> Comments
          </h3>
        </div>
        <div className="yt-panel__body">
          {[1, 2, 3].map(i => (
            <div key={i} className="yt-skeleton yt-skeleton--card" />
          ))}
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="yt-panel yt-comments">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4AC}'}</span> Comments
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

  const list = comments || []

  // Empty state
  if (list.length === 0) {
    return (
      <div className="yt-panel yt-comments">
        <div className="yt-panel__header">
          <h3 className="yt-panel__title">
            <span style={{ fontSize: 16 }}>{'\u{1F4AC}'}</span> Comments
            <span className="yt-panel__count">(0)</span>
          </h3>
        </div>
        <div className="yt-panel__body yt-panel__body--center">
          <div className="yt-empty">
            <p>No comments yet on your recent videos.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="yt-panel yt-comments">
      <div className="yt-panel__header">
        <h3 className="yt-panel__title">
          <span style={{ fontSize: 16 }}>{'\u{1F4AC}'}</span> Comments
          <span className="yt-panel__count">({list.length})</span>
        </h3>
        <button className="yt-panel__action" onClick={onRefresh} title="Refresh comments">
          {'\u21BB'}
        </button>
      </div>
      <div className="yt-panel__body yt-panel__body--scroll">
        {list.map((comment, i) => (
          <CommentCard
            key={comment.id || i}
            comment={comment}
            onReply={onReply}
            onModerate={onModerate}
          />
        ))}
      </div>
    </div>
  )
}
