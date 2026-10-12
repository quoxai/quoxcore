/**
 * ReportingSettingsSection — HITL reporting preferences for team settings
 *
 * UX-7: Configurable notification frequency, checkpoint policy, and task timeout.
 * Designed to slot into the AgenticTeamView Settings tab.
 *
 * Props:
 *   reportingFrequency          — 'every_failure' | 'end_of_run' | 'per_agent' | 'silent'
 *   checkpointPolicy            — 'after_each' | 'on_failure' | 'never'
 *   maxTaskTimeout              — seconds (number)
 *   onReportingFrequencyChange  — callback(value)
 *   onCheckpointPolicyChange    — callback(value)
 *   onMaxTaskTimeoutChange      — callback(seconds)
 */

const REPORTING_OPTIONS = [
  { value: 'every_failure', label: 'Every failure', desc: 'Notify immediately when any task fails' },
  { value: 'end_of_run', label: 'End of run', desc: 'Summary notification when objective completes' },
  { value: 'per_agent', label: 'Per agent', desc: 'Report after each agent finishes their tasks' },
  { value: 'silent', label: 'Silent', desc: 'No notifications — check results manually' },
]

const CHECKPOINT_OPTIONS = [
  { value: 'after_each', label: 'After each task', desc: 'Pause for approval after every task' },
  { value: 'on_failure', label: 'On failure only', desc: 'Only pause when a task fails' },
  { value: 'never', label: 'Never', desc: 'Run all tasks without human checkpoints' },
]

const radioStyle = {
  accentColor: '#8b5cf6',
}

const labelStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 8,
  color: 'var(--m-text-secondary, #a1a1aa)', fontSize: 12,
  cursor: 'pointer', padding: '6px 0',
}

const descStyle = {
  color: 'var(--m-text-tertiary, #71717a)', fontSize: 10,
  marginTop: 1, lineHeight: 1.4,
}

const inputStyle = {
  width: '100%', padding: '8px 12px', borderRadius: 6,
  background: 'var(--m-bg-base, rgba(255,255,255,0.04))',
  border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
  color: 'var(--m-text-primary, #f4f4f5)', fontSize: 13,
  outline: 'none', boxSizing: 'border-box',
}

export default function ReportingSettingsSection({
  reportingFrequency,
  checkpointPolicy,
  maxTaskTimeout,
  onReportingFrequencyChange,
  onCheckpointPolicyChange,
  onMaxTaskTimeoutChange,
}) {
  const timeoutMin = Math.round((maxTaskTimeout || 0) / 60)

  return (
    <div style={{
      background: 'var(--m-bg-elevated, rgba(255, 255, 255, 0.05))',
      border: '1px solid var(--m-border-subtle, rgba(255,255,255,0.06))',
      borderRadius: 12, padding: 20,
    }}>
      <div style={{
        color: 'var(--m-text-primary)', fontWeight: 600, fontSize: 13,
        marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ stroke: 'rgba(255,255,255,0.8)' }} strokeWidth="1.2" strokeLinecap="round">
          <path d="M2 7h2l2-4 2 8 2-4h2" />
        </svg>
        Reporting & Checkpoints
      </div>

      {/* Notification Frequency */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--m-text-secondary)', fontSize: 11, fontWeight: 500, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Notification Frequency
        </div>
        {REPORTING_OPTIONS.map(opt => (
          <label key={opt.value} style={labelStyle}>
            <input
              type="radio"
              name="reporting-freq"
              value={opt.value}
              checked={reportingFrequency === opt.value}
              onChange={() => onReportingFrequencyChange(opt.value)}
              style={radioStyle}
            />
            <div>
              <div>{opt.label}</div>
              <div style={descStyle}>{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>

      {/* Checkpoint Policy */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--m-text-secondary)', fontSize: 11, fontWeight: 500, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Checkpoint Policy
        </div>
        {CHECKPOINT_OPTIONS.map(opt => (
          <label key={opt.value} style={labelStyle}>
            <input
              type="radio"
              name="checkpoint-policy"
              value={opt.value}
              checked={checkpointPolicy === opt.value}
              onChange={() => onCheckpointPolicyChange(opt.value)}
              style={radioStyle}
            />
            <div>
              <div>{opt.label}</div>
              <div style={descStyle}>{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>

      {/* Task Timeout */}
      <div>
        <div style={{ color: 'var(--m-text-secondary)', fontSize: 11, fontWeight: 500, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Max Task Timeout
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            value={maxTaskTimeout}
            onChange={e => onMaxTaskTimeoutChange(Number(e.target.value))}
            min={60}
            max={7200}
            style={{ ...inputStyle, width: 120 }}
          />
          <span style={{ color: 'var(--m-text-tertiary)', fontSize: 11 }}>
            seconds = {timeoutMin} min
          </span>
        </div>
        <div style={{ color: 'var(--m-text-tertiary)', fontSize: 10, marginTop: 4, lineHeight: 1.5 }}>
          Individual tasks that exceed this timeout will fail. Default: 30 minutes.
        </div>
      </div>
    </div>
  )
}
