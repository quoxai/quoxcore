/**
 * AgentStandingWidget — fetches real Agent Standing data (services/tasks
 * GET /api/agent-standing/:agentId) and mounts the presentational
 * StandingBadge with it.
 *
 * StandingBadge itself is prop-driven only (no fetching) — this wrapper is
 * the data-fetching boundary, following the same pattern as
 * AgentProfileBadges.jsx (loading state, AbortController cleanup, fail
 * silently rather than break the surrounding card).
 *
 * Renders nothing until the fetch resolves — never shows a fabricated
 * score/status before real data is in.
 */

import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { fetchAgentStanding } from '../../services/agentStandingClient'
import StandingBadge from './StandingBadge'

export default function AgentStandingWidget({ agentId, taskClass = 'general' }) {
  const { authFetch } = useAuth()
  const [standing, setStanding] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!agentId) return
    const ac = new AbortController()
    setStanding(null)
    setError(null)

    fetchAgentStanding(authFetch, agentId, { taskClass, signal: ac.signal })
      .then((data) => setStanding(data))
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err)
      })

    return () => ac.abort()
  }, [agentId, taskClass, authFetch])

  // Fail silently — Standing is supplementary, not load-bearing for the page.
  if (error) return null
  if (!standing) return null

  return <StandingBadge standing={standing} />
}
