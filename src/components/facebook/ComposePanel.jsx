/**
 * ComposePanel — message editor, optional link, optional image URL, publish.
 * FB-3, mirrors src/components/linkedin/ComposePanel.jsx.
 */

import { useState, useCallback } from 'react'
import './facebook.css'

const MAX_CHARS = 5000

export default function ComposePanel({ defaultPageId, onPublish }) {
  const [pageId, setPageId] = useState(defaultPageId || '')
  const [message, setMessage] = useState('')
  const [link, setLink] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const charCount = message.length
  const overLimit = charCount > MAX_CHARS
  const canPublish = message.trim().length > 0 && pageId.trim().length > 0 && !overLimit && !publishing

  const handlePublish = useCallback(async () => {
    if (!canPublish) return
    setPublishing(true)
    setError(null)
    setResult(null)

    try {
      // Publishing is HITL-gated: this files an approval card and returns
      // { pending: true, inboxItemId }. Nothing posts until a human approves.
      const res = await onPublish({
        pageId: pageId.trim(),
        message: message.trim(),
        link: link.trim() || undefined,
        imageUrl: imageUrl.trim() || undefined,
      })
      setResult(res)
      if (res?.pending) {
        setMessage('')
        setLink('')
        setImageUrl('')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPublishing(false)
    }
  }, [canPublish, pageId, message, link, imageUrl, onPublish])

  return (
    <div className="fb-panel">
      <div className="fb-panel__header">
        <h3 className="fb-panel__title">
          {'✍'} Compose
        </h3>
      </div>
      <div className="fb-panel__body">
        <div className="fb-compose">
          <div className="fb-compose__option">
            <label className="fb-compose__label">Page ID</label>
            <input
              className="fb-compose__input"
              type="text"
              value={pageId}
              onChange={e => setPageId(e.target.value)}
              placeholder="e.g. 1234567890"
            />
          </div>

          <textarea
            className="fb-compose__textarea"
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Write your Facebook Page post..."
            rows={5}
          />

          <div className="fb-compose__meta-row">
            <span className={`fb-compose__char-count ${overLimit ? 'fb-compose__char-count--over' : ''}`}>
              {charCount} / {MAX_CHARS}
            </span>
          </div>

          <div className="fb-compose__option">
            <label className="fb-compose__label">Link URL (optional)</label>
            <input
              className="fb-compose__input"
              type="url"
              value={link}
              onChange={e => setLink(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="fb-compose__option">
            <label className="fb-compose__label">Image URL (optional, https)</label>
            <input
              className="fb-compose__input"
              type="url"
              value={imageUrl}
              onChange={e => setImageUrl(e.target.value)}
              placeholder="https://.../image.png"
            />
          </div>

          {message.trim() && (
            <div className="fb-compose__preview">
              <div className="fb-compose__preview-label">Preview</div>
              <div className="fb-compose__preview-text">{message}</div>
              <div className="fb-compose__preview-meta">
                Page {pageId || 'unset'}
                {link && ` · ${link}`}
                {imageUrl && ' · image attached'}
              </div>
            </div>
          )}

          <button
            className="fb-compose__publish"
            onClick={handlePublish}
            disabled={!canPublish}
          >
            {publishing ? 'Filing for approval...' : 'Publish to Facebook'}
          </button>

          {result?.pending && (
            <div className="fb-compose__result fb-compose__result--success">
              Filed for approval{result.inboxItemId ? <> - inbox item <code>{result.inboxItemId}</code></> : null}.
              Nothing publishes until an approver says yes in HITL Inbox.
            </div>
          )}

          {result && !result.pending && (
            <div className="fb-compose__result fb-compose__result--success">
              Post published successfully.
            </div>
          )}

          {error && (
            <div className="fb-compose__result fb-compose__result--error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
