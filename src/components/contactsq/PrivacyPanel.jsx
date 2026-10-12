/**
 * Privacy actions for one contact: download everything held about them (DSAR) and
 * erase them. Both are org-admin only; the server is the judge, a refusal is shown
 * in plain English. Erasure needs the contact's exact name typed back, then shows
 * the certificate (what was destroyed, what was NOT, when backups age out).
 */
import { useState } from 'react'
import { api, downloadJson } from './lib/api'
import { ERASE_REASONS, ERASE_SCOPES, PROPAGATION_SURFACES, canErase, describePropagation } from './lib/reasonCodes'
import { cardName } from './lib/names'
import { ErrorBanner, Field, fmtDate } from './shared'
import { DownloadIcon, ShieldIcon, TrashIcon } from './icons'

export function Certificate({ cert }) {
  if (!cert) return null
  return (
    <div className="qx-stack qx-stack--tight" role="status" aria-label="Erasure certificate">
      <div className="qx-banner qx-banner--success"><ShieldIcon />Erased. This certificate is the record that it happened.</div>
      <div className="qx-stat-row"><span>Certificate</span><span className="qx-stat__value--mono">{cert.erasure_id}</span></div>
      <div className="qx-stat-row"><span>Erased at</span><span>{fmtDate(cert.executed_at)}</span></div>
      <div className="qx-stat-row"><span>What was erased</span><span>{cert.scope === 'full' ? 'Everything' : 'Numbers and addresses only'}</span></div>
      <div className="qx-stat-row"><span>Fingerprint (SHA-256)</span><span className="qx-stat__value--mono" style={{ wordBreak: 'break-all' }}>{cert.sha256}</span></div>
      <h4 className="qx-section-title" style={{ margin: 0 }}>Where it went</h4>
      <ul className="qx-stack qx-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {Object.entries(cert.propagation || {}).map(([surface, state]) => (
          <li key={surface} className="qx-stat-row">
            <span>{PROPAGATION_SURFACES[surface] || surface}</span>
            <span className={state === 'NOT_PROPAGATED' ? 'qx-pill qx-pill--degraded' : undefined}>{describePropagation(state)}</span>
          </li>
        ))}
      </ul>
      <div><button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => downloadJson(`erasure-certificate-${cert.erasure_id}.json`, cert)}><DownloadIcon />Download certificate</button></div>
    </div>
  )
}

function Dsar({ card }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(null)
  const go = async () => {
    setBusy(true); setErr(null); setDone(null)
    try {
      const bundle = await api.getDsar(card.id)
      downloadJson(`dsar-${card.id}.json`, bundle)
      setDone(bundle.counts || {})
    } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Everything we hold about them</h3>
      <div>One file with their record, where each number came from, their consents, the call history and who or what was given access to them. This download is logged.</div>
      <ErrorBanner error={err} />
      {done ? <div className="qx-banner qx-banner--success" role="status">Downloaded. {done.leases ?? 0} access leases and {done.lease_uses ?? 0} uses included.</div> : null}
      <div><button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={go} disabled={busy}><DownloadIcon />{busy ? 'Preparing' : 'Download their data'}</button></div>
    </div>
  )
}

function Erase({ card, onErased }) {
  const [scope, setScope] = useState('full')
  const [reason, setReason] = useState('subject_request')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [cert, setCert] = useState(null)
  const held = (card.flags || []).includes('legal_hold')

  if (cert) return <Certificate cert={cert} />
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null)
    try {
      const r = await api.eraseContact(card.id, { scope, reason_code: reason })
      setCert(r.certificate)
      onErased?.()
    } catch (e2) { setErr(e2) } finally { setBusy(false) }
  }
  return (
    <form className="qx-stack qx-stack--tight" onSubmit={go} aria-label="Erase contact">
      <h3 className="qx-section-title" style={{ margin: 0 }}>Danger zone <span className="qx-severity qx-severity--critical">Cannot be undone</span></h3>
      <div>Erase this contact. Their record is destroyed and the same number or address can never be added back.</div>
      {held ? <div className="qx-banner qx-banner--warn" role="note">This contact is on legal hold, so it cannot be erased until the hold is removed.</div> : null}
      <ErrorBanner error={err} />
      <div className="qx-row qx-row--wrap">
        <Field label="What to erase" hint={ERASE_SCOPES.find((s) => s.key === scope)?.help}>
          <select className="qx-select" value={scope} onChange={(e) => setScope(e.target.value)}>{ERASE_SCOPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        </Field>
        <Field label="Why"><select className="qx-select" value={reason} onChange={(e) => setReason(e.target.value)}>{ERASE_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
      </div>
      <Field label={`Type "${cardName(card)}" to confirm`}>
        <input className="qx-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Confirm name" />
      </Field>
      <div><button type="submit" className="qx-btn qx-btn--danger qx-btn--sm" disabled={busy || held || !canErase(typed, cardName(card))}><TrashIcon />{busy ? 'Erasing' : 'Erase permanently'}</button></div>
    </form>
  )
}

export default function PrivacyPanel({ card, onChanged }) {
  if (card.status === 'erased') {
    return <div className="qx-empty"><div className="qx-empty__title">This contact has been erased</div><div className="qx-empty__body">Their details were destroyed and cannot be shown or exported. The erasure certificate was shown when it happened.</div></div>
  }
  return (
    <div className="qx-stack">
      <Dsar card={card} />
      <div className="qx-divider" style={{ margin: '28px 0' }} />
      <Erase card={card} onErased={onChanged} />
    </div>
  )
}
