/**
 * TikTokSetupWizard — Guided onboarding for the TikTok plugin. TT-4, mirrors
 * src/components/facebook/FacebookSetupWizard.jsx.
 *
 * Walks the user through creating a TikTok developer app, requesting the
 * Content Posting + Display API scopes, getting the four credential fields
 * (access_token, refresh_token, client_key, client_secret), and storing
 * them in the vault. States both hard truths honestly at the point they
 * matter: unaudited apps post SELF_ONLY only, and access tokens live 24
 * hours with NO auto-refresh built yet (a daily manual rotate is the real
 * contract today, not a promise this wizard makes go away).
 */

import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { checkCredentialHealth } from '../../services/tiktokClient'
import './tiktok-setup.css'

// ─── Tiny SVG Icons (explicit colours, no currentColor) ─────
function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="tts-icon-inline">
      <path d="M6 3h7v7M13 3L6 10" stroke="rgba(254, 44, 85, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="tts-icon-inline">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="rgba(254, 44, 85, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="tts-icon-check">
      <circle cx="10" cy="10" r="9" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="rgba(52, 211, 153, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="tts-icon-tip">
      <circle cx="8" cy="8" r="7" stroke="rgba(37, 244, 238, 0.7)" strokeWidth="1.2"/>
      <path d="M8 5v3M8 10.5v.5" stroke="rgba(37, 244, 238, 0.8)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="tts-icon-tip">
      <path d="M8 1.5L1 14h14L8 1.5z" stroke="rgba(251, 191, 36, 0.7)" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M8 6v3M8 11.5v.5" stroke="rgba(251, 191, 36, 0.9)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="tts-icon-tip">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

function TikTokLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="tts-logo">
      <path d="M16 3v9.5a4 4 0 1 1-4-4V3" stroke="rgba(254, 44, 85, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M16 3a5 5 0 0 0 5 5" stroke="rgba(37, 244, 238, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

const STEPS = [
  {
    id: 'create-app',
    title: 'Create a TikTok Developer App',
    subtitle: 'This takes a few minutes',
    content: (
      <>
        <p>TikTok requires a registered developer app to connect. You only need to do this once.</p>
        <ol className="tts-steps">
          <li>
            Open the <a href="https://developers.tiktok.com/apps" target="_blank" rel="noopener noreferrer" className="tts-link">TikTok Developer Portal <ExternalIcon /></a>
          </li>
          <li>Click <strong>Create an app</strong>, fill in the basic details, and save</li>
          <li>Add the <strong>Content Posting API</strong> and <strong>Display API</strong> products to your app</li>
          <li>Copy your app's <strong>Client Key</strong> and <strong>Client Secret</strong></li>
        </ol>
        <div className="tts-tip">
          <TipIcon />
          <span>
            An unaudited app can only post content as private (SELF_ONLY), visible to the
            posting account alone, until TikTok approves the app's audit. The audit is free to
            start and typically takes weeks to clear.
          </span>
        </div>
      </>
    ),
  },
  {
    id: 'request-scopes',
    title: 'Request Scopes',
    subtitle: 'Choose what the app can do',
    content: (
      <>
        <p>In your app's configuration, request these scopes:</p>
        <div className="tts-products">
          <div className="tts-product">
            <CheckIcon />
            <div>
              <strong>user.info.basic</strong>
              <span>Read the connected profile</span>
            </div>
          </div>
          <div className="tts-product">
            <CheckIcon />
            <div>
              <strong>video.list</strong>
              <span>List recent videos and read engagement stats</span>
            </div>
          </div>
          <div className="tts-product">
            <CheckIcon />
            <div>
              <strong>video.publish</strong>
              <span>Publish videos directly (every publish still needs a human approval in HITL Inbox)</span>
            </div>
          </div>
          <div className="tts-product">
            <CheckIcon />
            <div>
              <strong>video.upload</strong>
              <span>Upload videos to the account's TikTok inbox as drafts</span>
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'get-tokens',
    title: 'Get OAuth Tokens',
    subtitle: 'Exchange your app for access + refresh tokens',
    content: (
      <>
        <p>Complete TikTok's OAuth flow for your app to get an access token and a refresh token.</p>
        <ol className="tts-steps">
          <li>Follow TikTok's OAuth documentation for the Content Posting / Display APIs</li>
          <li>Authorize the app against the TikTok account you want connected</li>
          <li>Copy the <strong>Access Token</strong> and <strong>Refresh Token</strong> from the token exchange response</li>
        </ol>
        <div className="tts-tip tts-tip--warn">
          <WarnIcon />
          <span>
            Access tokens live exactly <strong>24 hours</strong>. Refresh tokens live 365 days
            and rotate on every use. There is <strong>no automatic refresh built yet</strong>
            (that is a separate stream) — the honest contract today is a daily manual rotate of
            the access_token, not a background refresh you can forget about.
          </span>
        </div>
      </>
    ),
  },
  {
    id: 'store-vault',
    title: 'Store in Vault',
    subtitle: 'Secure, encrypted, org-scoped',
    content: ({ onNavigateVault }) => (
      <>
        <p>Store the four TikTok credential fields securely in the QuoxCORE vault.</p>
        <ol className="tts-steps">
          <li>
            <button className="tts-link-btn" onClick={onNavigateVault}>
              Open Vault Credentials <ArrowIcon />
            </button>
          </li>
          <li>Click <strong>Add Credential</strong></li>
          <li>Select type: <strong>TikTok</strong></li>
          <li>Paste all four fields: <code>access_token</code>, <code>refresh_token</code>, <code>client_key</code>, <code>client_secret</code></li>
          <li>Save</li>
        </ol>
        <div className="tts-secure-badge">
          <LockIcon />
          <span>Your tokens are encrypted with AES-256-GCM and never leave the vault. The connector reads them at runtime only.</span>
        </div>
      </>
    ),
  },
  {
    id: 'connect',
    title: 'Finish Setup',
    subtitle: 'Almost there',
    isForm: true,
  },
]

export default function TikTokSetupWizard({ onSave }) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState(null)

  const step = STEPS[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === STEPS.length - 1

  // Live probe when reaching the final step — get_profile is the cheapest
  // real check that the vaulted access token works. Never assumed.
  useEffect(() => {
    if (currentStep === STEPS.length - 1) {
      setChecking(true)
      checkCredentialHealth()
        .then((h) => setHealth(h))
        .catch(() => setHealth(null))
        .finally(() => setChecking(false))
    }
  }, [currentStep]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = useCallback(() => {
    if (isLast) {
      onSave({ setupComplete: true })
    } else {
      setCurrentStep(s => Math.min(s + 1, STEPS.length - 1))
    }
  }, [isLast, onSave])

  const handleBack = useCallback(() => {
    setCurrentStep(s => Math.max(s - 1, 0))
  }, [])

  return (
    <div className="tts">
      <div className="tts-header">
        <TikTokLogo />
        <div>
          <h2 className="tts-header__title">Connect TikTok</h2>
          <p className="tts-header__sub">Set up once, publish (or draft) forever</p>
        </div>
      </div>

      <div className="tts-progress">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`tts-progress__step ${i === currentStep ? 'tts-progress__step--active' : ''} ${i < currentStep ? 'tts-progress__step--done' : ''}`}
            onClick={() => setCurrentStep(i)}
          >
            <span className="tts-progress__num">
              {i < currentStep ? '✓' : i + 1}
            </span>
            <span className="tts-progress__label">{s.title}</span>
          </button>
        ))}
      </div>

      <div className="tts-content">
        <div className="tts-content__header">
          <h3 className="tts-content__title">{step.title}</h3>
          <p className="tts-content__subtitle">{step.subtitle}</p>
        </div>

        <div className="tts-content__body">
          {step.isForm ? (
            <div className="tts-form">
              {checking && (
                <p style={{ color: 'rgba(255, 255, 255, 0.6)', fontStyle: 'italic' }}>
                  Checking your vaulted TikTok credential...
                </p>
              )}
              {!checking && health?.connected && (
                <div className="tts-result tts-result--success">
                  Connected as <strong>{health.profile?.display_name || health.profile?.open_id || 'your TikTok account'}</strong>.
                </div>
              )}
              {!checking && health && !health.connected && (
                <div className="tts-result tts-result--error">
                  Not connected yet: {health.error}
                </div>
              )}
              <p style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: 13, marginTop: 12 }}>
                Nothing else to configure here. Publishing and draft uploads are governed: every
                one files a human approval card in HITL Inbox before anything reaches TikTok.
              </p>
            </div>
          ) : (
            typeof step.content === 'function'
              ? step.content({ onNavigateVault: () => navigate('/vault/credentials') })
              : step.content
          )}
        </div>
      </div>

      <div className="tts-nav">
        <button
          className="tts-nav__back"
          onClick={handleBack}
          disabled={isFirst}
        >
          {'◀'} Back
        </button>

        <div className="tts-nav__right">
          {!isLast && (
            <button className="tts-nav__skip" onClick={handleNext}>
              Next {'▶'}
            </button>
          )}
          {isLast && (
            <button className="tts-nav__finish" onClick={handleNext}>
              {'▶'} Finish Setup
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
