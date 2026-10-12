import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { cardName } from './names'

const MAX_FETCH = 25

/**
 * Display names for contact ids, resolved on the CLIENT for a signed-in human: from the address book list, then by
 * fetching the cards of any ids still unknown (capped). The evidence trail itself stays ids and codes only.
 * Returns nameOf(id) -> string | null (null while loading, for an erased contact, or on any failure).
 */
export function useContactNames(ids) {
  const [names, setNames] = useState({})
  const tried = useRef(new Set())
  const listed = useRef(false)
  const key = [...new Set(ids.filter(Boolean))].sort().join('|')
  useEffect(() => {
    let live = true
    const want = key ? key.split('|') : []
    if (!want.length) return undefined
    ;(async () => {
      const found = {}
      if (!listed.current) {
        listed.current = true
        try {
          const r = await api.listContacts({})
          for (const c of (r && r.contacts) || []) { const n = cardName(c); if (c.id && n) found[c.id] = n }
        } catch { /* fall through to per-card fetches */ }
      }
      const missing = want.filter((id) => !found[id] && !names[id] && !tried.current.has(id)).slice(0, MAX_FETCH)
      await Promise.all(missing.map(async (id) => {
        tried.current.add(id)
        try { const r = await api.getContact(id); const n = r && r.contact ? cardName(r.contact) : ''; if (n) found[id] = n } catch { /* erased or unavailable */ }
      }))
      if (live && Object.keys(found).length) setNames((m) => ({ ...m, ...found }))
    })()
    return () => { live = false }
  }, [key])
  return (id) => names[id] || null
}
