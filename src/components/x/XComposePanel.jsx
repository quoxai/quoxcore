/**
 * XComposePanel, draft a post or thread for HITL approval. X-PLUGIN P3.
 *
 * Drafting NEVER publishes: x_post/x_thread file an owner approval card and
 * return { status: 'awaiting_approval', inbox_item_id }. The panel renders
 * that state honestly, with the inbox item id and a link to /inbox.
 *
 * Image picker (rebuilt in phase 13): upload from this machine, or pick from
 * the org media library (GET /x/media for the listing, GET /x/media/file for
 * each thumbnail's bytes). File names are relative to the org media root,
 * which is exactly what x_post's image_paths expects.
 *
 * Composition from the global .qx-* classes plus the X-scoped .xs-* polish
 * layer in x-shine.css (imported once by XView).
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'

const MAX_CHARS = 280
const MAX_IMAGES = 4

/** The X mark, on the one button that reaches X. */
function XGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * One thumbnail. The bytes come from GET /x/media/file through authFetch (an
 * unauthenticated <img src> would 401), so the object URL is created here and
 * REVOKED on unmount: without that, a compose session leaks one blob per image
 * it has ever previewed.
 *
 * A load failure renders a labelled placeholder rather than a broken image
 * icon, because "this file would not load" is information the composer needs
 * before they attach it.
 */
function MediaThumb({ name, onLoadThumb, className = '', alt }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (typeof onLoadThumb !== 'function') return undefined
    let revoked = false
    let mine = null
    setFailed(false)
    setUrl(null)
    onLoadThumb(name)
      .then((objectUrl) => {
        if (revoked) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        mine = objectUrl
        setUrl(objectUrl)
      })
      .catch(() => { if (!revoked) setFailed(true) })
    return () => {
      revoked = true
      if (mine) URL.revokeObjectURL(mine)
    }
  }, [name, onLoadThumb])

  if (url) return <img className={className} src={url} alt={alt || name} />
  return (
    <span className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {failed
          ? <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
          : <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>}
      </svg>
    </span>
  )
}

function CharCount({ text }) {
  const left = MAX_CHARS - (text || '').length
  return (
    <span className={`qx-hint qx-hint--sm ${left < 0 ? 'qx-hint--danger' : ''}`}>
      {left} left
    </span>
  )
}

/** The types POST /x/media accepts. Stated on the control so a refusal is
 * never a surprise; the server sniffs the CONTENT and is the real authority.
 * Caps mirror the collector's per-type limits (phase 10 slice A): still
 * images 5MB, GIF 15MB, MP4 video 64MB by default. */
const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,video/mp4'
const MAX_UPLOAD_MB = 5
const TYPE_UPLOAD_CAPS_MB = { 'image/gif': 15, 'video/mp4': 64 }

/**
 * The image picker, rebuilt in X-PLUGIN phase 13 (owner item 4).
 *
 * WHAT WENT: a flat strip of buttons listing every file already in the org
 * media root. Owner: "recents were already posted so probably not useful". It
 * was also filenames only, so choosing between three uploads meant remembering
 * which was which.
 *
 * WHAT REPLACED IT: two named ways to get an image onto a post, upload from
 * this machine, or pick one out of the org media library, and the library is a
 * real browser with thumbnails, filenames and dates rather than a wall of
 * buttons. It stays CLOSED until asked for, so the common case (write, attach
 * nothing, send) is not buried under a grid.
 *
 * What is ATTACHED to this post is shown separately from what EXISTS in the
 * library, because those were the same list before and they are not the same
 * question.
 */
function ImagePicker({ files, selected, onToggle, onRefresh, onUpload, uploading, uploadError, onLoadThumb, altTexts, onAltText }) {
  const fileInputRef = useRef(null)
  const [libraryOpen, setLibraryOpen] = useState(false)

  const handleFiles = useCallback(async (fileList) => {
    const chosen = Array.from(fileList || [])
    if (!chosen.length) return
    for (const file of chosen) await onUpload(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [onUpload])

  const full = selected.length >= MAX_IMAGES

  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart qx-row--wrap">
        <span className="xs-panel-head">
          <span className="qx-section-title xs-title">Images</span>
          <span className="xs-badge">{selected.length} of {MAX_IMAGES} attached</span>
        </span>
        <div className="qx-row qx-row--tight qx-row--wrap">
          {/* Upload from this machine. Before phase 11 an image could only
              reach a post by being placed on the collector's filesystem out of
              band, which made this a feature only someone with a shell could
              use. */}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
            data-testid="x-image-upload-input"
          />
          <button
            type="button"
            className="qx-btn xs-btn qx-btn--sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            {uploading ? 'Uploading…' : 'Upload image'}
          </button>

          <button
            type="button"
            className="qx-btn xs-btn qx-btn--sm"
            aria-expanded={libraryOpen}
            onClick={() => setLibraryOpen((open) => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
            {libraryOpen ? 'Hide media library' : 'Choose from media library'}
          </button>

          {/* Generation slot. Deliberately inert and labelled as such: an
              affordance that looks live but does nothing is worse than one
              that says it is not ready. imagesQ owns multi-model generation
              and lands later. */}
          <button
            type="button"
            className="qx-btn xs-btn qx-btn--sm"
            disabled
            aria-disabled="true"
            title="Not available yet. Image generation arrives with imagesQ, which will offer several models including nanobanana. Until then, upload an image or attach one already in the org media library."
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>
            Generate with nanobanana
          </button>
        </div>
      </div>

      <p className="xs-caption">
        png, jpg, webp or gif, up to {MAX_UPLOAD_MB}MB each as still images; an animated gif can be
        up to {TYPE_UPLOAD_CAPS_MB['image/gif']} MB and an mp4 video up to {TYPE_UPLOAD_CAPS_MB['video/mp4']} MB,
        attached alone. Uploading stores the file on your own
        server, it does not send anything to X. That happens when a post is approved.
      </p>

      {uploadError && <div className="qx-banner qx-banner--error">{uploadError}</div>}

      {/* Attached to THIS post. */}
      {selected.length > 0 && (
        <div className="xs-attached">
          {selected.map((name) => (
            <span className="xs-attached__item" key={name}>
              <MediaThumb name={name} onLoadThumb={onLoadThumb} className="xs-attached__thumb" alt={`Attached image ${name}`} />
              <span className="xs-attached__name" title={name}>{name}</span>
              {/* Alt text travels with the draft into the approval card, so
                  the approver sees what a screen reader will be given. X does
                  not take alt text on video. */}
              {!name.toLowerCase().endsWith('.mp4') && (
                <input
                  type="text"
                  className="qx-input qx-input--sm xs-attached__alt"
                  aria-label={`Alt text for ${name}`}
                  placeholder="Alt text (screen readers)"
                  maxLength={1000}
                  value={(altTexts && altTexts[name]) || ''}
                  onChange={(e) => onAltText && onAltText(name, e.target.value)}
                />
              )}
              <button
                type="button"
                className="xs-attached__remove"
                onClick={() => onToggle(name)}
                aria-label={`Remove ${name} from this post`}
                title={`Remove ${name}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {libraryOpen && (
        <div className="xs-media-panel">
          <div className="qx-row qx-row--apart qx-row--wrap">
            <span className="xs-caption xs-caption--strong">
              Org media library{files.length ? `: ${files.length} image${files.length === 1 ? '' : 's'}` : ''}
            </span>
            <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={onRefresh}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              Refresh
            </button>
          </div>

          {files.length === 0 ? (
            <p className="xs-caption">
              Nothing in the library yet. Upload an image above, or ask HERALD in the chat panel to
              attach one.
            </p>
          ) : (
            <div className="xs-media-grid">
              {files.map((f) => {
                const isSel = selected.includes(f.name)
                return (
                  <button
                    key={f.name}
                    type="button"
                    className={`xs-media-tile ${isSel ? 'xs-media-tile--selected' : ''}`}
                    onClick={() => onToggle(f.name)}
                    disabled={!isSel && full}
                    aria-pressed={isSel}
                    title={`${f.name} (${Math.round(f.size / 1024)} KB)`}
                  >
                    <span className="xs-media-tile__thumb">
                      <MediaThumb name={f.name} onLoadThumb={onLoadThumb} alt={f.name} />
                      {isSel && (
                        <span className="xs-media-tile__check" aria-hidden="true">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        </span>
                      )}
                    </span>
                    <span className="xs-media-tile__meta">
                      <span className="xs-media-tile__name">{f.name}</span>
                      <span className="xs-media-tile__date">{fmtDate(f.modified_at)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {full && (
            <p className="xs-caption">
              That is the maximum of {MAX_IMAGES} images for one post. Remove one to swap it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function AwaitingApproval({ result, onDismiss }) {
  // Three outcomes share this banner, and they must not read the same. A
  // published post says so and links to it; a draft says plainly that nothing
  // has gone out yet.
  const published = result.outcome === 'published'
  const scheduled = result.outcome === 'scheduled'
  return (
    <div className={`qx-banner ${published ? 'qx-banner--success' : scheduled ? 'qx-banner--info' : 'qx-banner--success'}`}>
      <div className="qx-stack qx-stack--tight">
        {published ? (
          <span>
            Approved and sent to X. The approval card{' '}
            <code className="qx-code">{result.inbox_item_id}</code> records who approved it and
            when, and the post is counted against your budget.
          </span>
        ) : scheduled ? (
          <span>
            Approved and scheduled. This will publish to X at the time you chose, with no further
            tap needed, because you approved it just now. Approval card{' '}
            <code className="qx-code">{result.inbox_item_id}</code> records that decision and its
            publish time. You can cancel it from the Activity tab any time before it fires.
          </span>
        ) : (
          <span>
            Draft filed for owner approval. Nothing is published until it is approved.
            Inbox item <code className="qx-code">{result.inbox_item_id}</code>.
          </span>
        )}
        <div className="qx-row qx-row--tight">
          {/* A published or scheduled post lives on the Activity tab; only a
              plain draft has anything for the approver to DO in the inbox.
              Sending someone to the inbox after SEND NOW implied a pending
              approval that does not exist (owner confusion, 2026-09-16). */}
          {published || scheduled ? (
            <Link className="qx-btn qx-btn--sm" to="/x?tab=activity">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
              View in Activity
            </Link>
          ) : (
            <Link className="qx-btn qx-btn--sm" to="/inbox">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
              Open Inbox
            </Link>
          )}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onDismiss}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            Compose another
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Turn a datetime-local value into an ISO instant for the scheduler.
 *
 * X-PLUGIN phase 12 replaced a cron string with a single instant, because the
 * semantics changed: this is now ONE pre-authorised publish at a chosen
 * moment, not a recurring drafting job. A cron expression has no year field
 * and would silently recur annually, which is the wrong shape entirely for
 * "publish this specific post at this specific time".
 *
 * Returns null for an empty or unparseable value, and for a time already in
 * the past (the server refuses those too; refusing here as well means the
 * button can be disabled rather than the user being bounced).
 */
export function datetimeToIso(value, now = new Date()) {
  if (!value) return null
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return null
  if (when.getTime() <= now.getTime()) return null
  return when.toISOString()
}

export default function XComposePanel({
  mediaFiles = [],
  onRefreshMedia,
  onDraftPost,
  onDraftThread,
  // X-PLUGIN phase 11. All three actions below go through the SAME mint then
  // decide path; see xClient.respondToInboxItem for why a second write path
  // must never be added.
  onApprove,          // (inboxItemId) => Promise, drives the inbox decide endpoint
  onCheckClaim,       // (inboxItemId) => Promise<claim|null>, collector ground truth after an approve error
  onSchedulePublish,  // ({ inboxItemId, action, actionParams, scheduledPublishAt }) => Promise
  onUploadImage,      // (File) => Promise
  onLoadThumb,        // (name) => Promise<objectUrl>, media library thumbnails
  canApprove = false, // org owner/admin only; see the comment on the footer
}) {
  const [mode, setMode] = useState('post')
  const [text, setText] = useState('')
  const [threadTexts, setThreadTexts] = useState(['', ''])
  const [selectedImages, setSelectedImages] = useState([])
  const [drafting, setDrafting] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [scheduleAt, setScheduleAt] = useState('')
  // Phase 10 slice A compose affordances.
  const [altTexts, setAltTexts] = useState({})
  const [quoteTweetId, setQuoteTweetId] = useState('')
  const [replySettings, setReplySettings] = useState('everyone')
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [pollDuration, setPollDuration] = useState(1440)

  const setAltText = useCallback((name, value) => {
    setAltTexts((cur) => ({ ...cur, [name]: value }))
  }, [])

  const toggleImage = useCallback((name) => {
    setSelectedImages((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name].slice(0, MAX_IMAGES)))
  }, [])

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setText('')
    setThreadTexts(['', ''])
    setSelectedImages([])
    setScheduleAt('')
    setAltTexts({})
    setQuoteTweetId('')
    setReplySettings('everyone')
    setPollEnabled(false)
    setPollOptions(['', ''])
    setPollDuration(1440)
  }, [])

  const handleUpload = useCallback(async (file) => {
    if (!onUploadImage) return
    // Per-type size check BEFORE the bytes leave the browser: refusing a
    // 200MB video after a full upload wastes the user's time and bandwidth.
    // The server re-checks against the sniffed content and stays the authority.
    const capMb = TYPE_UPLOAD_CAPS_MB[file.type] || MAX_UPLOAD_MB
    if (file.size > capMb * 1024 * 1024) {
      setUploadError(`${file.name} is larger than the ${capMb}MB limit for its type`)
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const out = await onUploadImage(file)
      // Select the new image straight away: uploading it is the user saying
      // they want it on this post.
      const name = out?.file?.name
      if (name) setSelectedImages((cur) => (cur.includes(name) ? cur : [...cur, name].slice(0, MAX_IMAGES)))
      if (onRefreshMedia) await onRefreshMedia()
    } catch (e) {
      // Never swallow a refusal. The server refuses on type, size and
      // containment, and the user needs to know which.
      setUploadError(e.message)
    } finally {
      setUploading(false)
    }
  }, [onUploadImage, onRefreshMedia])

  /** Mint the approval card. Shared by every action, because every action
   * starts by filing a card; they differ only in what happens next. */
  const mint = useCallback(async () => {
    // Attachments keep the legacy imagePaths shape unless any alt text was
    // written, in which case the phase 10 images objects carry it through the
    // card so the approver sees it.
    const hasAltText = selectedImages.some((n) => (altTexts[n] || '').trim())
    const attachments = selectedImages.length === 0
      ? {}
      : hasAltText
        ? { images: selectedImages.map((n) => ({ path: n, ...((altTexts[n] || '').trim() ? { alt_text: altTexts[n].trim() } : {}) })) }
        : { imagePaths: selectedImages }
    const extras = {}
    if (quoteTweetId.trim()) extras.quote_tweet_id = quoteTweetId.trim()
    if (replySettings !== 'everyone') extras.reply_settings = replySettings
    if (pollEnabled && selectedImages.length === 0) {
      extras.poll = { options: pollOptions.map((o) => o.trim()).filter(Boolean), duration_minutes: Number(pollDuration) }
    }
    if (mode === 'post') return onDraftPost({ text, ...attachments, ...extras })
    const posts = threadTexts.filter((t) => t.trim().length > 0).map((t, i) => (
      i === 0 && selectedImages.length ? { text: t, ...attachments } : { text: t }
    ))
    return onDraftThread({ posts })
  }, [mode, text, threadTexts, selectedImages, altTexts, quoteTweetId, replySettings, pollEnabled, pollOptions, pollDuration, onDraftPost, onDraftThread])

  const run = useCallback(async (action) => {
    setDrafting(true)
    setPendingAction(action)
    setError(null)
    try {
      if (action === 'schedule') {
        const publishAt = datetimeToIso(scheduleAt)
        if (!publishAt) {
          setError('Choose a date and time in the future to publish at')
          return
        }
      }

      const minted = await mint()
      if (!minted?.success) {
        setError(minted?.error || 'Draft was rejected')
        return
      }

      if (action === 'draft') {
        setResult({ ...minted, outcome: 'draft' })
        return
      }

      if (action === 'schedule') {
        // Phase 12: the card is minted and the approval is recorded NOW,
        // against a publish time in the future. Same mint-then-decide shape as
        // posting now; only the moment the publish happens differs.
        try {
          const out = await onSchedulePublish({
            inboxItemId: minted.inbox_item_id,
            action: mode === 'post' ? 'x.post' : 'x.thread',
            actionParams: minted.action_params || null,
            scheduledPublishAt: datetimeToIso(scheduleAt),
          })
          setResult({ ...minted, outcome: 'scheduled', scheduled: out?.scheduled || null })
        } catch (scheduleErr) {
          setError(
            `The draft was filed (inbox item ${minted.inbox_item_id}) but scheduling it failed: ${scheduleErr.message}. `
            + 'Check the Activity tab: if it is not listed as scheduled there, the card is still open in your inbox.'
          )
        }
        return
      }

      // action === 'post-now'. The card exists; approving it drives the same
      // endpoint the inbox's own Post button drives, so the budget claim,
      // replay guard, credential binding and AEE evidence all still happen.
      // If this approval fails the card SURVIVES as a draft, which is why the
      // error says so rather than implying the work was lost.
      try {
        await onApprove(minted.inbox_item_id)
        setResult({ ...minted, outcome: 'published' })
      } catch (approveErr) {
        // The call erroring proves nothing about what HAPPENED: the publish
        // can succeed server-side while the response back to this browser
        // fails, and the old copy here asserted the card was "waiting in
        // your inbox" while the tweet was already live (owner, 2026-09-16).
        // Ask the collector's ledger before saying anything.
        const claim = onCheckClaim ? await onCheckClaim(minted.inbox_item_id).catch(() => null) : null
        if (claim?.status === 'posted') {
          setResult({ ...minted, outcome: 'published' })
        } else if (claim?.status === 'failed') {
          setError(
            `The draft was filed (inbox item ${minted.inbox_item_id}) but the publish failed: ${claim.error || approveErr.message}.`
          )
        } else {
          setError(
            `The draft was filed (inbox item ${minted.inbox_item_id}) but the approval call did not return cleanly: ${approveErr.message}. `
            + 'Check the Activity tab before retrying; the post may have published anyway.'
          )
        }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setDrafting(false)
      setPendingAction(null)
    }
  }, [mint, onApprove, onSchedulePublish, scheduleAt, mode])

  const pollValid = !pollEnabled || selectedImages.length > 0
    || (pollOptions.filter((o) => o.trim()).length >= 2 && Number(pollDuration) >= 5 && Number(pollDuration) <= 10080)
  const postValid = text.trim().length > 0 && text.length <= MAX_CHARS && pollValid
  const threadValid = threadTexts.filter((t) => t.trim().length > 0).length >= 2
    && threadTexts.every((t) => t.length <= MAX_CHARS)
  const canSubmit = !drafting && (mode === 'post' ? postValid : threadValid)

  if (result) {
    return (
      <section className="qx-card">
        <h3 style={{ marginTop: 0 }}>Compose</h3>
        <AwaitingApproval result={result} onDismiss={reset} />
      </section>
    )
  }

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <h3 style={{ margin: 0 }}>Compose</h3>
          <div className="qx-seg" role="tablist" aria-label="compose mode">
            <button type="button" role="tab" aria-selected={mode === 'post'} className={`qx-seg__btn ${mode === 'post' ? 'qx-seg__btn--active' : ''}`} onClick={() => setMode('post')}>Post</button>
            <button type="button" role="tab" aria-selected={mode === 'thread'} className={`qx-seg__btn ${mode === 'thread' ? 'qx-seg__btn--active' : ''}`} onClick={() => setMode('thread')}>Thread</button>
          </div>
        </div>

        {mode === 'post' ? (
          <div className="qx-field">
            <span className="qx-field__label">Post text</span>
            <textarea
              className="qx-textarea xs-compose-text"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What's happening?"
            />
            <span className="qx-field__hint"><CharCount text={text} /></span>
          </div>
        ) : (
          <div className="qx-stack qx-stack--compact">
            {threadTexts.map((t, i) => (
              <div className="qx-field" key={i}>
                <span className="qx-field__label">Post {i + 1}{i === 0 && selectedImages.length ? ' (carries the images)' : ''}</span>
                <textarea
                  className="qx-textarea"
                  rows={3}
                  value={t}
                  onChange={(e) => setThreadTexts((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))}
                  placeholder={i === 0 ? 'Opening post…' : 'Continue the thread…'}
                />
                <span className="qx-field__hint"><CharCount text={t} /></span>
              </div>
            ))}
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setThreadTexts((cur) => [...cur, ''])}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                Add post
              </button>
              {threadTexts.length > 2 && (
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setThreadTexts((cur) => cur.slice(0, -1))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  Remove last
                </button>
              )}
            </div>
          </div>
        )}

        <ImagePicker
          files={mediaFiles}
          selected={selectedImages}
          onToggle={toggleImage}
          onRefresh={onRefreshMedia}
          onUpload={handleUpload}
          uploading={uploading}
          uploadError={uploadError}
          onLoadThumb={onLoadThumb}
          altTexts={altTexts}
          onAltText={setAltText}
        />

        {/* Phase 10 slice A: quote, reply controls and poll. Single-post only;
            per-post thread compose stays on the backlog. Everything here rides
            the approval card as data, so the approver sees it before tapping. */}
        {mode === 'post' && (
          <div className="qx-stack qx-stack--tight xs-compose-extras">
            <div className="qx-row qx-row--tight qx-row--wrap">
              <label className="xs-caption xs-caption--strong" htmlFor="x-quote-id">Quote tweet id</label>
              <input
                id="x-quote-id"
                type="text"
                inputMode="numeric"
                className="qx-input"
                placeholder="Optional: id of the tweet to quote"
                value={quoteTweetId}
                onChange={(e) => setQuoteTweetId(e.target.value)}
              />
              <label className="xs-caption xs-caption--strong" htmlFor="x-reply-settings">Who can reply</label>
              <select
                id="x-reply-settings"
                className="qx-input"
                value={replySettings}
                onChange={(e) => setReplySettings(e.target.value)}
              >
                <option value="everyone">Everyone</option>
                <option value="mentionedUsers">Only people mentioned</option>
                <option value="following">People you follow</option>
              </select>
            </div>

            <label className="qx-row qx-row--tight xs-caption" style={{ alignItems: 'center', cursor: selectedImages.length ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                aria-label="Add a poll"
                checked={pollEnabled && selectedImages.length === 0}
                disabled={selectedImages.length > 0}
                onChange={(e) => setPollEnabled(e.target.checked)}
              />
              Add a poll{selectedImages.length > 0 ? ' (X does not allow a poll and media on the same post)' : ''}
            </label>

            {pollEnabled && selectedImages.length === 0 && (
              <div className="qx-stack qx-stack--tight" style={{ paddingLeft: 22 }}>
                {pollOptions.map((opt, i) => (
                  <input
                    key={i}
                    type="text"
                    className="qx-input"
                    aria-label={`Poll option ${i + 1}`}
                    placeholder={`Option ${i + 1}`}
                    maxLength={25}
                    value={opt}
                    onChange={(e) => setPollOptions((cur) => cur.map((v, j) => (j === i ? e.target.value : v)))}
                  />
                ))}
                <div className="qx-row qx-row--tight qx-row--wrap">
                  {pollOptions.length < 4 && (
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPollOptions((cur) => [...cur, ''])}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      Add option
                    </button>
                  )}
                  {pollOptions.length > 2 && (
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPollOptions((cur) => cur.slice(0, -1))}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      Remove option
                    </button>
                  )}
                  <label className="xs-caption xs-caption--strong" htmlFor="x-poll-duration">Poll duration (minutes)</label>
                  <input
                    id="x-poll-duration"
                    type="number"
                    className="qx-input"
                    min={5}
                    max={10080}
                    value={pollDuration}
                    onChange={(e) => setPollDuration(e.target.value)}
                    style={{ width: 110 }}
                  />
                </div>
                <span className="xs-caption">2 to 4 options, 25 characters each. Duration from 5 minutes to 7 days.</span>
              </div>
            )}
          </div>
        )}

        {error && <div className="qx-banner qx-banner--error">{error}</div>}

        {/* Scheduling applies to a single post. A thread has no scheduled
            shape in the template, so the control is simply absent in thread
            mode rather than present and quietly ignored. */}
        {mode === 'post' && canApprove && (
          <div className="qx-row qx-row--tight qx-row--wrap">
            <label className="xs-caption xs-caption--strong" htmlFor="x-schedule-at">Publish at</label>
            <input
              id="x-schedule-at"
              type="datetime-local"
              className="qx-input"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </div>
        )}

        <div className="qx-stack qx-stack--tight">
          <span className="xs-caption">
            {canApprove
              ? 'Every action here files an approval card first. Posting now approves that same card, so the budget, the evidence trail and the record of who approved it are identical to tapping Post in the inbox.'
              : 'Drafts go to the inbox for an owner or admin to approve. Nothing posts directly.'}
          </span>
          {/* Owner item 7: the publishing action is the hero and looks like it.
              Draft and Schedule are its siblings, deliberately smaller and
              quieter, because they do not reach X. */}
          <div className="xs-actionbar">
            <button
              type="button"
              className="qx-btn xs-btn xs-btn--sibling"
              onClick={() => run('draft')}
              disabled={!canSubmit}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
              {drafting && pendingAction === 'draft' ? 'Saving…' : 'Save as draft'}
            </button>

            {/* Role gate. The auth service lets any active org member respond
                to an item they can SEE, but X approval cards are auto-assigned
                to owners and admins at mint time and non-admins never see
                them, so owner/admin is the real approver set for X. This gate
                mirrors that rather than offering a button the server would
                accept but the workflow never intends. It is a UI hint: the
                server remains the enforcement point. */}
            {canApprove && (
              <>
                <button
                  type="button"
                  className="qx-btn xs-btn xs-btn--sibling"
                  onClick={() => run('schedule')}
                  disabled={drafting || mode !== 'post' || !postValid || !scheduleAt}
                  title="Approves this post now and publishes it at the time you choose. No second tap is needed. Cancellable from the Activity tab until it fires."
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                  {drafting && pendingAction === 'schedule' ? 'Scheduling…' : 'Approve and schedule'}
                </button>

                <button
                  type="button"
                  className="qx-btn xs-btn xs-btn--send"
                  onClick={() => run('post-now')}
                  disabled={!canSubmit}
                  title="Approves this post and sends it to X right now."
                >
                  <XGlyph size={18} />
                  {drafting && pendingAction === 'post-now' ? 'SENDING…' : 'SEND NOW'}
                </button>
              </>
            )}
          </div>
        </div>

        {canApprove && (
          <p className="xs-caption">
            Approve and schedule approves the post NOW and delays only the publish. It will go out
            at the time you pick without a second tap, so treat it as posting. It holds a slot in
            your posting budget from the moment you approve it, and you can cancel it from the
            Activity tab at any point before it fires.
          </p>
        )}
      </div>
    </section>
  )
}
