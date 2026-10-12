/**
 * ContactAvatar: everyone gets a deterministic coloured initials avatar (hue from the contact id); a photo replaces it
 * when the card says has_photo. With onClick it becomes a button (change photo) with an edit glyph on hover.
 * Photos are human-only on the server, so an unreadable photo (403/404) falls back to initials.
 */
import { useEffect, useState } from 'react'
import { photoUrl } from './lib/api'
import { avatarHue } from './lib/chips'
import { initialsOf } from './lib/names'
import { BuildingIcon, CameraIcon } from './icons'

export default function ContactAvatar({ card, size = 'sm', onClick, label }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [card?.id, card?.photo_v])
  const org = card?.kind === 'organisation'
  const showPhoto = !!card?.has_photo && !failed
  const cls = `qx-avatar qx-avatar--${size} qx-avatar--tint${org ? '' : ' qx-avatar--circle'}`
  const style = { '--qx-avatar-hue': avatarHue(card?.id) }
  const inner = (
    <>
      {showPhoto
        ? <img src={photoUrl(card.id, card.photo_v)} alt="" loading="lazy" onError={() => setFailed(true)} />
        : (org ? <BuildingIcon size={size === 'lg' || size === 'xl' ? 24 : 14} /> : initialsOf(card))}
      {onClick ? <span className="qx-avatar__edit" aria-hidden="true"><CameraIcon size={size === 'lg' || size === 'xl' ? 20 : 12} /></span> : null}
    </>
  )
  return onClick
    ? <button type="button" className={cls} style={style} onClick={onClick} aria-label={label || 'Change photo'} title={label || 'Change photo'}>{inner}</button>
    : <span className={cls} style={style} aria-hidden="true">{inner}</span>
}
