/**
 * ScopeAssignmentPanel — Matrix UI for assigning notification channels to scopes.
 *
 * Rows: Org scopes (indented by depth)
 * Columns: 16 channel types with rotated headers
 * Cells: Checkbox toggles
 */

import { useScopeAssignments } from '../../hooks/useScopeAssignments'
import './comms-layout.css'

const CHANNEL_TYPES = [
  { id: 'telegram', label: 'TG', full: 'Telegram' },
  { id: 'slack', label: 'SL', full: 'Slack' },
  { id: 'email', label: 'EM', full: 'Email' },
  { id: 'discord', label: 'DC', full: 'Discord' },
  { id: 'webhook', label: 'WH', full: 'Webhook' },
  { id: 'msteams', label: 'MS', full: 'MS Teams' },
  { id: 'twilio-sms', label: 'SM', full: 'Twilio SMS' },
  { id: 'pagerduty', label: 'PD', full: 'PagerDuty' },
  { id: 'opsgenie', label: 'OG', full: 'OpsGenie' },
  { id: 'mattermost', label: 'MM', full: 'Mattermost' },
  { id: 'ntfy', label: 'NT', full: 'ntfy' },
  { id: 'pushover', label: 'PO', full: 'Pushover' },
  { id: 'google-chat', label: 'GC', full: 'Google Chat' },
  { id: 'gotify', label: 'GT', full: 'Gotify' },
  { id: 'rocketchat', label: 'RC', full: 'Rocket.Chat' },
  { id: 'line', label: 'LN', full: 'LINE' },
]

const SCOPE_TYPE_ICONS = {
  org: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </svg>
  ),
  division: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
    </svg>
  ),
  department: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  team: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
    </svg>
  ),
}

export default function ScopeAssignmentPanel() {
  const { assignments, scopes, loading, error, saving, toggleAssignment } = useScopeAssignments()

  if (loading) {
    return (
      <div className="comms-loading">
        <svg className="corecomms-spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20"/>
        </svg>
        Loading scope assignments...
      </div>
    )
  }

  if (error) {
    return (
      <div className="comms-empty">
        <p style={{ color: 'var(--ui-red, #ef4444)' }}>{error}</p>
      </div>
    )
  }

  if (!scopes.length) {
    return (
      <div className="comms-empty">
        <div className="comms-empty__icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
          </svg>
        </div>
        <p>No scopes found. Create divisions and teams in Organization settings.</p>
      </div>
    )
  }

  // Sort scopes by depth then name
  const sortedScopes = [...scopes].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    return (a.name_cache || '').localeCompare(b.name_cache || '')
  })

  const handleToggle = (scopeId, channelType) => {
    const current = assignments[scopeId]?.[channelType] || false
    toggleAssignment(scopeId, channelType, !current)
  }

  return (
    <div className="comms-matrix-wrapper">
      <div className="comms-content__header">
        <h2 className="comms-content__title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          Scope-Channel Assignments
        </h2>
        {saving && (
          <span className="comms-badge comms-badge--info">Saving...</span>
        )}
      </div>

      <div className="comms-matrix-scroll">
        <table className="comms-matrix">
          <thead>
            <tr>
              <th className="comms-matrix__scope-header">Scope</th>
              {CHANNEL_TYPES.map(ch => (
                <th key={ch.id} className="comms-matrix__channel-header">
                  <span className="comms-matrix__channel-label" title={ch.full}>
                    {ch.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedScopes.map(scope => (
              <tr key={scope.id} className="comms-matrix__row">
                <td
                  className="comms-matrix__scope-cell"
                  style={{ paddingLeft: `${12 + (scope.depth || 0) * 16}px` }}
                >
                  <span className="comms-matrix__scope-icon">
                    {SCOPE_TYPE_ICONS[scope.scope_type] || SCOPE_TYPE_ICONS.team}
                  </span>
                  <span className="comms-matrix__scope-name" title={scope.name_cache}>
                    {scope.name_cache || scope.id}
                  </span>
                  <span className="comms-badge comms-badge--neutral comms-matrix__scope-type">
                    {scope.scope_type}
                  </span>
                </td>
                {CHANNEL_TYPES.map(ch => {
                  const checked = assignments[scope.id]?.[ch.id] || false
                  return (
                    <td key={ch.id} className="comms-matrix__cell">
                      <label
                        className={`comms-matrix__toggle${checked ? ' comms-matrix__toggle--active' : ''}`}
                        title={`${ch.full} for ${scope.name_cache}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggle(scope.id, ch.id)}
                          className="comms-matrix__checkbox"
                        />
                        <span className="comms-matrix__toggle-indicator" />
                      </label>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
