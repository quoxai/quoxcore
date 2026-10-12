/** Photo controls on the avatar: click it, then upload / replace / remove. Used in the detail header. Human-only on the server. */
import { useEffect, useRef, useState } from 'react'
import { api, PHOTO_MAX_BYTES, PHOTO_TYPES } from './lib/api'
import { explainError } from './lib/reasonCodes'
import { MenuItem } from './shared'
import ContactAvatar from './ContactAvatar'
import { CameraIcon, TrashIcon } from './icons'
import { useToast } from './toast'

/** Client-side check before upload (the server re-validates by magic bytes). -> sentence or null. */
export function photoProblem(file) {
  if (!file) return 'Choose a picture.'
  if (!PHOTO_TYPES.includes(file.type)) return 'Choose a PNG, JPEG or WebP picture.'
  if (file.size > PHOTO_MAX_BYTES) return 'That picture is over 2 MB. Choose a smaller one.'
  return null
}

export default function PhotoMenu({ card, size = 'lg', onChanged }) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const input = useRef(null)
  const toast = useToast()
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    const problem = photoProblem(file)
    if (problem) { setErr(problem); return }
    setBusy(true); setErr(null)
    try { await api.putPhoto(card.id, file); toast('Photo saved'); onChanged?.() } catch (e2) { setErr(explainError(e2)) } finally { setBusy(false) }
  }
  const remove = async () => {
    setOpen(false); setBusy(true); setErr(null)
    try { await api.deletePhoto(card.id); toast('Photo removed'); onChanged?.() } catch (e2) { setErr(explainError(e2)) } finally { setBusy(false) }
  }
  return (
    <div className="qx-popover" ref={ref}>
      <ContactAvatar card={card} size={size} onClick={() => setOpen((o) => !o)} label={card.has_photo ? 'Change or remove photo' : 'Add a photo'} />
      <input ref={input} type="file" accept={PHOTO_TYPES.join(',')} hidden aria-label="Choose a photo" onChange={pick} />
      {open ? (
        <div className="qx-menu qx-popover__panel" role="menu">
          <MenuItem icon={CameraIcon} title={card.has_photo ? 'Replace photo' : 'Upload photo'} help="PNG, JPEG or WebP, up to 2 MB. Stored encrypted." disabled={busy} onClick={() => { setOpen(false); input.current?.click() }} />
          {card.has_photo ? <MenuItem icon={TrashIcon} danger title="Remove photo" onClick={remove} /> : null}
        </div>
      ) : null}
      {err ? <div className="qx-banner qx-banner--error" role="alert" style={{ position: 'absolute', zIndex: 5, minWidth: 220 }}>{err}</div> : null}
    </div>
  )
}
