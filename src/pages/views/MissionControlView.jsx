/**
 * MissionControlView — Unified agentic experience
 *
 * UX-4: Consolidates Objectives, Agentic Teams, and OpsDeck into a single page
 * with three depths of progressive disclosure:
 *
 *   Depth 0 — Status strip (always visible): running/stale/approval counts
 *   Depth 1 — Tab content: Teams | Objectives | Live | Schedules (WC-5)
 *   Depth 2 — Detail drawer (480px slide-in, ESC to close)
 *
 * Old routes (/objectives, /teams-overview, /opsdeck) redirect here via
 * the Navigate component in routeRegistry.
 *
 * P6.A changes:
 *   Item 1 — Real inbox via useInboxWithRealtime (actionable+unread, limit 5)
 *   Item 2 — AgenticTeamView embedded short-circuit (black rectangle fix)
 *   Item 3 — ObjectivesView + OpsDeckView receive embedded prop (banner stacking fix)
 *   Item 4 — SchedulesPanel uses shared <ScheduleRow /> component
 *   Item 5 — Run Now shows executionId link for 30s (inside ScheduleRow)
 *   Item 6 — Inline InboxFeed expansion removed; inline strip links to /inbox
 *   Item 7 — Skeleton stagger 0.15s -> 0.05s (in CSS + here)
 *   Item 8 — K2 vitest in MissionControlView.k2-singlesource.test.jsx
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useRunningProcesses } from '../../hooks/useRunningProcesses'
import { useInboxWithRealtime } from '../../hooks/useInboxStream'
import { isPluginLicensed } from '../../services/licenseValidator'
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import TeamsOverviewView from './TeamsOverviewView'
import AgenticTeamView from './AgenticTeamView'
import ObjectivesView from './ObjectivesView'
import OpsDeckView from './OpsDeckView'
import { listAllSchedules } from '../../services/teamService'
import ScheduleRow from '../../components/scheduling/ScheduleRow'
import PlatformDependencyNotice from '../../components/ui/PlatformDependencyNotice.jsx'
import { getPlatformDependencyIssue } from '../../services/platformDependencyIssues'
import '../../styles/mission-control.css'

// Tab definitions
const TABS = [
  { key: 'objectives', label: 'Objectives', icon: '◎' },
  { key: 'teams',      label: 'Teams',      icon: '◆' },
  { key: 'schedules',  label: 'Schedules',  icon: '◷' },
  { key: 'live',       label: 'Live',       icon: '◉', requiresLicence: 'opsdeck' },
]

/**
 * Status strip — shows running/stale/stuck counts at a glance
 */
function StatusStrip({ runningCount, staleCount, stuckCount }) {
  const hasIssues = staleCount > 0 || stuckCount > 0

  return (
    <div className="mc-status-strip">
      {/* QuoxEngine brand */}
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
        color: '#d97706', opacity: 0.6, textTransform: 'uppercase',
        marginRight: 4,
      }}>QuoxEngine</span>
      <span className="mc-status-divider" />

      {/* Running */}
      <div className="mc-status-item">
        <span className={`mc-status-dot mc-status-dot--${runningCount > 0 ? 'active' : 'idle'}`} />
        <span className="mc-status-count">{runningCount}</span>
        <span className="mc-status-label">running</span>
      </div>

      {/* Stale */}
      {staleCount > 0 && (
        <>
          <span className="mc-status-divider" />
          <div className="mc-status-item">
            <span className="mc-status-dot mc-status-dot--stale" />
            <span className="mc-status-count">{staleCount}</span>
            <span className="mc-status-label">stale</span>
          </div>
        </>
      )}

      {/* Stuck */}
      {stuckCount > 0 && (
        <>
          <span className="mc-status-divider" />
          <div className="mc-status-item">
            <span className="mc-status-dot mc-status-dot--stuck" />
            <span className="mc-status-count">{stuckCount}</span>
            <span className="mc-status-label">stuck</span>
          </div>
        </>
      )}

      {/* Health summary text */}
      {!hasIssues && runningCount === 0 && (
        <span style={{ color: 'var(--m-text-tertiary)', fontSize: 11, opacity: 0.6 }}>
          All clear — no active objectives
        </span>
      )}
    </div>
  )
}


// =============================================
// WC-5: SchedulesPanel  (Item 4 — uses shared ScheduleRow)
// =============================================

function SchedulesPanel() {
  const { authFetch } = useAuth()
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const scheduleServiceIssue = getPlatformDependencyIssue(error, {
    service: 'tasks',
    feature: 'Mission Control schedules',
  })

  const fetchSchedules = useCallback(async () => {
    if (!authFetch) return
    try {
      setError(null)
      const data = await listAllSchedules(authFetch)
      // K2 guard: filter out any quoxflow-sourced rows that sneak through.
      // The API /collector/schedules?source=tasks should already exclude them,
      // but this ensures the single-source invariant holds even if the guard breaks.
      const rows = (data.schedules || []).filter(s => s.source !== 'quoxflow')
      setSchedules(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [authFetch])

  useEffect(() => { fetchSchedules() }, [fetchSchedules])

  if (loading) {
    return (
      <div style={{ padding: '16px 20px', maxWidth: 960 }} role="status" aria-label="Loading schedules">
        {[0, 1, 2, 3].map(i => (
          /* Item 7: stagger 0.05s (was 0.15s); first row at 0s via CSS .mc-skeleton-row:first-child */
          <div key={i} className="mc-skeleton-row" style={{ animationDelay: `${i * 0.05}s` }}>
            <div className="mc-skeleton-bar" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
            <div className="mc-skeleton-bar" style={{ flex: 1, height: 14 }} />
            <div className="mc-skeleton-bar" style={{ width: 100, height: 12 }} />
            <div className="mc-skeleton-bar" style={{ width: 60, height: 12 }} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 20px', maxWidth: 960 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}>
            Schedules
          </span>
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 8,
            background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {schedules.length}
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        scheduleServiceIssue ? (
          <PlatformDependencyNotice issue={scheduleServiceIssue} compact style={{ marginBottom: 12 }} />
        ) : (
          <div style={{
            padding: '8px 12px', marginBottom: 12, borderRadius: 6,
            background: 'rgba(239,68,68,0.12)', color: '#f87171', fontSize: 12,
          }}>
            {error}
          </div>
        )
      )}

      {/* Empty state */}
      {schedules.length === 0 && !error && (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          color: 'rgba(255,255,255,0.4)', fontSize: 13,
        }}>
          <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.4 }}>{'◷'}</div>
          No schedules yet. Create one from the Objectives tab using "Schedule" on a template.
        </div>
      )}

      {/* Item 4: Schedule rows — now using shared <ScheduleRow /> */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {schedules.map(schedule => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            onUpdated={(updated) => setSchedules(prev => prev.map(s => s.id === updated.id ? updated : s))}
            onDeleted={(id) => setSchedules(prev => prev.filter(s => s.id !== id))}
            onError={(msg) => setError(msg)}
          />
        ))}
      </div>
    </div>
  )
}


/**
 * MissionControlView — main component
 */
export default function MissionControlView() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Running process state for status strip
  const { runningCount, staleCount, stuckCount } = useRunningProcesses()

  // Item 1: Real inbox via useInboxWithRealtime — replaces the fake derived list.
  // Scoped to actionable + unread, limit 5. Falls back gracefully if org not loaded.
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  const { items: allInboxItems } = useInboxWithRealtime(orgId)
  const inboxItems = useMemo(() => {
    if (!allInboxItems?.length) return []
    return allInboxItems
      .filter(item => {
        const actionable = ['pending', 'open', 'waiting'].includes(item.status) || !item.status
        const unread = !item.read_at
        return actionable && unread
      })
      .slice(0, 5)
  }, [allInboxItems])

  // Tab state from URL
  const activeTab = searchParams.get('tab') || 'objectives'

  // Team detail drawer state (synced with URL ?team=)
  const selectedTeamId = searchParams.get('team') || null

  const setSelectedTeamId = useCallback((teamId) => {
    const params = { tab: activeTab }
    if (teamId) params.team = teamId
    setSearchParams(params, { replace: true })
  }, [activeTab, setSearchParams])

  const closeTeamDrawer = useCallback(() => {
    setSearchParams({ tab: activeTab }, { replace: true })
  }, [activeTab, setSearchParams])

  // Filter tabs by licence
  const visibleTabs = useMemo(() => {
    return TABS.filter(tab => {
      if (!tab.requiresLicence) return true
      return isPluginLicensed(tab.requiresLicence)
    })
  }, [])

  // Tab switching
  const setTab = useCallback((key) => {
    setSearchParams({ tab: key }, { replace: true })
  }, [setSearchParams])

  // ESC to close drawer, number keys for tab switching
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape' && selectedTeamId) {
        e.preventDefault()
        closeTeamDrawer()
        return
      }
      if (e.key === '1' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setTab('objectives') }
      else if (e.key === '2' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setTab('teams') }
      else if (e.key === '3' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setTab('schedules') }
      else if (e.key === '4' && !e.metaKey && !e.ctrlKey && visibleTabs.some(t => t.key === 'live')) {
        e.preventDefault(); setTab('live')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setTab, visibleTabs, selectedTeamId, closeTeamDrawer])

  return (
    <div className="mc-container">
      <LLMAuthBanner />

      {/* Depth 0 — Status Strip */}
      <StatusStrip
        runningCount={runningCount}
        staleCount={staleCount}
        stuckCount={stuckCount}
      />

      {/* Item 1+6: Real inbox strip — links to /inbox; no inline expansion (item 6 dropped).
           useInboxWithRealtime replaces the old fake derived list from useRunningProcesses. */}
      {inboxItems.length > 0 && (
        <div style={{
          padding: '6px 20px',
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 11, borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(251,191,36,0.04)',
          flexShrink: 0,
        }}>
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>
            {inboxItems.length} action{inboxItems.length !== 1 ? 's' : ''} pending
          </span>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 10 }}>—</span>
          {inboxItems.slice(0, 2).map(item => (
            <Link
              key={item.id}
              to="/inbox"
              style={{
                color: 'rgba(255,255,255,0.65)',
                textDecoration: 'none',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-block',
              }}
              title={item.title}
            >
              {item.title}
            </Link>
          ))}
          {inboxItems.length > 2 && (
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>
              +{inboxItems.length - 2} more
            </span>
          )}
          <Link
            to="/inbox"
            style={{
              marginLeft: 'auto',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 10,
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            View all →
          </Link>
        </div>
      )}

      {/* OBJ-1: Plans Awaiting Approval banner now rendered INSIDE
          ObjectivesView's list panel — keeps PRISM sidebar full height
          and contextualises the banner to the Objectives tab. */}

      {/* Tab Bar */}
      <div className="mc-tab-bar" role="tablist" aria-label="Mission Control tabs">
        {visibleTabs.map(tab => (
          <button
            key={tab.key}
            className={`mc-tab ${activeTab === tab.key ? 'mc-tab--active' : ''}`}
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => setTab(tab.key)}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Depth 1 — Tab Content.
           Item 3: ObjectivesView + OpsDeckView receive embedded prop to suppress
           their own LLMAuthBanner and outer page padding. */}
      <div className="mc-content">
        <div className="mc-tab-content" key={activeTab}>
          {activeTab === 'objectives' && <ObjectivesView embedded />}
          {activeTab === 'teams' && <TeamsOverviewView onTeamSelect={setSelectedTeamId} />}
          {activeTab === 'schedules' && <SchedulesPanel />}
          {activeTab === 'live' && <OpsDeckView embedded />}
        </div>

        {/* Depth 2 — Team Detail Drawer.
             Item 2: AgenticTeamView receives embedded prop to suppress glass-card wrapper. */}
        {selectedTeamId && (
          <>
            <div className="mc-drawer-overlay" onClick={closeTeamDrawer} />
            <div className="mc-drawer mc-drawer--wide">
              <div className="mc-drawer__header">
                <button className="mc-drawer__close" onClick={closeTeamDrawer} title="Close (Esc)">
                  ✕
                </button>
                <span className="mc-drawer__title">Team Detail</span>
                <span className="mc-drawer__kbd">Esc</span>
              </div>
              <div className="mc-drawer__body">
                <AgenticTeamView teamId={selectedTeamId} onClose={closeTeamDrawer} embedded />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
