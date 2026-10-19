/**
 * ProxmoxDoctorPanel: VM Doctor report for one VM (DEVFLEET-DOCTOR).
 *
 * Verdict pill, one card per finding (cause, evidence list, suggested fix, and a button that
 * hands a gated fix to the existing action flow), and a banner for anything that could not be
 * read. Read only; the diagnosis itself runs server-side. Styling is global .qx-* classes only.
 */

import { useProxmoxDoctor, fixToAction } from './useProxmoxDoctor'

export const VERDICT_PILL = { healthy: 'qx-pill--online', degraded: 'qx-pill--degraded', critical: 'qx-pill--danger' }
export const SEVERITY_PILL = { critical: 'qx-pill--danger', warning: 'qx-pill--degraded', info: 'qx-pill--info' }

const shown = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v))

function Finding({ finding, vm, onAction }) {
  const action = fixToAction(finding, vm)
  return (
    <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid={`finding-${finding.id}`}>
      <div className="qx-row qx-row--tight qx-row--center">
        <span className={`qx-pill qx-pill--sm ${SEVERITY_PILL[finding.severity] || 'qx-pill--info'}`}>{finding.severity}</span>
        <strong>{finding.title}</strong>
      </div>
      <div>{finding.cause}</div>
      <ul className="qx-stack qx-stack--tight" aria-label="Evidence">
        {(finding.evidence || []).map((e, i) => (
          <li key={i}>
            <span className="qx-code">{e.metric}</span> {shown(e.value)}
            {' '}(threshold {shown(e.threshold)}, {e.window}, from {e.source})
          </li>
        ))}
      </ul>
      <div className="qx-row qx-row--tight qx-row--center qx-row--wrap">
        <span><strong>Fix:</strong> {finding.fix && finding.fix.text}</span>
        {action && (
          <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => onAction && onAction(action)} title={action.description}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            Open gated action
          </button>
        )}
      </div>
    </div>
  )
}

export function ProxmoxDoctorPanel({ vm, onClose, onAction }) {
  const { report, error, loading, rerun } = useProxmoxDoctor(vm)
  const name = (vm && (vm.name || `VM ${vm.vmid}`)) || ''

  return (
    <section className="qx-card qx-stack" aria-label={`Diagnosis of ${name}`} data-testid="doctor-panel">
      <div className="qx-row qx-row--apart qx-row--center">
        <div className="qx-row qx-row--tight qx-row--center">
          <span className="qx-section-title">Diagnose</span>
          <strong>{name}</strong>
          {report && <span className={`qx-pill ${VERDICT_PILL[report.verdict] || 'qx-pill--info'}`} data-testid="doctor-verdict">{report.verdict}</span>}
        </div>
        <div className="qx-row qx-row--tight">
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={rerun} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" /></svg>
            Run again
          </button>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose} aria-label="Close diagnosis">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
            Close
          </button>
        </div>
      </div>

      {loading && (
        <div className="qx-row qx-row--tight qx-row--center" role="status">
          <span className="qx-spinner qx-spinner--sm" aria-hidden="true" />
          Reading the VM, its node, storage, tasks and guest agent...
        </div>
      )}

      {!loading && error && (
        <div className="qx-banner qx-banner--error" role="alert">
          <span className="qx-banner__title">Diagnosis failed</span>
          <span>{error}</span>
        </div>
      )}

      {!loading && report && (
        <>
          {report.gaps && report.gaps.length > 0 && (
            <div className="qx-banner qx-banner--warn" role="status" data-testid="doctor-gaps">
              <span className="qx-banner__title">Could not check</span>
              <ul>{report.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </div>
          )}
          {report.findings.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__title">No problems found in what could be read</div>
              <div className="qx-empty__body">{report.checked ? `${report.checked.length} sources checked.` : ''}</div>
            </div>
          ) : (
            <div className="qx-stack qx-stack--compact">
              {report.findings.map((f) => <Finding key={f.id} finding={f} vm={vm} onAction={onAction} />)}
            </div>
          )}
          <div className="qx-row qx-row--tight qx-row--wrap">
            <span className="qx-chip qx-chip--xs">report {report.report_id}</span>
            <span className="qx-chip qx-chip--xs">{new Date(report.generated_at).toLocaleString()}</span>
          </div>
        </>
      )}
    </section>
  )
}

export default ProxmoxDoctorPanel
