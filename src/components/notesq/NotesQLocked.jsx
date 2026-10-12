/**
 * NotesQLocked: the unentitled state for /notes. Mirrors InboxQLocked
 * (steps, then one CTA) but composes qx-* globals only.
 */
import { useNavigate } from 'react-router-dom'
import { NotesIcon, PlusIcon, SearchIcon, HistoryIcon, EditIcon } from './icons'
import MANIFEST from '../../config/plugins/notesq.json'  // price from the manifest, never a hard-coded string (drifted to 'bundle'/'Included' while the store charged)

const STEPS = [
  { title: 'Write', body: 'Markdown notes with collections, tags and properties, personal or shared with your org.', icon: <EditIcon size={18} /> },
  { title: 'Trust', body: 'Every save is a revision. Compare, restore, and see who or what changed a note.', icon: <HistoryIcon size={18} /> },
  { title: 'Find', body: 'Notes are searchable by every Quox agent through Qortex, so what you write gets used.', icon: <SearchIcon size={18} /> },
]

export default function NotesQLocked({ priceDisplay = MANIFEST.priceDisplay }) {
  const navigate = useNavigate()
  return (
    <div className="qx-view">
      <section className="qx-card qx-stack" style={{ alignItems: 'center', textAlign: 'center', padding: '40px 24px' }}>
        <span className="qx-avatar qx-avatar--lg qx-avatar--ring" aria-hidden="true"><NotesIcon size={26} /></span>
        <span className="qx-badge">NotesQ &middot; not yet activated</span>
        <h1 style={{ fontSize: 28, fontWeight: 650, letterSpacing: '-0.02em', margin: 0, textWrap: 'balance' }}>
          Markdown notes that feed the brain.
        </h1>
        <p style={{ maxWidth: 600, margin: 0, lineHeight: 1.6 }}>
          NotesQ is a notebook for you and your org. Collections, tags, properties, a full revision
          history, and every note searchable by your Quox agents.
        </p>
        <div className="qx-row qx-row--center qx-row--wrap qx-row--tight">
          {['Markdown', 'Collections and tags', 'Revision history', 'Qortex search'].map((f) => (
            <span key={f} className="qx-chip">{f}</span>
          ))}
        </div>
        <div className="qx-grid-3" style={{ textAlign: 'left', width: '100%', maxWidth: 780 }}>
          {STEPS.map((s) => (
            <div key={s.title} className="qx-card qx-card--compact qx-stack qx-stack--tight">
              <span className="qx-avatar qx-avatar--sm" aria-hidden="true">{s.icon}</span>
              <strong>{s.title}</strong>
              <span className="qx-hint">{s.body}</span>
            </div>
          ))}
        </div>
        <button type="button" className="qx-btn qx-btn--primary qx-btn--lg" onClick={() => navigate('/settings#plugins')}>
          <PlusIcon />
          Activate NotesQ{priceDisplay ? ` (${priceDisplay})` : ''}
        </button>
        <p className="qx-hint qx-hint--sm" style={{ margin: 0 }}>Manage plugins any time in Settings, Plugins.</p>
      </section>
    </div>
  )
}
