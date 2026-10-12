/**
 * VoltBundleInspector — Export preview modal + Import/verify drop zone
 *
 * Export: Modal with bundle manifest preview before download.
 * Import: Dashed drop zone accepts .json drag-and-drop or file input,
 *         reads file, runs verifyEvidenceBundle(), shows check results.
 */

import { useState, useCallback, useRef } from 'react'
import Modal from '../ui/Modal'

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

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

const CheckIcon = () => (
  <svg className="volt-bundle__check-icon volt-bundle__check-icon--pass" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const XIcon = () => (
  <svg className="volt-bundle__check-icon volt-bundle__check-icon--fail" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

export function VoltExportPreview({ run, eventCount, onConfirm, onCancel, isOpen }) {
  if (!run) return null

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="sm">
      <Modal.Header>
        <DownloadIcon /> Export Evidence Bundle
      </Modal.Header>
      <Modal.Body>
        <div className="volt-bundle__manifest">
          <div className="volt-bundle__manifest-row">
            <span className="volt-bundle__manifest-label">Run ID</span>
            <span className="volt-bundle__manifest-value">{run.run_id}</span>
          </div>
          <div className="volt-bundle__manifest-row">
            <span className="volt-bundle__manifest-label">Correlation</span>
            <span className="volt-bundle__manifest-value">{run.corr || '\u2014'}</span>
          </div>
          <div className="volt-bundle__manifest-row">
            <span className="volt-bundle__manifest-label">Events</span>
            <span className="volt-bundle__manifest-value">{eventCount}</span>
          </div>
          <div className="volt-bundle__manifest-row">
            <span className="volt-bundle__manifest-label">Head Hash</span>
            <span className="volt-bundle__manifest-value volt-bundle__manifest-value--mono">
              {run.head_hash ? run.head_hash.slice(0, 16) + '\u2026' : '\u2014'}
            </span>
          </div>
          <div className="volt-bundle__manifest-row">
            <span className="volt-bundle__manifest-label">Status</span>
            <span className="volt-bundle__manifest-value">{run.status}</span>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <button className="volt-btn" onClick={onCancel}>Cancel</button>
        <button className="volt-btn volt-btn--primary" onClick={onConfirm}>
          <DownloadIcon /> Export Bundle
        </button>
      </Modal.Footer>
    </Modal>
  )
}

export default function VoltBundleInspector({ onImportVerify }) {
  const [dragging, setDragging] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [importError, setImportError] = useState(null)
  const fileInputRef = useRef(null)

  const processFile = useCallback(async (file) => {
    setResult(null)
    setImportError(null)
    setFileName(file.name)
    setVerifying(true)

    try {
      const text = await file.text()
      const res = await onImportVerify(text)
      setResult(res)
    } catch (err) {
      setImportError(err.message || 'Verification failed')
    } finally {
      setVerifying(false)
    }
  }, [onImportVerify])

  const handleDragOver = (e) => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = () => setDragging(false)

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.json')) {
      processFile(file)
    } else {
      setImportError('Please drop a .json bundle file')
    }
  }

  const handleFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) processFile(file)
  }

  const checks = result
    ? CHECK_NAMES.map(({ code, name }) => {
        const matchingError = result.errors?.find(e => e.code === code)
        return {
          name,
          pass: !matchingError,
          detail: matchingError?.detail || matchingError?.message || null,
        }
      })
    : null

  return (
    <div className="volt-bundle-inspector">
      <h4 className="volt-bundle-inspector__title">Import & Verify Bundle</h4>

      {/* Drop zone */}
      <div
        className={`volt-bundle__dropzone${dragging ? ' volt-bundle__dropzone--active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Drop a VOLT bundle JSON file here or click to browse"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
      >
        <UploadIcon />
        <span className="volt-bundle__dropzone-text">
          {verifying
            ? 'Verifying bundle\u2026'
            : 'Drop a .json bundle here or click to browse'}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {/* Error */}
      {importError && (
        <div className="volt-bundle__error">{importError}</div>
      )}

      {/* Results */}
      {result && (
        <div className="volt-bundle__results">
          <div className={`volt-bundle__verdict${result.valid ? ' volt-bundle__verdict--pass' : ' volt-bundle__verdict--fail'}`}>
            {result.valid ? 'Verification Passed' : 'Verification Failed'}
            {fileName && <span className="volt-bundle__filename"> \u2014 {fileName}</span>}
          </div>

          {checks.map(({ name, pass, detail }, i) => (
            <div key={i} className="volt-bundle__check-row">
              {pass ? <CheckIcon /> : <XIcon />}
              <span className="volt-bundle__check-name">{name}</span>
              {detail && <span className="volt-bundle__check-detail">{detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
