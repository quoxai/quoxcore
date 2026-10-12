/**
 * GoalLane — P10.I-1 Goal Lane on Home
 *
 * Horizontal band above the chat workspace on `/`. One card per active
 * automation thread. Threads are grouped by corr (conversation ID) and
 * aggregated from the AEE envelope feed.
 *
 * Empty state: "Nothing running. Try one of these:" with 3 starter Crystals.
 *
 * Glass design system: qx-card / qx-pill / qx-row tokens. No bespoke CSS.
 *
 * Note: an earlier draft folded a Mission Control panel below the lane via
 * a disclosure toggle. Reverted 2026-05-08 — too dense for a Home accordion.
 * Mission Control lives at /mission-control as a separate page.
 */

import { useState, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { subscribeGoalLane } from '../../services/goalLaneFeed'
import GoalLaneCard from './GoalLaneCard'

// ── Empty state — starter Crystals ────────────────────────────────────────

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ crystals = [] }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flex: 1,
      minWidth: 0,
    }}>
      {/* Idle dot */}
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: 'var(--text-muted)', opacity: 0.35,
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        Nothing running.
      </span>
      {crystals.length > 0 && (
        <>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', opacity: 0.6, whiteSpace: 'nowrap' }}>
            Try:
          </span>
          <div style={{ display: 'flex', gap: 6, overflow: 'hidden' }}>
            {crystals.slice(0, 3).map((c) => (
              <span
                key={c.id || c.sourceWorkflowId}
                className="qx-pill qx-pill--sm qx-pill--ghost"
                style={{ cursor: 'default', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {c.name || c.sourceWorkflowId || 'Crystal'}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

const COLLAPSE_KEY = 'quox.goalLane.collapsed'

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}
function writeCollapsed(v) {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0') } catch { /* noop */ }
}

export default function GoalLane() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  const [threads, setThreads] = useState([])
  const [starterCrystals, setStarterCrystals] = useState([])
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggleCollapsed = () => setCollapsed((v) => { writeCollapsed(!v); return !v })

  // Tick every 30s so "elapsed" labels stay fresh without server traffic
  const [, setTickN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTickN((n) => (n + 1) % 1000), 30_000)
    return () => clearInterval(id)
  }, [])

  // Subscribe to goal lane feed
  useEffect(() => {
    if (!authFetch) return

    const unsubscribe = subscribeGoalLane(
      (newThreads) => setThreads(newThreads),
      authFetch,
      orgId,
    )

    return unsubscribe
  }, [authFetch, orgId])

  // Load 3 starter Crystals for the empty state
  useEffect(() => {
    if (!authFetch || !orgId || threads.length > 0) return
    let cancelled = false

    async function loadCrystals() {
      try {
        const mod = await import('../../services/quoxflowClient')
        const skills = await mod.listSkills?.({ orgId, limit: 3 }).catch(() => [])
        if (!cancelled && Array.isArray(skills)) {
          setStarterCrystals(skills.slice(0, 3))
        }
      } catch {
        // Empty state still renders without Crystals — graceful no-op.
      }
    }

    loadCrystals()
    return () => { cancelled = true }
  }, [authFetch, orgId, threads.length])

  return (
    <div
      className="goal-lane"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        flexShrink: 0,
      }}
    >
      {/* Header strip — always visible. Doubles as collapse trigger.
          Click anywhere on the header (except cards) to expand/collapse. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <button
          type="button"
          data-testid="goal-lane-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Goal Lane' : 'Collapse Goal Lane'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--text-muted)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            opacity: 0.7,
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            style={{
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
              flexShrink: 0,
            }}
            aria-hidden
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
          Goal Lane
          {threads.length > 0 && (
            <span style={{
              marginLeft: 4,
              padding: '1px 7px',
              borderRadius: 999,
              background: 'rgba(6,182,212,0.18)',
              color: 'var(--qx-cyan, #06b6d4)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0,
            }}>
              {threads.length}
            </span>
          )}
          {collapsed && threads.length === 0 && (
            <span style={{ marginLeft: 4, opacity: 0.55, letterSpacing: 0, fontWeight: 500 }}>
              · idle
            </span>
          )}
        </button>
      </div>

      {/* Band: 2-row cards. Hidden when collapsed. Content drives height. */}
      {!collapsed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: 10,
            padding: '12px 16px',
            overflowX: 'auto',
            overflowY: 'visible',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {threads.length === 0 ? (
            <EmptyState crystals={starterCrystals} />
          ) : (
            threads.map((thread) => (
              <GoalLaneCard key={thread.corr} thread={thread} />
            ))
          )}
        </div>
      )}
    </div>
  )
}
