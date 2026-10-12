/**
 * VoltVerifyModal — 10-check verification results modal
 *
 * Displays:
 * - PASS/FAIL header with shield icon
 * - Summary card (bundle_id, version, event_count, chain_valid)
 * - 10-check report rows (name + pass/fail + detail)
 * - Warnings section
 */

const CHECK_NAMES = [
  { code: 'PARSE_ERROR',              name: 'JSON Parse' },
  { code: 'MISSING_MANIFEST',         name: 'Manifest Present' },
  { code: 'MISSING_EVENTS',           name: 'Events Present' },
  { code: 'UNSUPPORTED_VERSION',      name: 'Version Supported' },
  { code: 'BUNDLE_VALIDATION_FAILED', name: 'Bundle Integrity' },
  { code: 'EVENT_COUNT_MISMATCH',     name: 'Event Count' },
  { code: 'FIRST_HASH_MISMATCH',      name: 'First Hash Anchor' },
  { code: 'LAST_HASH_MISMATCH',       name: 'Last Hash Anchor' },
  { code: 'MERKLE_ROOT_MISMATCH',     name: 'Merkle Root' },
  { code: 'CHAIN_BROKEN',             name: 'Hash Chain' },
  { code: 'REDACTION_INCONSISTENT',   name: 'Redaction Consistency' },
  { code: 'SIGNATURE_INVALID',        name: 'Signatures' },
  { code: 'TIMESTAMP_INVALID',        name: 'Timestamps' },
]

const ShieldCheckIcon = ({ pass }) => (
  <svg
    className={`volt-modal__shield ${pass ? 'volt-modal__shield--pass' : 'volt-modal__shield--fail'}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    {pass
      ? <polyline points="9 12 11 14 15 10" />
      : <><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
    }
  </svg>
)

const CheckIcon = () => (
  <svg className="volt-modal__check-icon volt-modal__check-icon--pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const XIcon = () => (
  <svg className="volt-modal__check-icon volt-modal__check-icon--fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

export default function VoltVerifyModal({ result, onClose }) {
  if (!result) return null

  const { valid, errors = [], warnings = [], summary = {} } = result
  const errorCodes = new Set(errors.map(e => e.code))

  // Build check rows — each check is pass unless its code appears in errors
  const checks = CHECK_NAMES.map(({ code, name }) => {
    const matchingError = errors.find(e => e.code === code)
    return {
      name,
      pass: !matchingError,
      detail: matchingError?.detail || matchingError?.message || null
    }
  })

  return (
    <div className="volt-modal-backdrop" onClick={onClose}>
      <div className="volt-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="volt-modal__header">
          <ShieldCheckIcon pass={valid} />
          <h3 className={`volt-modal__title ${valid ? 'volt-modal__title--pass' : 'volt-modal__title--fail'}`}>
            {valid ? 'Verification Passed' : 'Verification Failed'}
          </h3>
          <button className="volt-btn volt-btn--icon volt-modal__close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div className="volt-modal__body">
          {/* Summary card */}
          <div className="volt-modal__summary">
            <div className="volt-modal__summary-item">
              <span className="volt-modal__summary-label">Bundle ID</span>
              <span className="volt-modal__summary-value">
                {summary.bundle_id ? summary.bundle_id.slice(0, 16) + '…' : '—'}
              </span>
            </div>
            <div className="volt-modal__summary-item">
              <span className="volt-modal__summary-label">Version</span>
              <span className="volt-modal__summary-value">{summary.volt_version || '—'}</span>
            </div>
            <div className="volt-modal__summary-item">
              <span className="volt-modal__summary-label">Events</span>
              <span className="volt-modal__summary-value">{summary.event_count ?? '—'}</span>
            </div>
            <div className="volt-modal__summary-item">
              <span className="volt-modal__summary-label">Chain Valid</span>
              <span className="volt-modal__summary-value">
                {summary.chain_valid ? 'Yes' : 'No'}
              </span>
            </div>
          </div>

          {/* Check report */}
          <div className="volt-modal__checks-title">Verification Checks</div>
          {checks.map(({ name, pass, detail }, i) => (
            <div key={i} className="volt-modal__check">
              {pass ? <CheckIcon /> : <XIcon />}
              <div>
                <div className="volt-modal__check-name">{name}</div>
                {detail && <div className="volt-modal__check-detail">{detail}</div>}
              </div>
            </div>
          ))}

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="volt-modal__warnings">
              <div className="volt-modal__warnings-title">Warnings</div>
              {warnings.map((w, i) => (
                <div key={i} className="volt-modal__warning-item">{w.message}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
