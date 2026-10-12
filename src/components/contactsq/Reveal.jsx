/**
 * Reveal: the human-only "show real values" state, copy-to-clipboard for a revealed value, and the
 * countdown. Real values live only in hook state and vanish when REVEAL_MS passes (owner OK'd keeping the
 * timer, 2026-10-09: 60 seconds, visibly counted down), the contact changes, or the component unmounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { useToast } from './toast'
import { CheckIcon, CopyIcon, EyeOffIcon } from './icons'

export const REVEAL_MS = 60000

/** Whole seconds left until `expiresAt` (never negative). */
export const secondsLeft = (expiresAt, now) => Math.max(0, Math.ceil((expiresAt - now) / 1000))

export function useReveal(contactId, { ms = REVEAL_MS, load = (id) => api.getContactFull(id) } = {}) {
  const [full, setFull] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState(0)
  const expiry = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // One 1s ticker while values are on screen; it hides them at zero.
  useEffect(() => {
    if (!full) return undefined
    const tick = () => {
      const n = secondsLeft(expiry.current, Date.now())
      setLeft(n)
      if (n <= 0) setFull(null)
    }
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [full])
  const hide = useCallback(() => { expiry.current = 0; setFull(null); setLeft(0) }, [])
  const reveal = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await load(contactId)
      if (!alive.current) return
      expiry.current = Date.now() + ms
      setLeft(secondsLeft(expiry.current, Date.now()))
      setFull(r.contact)
    } catch (e) { if (alive.current) setErr(e) } finally { if (alive.current) setBusy(false) }
  }, [contactId, ms, load])
  return { full, err, busy, reveal, hide, secondsLeft: left }
}

async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return }
  const ta = document.createElement('textarea')
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy') } finally { ta.remove() }
}

/** Icon button that copies a revealed value and says "Copied". The value is never put in the DOM text of the button. */
export function CopyButton({ value, label }) {
  const toast = useToast()
  const [done, setDone] = useState(false)
  const t = useRef(null)
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = async () => {
    try {
      await writeClipboard(String(value))
      toast('Copied')
      setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1500)
    } catch { toast('Could not copy. Select the value and copy it by hand.') }
  }
  return (
    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm qx-tip" data-tip={done ? 'Copied' : 'Copy'} aria-label={`Copy ${label}`} onClick={copy}>
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

/** The notice shown while real values are visible: what it means, the live countdown, and a way to hide now. */
export function RevealNotice({ secondsLeft: left, onHide }) {
  return (
    <div className="qx-banner qx-banner--info" role="status">
      <span>Showing real values. Hiding in <strong data-testid="reveal-countdown">{left}s</strong>. This read is logged.</span>
      <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onHide}><EyeOffIcon />Hide now</button>
    </div>
  )
}
