/**
 * BrowserQ Run Detail View — Three-column layout
 *
 * Route: /browser-q/run/:objectiveId
 *
 * Layout:
 *   Top: RunMetadataBar (back, title, status, actions)
 *   Left (250px): StepTimeline (clickable step list)
 *   Center (flex): ViewportPanel (live stream or screenshot) + TimelineScrubber
 *   Right (300px): StepDetailPanel (tabbed: Info/Data/Errors)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import {
  RunMetadataBar, StepTimeline, TimelineScrubber,
  StepDetailPanel, ViewportPanel, GlassPanel,
} from '../../components/browser-q/RunDetailComponents'
import LiveSessionViewer from '../../components/browser-q/LiveSessionViewer'
import AgenticReasoningLog from '../../components/browser-q/AgenticReasoningLog'
import { approveStep, createAgenticBrowserRun, getGalleryImageUrl } from '../../services/browserQService'

function getScreenshotUrl(orgId, screenshotId) {
  return `/screencap/api/browser-q/gallery/${screenshotId}/image?org_id=${encodeURIComponent(orgId)}&type=full`
}
import './browser-q-run-detail.css'

const POLL_INTERVAL_ACTIVE = 2000
const POLL_INTERVAL_IDLE = 0 // no polling for completed runs

export default function BrowserQRunDetailView() {
  const { objectiveId } = useParams()
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id || 'default'

  const [objective, setObjective] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeStepIndex, setActiveStepIndex] = useState(-1)
  const [stepScreenshots, setStepScreenshots] = useState({}) // stepIndex → base64 or URL
  const [approvingStep, setApprovingStep] = useState(false)
  const pollRef = useRef(null)
  const [galleryScreenshots, setGalleryScreenshots] = useState([])
  const [selectedGalleryIdx, setSelectedGalleryIdx] = useState(0)

  // Detect agentic vs screencap objective by ID format
  const isAgentic = objectiveId && !objectiveId.startsWith('obj_')

  // P8.E.3 (DEFERRED to BQ-AGENTIC-MIGRATION): Feature flag — when explicitly
  // enabled, tries QuoxFlow execution store first for agentic runs, falling
  // back to the tasks-service path.
  //
  // Per master plan (Adam: "forget BrowserQ until the engine underneath is
  // 100%"), default is OFF; tasks-service path is canonical until the
  // engine validation suite ships green 14 nights + P9 + P8.D harness.
  // Set VITE_AGENTIC_BROWSER_Q=true to opt in while the migration is in flight.
  const agenticBrowserQEnabled = import.meta.env.VITE_AGENTIC_BROWSER_Q === 'true'

  /**
   * Convert a QuoxFlow StoredExecution record (or its output) into BrowserQ's
   * internal step format. The agentic executor writes action_log into output.
   */
  function quoxflowExecutionToObj(execution) {
    const output = execution.output || {}
    const actionLog = output.action_log || []
    const obj = {
      id: execution.id,
      status: execution.status === 'completed' ? 'completed' : execution.status === 'failed' ? 'failed' : 'running',
      intent: execution.workflowName || execution.workflow_name || `Execution ${execution.id}`,
      url: '',
      _isAgentic: true,
      _fromQuoxflow: true,
      final_reasoning: output.final_reasoning || '',
      objective_met: output.objective_met || false,
      iterations: output.iterations || actionLog.length,
      steps: actionLog.map((a, i) => ({
        id: `step-${i}`,
        action: a.action,
        description: (a.reasoning || '').substring(0, 100),
        status: a.success !== false ? 'completed' : 'failed',
        result: { observation: a.observation || '', durationMs: a.durationMs || 0 },
      })),
      tasks: [],
    }
    // Extract URL from objective if embedded in trigger data
    const triggerUrl = (execution.triggerData || execution.trigger_data || {}).url || ''
    if (triggerUrl) obj.url = triggerUrl
    return obj
  }

  // Fetch objective data — agentic objectives come from tasks service, screencap from screencap API
  const fetchObjective = useCallback(async () => {
    try {
      let obj
      if (isAgentic) {
        // P8.E.3: Try QuoxFlow execution store first (when flag enabled).
        // Falls back to tasks-service path if not found or flag disabled.
        let quoxflowObj = null
        if (agenticBrowserQEnabled) {
          try {
            const qfRes = await authFetch(`/quoxflow/api/executions/${objectiveId}`)
            if (qfRes.ok) {
              const qfData = await qfRes.json()
              // QuoxFlow returns { success, data: StoredExecution }
              const execution = qfData.data || qfData
              if (execution && execution.id) {
                quoxflowObj = quoxflowExecutionToObj(execution)
              }
            }
          } catch { /* best-effort: QuoxFlow may not be running */ }
        }

        if (quoxflowObj) {
          obj = quoxflowObj
        } else {
          // Fallback: tasks-service path (legacy agentic path)
          const res = await authFetch(`/tasks/api/objectives/${objectiveId}`)
          if (!res.ok) throw new Error(`Failed to load run (${res.status})`)
          const data = await res.json()
          obj = data
          // Convert tasks-service format to BrowserQ format
          const tasks = data.tasks || []
          const browserTask = tasks.find(t => t.agent_id === 'browser-q') || tasks[0]
          let parsed = null
          try {
            parsed = typeof browserTask?.result === 'string' ? JSON.parse(browserTask.result) : (browserTask?.result || null)
          } catch { parsed = null }
          const actionLog = parsed?.action_log || []
          // Map action log to steps format
          obj.steps = actionLog.map((a, i) => ({
            id: `step-${i}`,
            action: a.action,
            description: (a.reasoning || '').substring(0, 100),
            status: a.success !== false ? 'completed' : 'failed',
            result: { observation: a.observation || '', durationMs: a.durationMs || 0 },
          }))
          obj.intent = data.title
          obj.url = (data.description || '').match(/https?:\/\/[^\s,)]+/)?.[0] || ''
          obj._isAgentic = true
          obj.final_reasoning = parsed?.final_reasoning || ''
          obj.objective_met = parsed?.objective_met || false
          obj.iterations = parsed?.iterations || actionLog.length
        }
      } else {
        // Screencap path: original behavior
        const res = await fetch(`/screencap/api/browser-objectives/${objectiveId}?org_id=${encodeURIComponent(orgId)}`)
        if (!res.ok) throw new Error(`Failed to load run (${res.status})`)
        const data = await res.json()
        obj = data.objective || data
      }
      setObjective(obj)
      setError(null)

      // Resolve step screenshots
      const screenshots = {}
      if (!isAgentic) {
        for (let i = 0; i < (obj.steps || []).length; i++) {
          const step = obj.steps[i]
          if (step.screenshot_id && orgId) {
            screenshots[i] = getScreenshotUrl(orgId, step.screenshot_id)
          }
        }
      }
      setStepScreenshots(screenshots)

      // Auto-select first completed step if none selected
      if (activeStepIndex === -1 && obj.steps?.length > 0) {
        const firstDone = obj.steps.findIndex(s => s.status === 'completed' || s.status === 'done')
        if (firstDone >= 0) setActiveStepIndex(firstDone)
      }

      return obj
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [objectiveId, orgId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch + polling
  useEffect(() => {
    fetchObjective()

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop polling based on objective status
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)

    const isRunning = objective?.status === 'running'
    const isPaused = objective?.status === 'paused' || objective?.status === 'planned'
    // Running: poll every 2s. Paused/planned: poll every 10s (waiting for approval, no rush)
    if (isRunning) {
      pollRef.current = setInterval(fetchObjective, POLL_INTERVAL_ACTIVE)
    } else if (isPaused) {
      pollRef.current = setInterval(fetchObjective, 10000)
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [objective?.status, fetchObjective])

  // Fetch gallery screenshots for agentic runs
  useEffect(() => {
    if (!isAgentic || !orgId) return
    let cancelled = false
    const fetchGallery = async () => {
      try {
        const res = await fetch(`/screencap/api/browser-q/gallery?org_id=${encodeURIComponent(orgId)}&limit=20`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        setGalleryScreenshots(data.screenshots || [])
      } catch { /* best-effort */ }
    }
    fetchGallery()
    // Poll gallery while running
    const isActive = objective?.status === 'running' || objective?.status === 'paused'
    if (isActive) {
      const id = setInterval(fetchGallery, 5000)
      return () => { cancelled = true; clearInterval(id) }
    }
    return () => { cancelled = true }
  }, [isAgentic, orgId, objective?.status])

  // Handlers
  const handleBack = useCallback(() => navigate('/browser-q'), [navigate])

  const handleStepClick = useCallback((index) => {
    setActiveStepIndex(index)
  }, [])

  const handleApprove = useCallback(async () => {
    if (!objective) return
    // Match any pending approval status variant
    const pendingStep = objective.steps?.find(s =>
      s.status === 'awaiting_approval' || s.status === 'paused' ||
      s.status === 'pending_approval' || s.needs_hitl
    )
    if (!pendingStep) {
      // No specific step found — try approving the objective itself
      console.warn('[BQ] No pending step found, approving objective directly')
      setApprovingStep(true)
      try {
        // Try objective-level approve endpoint
        await authFetch(`/screencap/api/browser-objectives/${objectiveId}/approve?org_id=${encodeURIComponent(orgId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        })
        await fetchObjective()
      } catch (err) {
        console.error('Objective-level approve failed:', err)
      } finally {
        setApprovingStep(false)
      }
      return
    }

    setApprovingStep(true)
    try {
      await approveStep(authFetch, objectiveId, pendingStep.id, orgId)
      await fetchObjective()
    } catch (err) {
      console.error('Approve failed:', err)
    } finally {
      setApprovingStep(false)
    }
  }, [objective, objectiveId, orgId, authFetch, fetchObjective])

  const handleRerun = useCallback(async () => {
    try {
      if (isAgentic) {
        // Agentic path: use QuoxFlow execution
        const result = await createAgenticBrowserRun(
          objective.intent || objective.title,
          objective.url,
          { credentialId: objective.credential_id, needsLogin: objective.needs_login }
        )
        if (result?.executionId) {
          navigate(`/executions/${result.executionId}`)
        }
        return
      }
      // Screencap path: legacy objective flow
      const createRes = await fetch(`/screencap/api/browser-objectives?org_id=${encodeURIComponent(orgId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: objective.url,
          intent: objective.intent,
          org_id: orgId,
          needs_login: objective.needs_login,
          credential_id: objective.credential_id,
        }),
      })
      const { objective: newObj } = await createRes.json()
      if (!newObj) return

      await fetch(`/screencap/api/browser-objectives/${newObj.id}/plan?org_id=${encodeURIComponent(orgId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: objective.steps?.map(s => ({
            action: s.action, description: s.description,
            params: s.params, needs_hitl: s.needs_hitl,
          })),
        }),
      })

      await fetch(`/screencap/api/browser-objectives/${newObj.id}/execute?org_id=${encodeURIComponent(orgId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: `rerun_${newObj.id}` }),
      })

      navigate(`/browser-q/run/${newObj.id}`)
    } catch (err) {
      console.error('Rerun failed:', err)
    }
  }, [objective, orgId, navigate, isAgentic])

  const handleSave = useCallback(async () => {
    try {
      await fetch(`/screencap/api/browser-q/automations/from-run/${objectiveId}?org_id=${encodeURIComponent(orgId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      console.error('Save as automation failed:', err)
    }
  }, [objectiveId, orgId])

  // Keyboard shortcuts (must be after all useCallback definitions)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const s = objective?.steps || []
      switch (e.key) {
        case 'ArrowDown': case 'j':
          e.preventDefault(); setActiveStepIndex(prev => Math.min(prev + 1, s.length - 1)); break
        case 'ArrowUp': case 'k':
          e.preventDefault(); setActiveStepIndex(prev => Math.max(prev - 1, 0)); break
        case 'Escape':
          e.preventDefault(); navigate('/browser-q'); break
        case 'a':
          if (!e.metaKey && !e.ctrlKey && s.find(x => x.status === 'awaiting_approval')) {
            e.preventDefault(); handleApprove()
          }
          break
        case 'r':
          if (!e.metaKey && !e.ctrlKey && objective?.status === 'completed') {
            e.preventDefault(); handleRerun()
          }
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [objective, navigate, handleApprove, handleRerun])

  // Derived state
  const steps = objective?.steps || []
  const activeStep = activeStepIndex >= 0 ? steps[activeStepIndex] : null
  const isLive = objective?.status === 'running' || objective?.status === 'paused'
  const activeScreenshot = activeStepIndex >= 0 ? stepScreenshots[activeStepIndex] : null

  // Loading state
  if (loading) {
    return (
      <div className="bq-run-detail">
        <GlassPanel style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ width: 36, height: 20, borderRadius: 6, background: 'rgba(255,255,255,0.05)', animation: 'bq-pulse 1.5s ease-in-out infinite' }} />
          <div style={{ flex: 1, height: 16, borderRadius: 4, background: 'rgba(255,255,255,0.04)', animation: 'bq-pulse 1.5s ease-in-out infinite' }} />
          <div style={{ width: 80, height: 24, borderRadius: 6, background: 'rgba(255,255,255,0.04)', animation: 'bq-pulse 1.5s ease-in-out infinite' }} />
        </GlassPanel>
        <div className="bq-run-detail__columns">
          <GlassPanel style={{ padding: 10 }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} style={{ height: 40, borderRadius: 8, background: 'rgba(255,255,255,0.03)', marginBottom: 6, animation: 'bq-pulse 1.5s ease-in-out infinite', animationDelay: `${i * 0.1}s` }} />
            ))}
          </GlassPanel>
          <GlassPanel style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: '80%', height: '60%', borderRadius: 8, background: 'rgba(255,255,255,0.03)', animation: 'bq-pulse 1.5s ease-in-out infinite' }} />
          </GlassPanel>
          <GlassPanel style={{ padding: 10 }}>
            <div style={{ height: 30, borderRadius: 6, background: 'rgba(255,255,255,0.04)', marginBottom: 10, animation: 'bq-pulse 1.5s ease-in-out infinite' }} />
            {[1,2,3].map(i => (
              <div key={i} style={{ height: 18, borderRadius: 4, background: 'rgba(255,255,255,0.03)', marginBottom: 8, animation: 'bq-pulse 1.5s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
            ))}
          </GlassPanel>
        </div>
      </div>
    )
  }

  if (error || !objective) {
    return (
      <div className="bq-run-detail">
        <GlassPanel style={{ padding: 20, textAlign: 'center' }}>
          <div style={{ color: '#ef4444', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            {error || 'Run not found'}
          </div>
          <button onClick={handleBack} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.2)',
            color: '#fff', padding: '6px 16px', borderRadius: 8, cursor: 'pointer',
          }}>
            Back to BrowserQ
          </button>
        </GlassPanel>
      </div>
    )
  }

  // Agentic run: three-column layout — viewer + reasoning + summary
  if (objective._isAgentic) {
    const selectedScreenshot = galleryScreenshots[selectedGalleryIdx]
    return (
      <div className="bq-run-detail">
        <RunMetadataBar
          objective={objective}
          onBack={handleBack}
          onRerun={handleRerun}
          onSave={handleSave}
          onApprove={handleApprove}
        />
        <div className="bq-run-detail__columns" style={{ gridTemplateColumns: '1fr 340px 300px' }}>
          {/* Left: Screenshot viewer (big) */}
          <div className="bq-run-detail__center" style={{ minHeight: 0 }}>
            <GlassPanel style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)', position: 'relative' }}>
                {selectedScreenshot ? (
                  <img
                    src={getGalleryImageUrl(orgId, selectedScreenshot.id, 'full')}
                    alt={selectedScreenshot.description || 'Screenshot'}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div style={{ textAlign: 'center', padding: 40 }}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1" style={{ stroke: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                    <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>
                      {objective.status === 'running' ? 'Waiting for screenshots...' : 'No screenshots captured'}
                    </div>
                  </div>
                )}
              </div>
              {/* Thumbnail strip */}
              {galleryScreenshots.length > 0 && (
                <div style={{ display: 'flex', gap: 4, padding: '6px 8px', overflowX: 'auto', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {galleryScreenshots.map((ss, i) => (
                    <button
                      key={ss.id}
                      onClick={() => setSelectedGalleryIdx(i)}
                      style={{
                        flexShrink: 0, width: 64, height: 42, borderRadius: 4, overflow: 'hidden',
                        border: i === selectedGalleryIdx ? '2px solid #06b6d4' : '2px solid transparent',
                        cursor: 'pointer', padding: 0, background: 'rgba(0,0,0,0.3)',
                        boxShadow: i === selectedGalleryIdx ? '0 0 8px rgba(6,182,212,0.3)' : 'none',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <img
                        src={getGalleryImageUrl(orgId, ss.id, 'thumb')}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}
            </GlassPanel>
          </div>

          {/* Middle: Reasoning log */}
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <GlassPanel style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <AgenticReasoningLog actionLog={objective.steps?.map((s, i) => ({
                iteration: i,
                action: s.action,
                reasoning: s.description,
                observation: s.result?.observation || '',
                success: s.status === 'completed',
                durationMs: s.result?.durationMs || 0,
              })) || []} />
            </GlassPanel>
          </div>

          {/* Right: Summary */}
          <div className="bq-run-detail__right">
            <GlassPanel style={{ height: '100%', padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, color: '#fff', margin: '0 0 12px' }}>
                {objective.objective_met ? '\u2713 Objective Complete' : objective.status === 'running' ? '\u25C9 Running...' : '\u2717 ' + objective.status}
              </h3>
              {objective.final_reasoning && (
                <div style={{ fontSize: 12, color: '#fff', lineHeight: 1.6, marginBottom: 16, whiteSpace: 'pre-wrap' }}>
                  {objective.final_reasoning}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>Iterations: {objective.iterations || 0}</div>
                <div>Actions: {objective.steps?.length || 0}</div>
                <div style={{ wordBreak: 'break-all' }}>URL: {objective.url || '\u2014'}</div>
              </div>

              {/* Quick actions */}
              <div style={{ marginTop: 'auto', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {objective.status === 'completed' && (
                  <button
                    onClick={handleRerun}
                    style={{
                      width: '100%', padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                      cursor: 'pointer', border: '1px solid rgba(16,185,129,0.3)',
                      background: 'rgba(16,185,129,0.12)', color: '#10b981',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {'\u21BB'} Rerun This Objective
                  </button>
                )}
                {(objective.status === 'failed' || objective.status === 'cancelled') && (
                  <button
                    onClick={handleRerun}
                    style={{
                      width: '100%', padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                      cursor: 'pointer', border: '1px solid rgba(245,158,11,0.3)',
                      background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {'\u21BB'} Retry
                  </button>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bq-run-detail">
      {/* Top: Metadata bar */}
      <RunMetadataBar
        objective={objective}
        onBack={handleBack}
        onWatch={() => {}} // LiveSessionViewer handles this in the viewport
        onRerun={handleRerun}
        onSave={handleSave}
        onApprove={handleApprove}
      />

      {/* Three-column layout */}
      <div className="bq-run-detail__columns">
        {/* Left: Step timeline */}
        <div className="bq-run-detail__left">
          <StepTimeline
            steps={steps}
            activeStepIndex={activeStepIndex}
            onStepClick={handleStepClick}
          />
        </div>

        {/* Center: Viewport + scrubber */}
        <div className="bq-run-detail__center">
          {isLive ? (
            <div className="bq-run-detail__live-wrapper">
              <LiveSessionViewer
                objectiveId={objectiveId}
                sessionId={objective.session_id || objectiveId}
                steps={steps}
              />
            </div>
          ) : (
            <ViewportPanel
              screenshot={activeScreenshot}
              isLive={false}
            />
          )}
          <TimelineScrubber
            steps={steps}
            activeStepIndex={activeStepIndex}
            onStepClick={handleStepClick}
          />
        </div>

        {/* Right: Detail panel */}
        <div className="bq-run-detail__right">
          <StepDetailPanel
            step={activeStep}
            objective={objective}
          />
        </div>
      </div>

      {/* Keyboard shortcuts hint */}
      <div style={{
        position: 'fixed', bottom: 12, right: 12,
        display: 'flex', gap: 8, padding: '6px 12px',
        borderRadius: 8, fontSize: 10,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(12px)',
        color: 'rgba(255,255,255,0.6)',
        fontFamily: "'JetBrains Mono', monospace",
        pointerEvents: 'none', zIndex: 50,
      }}>
        <span><kbd style={{ color: '#fff', fontWeight: 600 }}>j/k</kbd> steps</span>
        <span><kbd style={{ color: '#fff', fontWeight: 600 }}>a</kbd> approve</span>
        <span><kbd style={{ color: '#fff', fontWeight: 600 }}>r</kbd> rerun</span>
        <span><kbd style={{ color: '#fff', fontWeight: 600 }}>esc</kbd> back</span>
      </div>
    </div>
  )
}
