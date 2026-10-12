import { useState, useEffect } from 'react'
import './safety.css'

/**
 * VMDeleteConfirmation - Two-step confirmation for VM/Container deletion
 * This is a RED-level operation requiring typed authorization code
 */
export function VMDeleteConfirmation({
  vmid,
  vmName,
  node,
  type = 'qemu', // 'qemu' or 'lxc'
  onConfirm,
  onCancel
}) {
  const [step, setStep] = useState(1)
  const [inputCode, setInputCode] = useState('')
  const [countdown, setCountdown] = useState(5)

  // Generate confirmation code
  const expectedCode = `DELETE-${vmName?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VM'}-${vmid}`

  const isCodeValid = inputCode.toUpperCase() === expectedCode

  // Countdown before allowing proceed to step 2
  useEffect(() => {
    if (step === 1 && countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [step, countdown])

  const handleProceed = () => {
    if (step === 1 && countdown === 0) {
      setStep(2)
    } else if (step === 2 && isCodeValid) {
      onConfirm(expectedCode)
    }
  }

  const typeLabel = type === 'qemu' ? 'Virtual Machine' : 'Container'
  const typeShort = type === 'qemu' ? 'VM' : 'CT'

  return (
    <div className="vm-delete-overlay" onClick={onCancel}>
      <div className="vm-delete-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="vm-delete-header">
          <div className="vm-delete-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div className="vm-delete-title">
            <h2>DESTRUCTIVE OPERATION</h2>
            <p>This action cannot be undone</p>
          </div>
          <span className="vm-delete-badge">RED</span>
        </div>

        {/* Step 1: Review */}
        {step === 1 && (
          <div className="vm-delete-body">
            <div className="vm-delete-target">
              <div className="vm-delete-target-header">
                <span className="vm-delete-type">{typeShort}</span>
                <span className="vm-delete-vmid">{vmid}</span>
              </div>
              <div className="vm-delete-name">{vmName || `${typeShort} ${vmid}`}</div>
              <div className="vm-delete-node">Node: {node}</div>
            </div>

            <div className="vm-delete-warning">
              <strong>Warning:</strong> You are about to permanently delete this {typeLabel.toLowerCase()}.
              <ul>
                <li>All data on this {typeLabel.toLowerCase()} will be lost</li>
                <li>All snapshots will be deleted</li>
                <li>This operation cannot be reversed</li>
                <li>Dependent resources may be affected</li>
              </ul>
            </div>

            <div className="vm-delete-countdown">
              {countdown > 0 ? (
                <span>Please review carefully. Continue available in {countdown}s...</span>
              ) : (
                <span className="vm-delete-ready">Ready to proceed to authorization</span>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Authorization */}
        {step === 2 && (
          <div className="vm-delete-body">
            <div className="vm-delete-auth">
              <p>To confirm deletion, type the following code exactly:</p>
              <code className="vm-delete-expected-code">{expectedCode}</code>
              <input
                type="text"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                placeholder="Type confirmation code"
                className={`vm-delete-input ${inputCode ? (isCodeValid ? 'valid' : 'invalid') : ''}`}
                autoFocus
                spellCheck="false"
                autoComplete="off"
              />
            </div>

            <div className="vm-delete-final-warning">
              Once confirmed, this {typeLabel.toLowerCase()} and all its data will be permanently destroyed.
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="vm-delete-footer">
          <button className="vm-delete-btn vm-delete-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="vm-delete-btn vm-delete-btn-confirm"
            onClick={handleProceed}
            disabled={step === 1 ? countdown > 0 : !isCodeValid}
          >
            {step === 1 ? 'Continue to Authorization' : 'Confirm Deletion'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default VMDeleteConfirmation
