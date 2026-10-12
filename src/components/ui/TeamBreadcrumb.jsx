/**
 * TeamBreadcrumb — Prop-driven breadcrumb for Agentic Teams pages.
 *
 * Usage:
 *   <TeamBreadcrumb teamName="SecOps" tabLabel="Objectives" />
 *   → Agentic Teams > SecOps > Objectives
 */

import { useNavigate } from 'react-router-dom'

export default function TeamBreadcrumb({ teamName, tabLabel }) {
  const navigate = useNavigate()

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        marginBottom: 16,
        color: 'var(--m-text-tertiary, #71717a)',
      }}
    >
      <button
        onClick={() => navigate('/teams-overview')}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--m-text-secondary, #a1a1aa)',
          fontSize: 12,
          fontWeight: 500,
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--m-text-primary, #f4f4f5)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--m-text-secondary, #a1a1aa)'}
      >
        Agentic Teams
      </button>
      <span style={{ opacity: 0.5 }}>›</span>
      {teamName && (
        <>
          <span style={{ color: tabLabel ? 'var(--m-text-secondary, #a1a1aa)' : 'var(--m-text-primary, #f4f4f5)', fontWeight: tabLabel ? 400 : 500 }}>
            {teamName}
          </span>
          {tabLabel && (
            <>
              <span style={{ opacity: 0.5 }}>›</span>
              <span style={{ color: 'var(--m-text-primary, #f4f4f5)', fontWeight: 500 }}>{tabLabel}</span>
            </>
          )}
        </>
      )}
    </nav>
  )
}
