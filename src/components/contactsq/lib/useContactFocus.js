import { useEffect } from 'react'
import { api } from './api'

/**
 * Tell the server which contact this human has open, so an attached agent can resolve
 * "this person". The POST fires only when the contact CHANGES (module-level, so a
 * remount of the same contact does not repeat it). Ids only; the server keeps it in
 * memory for 30 minutes. Failures are silent: focus is a convenience, never a blocker.
 */
let lastPosted = null

export function resetFocusDebounce() { lastPosted = null }

export function useContactFocus(contactId) {
  useEffect(() => {
    if (!contactId || contactId === lastPosted) return
    lastPosted = contactId
    let p
    try { p = api.setFocus(contactId) } catch { p = null }
    Promise.resolve(p).catch(() => { if (lastPosted === contactId) lastPosted = null })
  }, [contactId])
}
