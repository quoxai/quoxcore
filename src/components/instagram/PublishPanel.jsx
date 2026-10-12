/**
 * PublishPanel — caption + media URL + IMAGE/VIDEO/REEL selector, publish.
 * IG-3, mirrors src/components/facebook/ComposePanel.jsx.
 *
 * Honest boundary stated inline: single image/video/reel by public https
 * URL only. No carousel (multi-item) posts and no Stories in v1.
 */

import { useState, useCallback } from 'react'
import './instagram.css'

const MAX_CHARS = 2200

export default function PublishPanel({ igUserId, onPublish }) {
  const [caption, setCaption] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaType, setMediaType] = useState('IMAGE')
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const charCount = caption.length
  const overLimit = charCount > MAX_CHARS
  const canPublish = mediaUrl.trim().length > 0 && !!igUserId && !overLimit && !publishing && /^https:\/\//i.test(mediaUrl.trim())

  const handlePublish = useCallback(async () => {
    if (!canPublish) return
    setPublishing(true)
    setError(null)
    setResult(null)

    try {
      // Publishing is HITL-gated: this files an approval card and returns
      // { pending: true, inboxItemId }. Nothing publishes until a human
      // approves. The container create -> poll -> media_publish flow runs
      // server-side only after approval.
      const args = { igUserId, caption: caption.trim() || undefined, mediaType: mediaType === 'REEL' ? 'REELS' : mediaType }
      if (mediaType === 'IMAGE') args.imageUrl = mediaUrl.trim()
      else args.videoUrl = mediaUrl.trim()

      const res = await onPublish(args)
      setResult(res)
      if (res?.pending) {
        setCaption('')
        setMediaUrl('')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPublishing(false)
    }
  }, [canPublish, igUserId, caption, mediaUrl, mediaType, onPublish])

  return (
    <div className="ig-panel">
      <div className="ig-panel__header">
        <h3 className="ig-panel__title">{'\u{1F4F7}'} Publish</h3>
      </div>
      <div className="ig-panel__body">
        <div className="ig-compose">
          <div className="ig-compose__option">
            <label className="ig-compose__label">Media type</label>
            <div className="ig-media-type-toggle">
              {['IMAGE', 'VIDEO', 'REEL'].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`ig-media-type-toggle__option ${mediaType === t ? 'ig-media-type-toggle__option--active' : ''}`}
                  onClick={() => setMediaType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="ig-compose__option">
            <label className="ig-compose__label">Media URL (public https, required)</label>
            <input
              className="ig-compose__input"
              type="url"
              value={mediaUrl}
              onChange={e => setMediaUrl(e.target.value)}
              placeholder={mediaType === 'IMAGE' ? 'https://.../photo.jpg' : 'https://.../video.mp4'}
            />
          </div>

          <textarea
            className="ig-compose__textarea"
            value={caption}
            onChange={e => setCaption(e.target.value)}
            placeholder="Write a caption..."
            rows={4}
          />

          <div className="ig-compose__meta-row">
            <span className={`ig-compose__char-count ${overLimit ? 'ig-compose__char-count--over' : ''}`}>
              {charCount} / {MAX_CHARS}
            </span>
          </div>

          {mediaUrl.trim() && (
            <div className="ig-compose__preview">
              <div className="ig-compose__preview-label">Preview</div>
              <div className="ig-compose__preview-text">{caption || '(no caption)'}</div>
              <div className="ig-compose__preview-meta">
                {mediaType} · {mediaUrl}
              </div>
            </div>
          )}

          <button
            className="ig-compose__publish"
            onClick={handlePublish}
            disabled={!canPublish}
          >
            {publishing ? 'Filing for approval...' : 'Publish to Instagram'}
          </button>

          {result?.pending && (
            <div className="ig-compose__result ig-compose__result--success">
              Filed for approval{result.inboxItemId ? <> - inbox item <code>{result.inboxItemId}</code></> : null}.
              Nothing publishes until an approver says yes in HITL Inbox.
            </div>
          )}

          {result && !result.pending && (
            <div className="ig-compose__result ig-compose__result--success">
              Media published successfully.
            </div>
          )}

          {error && (
            <div className="ig-compose__result ig-compose__result--error">
              {error}
            </div>
          )}

          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', margin: 0 }}>
            Single image, video, or reel only. No carousel (multi-item) posts and no Stories
            in this plugin yet. The media URL must be publicly reachable over https so Meta
            can fetch it server-side.
          </p>
        </div>
      </div>
    </div>
  )
}
