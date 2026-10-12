/**
 * UploadPanel — Video metadata editor and upload trigger.
 *
 * Title, description, tags, privacy, category, file path inputs.
 * Preview section showing metadata summary.
 * Upload button (disabled if no title or file path).
 */

import { useState, useCallback } from 'react'
import './youtube.css'

const YOUTUBE_CATEGORIES = [
  { id: '1', name: 'Film & Animation' },
  { id: '2', name: 'Autos & Vehicles' },
  { id: '10', name: 'Music' },
  { id: '15', name: 'Pets & Animals' },
  { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
  { id: '20', name: 'Gaming' },
  { id: '22', name: 'People & Blogs' },
  { id: '23', name: 'Comedy' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' },
  { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' },
  { id: '29', name: 'Nonprofits & Activism' },
]

const TITLE_MAX = 100
const DESC_MAX = 5000

export default function UploadPanel({ onUpload, defaultPrivacy, defaultCategory, uploading }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [privacy, setPrivacy] = useState(defaultPrivacy || 'private')
  const [category, setCategory] = useState(defaultCategory || '28')
  const [filePath, setFilePath] = useState('')
  const [status, setStatus] = useState(null) // { type: 'success'|'error'|'uploading', message }

  const canUpload = title.trim().length > 0 && filePath.trim().length > 0 && !uploading

  const handleUpload = useCallback(async () => {
    if (!canUpload || !onUpload) return
    setStatus({ type: 'uploading', message: 'Uploading video...' })

    try {
      const tagList = tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)

      const result = await onUpload({
        title: title.trim(),
        description: description.trim(),
        tags: tagList,
        privacyStatus: privacy,
        categoryId: category,
        filePath: filePath.trim(),
      })

      setStatus({ type: 'success', message: `Video uploaded successfully${result?.videoId ? ` (ID: ${result.videoId})` : ''}` })
      // Reset form
      setTitle('')
      setDescription('')
      setTags('')
      setFilePath('')
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Upload failed' })
    }
  }, [canUpload, title, description, tags, privacy, category, filePath, onUpload])

  const getCategoryName = (id) => {
    const cat = YOUTUBE_CATEGORIES.find(c => c.id === id)
    return cat ? cat.name : id
  }

  return (
    <div className="yt-panel">
      <div className="yt-panel__header">
        <h3 className="yt-panel__title">{'\u2B06'} Upload</h3>
      </div>
      <div className="yt-panel__body yt-panel__body--scroll">
        <div className="yt-upload">
          {/* Title */}
          <div className="yt-upload__field">
            <label className="yt-upload__label">Title *</label>
            <input
              className="yt-upload__input"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value.slice(0, TITLE_MAX))}
              placeholder="Video title"
              maxLength={TITLE_MAX}
            />
            <span className={`yt-upload__char-count ${title.length >= TITLE_MAX ? 'yt-upload__char-count--over' : ''}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </div>

          {/* Description */}
          <div className="yt-upload__field">
            <label className="yt-upload__label">Description</label>
            <textarea
              className="yt-upload__textarea"
              value={description}
              onChange={e => setDescription(e.target.value.slice(0, DESC_MAX))}
              placeholder="Video description"
              maxLength={DESC_MAX}
            />
            <span className={`yt-upload__char-count ${description.length >= DESC_MAX ? 'yt-upload__char-count--over' : ''}`}>
              {description.length}/{DESC_MAX}
            </span>
          </div>

          {/* Tags */}
          <div className="yt-upload__field">
            <label className="yt-upload__label">Tags</label>
            <input
              className="yt-upload__input"
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="tag1, tag2, tag3"
            />
          </div>

          {/* Privacy + Category row */}
          <div className="yt-upload__row">
            <div className="yt-upload__field">
              <label className="yt-upload__label">Privacy</label>
              <select
                className="yt-upload__select"
                value={privacy}
                onChange={e => setPrivacy(e.target.value)}
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
            <div className="yt-upload__field">
              <label className="yt-upload__label">Category</label>
              <select
                className="yt-upload__select"
                value={category}
                onChange={e => setCategory(e.target.value)}
              >
                {YOUTUBE_CATEGORIES.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* File Path */}
          <div className="yt-upload__field">
            <label className="yt-upload__label">File Path *</label>
            <input
              className="yt-upload__input"
              type="text"
              value={filePath}
              onChange={e => setFilePath(e.target.value)}
              placeholder="/path/to/video.mp4"
            />
          </div>

          {/* Preview */}
          {(title.trim() || description.trim()) && (
            <div className="yt-upload__preview">
              <div className="yt-upload__preview-label">Preview</div>
              {title.trim() && (
                <p className="yt-upload__preview-title">{title.trim()}</p>
              )}
              {description.trim() && (
                <p className="yt-upload__preview-desc">{description.trim()}</p>
              )}
              <p className="yt-upload__preview-meta">
                {privacy} {'\u00B7'} {getCategoryName(category)}
                {tags.trim() && ` \u00B7 ${tags.split(',').filter(t => t.trim()).length} tags`}
              </p>
            </div>
          )}

          {/* Upload button */}
          <button
            className="yt-upload__submit"
            onClick={handleUpload}
            disabled={!canUpload}
          >
            {uploading ? 'Uploading...' : '\u2B06 Upload Video'}
          </button>

          {/* Status */}
          {status && (
            <div className={`yt-upload__status yt-upload__status--${status.type}`}>
              {status.message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
