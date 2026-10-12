/** Interaction history for one contact: refs and outcomes, summaries for people only. */
import { useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { describeTouchpoint } from './lib/graph'
import { SURFACES, DIRECTIONS, explainError } from './lib/reasonCodes'
import { AsyncGuard, Field, fmtDate } from './shared'
import { ClockIcon, PlusIcon } from './icons'

function LogForm({ contactId, onLogged }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ surface: 'manual', direction: 'inbound', outcome: '', summary: '' })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!open) return <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(true)}><PlusIcon />Log an interaction</button></div>
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      await api.logTouchpoint(contactId, {
        surface: f.surface, direction: f.direction, outcome: f.outcome.trim().toLowerCase().replace(/\s+/g, '_'),
        ...(f.summary.trim() ? { summary: f.summary.trim() } : {}),
      })
      setF({ surface: 'manual', direction: 'inbound', outcome: '', summary: '' }); setOpen(false); onLogged()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Log an interaction">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <div className="qx-row qx-row--wrap">
        <Field label="Where"><select className="qx-select" value={f.surface} onChange={(e) => setF({ ...f, surface: e.target.value })}>{SURFACES.filter((s) => s.key !== 'contactsq' && s.key !== 'agent').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
        <Field label="Direction"><select className="qx-select" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>{Object.entries(DIRECTIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Outcome" hint="A short word, for example answered or replied."><input className="qx-input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} required maxLength={48} /></Field>
      </div>
      <Field label="Summary" hint="Optional, up to 500 characters. Stored encrypted and shown only to signed-in people."><textarea className="qx-textarea" rows={2} maxLength={500} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !f.outcome.trim()}><PlusIcon />{busy ? 'Saving' : 'Save'}</button>
      </div>
    </form>
  )
}

export default function TimelinePanel({ contactId, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.getTimeline(contactId), [contactId])
  const rows = data?.timeline || []
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Timeline</h3>
      <AsyncGuard error={error} loading={loading} onRetry={reload} rows={3} what="The timeline">
        {rows.length === 0 ? (
          <div className="qx-empty"><div className="qx-empty__body">No interactions recorded yet. Calls, emails and messages appear here as they happen.</div></div>
        ) : (
          <ul className="qx-stack qx-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Interaction timeline">
            {rows.map((t) => {
              const d = describeTouchpoint(t)
              return (
                <li key={t.id} className="qx-stat-row">
                  <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    <ClockIcon />
                    <span>
                      <strong>{d.surface}</strong>{' · '}{d.direction}{d.outcome ? ` · ${d.outcome}` : ''}
                      {d.summary ? <span style={{ display: 'block' }}>{d.summary}</span> : null}
                    </span>
                  </span>
                  <span className="qx-stat__value--mono">{fmtDate(t.occurred_at)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </AsyncGuard>
      <LogForm contactId={contactId} onLogged={() => { reload(); onChanged?.() }} />
    </div>
  )
}
