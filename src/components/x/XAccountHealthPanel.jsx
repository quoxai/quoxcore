/**
 * XAccountHealthPanel — which account this org publishes as, and whether the
 * credential still works. X-PLUGIN P3, restyled in phase 13.
 *
 * Two different facts, deliberately not conflated:
 *   - IDENTITY (`account`) is served free from the collector's cache, written
 *     the last time a verify succeeded. It survives a browser wipe and a
 *     different machine, so the panel can always say who we are connected as.
 *   - LIVENESS (`health`) is only known after a PAID call to X (about $0.005),
 *     so it is never fetched on mount. "Not checked this session" is an honest
 *     answer; a cached handle is NOT evidence the credential still works.
 *
 * Phase 13 (owner item 8): the "Confirmed with X on ..." line was 11px at 55%
 * white, which is footnote weight for a sentence that answers "can this org
 * post right now". It is now a full caption next to a status icon, so the
 * state reads at a glance before a word is read: green for verified and
 * cached, amber for a credential nobody has checked yet, red for a check that
 * failed or a credential that is missing.
 */

export const VERIFY_COST_USD = '$0.005'

function fmtTime(iso) {
  if (!iso) return null
  try {
    return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString()
  } catch {
    return iso
  }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  )
}

/**
 * Resolve the one state this panel is in. Kept as a single function returning
 * tone + icon + words, so the icon, the border colour and the sentence can
 * never disagree with each other: a green tick above red words is worse than
 * no icon at all.
 */
export function resolveHealthState({ health, account, credential }) {
  const identity = health?.account || account || null
  // The handle always sits in its own element so it can be read, copied and
  // asserted on as one string rather than as a fragment of a sentence.
  const handle = identity?.username ? <strong>@{identity.username}</strong> : null

  if (health && health.ok === false && !health.checking) {
    return {
      tone: 'bad',
      icon: <CrossIcon />,
      label: 'Check failed',
      live: false,
      headline: handle
        ? <>The credential for {handle} did not verify</>
        : <>The stored credential did not verify</>,
    }
  }
  if (health?.ok) {
    return {
      tone: 'ok',
      icon: <CheckIcon />,
      label: 'Verified',
      live: true,
      headline: <>Verified just now as {handle || <strong>an unnamed account</strong>}</>,
    }
  }
  if (identity?.username) {
    return {
      tone: 'ok',
      icon: <CheckIcon />,
      label: 'Verified and cached',
      live: false,
      headline: <>Connected as {handle}{identity.name ? ` (${identity.name})` : ''}</>,
    }
  }
  if (credential?.configured) {
    return {
      tone: 'warn',
      icon: <AlertIcon />,
      label: 'Unverified',
      live: false,
      headline: (
        <>
          Credential <strong>{credential.label || 'twitter'}</strong> is in the vault, but this org
          has not verified it yet, so we do not know which account it posts as.
        </>
      ),
    }
  }
  return {
    tone: 'bad',
    icon: <CrossIcon />,
    label: 'No credential',
    live: false,
    headline: <>No Twitter or X credential is resolved for this org</>,
  }
}

export default function XAccountHealthPanel({ health, account, credential, onVerify }) {
  const checking = health?.checking
  const state = resolveHealthState({ health, account, credential })
  const verifiedAt = fmtTime(account?.verifiedAt)

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <div className="xs-panel-head">
            <h3>Account health</h3>
            <span className={`xs-badge xs-badge--${state.tone}`}>{state.label}</span>
          </div>
          <button type="button" className="qx-btn xs-btn xs-btn--accent qx-btn--sm" onClick={onVerify} disabled={checking}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            {checking ? 'Checking…' : `Check now (${VERIFY_COST_USD})`}
          </button>
        </div>

        <div className={`xs-status xs-status--${state.tone}`}>
          <div className="xs-status__icon" aria-hidden="true">{state.icon}</div>
          <div className="xs-status__body">
            <span className="xs-status__headline">{state.headline}</span>
            {/* Only claimable straight after a live check. A cached handle is
                not evidence the OAuth quad still works, so this badge is
                absent in the cached case on purpose. */}
            {state.live && <span className="xs-badge xs-badge--ok" style={{ alignSelf: 'flex-start' }}>OAuth 1.0a valid</span>}
            <span className="xs-status__caption">
              {verifiedAt
                ? `Confirmed with X on ${verifiedAt} and cached server-side since. `
                : ''}
              The handle above costs nothing to view. Only the button above spends money: it asks
              X directly and costs about {VERIFY_COST_USD} per check.
            </span>
            {state.tone === 'ok' && !health?.ok && (
              <span className="xs-status__caption">
                This is the cached result of the last successful check, not proof the credential
                still works today. Run a check if you need that.
              </span>
            )}
          </div>
        </div>

        {checking && <div className="qx-skeleton qx-skeleton--line-md" />}

        {!checking && health && health.ok === false && (
          <div className="qx-banner qx-banner--error">
            Credentials failed verification: {health.error || 'unknown error'}. Fix the Twitter/X
            credential in the Vault (all four OAuth 1.0a values), then check again.
          </div>
        )}

        {!credential?.configured && credential?.error && (
          <p className="xs-caption">Vault said: {credential.error}</p>
        )}
      </div>
    </section>
  )
}
