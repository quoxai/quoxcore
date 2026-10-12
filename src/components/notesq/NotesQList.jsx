/** Middle pane: debounced search + note list. */
import { useEffect, useState } from 'react'
import { SearchIcon, PinIcon, NotesIcon, ChevronsLeftIcon, ChatIcon } from './icons'
import { relativeTime } from './lib/listQuery'
import { VIEWS } from './lib/propertyViews'
import { tagChipClass } from './lib/tagHue'
import NotesQProjection from './NotesQProjection'

const VIEW_LABELS = { list: 'List', table: 'Table', cards: 'Cards', timeline: 'Timeline' }

export default function NotesQList({ q, onQ, notes, total, loading, error, selectedId, onSelect, onPrefetch, hasFilters, onRetry, onCollapse, onAgent, agentOpen, view = 'list', onView, onOpen }) {
  const [local, setLocal] = useState(q)
  useEffect(() => { setLocal(q) }, [q])
  useEffect(() => {
    if (local === q) return undefined
    const t = setTimeout(() => onQ(local), 300)
    return () => clearTimeout(t)
  }, [local, q, onQ])

  return (
    <section className="nq-pane nq-pane--list qx-card qx-card--compact" aria-label="Notes">
      <div className="qx-row qx-row--apart qx-row--tight qx-row--wrap">
        <span className="qx-section-title">Notes</span>
        <span className="qx-row qx-row--tight">
        {onAgent ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-pressed={!!agentOpen} onClick={onAgent} aria-label="Agent" title="Ask the NotesQ agent"><ChatIcon /> <span className="nq-btn-label">Agent</span></button> : null}
        {onCollapse ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-wide-only" onClick={onCollapse} aria-label="Hide notes list" title="Hide notes list"><ChevronsLeftIcon /></button> : null}
        </span>
      </div>
      {onView ? (
        <div className="qx-seg nq-viewswitch" role="group" aria-label="Notes view">
          {VIEWS.map((v) => (
            <button key={v} type="button" className={`qx-seg__btn${view === v ? ' qx-seg__btn--active' : ''}`} aria-pressed={view === v} onClick={() => onView(v)}>{VIEW_LABELS[v]}</button>
          ))}
        </div>
      ) : null}
      <div className="qx-search-wrap">
        <span className="qx-search-wrap__icon"><SearchIcon /></span>
        <input className="qx-input" type="search" placeholder="Search notes" value={local} onChange={(e) => setLocal(e.target.value)} aria-label="Search notes" />
      </div>
      <div className="nq-pane__scroll qx-stack qx-stack--tight">
        {error ? (
          <div className="qx-banner qx-banner--error" role="alert">
            <span>Could not load notes. {error}</span>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onRetry}>Retry</button>
          </div>
        ) : loading && notes.length === 0 ? (
          [0, 1, 2, 3].map((i) => (
            <div key={i} className="qx-stack qx-stack--tight" aria-hidden="true">
              <div className="qx-skeleton qx-skeleton--line-md" /><div className="qx-skeleton qx-skeleton--line-sm" />
            </div>
          ))
        ) : notes.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__icon"><NotesIcon /></div>
            <div className="qx-empty__title">{hasFilters ? 'No notes match' : 'No notes yet'}</div>
            <div className="qx-empty__body">
              {hasFilters
                ? 'Clear the search or filters to see more.'
                : 'Create your first note with New note. Notes are markdown, and every Quox agent can search them through Qortex.'}
            </div>
          </div>
        ) : view !== 'list' ? (
          <NotesQProjection view={view} notes={notes} onOpen={onOpen || onSelect} selectedId={selectedId} />
        ) : (
          notes.map((n) => (
            <button key={n.id} type="button" onClick={() => onSelect(n.id)} onPointerEnter={() => onPrefetch?.(n.id)} onFocus={() => onPrefetch?.(n.id)}
              className={`nq-row-item qx-card qx-card--compact qx-card--lift${n.id === selectedId ? ' qx-enabled-glow' : ''}`}
              aria-current={n.id === selectedId ? 'true' : undefined}>
              <span className="nq-row-item__top">
                <span className="nq-row-item__title">{n.title || 'Untitled'}</span>
                {n.properties?.pinned ? <span title="Pinned"><PinIcon /></span> : null}
              </span>
              {n.excerpt ? <span className="nq-row-item__excerpt qx-hint">{n.excerpt}</span> : null}
              <span className="nq-row-item__tags">
                <span className={`qx-pill qx-pill--xs ${n.scope === 'org' ? 'qx-pill--info' : 'qx-pill--purple'}`}>{n.scope === 'org' ? 'Org' : 'Personal'}</span>
                {(n.tags || []).slice(0, 3).map((t) => <span key={t} className={tagChipClass(t)}>#{t}</span>)}
                <span className="qx-hint qx-hint--sm" style={{ marginLeft: 'auto' }}>{relativeTime(n.updated_at)}</span>
              </span>
            </button>
          ))
        )}
        {total > notes.length ? <div className="qx-hint qx-hint--sm">Showing {notes.length} of {total}.</div> : null}
      </div>
    </section>
  )
}
