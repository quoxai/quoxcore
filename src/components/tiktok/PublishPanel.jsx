/**
 * PublishPanel — title + org media-root file path + privacy selector +
 * duet/comment/stitch toggles, plus a separate "Upload as draft" action.
 * TT-4, mirrors src/components/instagram/PublishPanel.jsx.
 *
 * Two hard truths stated inline: an unaudited TikTok app is restricted to
 * private (SELF_ONLY) viewing regardless of the requested privacy_level,
 * until TikTok approves the app audit; and the video must already sit under
 * the org's TikTok media root (no URLs, no local browser upload in v1).
 */

import { useState, useCallback } from 'react'
import './tiktok.css'

const PRIVACY_LEVELS = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE']

export default function PublishPanel({ onPublish, onUploadDraft }) {
  const [title, setTitle] = useState('')
  const [videoPath, setVideoPath] = useState('')
  const [privacyLevel, setPrivacyLevel] = useState('SELF_ONLY')
  const [disableDuet, setDisableDuet] = useState(false)
  const [disableComment, setDisableComment] = useState(false)
  const [disableStitch, setDisableStitch] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [uploadingDraft, setUploadingDraft] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const canSubmit = title.trim().length > 0 && videoPath.trim().length > 0 && !publishing && !uploadingDraft

  const handlePublish = useCallback(async () => {
    if (!canSubmit) return
    setPublishing(true)
    setError(null)
    setResult(null)
    try {
      // Publishing is HITL-gated: this files an approval card and returns
      // { pending: true, inboxItemId }. Nothing publishes until a human
      // approves.
      const res = await onPublish({
        title: title.trim(),
        videoPath: videoPath.trim(),
        privacyLevel,
        disableDuet,
        disableComment,
        disableStitch,
      })
      setResult({ ...res, kind: 'publish' })
      if (res?.pending) {
        setTitle('')
        setVideoPath('')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPublishing(false)
    }
  }, [canSubmit, title, videoPath, privacyLevel, disableDuet, disableComment, disableStitch, onPublish])

  const handleUploadDraft = useCallback(async () => {
    if (!videoPath.trim() || uploadingDraft || publishing) return
    setUploadingDraft(true)
    setError(null)
    setResult(null)
    try {
      const res = await onUploadDraft({ title: title.trim() || undefined, videoPath: videoPath.trim() })
      setResult({ ...res, kind: 'draft' })
      if (res?.pending) {
        setTitle('')
        setVideoPath('')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setUploadingDraft(false)
    }
  }, [videoPath, title, uploadingDraft, publishing, onUploadDraft])

  return (
    <div className="tt-panel">
      <div className="tt-panel__header">
        <h3 className="tt-panel__title">{'\u{1F4F9}'} Publish</h3>
      </div>
      <div className="tt-panel__body">
        <div className="tt-compose">
          <div className="tt-compose__option">
            <label className="tt-compose__label">Title / caption</label>
            <input
              className="tt-compose__input"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Video title"
            />
          </div>

          <div className="tt-compose__option">
            <label className="tt-compose__label">File path (relative to the org's TikTok media root)</label>
            <input
              className="tt-compose__input"
              type="text"
              value={videoPath}
              onChange={e => setVideoPath(e.target.value)}
              placeholder="clips/latest.mp4"
            />
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', margin: '4px 0 0' }}>
              The video must already exist under this org's TikTok media root. No arbitrary
              URLs and no local browser upload in this plugin yet.
            </p>
          </div>

          <div className="tt-compose__option">
            <label className="tt-compose__label">Privacy level</label>
            <div className="tt-media-type-toggle">
              {PRIVACY_LEVELS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`tt-media-type-toggle__option ${privacyLevel === p ? 'tt-media-type-toggle__option--active' : ''}`}
                  onClick={() => setPrivacyLevel(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            {privacyLevel !== 'SELF_ONLY' && (
              <p className="tt-audit-note">
                An unaudited TikTok app is restricted to private (SELF_ONLY) viewing regardless
                of this setting, until TikTok approves the app audit. Your requested privacy
                level is still sent exactly as chosen, never silently downgraded here; TikTok
                itself may override it until the audit clears.
              </p>
            )}
          </div>

          <div className="tt-compose__toggles">
            <label className="tt-toggle">
              <input type="checkbox" checked={disableDuet} onChange={e => setDisableDuet(e.target.checked)} />
              Disable duet
            </label>
            <label className="tt-toggle">
              <input type="checkbox" checked={disableComment} onChange={e => setDisableComment(e.target.checked)} />
              Disable comments
            </label>
            <label className="tt-toggle">
              <input type="checkbox" checked={disableStitch} onChange={e => setDisableStitch(e.target.checked)} />
              Disable stitch
            </label>
          </div>

          <div className="tt-compose__actions">
            <button
              className="tt-compose__publish"
              onClick={handlePublish}
              disabled={!canSubmit}
            >
              {publishing ? 'Filing for approval...' : 'Publish to TikTok'}
            </button>
            <button
              className="tt-compose__draft"
              onClick={handleUploadDraft}
              disabled={!videoPath.trim() || publishing || uploadingDraft}
            >
              {uploadingDraft ? 'Filing for approval...' : 'Upload as draft'}
            </button>
          </div>

          {result?.pending && (
            <div className="tt-compose__result tt-compose__result--success">
              Filed for approval{result.inboxItemId ? <> - inbox item <code>{result.inboxItemId}</code></> : null}.
              Nothing {result.kind === 'draft' ? 'uploads' : 'publishes'} until an approver says
              yes in HITL Inbox.
            </div>
          )}

          {result && !result.pending && (
            <div className="tt-compose__result tt-compose__result--success">
              {result.kind === 'draft' ? 'Draft uploaded successfully.' : 'Video published successfully.'}
            </div>
          )}

          {error && (
            <div className="tt-compose__result tt-compose__result--error">
              {error}
            </div>
          )}

          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', margin: 0 }}>
            "Upload as draft" sends the video to this account's TikTok inbox as a draft, which
            the user finishes and publishes manually from inside the TikTok app. It is the
            recommended path before your app audit clears.
          </p>
        </div>
      </div>
    </div>
  )
}
