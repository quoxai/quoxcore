/**
 * ScheduleRow — shared schedule row for MC SchedulesPanel, AgenticTeamView, and ObjectivesView.
 *
 * P6.A Item 4+5: Extracted from MissionControlView SchedulesPanel so all three
 * call sites share one row component. Each caller supplies its own list query
 * (listAllSchedules / listTeamSchedules / org-scope); this component only renders
 * and handles per-row actions.
 *
 * Item 5: On a successful "Run Now", captures result.executionId and shows a
 * <Link to="/executions/:id"> for 30s before fading, replacing the old 2s pill.
 */

import { useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { SLACountdown } from '../orchestration'
import { cronToHuman } from '../../services/cronHelper'
import { toggleSchedule, deleteSchedule, triggerSchedule, triggerWorkflowSchedule, toggleWorkflowSchedule } from '../../services/teamService'
import { useAuth } from '../../contexts/AuthContext'

const MONO_FONT = "'SF Mono', 'JetBrains Mono', monospace"

/** Status dot colour for last_status */
function statusDotColor(status) {
  if (status === 'completed') return '#22c55e'
  if (status === 'completed_with_errors') return '#f59e0b'
  if (status === 'failed') return '#ef4444'
  return '#52525b'
}

/**
 * Inline toggle switch — no external CSS dependency.
 */
function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        position: 'relative',
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.1)',
        transition: 'background 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: checked ? '#22c55e' : 'rgba(255,255,255,0.4)',
        transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      }} />
    </button>
  )
}

/**
 * ScheduleRow
 *
 * Props:
 *   schedule   — schedule object from the API
 *   onToggle   — (schedule, newEnabled) => Promise  [optional, falls back to default]
 *   onDelete   — (schedule) => Promise              [optional, falls back to default]
 *   onTrigger  — (schedule, result) => void         [optional callback after trigger]
 *   onUpdated  — (updatedSchedule) => void          [called after toggle succeeds]
 *   onDeleted  — (scheduleId) => void               [called after delete succeeds]
 *   onError    — (message) => void                  [called on any error]
 */
export default function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
  onTrigger,
  onUpdated,
  onDeleted,
  onError,
}) {
  const { authFetch } = useAuth()
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Item 5: track triggered state + executionId
  const [triggeredId, setTriggeredId] = useState(null)   // executionId string or true (fallback)
  const [triggered, setTriggered] = useState(false)
  const triggerTimer = useRef(null)

  const isEnabled = schedule.enabled === 1 || schedule.enabled === true

  // Parse objective template for display
  let templateTitle = ''
  try {
    const tmpl = typeof schedule.objective_template_json === 'string'
      ? JSON.parse(schedule.objective_template_json)
      : schedule.objective_template_json
    templateTitle = tmpl?.title || ''
  } catch { /* ignore */ }

  const isWorkflow = schedule.kind === 'workflow'

  const handleToggle = useCallback(async () => {
    try {
      if (onToggle) {
        await onToggle(schedule, !isEnabled)
      } else if (isWorkflow) {
        await toggleWorkflowSchedule(authFetch, schedule.workflow_id, !isEnabled)
        onUpdated?.({ ...schedule, enabled: isEnabled ? 0 : 1 })
      } else {
        const teamId = schedule.team_definition_id || '_org'
        await toggleSchedule(authFetch, teamId, schedule.id, !isEnabled)
        onUpdated?.({ ...schedule, enabled: isEnabled ? 0 : 1 })
      }
    } catch (err) {
      onError?.(err.message)
    }
  }, [schedule, isEnabled, isWorkflow, onToggle, onUpdated, onError, authFetch])

  const handleDelete = useCallback(async () => {
    // Workflow rows: delete is disabled at the UI level (button not shown)
    if (isWorkflow) {
      setConfirmDelete(false)
      return
    }
    try {
      if (onDelete) {
        await onDelete(schedule)
      } else {
        const teamId = schedule.team_definition_id || '_org'
        await deleteSchedule(authFetch, teamId, schedule.id)
        onDeleted?.(schedule.id)
      }
      setConfirmDelete(false)
    } catch (err) {
      onError?.(err.message)
      setConfirmDelete(false)
    }
  }, [schedule, isWorkflow, onDelete, onDeleted, onError, authFetch])

  const handleTrigger = useCallback(async () => {
    try {
      let result
      if (isWorkflow) {
        result = await triggerWorkflowSchedule(authFetch, schedule.workflow_id)
      } else {
        const teamId = schedule.team_definition_id || '_org'
        result = await triggerSchedule(authFetch, teamId, schedule.id)
      }
      // Item 5: capture executionId; fall back to true if backend doesn't return one
      const execId = result?.executionId || result?.execution_id || null
      setTriggeredId(execId)
      setTriggered(true)
      onTrigger?.(schedule, result)
      if (triggerTimer.current) clearTimeout(triggerTimer.current)
      // Show link for 30s then fade
      triggerTimer.current = setTimeout(() => {
        setTriggered(false)
        setTriggeredId(null)
      }, 30000)
    } catch (err) {
      onError?.(err.message)
    }
  }, [schedule, isWorkflow, onTrigger, onError, authFetch])

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px', borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        opacity: isEnabled ? 1 : 0.5,
        transition: 'opacity 0.2s, background 0.15s',
        minHeight: 44,
      }}
    >
      {/* Status dot */}
      <span
        title={schedule.last_status || 'Never run'}
        style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: statusDotColor(schedule.last_status),
        }}
      />

      {/* Name + template title */}
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{
          fontWeight: 600, fontSize: 13, color: 'rgba(255,255,255,0.9)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {schedule.name}
        </div>
        {templateTitle && (
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.4)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            marginTop: 1,
          }}>
            {templateTitle}
          </div>
        )}
      </div>

      {/* Cron expression (human-readable) */}
      <div style={{
        flex: '0 0 auto', minWidth: 100,
        fontFamily: MONO_FONT, fontSize: 11,
        color: 'rgba(255,255,255,0.6)',
        whiteSpace: 'nowrap',
      }}>
        {cronToHuman(schedule.cron_expression)}
      </div>

      {/* Next trigger countdown */}
      <div style={{ flex: '0 0 auto', minWidth: 80, textAlign: 'right' }}>
        {isEnabled && schedule.next_trigger_at ? (
          <SLACountdown
            deadline={schedule.next_trigger_at}
            label=""
            size="sm"
            variant="badge"
            totalMinutes={(() => {
              const ms = new Date(schedule.next_trigger_at).getTime() - Date.now()
              return Math.max(Math.ceil(ms / 60000) * 2, 60)
            })()}
          />
        ) : (
          <span style={{
            fontFamily: MONO_FONT, fontSize: 11,
            color: 'rgba(255,255,255,0.3)',
          }}>--</span>
        )}
      </div>

      {/* Kind badge + Team name or "Direct" */}
      <div style={{
        flex: '0 0 auto', minWidth: 70,
        fontSize: 11, color: 'rgba(255,255,255,0.45)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: 120,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {isWorkflow && (
          <span
            className="qx-pill"
            style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 4,
              background: 'rgba(99,102,241,0.18)',
              color: 'rgba(165,166,255,0.9)',
              border: '1px solid rgba(99,102,241,0.3)',
              flexShrink: 0,
            }}
          >
            Workflow
          </span>
        )}
        {!isWorkflow && (schedule.team_name || 'Direct')}
      </div>

      {/* Toggle */}
      <ToggleSwitch
        checked={isEnabled}
        onChange={handleToggle}
      />

      {/* Run Now — Item 5: link to spawned execution for 30s */}
      {triggered ? (
        triggeredId ? (
          <Link
            to={`/executions/${triggeredId}`}
            style={{
              padding: '4px 10px', borderRadius: 5,
              background: 'rgba(34,197,94,0.15)',
              color: '#22c55e',
              fontSize: 11, fontWeight: 500,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}
          >
            View Run →
          </Link>
        ) : (
          <span style={{
            padding: '4px 10px', borderRadius: 5,
            background: 'rgba(34,197,94,0.15)',
            color: '#22c55e',
            fontSize: 11, fontWeight: 500,
            whiteSpace: 'nowrap',
          }}>
            ~ Triggered
          </span>
        )
      ) : (
        <button
          onClick={handleTrigger}
          title="Run now"
          style={{
            padding: '4px 10px', borderRadius: 5, border: 'none',
            background: 'rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.7)',
            fontSize: 11, fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 0.15s, color 0.15s',
            whiteSpace: 'nowrap',
          }}
        >
          ~ Run Now
        </button>
      )}

      {/* Delete — disabled for workflow rows (remove the trigger node from the workflow definition instead) */}
      {isWorkflow ? (
        <button
          disabled
          title="Delete the trigger node from the workflow definition to remove this schedule"
          style={{
            padding: '4px 8px', borderRadius: 5, border: 'none',
            background: 'transparent', color: 'rgba(255,255,255,0.15)',
            fontSize: 13, cursor: 'not-allowed',
          }}
        >
          &#x2715;
        </button>
      ) : confirmDelete ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={handleDelete}
            style={{
              padding: '4px 8px', borderRadius: 5, border: 'none',
              background: 'rgba(239,68,68,0.2)', color: '#f87171',
              fontSize: 11, cursor: 'pointer', fontWeight: 500,
            }}
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{
              padding: '4px 8px', borderRadius: 5, border: 'none',
              background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)',
              fontSize: 11, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmDelete(true)}
          title="Delete schedule"
          style={{
            padding: '4px 8px', borderRadius: 5, border: 'none',
            background: 'transparent', color: 'rgba(255,255,255,0.35)',
            fontSize: 13, cursor: 'pointer',
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
          onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.35)'}
        >
          &#x2715;
        </button>
      )}
    </div>
  )
}
