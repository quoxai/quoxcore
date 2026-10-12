/**
 * OpsDeckView V2 — Live Agent Activity Graph
 *
 * Zoomable node graph showing ALL active objectives simultaneously.
 * Each objective is a cluster with orchestrator + agent nodes.
 * Empty state guides users to Agentic Teams.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { isPluginLicensed } from '../../services/licenseValidator'
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import SystemPulseBar from '../../components/opsdeck/SystemPulseBar'
import OpsDeckCanvas from '../../components/opsdeck/OpsDeckCanvas'
import useOpsDeckState from '../../components/opsdeck/useOpsDeckState'
import { CommandStream } from '../../components/orchestration'
import RunningObjectivesWidget from '../../components/opsdeck/RunningObjectivesWidget'
import '../../styles/opsdeck.css'

function RecentHistory({ objectives, navigate }) {
  // Show last 10 objectives with their outcomes
  const recent = (objectives || [])
    .filter(o => o.status !== 'pending' && o.status !== 'decomposing')
    .slice(0, 10)

  const statusColor = (s) =>
    s === 'completed' ? '#22c55e'
    : s === 'completed_with_errors' ? '#eab308'
    : s === 'failed' ? '#ef4444'
    : s === 'cancelled' ? '#6b7280'
    : s === 'running' || s === 'in_progress' ? '#6366f1'
    : '#a1a1aa'

  const statusIcon = (s) =>
    s === 'completed' ? '\u2713'
    : s === 'completed_with_errors' ? '\u26A0'
    : s === 'failed' ? '\u2717'
    : s === 'cancelled' ? '\u2014'
    : s === 'running' || s === 'in_progress' ? '\u25CF'
    : '\u25CB'

  const timeAgo = (ts) => {
    if (!ts) return ''
    const diff = Date.now() - new Date(ts).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  if (recent.length === 0) {
    return (
      <div className="opsdeck-empty-state">
        <div className="opsdeck-empty-state__icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1" opacity="0.7">
            <circle cx="12" cy="12" r="10" strokeDasharray="4 3" />
            <circle cx="12" cy="12" r="6" strokeDasharray="4 3" />
            <circle cx="12" cy="12" r="2" fill="rgba(255,255,255,0.8)" stroke="none" />
          </svg>
        </div>
        <h3 className="opsdeck-empty-state__title">No objectives yet</h3>
        <p className="opsdeck-empty-state__desc">
          Start an objective from Agentic Teams to watch agents work in real-time.
        </p>
        <button
          className="opsdeck-empty-state__cta"
          onClick={() => navigate('/teams-overview')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255, 255, 255, 0.8)' }} strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          Go to Agentic Teams
        </button>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px', maxWidth: 600, margin: '0 auto', width: '100%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24,
        color: 'rgba(255,255,255,0.5)', fontSize: 12, fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
        letterSpacing: '0.05em', textTransform: 'uppercase',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.4)' }} strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        Recent Objectives
      </div>

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {recent.map(obj => (
          <button
            key={obj.id}
            onClick={() => navigate(`/opsdeck?objective=${obj.id}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 14px', background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6,
              cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}
          >
            <span style={{
              color: statusColor(obj.status), fontSize: 14, fontWeight: 600,
              width: 20, textAlign: 'center', flexShrink: 0,
            }}>
              {statusIcon(obj.status)}
            </span>
            <span style={{
              flex: 1, color: 'rgba(255,255,255,0.8)', fontSize: 13,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {obj.title}
            </span>
            <span style={{
              fontSize: 11, color: statusColor(obj.status), opacity: 0.8,
              fontFamily: "'SF Mono', monospace", flexShrink: 0,
            }}>
              {obj.status === 'completed_with_errors' ? 'partial' : obj.status}
            </span>
            {obj.task_count > 0 && (
              <span style={{
                fontSize: 10, color: 'rgba(255,255,255,0.35)',
                fontFamily: "'SF Mono', monospace", flexShrink: 0,
              }}>
                {obj.tasks_completed || 0}/{obj.task_count}
              </span>
            )}
            <span style={{
              fontSize: 10, color: 'rgba(255,255,255,0.3)',
              fontFamily: "'SF Mono', monospace", flexShrink: 0, minWidth: 50, textAlign: 'right',
            }}>
              {timeAgo(obj.completed_at || obj.updated_at || obj.created_at)}
            </span>
          </button>
        ))}
      </div>

      <button
        onClick={() => navigate('/teams-overview')}
        style={{
          marginTop: 24, display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 20px', borderRadius: 8,
          border: '1px solid rgba(99, 102, 241, 0.3)',
          background: 'rgba(99, 102, 241, 0.1)',
          color: '#818cf8', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          transition: 'background 0.15s, border-color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.2)'; e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.5)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.1)'; e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.3)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(129, 140, 248, 0.8)' }} strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New Objective
      </button>
    </div>
  )
}

export default function OpsDeckView({ embedded = false }) {
  const navigate = useNavigate()
  const licensed = isPluginLicensed('opsdeck')
  const state = useOpsDeckState()
  const [searchParams] = useSearchParams()
  const focusObjectiveId = searchParams.get('objective') || null
  const fromTeam = searchParams.get('from') === 'team'
  const fromTeamId = searchParams.get('teamId') || null
  const hasActivity = state.groups.length > 0

  // Wallboard mode
  const [wallboardMode, setWallboardMode] = useState(() => searchParams.get('wallboard') === '1')
  const [cursorHidden, setCursorHidden] = useState(false)

  const toggleWallboard = useCallback(() => {
    setWallboardMode(prev => {
      const next = !prev
      if (next) {
        document.documentElement.requestFullscreen?.().catch(() => {})
        const sidebar = document.querySelector('.app-shell__sidebar')
        const header = document.querySelector('.app-shell__header')
        if (sidebar) sidebar.style.display = 'none'
        if (header) header.style.display = 'none'
      } else {
        if (document.fullscreenElement) document.exitFullscreen?.()
        const sidebar = document.querySelector('.app-shell__sidebar')
        const header = document.querySelector('.app-shell__header')
        if (sidebar) sidebar.style.display = ''
        if (header) header.style.display = ''
      }
      return next
    })
  }, [])

  // Escape key exits wallboard
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && wallboardMode) {
        // Don't toggle — set directly to false. Browser also exits fullscreen on Escape,
        // so toggleWallboard() could race with fullscreenchange and flip back to true.
        setWallboardMode(false)
        const sidebar = document.querySelector('.app-shell__sidebar')
        const header = document.querySelector('.app-shell__header')
        if (sidebar) sidebar.style.display = ''
        if (header) header.style.display = ''
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wallboardMode, toggleWallboard])

  // Sync state if fullscreen is exited via browser UI
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && wallboardMode) {
        setWallboardMode(false)
        const sidebar = document.querySelector('.app-shell__sidebar')
        const header = document.querySelector('.app-shell__header')
        if (sidebar) sidebar.style.display = ''
        if (header) header.style.display = ''
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [wallboardMode])

  // Auto-hide cursor after 3s of no movement in wallboard mode
  useEffect(() => {
    if (!wallboardMode) { setCursorHidden(false); return }
    let timer
    const onMove = () => {
      setCursorHidden(false)
      clearTimeout(timer)
      timer = setTimeout(() => setCursorHidden(true), 3000)
    }
    window.addEventListener('mousemove', onMove)
    timer = setTimeout(() => setCursorHidden(true), 3000)
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(timer) }
  }, [wallboardMode])

  // Cleanup: restore sidebar/header and exit fullscreen on unmount
  useEffect(() => {
    return () => {
      const sidebar = document.querySelector('.app-shell__sidebar')
      const header = document.querySelector('.app-shell__header')
      if (sidebar) sidebar.style.display = ''
      if (header) header.style.display = ''
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [])

  if (!licensed) {
    return (
      <div className="opsdeck-view" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5" style={{ marginBottom: 16 }}>
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M12 22V12"/><path d="M22 7v10"/><path d="M2 7v10"/>
          </svg>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>OpsDeck</h2>
          <p style={{ color: 'var(--ui-text-secondary)', fontSize: 14, marginBottom: 20 }}>
            Watch your agents work in real-time with a live constellation view of all active objectives.
          </p>
          <button onClick={() => navigate('/settings#plugins')} style={{
            padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', fontWeight: 500, fontSize: 14
          }}>
            Activate Plugin — $8
          </button>
        </div>
      </div>
    )
  }

  const viewCls = ['opsdeck-view', wallboardMode && 'opsdeck-view--wallboard', cursorHidden && 'opsdeck-cursor-hidden'].filter(Boolean).join(' ')

  return (
    <div className={viewCls}>
      {/* Item 3: Suppress banner when embedded inside MissionControl */}
      {!embedded && <LLMAuthBanner />}
      {(focusObjectiveId || fromTeam) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
          fontSize: 12, color: 'var(--m-text-secondary, #a1a1aa)',
        }}>
          {fromTeam && fromTeamId ? (
            <>
              <button onClick={() => navigate(`/agentic-teams/${fromTeamId}`)} style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--m-text-secondary)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--m-text-primary, #f4f4f5)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--m-text-secondary, #a1a1aa)'}
              >
                ← Back to Team
              </button>
              <span style={{ opacity: 0.4 }}>|</span>
              <span>OpsDeck</span>
            </>
          ) : (
            <>
              <button onClick={() => navigate(-1)} style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--m-text-secondary)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--m-text-primary, #f4f4f5)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--m-text-secondary, #a1a1aa)'}
              >
                ← Back
              </button>
              <span style={{ opacity: 0.4 }}>|</span>
              <span>Watching objective</span>
            </>
          )}
        </div>
      )}
      <SystemPulseBar
        groups={state.groups}
        objectives={state.objectives}
        connectionState={state.connectionState}
        totalAgents={state.totalAgents}
        activeAgents={state.activeAgents}
        onToggleWallboard={toggleWallboard}
        isWallboard={wallboardMode}
        onClearCompleted={state.clearCompleted}
      />

      {/* EUX-5: Running objectives compact strip */}
      <RunningObjectivesWidget
        objectives={state.objectives}
        onNavigate={(id) => navigate(`/opsdeck?objective=${id}`)}
      />

      {hasActivity ? (
        <OpsDeckCanvas
          groups={state.groups}
          systemState={state.systemState}
          initialFocusId={focusObjectiveId}
          events={state.events}
          delegations={state.delegations}
          onToggleWallboard={toggleWallboard}
        />
      ) : (
        <div className="opsdeck-canvas" data-system-state="idle">
          <RecentHistory objectives={state.objectives} navigate={navigate} />
        </div>
      )}

      {/* Floating live event overlay — bottom-right, doesn't affect canvas layout */}
      {hasActivity && !wallboardMode && (state.events || []).length > 0 && (
        <div style={{
          position: 'absolute', bottom: 12, right: 12,
          width: 340, maxHeight: 260,
          background: 'rgba(6,7,12,0.92)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          overflow: 'hidden',
          zIndex: 50,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(8px)',
        }}>
          <CommandStream
            events={(state.events || []).map(evt => ({
              time: evt.ts ? new Date(evt.ts).toISOString() : new Date().toISOString(),
              level: evt.type?.includes('fail') ? 'error' : evt.type?.includes('complete') ? 'success' : evt.type?.includes('start') ? 'task' : evt.type?.includes('heartbeat') ? 'heartbeat' : 'info',
              source: evt.agentId || evt.agent || 'system',
              message: evt.title || evt.type || 'event',
            }))}
            maxVisible={6}
            variant="compact"
          />
        </div>
      )}
    </div>
  )
}
