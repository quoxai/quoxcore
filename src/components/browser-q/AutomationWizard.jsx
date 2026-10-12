/**
 * AutomationWizard — BQ-W2-2: New Automation Wizard
 *
 * Four-step wizard flow for creating browser objectives:
 *   1. Input: URL, intent, options, template chips
 *   2. Plan review: LLM-generated step plan with HITL markers
 *   3. Execution: live progress with step indicators
 *   4. Completion: results + save/schedule actions
 *
 * Renders inline within BrowserQView (replaces the welcome/tab content).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createBrowserObjective,
  planBrowserObjective,
  executeBrowserObjective,
  getBrowserObjective,
  approveStep,
  cancelBrowserObjective,
  saveAsSequence,
  scheduleBrowserAutomation,
  listBrowserCredentials,
  createBrowserCredential,
  getGalleryImageUrl
} from '../../services/browserQService'
import { naturalLanguageToCron, cronToHuman } from '../../services/cronHelper'
import LiveSessionViewer from './LiveSessionViewer'

// ─── Template Presets ─────────────────────────────────────────────────

const TEMPLATES = [
  { label: 'Extract table data', intent: 'Navigate to the page and extract all table data as structured JSON' },
  { label: 'Monitor changes', intent: 'Take a screenshot for visual monitoring. I want to track changes over time.' },
  { label: 'Download files', intent: 'Find and download all available files (PDFs, CSVs, etc.)' },
  { label: 'Fill a form', intent: 'Fill out the form on this page with the data I\'ll provide' },
  { label: 'Take screenshots', intent: 'Navigate through the site and capture screenshots of key pages' },
  { label: 'Custom', intent: '' },
]

// ─── Step Status Icons ────────────────────────────────────────────────

function StepIcon({ status }) {
  switch (status) {
    case 'done':
      return <span className="bqw-step-icon bqw-step-icon--done">{'\u2713'}</span>
    case 'running':
      return <span className="bqw-step-icon bqw-step-icon--running">{'\u25CF'}</span>
    case 'failed':
      return <span className="bqw-step-icon bqw-step-icon--failed">{'\u2717'}</span>
    case 'hitl':
      return <span className="bqw-step-icon bqw-step-icon--hitl">{'\uD83D\uDD12'}</span>
    case 'paused':
      return <span className="bqw-step-icon bqw-step-icon--paused">{'\u23F8'}</span>
    default:
      return <span className="bqw-step-icon bqw-step-icon--pending">{'\u25CB'}</span>
  }
}

// ─── Step 1: Input ────────────────────────────────────────────────────

function WizardInput({ wizardData, setWizardData, onPlan, planning, credentials, credentialsLoading, onAddCredential }) {
  const urlRef = useRef(null)
  const [showNewCred, setShowNewCred] = useState(false)
  const [newCred, setNewCred] = useState({ domain: '', username: '', password: '' })
  const [savingCred, setSavingCred] = useState(false)

  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  // Auto-fill domain from URL when adding new credential
  useEffect(() => {
    if (showNewCred && wizardData.url && !newCred.domain) {
      try { setNewCred(prev => ({ ...prev, domain: new URL(wizardData.url).origin })) } catch {}
    }
  }, [showNewCred, wizardData.url, newCred.domain])

  const handleTemplateClick = (template) => {
    setWizardData(prev => ({
      ...prev,
      intent: template.intent,
      selectedTemplate: template.label
    }))
  }

  const handleSaveNewCredential = async () => {
    if (!newCred.domain || !newCred.username || !newCred.password) return
    setSavingCred(true)
    try {
      const saved = await onAddCredential(newCred)
      if (saved?.id || saved?.credential?.id) {
        setWizardData(prev => ({ ...prev, credentialId: saved.id || saved.credential?.id }))
        setShowNewCred(false)
        setNewCred({ domain: '', username: '', password: '' })
      }
    } catch (err) {
      console.error('Failed to save credential:', err)
    } finally {
      setSavingCred(false)
    }
  }

  const canSubmit = wizardData.url.trim() && wizardData.intent.trim() && !planning

  return (
    <div className="bqw-step bqw-step--input">
      <div className="bqw-step__header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#06b6d4' }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <h3 className="bqw-step__title">New Browser Automation</h3>
      </div>

      <div className="bqw-field">
        <label className="bqw-field__label">URL</label>
        <input
          ref={urlRef}
          type="url"
          className="bqw-field__input"
          placeholder="https://"
          value={wizardData.url}
          onChange={e => setWizardData(prev => ({ ...prev, url: e.target.value }))}
        />
      </div>

      <div className="bqw-field">
        <label className="bqw-field__label">What should Browser-Q do?</label>
        <textarea
          className="bqw-field__textarea"
          placeholder="Describe the task in plain English..."
          rows={3}
          value={wizardData.intent}
          onChange={e => setWizardData(prev => ({ ...prev, intent: e.target.value }))}
        />
      </div>

      <div className="bqw-templates">
        <span className="bqw-templates__label">Quick templates:</span>
        <div className="bqw-templates__chips">
          {TEMPLATES.map((t, i) => (
            <button
              key={i}
              className={`bqw-template-chip ${wizardData.selectedTemplate === t.label ? 'bqw-template-chip--active' : ''}`}
              onClick={() => handleTemplateClick(t)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bqw-options">
        <label className="bqw-option">
          <input
            type="checkbox"
            checked={wizardData.needsLogin}
            onChange={e => setWizardData(prev => ({ ...prev, needsLogin: e.target.checked, credentialId: e.target.checked ? prev.credentialId : null }))}
          />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Needs login</span>
        </label>
        <label className="bqw-option">
          <input
            type="checkbox"
            checked={wizardData.recordVideo}
            onChange={e => setWizardData(prev => ({ ...prev, recordVideo: e.target.checked }))}
          />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" fill="rgba(239,68,68,0.6)" />
          </svg>
          <span>Record video</span>
        </label>
      </div>

      {/* Credential picker — shown when "Needs login" is checked */}
      {wizardData.needsLogin && (
        <div className="bqw-credential-section">
          <label className="bqw-field__label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#f59e0b' }}>
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
            Select credential from vault
          </label>

          {credentialsLoading ? (
            <div style={{ padding: '8px 0', color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>Loading credentials...</div>
          ) : (
            <select
              className="bqw-field__input"
              value={wizardData.credentialId || ''}
              onChange={e => setWizardData(prev => ({ ...prev, credentialId: e.target.value || null }))}
              style={{ cursor: 'pointer' }}
            >
              <option value="">-- Select saved login --</option>
              {(credentials || []).map(c => (
                <option key={c.id} value={c.id}>
                  {c.label} {c.username ? `(${c.username})` : ''}
                </option>
              ))}
            </select>
          )}

          <button
            className="bqw-btn bqw-btn--ghost"
            onClick={() => setShowNewCred(v => !v)}
            style={{ marginTop: 6, fontSize: 12 }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'currentColor' }}>
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {showNewCred ? 'Cancel' : 'Add new credential'}
          </button>

          {/* Inline new credential form */}
          {showNewCred && (
            <div className="bqw-new-cred">
              <input
                className="bqw-field__input"
                type="url"
                placeholder="Website domain (e.g. https://console.hetzner.cloud)"
                value={newCred.domain}
                onChange={e => setNewCred(prev => ({ ...prev, domain: e.target.value }))}
              />
              <input
                className="bqw-field__input"
                type="text"
                placeholder="Username or email"
                value={newCred.username}
                onChange={e => setNewCred(prev => ({ ...prev, username: e.target.value }))}
                autoComplete="off"
              />
              <input
                className="bqw-field__input"
                type="password"
                placeholder="Password"
                value={newCred.password}
                onChange={e => setNewCred(prev => ({ ...prev, password: e.target.value }))}
                autoComplete="new-password"
              />
              <button
                className="bqw-btn bqw-btn--secondary"
                disabled={!newCred.domain || !newCred.username || !newCred.password || savingCred}
                onClick={handleSaveNewCredential}
                style={{ marginTop: 4 }}
              >
                {savingCred ? 'Saving...' : 'Save to vault & use'}
              </button>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
                Stored encrypted in QuoxVault. Browser-Q retrieves it just-in-time during execution.
              </div>
            </div>
          )}

          {!wizardData.credentialId && !showNewCred && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
              You can also skip this — Browser-Q will pause at the login step for you to enter credentials manually.
            </div>
          )}
        </div>
      )}

      <div className="bqw-actions">
        <button
          className="bqw-btn bqw-btn--primary"
          disabled={!canSubmit}
          onClick={onPlan}
        >
          {planning ? (
            <>
              <span className="bqw-spinner" />
              Planning...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
                <path d="M9 18l6-6-6-6" />
              </svg>
              Plan Automation
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Step 2: Plan Review ──────────────────────────────────────────────

function WizardPlanReview({ wizardData, onApprove, onCancel, approving }) {
  const plan = wizardData.plan || {}
  // Agentic path returns tasks, screencap path returns steps
  const steps = plan.steps || (plan.tasks || []).map(t => ({
    action: t.agent_id || 'browser-q',
    description: t.title || t.prompt,
    status: t.status || 'pending',
  }))
  const title = plan.title || wizardData.intent
  const isFast = wizardData.isFastPath

  return (
    <div className="bqw-step bqw-step--plan">
      <div className="bqw-step__header">
        {isFast ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#f59e0b' }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#06b6d4' }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        )}
        <h3 className="bqw-step__title">{isFast ? 'Fast Path Plan' : 'Automation Plan'}</h3>
        {isFast && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
            marginLeft: 8,
          }}>~10s</span>
        )}
      </div>

      <div className="bqw-plan-title">"{title}"</div>

      <div className="bqw-plan-steps">
        {steps.map((step, i) => {
          const isHitl = step.needs_hitl || step.hitl
          return (
            <div key={step.id || i} className={`bqw-plan-step ${isHitl ? 'bqw-plan-step--hitl' : ''}`}>
              <span className="bqw-plan-step__num">{i + 1}.</span>
              <StepIcon status={isHitl ? 'hitl' : 'pending'} />
              <span className="bqw-plan-step__desc">{step.description || step.action}</span>
              {isHitl && <span className="bqw-plan-step__hitl-badge">HITL</span>}
            </div>
          )
        })}
      </div>

      {steps.length === 0 && (
        <div className="bqw-plan-empty">
          No steps were generated. Try a more specific description.
        </div>
      )}

      <div className="bqw-actions">
        <button
          className="bqw-btn bqw-btn--primary"
          disabled={approving || steps.length === 0}
          onClick={onApprove}
        >
          {approving ? (
            <>
              <span className="bqw-spinner" />
              Starting...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Approve & Run
            </>
          )}
        </button>
        <button className="bqw-btn bqw-btn--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Execution Progress ───────────────────────────────────────

function WizardExecution({ wizardData, authFetch, orgId, onComplete, onCancel, screencastSessionId }) {
  const plan = wizardData.plan || {}
  const steps = plan.steps || []
  const [liveSteps, setLiveSteps] = useState(() =>
    steps.map(s => ({ ...s, status: 'pending', elapsed: null }))
  )
  const [currentStep, setCurrentStep] = useState(0)
  const [elapsedTotal, setElapsedTotal] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hitlPending, setHitlPending] = useState(null)
  const [approvingStep, setApprovingStep] = useState(false)
  const pollRef = useRef(null)
  const startTimeRef = useRef(Date.now())

  // Poll objective status every 3s
  useEffect(() => {
    if (!wizardData.objectiveId) return

    const poll = async () => {
      try {
        // BQ-FIX: Poll the correct service based on objective type
        let obj
        if (wizardData.isAgentic) {
          // Agentic path: poll tasks service
          const res = await authFetch(`/tasks/api/objectives/${wizardData.objectiveId}`)
          if (!res.ok) return
          obj = await res.json()
          // Map tasks-service status to BQ status
          if (obj.status === 'decomposed') obj.status = 'planned'
          if (obj.status === 'executing') obj.status = 'running'
          // Map tasks to steps format
          if (obj.tasks && !obj.steps) {
            obj.steps = obj.tasks.map((t, i) => ({
              id: t.id || `task-${i}`,
              action: t.agent_id || 'browser-q',
              description: t.title || t.prompt,
              status: t.status === 'completed' ? 'done' : t.status,
              elapsed_ms: t.duration_ms,
              result: t.result,
            }))
          }
        } else {
          // Legacy screencap path
          const result = await getBrowserObjective(authFetch, wizardData.objectiveId, orgId)
          obj = result.objective || result
        }

        // Update step statuses from server
        if (obj.steps && obj.steps.length > 0) {
          setLiveSteps(prev => {
            const updated = [...prev]
            obj.steps.forEach((serverStep, i) => {
              if (i < updated.length) {
                updated[i] = {
                  ...updated[i],
                  status: serverStep.status || updated[i].status,
                  elapsed: serverStep.elapsed_ms || serverStep.elapsed || updated[i].elapsed,
                  result: serverStep.result
                }
              }
            })
            return updated
          })

          // Find current step index
          const runningIdx = obj.steps.findIndex(s => s.status === 'running')
          const pausedIdx = obj.steps.findIndex(s => s.status === 'paused' || s.status === 'awaiting_approval')
          if (runningIdx >= 0) {
            setCurrentStep(runningIdx)
            setHitlPending(null)
          } else if (pausedIdx >= 0) {
            setCurrentStep(pausedIdx)
            setHitlPending(obj.steps[pausedIdx])
          } else {
            const lastDone = obj.steps.reduce((acc, s, i) => s.status === 'done' ? i : acc, -1)
            if (lastDone >= 0) setCurrentStep(lastDone)
          }
        }

        // Update elapsed total
        setElapsedTotal(Math.floor((Date.now() - startTimeRef.current) / 1000))

        // Check terminal states
        if (obj.status === 'completed' || obj.status === 'done') {
          clearInterval(pollRef.current)
          onComplete({
            steps: obj.steps || liveSteps,
            results: obj.results || obj.result,
            screenshots: obj.screenshots || [],
            elapsed_ms: Date.now() - startTimeRef.current
          })
          return
        }

        if (obj.status === 'failed' || obj.status === 'cancelled') {
          clearInterval(pollRef.current)
          onComplete({
            steps: obj.steps || liveSteps,
            results: obj.results || obj.result,
            error: obj.error || `Objective ${obj.status}`,
            elapsed_ms: Date.now() - startTimeRef.current
          })
          return
        }

        if (obj.status === 'paused') {
          setPaused(true)
        } else {
          setPaused(false)
        }
      } catch (err) {
        console.error('[AutomationWizard] Poll error:', err)
      }
    }

    poll()
    pollRef.current = setInterval(poll, 3000)

    // Safety timeout: auto-cancel after 5 minutes
    const timeout = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current)
      onComplete({
        steps: liveSteps,
        error: 'Execution timed out after 5 minutes',
        elapsed_ms: Date.now() - startTimeRef.current
      })
    }, 300000)

    return () => {
      clearTimeout(timeout)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [wizardData.objectiveId, authFetch, onComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed timer
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTotal(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const handleApproveStep = useCallback(async () => {
    if (!hitlPending || !wizardData.objectiveId) return
    setApprovingStep(true)
    try {
      await approveStep(authFetch, wizardData.objectiveId, hitlPending.id || hitlPending.step_id, orgId)
      setHitlPending(null)
    } catch (err) {
      console.error('[AutomationWizard] Approve step error:', err)
    } finally {
      setApprovingStep(false)
    }
  }, [hitlPending, wizardData.objectiveId, authFetch])

  const handleCancel = useCallback(async () => {
    try {
      await cancelBrowserObjective(authFetch, wizardData.objectiveId, orgId)
    } catch (err) {
      console.error('[AutomationWizard] Cancel error:', err)
    }
    if (pollRef.current) clearInterval(pollRef.current)
    onCancel()
  }, [authFetch, wizardData.objectiveId, onCancel])

  const totalSteps = liveSteps.length
  const doneSteps = liveSteps.filter(s => s.status === 'done').length
  const progressPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0
  const title = wizardData.plan?.title || wizardData.intent

  return (
    <div className="bqw-step bqw-step--executing">
      <div className="bqw-step__header">
        <span className="bqw-exec-spinner" />
        <h3 className="bqw-step__title">Running: {title}</h3>
      </div>

      <div className="bqw-exec-progress">
        <span className="bqw-exec-progress__text">
          Step {currentStep + 1} of {totalSteps}
        </span>
        <div className="bqw-exec-progress__bar">
          <div className="bqw-exec-progress__fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="bqw-exec-progress__pct">{progressPct}%</span>
        <span className="bqw-exec-progress__time">{elapsedTotal}s</span>
      </div>

      {/* Live Session Viewer + Step List side by side */}
      <div className="bqw-exec-split">
        {/* Live viewer (left, ~60%) */}
        <div className="bqw-exec-split__viewer">
          <LiveSessionViewer
            objectiveId={wizardData.isAgentic ? null : wizardData.objectiveId}
            sessionId={screencastSessionId}
            steps={liveSteps}
            tasksObjectiveId={wizardData.isAgentic ? wizardData.objectiveId : null}
            orgId={orgId}
          />
        </div>

        {/* Step list (right, ~40%) */}
        <div className="bqw-exec-split__steps">
          <div className="bqw-exec-steps">
            {liveSteps.map((step, i) => {
              const isActive = i === currentStep && step.status === 'running'
              return (
                <div key={step.id || i} className={`bqw-exec-step ${isActive ? 'bqw-exec-step--active' : ''}`}>
                  <span className="bqw-exec-step__num">{i + 1}.</span>
                  <StepIcon status={step.status} />
                  <span className="bqw-exec-step__desc">
                    {step.description || step.action}
                    {step.status === 'done' && step.elapsed != null && (
                      <span className="bqw-exec-step__elapsed"> ({Math.round(step.elapsed / 1000)}s)</span>
                    )}
                    {step.status === 'running' && (
                      <span className="bqw-exec-step__running"> ...</span>
                    )}
                  </span>
                  {/* HITL approval button inline */}
                  {(step.status === 'paused' || step.status === 'awaiting_approval') && hitlPending && (
                    <button
                      className="bqw-btn bqw-btn--small bqw-btn--approve"
                      onClick={handleApproveStep}
                      disabled={approvingStep}
                    >
                      {approvingStep ? '...' : '\u2713 Approve'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="bqw-actions">
        <button className="bqw-btn bqw-btn--secondary" onClick={handleCancel}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Step 4: Completion ───────────────────────────────────────────────

function WizardComplete({ wizardData, authFetch, orgId, onClose, onRunAgain }) {
  const results = wizardData.results || {}
  const plan = wizardData.plan || {}
  const steps = results.steps || plan.steps || []
  const doneCount = steps.filter(s => s.status === 'done').length
  const totalCount = steps.length
  const screenshots = results.screenshots || []
  const elapsedSec = results.elapsed_ms ? Math.round(results.elapsed_ms / 1000) : 0
  const hasError = !!results.error
  const title = plan.title || wizardData.intent

  // ─ Save state
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedSequenceId, setSavedSequenceId] = useState(null)

  // ─ Schedule state
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduleText, setScheduleText] = useState('')
  const [parsedCron, setParsedCron] = useState(null)
  const [parsedHuman, setParsedHuman] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduled, setScheduled] = useState(false)
  const [scheduleError, setScheduleError] = useState(null)

  // ─ Action-Q bridge state
  const [creatingActions, setCreatingActions] = useState(false)
  const [actionsCreated, setActionsCreated] = useState(false)

  const handleSaveAsAutomation = useCallback(async () => {
    if (!wizardData.objectiveId) return
    setSaving(true)
    try {
      const res = await saveAsSequence(authFetch, wizardData.objectiveId, orgId)
      setSaved(true)
      setSavedSequenceId(res.id || res.sequence_id || null)
    } catch (err) {
      console.error('[AutomationWizard] Save as sequence error:', err)
    } finally {
      setSaving(false)
    }
  }, [authFetch, wizardData.objectiveId, orgId])

  // Parse NL schedule text on change
  const handleScheduleTextChange = useCallback((text) => {
    setScheduleText(text)
    setScheduleError(null)
    if (!text.trim()) {
      setParsedCron(null)
      setParsedHuman('')
      return
    }
    const cron = naturalLanguageToCron(text)
    if (cron) {
      setParsedCron(cron)
      setParsedHuman(cronToHuman(cron))
    } else {
      setParsedCron(null)
      setParsedHuman('')
    }
  }, [])

  const handleScheduleSubmit = useCallback(async () => {
    if (!parsedCron) {
      setScheduleError('Could not parse schedule. Try: "every Monday at 9am" or "daily at 6pm"')
      return
    }
    // Save sequence first if not already saved
    let seqId = savedSequenceId
    if (!saved && wizardData.objectiveId) {
      setSaving(true)
      try {
        const res = await saveAsSequence(authFetch, wizardData.objectiveId, orgId)
        setSaved(true)
        seqId = res.id || res.sequence_id || null
        setSavedSequenceId(seqId)
      } catch (err) {
        setScheduleError('Failed to save automation before scheduling')
        setSaving(false)
        return
      } finally {
        setSaving(false)
      }
    }

    setScheduling(true)
    setScheduleError(null)
    try {
      await scheduleBrowserAutomation(authFetch, {
        sequenceId: seqId,
        cronExpression: parsedCron,
        name: title,
        url: wizardData.url,
        intent: wizardData.intent
      })
      setScheduled(true)
    } catch (err) {
      console.error('[AutomationWizard] Schedule error:', err)
      setScheduleError(err.message || 'Failed to create schedule')
    } finally {
      setScheduling(false)
    }
  }, [parsedCron, saved, savedSequenceId, wizardData, authFetch, title])

  // Action-Q bridge: extract results into action items
  const handleCreateActions = useCallback(async () => {
    if (!results.results) return
    setCreatingActions(true)
    try {
      // Format extracted results as action items via the action tool API
      const extracted = typeof results.results === 'string'
        ? [{ title: results.results.substring(0, 200) }]
        : Array.isArray(results.results)
          ? results.results.map((r, i) => ({
              title: typeof r === 'string' ? r.substring(0, 200) : (r.title || r.name || `Result ${i + 1}`),
              description: typeof r === 'object' ? JSON.stringify(r) : undefined
            }))
          : [{ title: `Browser-Q results from: ${title}`, description: JSON.stringify(results.results) }]

      // Create via collector tool execution
      for (const item of extracted.slice(0, 20)) {
        await authFetch('/collector/api/v1/tools/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_name: 'action_add',
            input: {
              title: item.title,
              description: item.description || `From Browser-Q: ${wizardData.url}`,
              priority: 'medium',
              tags: ['browser-q', 'extracted']
            },
            agent_id: 'action-q'
          })
        })
      }
      setActionsCreated(true)
    } catch (err) {
      console.error('[AutomationWizard] Create actions error:', err)
    } finally {
      setCreatingActions(false)
    }
  }, [results, authFetch, title, wizardData.url])

  // Determine if results look like extracted data (array or object with entries)
  const hasExtractedResults = results.results && (
    Array.isArray(results.results) ||
    (typeof results.results === 'object' && Object.keys(results.results).length > 0)
  )

  return (
    <div className="bqw-step bqw-step--complete">
      <div className="bqw-step__header">
        {hasError ? (
          <span className="bqw-complete-icon bqw-complete-icon--error">{'\u2717'}</span>
        ) : (
          <span className="bqw-complete-icon bqw-complete-icon--success">{'\u2713'}</span>
        )}
        <h3 className="bqw-step__title">
          {hasError ? 'Failed' : 'Complete'}: {title}
        </h3>
      </div>

      <div className="bqw-complete-summary">
        <span>{doneCount}/{totalCount} steps</span>
        <span className="bqw-complete-summary__sep">{'\u00B7'}</span>
        <span>{elapsedSec}s</span>
        {screenshots.length > 0 && (
          <>
            <span className="bqw-complete-summary__sep">{'\u00B7'}</span>
            <span>{screenshots.length} screenshot{screenshots.length !== 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {hasError && (
        <div className="bqw-complete-error">
          {results.error}
        </div>
      )}

      {results.results && (
        <div className="bqw-complete-results">
          <div className="bqw-complete-results__label">Results</div>
          <div className="bqw-complete-results__body">
            {typeof results.results === 'string'
              ? results.results
              : JSON.stringify(results.results, null, 2)}
          </div>
        </div>
      )}

      {/* Step recap */}
      <div className="bqw-complete-steps">
        {steps.map((step, i) => (
          <div key={step.id || i} className="bqw-exec-step">
            <span className="bqw-exec-step__num">{i + 1}.</span>
            <StepIcon status={step.status || 'done'} />
            <span className="bqw-exec-step__desc">
              {step.description || step.action}
              {step.elapsed != null && (
                <span className="bqw-exec-step__elapsed"> ({Math.round(step.elapsed / 1000)}s)</span>
              )}
            </span>
          </div>
        ))}
      </div>

      {/* ─── Screenshots from this run ───────────────────────── */}
      {screenshots.length > 0 && orgId && (
        <div className="bqw-complete-screenshots">
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
            Screenshots ({screenshots.length})
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {screenshots.map((ssId, i) => (
              <a
                key={ssId}
                href={getGalleryImageUrl(orgId, ssId, 'full')}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'block', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}
              >
                <img
                  src={getGalleryImageUrl(orgId, ssId, 'thumb')}
                  alt={`Screenshot ${i + 1}`}
                  style={{ display: 'block', width: 160, height: 100, objectFit: 'cover', background: 'rgba(0,0,0,0.3)' }}
                  onError={e => { e.target.style.display = 'none' }}
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ─── Inline Schedule Panel ───────────────────────────── */}
      {showSchedule && !scheduled && (
        <div className="bqw-schedule-panel">
          <div className="bqw-schedule-panel__row">
            <input
              type="text"
              className="bqw-field__input bqw-schedule-input"
              placeholder="every Monday at 9am"
              value={scheduleText}
              onChange={e => handleScheduleTextChange(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleScheduleSubmit()}
              autoFocus
            />
            <button
              className="bqw-btn bqw-btn--primary bqw-btn--small"
              onClick={handleScheduleSubmit}
              disabled={scheduling || !parsedCron}
            >
              {scheduling ? (
                <><span className="bqw-spinner" /> Scheduling...</>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  Schedule
                </>
              )}
            </button>
          </div>
          {parsedHuman && (
            <div className="bqw-schedule-panel__preview">
              Runs: {parsedHuman}
              <span className="bqw-schedule-panel__cron">({parsedCron})</span>
            </div>
          )}
          {scheduleText && !parsedCron && (
            <div className="bqw-schedule-panel__hint">
              Try: "every day at 6am", "every Monday at 9am", "every 30 minutes"
            </div>
          )}
          {scheduleError && (
            <div className="bqw-schedule-panel__error">{scheduleError}</div>
          )}
        </div>
      )}

      {scheduled && (
        <div className="bqw-schedule-panel bqw-schedule-panel--done">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#30ff90' }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>Scheduled! View in Mission Control {'\u2192'} Schedules tab.</span>
        </div>
      )}

      <div className="bqw-actions bqw-actions--complete">
        <button
          className="bqw-btn bqw-btn--primary"
          onClick={handleSaveAsAutomation}
          disabled={saving || saved || hasError}
        >
          {saved ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Saved {'\u2713'}
            </>
          ) : saving ? (
            <>
              <span className="bqw-spinner" />
              Saving...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              Save as Automation
            </>
          )}
        </button>
        <button
          className={`bqw-btn ${scheduled ? 'bqw-btn--ghost' : 'bqw-btn--secondary'}`}
          onClick={() => setShowSchedule(v => !v)}
          disabled={hasError || scheduled}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {scheduled ? 'Scheduled \u2713' : showSchedule ? 'Hide Schedule' : 'Schedule This'}
        </button>
        {hasExtractedResults && (
          <button
            className="bqw-btn bqw-btn--secondary"
            onClick={handleCreateActions}
            disabled={creatingActions || actionsCreated || hasError}
          >
            {actionsCreated ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Actions Created {'\u2713'}
              </>
            ) : creatingActions ? (
              <><span className="bqw-spinner" /> Creating...</>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create Actions from Results
              </>
            )}
          </button>
        )}
        <button className="bqw-btn bqw-btn--secondary" onClick={onRunAgain}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Run Again
        </button>
        <button className="bqw-btn bqw-btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

// ─── Main Wizard Orchestrator ─────────────────────────────────────────

export default function AutomationWizard({ authFetch, orgId, wizardStep, setWizardStep, wizardData, setWizardData, onClose }) {
  const [planning, setPlanning] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState(null)

  // ─── Credential Management ──────────────────────────────────────────
  const [credentials, setCredentials] = useState([])
  const [credentialsLoading, setCredentialsLoading] = useState(false)

  // Fetch credentials when "Needs login" is checked
  useEffect(() => {
    if (!wizardData.needsLogin || !orgId) return
    setCredentialsLoading(true)
    listBrowserCredentials(authFetch, orgId)
      .then(setCredentials)
      .catch(() => setCredentials([]))
      .finally(() => setCredentialsLoading(false))
  }, [wizardData.needsLogin, authFetch, orgId])

  const handleAddCredential = useCallback(async ({ domain, username, password }) => {
    try {
      const result = await createBrowserCredential(authFetch, orgId, { domain, username, password })
      // Refresh the list
      const updated = await listBrowserCredentials(authFetch, orgId)
      setCredentials(updated)
      return result
    } catch (err) {
      console.error('[AutomationWizard] Credential save failed:', err)
      setError(`Failed to save credential: ${err.message}`)
      throw err
    }
  }, [authFetch, orgId])

  // Step 1 → Step 2: plan the automation
  const handlePlan = useCallback(async () => {
    setPlanning(true)
    setError(null)
    try {
      // BQ-RC-2: Try fast path first (skip LLM decomposition for simple patterns)
      if (!wizardData.needsLogin) {
        try {
          const fastRes = await authFetch('/screencap/api/browser-objectives/fast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: wizardData.url,
              intent: wizardData.intent,
              org_id: orgId,
              record_video: wizardData.recordVideo,
            }),
          })
          const fastData = await fastRes.json()
          if (fastData.success && fastData.fast_path) {
            console.log(`[AutomationWizard] Fast path matched: ${fastData.pattern_id}`)
            setWizardData(prev => ({
              ...prev,
              objectiveId: fastData.objective.id,
              plan: fastData.objective,
              isAgentic: false,
              isFastPath: true,
              fastPathPattern: fastData.pattern_id,
            }))
            setWizardStep('plan_review')
            return
          }
        } catch (fastErr) {
          console.warn('[AutomationWizard] Fast path check failed, using agentic:', fastErr.message)
        }
      }

      // Agentic path: create tasks-service objective (appears in Mission Control)
      const taskIntent = `${wizardData.intent}. Start by navigating to ${wizardData.url}.${wizardData.needsLogin ? ' Login is required — use vault credentials.' : ''}${wizardData.credentialId ? ` Credential ID: ${wizardData.credentialId}` : ''}`
      const createRes = await authFetch('/tasks/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: wizardData.intent.substring(0, 100),
          description: taskIntent,
          org_id: orgId,
          max_tokens: 50000,
          max_duration_ms: 900000,
        }),
      })
      const objective = await createRes.json()
      const objectiveId = objective.id

      // Start decomposition (will assign browser-q agent)
      await authFetch(`/tasks/api/objectives/${objectiveId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      // Poll for decomposition to complete (CLI path can take 30-60s)
      let plan = null
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const checkRes = await authFetch(`/tasks/api/objectives/${objectiveId}`)
        const obj = await checkRes.json()
        if (obj.status === 'decomposed') {
          plan = obj
          break
        }
        if (obj.status === 'failed') throw new Error('Plan generation failed')
      }
      if (!plan) throw new Error('Plan generation timed out')

      setWizardData(prev => ({
        ...prev,
        objectiveId,
        plan,
        isAgentic: true,
      }))
      setWizardStep('plan_review')
    } catch (err) {
      console.error('[AutomationWizard] Plan error:', err)
      setError(err.message || 'Failed to plan automation')
    } finally {
      setPlanning(false)
    }
  }, [authFetch, wizardData, orgId, setWizardData, setWizardStep])

  // Step 2 → Step 3: approve and run
  const [screencastSessionId, setScreencastSessionId] = useState(null)

  const handleApproveAndRun = useCallback(async () => {
    setApproving(true)
    setError(null)
    try {
      if (wizardData.isAgentic) {
        // Agentic path: approve plan triggers QuoxFlow execution
        const approveRes = await authFetch(`/tasks/api/objectives/${wizardData.objectiveId}/approve-plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        const result = await approveRes.json()
        if (result.quoxflow_execution_id) {
          setScreencastSessionId(`agentic_${result.quoxflow_execution_id}`)
        }
      } else {
        // Legacy screencap path
        const result = await executeBrowserObjective(authFetch, wizardData.objectiveId, orgId)
        if (result.screencast_session_id) {
          setScreencastSessionId(result.screencast_session_id)
        }
      }
      setWizardStep('executing')
    } catch (err) {
      console.error('[AutomationWizard] Execute error:', err)
      setError(err.message || 'Failed to start execution')
    } finally {
      setApproving(false)
    }
  }, [authFetch, wizardData.objectiveId, setWizardStep])

  // Step 3 → Step 4: execution complete
  const handleExecutionComplete = useCallback((results) => {
    setWizardData(prev => ({ ...prev, results }))
    setWizardStep('complete')
  }, [setWizardData, setWizardStep])

  // Run again from completion
  const handleRunAgain = useCallback(() => {
    setWizardData(prev => ({
      ...prev,
      objectiveId: null,
      plan: null,
      results: null
    }))
    setWizardStep('input')
  }, [setWizardData, setWizardStep])

  if (!wizardStep) return null

  return (
    <div className="bqw">
      {error && (
        <div className="bqw-error">
          <span>{'\u26A0'} {error}</span>
          <button className="bqw-error__dismiss" onClick={() => setError(null)}>{'\u2715'}</button>
        </div>
      )}

      {wizardStep === 'input' && (
        <WizardInput
          wizardData={wizardData}
          setWizardData={setWizardData}
          onPlan={handlePlan}
          planning={planning}
          credentials={credentials}
          credentialsLoading={credentialsLoading}
          onAddCredential={handleAddCredential}
        />
      )}

      {wizardStep === 'planning' && (
        <div className="bqw-step bqw-step--planning">
          <div className="bqw-planning-state">
            <span className="bqw-exec-spinner" />
            <span>Planning automation...</span>
            <span className="bqw-planning-sub">Browser-Q is analysing the target and generating steps</span>
          </div>
        </div>
      )}

      {wizardStep === 'plan_review' && (
        <WizardPlanReview
          wizardData={wizardData}
          onApprove={handleApproveAndRun}
          onCancel={onClose}
          approving={approving}
        />
      )}

      {wizardStep === 'executing' && (
        <WizardExecution
          wizardData={wizardData}
          authFetch={authFetch}
          orgId={orgId}
          onComplete={handleExecutionComplete}
          onCancel={onClose}
          screencastSessionId={screencastSessionId}
        />
      )}

      {wizardStep === 'complete' && (
        <WizardComplete
          wizardData={wizardData}
          authFetch={authFetch}
          orgId={orgId}
          onClose={onClose}
          onRunAgain={handleRunAgain}
        />
      )}
    </div>
  )
}
