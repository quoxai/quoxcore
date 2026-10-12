/**
 * ObjectiveControlBar — Shared action buttons for objectives
 *
 * Extracted from ObjectivesView.jsx (UX-0B).
 * Shows context-appropriate action buttons based on objective status.
 * WC-2: Schedule from Template — after saving a template, offers inline scheduling.
 * WC-4: Variable parameterisation — detect IPs/hostnames/paths and let user confirm variables.
 *
 * Props:
 *   status         — objective status string
 *   tasks          — array of task objects (for variable detection)
 *   onPlanTasks    — callback for "Plan Tasks" (pending)
 *   onPause        — callback for "Pause" (running)
 *   onResume       — callback for "Resume" (paused)
 *   onCancel       — callback for "Cancel" (pending/running/paused/decomposed)
 *   onRerun        — callback for "Rerun" (completed/failed/cancelled)
 *   onClone        — optional callback for "Clone" (completed/failed/cancelled)
 *   onWatchOpsDeck — optional callback for "Watch in OpsDeck" (running)
 *   onSaveTemplate — callback for "Save as Template" → must return { id, name, template_json }
 *   onSaveTemplateWithVars — callback(name, variables) for saving with variable metadata
 *   onCreateSchedule — optional callback(cronExpression, templateData) for scheduling
 */

import { useState, useMemo } from 'react'
import Button from '../ui/Button'
import { naturalLanguageToCron, cronToHuman } from '../../services/cronHelper'
import { detectVariables, parameteriseTemplate } from '../../services/templateVariables'

const SCHEDULE_PRESETS = [
  { label: 'Daily 9am', text: 'every day at 9am' },
  { label: 'Weekdays', text: 'every weekday' },
  { label: 'Weekly Mon', text: 'every monday at 9am' },
  { label: 'Monthly 1st', text: 'every month' },
]

const inputStyle = {
  flex: 1, background: 'transparent', border: 'none', outline: 'none',
  color: 'rgba(255,255,255,0.9)', fontSize: 12,
  fontFamily: "'SF Mono', monospace",
}

const panelStyle = {
  display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 8,
  padding: '10px 12px', background: 'rgba(99,102,241,0.08)', borderRadius: 8,
  border: '1px solid rgba(99,102,241,0.2)',
}

const chipStyle = {
  background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
  borderRadius: 6, padding: '3px 8px', fontSize: 11, color: 'rgba(255,255,255,0.7)',
  cursor: 'pointer', fontFamily: "'SF Mono', monospace",
}

export default function ObjectiveControlBar({
  status,
  tasks,
  hasSkipped,
  onPlanTasks,
  onPause,
  onResume,
  onCancel,
  onRerun,
  onResumeSkipped,
  onSaveTemplate,
  onSaveTemplateWithVars,
  onCreateSchedule,
  onClone,
  onWatchOpsDeck,
  onCrystallise,
}) {
  // Template save state
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [saving, setSaving] = useState(false)

  // WC-4: Variable detection state
  const [showVarChecklist, setShowVarChecklist] = useState(false)
  const [detectedVars, setDetectedVars] = useState([])
  const [checkedVars, setCheckedVars] = useState({}) // { value: boolean }
  const [pendingName, setPendingName] = useState('') // name waiting for variable confirmation

  // WC-2: Schedule state (shown after template save)
  const [showSchedule, setShowSchedule] = useState(false)
  const [savedTemplate, setSavedTemplate] = useState(null)
  const [scheduleText, setScheduleText] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState(null) // 'done' | null

  // Parse NL text to cron in real time
  const parsedCron = useMemo(() => naturalLanguageToCron(scheduleText), [scheduleText])
  const parsedHuman = useMemo(() => parsedCron ? cronToHuman(parsedCron) : null, [parsedCron])

  // WC-4: After user types name and clicks Save, scan for variables first
  const handleNameSubmit = (name) => {
    const vars = detectVariables(tasks || [])
    if (vars.length > 0) {
      // Show variable checklist before saving
      setDetectedVars(vars)
      const initial = {}
      for (const v of vars) initial[v.value] = v.preChecked
      setCheckedVars(initial)
      setPendingName(name)
      setShowSaveInput(false)
      setShowVarChecklist(true)
    } else {
      // No variables found — save directly
      doSaveTemplate(name, [])
    }
  }

  const toggleVar = (value) => {
    setCheckedVars(prev => ({ ...prev, [value]: !prev[value] }))
  }

  // WC-4: Confirm variable selection and save
  const confirmVarsAndSave = () => {
    const selected = detectedVars.filter(v => checkedVars[v.value])
    doSaveTemplate(pendingName, selected)
    setShowVarChecklist(false)
    setDetectedVars([])
    setCheckedVars({})
    setPendingName('')
  }

  const dismissVarChecklist = () => {
    // Save without any variables
    doSaveTemplate(pendingName, [])
    setShowVarChecklist(false)
    setDetectedVars([])
    setCheckedVars({})
    setPendingName('')
  }

  // Save template, then transition to schedule UI
  const doSaveTemplate = async (name, selectedVars) => {
    setSaving(true)
    try {
      let result
      if (selectedVars && selectedVars.length > 0 && onSaveTemplateWithVars) {
        result = await onSaveTemplateWithVars(name, selectedVars)
      } else {
        result = await onSaveTemplate(name)
      }
      // Transition to schedule prompt
      setShowSaveInput(false)
      setTemplateName('')
      if (onCreateSchedule && result) {
        setSavedTemplate(result)
        setShowSchedule(true)
      }
    } catch {
      // stay on save input on error
    } finally {
      setSaving(false)
    }
  }

  const doSchedule = async () => {
    if (!parsedCron || !savedTemplate || !onCreateSchedule) return
    setScheduling(true)
    try {
      await onCreateSchedule(parsedCron, savedTemplate)
      setScheduleResult('done')
      setTimeout(() => {
        setShowSchedule(false)
        setScheduleResult(null)
        setSavedTemplate(null)
        setScheduleText('')
      }, 2500)
    } catch {
      // keep UI open on error
    } finally {
      setScheduling(false)
    }
  }

  const dismissSchedule = () => {
    setShowSchedule(false)
    setSavedTemplate(null)
    setScheduleText('')
    setScheduleResult(null)
  }

  return (
    <div className="obj-action-bar" role="toolbar" aria-label="Objective actions">
      {status === 'pending' && (
        <Button
          variant="primary" size="sm"
          onClick={onPlanTasks}
          style={{ background: 'var(--m-coral, #ff8a6b)' }}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
        >Plan Tasks</Button>
      )}

      {status === 'running' && (
        <Button
          variant="outline-amber" size="sm"
          onClick={onPause}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>}
        >Pause</Button>
      )}

      {status === 'paused' && (
        <Button
          variant="outline-blue" size="sm"
          onClick={onResume}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21"/></svg>}
        >Resume</Button>
      )}

      {status === 'running' && onWatchOpsDeck && (
        <Button
          variant="outline" size="sm"
          onClick={onWatchOpsDeck}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.4"/><circle cx="12" cy="12" r="5" opacity="0.6"/><circle cx="12" cy="12" r="1.5" fill="rgba(255,255,255,0.8)" stroke="none"/></svg>}
        >Watch in OpsDeck</Button>
      )}

      {['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(status) && (
        <>
          {hasSkipped && onResumeSkipped && (
            <Button
              variant="primary" size="sm"
              onClick={onResumeSkipped}
              style={{ background: '#6366f1' }}
              icon={<span style={{ fontSize: 12 }}>▶</span>}
            >Resume skipped</Button>
          )}
          <Button
            variant="outline" size="sm"
            onClick={onRerun}
            icon={<span style={{ fontSize: 12 }}>↻</span>}
          >Rerun all</Button>
          {onClone && (
            <Button
              variant="outline" size="sm"
              onClick={onClone}
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.7)' }} strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>}
            >Clone</Button>
          )}
        </>
      )}

      {/* Save as Template — for completed objectives */}
      {['completed', 'completed_with_errors'].includes(status) && onSaveTemplate && !showSaveInput && !showSchedule && (
        <Button
          variant="outline" size="sm"
          onClick={() => setShowSaveInput(true)}
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.7)' }} strokeWidth="2" strokeLinecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>}
        >Save as Template</Button>
      )}

      {/* STUDY-REV-2 P1.E — Objective→Workflow CTA */}
      {['completed', 'completed_with_errors'].includes(status) && onCrystallise && !showSaveInput && !showSchedule && (
        <Button
          variant="outline" size="sm"
          onClick={onCrystallise}
          title="Reuse this plan as a Workflow. Each run skips the LLM planning step."
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(99,102,241,0.9)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}
          style={{ borderColor: 'rgba(99,102,241,0.35)', color: 'rgba(165,180,252,0.9)' }}
        >Crystallise into a reusable Workflow</Button>
      )}

      {['pending', 'running', 'paused', 'decomposed'].includes(status) && (
        <Button variant="outline-red" size="sm" onClick={onCancel}>Cancel</Button>
      )}

      {/* Inline save input */}
      {showSaveInput && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: 8,
          padding: '8px 10px', background: 'rgba(99,102,241,0.08)', borderRadius: 8,
          border: '1px solid rgba(99,102,241,0.2)',
        }}>
          <input
            type="text"
            value={templateName}
            onChange={e => setTemplateName(e.target.value)}
            placeholder="Template name..."
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && templateName.trim()) handleNameSubmit(templateName.trim())
              if (e.key === 'Escape') { setShowSaveInput(false); setTemplateName('') }
            }}
            style={inputStyle}
          />
          <Button
            variant="primary" size="sm"
            disabled={!templateName.trim() || saving}
            onClick={() => templateName.trim() && handleNameSubmit(templateName.trim())}
            style={{ background: '#6366f1', padding: '4px 12px', fontSize: 11 }}
          >{saving ? 'Saving...' : 'Save'}</Button>
          <button
            onClick={() => { setShowSaveInput(false); setTemplateName('') }}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
          >✕</button>
        </div>
      )}

      {/* WC-4: Variable detection checklist — shown after name entry, before save */}
      {showVarChecklist && detectedVars.length > 0 && (
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
              Detected variables (uncheck to hardcode):
            </span>
            <button
              onClick={dismissVarChecklist}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11 }}
            >Skip all</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
            {detectedVars.map(v => (
              <label
                key={v.value}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                  background: checkedVars[v.value] ? 'rgba(99,102,241,0.1)' : 'transparent',
                  fontSize: 12, color: 'rgba(255,255,255,0.8)',
                }}
              >
                <input
                  type="checkbox"
                  checked={!!checkedVars[v.value]}
                  onChange={() => toggleVar(v.value)}
                  style={{ accentColor: '#6366f1', width: 14, height: 14, cursor: 'pointer' }}
                />
                <code style={{
                  fontFamily: "'SF Mono', monospace", fontSize: 11,
                  color: 'rgba(255,255,255,0.9)', background: 'rgba(0,0,0,0.2)',
                  padding: '1px 5px', borderRadius: 3,
                }}>{v.value}</code>
                <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>{'  '}→{'  '}</span>
                <code style={{
                  fontFamily: "'SF Mono', monospace", fontSize: 11,
                  color: '#818cf8', background: 'rgba(99,102,241,0.1)',
                  padding: '1px 5px', borderRadius: 3,
                }}>{`{{${v.suggestedName}}}`}</code>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                  {v.label}
                  {v.occurrences > 1 && ` (x${v.occurrences})`}
                </span>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <Button
              variant="primary" size="sm"
              disabled={saving}
              onClick={confirmVarsAndSave}
              style={{ background: '#6366f1', padding: '4px 14px', fontSize: 11 }}
              icon={<span style={{ fontSize: 11 }}>&#9881;</span>}
            >{saving ? 'Saving...' : 'Save template'}</Button>
          </div>
        </div>
      )}

      {/* WC-2: Schedule from Template — shown after template save */}
      {showSchedule && !scheduleResult && (
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
              <span style={{ marginRight: 6 }}>&#128337;</span>Schedule this template?
            </span>
            <button
              onClick={dismissSchedule}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11 }}
            >Skip</button>
          </div>

          <input
            type="text"
            value={scheduleText}
            onChange={e => setScheduleText(e.target.value)}
            placeholder="e.g. every Monday at 9am"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && parsedCron) doSchedule()
              if (e.key === 'Escape') dismissSchedule()
            }}
            style={{
              ...inputStyle,
              flex: 'none', width: '100%',
              padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          />

          {/* Quick presets */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SCHEDULE_PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => setScheduleText(p.text)}
                style={{
                  ...chipStyle,
                  background: scheduleText === p.text ? 'rgba(99,102,241,0.3)' : chipStyle.background,
                  borderColor: scheduleText === p.text ? 'rgba(99,102,241,0.5)' : chipStyle.borderColor,
                }}
              >{p.label}</button>
            ))}
          </div>

          {/* Parsed preview */}
          {scheduleText && (
            <div style={{ fontSize: 11, fontFamily: "'SF Mono', monospace" }}>
              {parsedCron ? (
                <span style={{ color: 'rgba(134,239,172,0.9)' }}>
                  Runs: {parsedHuman} UTC &nbsp;
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>({parsedCron})</span>
                </span>
              ) : (
                <span style={{ color: 'rgba(255,180,120,0.8)' }}>
                  Could not parse schedule. Try "every day at 9am" or "weekly".
                </span>
              )}
            </div>
          )}

          {/* Schedule button */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              variant="primary" size="sm"
              disabled={!parsedCron || scheduling}
              onClick={doSchedule}
              style={{ background: '#6366f1', padding: '4px 14px', fontSize: 11 }}
              icon={<span style={{ fontSize: 11 }}>&#9200;</span>}
            >{scheduling ? 'Scheduling...' : 'Schedule'}</Button>
          </div>
        </div>
      )}

      {/* WC-2: Schedule confirmation */}
      {showSchedule && scheduleResult === 'done' && (
        <div style={{
          ...panelStyle, flexDirection: 'row', alignItems: 'center', gap: 8,
          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)',
        }}>
          <span style={{ fontSize: 14 }}>&#10003;</span>
          <span style={{ fontSize: 12, color: 'rgba(134,239,172,0.9)' }}>
            Scheduled! {parsedHuman && `Runs: ${parsedHuman} UTC`}
          </span>
        </div>
      )}
    </div>
  )
}
