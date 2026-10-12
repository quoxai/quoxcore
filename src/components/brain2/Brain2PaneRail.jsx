/**
 * Collapsed pane rail (the NotesQ pattern, see notesq/NotesQPaneRail.jsx): a slim
 * glass strip standing in for a hidden pane in the SAME slot, so hiding a pane is
 * always visibly reversible. The whole rail is clickable; the chevron button is
 * the keyboard-focusable control. `side` picks the chevron direction.
 */
function ChevronsIcon({ dir = 'right' }) {
  const d = dir === 'right' ? 'M13 17l5-5-5-5M6 17l5-5-5-5' : dir === 'left' ? 'M11 17l-5-5 5-5M18 17l-5-5 5-5' : 'M17 11l-5-5-5 5M17 18l-5-5-5 5'
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  )
}

export default function Brain2PaneRail({ className = '', side = 'left', icon, label, count, countLabel, expandLabel, onExpand, testId }) {
  return (
    <aside className={`qx-card bw-pane-rail bw-pane-rail--${side} ${className}`} aria-label={`${label} (hidden)`}
      onClick={onExpand} data-testid={testId}>
      <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm bw-pane-rail__expand"
        onClick={(e) => { e.stopPropagation(); onExpand() }} aria-label={expandLabel} title={expandLabel}>
        <ChevronsIcon dir={side === 'left' ? 'right' : side === 'right' ? 'left' : 'up'} />
      </button>
      <span className="bw-pane-rail__icon" aria-hidden="true">{icon}</span>
      <span className="bw-pane-rail__label">{label}</span>
      {count != null ? <span className="bw-pane-rail__count qx-badge" aria-label={countLabel}>{count}</span> : null}
    </aside>
  )
}
