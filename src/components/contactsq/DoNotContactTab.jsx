/** Do-not-contact (was "Suppressions"): check a number or address, and add an entry. Only blind indexes are stored. */
import { useState } from 'react'
import { api } from './lib/api'
import { IDENTIFIER_CHANNELS, SUPPRESSION_REASONS, explainError, explainReason, labelOf } from './lib/reasonCodes'
import { Field, TabHeader } from './shared'
import { BanIcon, SearchIcon } from './icons'

function Check() {
  const [f, setF] = useState({ channel: 'phone', value: '' })
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setRes(null)
    try { setRes(await api.checkSuppression(f)) } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={run} aria-label="Check do-not-contact">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Check a number or address</h3>
      <div className="qx-row qx-row--wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Type"><select className="qx-select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{IDENTIFIER_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
        <Field label="Value"><input className="qx-input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required autoComplete="off" /></Field>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy || !f.value.trim()}><SearchIcon />{busy ? 'Checking' : 'Check'}</button>
      </div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      {res ? (
        res.suppressed
          ? <div className="qx-banner qx-banner--warn" role="status">Suppressed. {(res.reasons || []).map((r) => SUPPRESSION_REASONS.find((s) => s.key === r)?.label || explainReason(r)).join(', ')}</div>
          : <div className="qx-banner qx-banner--success" role="status">Not on the do-not-contact list.</div>
      ) : null}
    </form>
  )
}

function Add() {
  const [f, setF] = useState({ channel: 'phone', value: '', reason: 'dnc' })
  const [done, setDone] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setDone(null)
    try {
      const r = await api.addSuppression(f)
      setDone(r.suppression || r)
      setF({ ...f, value: '' })
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--compact" onSubmit={run} aria-label="Add to do-not-contact">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Add to the do-not-contact list</h3>
      <div className="qx-row qx-row--wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Type"><select className="qx-select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{IDENTIFIER_CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
        <Field label="Value"><input className="qx-input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required autoComplete="off" /></Field>
        <Field label="Reason"><select className="qx-select" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{SUPPRESSION_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={busy || !f.value.trim()}><BanIcon />{busy ? 'Adding' : 'Add to list'}</button>
      </div>
      {err ? <div className="qx-banner qx-banner--error" role="alert">{explainError(err)}</div> : null}
      {done ? <div className="qx-banner qx-banner--success" role="status">Added: {labelOf(IDENTIFIER_CHANNELS, done.channel)}, {SUPPRESSION_REASONS.find((r) => r.key === done.reason)?.label || done.reason}.</div> : null}
    </form>
  )
}

export default function DoNotContactTab() {
  return (
    <section className="qx-card qx-stack" aria-label="Do-not-contact">
      <TabHeader icon={BanIcon} title="Do-not-contact" testId="dnc-explainer"
        subtitle="These are the numbers and email addresses we must never contact: people who objected, opted out, or asked to be erased. Each entry is kept as a one-way fingerprint (a hash), never the number or address itself, so the block still works after the person has been deleted, and the list cannot be read back. Use Check to test one." />
      <div className="qx-divider" />
      <Check />
      <div className="qx-divider" />
      <Add />
    </section>
  )
}
