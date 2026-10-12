/**
 * Collapsed pane rail: a slim glass strip that stands in for a hidden pane in
 * the SAME grid column, so hiding a pane is always visibly reversible. The whole
 * rail is clickable; the chevron is the keyboard-focusable control.
 */
import { ChevronsRightIcon } from './icons'

export default function NotesQPaneRail({ className = '', icon: Icon, label, count, expandLabel, onExpand, children }) {
  return (
    <aside className={`qx-pane-rail qx-card qx-card--compact ${className}`} aria-label={`${label} (hidden)`}
      onClick={onExpand} data-testid={`nq-rail-${label.toLowerCase()}`}>
      <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-rail__expand" onClick={(e) => { e.stopPropagation(); onExpand() }}
        aria-label={expandLabel} title={expandLabel}><ChevronsRightIcon /></button>
      {children}
      <span className="qx-pane-rail__icon" aria-hidden="true">{Icon ? <Icon /> : null}</span>
      <span className="qx-pane-rail__label">{label}</span>
      {count != null ? <span className="qx-pane-rail__count qx-badge" aria-label={`${count} notes`}>{count}</span> : null}
    </aside>
  )
}
