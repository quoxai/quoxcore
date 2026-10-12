/**
 * LinkedInSetupWizard — Guided onboarding for the LinkedIn plugin.
 *
 * Multi-step wizard that walks the user through:
 *   1. Creating a LinkedIn Developer App
 *   2. Getting an OAuth access token
 *   3. Storing it in the vault
 *   4. Connecting their profile/org
 *
 * Design: clean progressive disclosure, one action per step, no jargon.
 */

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import './linkedin-setup.css'

const STEPS = [
  {
    id: 'create-app',
    title: 'Create a LinkedIn App',
    subtitle: 'This takes about 2 minutes',
    content: (
      <>
        <p>LinkedIn requires a Developer App to connect. You only need to do this once.</p>
        <ol className="lis-steps">
          <li>
            Open the <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer" className="lis-link">LinkedIn Developer Portal <ExternalIcon /></a>
          </li>
          <li>Click <strong>Create app</strong></li>
          <li>Fill in your app name (e.g. "QuoxCORE") and select your company page</li>
          <li>Accept the terms and create</li>
        </ol>
        <div className="lis-tip">
          <TipIcon />
          <span>You need to be an admin of your LinkedIn company page to create the app.</span>
        </div>
      </>
    ),
  },
  {
    id: 'request-access',
    title: 'Enable API Products',
    subtitle: 'Choose what the app can do',
    content: (
      <>
        <p>In your new app's settings, go to the <strong>Products</strong> tab and request these:</p>
        <div className="lis-products">
          <div className="lis-product">
            <CheckIcon />
            <div>
              <strong>Share on LinkedIn</strong>
              <span>Post content to your profile</span>
            </div>
            <span className="lis-product-badge lis-product-badge--auto">Auto-approved</span>
          </div>
          <div className="lis-product">
            <CheckIcon />
            <div>
              <strong>Sign In with LinkedIn (OpenID Connect)</strong>
              <span>Basic authentication</span>
            </div>
            <span className="lis-product-badge lis-product-badge--auto">Auto-approved</span>
          </div>
          <div className="lis-product">
            <CheckIcon />
            <div>
              <strong>Community Management API</strong>
              <span>Post as your company, read engagement, manage comments</span>
            </div>
            <span className="lis-product-badge lis-product-badge--review">May need review</span>
          </div>
        </div>
        <div className="lis-tip">
          <TipIcon />
          <span>The first two are instant. Community Management may take a few hours to approve if your page is new.</span>
        </div>
      </>
    ),
  },
  {
    id: 'get-token',
    title: 'Get Your Access Token',
    subtitle: 'The key that connects everything',
    content: (
      <>
        <p>In your app's <strong>Auth</strong> tab, you'll find your Client ID and Client Secret. Use these to get an access token:</p>

        <div className="lis-method">
          <div className="lis-method-header">
            <span className="lis-method-badge">Recommended</span>
            <strong>Use LinkedIn's Token Tool</strong>
          </div>
          <ol className="lis-steps">
            <li>
              Open <a href="https://www.linkedin.com/developers/tools/oauth" target="_blank" rel="noopener noreferrer" className="lis-link">LinkedIn OAuth Token Tool <ExternalIcon /></a>
            </li>
            <li>Select your app from the dropdown</li>
            <li>Select the scopes: <code>openid</code>, <code>profile</code>, <code>w_member_social</code>, <code>r_organization_social</code>, <code>w_organization_social</code>, <code>rw_organization_admin</code> (org page details), and for comments/reactions the feed scopes: <code>r_organization_social_feed</code>, <code>w_organization_social_feed</code>, <code>w_member_social_feed</code></li>
            <li>Click <strong>Request access token</strong></li>
            <li>Copy the generated token</li>
          </ol>
        </div>

        <div className="lis-tip lis-tip--warn">
          <WarnIcon />
          <span>Access tokens expire after <strong>60 days</strong>. You'll need to refresh it before then. The dashboard will warn you when it's close to expiring.</span>
        </div>
      </>
    ),
  },
  {
    id: 'store-token',
    title: 'Store in Vault',
    subtitle: 'Secure, encrypted, org-scoped',
    content: ({ onNavigateVault }) => (
      <>
        <p>Store your access token securely in the QuoxCORE vault.</p>
        <ol className="lis-steps">
          <li>
            <button className="lis-link-btn" onClick={onNavigateVault}>
              Open Vault Credentials <ArrowIcon />
            </button>
          </li>
          <li>Click <strong>Add Credential</strong></li>
          <li>Select type: <strong>LinkedIn</strong></li>
          <li>Paste your access token and save</li>
        </ol>
        <div className="lis-secure-badge">
          <LockIcon />
          <span>Your token is encrypted with AES-256-GCM and never leaves the vault.</span>
        </div>
      </>
    ),
  },
  {
    id: 'connect',
    title: 'Connect Your Account',
    subtitle: 'Almost there',
    isForm: true,
  },
]

// ─── Tiny SVG Icons (explicit colours, no currentColor) ─────
function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="lis-icon-inline">
      <path d="M6 3h7v7M13 3L6 10" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="lis-icon-inline">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="lis-icon-check">
      <circle cx="10" cy="10" r="9" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="rgba(52, 211, 153, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="lis-icon-tip">
      <circle cx="8" cy="8" r="7" stroke="rgba(10, 102, 194, 0.6)" strokeWidth="1.2"/>
      <path d="M8 5v3M8 10.5v.5" stroke="rgba(10, 102, 194, 0.8)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="lis-icon-tip">
      <path d="M8 1.5L1 14h14L8 1.5z" stroke="rgba(251, 191, 36, 0.7)" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M8 6v3M8 11.5v.5" stroke="rgba(251, 191, 36, 0.9)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="lis-icon-tip">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

function LinkedInLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="lis-logo">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="2" y="9" width="4" height="12" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="4" cy="4" r="2" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8"/>
    </svg>
  )
}

// ─── Main Component ─────────────────────────────────────────
export default function LinkedInSetupWizard({ onSave }) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [authorUrn, setAuthorUrn] = useState('')
  const [orgId, setOrgId] = useState('')

  const step = STEPS[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === STEPS.length - 1
  const canFinish = authorUrn.trim().length > 0

  const handleNext = useCallback(() => {
    if (isLast) {
      if (canFinish) onSave({ authorUrn: authorUrn.trim(), orgId: orgId.trim() })
    } else {
      setCurrentStep(s => Math.min(s + 1, STEPS.length - 1))
    }
  }, [isLast, canFinish, authorUrn, orgId, onSave])

  const handleBack = useCallback(() => {
    setCurrentStep(s => Math.max(s - 1, 0))
  }, [])

  return (
    <div className="lis">
      {/* Header */}
      <div className="lis-header">
        <LinkedInLogo />
        <div>
          <h2 className="lis-header__title">Connect LinkedIn</h2>
          <p className="lis-header__sub">Set up once, publish forever</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="lis-progress">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`lis-progress__step ${i === currentStep ? 'lis-progress__step--active' : ''} ${i < currentStep ? 'lis-progress__step--done' : ''}`}
            onClick={() => setCurrentStep(i)}
          >
            <span className="lis-progress__num">
              {i < currentStep ? '\u2713' : i + 1}
            </span>
            <span className="lis-progress__label">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="lis-content">
        <div className="lis-content__header">
          <h3 className="lis-content__title">{step.title}</h3>
          <p className="lis-content__subtitle">{step.subtitle}</p>
        </div>

        <div className="lis-content__body">
          {step.isForm ? (
            /* Final step: connect form */
            <div className="lis-form">
              <p>Enter your LinkedIn identifiers so the plugin knows who you are.</p>

              <div className="lis-field">
                <label className="lis-field__label">
                  Your LinkedIn Member URN
                  <span className="lis-field__required">Required</span>
                </label>
                <p className="lis-field__help">
                  Find this in your app's <strong>Auth</strong> tab, or ask the LinkedIn agent after connecting: "What is my member URN?"
                </p>
                <input
                  className="lis-field__input"
                  type="text"
                  value={authorUrn}
                  onChange={e => setAuthorUrn(e.target.value)}
                  placeholder="urn:li:person:abc123..."
                  autoFocus
                />
              </div>

              <div className="lis-field">
                <label className="lis-field__label">
                  Organisation ID
                  <span className="lis-field__optional">Optional</span>
                </label>
                <p className="lis-field__help">
                  For posting as your company page. Find it in the URL of your LinkedIn company page, or in the Developer Portal under your app.
                </p>
                <input
                  className="lis-field__input"
                  type="text"
                  value={orgId}
                  onChange={e => setOrgId(e.target.value)}
                  placeholder="e.g. 12345678"
                />
              </div>
            </div>
          ) : (
            /* Content steps */
            typeof step.content === 'function'
              ? step.content({ onNavigateVault: () => navigate('/vault/credentials') })
              : step.content
          )}
        </div>
      </div>

      {/* Navigation */}
      <div className="lis-nav">
        <button
          className="lis-nav__back"
          onClick={handleBack}
          disabled={isFirst}
        >
          Back
        </button>

        <div className="lis-nav__right">
          {!isLast && (
            <button className="lis-nav__skip" onClick={handleNext}>
              {currentStep < STEPS.length - 2 ? 'Next' : 'Next'}
            </button>
          )}
          {isLast && (
            <button
              className="lis-nav__finish"
              onClick={handleNext}
              disabled={!canFinish}
            >
              Connect LinkedIn
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
