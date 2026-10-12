/**
 * YouTubeSetupWizard — Guided onboarding for the YouTube plugin.
 *
 * 4-step wizard:
 *   1. Enable YouTube API in Google Cloud Console
 *   2. Get OAuth tokens via Google OAuth Playground
 *   3. Store credentials in Vault
 *   4. Connect channel (auto-detect or manual)
 *
 * Design: progressive disclosure, YouTube red accent, dark glassmorphic.
 */

import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { checkCredentialHealth } from '../../services/youtubeClient'
import './youtube-setup.css'

const YOUTUBE_CATEGORIES = [
  { id: '1', name: 'Film & Animation' },
  { id: '2', name: 'Autos & Vehicles' },
  { id: '10', name: 'Music' },
  { id: '15', name: 'Pets & Animals' },
  { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
  { id: '20', name: 'Gaming' },
  { id: '22', name: 'People & Blogs' },
  { id: '23', name: 'Comedy' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' },
  { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' },
  { id: '29', name: 'Nonprofits & Activism' },
]

// ─── SVG Icons (explicit colours, no currentColor) ───────────
function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="yts-icon-inline">
      <path d="M6 3h7v7M13 3L6 10" stroke="rgba(255, 0, 0, 0.85)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="yts-icon-inline">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="rgba(255, 0, 0, 0.85)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="yts-icon-check">
      <circle cx="10" cy="10" r="9" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.5"/>
      <path d="M6 10l3 3 5-5" stroke="rgba(52, 211, 153, 0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="yts-icon-tip">
      <circle cx="8" cy="8" r="7" stroke="rgba(255, 0, 0, 0.7)" strokeWidth="1.2"/>
      <path d="M8 5v3M8 10.5v.5" stroke="rgba(255, 0, 0, 0.7)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="yts-icon-tip">
      <path d="M8 1.5L1 14h14L8 1.5z" stroke="rgba(251, 191, 36, 0.7)" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M8 6v3M8 11.5v.5" stroke="rgba(251, 191, 36, 0.9)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="yts-icon-tip">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="rgba(52, 211, 153, 0.7)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
}

function YouTubeLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="yts-logo">
      <rect x="2" y="4" width="20" height="16" rx="4" stroke="rgba(255, 0, 0, 0.85)" strokeWidth="1.8"/>
      <path d="M10 8.5v7l6-3.5-6-3.5z" style={{ fill: 'rgba(255, 0, 0, 0.85)' }}/>
    </svg>
  )
}

const STEPS = [
  {
    id: 'enable-api',
    title: 'Enable YouTube API',
    subtitle: 'Set up a Google Cloud project',
    content: (
      <>
        <p>YouTube uses Google Cloud for API access. You only need to do this once.</p>
        <ol className="yts-steps">
          <li>
            Open the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer" className="yts-link">Google Cloud Console <ExternalIcon /></a>
          </li>
          <li>Create a new project (or select an existing one)</li>
          <li>
            Go to <strong>APIs &amp; Services &gt; Library</strong> and search for <code>YouTube Data API v3</code>
          </li>
          <li>Click <strong>Enable</strong></li>
          <li>
            Go to <strong>APIs &amp; Services &gt; Credentials</strong>, click <strong>Create Credentials &gt; OAuth client ID</strong>
          </li>
          <li>
            Select application type: <strong>Web application</strong>. Add <code>https://developers.google.com/oauthplayground</code> as an authorised redirect URI.
          </li>
          <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong></li>
        </ol>
        <div className="yts-tip">
          <TipIcon />
          <span>If you have not configured an OAuth consent screen yet, Google will prompt you. Select "External" for testing, add your email as a test user.</span>
        </div>
      </>
    ),
  },
  {
    id: 'get-tokens',
    title: 'Get OAuth Tokens',
    subtitle: 'Exchange credentials for access + refresh tokens',
    content: (
      <>
        <p>Use the Google OAuth Playground to generate your tokens. This gives you both an access token and a refresh token.</p>
        <ol className="yts-steps">
          <li>
            Open <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noopener noreferrer" className="yts-link">Google OAuth Playground <ExternalIcon /></a>
          </li>
          <li>Click the gear icon (top right) and tick <strong>Use your own OAuth credentials</strong></li>
          <li>Enter your Client ID and Client Secret from Step 1</li>
          <li>In the scope list on the left, find and select these scopes:</li>
        </ol>

        <div className="yts-scopes">
          <div className="yts-scope">
            <CheckIcon />
            <div>
              <strong>youtube</strong>
              <span>Manage your YouTube account</span>
            </div>
            <span className="yts-scope-badge">Required</span>
          </div>
          <div className="yts-scope">
            <CheckIcon />
            <div>
              <strong>youtube.upload</strong>
              <span>Upload videos</span>
            </div>
            <span className="yts-scope-badge">Required</span>
          </div>
          <div className="yts-scope">
            <CheckIcon />
            <div>
              <strong>youtube.readonly</strong>
              <span>Read channel data and video stats</span>
            </div>
            <span className="yts-scope-badge">Required</span>
          </div>
        </div>

        <ol className="yts-steps" start="5">
          <li>Click <strong>Authorize APIs</strong> and sign in with your Google account</li>
          <li>Click <strong>Exchange authorization code for tokens</strong></li>
          <li>Copy both the <strong>Access Token</strong> and <strong>Refresh Token</strong></li>
        </ol>

        <div className="yts-tip yts-tip--warn">
          <WarnIcon />
          <span>Access tokens expire after <strong>1 hour</strong>, but the refresh token is long-lived. The connector will auto-refresh using the refresh token and your client credentials.</span>
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
        <p>Store all four values securely in the QuoxCORE vault.</p>
        <ol className="yts-steps">
          <li>
            <button className="yts-link-btn" onClick={onNavigateVault}>
              Open Vault Credentials <ArrowIcon />
            </button>
          </li>
          <li>Click <strong>Add Credential</strong></li>
          <li>Select type: <strong>YouTube</strong></li>
          <li>Paste all four fields: <code>access_token</code>, <code>refresh_token</code>, <code>client_id</code>, <code>client_secret</code></li>
          <li>Save</li>
        </ol>
        <div className="yts-secure-badge">
          <LockIcon />
          <span>Your tokens are encrypted with AES-256-GCM and never leave the vault. The connector reads them at runtime only.</span>
        </div>
      </>
    ),
  },
  {
    id: 'connect',
    title: 'Connect Channel',
    subtitle: 'Almost there',
    isForm: true,
  },
]

// ─── Main Component ─────────────────────────────────────────
export default function YouTubeSetupWizard({ onComplete }) {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [channelId, setChannelId] = useState('')
  const [defaultPrivacy, setDefaultPrivacy] = useState('private')
  const [defaultCategory, setDefaultCategory] = useState('28')
  const [detectedChannel, setDetectedChannel] = useState(null)
  const [detecting, setDetecting] = useState(false)

  const step = STEPS[currentStep]
  const isFirst = currentStep === 0
  const isLast = currentStep === STEPS.length - 1

  // Auto-detect channel when reaching step 4
  useEffect(() => {
    if (currentStep === 3) {
      setDetecting(true)
      checkCredentialHealth()
        .then((health) => {
          if (health.connected && health.channel) {
            setDetectedChannel(health.channel)
            if (health.channel.id && !channelId) {
              setChannelId(health.channel.id)
            }
          }
        })
        .catch(() => {})
        .finally(() => setDetecting(false))
    }
  }, [currentStep]) // eslint-disable-line react-hooks/exhaustive-deps

  const canFinish = channelId.trim().length > 0

  const handleNext = useCallback(() => {
    if (isLast) {
      if (canFinish) {
        onComplete({
          channelId: channelId.trim(),
          defaultPrivacy,
          defaultCategory,
        })
      }
    } else {
      setCurrentStep(s => Math.min(s + 1, STEPS.length - 1))
    }
  }, [isLast, canFinish, channelId, defaultPrivacy, defaultCategory, onComplete])

  const handleBack = useCallback(() => {
    setCurrentStep(s => Math.max(s - 1, 0))
  }, [])

  return (
    <div className="yts">
      {/* Header */}
      <div className="yts-header">
        <YouTubeLogo />
        <div>
          <h2 className="yts-header__title">Connect YouTube</h2>
          <p className="yts-header__sub">Set up once, publish and manage forever</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="yts-progress">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`yts-progress__step ${i === currentStep ? 'yts-progress__step--active' : ''} ${i < currentStep ? 'yts-progress__step--done' : ''}`}
            onClick={() => setCurrentStep(i)}
          >
            <span className="yts-progress__num">
              {i < currentStep ? '\u2713' : i + 1}
            </span>
            <span className="yts-progress__label">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="yts-content">
        <div className="yts-content__header">
          <h3 className="yts-content__title">{step.title}</h3>
          <p className="yts-content__subtitle">{step.subtitle}</p>
        </div>

        <div className="yts-content__body">
          {step.isForm ? (
            /* Final step: connect form */
            <div className="yts-form">
              {detecting && (
                <p style={{ color: 'rgba(255, 255, 255, 0.6)', fontStyle: 'italic' }}>
                  Detecting your channel from vault credentials...
                </p>
              )}

              {detectedChannel && (
                <div className="yts-channel-found">
                  {detectedChannel.thumbnail ? (
                    <img
                      className="yts-channel-found__thumb"
                      src={detectedChannel.thumbnail}
                      alt={detectedChannel.title || 'Channel'}
                    />
                  ) : (
                    <span style={{
                      width: 44, height: 44, borderRadius: '50%',
                      background: 'rgba(52, 211, 153, 0.1)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18, color: 'rgba(52, 211, 153, 0.8)', flexShrink: 0
                    }}>
                      {'\u25B6'}
                    </span>
                  )}
                  <div>
                    <p className="yts-channel-found__name">{detectedChannel.title || 'Your Channel'}</p>
                    <p className="yts-channel-found__subs">
                      {detectedChannel.subscriberCount ? `${Number(detectedChannel.subscriberCount).toLocaleString()} subscribers` : 'Channel detected'}
                    </p>
                  </div>
                  <span className="yts-channel-found__badge">Connected</span>
                </div>
              )}

              {!detecting && !detectedChannel && (
                <p style={{ color: 'rgba(255, 255, 255, 0.5)', fontSize: 13, marginBottom: 16 }}>
                  Could not auto-detect your channel. Enter the Channel ID manually below.
                </p>
              )}

              <div className="yts-field">
                <label className="yts-field__label">
                  Channel ID
                  <span className="yts-field__required">Required</span>
                </label>
                <p className="yts-field__help">
                  Find this in YouTube Studio under Settings &gt; Channel &gt; Advanced settings, or in your channel URL (youtube.com/channel/UC...).
                </p>
                <input
                  className="yts-field__input"
                  type="text"
                  value={channelId}
                  onChange={e => setChannelId(e.target.value)}
                  placeholder="UC..."
                  autoFocus
                />
              </div>

              <div className="yts-field">
                <label className="yts-field__label">
                  Default Privacy
                  <span className="yts-field__optional">Optional</span>
                </label>
                <p className="yts-field__help">
                  Default privacy status for new uploads. You can override this per video.
                </p>
                <select
                  className="yts-field__select"
                  value={defaultPrivacy}
                  onChange={e => setDefaultPrivacy(e.target.value)}
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </div>

              <div className="yts-field">
                <label className="yts-field__label">
                  Default Category
                  <span className="yts-field__optional">Optional</span>
                </label>
                <p className="yts-field__help">
                  Default category for new uploads.
                </p>
                <select
                  className="yts-field__select"
                  value={defaultCategory}
                  onChange={e => setDefaultCategory(e.target.value)}
                >
                  {YOUTUBE_CATEGORIES.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
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
      <div className="yts-nav">
        <button
          className="yts-nav__back"
          onClick={handleBack}
          disabled={isFirst}
        >
          {'\u25C0'} Back
        </button>

        <div className="yts-nav__right">
          {!isLast && (
            <button className="yts-nav__next" onClick={handleNext}>
              Next {'\u25B6'}
            </button>
          )}
          {isLast && (
            <button
              className="yts-nav__finish"
              onClick={handleNext}
              disabled={!canFinish}
            >
              {'\u25B6'} Finish Setup
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
