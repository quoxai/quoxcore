/**
 * Facts about one contact. Agents can only suggest a fact; it waits here as "Needs review"
 * until a person confirms, edits or rejects it. Sensitive categories are flagged and are
 * never given to an agent. Facts a person adds themselves are confirmed straight away.
 */
import { Fragment, useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { REVIEW_STATES, SENSITIVITIES, explainError } from './lib/reasonCodes'
import { AsyncGuard, ErrorBanner, Field, fmtDate } from './shared'
import { CheckIcon, EditIcon, PlusIcon, XIcon } from './icons'

/** Proposed first, then confirmed, then rejected; stable within each group. Exported for tests. */
export function orderFacts(facts) {
  const rank = { proposed: 0, confirmed: 1, rejected: 2 }
  return [...facts].sort((a, b) => (rank[a.review_state] ?? 3) - (rank[b.review_state] ?? 3))
}

function FactRow({ contactId, fact, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({ key: fact.key, value: fact.value || '' })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const sens = SENSITIVITIES[fact.sensitivity] || SENSITIVITIES.normal
  const state = REVIEW_STATES[fact.review_state] || REVIEW_STATES.proposed

  const send = async (body) => {
    setBusy(true); setErr(null)
    try { await api.updateFact(contactId, fact.id, body); setEditing(false); onChanged() } catch (e) { setErr(e) } finally { setBusy(false) }
  }

  return (
    <li className="qx-stack qx-stack--tight" style={{ listStyle: 'none' }}>
      <div className="qx-row qx-row--apart qx-row--wrap">
        <span className="qx-row qx-row--tight qx-row--wrap">
          <strong>{fact.key}</strong>
          <span className={`qx-pill qx-pill--xs ${state.pill}`}>{state.label}</span>
          {fact.sensitivity !== 'normal' ? <span className={`qx-pill qx-pill--xs ${sens.pill}`} title={sens.help}>{sens.label}</span> : null}
        </span>
        <span className="qx-stat__value--mono">{fact.expires_at ? `until ${fmtDate(fact.expires_at)}` : ''}</span>
      </div>
      {editing ? (
        <div className="qx-stack qx-stack--compact">
          <div className="qx-row qx-row--wrap">
            <Field label="Label"><input className="qx-input" value={f.key} maxLength={64} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
            <Field label="Fact"><input className="qx-input" value={f.value} maxLength={1000} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          </div>
          <div className="qx-row qx-row--end qx-row--tight">
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setEditing(false)}><XIcon />Cancel</button>
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !f.key.trim() || !f.value.trim()} onClick={() => send({ key: f.key.trim(), value: f.value.trim() })}><CheckIcon />Save</button>
          </div>
        </div>
      ) : (
        <div>{fact.value}</div>
      )}
      <ErrorBanner error={err && { ...err, message: explainError(err) }} />
      {!editing ? (
        <div className="qx-row qx-row--wrap qx-row--tight">
          {fact.review_state !== 'confirmed' ? <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy} onClick={() => send({ review_state: 'confirmed' })}><CheckIcon />Confirm</button> : null}
          {fact.review_state !== 'rejected' ? <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => send({ review_state: 'rejected' })}><XIcon />Reject</button> : null}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => setEditing(true)}><EditIcon />Edit</button>
        </div>
      ) : null}
    </li>
  )
}

function AddFact({ contactId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ key: '', value: '' })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!open) return <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(true)}><PlusIcon />Add a fact</button></div>
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try { await api.addFact(contactId, { key: f.key.trim(), value: f.value.trim() }); setF({ key: '', value: '' }); setOpen(false); onAdded() } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add a fact">
      <ErrorBanner error={err && { ...err, message: explainError(err) }} />
      <div className="qx-row qx-row--wrap">
        <Field label="Label" hint="For example preferred contact time."><input className="qx-input" value={f.key} maxLength={64} required onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
        <Field label="Fact"><input className="qx-input" value={f.value} maxLength={1000} required onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
      </div>
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy || !f.key.trim() || !f.value.trim()}><PlusIcon />{busy ? 'Saving' : 'Save'}</button>
      </div>
    </form>
  )
}

export default function FactsPanel({ contactId, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.getFacts(contactId), [contactId])
  const facts = orderFacts(data?.facts || [])
  const pending = facts.filter((x) => x.review_state === 'proposed').length
  const changed = () => { reload(); onChanged?.() }
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Facts</h3>
      <div>Things worth remembering about them. An agent can suggest a fact, but nothing is used until you confirm it. Sensitive facts (health, religion and similar) are flagged and are never shown to an agent.</div>
      {pending ? <div className="qx-banner qx-banner--info" role="status">{pending} suggested {pending === 1 ? 'fact needs' : 'facts need'} your review.</div> : null}
      <AsyncGuard error={error} loading={loading && !data} onRetry={reload} rows={3} what="Facts">
        {facts.length === 0 ? (
          <div className="qx-empty"><div className="qx-empty__body">No facts yet. Agents will suggest them after conversations, or add one yourself.</div></div>
        ) : (
          <ul className="qx-stack" style={{ margin: 0, padding: 0 }} aria-label="Facts">{facts.map((x, i) => <Fragment key={x.id}>{i > 0 ? <li className="qx-divider" role="separator" style={{ margin: 0 }} /> : null}<FactRow contactId={contactId} fact={x} onChanged={changed} /></Fragment>)}</ul>
        )}
      </AsyncGuard>
      <AddFact contactId={contactId} onAdded={changed} />
    </div>
  )
}
