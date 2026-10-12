// onboarding.js - BRAIN2-W8 first-run progress, derived from SERVER data only.
// Inputs: /brain/status noteCount, the feed sources list (connected rows),
// /brain/usage search ledger, plus in-session search results. localStorage is
// used by the view solely for the "dismissed" UI preference, never for progress.

export const STEP_IDS = ['connect', 'capture', 'ask']

/** A source row counts as connected when the feed API says so (and it is enabled). */
export function connectedSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter((s) => s && s.connected && s.enabled !== false)
}

export function deriveOnboarding({ noteCount = 0, sources = [], searchCount = 0, askedThisSession = false } = {}) {
  const connected = connectedSources(sources)
  const done = {
    connect: connected.length > 0,
    capture: Number(noteCount) > 0,
    ask: Number(searchCount) > 0 || !!askedThisSession
  }
  const current = STEP_IDS.find((id) => !done[id]) || null
  const doneCount = STEP_IDS.filter((id) => done[id]).length
  return { done, current, doneCount, total: STEP_IDS.length, complete: current === null, connected }
}

/**
 * Show for a new org (zero notes) and keep showing through the flow once it has
 * started (so capturing the first note does not make the card vanish mid-way),
 * until the user dismisses it. Never shows for an established brain.
 */
export function shouldShowOnboarding({ noteCount = 0, dismissed = false, started = false } = {}) {
  if (dismissed) return false
  return Number(noteCount) === 0 || !!started
}

/** Seed the "ask" step from the note just captured. */
export function seedQuestion(note) {
  const title = String(note?.title || '').trim()
  if (title) return `What did I note about ${title.replace(/[?.!]+$/, '')}?`
  const words = String(note?.text || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  return words ? `What did I note about ${words}?` : ''
}
