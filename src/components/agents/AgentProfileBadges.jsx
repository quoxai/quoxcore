/**
 * AgentProfileBadges — catalog stats cluster for agent cards.
 *
 * Renders skills / tools / workflows / crystals count badges for a single agent.
 * Follows anti-placeholder discipline: if a count field is absent from the
 * profile response, its badge is NOT rendered (not shown as 0).
 *
 * Props:
 *   agentId        — agent ID string (used to fetch if profile not provided)
 *   variant        — 'compact' (default) | 'detail' (shows top_5_skills inline)
 *   profile        — pre-fetched profile object; if provided, no fetch is made.
 *                    Use this in AssistantsView where a batch fetch is done
 *                    once for all agents.
 *
 * QSKL-AP-2
 */

import { useEffect, useState } from 'react'
import { fetchAgentProfile } from '../../services/agentProfileClient.js'
import '../../styles/agent-profile-badges.css'

export function AgentProfileBadges({ agentId, variant = 'compact', profile: providedProfile }) {
  const [profile, setProfile] = useState(providedProfile || null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!providedProfile)

  useEffect(() => {
    if (providedProfile) {
      setProfile(providedProfile)
      setLoading(false)
      return
    }

    if (!agentId) {
      setLoading(false)
      return
    }

    const ac = new AbortController()
    setLoading(true)
    setError(null)

    fetchAgentProfile(agentId, { signal: ac.signal })
      .then(p => {
        setProfile(p)
        setLoading(false)
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          setError(err)
          setLoading(false)
        }
      })

    return () => ac.abort()
  }, [agentId, providedProfile])

  // Fail silently — don't break card render
  if (error) return null

  if (loading) {
    return (
      <div
        className="ac__stat-cluster ac__stat-cluster--loading"
        aria-busy="true"
      />
    )
  }

  if (!profile) return null

  // Build badge list — OMIT any field absent from profile (anti-placeholder)
  const badges = []

  if (typeof profile.skill_count === 'number') {
    const isZero = profile.skill_count === 0
    badges.push({
      key: 'skills',
      count: profile.skill_count,
      label: 'skills',
      zero: isZero,
      cta: isZero
        ? {
            text: 'Author one →',
            href: `/skills?best_for_agents=${encodeURIComponent(agentId)}&create=1`,
          }
        : null,
    })
  }

  if (typeof profile.tool_count === 'number') {
    badges.push({
      key: 'tools',
      count: profile.tool_count,
      label: 'tools',
      zero: profile.tool_count === 0,
      cta: null,
    })
  }

  if (typeof profile.workflow_count === 'number') {
    badges.push({
      key: 'workflows',
      count: profile.workflow_count,
      label: 'workflows',
      zero: profile.workflow_count === 0,
      cta: null,
    })
  }

  // crystal_count: only render if field is present in response
  if (typeof profile.crystal_count === 'number') {
    badges.push({
      key: 'crystals',
      count: profile.crystal_count,
      label: 'crystals',
      zero: profile.crystal_count === 0,
      cta: null,
    })
  }

  const showDetail = variant === 'detail'
  const hasTopSkills = Array.isArray(profile.top_5_skills) && profile.top_5_skills.length > 0

  return (
    <div
      className={`ac__stat-cluster${showDetail ? ' ac__stat-cluster--detail' : ''}`}
      role="list"
      aria-label={`${agentId} catalog stats`}
    >
      {badges.map(b => (
        <span
          key={b.key}
          className={`qx-pill qx-pill--sm${b.zero ? ' qx-pill--zero' : ''}`}
          role="listitem"
        >
          <strong>{b.count}</strong>
          <span className="qx-pill__label">{b.label}</span>
          {b.cta && (
            <a href={b.cta.href} className="qx-pill__cta">
              {b.cta.text}
            </a>
          )}
        </span>
      ))}

      {showDetail && hasTopSkills && (
        <div className="ac__stat-detail">
          <span className="ac__stat-detail-label">Top skills:</span>
          {profile.top_5_skills.map(s => (
            <a
              key={s.id}
              href={`/skills?id=${encodeURIComponent(s.id)}`}
              className="ac__stat-detail-item"
            >
              {s.name}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
