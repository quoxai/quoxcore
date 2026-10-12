/**
 * DevRegisterPanel — capability panel for dev.register
 *
 * DEVSUITE-HUB Phase 3: the illustrative, real example proving the
 * capabilityPanelRegistry mechanism works end-to-end. dev.register is the
 * only capability with genuinely real backend data today — registerStatus()'s
 * output already flows through the dev_servers registry (see
 * services/collector/lib/devServersStore.js) and is already part of the
 * GET /api/v1/dev-servers response DevServersHubPanel fetches. No new
 * backend call is made here; this panel only renders fields already present
 * on the `server` object it's handed.
 */

export default function DevRegisterPanel({ server }) {
  const { profile_verified, profile_version, checked_at } = server || {}

  return (
    <div className="capability-panel-dev-register" data-testid="capability-panel-dev-register">
      <div className="capability-panel-row" data-testid="dev-register-panel-verified-row">
        <span className="capability-panel-label" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
          Profile verified
        </span>{' '}
        <span data-testid="dev-register-panel-verified">{profile_verified ? 'Yes' : 'No'}</span>
      </div>
      <div className="capability-panel-row" data-testid="dev-register-panel-version-row">
        <span className="capability-panel-label" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
          Profile version
        </span>{' '}
        <span data-testid="dev-register-panel-version">{profile_version || 'unknown'}</span>
      </div>
      <div className="capability-panel-row" data-testid="dev-register-panel-checked-at-row">
        <span className="capability-panel-label" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
          Last checked
        </span>{' '}
        <span data-testid="dev-register-panel-checked-at">
          {checked_at ? new Date(checked_at).toLocaleString() : 'never'}
        </span>
      </div>
    </div>
  )
}
