/**
 * SuggestionPanel — P10.I-3 Quox Brain
 *
 * Sidebar panel titled "Quox suggests". Fetches the top-3 active suggestions
 * on mount, refreshes after each dismiss. Empty state shown when no rules
 * fire for the current org.
 *
 * Glass design system: qx-card / qx-pill / qx-btn tokens only. No bespoke CSS.
 */

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { getSuggestions, dismissSuggestion } from '../../services/quoxBrain'
import SuggestionCard from './SuggestionCard'

const MAX_CARDS = 3

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="qx-card qx-card--compact"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '13px 15px',
        // Dim the content, NOT the whole card — a card-wide opacity also faded
        // the border/background, so it read as unpadded floating text (owner).
        color: 'var(--text-secondary)',
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      {/* checkmark icon */}
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      All clear, no suggestions right now
    </div>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

export default function SuggestionPanel() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()

  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  const orgId = currentOrg?.id || localStorage.getItem('current_org_id') || ''
  const tier = currentOrg?.tier || 'tier_free'

  // Keep authFetch in a ref so the effect doesn't re-run when it changes identity
  const authFetchRef = useRef(authFetch)
  useEffect(() => { authFetchRef.current = authFetch }, [authFetch])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getSuggestions({ orgId, tier, authFetch: authFetchRef.current })
      .then((results) => {
        if (!cancelled) setSuggestions(results.slice(0, MAX_CARDS))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [orgId, tier, refreshTick])

  function refreshSuggestions() {
    setRefreshTick((t) => t + 1)
  }

  async function handleDismiss(suggestionId) {
    await dismissSuggestion({ suggestionId, orgId, authFetch: authFetchRef.current })
    // Refresh to pull in the next suggestion
    refreshSuggestions()
  }

  return (
    <section aria-label="Quox suggests" style={{ padding: '6px 20px 16px' }}>
      {/* Header — 20px inset matches AgentIdentityCard + the sidebar controls,
          so the "Quox suggests" block no longer hugs the sidebar's left edge. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        {/* sparkle icon */}
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', opacity: 0.8 }}>
          Quox suggests
        </span>
      </div>

      {/* Content */}
      {loading ? null : suggestions.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </section>
  )
}
