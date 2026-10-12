/**
 * XSetupWizard — guided onboarding for the X plugin. X-PLUGIN P3.
 *
 * Five steps mirroring LinkedInSetupWizard's UX (one action per step,
 * progressive disclosure), but composed from global .qx-* classes only —
 * zero bespoke panel CSS (glass-design-system rule).
 *
 *   1. Create a Project + App in the X Developer Portal (the PAY PER USE
 *      project — the app-attached-to-wrong-project trap is called out).
 *   2. Set app permissions to Read and Write BEFORE generating tokens.
 *   3. The OAuth 1.0a quad — which four values, and that OAuth 2.0
 *      Client ID / Client Secret are NOT them.
 *   4. Store the quad in the vault (type: twitter).
 *   5. Verify — drives the twitter connector's verify_credentials live and
 *      shows the @handle on success.
 */

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { verifyCredentials } from '../../services/xClient'

const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const STEPS = [
  { id: 'create-app', title: 'Create a Project + App', subtitle: 'In the X Developer Portal' },
  { id: 'permissions', title: 'Enable Read and Write', subtitle: 'Before generating tokens' },
  { id: 'keys', title: 'The Four Keys', subtitle: 'OAuth 1.0a, not OAuth 2.0' },
  { id: 'vault', title: 'Store in Vault', subtitle: 'Encrypted, org-scoped' },
  { id: 'verify', title: 'Verify Connection', subtitle: 'Live check against the X API' },
]

export default function XSetupWizard({ onComplete, authFetch }) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null) // { ok, username?, error? }

  const step = STEPS[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === STEPS.length - 1

  const handleVerify = useCallback(async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      const out = await verifyCredentials(authFetch)
      if (out?.success && out?.result?.username) {
        setVerifyResult({ ok: true, username: out.result.username, name: out.result.name })
      } else {
        setVerifyResult({ ok: false, error: out?.error || 'X did not return an authenticated account' })
      }
    } catch (e) {
      setVerifyResult({ ok: false, error: e.message })
    } finally {
      setVerifying(false)
    }
  }, [authFetch])

  const renderStep = () => {
    switch (step.id) {
      case 'create-app':
        return (
          <>
            <p>X requires a developer Project with an App inside it. You only do this once.</p>
            <ol>
              <li>
                Open the{' '}
                <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener noreferrer">
                  X Developer Portal <ExternalIcon />
                </a>
              </li>
              <li>Open your <strong>Pay Per Use</strong> project (or create one)</li>
              <li>Inside that project, click <strong>Add App</strong> and name it (e.g. "QuoxCORE")</li>
            </ol>
            <div className="qx-banner qx-banner--warn">
              The app MUST live inside the paid project. A standalone app, or one attached to the
              free project, authenticates fine and then fails on writes with confusing 403s: this
              exact trap costs real debugging time. Check the app's parent project before moving on.
            </div>
          </>
        )
      case 'permissions':
        return (
          <>
            <p>In the app's <strong>Settings</strong>, under <strong>User authentication settings</strong>:</p>
            <ol>
              <li>Click <strong>Set up</strong> (or Edit)</li>
              <li>Set App permissions to <strong>Read and write</strong></li>
              <li>Save</li>
            </ol>
            <div className="qx-banner qx-banner--warn">
              Do this BEFORE generating your access token. Tokens minted while the app was
              read-only stay read-only forever: changing the permission afterwards does not
              upgrade them. If you already generated tokens, regenerate them after this step.
            </div>
          </>
        )
      case 'keys':
        return (
          <>
            <p>From the app's <strong>Keys and tokens</strong> tab you need exactly four values (the OAuth 1.0a quad):</p>
            <ol>
              <li><strong>API Key</strong> (consumer key)</li>
              <li><strong>API Key Secret</strong> (consumer secret)</li>
              <li><strong>Access Token</strong>, generate under "Authentication Tokens"</li>
              <li><strong>Access Token Secret</strong>, shown once with the token</li>
            </ol>
            <div className="qx-banner qx-banner--info">
              The <strong>OAuth 2.0 Client ID and Client Secret</strong> on the same page are NOT
              these. If a value looks like a Client ID/Secret pair, you are copying the wrong
              section: the quad lives under "Consumer Keys" and "Authentication Tokens".
            </div>
          </>
        )
      case 'vault':
        return (
          <>
            <p>Store the quad in the QuoxCORE vault. It is encrypted, org-scoped, and never leaves the server.</p>
            <ol>
              <li>
                <button type="button" className="qx-btn qx-btn--sm" onClick={() => navigate('/vault/credentials')}>
                  <ExternalIcon /> Open Vault Credentials
                </button>
              </li>
              <li>Click <strong>Add Credential</strong> and select type <strong>Twitter/X</strong></li>
              <li>Paste the four values: api_key, api_secret, access_token, access_secret</li>
              <li>Save, then come back here</li>
            </ol>
          </>
        )
      case 'verify':
        return (
          <>
            <p>This drives a real call to the X API through the vault credentials, and nothing is posted.</p>
            <div className="qx-row qx-row--tight">
              <button type="button" className="qx-btn qx-btn--primary" onClick={handleVerify} disabled={verifying}>
                {verifying ? 'Verifying…' : 'Verify connection'}
              </button>
              {verifying && <span className="qx-spinner qx-spinner--sm" aria-label="verifying" />}
            </div>
            {verifyResult?.ok && (
              <div className="qx-banner qx-banner--success">
                Connected as <strong>@{verifyResult.username}</strong>
                {verifyResult.name ? ` (${verifyResult.name})` : ''}. You are ready to compose.
              </div>
            )}
            {verifyResult && !verifyResult.ok && (
              <div className="qx-banner qx-banner--error">
                Verification failed: {verifyResult.error}. Check the vault credential (all four
                values, no surrounding spaces) and that the app sits in the Pay Per Use project.
              </div>
            )}
          </>
        )
      default:
        return null
    }
  }

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div>
          <h2 style={{ margin: 0 }}>Connect X</h2>
          <p className="qx-hint">Set up once, publish through governed approval forever.</p>
        </div>

        <span className="qx-stage-track" role="list" aria-label="setup progress">
          {STEPS.map((s, i) => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              {i > 0 && (
                <span className={`qx-stage-track__bar${i <= currentStep ? ' qx-stage-track__bar--done' : ''}`} />
              )}
              <button
                type="button"
                role="listitem"
                aria-label={`Step ${i + 1}: ${s.title}`}
                title={s.title}
                className={`qx-stage-track__node${i < currentStep ? ' qx-stage-track__node--done' : ''}${i === currentStep ? ' qx-stage-track__node--current' : ''}${i === STEPS.length - 1 && i === currentStep ? ' qx-stage-track__node--terminal' : ''}`}
                onClick={() => setCurrentStep(i)}
                style={{ cursor: 'pointer', border: 'none', padding: 0 }}
              />
            </span>
          ))}
          <span className="qx-stage-track__label qx-stage-track__label--current">
            {step.title} <span style={{ opacity: 0.6 }}>{currentStep + 1}/{STEPS.length}</span>
          </span>
        </span>

        <div>
          <h3 style={{ marginTop: 0 }}>{step.title}</h3>
          <p className="qx-hint">{step.subtitle}</p>
          {renderStep()}
        </div>

        <div className="qx-row qx-row--apart">
          <button type="button" className="qx-btn qx-btn--ghost" onClick={() => setCurrentStep((s) => Math.max(0, s - 1))} disabled={isFirst}>
            Back
          </button>
          {!isLast && (
            <button type="button" className="qx-btn qx-btn--primary" onClick={() => setCurrentStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              Next
            </button>
          )}
          {isLast && (
            <button
              type="button"
              className="qx-btn qx-btn--primary"
              onClick={() => onComplete({ handle: verifyResult?.username || '' })}
              disabled={!verifyResult?.ok}
            >
              Finish setup
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
