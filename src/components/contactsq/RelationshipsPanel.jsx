/** Who this contact is connected to: employer, manager, family. Graph edges, human-edited. */
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { useAsync } from './lib/useAsync'
import { buildEdgeBody, describeEdge, pickerKind, resolveTarget } from './lib/graph'
import { EDGE_TYPES, explainError } from './lib/reasonCodes'
import { AsyncGuard, Field, FormGrid } from './shared'
import { LinkIcon, PlusIcon, TrashIcon, XIcon } from './icons'

/**
 * Type a name: matching contacts appear as you type (pick one), or keep the typed name and it is created on Add.
 * No separate Search step, and the Add button says what it will do.
 */
function NamePicker({ kind, selfId, typed, setTyped, picked, onPick, results, setResults }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const q = typed.trim()
    if (picked || q.length < 2) { setResults([]); return undefined }
    let live = true
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const r = await api.search(q)
        if (live) setResults((r.candidates || []).filter((c) => c.id !== selfId && (!kind || c.kind === kind)).slice(0, 6))
      } catch { if (live) setResults([]) } finally { if (live) setBusy(false) }
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [typed, picked, kind, selfId, setResults])
  const noun = kind === 'organisation' ? 'Organisation' : 'Name'
  if (picked) {
    return (
      <Field label={noun}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span className="qx-chip" role="status"><LinkIcon />{picked.display_name}</span>
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => onPick(null)}><XIcon />Change</button>
        </div>
      </Field>
    )
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <Field label={noun} hint={kind === 'organisation' ? 'Type the organisation. Pick a match below, or keep typing to add a new one.' : 'Type a name. Pick a match below, or keep typing to add a new contact.'}>
        <input className="qx-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={kind === 'organisation' ? 'Organisation name' : 'Their name'} autoComplete="off" aria-label={noun} autoFocus />
      </Field>
      {busy ? <span className="qx-hint qx-hint--sm">Looking for matches</span> : null}
      {results.length ? (
        <ul className="qx-row qx-row--wrap qx-row--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Matches">
          {results.map((c) => (
            <li key={c.id}><button type="button" className="qx-btn qx-btn--sm" onClick={() => onPick(c)}><LinkIcon />{c.display_name}</button></li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function AddEdge({ contactId, onAdded }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('works_at')
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState(null)
  const [results, setResults] = useState([])
  const [role, setRole] = useState('')
  const [dept, setDept] = useState('')
  const [label, setLabel] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!open) return <div><button type="button" className="qx-btn qx-btn--sm" onClick={() => setOpen(true)}><PlusIcon />Add a relationship</button></div>
  const kind = pickerKind(type)
  const target = resolveTarget({ picked, typed, results, kind })
  const reset = () => { setOpen(false); setPicked(null); setTyped(''); setResults([]); setRole(''); setDept(''); setLabel(''); setErr(null) }
  const submit = async (e) => {
    e.preventDefault()
    if (target.mode === 'none') { setErr(new Error(kind === 'organisation' ? 'Type the organisation first.' : 'Type a name first.')); return }
    setBusy(true); setErr(null)
    try {
      let toId = target.id
      if (target.mode === 'create') {
        const r = await api.createContact({ kind: target.kind, display_name: target.name })
        toId = r.contact.id
      }
      await api.addEdge(contactId, buildEdgeBody({ type, toId, role, dept, label }))
      reset(); onAdded()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  const action = target.mode === 'create' ? `Add ${target.name}` : 'Add'
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={submit} aria-label="Add relationship">
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <FormGrid>
        <Field label="Relationship" span={4} spanSm={12}>
          <select className="qx-select" value={type} onChange={(e) => { setType(e.target.value); setPicked(null); setResults([]) }}>{EDGE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.out}</option>)}</select>
        </Field>
        <div style={{ '--span': 8, '--span-sm': 12 }}>
          <NamePicker kind={kind} selfId={contactId} typed={typed} setTyped={setTyped} picked={picked} onPick={setPicked} results={results} setResults={setResults} />
        </div>
        {type === 'works_at' ? (
          <>
            <Field label="Job title" span={6} spanSm={12}><input className="qx-input" value={role} maxLength={100} onChange={(e) => setRole(e.target.value)} /></Field>
            <Field label="Department" hint="Optional." span={6} spanSm={12}><input className="qx-input" value={dept} maxLength={100} onChange={(e) => setDept(e.target.value)} /></Field>
          </>
        ) : null}
        {type === 'related_to' ? <Field label="How are they related?" span={12}><input className="qx-input" value={label} maxLength={100} placeholder="For example spouse, business partner" onChange={(e) => setLabel(e.target.value)} /></Field> : null}
      </FormGrid>
      {target.mode === 'create' ? <div className="qx-hint qx-hint--sm" role="status">{target.name} is not in your contacts yet: Add creates {target.kind === 'organisation' ? 'the organisation' : 'them'} and links them.</div> : null}
      {type === 'works_at' ? <div className="qx-hint qx-hint--sm">If their organisation opts out of marketing, that opt-out covers them too.</div> : null}
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--sm" onClick={reset}><XIcon />Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy}><PlusIcon />{busy ? 'Adding' : action}</button>
      </div>
    </form>
  )
}

export default function RelationshipsPanel({ contactId, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.getEdges(contactId), [contactId])
  const [err, setErr] = useState(null)
  const edges = data?.edges || []
  const changed = () => { reload(); onChanged?.() }
  const remove = async (id) => {
    setErr(null)
    try { await api.removeEdge(contactId, id); changed() } catch (e) { setErr(e) }
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Relationships</h3>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      <AsyncGuard error={error} loading={loading} onRetry={reload} rows={2} what="Relationships">
        {edges.length === 0 ? (
          <div className="qx-empty"><div className="qx-empty__body">No relationships yet. Link this person to where they work, who they report to, or who they are related to.</div></div>
        ) : (
          <ul className="qx-stack qx-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Relationships">
            {edges.map((e) => {
              const d = describeEdge(e)
              return (
                <li key={e.id} className="qx-stat-row">
                  <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}><LinkIcon />{d.text}</span>
                  <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-label={`Remove: ${d.text}`} onClick={() => remove(e.id)}><TrashIcon />Remove</button>
                </li>
              )
            })}
          </ul>
        )}
      </AsyncGuard>
      <AddEdge contactId={contactId} onAdded={changed} />
    </div>
  )
}
