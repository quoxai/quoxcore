/** Middle pane in Skills mode: client-side search over the org's skills. Read-only list; the editor lives in the doc pane. */
import { useMemo, useState } from 'react'
import { SearchIcon, BookOpenIcon, ChevronsLeftIcon } from './icons'
import { relativeTime } from './lib/listQuery'
import { tagChipClass } from './lib/tagHue'
import { filterSkills, editionChipClass, skillUpdated } from './lib/skillsView'

export default function NotesQSkillList({ skills, selectedId, onSelect, onCollapse }) {
  const [q, setQ] = useState('')
  const rows = useMemo(() => filterSkills(skills, q), [skills, q])
  return (
    <section className="nq-pane nq-pane--list qx-card qx-card--compact" aria-label="Skills">
      <div className="qx-row qx-row--apart qx-row--tight qx-row--wrap">
        <span className="qx-section-title">Skills</span>
        {onCollapse ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-wide-only" onClick={onCollapse} aria-label="Hide notes list" title="Hide list"><ChevronsLeftIcon /></button> : null}
      </div>
      <div className="qx-search-wrap">
        <span className="qx-search-wrap__icon"><SearchIcon /></span>
        <input className="qx-input" type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" />
      </div>
      <div className="nq-pane__scroll qx-stack qx-stack--tight">
        {rows.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__icon"><BookOpenIcon /></div>
            <div className="qx-empty__title">{q ? 'No skills match' : 'No skills yet'}</div>
            <div className="qx-empty__body">{q ? 'Clear the search to see more.' : 'Skills are owned by the Skills library. Propose one from a note to start.'}</div>
          </div>
        ) : rows.map((s) => (
          <button key={s.id} type="button" onClick={() => onSelect(s.id)}
            className={`nq-row-item qx-card qx-card--compact qx-card--lift${s.id === selectedId ? ' qx-enabled-glow' : ''}`}
            aria-current={s.id === selectedId ? 'true' : undefined}>
            <span className="nq-row-item__top"><span className="nq-row-item__title">{s.name}</span></span>
            {s.description ? (
              <span className="nq-row-item__excerpt qx-hint" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.description}</span>
            ) : null}
            <span className="nq-row-item__tags">
              <span className={editionChipClass(s.edition)}>{s.edition || 'experimental'}</span>
              {(s.tags || []).slice(0, 3).map((t) => <span key={t} className={tagChipClass(t)}>#{t}</span>)}
              <span className="qx-hint qx-hint--sm" style={{ marginLeft: 'auto' }}>{relativeTime(skillUpdated(s))}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
