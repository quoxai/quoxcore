import { useState, useEffect } from 'react'
import { DEFCON_LEVELS } from '../../contexts/SafetyContext'
import { Input } from '../ui/Input'
import Button from '../ui/Button'
import './safety.css'

// Generate authorization code based on operation
function generateAuthCode(operation) {
  const verbs = ['delete', 'destroy', 'remove', 'stop', 'restart', 'migrate', 'update']
  const query = operation.query.toLowerCase()

  let verb = 'CONFIRM'
  for (const v of verbs) {
    if (query.includes(v)) {
      verb = v.toUpperCase()
      break
    }
  }

  const random = Math.floor(Math.random() * 9000) + 1000
  return `${verb}-${random}`
}

export function AuthorizationModal({
  operation,
  defconLevel = 'AMBER',
  onAuthorize,
  onCancel
}) {
  const [authCode, setAuthCode] = useState('')
  const [expectedCode] = useState(() => generateAuthCode(operation))
  const [step, setStep] = useState(1)

  const defcon = DEFCON_LEVELS[defconLevel]
  const isRed = defconLevel === 'RED'
  const isOrange = defconLevel === 'ORANGE'
  const requiresCode = isRed
  const requiresTwoStep = isOrange || isRed

  const isCodeValid = authCode === expectedCode

  // Focus input when modal opens
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = document.querySelector('.auth-modal-input')
      if (input) input.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [step])

  const handleConfirm = () => {
    if (requiresTwoStep && step === 1) {
      setStep(2)
      return
    }

    if (requiresCode && !isCodeValid) {
      return
    }

    onAuthorize(authCode)
  }

  return (
    <div className="auth-modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
      <div className="auth-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`auth-modal-header defcon-${defconLevel.toLowerCase()}`}>
          <div className="auth-modal-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div className="auth-modal-title">
            <h2 id="auth-modal-title">Authorization Required</h2>
            <p>{defcon.description}</p>
          </div>
          <span className="auth-modal-badge" style={{ background: `${defcon.color}20`, color: defcon.color }}>
            {defconLevel}
          </span>
        </div>

        {/* Body */}
        <div className="auth-modal-body">
          {/* Step 1: Review operation */}
          {step === 1 && (
            <>
              <div className="auth-modal-operation">
                <h4>Operation</h4>
                <pre>{operation.query}</pre>
              </div>

              {operation.targets && operation.targets.length > 0 && (
                <div className="auth-modal-targets">
                  <h4>Affected Targets ({operation.targets.length})</h4>
                  <ul>
                    {operation.targets.slice(0, 10).map((target, i) => (
                      <li key={i}>{target}</li>
                    ))}
                    {operation.targets.length > 10 && (
                      <li>+{operation.targets.length - 10} more</li>
                    )}
                  </ul>
                </div>
              )}

              {isRed && (
                <div className="auth-modal-warning">
                  This is a destructive operation that cannot be undone.
                  You will need to enter an authorization code to proceed.
                </div>
              )}

              {isOrange && !isRed && (
                <div className="auth-modal-warning" style={{ background: 'rgba(255, 176, 48, 0.1)', borderColor: 'rgba(255, 176, 48, 0.2)', color: '#ffb030' }}>
                  This operation affects multiple systems. Please review carefully before proceeding.
                </div>
              )}
            </>
          )}

          {/* Step 2: Enter authorization code (for RED/ORANGE) */}
          {step === 2 && requiresCode && (
            <div className="auth-modal-code-section">
              <p>Type the following code to confirm this operation:</p>
              <code className="auth-modal-expected-code">{expectedCode}</code>
              <input
                type="text"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value.toUpperCase())}
                placeholder="Enter authorization code"
                className={`auth-modal-input ${authCode ? (isCodeValid ? 'valid' : 'invalid') : ''}`}
                autoFocus
              />
            </div>
          )}

          {/* Step 2 for ORANGE (confirmation only, no code) */}
          {step === 2 && isOrange && !isRed && (
            <div className="auth-modal-warning" style={{ background: 'rgba(255, 107, 48, 0.1)', borderColor: 'rgba(255, 107, 48, 0.2)', color: '#ff8b30' }}>
              Final confirmation: Are you sure you want to proceed with this operation?
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="auth-modal-footer">
          <Button
            variant="secondary"
            onClick={onCancel}
            aria-label="Cancel authorization"
          >
            Cancel
          </Button>
          <Button
            variant={defconLevel === 'RED' ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={step === 2 && requiresCode && !isCodeValid}
            style={
              defconLevel === 'AMBER'
                ? { background: 'rgba(255, 176, 48, 0.2)', borderColor: 'rgba(255, 176, 48, 0.3)', color: '#ffb030' }
                : defconLevel === 'ORANGE'
                ? { background: 'rgba(255, 107, 48, 0.2)', borderColor: 'rgba(255, 107, 48, 0.3)', color: '#ff8b30' }
                : {}
            }
            aria-label={step === 1 && requiresTwoStep ? 'Continue to authorization' : 'Authorize operation'}
          >
            {step === 1 && requiresTwoStep ? 'Continue' : 'Authorize'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AuthorizationModal
