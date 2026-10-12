/** Left pane: scope switch, filters, collections, tags, New note. */
import { useState } from 'react'
import NotesQPaneRail from './NotesQPaneRail'
import { PlusIcon, PinIcon, ArchiveIcon, NotesIcon, CheckIcon, XIcon, ChevronsLeftIcon, FilterIcon, UploadIcon, GearIcon, TemplateIcon, HeartbeatIcon, BookOpenIcon } from './icons'
import { tagChipClass } from './lib/tagHue'
import { defaultNewScope } from './lib/listQuery'

const SCOPE_OPTS = [['all', 'All'], ['user', 'Personal'], ['org', 'Org']]

export default function NotesQSidebar({ filters, facets, onFilters, onCreate, creating, onImport, onTemplate, onSettings, onHealth, skillsCount = null, skillsActive = false, onSkills, collapsed = false, onToggle }) {
  const [picking, setPicking] = useState(false)
  const [newScope, setNewScope] = useState('org')
  const set = (patch) => onFilters({ ...filters, ...patch })

  const startNew = () => { setNewScope(defaultNewScope(filters.scope)); setPicking(true) }

  if (collapsed) {
    return (
      <NotesQPaneRail className="nq-pane--side nq-pane--strip" icon={FilterIcon} label="Filters" expandLabel="Show filters" onExpand={onToggle}>
        <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={creating}
          onClick={(e) => { e.stopPropagation(); onCreate(defaultNewScope(filters.scope)) }} aria-label="New note" title="New note"><PlusIcon /></button>
      </NotesQPaneRail>
    )
  }

  return (
    <aside className="nq-pane nq-pane--side qx-card qx-card--compact" aria-label="Notebook filters">
      <div className="qx-row qx-row--apart qx-row--tight qx-row--wrap">
        <span className="qx-section-title">Filters</span>
        {onToggle ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-wide-only" onClick={onToggle} aria-label="Hide filters" title="Hide filters"><ChevronsLeftIcon /></button> : null}
      </div>
      <div className="nq-new-row">
        {!picking ? (
          <button type="button" className="qx-btn qx-btn--primary" onClick={startNew}>
            <PlusIcon /> New note
          </button>
        ) : (
          <>
            <div className="qx-seg" role="group" aria-label="New note scope">
              {[['user', 'Personal'], ['org', 'Org']].map(([v, l]) => (
                <button key={v} type="button" className={`qx-seg__btn${newScope === v ? ' qx-seg__btn--active' : ''}`} onClick={() => setNewScope(v)}>{l}</button>
              ))}
            </div>
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={creating} onClick={() => { setPicking(false); onCreate(newScope) }}>
                <CheckIcon /> Create
              </button>
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPicking(false)}>
                <XIcon /> Cancel
              </button>
            </div>
          </>
        )}
        {onTemplate && !picking ? (
          <button type="button" className="qx-btn qx-btn--ghost" onClick={onTemplate}>
            <TemplateIcon /> From template
          </button>
        ) : null}
        {onImport && !picking ? (
          <button type="button" className="qx-btn qx-btn--ghost" onClick={onImport}>
            <UploadIcon /> Import
          </button>
        ) : null}
        {onSettings && !picking ? (
          <button type="button" className="qx-btn qx-btn--ghost" onClick={onSettings} aria-label="NotesQ settings" title="NotesQ settings">
            <GearIcon /> Settings
          </button>
        ) : null}
        {onHealth && !picking ? (
          <button type="button" className="qx-btn qx-btn--ghost" onClick={onHealth} aria-label="Notebook health" title="Notebook health">
            <HeartbeatIcon /> Health
          </button>
        ) : null}
      </div>

      <div className="qx-seg" role="group" aria-label="Scope">
        {SCOPE_OPTS.map(([v, l]) => (
          <button key={v} type="button" className={`qx-seg__btn${filters.scope === v ? ' qx-seg__btn--active' : ''}`} onClick={() => set({ scope: v })}>{l}</button>
        ))}
      </div>

      <div className="nq-pane__scroll qx-stack qx-stack--compact">
        <div className="nq-facet-list qx-tabs qx-tabs--vert">
          <button type="button" className={`qx-tab${!filters.collection && !filters.tag && !filters.pinned && filters.archived === 'exclude' ? ' qx-tab--active' : ''}`}
            onClick={() => set({ collection: '', tag: '', pinned: false, archived: 'exclude' })}>
            <span className="qx-row qx-row--tight"><NotesIcon /> All notes</span>
            <span className="qx-badge">{facets?.total ?? 0}</span>
          </button>
          <button type="button" className={`qx-tab${filters.pinned ? ' qx-tab--active' : ''}`} onClick={() => set({ pinned: !filters.pinned })}>
            <span className="qx-row qx-row--tight"><PinIcon /> Pinned</span>
            <span className="qx-badge">{facets?.pinned ?? 0}</span>
          </button>
          <button type="button" className={`qx-tab${filters.archived === 'only' ? ' qx-tab--active' : ''}`}
            onClick={() => set({ archived: filters.archived === 'only' ? 'exclude' : 'only' })}>
            <span className="qx-row qx-row--tight"><ArchiveIcon /> Archived</span>
            <span className="qx-badge">{facets?.archived ?? 0}</span>
          </button>
        </div>

        <div className="qx-section-title">Collections</div>
        {(facets?.collections || []).length === 0 ? (
          <div className="qx-hint qx-hint--sm">No collections yet. Set one in a note&apos;s properties.</div>
        ) : (
          <div className="nq-facet-list qx-tabs qx-tabs--vert">
            {facets.collections.map((c) => (
              <button key={c.name} type="button" className={`qx-tab${filters.collection === c.name ? ' qx-tab--active' : ''}`}
                onClick={() => set({ collection: filters.collection === c.name ? '' : c.name })}>
                <span>{c.name}</span><span className="qx-badge">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        {skillsCount != null && onSkills ? (
          <>
            <div className="qx-section-title">Skills</div>
            <div className="nq-facet-list qx-tabs qx-tabs--vert">
              <button type="button" className={`qx-tab${skillsActive ? ' qx-tab--active' : ''}`} aria-pressed={skillsActive} onClick={onSkills}>
                <span className="qx-row qx-row--tight"><BookOpenIcon /> Skills</span>
                <span className="qx-badge">{skillsCount}</span>
              </button>
            </div>
          </>
        ) : null}

        <div className="qx-section-title">Tags</div>
        {(facets?.tags || []).length === 0 ? (
          <div className="qx-hint qx-hint--sm">No tags yet.</div>
        ) : (
          <div className="qx-row qx-row--wrap qx-row--tight">
            {facets.tags.map((t) => (
              <button key={t.tag} type="button" className={`${tagChipClass(t.tag).replace('qx-chip--static', 'qx-chip--toggle')}${filters.tag === t.tag ? ' qx-chip--active' : ''}`} aria-pressed={filters.tag === t.tag}
                onClick={() => set({ tag: filters.tag === t.tag ? '' : t.tag })}>
                #{t.tag} {t.count}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
