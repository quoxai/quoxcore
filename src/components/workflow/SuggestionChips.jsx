/**
 * SuggestionChips — Contextual quick-action buttons for the workflow chat.
 *
 * Shows relevant suggestions based on current workflow state.
 */

import { useMemo } from 'react'

function SuggestionChips({ nodes, edges, onSend }) {
  const suggestions = useMemo(() => {
    const chips = []

    if (nodes.length === 0) {
      chips.push(
        { label: 'Build a webhook workflow', icon: 'globe' },
        { label: 'Build a scheduled job', icon: 'clock' },
        { label: 'Build an API integration', icon: 'zap' },
        { label: 'Browse templates', icon: 'book' },
      )
      return chips
    }

    const hasTrigger = nodes.some(n => n.type?.startsWith('trigger:'))
    const hasErrorHandling = nodes.some(n => n.type?.startsWith('error:'))
    const hasApiCall = nodes.some(n => n.type === 'call')
    const orphans = nodes.filter(n => {
      const connected = edges.some(e => e.source === n.id || e.target === n.id)
      return !connected && nodes.length > 1
    })

    if (!hasTrigger) {
      chips.push({ label: 'Add a trigger', icon: 'play' })
    }
    if (orphans.length > 0) {
      chips.push({ label: `Connect ${orphans.length} orphan node${orphans.length > 1 ? 's' : ''}`, icon: 'link' })
    }
    if (hasApiCall && !hasErrorHandling) {
      chips.push({ label: 'Add error handling', icon: 'shield' })
    }
    if (nodes.length > 0) {
      chips.push({ label: 'Explain this workflow', icon: 'help' })
      chips.push({ label: 'Validate and check', icon: 'check' })
    }
    if (nodes.length >= 3) {
      chips.push({ label: 'Deploy to QuoxFlow', icon: 'upload' })
    }

    return chips.slice(0, 4)
  }, [nodes, edges])

  if (suggestions.length === 0) return null

  const icons = {
    globe: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    clock: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
    zap: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    book: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
    play: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
    link: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
    shield: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    help: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    check: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
    upload: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  }

  return (
    <div className="wb-chips">
      {suggestions.map((chip, i) => (
        <button
          key={i}
          type="button"
          className="qx-chip"
          onClick={() => onSend(chip.label)}
        >
          {icons[chip.icon]}
          <span>{chip.label}</span>
        </button>
      ))}
    </div>
  )
}

export { SuggestionChips }
export default SuggestionChips
