/**
 * BrainCapture - "Save to brain" paste box for the Qortex view (BRAIN2-V3 A2).
 *
 * Paste text, or a bare URL to clip the page server-side, and it lands as an
 * editable NotesQ note via POST /brain/capture (quoxbrainClient.captureNote).
 * Server is the source of truth: the unsent draft is persisted server-side too
 * (BRAIN2-W8, org + user scoped), so it survives reloads and device switches.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { getQuoxbrainClient } from '../../services/quoxbrainClient'
import { createDraftSync } from './lib/captureDraft'
import './BrainCapture.css'

function SaveIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

const URL_ONLY = /^https?:\/\/\S+$/i

const RESULT_LABEL = { created: 'Saved to your brain', updated: 'Updated an existing note', unchanged: 'Already in your brain' }

function successMessage(out) {
  let msg = `${RESULT_LABEL[out.status] || 'Saved'}${out.title ? `: ${out.title}` : ''}`
  if (out.truncated) {
    const got = out.pagesCaptured
    const total = out.pagesTotal
    msg = got != null && total != null
      ? `Saved ${got} of ${total} pages (PDF truncated)${out.title ? `: ${out.title}` : ''}`
      : `${msg} (PDF truncated)`
  }
  if (out.possibleDuplicateOf) {
    const d = out.possibleDuplicateOf
    const ref = typeof d === 'object' ? (d.title || d.id) : d
    msg += `. Saved as a new note that may duplicate an existing one${ref ? ` (${ref})` : ''}`
  }
  return msg
}

export default function BrainCapture({ client, onSaved }) {
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState('user') // BRAIN2-W7 E 135: personal vs shared with the org
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { kind: 'ok'|'error', message }

  const trimmed = draft.trim()
  const api = useMemo(() => client || getQuoxbrainClient(), [client])
  const sync = useMemo(() => createDraftSync(api), [api])
  const latestRef = useRef({ title: '', text: '' }) // current field values, readable after an await
  const touchedRef = useRef(false) // the user typed before the server draft arrived

  // Restore the unsent draft from the server on mount (never overwrites typing).
  useEffect(() => {
    let live = true
    sync.load().then((d) => {
      if (!live || !d || touchedRef.current) return
      latestRef.current = { title: d.title, text: d.text }
      setDraft(d.text)
      setTitle(d.title)
    })
    return () => { live = false; sync.cancel() }
  }, [sync])

  const edit = (nextTitle, nextText) => {
    touchedRef.current = true
    latestRef.current = { title: nextTitle, text: nextText }
    setTitle(nextTitle)
    setDraft(nextText)
    sync.schedule({ title: nextTitle, text: nextText })
  }

  const submit = async (e) => {
    e?.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    setResult(null)
    try {
      const payload = URL_ONLY.test(trimmed) ? { url: trimmed } : { text: trimmed }
      if (title.trim()) payload.title = title.trim()
      if (scope === 'org') payload.scope = 'org'
      const out = await api.captureNote(payload)
      setResult({ kind: 'ok', message: successMessage(out) })
      // Clear only what was submitted: text typed during the save is kept.
      const cur = latestRef.current
      const sentText = draft
      const sentTitle = title
      const newText = cur.text === sentText ? '' : (cur.text.startsWith(sentText) ? cur.text.slice(sentText.length).trimStart() : cur.text)
      const newTitle = cur.title === sentTitle ? '' : cur.title
      latestRef.current = { title: newTitle, text: newText }
      setDraft(newText)
      setTitle(newTitle)
      if (newText || newTitle) sync.schedule({ title: newTitle, text: newText })
      else sync.clear()
      onSaved?.(out, { text: trimmed })
    } catch (err) {
      setResult({ kind: 'error', message: err?.message || 'Could not save' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="brain-capture" onSubmit={submit} data-testid="brain-capture">
      <input
        className="glass-input brain-capture__title"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => edit(e.target.value, draft)}
        aria-label="Note title"
      />
      <textarea
        className="glass-input brain-capture__text"
        placeholder="Paste a note, or a link to clip..."
        rows={3}
        value={draft}
        onChange={(e) => edit(title, e.target.value)}
        aria-label="Text or URL to save to your brain"
      />
      <select
        className="glass-input brain-capture__scope"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        aria-label="Who can see this note"
      >
        <option value="user">Only me</option>
        <option value="org">Shared with my organisation</option>
      </select>
      <button className="glass-btn brain-capture__btn" type="submit" disabled={!trimmed || busy}>
        <SaveIcon />
        {busy ? 'Saving...' : 'Save to brain'}
      </button>
      {result && (
        <div className={`brain-capture__result brain-capture__result--${result.kind}`} role={result.kind === 'error' ? 'alert' : 'status'}>
          {result.message}
        </div>
      )}
    </form>
  )
}
