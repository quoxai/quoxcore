/**
 * Property projections of the notes already loaded for the list: table, cards, timeline.
 * Read-only display (no inline editing); opening a row or card selects the note.
 */
import { useMemo, useState } from 'react'
import { relativeTime } from './lib/listQuery'
import { tagChipClass } from './lib/tagHue'
import {
  BASE_COLUMNS, COLUMN_LABELS, cellText, cellValue, discoverColumns, discoverDateKeys, sortNotes, nextSort, groupNotes, bucketTimeline,
} from './lib/propertyViews'

const GROUP_LABELS = { none: 'None', collection: 'Collection', type: 'Type', status: 'Status' }

function Chips({ note }) {
  const type = cellText(note, 'type'); const status = cellText(note, 'status')
  return (
    <>
      {type ? <span className="qx-pill qx-pill--xs qx-pill--info">{type}</span> : null}
      {status ? <span className="qx-pill qx-pill--xs">{status}</span> : null}
    </>
  )
}

function TableView({ notes, onOpen, selectedId }) {
  const extra = useMemo(() => discoverColumns(notes), [notes])
  const [picked, setPicked] = useState([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sort, setSort] = useState({ key: 'updated', dir: 'desc' })
  const columns = [...BASE_COLUMNS, ...picked.filter((k) => extra.includes(k))]
  const rows = useMemo(() => sortNotes(notes, sort.key, sort.dir), [notes, sort])
  const toggle = (k) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))
  const label = (k) => COLUMN_LABELS[k] || k
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--tight qx-row--wrap">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)}>Columns</button>
        {pickerOpen ? (
          extra.length ? (
            <span className="qx-row qx-row--tight qx-row--wrap" role="group" aria-label="Property columns">
              {extra.map((k) => (
                <label key={k} className="qx-row qx-row--tight qx-hint">
                  <input type="checkbox" checked={picked.includes(k)} onChange={() => toggle(k)} /> {k}
                </label>
              ))}
            </span>
          ) : <span className="qx-hint qx-hint--sm">No other properties found in these notes. Add front-matter keys to a note to show them here.</span>
        ) : null}
      </div>
      <div className="nq-table-wrap">
        <table className="qx-table">
          <thead>
            <tr>
              {columns.map((k) => (
                <th key={k} scope="col" aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="nq-th-sort" onClick={() => setSort((s) => nextSort(s, k))}>
                    {label(k)}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} className={n.id === selectedId ? 'qx-enabled-glow' : undefined} onClick={() => onOpen(n.id)}>
                {columns.map((k) => (
                  <td key={k}>
                    {k === 'title' ? (
                      <button type="button" className="nq-cell-link" onClick={(e) => { e.stopPropagation(); onOpen(n.id) }}>{n.title || 'Untitled'}</button>
                    ) : k === 'updated' ? relativeTime(n.updated_at) : k === 'tags' ? (
                      <span className="nq-row-item__tags">{(cellValue(n, 'tags') || []).map((t) => <span key={t} className={tagChipClass(t)}>#{t}</span>)}</span>
                    ) : cellText(n, k)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NoteCard({ n, onOpen, selectedId }) {
  return (
    <button type="button" onClick={() => onOpen(n.id)} aria-current={n.id === selectedId ? 'true' : undefined}
      className={`nq-row-item qx-card qx-card--compact qx-card--lift${n.id === selectedId ? ' qx-enabled-glow' : ''}`}>
      <span className="nq-row-item__top"><span className="nq-row-item__title">{n.title || 'Untitled'}</span></span>
      {n.excerpt ? <span className="nq-row-item__excerpt nq-clamp3 qx-hint">{n.excerpt}</span> : null}
      <span className="nq-row-item__tags">
        {cellText(n, 'collection') ? <span className="qx-pill qx-pill--xs qx-pill--purple">{cellText(n, 'collection')}</span> : null}
        <Chips note={n} />
        {(n.tags || []).slice(0, 3).map((t) => <span key={t} className={tagChipClass(t)}>#{t}</span>)}
        <span className="qx-hint qx-hint--sm" style={{ marginLeft: 'auto' }}>{relativeTime(n.updated_at)}</span>
      </span>
    </button>
  )
}

function CardsView({ notes, onOpen, selectedId }) {
  const [by, setBy] = useState('none')
  const groups = useMemo(() => groupNotes(notes, by), [notes, by])
  return (
    <div className="qx-stack qx-stack--tight">
      <label className="qx-row qx-row--tight qx-hint nq-nowrap">Group by
        <select className="qx-select" value={by} onChange={(e) => setBy(e.target.value)} aria-label="Group by">
          {Object.entries(GROUP_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {groups.map((g) => (
        <section key={g.key} className="qx-stack qx-stack--tight" aria-label={g.label || 'Notes'}>
          {by !== 'none' ? <h3 className="qx-section-title">{g.label} <span className="qx-hint qx-hint--sm">({g.notes.length})</span></h3> : null}
          <div className="nq-cards-grid">{g.notes.map((n) => <NoteCard key={n.id} n={n} onOpen={onOpen} selectedId={selectedId} />)}</div>
        </section>
      ))}
    </div>
  )
}

function TimelineView({ notes, onOpen, selectedId, now }) {
  const dateKeys = useMemo(() => discoverDateKeys(notes), [notes])
  const [source, setSource] = useState('updated')
  const src = source === 'updated' || dateKeys.includes(source) ? source : 'updated'
  const { days, undated } = useMemo(() => bucketTimeline(notes, src, now), [notes, src, now])
  return (
    <div className="qx-stack qx-stack--tight">
      <label className="qx-row qx-row--tight qx-hint nq-nowrap">Date
        <select className="qx-select" value={src} onChange={(e) => setSource(e.target.value)} aria-label="Date">
          <option value="updated">Updated</option>
          {dateKeys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      {days.map((d) => (
        <section key={d.key} className="qx-stack qx-stack--tight" aria-label={d.label}>
          <h3 className="qx-section-title">{d.label}{d.label !== d.key ? <span className="qx-hint qx-hint--sm"> {d.key}</span> : null}</h3>
          {d.notes.map((n) => <NoteCard key={n.id} n={n} onOpen={onOpen} selectedId={selectedId} />)}
        </section>
      ))}
      {undated.length ? (
        <section className="qx-stack qx-stack--tight" aria-label="No date">
          <h3 className="qx-section-title">No date <span className="qx-hint qx-hint--sm">({undated.length})</span></h3>
          {undated.map((n) => <NoteCard key={n.id} n={n} onOpen={onOpen} selectedId={selectedId} />)}
        </section>
      ) : null}
    </div>
  )
}

export default function NotesQProjection({ view, notes, onOpen, selectedId, now }) {
  if (view === 'table') return <TableView notes={notes} onOpen={onOpen} selectedId={selectedId} />
  if (view === 'cards') return <CardsView notes={notes} onOpen={onOpen} selectedId={selectedId} />
  if (view === 'timeline') return <TimelineView notes={notes} onOpen={onOpen} selectedId={selectedId} now={now} />
  return null
}
