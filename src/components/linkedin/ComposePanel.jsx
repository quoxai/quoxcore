/**
 * ComposePanel — text editor, image upload, post-as selector, preview, publish.
 */

import { useState, useCallback } from 'react'
import './linkedin.css'

const MAX_CHARS = 3000

export default function ComposePanel({ authorUrn, orgUrn, onPublish, onUploadMedia }) {
  const [text, setText] = useState('')
  const [postAs, setPostAs] = useState('member')
  const [visibility, setVisibility] = useState('PUBLIC')
  const [linkUrl, setLinkUrl] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const charCount = text.length
  const overLimit = charCount > MAX_CHARS
  const canPublish = text.trim().length > 0 && !overLimit && !publishing

  const targetUrn = postAs === 'org' && orgUrn ? orgUrn : authorUrn

  const handlePublish = useCallback(async () => {
    if (!canPublish || !targetUrn) return
    setPublishing(true)
    setError(null)
    setResult(null)

    try {
      // Image first (ungated asset upload), so the approval card carries the
      // finished media URN and the approver sees exactly what will publish.
      let mediaId
      if (imageUrl.trim()) {
        const media = await onUploadMedia({ owner: targetUrn, imageUrl: imageUrl.trim() })
        mediaId = media.image_urn
      }

      // Publishing is HITL-gated: this files an approval card and returns
      // { pending: true, inboxItemId }. Nothing posts until a human approves.
      const res = await onPublish({
        author: targetUrn,
        text: text.trim(),
        visibility,
        linkUrl: linkUrl.trim() || undefined,
        mediaId,
      })
      setResult(res)
      if (res?.pending) {
        setText('')
        setLinkUrl('')
        setImageUrl('')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPublishing(false)
    }
  }, [canPublish, targetUrn, text, visibility, linkUrl, imageUrl, onPublish, onUploadMedia])

  return (
    <div className="li-panel">
      <div className="li-panel__header">
        <h3 className="li-panel__title">
          {'\u270D'} Compose
        </h3>
      </div>
      <div className="li-panel__body">
        <div className="li-compose">
          <textarea
            className="li-compose__textarea"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Write your LinkedIn post..."
            rows={5}
          />

          <div className="li-compose__meta-row">
            <span className={`li-compose__char-count ${overLimit ? 'li-compose__char-count--over' : ''}`}>
              {charCount} / {MAX_CHARS}
            </span>
          </div>

          <div className="li-compose__options">
            <div className="li-compose__option">
              <label className="li-compose__label">Post as</label>
              <select
                className="li-compose__select"
                value={postAs}
                onChange={e => setPostAs(e.target.value)}
              >
                <option value="member">Member</option>
                {orgUrn && <option value="org">Organisation</option>}
              </select>
            </div>

            <div className="li-compose__option">
              <label className="li-compose__label">Visibility</label>
              <select
                className="li-compose__select"
                value={visibility}
                onChange={e => setVisibility(e.target.value)}
              >
                <option value="PUBLIC">Public</option>
                <option value="CONNECTIONS">Connections Only</option>
              </select>
            </div>
          </div>

          <div className="li-compose__option">
            <label className="li-compose__label">Link URL (optional)</label>
            <input
              className="li-compose__input"
              type="url"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="li-compose__option">
            <label className="li-compose__label">Image URL (optional, https, max 10MB)</label>
            <input
              className="li-compose__input"
              type="url"
              value={imageUrl}
              onChange={e => setImageUrl(e.target.value)}
              placeholder="https://.../image.png"
            />
          </div>

          {text.trim() && (
            <div className="li-compose__preview">
              <div className="li-compose__preview-label">Preview</div>
              <div className="li-compose__preview-text">{text}</div>
              <div className="li-compose__preview-meta">
                {postAs === 'org' ? 'Organisation' : 'Member'} · {visibility}
                {linkUrl && ` · ${linkUrl}`}
              </div>
            </div>
          )}

          <button
            className="li-compose__publish"
            onClick={handlePublish}
            disabled={!canPublish}
          >
            {publishing ? 'Filing for approval...' : 'Publish to LinkedIn'}
          </button>

          {result?.pending && (
            <div className="li-compose__result li-compose__result--success">
              Filed for approval{result.inboxItemId ? <> — inbox item <code>{result.inboxItemId}</code></> : null}.
              Nothing publishes until an approver says yes in HITL Inbox.
            </div>
          )}

          {result && !result.pending && (
            <div className="li-compose__result li-compose__result--success">
              Post published successfully.
            </div>
          )}

          {error && (
            <div className="li-compose__result li-compose__result--error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
