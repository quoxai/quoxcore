/**
 * Import contacts from a CSV (including the Google Contacts export) or a vCard file.
 * Always a dry run first: the report shows counts and row numbers, never the contents.
 * Committing is a separate, deliberate click on the SAME file. Org admin only (the
 * server decides; a refusal is shown in plain English).
 */
import { useState } from 'react'
import { api } from './lib/api'
import { explainError } from './lib/reasonCodes'
import { describeInvalid, parseMappingText, reportRows } from './lib/importReport'
import { ErrorBanner, Field } from './shared'
import { CheckIcon, PlayIcon, UploadIcon, XIcon } from './icons'

function Report({ result }) {
  const commit = result.dry_run === false
  const rows = reportRows(commit ? result.counts : result.report, { commit })
  const invalid = result.report?.invalid || []
  const failed = result.report?.row_errors || []
  return (
    <div className="qx-stack qx-stack--tight" role="status" aria-label={commit ? 'Import result' : 'Dry run report'}>
      <div className={`qx-banner ${commit ? 'qx-banner--success' : 'qx-banner--info'}`}>
        {commit ? 'Imported. Everything below was written.' : 'Dry run: nothing has been written yet.'}
      </div>
      <ul className="qx-stack qx-stack--tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => <li key={r.key} className="qx-stat-row"><span>{r.label}</span><span className="qx-stat__value--mono">{r.value}</span></li>)}
      </ul>
      {invalid.length ? (
        <div className="qx-stack qx-stack--tight">
          <h4 className="qx-section-title" style={{ margin: 0 }}>Rows to look at ({invalid.length})</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{invalid.slice(0, 50).map((i, n) => <li key={n}>{describeInvalid(i)}</li>)}</ul>
          {invalid.length > 50 ? <div>And {invalid.length - 50} more.</div> : null}
        </div>
      ) : null}
      {failed.length ? <div className="qx-banner qx-banner--warn">{failed.length} rows could not be written: {failed.slice(0, 10).map((f) => `row ${f.row}`).join(', ')}.</div> : null}
      {commit && result.import_id ? <div>Import reference: <span className="qx-stat__value--mono">{result.import_id}</span></div> : null}
    </div>
  )
}

export default function ImportPanel({ onClose, onImported }) {
  const [file, setFile] = useState(null)
  const [mappingText, setMappingText] = useState('')
  const [showMapping, setShowMapping] = useState(false)
  const [result, setResult] = useState(null)
  const [dryOk, setDryOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [mapErr, setMapErr] = useState(null)

  const pick = (e) => { setFile(e.target.files?.[0] || null); setResult(null); setDryOk(false); setErr(null) }

  const run = async (commit) => {
    if (!file) return
    const m = parseMappingText(mappingText)
    if (m.error) { setMapErr(m.error); return }
    setMapErr(null); setBusy(true); setErr(null)
    try {
      const r = await api.importContacts(file, { commit, mapping: m.value })
      setResult(r)
      setDryOk(!commit)
      if (commit) onImported?.()
    } catch (e) { setErr(e); setResult(null); setDryOk(false) } finally { setBusy(false) }
  }

  return (
    <form className="qx-stack qx-stack--compact" aria-label="Import contacts" onSubmit={(e) => e.preventDefault()}>
      <div className="qx-row qx-row--apart">
        <h3 className="qx-section-title" style={{ margin: 0 }}>Import contacts</h3>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}><XIcon />Close</button>
      </div>
      <div>
        Upload a CSV or a vCard (.vcf) file. iCloud: icloud.com, Contacts, select all, Export vCard. Android or Google Contacts: export as vCard or CSV. Outlook: export to CSV. LinkedIn: the Connections.csv from your data export. Photos in vCard files are imported. For a live link instead of a one-off file, add a sync source in Settings.
        People you import are treated as data collected from a third party, so each starts a 30 day clock to tell them you hold their details.
        Anyone you erased before stays erased.
      </div>
      <Field label="File"><input className="qx-input" type="file" accept=".csv,.vcf,.vcard,text/csv,text/vcard" onChange={pick} aria-label="Contacts file" /></Field>
      <div>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setShowMapping((s) => !s)}>{showMapping ? 'Hide column mapping' : 'Column mapping (optional)'}</button>
      </div>
      {showMapping ? (
        <Field label="Column mapping" hint={'Only needed when headers are not recognised. JSON, for example {"Who": "name", "Where": "email"}. Roles: name, first_name, last_name, email, phone, company, title, notes, tags, ignore.'}>
          <textarea className="qx-textarea" rows={3} value={mappingText} onChange={(e) => { setMappingText(e.target.value); setDryOk(false) }} />
        </Field>
      ) : null}
      {mapErr ? <div className="qx-banner qx-banner--error" role="alert">{mapErr}</div> : null}
      <ErrorBanner error={err && { ...err, message: explainError(err) }} />
      {result ? <Report result={result} /> : null}
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => run(false)} disabled={busy || !file}><PlayIcon />{busy && !dryOk ? 'Checking' : 'Dry run'}</button>
        <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => run(true)} disabled={busy || !file || !dryOk} title={dryOk ? undefined : 'Run a dry run first'}><CheckIcon />{busy && dryOk ? 'Importing' : 'Import for real'}</button>
      </div>
      {!dryOk && file && !result ? <div className="qx-field__hint">Run a dry run first. It shows what would happen and writes nothing.</div> : null}
      <div className="qx-field__hint"><UploadIcon /> Files up to 50 MB or 20,000 rows.</div>
    </form>
  )
}
