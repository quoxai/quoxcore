/**
 * LLMAuthBanner — Warning banner when LLM auth is not configured
 *
 * Renders a dismissible amber/red banner at the top of any page where
 * agents, chat, workflows, or objectives might be started.
 * Returns null when auth is ready.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import useLLMStatus from '../../hooks/useLLMStatus'

// Canonical settings hash for provider key setup (SET-IA V2 section id).
const PROVIDER_KEYS_SETTINGS_PATH = '/settings#instance/provider-keys'

export default function LLMAuthBanner({ status: statusOverride = null }) {
  const status = statusOverride || useLLMStatus()
  const { ready, recommendation, loading, error, authMethod } = status
  const [dismissed, setDismissed] = useState(false)

  if (loading || ready || ready === null || dismissed) return null

  const serviceUnavailable = authMethod === 'unavailable' || !!error
  const title = serviceUnavailable ? 'LLM service unavailable' : 'LLM not authenticated'
  const message = recommendation || (
    serviceUnavailable
      ? 'Ensure the collector service is running and reachable before starting chat.'
      : 'Configure OpenAI or Anthropic in Settings → Core Integrations.'
  )
  // Service-outage banners still point at provider-keys — a stale/missing
  // key is a common contributor to "unavailable" collector responses, and
  // the section is never the wrong place to check first.
  const linkLabel = serviceUnavailable
    ? 'Check Core Integrations'
    : 'Open Settings → Core Integrations'

  return (
    <div className="qx-banner qx-banner--warn" role="status" style={{ margin: '0 0 12px 0' }}>
      <svg className="qx-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span style={{ flex: 1 }}>
        <strong className="qx-banner__title">{title}</strong> — {message}
      </span>
      <div className="qx-banner__actions">
        <Link to={PROVIDER_KEYS_SETTINGS_PATH} className="qx-btn qx-btn--sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {linkLabel}
        </Link>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          onClick={() => setDismissed(true)}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
