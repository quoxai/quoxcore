import { useEffect, useRef, useState } from 'react'
import { api, PHOTO_TYPES } from './lib/api'
import { IDENTIFIER_CHANNELS, RELATIONSHIPS, labelOf } from './lib/reasonCodes'
import { explainError } from './lib/reasonCodes'
import { joinName, nameBodyFrom } from './lib/names'
import { Field, FormGrid } from './shared'
import NameFields from './NameFields'
import { photoProblem } from './PhotoMenu'
import { useToast } from './toast'
import { CameraIcon, CheckIcon, TrashIcon, XIcon } from './icons'

const BLANK_NAME = { prefix: '', given: '', middle: '', family: '', suffix: '', nickname: '', phonetic_given: '', phonetic_family: '', override: '' }

/**
 * The body POSTed for a new contact. Every contact has a name AND an organisation (owner rule, no person-or-organisation
 * choice): a name makes a person, linked to the organisation when one is given; an organisation alone makes an
 * organisation contact. Persons send name parts plus a derived display_name (so an older collector still works).
 */
export function buildCreateBody(f) {
  const name = nameBodyFrom(f.name)
  const override = f.name.override.trim()
  const personName = override || joinName(name)
  const orgName = (f.org_name || '').trim()
  const role = (f.org_role || '').trim()
  let body
  if (personName) {
    body = { kind: 'person', display_name: personName }
    if (Object.keys(name).length) body.name = name
    if (override) body.display_name_override = override
    if (orgName) body.organisation = { name: orgName, ...(role ? { role } : {}) }
  } else {
    body = { kind: 'organisation', display_name: orgName }
  }
  if (f.relationship_primary) body.relationship_primary = f.relationship_primary
  if (f.notes.trim()) body.notes = f.notes.trim()
  if (f.value.trim()) body.identifiers = [{ channel: f.channel, value: f.value.trim(), is_primary: true }]
  return body
}

export default function AddContactForm({ onCreated, onCancel }) {
  const [f, setF] = useState({ name: BLANK_NAME, org_name: '', org_role: '', relationship_primary: '', notes: '', channel: 'phone', value: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [photo, setPhoto] = useState(null) // { file, url } chosen now, uploaded right after the contact is saved
  const fileInput = useRef(null)
  const toast = useToast()
  useEffect(() => () => { if (photo?.url) URL.revokeObjectURL(photo.url) }, [photo])
  const choosePhoto = (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    const problem = photoProblem(file)
    if (problem) { setErr(new Error(problem)); return }
    setErr(null); setPhoto({ file, url: URL.createObjectURL(file) })
  }
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const personName = !!(joinName(f.name) || f.name.override.trim())
  const hasName = personName || !!f.org_name.trim()

  const submit = async (e) => {
    e.preventDefault()
    if (!hasName) return
    setBusy(true); setErr(null)
    try {
      const res = await api.createContact(buildCreateBody(f))
      if (photo) {
        // The contact is saved either way; a failed upload is reported, never silent, and can be retried from the detail header.
        try { await api.putPhoto(res.contact.id, photo.file) } catch (e3) { toast(`Contact saved, but the photo was not: ${explainError(e3)}`, { variant: 'warn' }) }
      }
      onCreated(res.contact)
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }

  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add contact">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <NameFields value={f.name} onChange={(name) => setF((s) => ({ ...s, name }))} autoFocus />
      <FormGrid>
        <Field label="Organisation" hint={personName ? 'Where they work, or their own business. Optional.' : 'On its own, this saves an organisation.'} span={5} spanSm={12}>
          <input className="qx-input" value={f.org_name} onChange={set('org_name')} aria-label="Organisation" />
        </Field>
        <Field label="Job title" span={4} spanSm={7}><input className="qx-input" value={f.org_role} onChange={set('org_role')} aria-label="Job title" disabled={!personName || !f.org_name.trim()} /></Field>
        <Field label="Relationship" span={3} spanSm={5}>
          <select className="qx-select" value={f.relationship_primary} onChange={set('relationship_primary')}>
            <option value="">Not set</option>
            {RELATIONSHIPS.map((r) => <option key={r} value={r}>{labelOf([], r)}</option>)}
          </select>
        </Field>
      </FormGrid>
      <FormGrid>
        <Field label="First detail" span={3} spanSm={5}>
          <select className="qx-select" value={f.channel} onChange={set('channel')}>{IDENTIFIER_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        </Field>
        <Field label="Phone or email" hint="Optional. Stored encrypted; shown masked after saving." span={9} spanSm={7}>
          <input className="qx-input" value={f.value} onChange={set('value')} autoComplete="off" />
        </Field>
      </FormGrid>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => fileInput.current?.click()}><CameraIcon />{photo ? 'Change photo' : 'Add photo'}</button>
        {photo ? (
          <>
            <img src={photo.url} alt="Chosen photo" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPhoto(null)}><TrashIcon />Remove</button>
          </>
        ) : <span className="qx-hint qx-hint--sm">Optional. PNG, JPEG or WebP, up to 2 MB.</span>}
        <input ref={fileInput} type="file" accept={PHOTO_TYPES.join(',')} hidden aria-label="Choose a photo" onChange={choosePhoto} />
      </div>
      <Field label="Notes"><textarea className="qx-textarea" rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onCancel}><XIcon />Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !hasName}><CheckIcon />{busy ? 'Saving' : 'Save contact'}</button>
      </div>
    </form>
  )
}
