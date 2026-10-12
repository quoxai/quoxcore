/**
 * FacebookSetupWizard — Guided onboarding for the Facebook plugin. FB-3,
 * mirrors src/components/linkedin/LinkedInSetupWizard.jsx.
 *
 * Multi-step wizard that walks the user through:
 *   1. Creating a Meta App
 *   2. Requesting the Pages permissions
 *   3. Getting a long-lived Page access token
 *   4. Storing it in the vault
 *   5. Connecting a default Page (optional)
 */

import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import './facebook-setup.css'

const STEPS = [
  {
    id: 'create-app',
    title: 'Create a Meta App',
    subtitle: 'This takes about 2 minutes',
    content: (
      <>
        <p>Facebook requires a Meta App to connect. You only need to do this once.</p>
        <ol className="fbs-steps">
          <li>
            Open the <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer" className="fbs-link">Meta for Developers Portal <ExternalIcon /></a>
          </li>
          <li>Click <strong>Create App</strong> and choose the <strong>Business</strong> type</li>
          <li>Fill in your app name (e.g. "QuoxCORE") and select your business</li>
          <li>Accept the terms and create</li>
        </ol>
        <div className="fbs-tip">
          <TipIcon />
          <span>You need to be an admin of the Facebook Page you want to connect.</span>
        </div>
      </>
    ),
  },
  {
    id: 'request-access',
    title: 'Request Page Permissions',
    subtitle: 'Choose what the app can do',
    content: (
      <>
        <p>In your app's settings, add the <strong>Facebook Login</strong> product and request these permissions:</p>
        <div className="fbs-products">
          <div className="fbs-product">
            <CheckIcon />
            <div>
              <strong>pages_show_list</strong>
              <span>List the Pages you manage</span>
            </div>
          </div>
          <div className="fbs-product">
            <CheckIcon />
            <div>
              <strong>pages_read_engagement, read_insights</strong>
              <span>Read posts, insights, and follower counts</span>
            </div>
          </div>
          <div className="fbs-product">
            <CheckIcon />
            <div>
              <strong>pages_manage_posts</strong>
              <span>Publish Page posts (every publish still needs a human approval in HITL Inbox)</span>
            </div>
          </div>
          <div className="fbs-product">
            <CheckIcon />
            <div>
              <strong>leads_retrieval</strong>
              <span>Read submitted Lead Ads leads</span>
            </div>
            <span className="fbs-product-badge fbs-product-badge--review">Needs App Review for live use</span>
          </div>
        </div>
        <div className="fbs-tip">
          <TipIcon />
          <span>pages_show_list, pages_read_engagement, and pages_manage_posts work for admins in development mode. leads_retrieval and read_insights at scale need Meta App Review.</span>
        </div>
      </>
    ),
  },
  {
    id: 'get-token',
    title: 'Get a Long-Lived Page Token',
    subtitle: 'The key that connects everything',
    content: (
      <>
        <p>Use the Graph API Explorer to generate a token, then exchange it for a long-lived one:</p>

        <div className="fbs-method">
          <div className="fbs-method-header">
            <span className="fbs-method-badge">Recommended</span>
            <strong>Graph API Explorer</strong>
          </div>
          <ol className="fbs-steps">
            <li>
              Open <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener noreferrer" className="fbs-link">Graph API Explorer <ExternalIcon /></a>
            </li>
            <li>Select your app, then request a User access token with the permissions above</li>
            <li>Call <code>GET /me/accounts</code> to get a Page access token per Page you manage</li>
            <li>Exchange the User token for a long-lived one via <code>GET /oauth/access_token?grant_type=fb_exchange_token</code>, then re-call <code>/me/accounts</code> for a long-lived Page token</li>
            <li>Copy the Page access token</li>
          </ol>
        </div>

        <div className="fbs-tip fbs-tip--warn">
          <WarnIcon />
          <span>Long-lived Page tokens are valid for roughly <strong>60 days</strong>. You'll need to refresh it before then. The dashboard will warn you when it's close to expiring.</span>
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
        <p>Store your Page access token securely in the QuoxCORE vault.</p>
        <ol className="fbs-steps">
          <li>
            <button className="fbs-link-btn" onClick={onNavigateVault}>
              Open Vault Credentials <ArrowIcon />
            </button>
          </li>
          <li>Click <strong>Add Credential</strong></li>
          <li>Select type: <strong>Meta (Facebook)</strong></li>
          <li>Paste your Page access token, optionally add a default Page ID, and save</li>
        </ol>
        <div className="fbs-secure-badge">
          <LockIcon />
          <span>Your token is encrypted with AES-256-GCM and never leaves the vault.</span>
        </div>
      </>
    ),
  },
  {
    id: 'connect',
    title: 'Connect Your Page',
    subtitle: 'Almost there (optional)',
    isForm: true,
  },
]

// ─── Tiny SVG Icons (explicit colours, no currentColor) ─────
function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="fbs-icon-inline">
      <path d="M6 3h7v7M13 3L6 10" stroke="rgba(24, 119, 242, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="fbs-icon-inline">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="rgba(24, 119, 242, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="fbs-icon-check">
      <circle cx="10" cy="10" r="9" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="rgba(52, 211, 153, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="fbs-icon-tip">
      <circle cx="8" cy="8" r="7" stroke="rgba(24, 119, 242, 0.6)" strokeWidth="1.2"/>
      <path d="M8 5v3M8 10.5v.5" stroke="rgba(24, 119, 242, 0.8)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="fbs-icon-tip">
      <path d="M8 1.5L1 14h14L8 1.5z" stroke="rgba(251, 191, 36, 0.7)" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M8 6v3M8 11.5v.5" stroke="rgba(251, 191, 36, 0.9)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="fbs-icon-tip">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

function FacebookLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="fbs-logo">
      <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z" stroke="rgba(24, 119, 242, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Main Component ─────────────────────────────────────────
export default function FacebookSetupWizard({ onSave }) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [defaultPageId, setDefaultPageId] = useState('')

  const step = STEPS[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === STEPS.length - 1

  const handleNext = useCallback(() => {
    if (isLast) {
      // Default Page ID is optional: publish_page_post always takes an
      // explicit page_id, so finishing the wizard never requires one.
      onSave({ defaultPageId: defaultPageId.trim(), setupComplete: true })
    } else {
      setCurrentStep(s => Math.min(s + 1, STEPS.length - 1))
    }
  }, [isLast, defaultPageId, onSave])

  const handleBack = useCallback(() => {
    setCurrentStep(s => Math.max(s - 1, 0))
  }, [])

  return (
    <div className="fbs">
      {/* Header */}
      <div className="fbs-header">
        <FacebookLogo />
        <div>
          <h2 className="fbs-header__title">Connect Facebook</h2>
          <p className="fbs-header__sub">Set up once, publish forever</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="fbs-progress">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`fbs-progress__step ${i === currentStep ? 'fbs-progress__step--active' : ''} ${i < currentStep ? 'fbs-progress__step--done' : ''}`}
            onClick={() => setCurrentStep(i)}
          >
            <span className="fbs-progress__num">
              {i < currentStep ? '✓' : i + 1}
            </span>
            <span className="fbs-progress__label">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="fbs-content">
        <div className="fbs-content__header">
          <h3 className="fbs-content__title">{step.title}</h3>
          <p className="fbs-content__subtitle">{step.subtitle}</p>
        </div>

        <div className="fbs-content__body">
          {step.isForm ? (
            /* Final step: connect form */
            <div className="fbs-form">
              <p>Optionally set a default Page ID so the dashboard opens straight to it. You can always type a different Page ID at publish time.</p>

              <div className="fbs-field">
                <label className="fbs-field__label">
                  Default Page ID
                  <span className="fbs-field__optional">Optional</span>
                </label>
                <p className="fbs-field__help">
                  Find this on your Page's About tab, or ask the Facebook agent after connecting: "List my Pages".
                </p>
                <input
                  className="fbs-field__input"
                  type="text"
                  value={defaultPageId}
                  onChange={e => setDefaultPageId(e.target.value)}
                  placeholder="e.g. 1234567890"
                  autoFocus
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
      <div className="fbs-nav">
        <button
          className="fbs-nav__back"
          onClick={handleBack}
          disabled={isFirst}
        >
          Back
        </button>

        <div className="fbs-nav__right">
          {!isLast && (
            <button className="fbs-nav__skip" onClick={handleNext}>
              Next
            </button>
          )}
          {isLast && (
            <button
              className="fbs-nav__finish"
              onClick={handleNext}
            >
              Connect Facebook
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
