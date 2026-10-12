import { useState, useRef, useEffect, useCallback } from 'react'
import { useSafety } from '../../contexts/SafetyContext'
import './safety.css'

export function KillSwitch() {
  const {
    killSwitchActive,
    deactivationCode,
    activateKillSwitch,
    deactivateKillSwitch
  } = useSafety()

  const [armed, setArmed] = useState(false)
  const [showDeactivate, setShowDeactivate] = useState(false)
  const [inputCode, setInputCode] = useState('')
  const [error, setError] = useState('')
  const [resuming, setResuming] = useState(false)
  const armTimeoutRef = useRef(null)

  // Auto-disarm after 4 seconds if not confirmed
  useEffect(() => {
    if (armed) {
      armTimeoutRef.current = setTimeout(() => setArmed(false), 4000)
      return () => clearTimeout(armTimeoutRef.current)
    }
  }, [armed])

  const handleStage1 = useCallback(() => {
    // Lift the cover
    setArmed(true)
  }, [])

  const handleStage2 = useCallback(async () => {
    // Fire
    clearTimeout(armTimeoutRef.current)
    setArmed(false)
    const code = await activateKillSwitch()
    if (code) {
      alert(`ALL OPERATIONS HALTED\n\nDeactivation code:\n${code}\n\nSave this code to resume.`)
    } else {
      alert('Kill switch could not be activated: admin required.')
    }
  }, [activateKillSwitch])

  const handleDeactivate = useCallback(async () => {
    const ok = await deactivateKillSwitch(inputCode)
    if (ok) {
      setShowDeactivate(false)
      setInputCode('')
      setError('')
    } else {
      setError('Invalid code')
    }
  }, [inputCode, deactivateKillSwitch])

  // quox#503 residual: a server-loaded halt (another operator's E-STOP, or
  // this browser's own halt rehydrated after a reload) has no local
  // deactivation code — deactivationCode is null — so there is no code to
  // type. The only real path to resume is the server's requireHumanAdmin
  // gate, so skip the code-input entirely and call deactivate directly.
  const handleResumeAdmin = useCallback(async () => {
    setResuming(true)
    setError('')
    const ok = await deactivateKillSwitch(null)
    setResuming(false)
    if (!ok) {
      setError('Admin required')
    }
  }, [deactivateKillSwitch])

  // --- Active state, no local code: only the server admin gate can resume ---
  if (killSwitchActive && showDeactivate && deactivationCode === null) {
    return (
      <div className="kill-switch-deactivate">
        <button onClick={handleResumeAdmin} className="kill-switch-confirm" disabled={resuming}>
          {resuming ? 'Resuming…' : 'Resume (admin)'}
        </button>
        <button onClick={() => setShowDeactivate(false)} className="kill-switch-cancel">
          Cancel
        </button>
        {error && <span className="kill-switch-error">{error}</span>}
      </div>
    )
  }

  // --- Active state: locked, needs code to unlock ---
  if (killSwitchActive && showDeactivate) {
    return (
      <div className="kill-switch-deactivate">
        <input
          type="text"
          value={inputCode}
          onChange={(e) => setInputCode(e.target.value.toUpperCase())}
          placeholder="Enter code"
          className="kill-switch-input"
          autoFocus
        />
        <button onClick={handleDeactivate} className="kill-switch-confirm">
          Resume
        </button>
        <button onClick={() => setShowDeactivate(false)} className="kill-switch-cancel">
          Cancel
        </button>
        {error && <span className="kill-switch-error">{error}</span>}
      </div>
    )
  }

  if (killSwitchActive) {
    return (
      <button
        className="kill-switch-btn active"
        onClick={() => setShowDeactivate(true)}
        title="All operations halted. Click to enter deactivation code (Ctrl+Shift+K)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        HALTED
      </button>
    )
  }

  // --- Default state: two-stage arm → confirm ---
  if (armed) {
    return (
      <div className="estop-armed-container">
        <div className="estop-armed-ring" />
        <button
          className="estop-armed-btn"
          onClick={handleStage2}
          title="Halt all operations"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
          CONFIRM HALT
        </button>
        <button
          className="estop-cancel-btn"
          onClick={() => setArmed(false)}
          title="Cancel"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    )
  }

  // --- Idle state: just the cover ---
  return (
    <button
      className="estop-btn"
      onClick={handleStage1}
      title="Emergency stop. Click to arm (Ctrl+Shift+K)"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/><line x1="12" y1="2" x2="12" y2="12"/>
      </svg>
      <span className="estop-label">E-STOP</span>
    </button>
  )
}

export function DefconIndicator() {
  const { currentDefcon, dryRunMode, setDryRunMode } = useSafety()

  const defconColors = {
    GREEN: '#30ff90',
    BLUE: '#3090ff',
    AMBER: '#ffb030',
    ORANGE: '#ff6b30',
    RED: '#38bdf8'
  }

  return (
    <div className="defcon-indicator">
      <div
        className={`defcon-badge defcon-${currentDefcon.toLowerCase()}`}
        style={{ '--defcon-color': defconColors[currentDefcon] }}
        title={`Current DEFCON level: ${currentDefcon}`}
      >
        <span className="defcon-dot" />
        <span className="defcon-label">DEFCON {currentDefcon}</span>
      </div>
      <button
        className={`dry-run-toggle ${dryRunMode ? 'active' : ''}`}
        onClick={() => setDryRunMode(!dryRunMode)}
        title={dryRunMode ? 'Dry run mode ON - commands logged but not executed' : 'Click to enable dry run mode'}
      >
        {dryRunMode ? 'DRY RUN' : 'LIVE'}
      </button>
    </div>
  )
}

export default KillSwitch
