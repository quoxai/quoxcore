/**
 * Org-level NotesQ settings for the browser (Settings > NotesQ, group notesq).
 * Fetched once per NotesQ view mount from the platform flags API. Every
 * failure falls back to the shipped defaults: a settings hiccup must never
 * block editing or creating a note.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '../../../contexts/AuthContext'
import { fetchPlatformFlags } from '../../../services/platformFlagsClient'
import { AUTOSAVE_DELAY_MS } from './saveMachine'

export const AUTOSAVE_MIN_MS = 500
export const AUTOSAVE_MAX_MS = 30000
export const DEFAULT_NOTESQ_SETTINGS = { autosaveMs: AUTOSAVE_DELAY_MS, defaultCollection: '' }

/** Pure: flags list -> effective settings, clamped, defaults on anything unusable. */
export function parseNotesqSettings(flags) {
  const out = { ...DEFAULT_NOTESQ_SETTINGS }
  if (!Array.isArray(flags)) return out
  const get = (k) => flags.find((f) => f && f.key === k)
  const ms = Number(get('NOTESQ_AUTOSAVE_MS')?.value)
  if (Number.isFinite(ms) && ms >= AUTOSAVE_MIN_MS && ms <= AUTOSAVE_MAX_MS) out.autosaveMs = ms
  const col = get('NOTESQ_DEFAULT_COLLECTION')?.value
  if (typeof col === 'string' && col.trim()) out.defaultCollection = col.trim()
  return out
}

export function useNotesqSettings() {
  const { authFetch } = useAuth()
  const [settings, setSettings] = useState(DEFAULT_NOTESQ_SETTINGS)
  useEffect(() => {
    let live = true
    fetchPlatformFlags(authFetch)
      .then((flags) => { if (live) setSettings(parseNotesqSettings(flags)) })
      .catch(() => { /* defaults stay */ })
    return () => { live = false }
  }, []) // once per view mount; the org switch remounts the content
  return settings
}
