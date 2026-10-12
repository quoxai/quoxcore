/** "From template" dialog: pick a template, scope and optional collection, create the note, hand its id back. */
import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { CheckIcon, XIcon } from './icons'

export default function NotesQTemplateDialog({ collection: initialCollection = '', onClose, onCreated }) {
  const [templates, setTemplates] = useState(null)
  const [template, setTemplate] = useState('')
  const [scope, setScope] = useState('user')
  const [collection, setCollection] = useState(initialCollection || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { dialogRef.current?.focus() }, [])
  useEffect(() => {
    api.listTemplates()
      .then((r) => {
        if (!alive.current) return
        const list = r?.templates || []
        setTemplates(list)
        if (list.length) setTemplate(list[0].name)
      })
      .catch((e) => { if (alive.current) { setTemplates([]); setError(`Could not load templates. ${e.message}`) } })
  }, [])

  const create = async () => {
    setBusy(true); setError('')
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const res = await api.createFromTemplate({ template, scope, collection: collection.trim() || undefined, tz })
      if (alive.current) onCreated(res.note.id)
    } catch (e) {
      if (alive.current) setError(e.message || 'Something went wrong.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key === 'Tab' && dialogRef.current) {
      const els = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!els.length) return
      const first = els[0]; const last = els[els.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  return (
    <div className="qx-modal-overlay" style={{ padding: '0 16px' }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} className="qx-modal" style={{ maxWidth: 480, outline: 'none' }} role="dialog" aria-modal="true"
        aria-labelledby="nq-tpl-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="qx-modal__header">
          <h2 id="nq-tpl-title">New note from template</h2>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="qx-modal__body qx-stack qx-stack--compact">
          {error ? <div className="qx-banner qx-banner--error" role="alert">{error}</div> : null}
          {templates === null ? <div className="qx-hint" role="status">Loading templates...</div> : null}
          {templates && templates.length === 0 && !error ? <div className="qx-hint">No templates available.</div> : null}
          {templates && templates.length > 0 ? (
            <>
              <div className="qx-field">
                <label className="qx-field__label" htmlFor="nq-tpl-select">Template</label>
                <select id="nq-tpl-select" className="qx-select" value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {templates.map((t) => <option key={`${t.source}:${t.id || t.name}`} value={t.name}>{t.name}{t.source === 'note' ? ' (your note)' : ''}</option>)}
                </select>
              </div>
              <div className="qx-seg" role="group" aria-label="Template note scope">
                {[['user', 'Personal'], ['org', 'Org']].map(([v, l]) => (
                  <button key={v} type="button" className={`qx-seg__btn${scope === v ? ' qx-seg__btn--active' : ''}`} aria-pressed={scope === v} onClick={() => setScope(v)}>{l}</button>
                ))}
              </div>
              <div className="qx-field">
                <label className="qx-field__label" htmlFor="nq-tpl-coll">Collection (optional)</label>
                <input id="nq-tpl-coll" className="qx-input" type="text" value={collection} onChange={(e) => setCollection(e.target.value)} />
              </div>
            </>
          ) : null}
          <div className="qx-modal__actions">
            <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}><XIcon /> Cancel</button>
            <button type="button" className="qx-btn qx-btn--primary" disabled={busy || !template} onClick={create}><CheckIcon /> Create note</button>
          </div>
        </div>
      </div>
    </div>
  )
}
