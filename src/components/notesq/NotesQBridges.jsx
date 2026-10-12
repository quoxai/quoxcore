/** Details-rail wires (AQ-9D P4): send a note's open tasks to Action-Q, add the note to a QuoxPlan stream. Mirrors `quox notes actions | promote`. */
import { useEffect, useState } from 'react'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { createActionStrict } from '../../services/actionsService'
import { api as planApi } from '../../services/quoxplanApiClient'
import { api } from './lib/api'
import { extractTasks, splitSent, actionBody, promoteBody, noteLink } from './lib/noteBridges'
import { SendIcon, RouteIcon, NotesIcon, CheckIcon, XIcon, SearchIcon } from './icons'

// Rendered in tests and shells that have no workspace provider; fall back to no org rather than crash.
function useOrgId() {
  try { return useWorkspace()?.currentOrg?.id || null } catch { return null }
}

const failText = (e) => (e?.diagnostic ? `${e.message}: ${String(e.diagnostic).slice(0, 120)}` : (e?.message || 'failed'))

export function SendTasks({ note, onBridged }) {
  const orgId = useOrgId()
  const [tasks, setTasks] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [err, setErr] = useState('')
  const props = note.properties || {}

  useEffect(() => {
    let live = true
    extractTasks(note.markdown).then((t) => { if (live) setTasks(t) })
    return () => { live = false }
  }, [note.markdown])

  const { fresh, sent } = splitSent(tasks || [], props)
  const send = async () => {
    setBusy(true); setErr(''); setDone(null)
    let created = []
    let stage = 'create'
    let pending = null
    try {
      // Work from the server copy, as the CLI does, so the bookkeeping PUT carries the right hash.
      const { note: cur } = await api.getNote(note.id)
      const curProps = cur.properties || {}
      const toSend = splitSent(await extractTasks(cur.markdown), curProps).fresh
      const base = Array.isArray(curProps.actions_extracted) ? curProps.actions_extracted : []
      pending = { cur, curProps, base }
      try {
        for (const t of toSend) {
          await createActionStrict(orgId, actionBody(t, { id: note.id, title: cur.title || note.title }))
          created.push(t)
        }
      } catch (e) { pending.createErr = e }
      if (created.length) {
        stage = 'record'
        const r = await api.updateNote(note.id, { markdown: cur.markdown, properties: { ...curProps, actions_extracted: [...base, ...created.map((c) => c.hash)] }, base_hash: cur.content_hash })
        onBridged?.(r?.note)
      }
      if (pending.createErr) setErr(`Stopped after ${created.length} of ${toSend.length}. ${failText(pending.createErr)}`)
      if (created.length) setDone(created.length)
    } catch (e) {
      if (stage === 'record') {
        setErr(e.status === 409
          ? `${created.length} added to Action-Q, but recording them on this note failed because the note changed meanwhile. Sending again would add them twice.`
          : `${created.length} added to Action-Q, but recording them on this note failed (${e.message}). Sending again would add them twice.`)
      } else setErr(failText(e))
    } finally { setBusy(false) }
  }

  const n = fresh.length
  const hint = tasks === null ? 'Looking for open tasks.'
    : tasks.length === 0 ? 'No open tasks. Add lines like "- [ ] call the bank" to send them.'
      : n === 0 ? `All ${tasks.length} open task${tasks.length === 1 ? '' : 's'} already sent.`
        : `${n} open task${n === 1 ? '' : 's'} to send${sent ? `, ${sent} already sent` : ''}.`
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-section-title">Action-Q</div>
      <div className="qx-hint qx-hint--sm" data-testid="nq-send-hint">{hint}</div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {done ? <div className="qx-banner qx-banner--success" role="status">{done} added to Action-Q. <a href="/actions">Open Action-Q</a></div> : null}
      <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy || n === 0 || !orgId} title={n === 0 ? hint : undefined} onClick={send}>
        <SendIcon /> {busy ? 'Sending' : 'Send tasks to Action-Q'}
      </button>
    </div>
  )
}

export function AddToPlan({ note, properties, onBridged }) {
  const [open, setOpen] = useState(false)
  const [streams, setStreams] = useState(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [added, setAdded] = useState(null)

  useEffect(() => {
    if (!open || streams) return undefined
    let live = true
    ;(async () => {
      try {
        const { roadmaps } = await planApi.listRoadmaps()
        const lists = await Promise.all((roadmaps || []).map((r) => planApi.listStreams(r.id, 'all')))
        const all = lists.flatMap((l) => l.streams || [])
        if (live) setStreams(all)
      } catch (e) { if (live) { setErr(`Could not load QuoxPlan streams. ${e.message}`); setStreams([]) } }
    })()
    return () => { live = false }
  }, [open, streams])

  const needle = q.trim().toLowerCase()
  const matches = (streams || []).filter((s) => !needle || String(s.id).toLowerCase().includes(needle) || String(s.name || '').toLowerCase().includes(needle)).slice(0, 8)

  const promote = async (s) => {
    setBusy(true); setErr(''); setAdded(null)
    let posted = false
    try {
      const { note: cur } = await api.getNote(note.id)
      await planApi.addNote(s.id, promoteBody({ title: cur.title || note.title, markdown: cur.markdown }, noteLink(note.id)), 'quox-dashboard')
      posted = true
      const curProps = cur.properties || {}
      const to = [...new Set([...(Array.isArray(curProps.promoted_to) ? curProps.promoted_to : []), s.id])]
      const r = await api.updateNote(note.id, { markdown: cur.markdown, properties: { ...curProps, promoted_to: to }, base_hash: cur.content_hash })
      onBridged?.(r?.note)
      setAdded(s.name ? `${s.id} (${s.name})` : s.id); setOpen(false); setQ('')
    } catch (e) {
      if (posted) { setAdded(s.id); setErr(`Added to ${s.id}, but recording it on this note failed${e.status === 409 ? ' because the note changed meanwhile' : ` (${e.message})`}.`) }
      else setErr(failText(e))
    } finally { setBusy(false) }
  }

  const prior = Array.isArray(properties?.promoted_to) ? properties.promoted_to : []
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-section-title">QuoxPlan</div>
      {prior.length ? <div className="qx-row qx-row--tight">{prior.map((id) => <span key={id} className="qx-chip">{id}</span>)}</div> : null}
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {added ? <div className="qx-banner qx-banner--success" role="status">Added to {added}.</div> : null}
      {open ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-field">
            <label className="qx-field__label" htmlFor="nq-plan-q"><SearchIcon /> Find a stream</label>
            <input id="nq-plan-q" className="qx-input" value={q} placeholder="Stream id or name" onChange={(e) => setQ(e.target.value)} />
          </div>
          {streams === null ? <div className="qx-skeleton qx-skeleton--line-md" aria-hidden="true" /> : null}
          {streams && matches.length === 0 && !err ? <div className="qx-hint qx-hint--sm">No matching streams.</div> : null}
          {matches.map((s) => (
            <button key={s.id} type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => promote(s)}>
              <CheckIcon /> {s.id}{s.name ? ` ${s.name}` : ''}
            </button>
          ))}
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setOpen(false)}><XIcon /> Cancel</button>
        </div>
      ) : (
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => { setErr(''); setAdded(null); setOpen(true) }}><RouteIcon /> Add to QuoxPlan</button>
      )}
    </div>
  )
}

// AQ-9D P5: propose the note (an SOP) as a skill. Never auto: the skill waits in the review queue.
// The note carries flat proposed_skill_* properties (brain properties are scalars only).
export function ProposeSkill({ note, properties, dirty = false, onRefresh }) {
  const [plan, setPlan] = useState(null) // dry_run payload while the confirm is open
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [proposed, setProposed] = useState(null)

  useEffect(() => { setPlan(null); setErr(''); setProposed(null) }, [note.id])

  const priorName = properties?.proposed_skill_name || null
  const doneName = proposed || priorName
  const tooShort = (e) => (e?.body?.error === 'too_short' ? 'This note is too short to be a skill. Write out the steps first (at least 50 words).' : failText(e))

  const preview = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.proposeSkill(note.id, { dry_run: true })
      setPlan(r.payload)
    } catch (e) { setErr(tooShort(e)) } finally { setBusy(false) }
  }
  const propose = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.proposeSkill(note.id)
      setProposed(r.skill.name); setPlan(null)
      if (r.note_updated) await onRefresh?.()
      else setErr('The skill was created, but this note changed meanwhile so the link was not saved on it.')
    } catch (e) { setErr(tooShort(e)); setPlan(null) } finally { setBusy(false) }
  }

  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-section-title">Skills</div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{err}</div> : null}
      {doneName ? (
        <div className="qx-banner qx-banner--success" role="status" data-testid="nq-skill-done">Proposed as {doneName}, experimental</div>
      ) : plan ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-hint qx-hint--sm">Propose this note as the skill <strong>{plan.name}</strong>?</div>
          <div className="qx-hint qx-hint--sm">It lands as an experimental skill, outside the stable library. An automated safety check reviews it, and anything it flags goes to the human review queue.</div>
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" disabled={busy} onClick={propose}><CheckIcon /> {busy ? 'Proposing' : 'Propose for review'}</button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy} onClick={() => setPlan(null)}><XIcon /> Cancel</button>
        </div>
      ) : (
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy || dirty} title={dirty ? 'Save the note first.' : undefined} onClick={preview}>
          <NotesIcon /> {busy ? 'Checking' : 'Propose as skill'}
        </button>
      )}
    </div>
  )
}
