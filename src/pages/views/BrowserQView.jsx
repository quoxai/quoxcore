/**
 * BrowserQView — BQ-6: Browser-Q Full Dashboard
 * Production-quality UI with real API calls to ScreenCap service.
 * Viewport-locked, tabbed layout with glassmorphic panels, cyan accent.
 * Follows ActionsView pattern: toolbar + content + collapsible sidebar.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import {
  listSessions,
  listSequences,
  listMonitors,
  listVideos,
  deleteSequence as apiDeleteSequence,
  replaySequence as apiReplaySequence,
  deleteMonitor as apiDeleteMonitor,
  checkMonitor as apiCheckMonitor,
  getMonitorHistory as apiGetMonitorHistory,
  deleteVideo as apiDeleteVideo,
  fetchDashboardStats,
  deleteGalleryScreenshot as apiDeleteGalleryScreenshot,
  keepGalleryScreenshot as apiKeepGalleryScreenshot,
  getGalleryImageUrl,
  listBrowserObjectives,
  listAgenticBrowserRuns,
  approveStep,
  getOrgSettings,
  saveOrgSettings,
  runAutomationApi,
  deleteAutomationApi,
  createAgenticBrowserRun,
} from '../../services/browserQService'
import BrowserQSidebar from '../../components/browser-q/BrowserQSidebar'
import AutomationWizard from '../../components/browser-q/AutomationWizard'
import ExtractionResultsPanel from '../../components/browser-q/ExtractionResultsPanel'
// VAULT-INTEG P17: SCREENCAP_SCHEDULE_HOURS is settable (registry group
// 'screencap') but had no page showing it. PlatformFlagsPanel is the shared
// write control from Settings — reusing the existing global settings/ui
// stylesheets (no new per-page CSS) to render it inside this tab.
import PlatformFlagsPanel from '../../components/settings/PlatformFlagsPanel'
import '../../components/settings/settings.css'
import '../../components/ui/ui.css'
import './browser-q-view.css'

const PLUGIN_NAME = 'browser-q'

// ─── Static Config (not data — these are UI constants) ───────────────

const STEP_ICONS = { navigate: '\u{1F310}', wait: '\u23F3', click: '\u{1F446}', scroll: '\u2193', extract: '\u{1F4E6}', screenshot: '\u{1F4F7}' }
const STEP_COLORS = { done: '#30ff90', active: '#38bdf8', pending: 'rgba(255,255,255,0.2)' }
const RISK_COLORS = { low: '#30ff90', medium: '#f59e0b', high: '#ef4444' }

// Extraction templates available via chat sidebar (browserExtraction.js has full implementations)

const POLICIES = [
  'Login \u2192 HITL required',
  'Payments \u2192 HITL + 2FA',
  'Read-only \u2192 Auto-approve',
  'Screenshots \u2192 Auto-approve',
  'Form submit \u2192 HITL required',
]

const USE_CASE_CHIPS = [
  'Monitor a website', 'Extract data', 'Download files', 'Fill a form', 'Screenshot a page',
]

// ─── Welcome Chips (functional — each maps to a chat prompt) ─────────

const WELCOME_CHIPS = [
  { label: 'Screenshot quox.ai', prompt: 'Navigate to https://quox.ai and take a screenshot' },
  { label: 'Monitor a website', prompt: 'Set up visual monitoring for https://quox.ai -- check every day for changes' },
  { label: 'Extract data from a page', prompt: 'Go to https://quox.ai/pricing and extract all pricing information' },
  { label: 'Fill a web form', prompt: 'Help me fill out a web form -- I\'ll tell you which site' },
  { label: 'Check SSL certificates', prompt: 'Navigate to https://quox.ai and check the SSL certificate details' },
  { label: 'Download invoices', prompt: 'Help me download invoices from a portal -- I\'ll provide the login details' },
]

// ─── How It Works Steps ──────────────────────────────────────────────

const HOW_IT_WORKS_STEPS = [
  'Click "New Automation" and describe what you need',
  'Browser-Q plans the steps and shows them for your approval',
  'Watch the automation run live with step-by-step progress',
  'Results appear here -- screenshots, data, recordings',
  'Sensitive actions (login, payment) always require your approval',
]

const TABS = [
  { id: 'runs', label: 'Runs' },
  { id: 'library', label: 'Library' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'security', label: 'Security' },
]

// ─── Skeleton Loader ─────────────────────────────────────────────────

function Skeleton({ width, height = 16, style }) {
  return (
    <div
      className="bqv-skeleton"
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: `${height}px`,
        borderRadius: 4,
        background: 'rgba(255,255,255,0.06)',
        animation: 'bqv-pulse 1.5s ease-in-out infinite',
        ...style
      }}
    />
  )
}

function SkeletonRows({ count = 4, height = 32 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width="100%" height={height} />
      ))}
    </div>
  )
}

// ─── Error Banner ────────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="bqv-error-banner">
      <span style={{ opacity: 0.8 }}>{'\u26A0'} {message}</span>
      {onRetry && (
        <button className="bqv-error-banner__retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}

// ─── Empty State ─────────────────────────────────────────────────────

function EmptyState({ icon, text, sub }) {
  return (
    <div className="bqv-tab-empty">
      <div className="bqv-tab-empty__icon">{icon}</div>
      <div className="bqv-tab-empty__text">{text}</div>
      {sub && <div className="bqv-tab-empty__sub">{sub}</div>}
    </div>
  )
}

// ─── Welcome State (replaces empty sessions for first-use) ──────────

function WelcomeState({ onChipClick, onNewAutomation }) {
  // W2-7: Hide "How it works" permanently after first successful automation
  const [howExpanded, setHowExpanded] = useState(() => {
    try {
      if (localStorage.getItem('bqv-first-automation-done')) return false
      return !localStorage.getItem('bqv-how-it-works-seen')
    } catch { return true }
  })

  const toggleHow = useCallback(() => {
    setHowExpanded(v => {
      if (!v === false) {
        try { localStorage.setItem('bqv-how-it-works-seen', '1') } catch {}
      }
      return !v
    })
  }, [])

  return (
    <div className="bqv-welcome">
      <div className="bqv-welcome__card">
        {/* Globe icon */}
        <div className="bqv-welcome__icon-wrap">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#06b6d4' }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>

        <h2 className="bqv-welcome__title">Welcome to Browser-Q</h2>

        <p className="bqv-welcome__desc">
          Browser-Q navigates websites for you -- extracting data, filling forms,
          monitoring changes, and automating repetitive web tasks.
        </p>

        <div className="bqv-welcome__safety">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#10b981' }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>
            Everything runs in a secure sandbox. Login actions require your approval. All activity is logged with evidence.
          </span>
        </div>

        {/* Primary CTA: New Automation Wizard */}
        {onNewAutomation && (
          <button
            className="bqw-new-btn bqw-new-btn--welcome"
            onClick={() => onNewAutomation()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Automation
          </button>
        )}

        <div className="bqv-welcome__try-label">Or try a quick start:</div>

        <div className="bqv-welcome__chips">
          {WELCOME_CHIPS.map((chip, i) => (
            <button
              key={i}
              className="bqv-welcome__chip"
              onClick={() => onNewAutomation ? onNewAutomation(chip.prompt) : onChipClick(chip.prompt)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="bqv-welcome__sidebar-hint">
          Or ask Browser-Q anything in the sidebar {'\u2192'}
        </div>
      </div>

      {/* How it works (collapsible) */}
      <div className="bqv-how">
        <button className="bqv-how__toggle" onClick={toggleHow}>
          <span className="bqv-how__arrow">{howExpanded ? '\u25BE' : '\u25B8'}</span>
          How it works
        </button>
        {howExpanded && (
          <ol className="bqv-how__steps">
            {HOW_IT_WORKS_STEPS.map((step, i) => (
              <li key={i} className="bqv-how__step">{step}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

// ─── Safety Indicator (header bar) ──────────────────────────────────

function SafetyIndicator() {
  return (
    <div className="bqv-safety">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: '#10b981' }}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
      <span className="bqv-safety__label">Sandbox mode</span>
      <span className="bqv-safety__sep">{'\u00B7'}</span>
      <span className="bqv-safety__hint">Logins require approval</span>
    </div>
  )
}

// ─── Time Formatting ─────────────────────────────────────────────────

function timeAgo(isoString) {
  if (!isoString) return 'never'
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s'
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Active Sessions Panel ───────────────────────────────────────────

function ActiveSessions({ sessions, loading, error, onRetry, isFirstUse, onChipClick, onNewAutomation }) {
  if (loading) {
    return (
      <div className="bqv-sessions">
        <div className="bqv-sessions__label">ACTIVE SESSIONS</div>
        <div className="bqv-sessions__grid">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} width="100%" height={120} style={{ borderRadius: 8 }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bqv-sessions">
        <div className="bqv-sessions__label">ACTIVE SESSIONS</div>
        <ErrorBanner message={error} onRetry={onRetry} />
      </div>
    )
  }

  // First use: show full welcome state instead of empty sessions + dead chips
  if ((!sessions || sessions.length === 0) && isFirstUse) {
    return <WelcomeState onChipClick={onChipClick} onNewAutomation={onNewAutomation} />
  }

  // Has data elsewhere but no active sessions: simpler empty
  if (!sessions || sessions.length === 0) {
    return (
      <div className="bqv-sessions">
        <div className="bqv-sessions__label">ACTIVE SESSIONS</div>
        <div className="bqv-sessions-empty">
          <div className="bqv-sessions-empty__text">No active sessions right now</div>
          <div className="bqv-sessions-empty__sub">Start a new session from the sidebar chat, or click a chip below.</div>
          <div className="bqv-sessions-empty__chips">
            {WELCOME_CHIPS.slice(0, 3).map((chip, i) => (
              <button key={i} className="bqv-sessions-empty__chip" onClick={() => onChipClick(chip.prompt)}>{chip.label}</button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Assign colours based on session index
  const SESSION_COLORS = ['#38bdf8', '#ef4444', '#a855f7', '#f59e0b', '#10b981']
  const SESSION_GRADIENTS = [
    'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, #161b22 50%, #21262d 100%)',
    'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, #2d1b2e 50%, rgba(255,255,255,0.05) 100%)',
    'linear-gradient(135deg, #1a1022 0%, #2d1b3e 50%, #1a1022 100%)',
    'linear-gradient(135deg, #1a1a10 0%, #2d2a1b 50%, #1a1a10 100%)',
    'linear-gradient(135deg, #0d1a17 0%, #162218 50%, #0d1a17 100%)',
  ]

  return (
    <div className="bqv-sessions">
      <div className="bqv-sessions__label">ACTIVE SESSIONS</div>
      <div className="bqv-sessions__grid">
        {sessions.map((s, idx) => {
          const color = SESSION_COLORS[idx % SESSION_COLORS.length]
          const gradient = SESSION_GRADIENTS[idx % SESSION_GRADIENTS.length]
          const isActive = s.idle_ms < 60000
          const title = s.url && s.url !== 'about:blank' ? s.url : `Session ${s.session_id}`
          const domain = (() => {
            try { return new URL(s.url).hostname } catch { return s.session_id }
          })()
          return (
            <div key={s.session_id} className={`bqv-session-card ${isActive ? 'bqv-session-card--active' : ''}`}>
              <div className="bqv-session-card__preview" style={{ background: gradient }}>
                <span className="bqv-session-card__preview-text">
                  {isActive ? 'LIVE' : 'IDLE'}
                </span>
              </div>
              <div className="bqv-session-card__header">
                <span className="bqv-session-card__title">{domain}</span>
                <span className={`bqv-session-card__status bqv-session-card__status--${isActive ? 'active' : 'paused'}`}>
                  {isActive ? 'active' : 'idle'}
                </span>
              </div>
              <div className="bqv-session-card__url">{title}</div>
              <div className="bqv-session-card__stats">
                <span>Age: {formatDuration(s.age_ms)}</span>
                <span>Idle: {formatDuration(s.idle_ms)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Tab: Overview ───────────────────────────────────────────────────

function OverviewTab({ sessions, sequences, monitors, videos, loading, error, onRetry, onReplay, replayingId }) {
  const activeSessions = sessions.filter(s => s.idle_ms < 60000).length

  if (loading) {
    return (
      <div>
        <div className="bqv-stats-grid">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} width="100%" height={60} style={{ borderRadius: 8 }} />)}
        </div>
        <div className="bqv-panel">
          <div className="bqv-panel__label">RECENT ACTIVITY</div>
          <SkeletonRows count={5} />
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />
  }

  return (
    <div>
      {/* Quick Stats */}
      <div className="bqv-stats-grid">
        {[
          { label: 'Active Sessions', value: String(sessions.length), color: '#3b82f6' },
          { label: 'Saved Sequences', value: String(sequences.length), color: '#f59e0b' },
          { label: 'Monitors', value: String(monitors.length), color: '#30ff90' },
          { label: 'Videos', value: String(videos.length), color: '#a855f7' },
        ].map((m, i) => (
          <div key={i} className="bqv-stats-card">
            <div className="bqv-stats-card__value" style={{ color: m.color }}>{m.value}</div>
            <div className="bqv-stats-card__label">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Active Sessions Summary */}
      {sessions.length > 0 && (
        <div className="bqv-panel">
          <div className="bqv-panel__label">ACTIVE SESSIONS</div>
          {sessions.map((s, i) => {
            const domain = (() => {
              try { return new URL(s.url).hostname } catch { return s.session_id }
            })()
            return (
              <div key={s.session_id} className="bqv-recent-row">
                <div className="bqv-recent-row__dot" style={{ background: s.idle_ms < 60000 ? '#30ff90' : '#f59e0b' }} />
                <span className="bqv-recent-row__session" style={{ color: s.idle_ms < 60000 ? '#30ff90' : '#f59e0b' }}>
                  {domain}
                </span>
                <span className="bqv-recent-row__action">{s.url}</span>
                <span className="bqv-recent-row__time">{timeAgo(s.last_action_at)}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Saved Sequences */}
      <div className="bqv-panel">
        <div className="bqv-panel__label">SAVED SEQUENCES</div>
        {sequences.length === 0 ? (
          <div style={{ padding: '12px 0', color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>No saved sequences yet. Record browser actions in chat to create reusable automations.</div>
        ) : (
          <div className="bqv-sequences-list">
            {sequences.map(seq => (
              <div key={seq.id} className="bqv-sequence-item">
                <span style={{ fontSize: 12, opacity: 0.6 }}>{'\u{23FA}\uFE0F'}</span>
                <span className="bqv-sequence-item__name">{seq.name}</span>
                <span className="bqv-sequence-item__steps">{seq.steps_count} steps</span>
                <span className="bqv-sequence-item__steps">{timeAgo(seq.created_at)}</span>
                <button
                  className="bqv-sequence-item__replay"
                  onClick={() => onReplay(seq.id)}
                  disabled={replayingId === seq.id}
                >
                  {replayingId === seq.id ? 'Running...' : `${'\u25B6'} Replay`}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer Stats */}
      <div className="bqv-footer-bar">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''} &nbsp;{'\u2502'}&nbsp;
        {activeSessions} active &nbsp;{'\u2502'}&nbsp;
        {sequences.length} sequence{sequences.length !== 1 ? 's' : ''} &nbsp;{'\u2502'}&nbsp;
        {videos.length} video{videos.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

// ─── Tab: Runs (Objective History) ───────────────────────────────────

function RunsTab({ authFetch, orgId, onNewAutomation, objectives: parentObjectives, loading: parentLoading, onRefresh }) {
  const runsNavigate = useNavigate()
  const objectives = parentObjectives || []
  const [expanded, setExpanded] = useState(null)
  const [approvingStep, setApprovingStep] = useState(null)
  const [quickUrl, setQuickUrl] = useState('')
  const [quickCapturing, setQuickCapturing] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(15)

  // No more independent fetching — objectives come from parent fetchDashboardStats

  if (parentLoading) {
    return <div className="bqv-panel"><div className="bqv-panel__label">RECENT RUNS</div><SkeletonRows count={5} /></div>
  }

  if (objectives.length === 0) {
    return (
      <EmptyState
        icon={'\u{1F680}'}
        text="No automation runs yet"
        sub="Click New Automation to start your first run. Results, screenshots, and step history will appear here."
      />
    )
  }

  const STATUS_COLORS = { completed: '#30ff90', failed: '#ef4444', running: '#38bdf8', paused: '#f59e0b', created: 'rgba(255,255,255,0.6)', planned: '#a855f7', cancelled: 'rgba(255,255,255,0.6)' }

  const handleQuickCapture = async (e) => {
    e.preventDefault()
    const url = quickUrl.trim()
    if (!url) return
    setQuickCapturing(true)
    try {
      // QE2: Use agentic QuoxFlow execution
      try {
        const result = await createAgenticBrowserRun(`Screenshot and extract content from ${url}`, url)
        if (result?.executionId) {
          setQuickUrl('')
          runsNavigate(`/executions/${result.executionId}`)
          return
        }
      } catch (agenticErr) {
        console.warn('[BQ] Agentic flow failed, falling back to legacy:', agenticErr.message)
      }

      // Legacy fallback: screencap objective flow
      const createRes = await fetch(`/screencap/api/browser-objectives?org_id=${encodeURIComponent(orgId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, intent: `Screenshot ${url}`, org_id: orgId }),
      })
      const { objective: obj } = await createRes.json()
      if (obj) {
        await fetch(`/screencap/api/browser-objectives/${obj.id}/plan?org_id=${encodeURIComponent(orgId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        await fetch(`/screencap/api/browser-objectives/${obj.id}/execute?org_id=${encodeURIComponent(orgId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: `quick_${obj.id}` }),
        })
        setQuickUrl('')
        onRefresh?.()
        runsNavigate(`/browser-q/run/${obj.id}`)
      }
    } catch (err) {
      console.error('Quick capture failed:', err)
    } finally {
      setQuickCapturing(false)
    }
  }

  return (
    <div>
      {/* Quick-capture bar */}
      <form onSubmit={handleQuickCapture} style={{
        display: 'flex', gap: 6, marginBottom: 12,
      }}>
        <input
          type="url"
          value={quickUrl}
          onChange={e => setQuickUrl(e.target.value)}
          placeholder="Paste a URL and hit Enter for a quick screenshot..."
          disabled={quickCapturing}
          style={{
            flex: 1, padding: '8px 14px', borderRadius: 10, fontSize: 13,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff', outline: 'none',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        <button
          type="submit"
          disabled={!quickUrl.trim() || quickCapturing}
          style={{
            padding: '8px 16px', borderRadius: 10, fontSize: 12, fontWeight: 600,
            cursor: quickUrl.trim() && !quickCapturing ? 'pointer' : 'not-allowed',
            background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.3)',
            color: '#06b6d4', opacity: quickUrl.trim() ? 1 : 0.5,
          }}
        >
          {quickCapturing ? 'Capturing...' : '\u{1F4F7} Capture'}
        </button>
      </form>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by intent or URL..."
          style={{
            flex: 1, padding: '6px 12px', borderRadius: 8, fontSize: 12,
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#fff', outline: 'none', fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        {['all', 'completed', 'running', 'paused', 'failed'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
              cursor: 'pointer', border: 'none', textTransform: 'capitalize',
              color: statusFilter === s ? '#fff' : 'rgba(255,255,255,0.6)',
              background: statusFilter === s
                ? 'linear-gradient(145deg, rgba(168,85,247,0.12) 0%, rgba(56,189,248,0.06) 100%)'
                : 'rgba(255,255,255,0.03)',
              transition: 'all 0.2s ease',
            }}
          >
            {s === 'all' ? 'All' : s}
          </button>
        ))}
      </div>

      <div className="bqv-panel">
        {(() => {
          const query = searchQuery.toLowerCase().trim()
          const filtered = objectives.filter(obj => {
            if (statusFilter !== 'all' && obj.status !== statusFilter) return false
            if (query && !(obj.intent || '').toLowerCase().includes(query) && !(obj.url || '').toLowerCase().includes(query)) return false
            return true
          })
          return (
            <>
        <div className="bqv-panel__label">RUNS ({filtered.length}{filtered.length !== objectives.length ? ` of ${objectives.length}` : ''})</div>
        {filtered.slice(0, visibleCount).map(obj => {
          const isExpanded = expanded === obj.id
          const steps = obj.steps || []
          const doneSteps = steps.filter(s => s.status === 'done').length
          const screenshots = obj.screenshots || []
          const statusColor = STATUS_COLORS[obj.status] || 'rgba(255,255,255,0.6)'

          return (
            <div key={obj.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div
                className="bqv-recent-row"
                style={{ cursor: 'pointer', padding: '10px 0' }}
                onClick={() => runsNavigate(`/browser-q/run/${obj.id}`)}
              >
                <div className="bqv-recent-row__dot" style={{ background: statusColor }} />
                <span style={{ flex: 1, fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>
                  {obj.intent || obj.url || 'Untitled'}
                </span>
                <span style={{
                  fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px',
                  color: statusColor, fontWeight: 600, marginRight: 8
                }}>
                  {obj.status}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', minWidth: 50, textAlign: 'right' }}>
                  {doneSteps}/{steps.length}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginLeft: 8, minWidth: 50, textAlign: 'right' }}>
                  {timeAgo(obj.completed_at || obj.created_at)}
                </span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginLeft: 6 }}>{isExpanded ? '\u25BE' : '\u25B8'}</span>
              </div>

              {isExpanded && (
                <div style={{ padding: '4px 0 12px 20px' }}>
                  {/* URL */}
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 6, fontFamily: 'monospace' }}>
                    {obj.url}
                  </div>

                  {/* Steps */}
                  {steps.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      {steps.map((s, i) => (
                        <div key={s.id || i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12 }}>
                          <span style={{
                            color: s.status === 'done' || s.status === 'completed' ? '#30ff90'
                              : s.status === 'failed' ? '#ef4444'
                              : s.status === 'awaiting_approval' ? '#f59e0b'
                              : s.status === 'running' ? '#06b6d4'
                              : 'rgba(255,255,255,0.6)'
                          }}>
                            {s.status === 'done' || s.status === 'completed' ? '\u2713'
                              : s.status === 'failed' ? '\u2717'
                              : s.status === 'awaiting_approval' ? '\u23F8'
                              : s.status === 'running' ? '\u25B6'
                              : '\u25CB'}
                          </span>
                          <span style={{ color: 'rgba(255,255,255,0.6)', flex: 1 }}>{s.description || s.action}</span>
                          {s.status === 'awaiting_approval' && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation()
                                setApprovingStep(s.id)
                                try {
                                  await approveStep(authFetch, obj.id, s.id, orgId)
                                  onRefresh?.()
                                } catch (err) {
                                  console.error('Approve failed:', err)
                                } finally {
                                  setApprovingStep(null)
                                }
                              }}
                              disabled={approvingStep === s.id}
                              style={{
                                background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)',
                                color: '#10b981', padding: '2px 10px', borderRadius: 4, fontSize: 11,
                                fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                              }}
                            >
                              {approvingStep === s.id ? 'Approving...' : '\u2713 Approve'}
                            </button>
                          )}
                          {s.elapsed_ms != null && (
                            <span style={{ color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', fontSize: 10 }}>
                              {formatDuration(s.elapsed_ms)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Screenshots */}
                  {screenshots.length > 0 && orgId && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {screenshots.map((ssId, i) => (
                        <a
                          key={ssId}
                          href={getGalleryImageUrl(orgId, ssId, 'full')}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ display: 'block', borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                          <img
                            src={getGalleryImageUrl(orgId, ssId, 'thumb')}
                            alt={`Screenshot ${i + 1}`}
                            style={{ display: 'block', width: 120, height: 75, objectFit: 'cover', background: 'rgba(0,0,0,0.3)' }}
                            onError={e => { e.target.style.display = 'none' }}
                          />
                        </a>
                      ))}
                    </div>
                  )}

                  {/* Elapsed */}
                  {obj.elapsed_ms && (
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 6, fontFamily: 'monospace' }}>
                      Total: {formatDuration(obj.elapsed_ms)}
                    </div>
                  )}

                  {/* Action bar */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {(obj.status === 'running' || obj.status === 'paused') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); /* LiveSessionViewer would go here — for now just scroll to sidebar */ }}
                        style={{
                          background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)',
                          color: '#06b6d4', padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {'\u25B6'} Watch Live
                      </button>
                    )}
                    {obj.status === 'completed' && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            const newObj = await fetch(`/screencap/api/browser-objectives?org_id=${encodeURIComponent(orgId)}`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ url: obj.url, intent: obj.intent, org_id: orgId, needs_login: obj.needs_login, credential_id: obj.credential_id }),
                            }).then(r => r.json())
                            if (newObj.objective) {
                              await fetch(`/screencap/api/browser-objectives/${newObj.objective.id}/plan?org_id=${encodeURIComponent(orgId)}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ steps: obj.steps?.map(s => ({ action: s.action, description: s.description, params: s.params, needs_hitl: s.needs_hitl })) }),
                              })
                              await fetch(`/screencap/api/browser-objectives/${newObj.objective.id}/execute?org_id=${encodeURIComponent(orgId)}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ session_id: `rerun_${newObj.objective.id}` }),
                              })
                              onRefresh?.()
                            }
                          } catch (err) { console.error('Rerun failed:', err) }
                        }}
                        style={{
                          background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
                          color: '#10b981', padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {'\u21BB'} Rerun
                      </button>
                    )}
                    {obj.status === 'completed' && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            await fetch(`/screencap/api/browser-objectives/${obj.id}/save-sequence?org_id=${encodeURIComponent(orgId)}`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                            })
                            onRefresh?.()
                          } catch (err) { console.error('Save failed:', err) }
                        }}
                        style={{
                          background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.25)',
                          color: '#a855f7', padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {'\u{1F4BE}'} Save as Automation
                      </button>
                    )}
                    {(obj.status === 'failed' || obj.status === 'cancelled') && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          try {
                            const newObj = await fetch(`/screencap/api/browser-objectives?org_id=${encodeURIComponent(orgId)}`, {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ url: obj.url, intent: obj.intent, org_id: orgId }),
                            }).then(r => r.json())
                            if (newObj.objective) {
                              await fetch(`/screencap/api/browser-objectives/${newObj.objective.id}/plan?org_id=${encodeURIComponent(orgId)}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                              })
                              await fetch(`/screencap/api/browser-objectives/${newObj.objective.id}/execute?org_id=${encodeURIComponent(orgId)}`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ session_id: `retry_${newObj.objective.id}` }),
                              })
                              onRefresh?.()
                            }
                          } catch (err) { console.error('Retry failed:', err) }
                        }}
                        style={{
                          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)',
                          color: '#f59e0b', padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {'\u21BB'} Retry
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {filtered.length > visibleCount && (
          <button
            onClick={() => setVisibleCount(prev => prev + 15)}
            style={{
              width: '100%', padding: '8px', borderRadius: 8, marginTop: 8,
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600,
            }}
          >
            Show more ({filtered.length - visibleCount} remaining)
          </button>
        )}
            </>
          )
        })()}
      </div>
    </div>
  )
}

// ─── Tab: Recorder ───────────────────────────────────────────────────

function RecorderTab({ sequences, loading, error, onRetry, orgId, authFetch, onRefresh }) {
  const [replayingId, setReplayingId] = useState(null)
  const [replayResult, setReplayResult] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const handleReplay = useCallback(async (seqId) => {
    setReplayingId(seqId)
    setReplayResult(null)
    try {
      const result = await apiReplaySequence(authFetch, orgId, seqId)
      setReplayResult(result)
    } catch (err) {
      setReplayResult({ success: false, error: err.message })
    } finally {
      setReplayingId(null)
    }
  }, [authFetch, orgId])

  const handleDelete = useCallback(async (seqId) => {
    if (!confirm('Delete this sequence?')) return
    setDeletingId(seqId)
    try {
      await apiDeleteSequence(authFetch, orgId, seqId)
      onRefresh()
    } catch (err) {
      console.error('Failed to delete sequence:', err)
    } finally {
      setDeletingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  if (loading) {
    return (
      <div>
        <div className="bqv-recorder-header">
          <Skeleton width={200} height={20} />
        </div>
        <div className="bqv-panel" style={{ marginTop: 12 }}>
          <div className="bqv-panel__label">SEQUENCE LIBRARY</div>
          <SkeletonRows count={3} />
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />
  }

  return (
    <div>
      <div className="bqv-recorder-header">
        <div className="bqv-recorder-header__info">
          <span style={{ fontSize: 16 }}>{'\u{23FA}\uFE0F'}</span>
          <div>
            <div className="bqv-recorder-header__title">Automation Recorder</div>
            <div className="bqv-recorder-header__sub">
              Record browser actions via chat commands. Use "record my actions" to start.
            </div>
          </div>
        </div>
      </div>

      {/* Replay Result */}
      {replayResult && (
        <div className="bqv-panel" style={{ marginTop: 8, borderTopColor: replayResult.success ? 'rgba(48,255,144,0.2)' : 'rgba(239,68,68,0.2)' }}>
          <div className="bqv-panel__label" style={{ color: replayResult.success ? '#30ff90' : '#ef4444' }}>
            {replayResult.success ? 'REPLAY COMPLETE' : 'REPLAY FAILED'}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, padding: '4px 0' }}>
            {replayResult.success
              ? `${replayResult.steps_completed}/${replayResult.steps_total} steps completed${replayResult.healed_steps?.length ? `, ${replayResult.healed_steps.length} self-healed` : ''}`
              : replayResult.error}
          </div>
        </div>
      )}

      {/* Sequence Library */}
      <div className="bqv-panel" style={{ marginTop: 12 }}>
        <div className="bqv-panel__label">SEQUENCE LIBRARY ({sequences.length})</div>
        {sequences.length === 0 ? (
          <EmptyState
            icon={'\u{23FA}\uFE0F'}
            text="No saved automations yet"
            sub="Ask Browser-Q to navigate a site, then say 'start recording' to capture a reusable sequence."
          />
        ) : (
          <div className="bqv-sequences-list">
            {sequences.map(seq => (
              <div key={seq.id} className="bqv-sequence-item">
                <span style={{ fontSize: 12, opacity: 0.6 }}>{'\u{23FA}\uFE0F'}</span>
                <span className="bqv-sequence-item__name">{seq.name}</span>
                <span className="bqv-sequence-item__steps">{seq.steps_count} steps</span>
                <span className="bqv-sequence-item__steps">{seq.description || ''}</span>
                <span className="bqv-sequence-item__steps">{timeAgo(seq.created_at)}</span>
                <button
                  className="bqv-sequence-item__replay"
                  onClick={() => handleReplay(seq.id)}
                  disabled={replayingId === seq.id}
                >
                  {replayingId === seq.id ? 'Running...' : `${'\u25B6'} Replay`}
                </button>
                <button
                  className="bqv-sequence-item__replay"
                  style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.2)' }}
                  onClick={() => handleDelete(seq.id)}
                  disabled={deletingId === seq.id}
                >
                  {deletingId === seq.id ? '...' : '\u2715'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab: Extraction ─────────────────────────────────────────────────

// ─── Tab: Monitoring ─────────────────────────────────────────────────

function MonitoringTab({ monitors, loading, error, onRetry, orgId, authFetch, onRefresh }) {
  const [checkingId, setCheckingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const handleCheck = useCallback(async (monitorId) => {
    setCheckingId(monitorId)
    try {
      await apiCheckMonitor(authFetch, orgId, monitorId)
      onRefresh()
    } catch (err) {
      console.error('Monitor check failed:', err)
    } finally {
      setCheckingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  const handleDelete = useCallback(async (monitorId) => {
    if (!confirm('Delete this monitor?')) return
    setDeletingId(monitorId)
    try {
      await apiDeleteMonitor(authFetch, orgId, monitorId)
      onRefresh()
    } catch (err) {
      console.error('Monitor delete failed:', err)
    } finally {
      setDeletingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  if (loading) {
    return (
      <div>
        <div className="bqv-panel">
          <div className="bqv-panel__label">VISUAL MONITORS</div>
          <SkeletonRows count={3} height={48} />
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />
  }

  return (
    <div>
      <div className="bqv-panel">
        <div className="bqv-panel__label">VISUAL MONITORS ({monitors.length})</div>
        {monitors.length === 0 ? (
          <EmptyState
            icon={'\u{1F4F7}'}
            text="No monitors set up"
            sub="Ask Browser-Q to 'monitor [URL] for visual changes every day' to get started."
          />
        ) : (
          monitors.map(m => {
            const lastResult = m.last_result
            const diffPct = lastResult?.diff_percentage ?? 0
            const diffColor = diffPct > 0 ? '#f59e0b' : '#30ff90'
            const statusLabel = m.status === 'active' ? (lastResult?.changed ? 'changed' : 'ok') : m.status
            const statusBg = statusLabel === 'changed' ? 'rgba(245,158,11,0.1)' : 'rgba(48,255,144,0.1)'
            const statusColor = statusLabel === 'changed' ? '#f59e0b' : '#30ff90'
            return (
              <div key={m.monitorId} className="bqv-monitor-card">
                <div className="bqv-monitor-card__thumb">
                  <span style={{ opacity: 0.6 }}>{'\u{1F4F7}'}</span>
                </div>
                <div className="bqv-monitor-card__info">
                  <div className="bqv-monitor-card__url">{m.name || m.url}</div>
                  <div className="bqv-monitor-card__meta">
                    <span>{m.url}</span>
                    <span>Last: {timeAgo(m.last_checked_at)}</span>
                    <span>Checks: {m.check_count}</span>
                  </div>
                </div>
                <span className="bqv-monitor-card__diff" style={{ color: diffColor }}>
                  {diffPct.toFixed(1)}% diff
                </span>
                <span className="bqv-monitor-card__status" style={{ background: statusBg, color: statusColor }}>
                  {statusLabel}
                </span>
                <button
                  className="bqv-sequence-item__replay"
                  onClick={() => handleCheck(m.monitorId)}
                  disabled={checkingId === m.monitorId}
                  style={{ marginLeft: 4 }}
                >
                  {checkingId === m.monitorId ? '...' : '\u21BB Check'}
                </button>
                <button
                  className="bqv-sequence-item__replay"
                  style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.2)', marginLeft: 4 }}
                  onClick={() => handleDelete(m.monitorId)}
                  disabled={deletingId === m.monitorId}
                >
                  {deletingId === m.monitorId ? '...' : '\u2715'}
                </button>
              </div>
            )
          })
        )}
      </div>

      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', padding: '8px 12px' }}>
        Create monitors via chat. Monitors run on a cron schedule and detect visual changes above the configured threshold.
      </div>
    </div>
  )
}

// ─── Tab: Security ───────────────────────────────────────────────────

function SecurityTab({ sessions, loading, authFetch, orgId }) {
  const [allowedDomains, setAllowedDomains] = useState([])
  const [newDomain, setNewDomain] = useState('')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [learnedData, setLearnedData] = useState(null)
  const [auditLog, setAuditLog] = useState({ entries: [], stats: null, total: 0 })

  // BQF: Load domain allowlist from backend (with localStorage fallback for migration)
  useEffect(() => {
    if (!authFetch || !orgId) return
    getOrgSettings(authFetch, orgId).then(settings => {
      if (settings.allowed_domains && settings.allowed_domains.length > 0) {
        setAllowedDomains(settings.allowed_domains)
      } else {
        // Migrate from localStorage if backend is empty
        try {
          const saved = localStorage.getItem('bqv-allowed-domains')
          const local = saved ? JSON.parse(saved) : ['github.com', 'console.hetzner.cloud', 'dashboard.stripe.com', 'app.cloudflare.com', 'aws.amazon.com']
          setAllowedDomains(local)
          // Persist to backend
          saveOrgSettings(authFetch, orgId, { allowed_domains: local }).catch(() => {})
        } catch {
          setAllowedDomains(['github.com', 'console.hetzner.cloud', 'dashboard.stripe.com'])
        }
      }
      setSettingsLoaded(true)
    })
    // Fetch audit log
    fetch(`/screencap/api/browser-q/audit-log?org_id=${encodeURIComponent(orgId || 'default')}&limit=50`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.success) setAuditLog(data) })
      .catch(() => {})
    // Fetch learned patterns
    fetch(`/screencap/api/browser-q/learned?org_id=${encodeURIComponent(orgId || 'default')}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.success) setLearnedData(data) })
      .catch(() => {})
  }, [authFetch, orgId])

  const persistDomains = useCallback((updated) => {
    setAllowedDomains(updated)
    localStorage.setItem('bqv-allowed-domains', JSON.stringify(updated))
    if (authFetch && orgId) {
      saveOrgSettings(authFetch, orgId, { allowed_domains: updated }).catch(() => {})
    }
  }, [authFetch, orgId])

  const addDomain = useCallback(() => {
    const d = newDomain.trim().toLowerCase()
    if (!d || allowedDomains.includes(d)) return
    persistDomains([...allowedDomains, d])
    setNewDomain('')
  }, [newDomain, allowedDomains, persistDomains])

  const removeDomain = useCallback((domain) => {
    persistDomains(allowedDomains.filter(d => d !== domain))
  }, [allowedDomains, persistDomains])

  return (
    <div>
      {/* Active Policies */}
      <div className="bqv-panel" style={{ borderTopColor: 'rgba(16,185,129,0.12)' }}>
        <div className="bqv-panel__label">ACTIVE POLICIES</div>
        <div className="bqv-policies">
          {POLICIES.map((p, i) => (
            <span key={i} className="bqv-policy-pill">{p}</span>
          ))}
        </div>
      </div>

      {/* Session Security Stats */}
      <div className="bqv-stats-grid">
        {[
          { label: 'Active Sessions', value: String(sessions.length), color: '#3b82f6' },
          { label: 'Policies Active', value: String(POLICIES.length), color: '#30ff90' },
          { label: 'Allowed Domains', value: String(allowedDomains.length), color: '#f59e0b' },
          { label: 'Audit Entries', value: String(auditLog.total), color: '#a855f7' },
        ].map((m, i) => (
          <div key={i} className="bqv-stats-card">
            <div className="bqv-stats-card__value" style={{ color: m.color }}>{m.value}</div>
            <div className="bqv-stats-card__label">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Audit Log */}
      <div className="bqv-panel">
        <div className="bqv-panel__label">AUDIT LOG (VOLT-WITNESSED) {auditLog.total > 0 && <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 400 }}>({auditLog.total} total)</span>}</div>
        {auditLog.entries.length === 0 ? (
          <div style={{ padding: '12px 0', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            No actions logged yet. Audit entries are created when Browser-Q performs login, form submission, or high-risk actions.
          </div>
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {auditLog.entries.map((entry, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                  background: entry.risk === 'high' ? 'rgba(239,68,68,0.15)' : entry.risk === 'medium' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                  color: entry.risk === 'high' ? '#ef4444' : entry.risk === 'medium' ? '#f59e0b' : '#10b981',
                }}>{entry.risk || 'low'}</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1 }}>{entry.action}</span>
                <span style={{ color: 'rgba(6,182,212,0.6)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.url || ''}</span>
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10 }}>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Learned Patterns (Q3) */}
      <div className="bqv-panel" style={{ marginTop: 10 }}>
        <div className="bqv-panel__label">
          SITE INTELLIGENCE {learnedData?.total_domains > 0 && <span style={{ opacity: 0.6, fontWeight: 400 }}>({learnedData.total_domains} sites learned)</span>}
        </div>
        {!learnedData || learnedData.total_domains === 0 ? (
          <div style={{ padding: '12px 0', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            No site patterns learned yet. BrowserQ learns from successful runs — repeat visits will be faster and more accurate.
          </div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {learnedData.domains.map((domain, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{domain.domain}</span>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
                    background: domain.confidence >= 0.9 ? 'rgba(48,255,144,0.12)' : domain.confidence >= 0.7 ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.06)',
                    color: domain.confidence >= 0.9 ? '#30ff90' : domain.confidence >= 0.7 ? '#38bdf8' : 'rgba(255,255,255,0.6)',
                  }}>
                    {Math.round(domain.confidence * 100)}% confidence
                  </span>
                  {domain.stats && (
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {domain.stats.successful_runs}/{domain.stats.total_runs} runs
                      {domain.stats.avg_duration_ms > 0 ? ` \u2022 avg ${(domain.stats.avg_duration_ms / 1000).toFixed(1)}s` : ''}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {domain.patterns.map((p, j) => (
                    <span key={j} style={{
                      fontSize: 9, padding: '2px 6px', borderRadius: 4,
                      background: p.type === 'login_success' ? 'rgba(168,85,247,0.1)' : p.type === 'form_structure' ? 'rgba(6,182,212,0.1)' : 'rgba(255,255,255,0.04)',
                      color: p.type === 'login_success' ? '#a855f7' : p.type === 'form_structure' ? '#06b6d4' : 'rgba(255,255,255,0.6)',
                      fontWeight: 600,
                    }}>
                      {p.type === 'step_pattern' ? `${p.data?.step_count || '?'}-step pattern`
                        : p.type === 'form_structure' ? `${p.data?.fields?.length || '?'} form fields`
                        : p.type === 'login_success' ? 'Login verified'
                        : p.type}
                      {p.use_count > 1 ? ` (${p.use_count}x)` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Domain Allowlist */}
      <div className="bqv-panel" style={{ marginTop: 10 }}>
        <div className="bqv-panel__label">DOMAIN ALLOWLIST</div>
        <div className="bqv-domain-list">
          {allowedDomains.map((d, i) => (
            <div key={i} className="bqv-domain-row">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: '#30ff90', flexShrink: 0 }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="bqv-domain-row__domain">{d}</span>
              <button className="bqv-domain-row__remove" onClick={() => removeDomain(d)}>{'\u2715'}</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            type="text"
            className="bqv-domain-input"
            placeholder="Add domain..."
            value={newDomain}
            onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addDomain()}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 4, padding: '4px 8px', color: 'rgba(255,255,255,0.8)', fontSize: 12, outline: 'none'
            }}
          />
          <button
            className="bqv-sequence-item__replay"
            onClick={addDomain}
            disabled={!newDomain.trim()}
          >
            + Add
          </button>
        </div>
      </div>

      {/* Automation Schedule (VAULT-INTEG P17) */}
      <div style={{ marginTop: 10 }}>
        <PlatformFlagsPanel
          group="screencap"
          title="Automation Schedule"
          subtitle="Cadence for the automated screenshot capture job"
          authFetch={authFetch}
        />
      </div>
    </div>
  )
}

// ─── Tab: Videos ─────────────────────────────────────────────────────

function VideosTab({ videos, loading, error, onRetry, orgId, authFetch, onRefresh }) {
  const [deletingId, setDeletingId] = useState(null)
  const [playingVideo, setPlayingVideo] = useState(null)

  const handleDelete = useCallback(async (videoId) => {
    if (!confirm('Delete this video?')) return
    setDeletingId(videoId)
    try {
      await apiDeleteVideo(authFetch, orgId, videoId)
      onRefresh()
    } catch (err) {
      console.error('Video delete failed:', err)
    } finally {
      setDeletingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  if (loading) {
    return (
      <div>
        <div className="bqv-videos-grid">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} width="100%" height={140} style={{ borderRadius: 8 }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />
  }

  if (!videos || videos.length === 0) {
    return (
      <EmptyState
        icon={'\u{1F3AC}'}
        text="No recordings yet"
        sub="Ask Browser-Q to 'start video recording' before an automation to capture the session."
      />
    )
  }

  return (
    <div>
      <div className="bqv-videos-grid">
        {/* Video Player Modal */}
        {playingVideo && (
          <div className="bqv-video-modal" onClick={() => setPlayingVideo(null)}>
            <div className="bqv-video-modal__content" onClick={e => e.stopPropagation()}>
              <div className="bqv-video-modal__header">
                <span>{playingVideo.metadata?.url || playingVideo.id}</span>
                <button className="bqv-video-modal__close" onClick={() => setPlayingVideo(null)}>{'\u2715'}</button>
              </div>
              {playingVideo.frames_only ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                  This recording has frames only (ffmpeg was not available during assembly).
                  <br />Video playback requires ffmpeg. Rebuild the screencap container to enable.
                </div>
              ) : (
                <video
                  controls
                  autoPlay
                  style={{ width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 4 }}
                  src={`/screencap/api/browser-q/videos/${playingVideo.id}/stream?org_id=${encodeURIComponent(orgId || 'default')}`}
                />
              )}
            </div>
          </div>
        )}

        {videos.map(v => (
          <div key={v.id} className="bqv-video-card">
            <div className="bqv-video-card__thumb" onClick={() => setPlayingVideo(v)} style={{ cursor: 'pointer' }}>
              <div className="bqv-video-card__play">{'\u25B6'}</div>
            </div>
            <div className="bqv-video-card__body">
              <div className="bqv-video-card__title">
                {v.metadata?.url || v.filename || v.id}
              </div>
              <div className="bqv-video-card__meta">
                <span>{v.duration ? `${v.duration.toFixed(1)}s` : '--'}</span>
                <span>{v.created_at ? new Date(v.created_at).toLocaleDateString() : '--'}</span>
                <span>{formatBytes(v.size_bytes)}</span>
              </div>
            </div>
            <div className="bqv-video-card__actions">
              <button
                className="bqv-video-card__action-btn"
                onClick={() => setPlayingVideo(v)}
                title="Play video"
              >
                {'\u25B6'} Play
              </button>
              {!v.frames_only && (
                <a
                  className="bqv-video-card__action-btn"
                  href={`/screencap/api/browser-q/videos/${v.id}/stream?org_id=${encodeURIComponent(orgId || 'default')}`}
                  download={`${v.id}.mp4`}
                  title="Download MP4"
                >
                  {'\u2B07'} Download
                </a>
              )}
              <button
                className="bqv-video-card__action-btn bqv-video-card__action-btn--delete"
                onClick={() => handleDelete(v.id)}
                disabled={deletingId === v.id}
              >
                {deletingId === v.id ? '...' : `${'\u2715'} Delete`}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tab: Screenshots (BQ-W2-4) ─────────────────────────────────────

function ScreenshotsTab({ gallery, loading, error, onRetry, orgId, authFetch, onRefresh }) {
  const [deletingId, setDeletingId] = useState(null)
  const [keepingId, setKeepingId] = useState(null)
  const [enlargedId, setEnlargedId] = useState(null)

  const handleDelete = useCallback(async (id) => {
    if (!confirm('Delete this screenshot?')) return
    setDeletingId(id)
    try {
      await apiDeleteGalleryScreenshot(authFetch, orgId, id)
      onRefresh()
    } catch (err) {
      console.error('Screenshot delete failed:', err)
    } finally {
      setDeletingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  const handleKeep = useCallback(async (id) => {
    setKeepingId(id)
    try {
      await apiKeepGalleryScreenshot(authFetch, orgId, id)
      onRefresh()
    } catch (err) {
      console.error('Screenshot keep failed:', err)
    } finally {
      setKeepingId(null)
    }
  }, [authFetch, orgId, onRefresh])

  if (loading) {
    return (
      <div>
        <div className="bqv-panel">
          <div className="bqv-panel__label">SCREENSHOTS</div>
          <SkeletonRows count={3} height={80} />
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={onRetry} />
  }

  if (!gallery || gallery.length === 0) {
    return (
      <EmptyState
        icon={'\u{1F4F7}'}
        text="No screenshots yet"
        sub="Screenshots are captured automatically during browser automation runs."
      />
    )
  }

  // Group by objective
  const grouped = {}
  for (const ss of gallery) {
    const key = ss.objective_id || 'manual'
    if (!grouped[key]) grouped[key] = { title: ss.objective_title || ss.objective_id || 'Manual', items: [] }
    grouped[key].items.push(ss)
  }

  return (
    <div>
      {/* Enlarged overlay */}
      {enlargedId && (() => {
        const entry = gallery.find(s => s.id === enlargedId)
        return entry ? (
          <div className="bqv-ss-overlay" onClick={() => setEnlargedId(null)}>
            <div className="bqv-ss-overlay__inner" onClick={e => e.stopPropagation()}>
              <img
                src={getGalleryImageUrl(orgId, entry.id, 'full')}
                alt={entry.description || 'Screenshot'}
                className="bqv-ss-overlay__img"
              />
              <div className="bqv-ss-overlay__meta">
                <span>{entry.objective_title ? `${entry.objective_title} — ` : ''}{entry.description || `Step ${(entry.step_index ?? 0) + 1}`}</span>
                <span>{entry.url || ''}</span>
                <span>{new Date(entry.timestamp).toLocaleString()}</span>
              </div>
              <a
                className="bqv-ss-overlay__download"
                href={getGalleryImageUrl(orgId, entry.id, 'full')}
                download={`screenshot-${entry.id}.jpg`}
                onClick={e => e.stopPropagation()}
                title="Download full screenshot"
                style={{ position: 'absolute', top: 12, right: 48, background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '6px 12px', color: '#fff', fontSize: 12, textDecoration: 'none', cursor: 'pointer' }}
              >
                {'\u2B07'} Download
              </a>
              <button className="bqv-ss-overlay__close" onClick={() => setEnlargedId(null)}>
                {'\u2715'}
              </button>
            </div>
          </div>
        ) : null
      })()}

      <div className="bqv-panel">
        <div className="bqv-panel__label">SCREENSHOTS ({gallery.length})</div>
        <div className="bqv-ss-grid">
          {gallery.map(ss => {
            const expiryDays = ss.expires_at
              ? Math.max(0, Math.ceil((new Date(ss.expires_at) - Date.now()) / (24 * 60 * 60 * 1000)))
              : null

            return (
              <div key={ss.id} className="bqv-ss-card">
                <div
                  className="bqv-ss-card__thumb"
                  onClick={() => setEnlargedId(ss.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <img
                    src={getGalleryImageUrl(orgId, ss.id, 'thumb')}
                    alt={ss.description || 'Screenshot'}
                    className="bqv-ss-card__img"
                    loading="lazy"
                  />
                </div>
                <div className="bqv-ss-card__body">
                  <div className="bqv-ss-card__desc">
                    {ss.description || `Step ${(ss.step_index ?? 0) + 1}`}
                  </div>
                  <div className="bqv-ss-card__meta">
                    {ss.objective_title && (
                      <span className="bqv-ss-card__obj" title={ss.objective_title}>
                        {ss.objective_title.length > 30
                          ? ss.objective_title.substring(0, 30) + '...'
                          : ss.objective_title}
                      </span>
                    )}
                    <span>{new Date(ss.timestamp).toLocaleDateString()}</span>
                    <span>{formatBytes(ss.size_bytes)}</span>
                    {expiryDays !== null && (
                      <span className={`bqv-ss-card__expiry ${expiryDays <= 3 ? 'bqv-ss-card__expiry--soon' : ''}`}>
                        {expiryDays === 0 ? 'Expiring today' : `${expiryDays}d left`}
                      </span>
                    )}
                    {expiryDays === null && (
                      <span className="bqv-ss-card__kept">Kept</span>
                    )}
                  </div>
                </div>
                <div className="bqv-ss-card__actions">
                  <a
                    className="bqv-sequence-item__replay"
                    href={getGalleryImageUrl(orgId, ss.id, 'full')}
                    download={`screenshot-${ss.id}.jpg`}
                    title="Download"
                    style={{ textDecoration: 'none' }}
                  >
                    {'\u2B07'}
                  </a>
                  {ss.expires_at && (
                    <button
                      className="bqv-sequence-item__replay"
                      onClick={() => handleKeep(ss.id)}
                      disabled={keepingId === ss.id}
                      title="Keep permanently (remove expiry)"
                    >
                      {keepingId === ss.id ? '...' : '\u{1F512} Keep'}
                    </button>
                  )}
                  <button
                    className="bqv-sequence-item__replay"
                    style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.2)' }}
                    onClick={() => handleDelete(ss.id)}
                    disabled={deletingId === ss.id}
                  >
                    {deletingId === ss.id ? '...' : '\u2715'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', padding: '8px 12px' }}>
        Screenshots are captured automatically during browser automation runs.
        They expire after 30 days unless you click "Keep" to retain them permanently.
      </div>
    </div>
  )
}

// ─── Tab: Library (merged Recorder + Screenshots + Videos) ──────────

function LibraryTab({ sequences, gallery, videos, automations, loading, error, onRetry, orgId, authFetch, onRefresh, onReplay, replayingId }) {
  const libNavigate = useNavigate()
  const [subTab, setSubTab] = useState('automations')

  if (loading) {
    return <div>{[1, 2, 3].map(i => <Skeleton key={i} width="100%" height={100} style={{ borderRadius: 8, marginBottom: 8 }} />)}</div>
  }
  if (error) return <ErrorBanner message={error} onRetry={onRetry} />

  const subTabs = [
    { id: 'automations', label: `Automations (${automations?.length || 0})` },
    { id: 'screenshots', label: `Screenshots (${gallery?.length || 0})` },
    { id: 'videos', label: `Videos (${videos?.length || 0})` },
  ]

  return (
    <div>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {subTabs.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '5px 14px', borderRadius: 8, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', border: 'none',
              color: subTab === t.id ? '#fff' : 'rgba(255,255,255,0.6)',
              background: subTab === t.id
                ? 'linear-gradient(145deg, rgba(168,85,247,0.1) 0%, rgba(56,189,248,0.04) 100%)'
                : 'rgba(255,255,255,0.03)',
              transition: 'all 0.2s ease',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'automations' && (
        <div>
          {(!automations || automations.length === 0) ? (
            <EmptyState
              icon={'\u{1F916}'}
              text="No saved automations"
              sub="Complete a run and click 'Save as Automation' to build your library."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {automations.map(auto => (
                <div
                  key={auto.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    borderRadius: 10, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    transition: 'all 0.2s ease',
                  }}
                  onClick={() => {
                    if (auto.last_run_id) libNavigate(`/browser-q/run/${auto.last_run_id}`)
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {auto.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
                      {auto.url} {auto.schedule_cron ? ` \u2022 ${auto.schedule_cron}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {auto.schedule_enabled && (
                      <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(168,85,247,0.12)', color: '#a855f7', fontWeight: 600 }}>
                        SCHEDULED
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {auto.run_count} runs
                    </span>
                    {auto.last_run_status && (
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: auto.last_run_status === 'completed' ? '#30ff90'
                          : auto.last_run_status === 'failed' ? '#ef4444'
                          : '#f59e0b',
                      }} />
                    )}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        try {
                          const result = await runAutomationApi(authFetch, orgId, auto.id)
                          if (result.objective_id) libNavigate(`/browser-q/run/${result.objective_id}`)
                        } catch (err) { console.error('Run failed:', err) }
                      }}
                      style={{
                        background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
                        color: '#10b981', padding: '3px 10px', borderRadius: 6, fontSize: 10,
                        fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {'\u25B6'} Run
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (confirm('Delete this automation?')) {
                          await deleteAutomationApi(authFetch, orgId, auto.id)
                          onRefresh()
                        }
                      }}
                      style={{
                        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                        color: 'rgba(239,68,68,0.7)', padding: '3px 8px', borderRadius: 6, fontSize: 10,
                        fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      {'\u2715'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {subTab === 'screenshots' && (
        <ScreenshotsTab
          gallery={gallery}
          loading={false}
          error={null}
          onRetry={onRetry}
          orgId={orgId}
          authFetch={authFetch}
          onRefresh={onRefresh}
        />
      )}
      {subTab === 'videos' && (
        <VideosTab
          videos={videos}
          loading={false}
          error={null}
          onRetry={onRetry}
          orgId={orgId}
          authFetch={authFetch}
          onRefresh={onRefresh}
        />
      )}
    </div>
  )
}

// ─── Tab Renderer ────────────────────────────────────────────────────

function TabContent({ activeTab, data, loading, error, onRetry, orgId, authFetch, onRefresh }) {
  const [replayingId, setReplayingId] = useState(null)

  const handleReplay = useCallback(async (seqId) => {
    setReplayingId(seqId)
    try {
      await apiReplaySequence(authFetch, orgId, seqId)
    } catch (err) {
      console.error('Replay failed:', err)
    } finally {
      setReplayingId(null)
    }
  }, [authFetch, orgId])

  switch (activeTab) {
    case 'runs':
      return (
        <RunsTab
          authFetch={authFetch}
          orgId={orgId}
          objectives={data.objectives || []}
          loading={loading}
          onRefresh={onRefresh}
        />
      )
    case 'library':
      return (
        <LibraryTab
          sequences={data.sequences}
          gallery={data.gallery || []}
          videos={data.videos}
          automations={data.automations || []}
          loading={loading}
          error={error}
          onRetry={onRetry}
          orgId={orgId}
          authFetch={authFetch}
          onRefresh={onRefresh}
          onReplay={handleReplay}
          replayingId={replayingId}
        />
      )
    case 'monitoring':
      return (
        <MonitoringTab
          monitors={data.monitors}
          loading={loading}
          error={error}
          onRetry={onRetry}
          orgId={orgId}
          authFetch={authFetch}
          onRefresh={onRefresh}
        />
      )
    case 'security':
      return <SecurityTab sessions={data.sessions} loading={loading} authFetch={authFetch} orgId={orgId} />
    default:
      return (
        <RunsTab
          authFetch={authFetch}
          orgId={orgId}
          objectives={data.objectives || []}
          loading={loading}
          onRefresh={onRefresh}
        />
      )
  }
}

// ─── Screenshot Viewer Panel (BQ-UX-2) ─────────────────────────────

function ScreenshotViewer({ gallery, orgId, loading }) {
  const [selectedId, setSelectedId] = useState(null)

  if (loading) {
    return (
      <div className="bqv-viewer">
        <div className="bqv-viewer__main">
          <div className="bqv-viewer__placeholder">
            <div style={{ width: '60%', height: '40%', borderRadius: 8, background: 'rgba(255,255,255,0.04)', animation: 'bqv-pulse 1.5s ease-in-out infinite' }} />
          </div>
        </div>
      </div>
    )
  }

  const selected = selectedId ? gallery.find(s => s.id === selectedId) : gallery[0]

  return (
    <div className="bqv-viewer">
      {/* Main image */}
      <div className="bqv-viewer__main">
        {selected ? (
          <>
            <img
              src={getGalleryImageUrl(orgId, selected.id, 'full')}
              alt={selected.description || 'Screenshot'}
              className="bqv-viewer__img"
            />
            <div className="bqv-viewer__meta">
              <span className="bqv-viewer__meta-title">{selected.description || selected.objective_title || 'Screenshot'}</span>
              {selected.url && <span className="bqv-viewer__meta-url">{selected.url}</span>}
              <span className="bqv-viewer__meta-time">{selected.timestamp ? timeAgo(selected.timestamp) : ''}</span>
            </div>
          </>
        ) : (
          <div className="bqv-viewer__placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1" style={{ stroke: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <div style={{ fontSize: 13, color: '#fff', fontWeight: 600 }}>No screenshots yet</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>Run an automation to capture your first screenshot</div>
          </div>
        )}
      </div>

      {/* Thumbnail strip */}
      {gallery.length > 0 && (
        <div className="bqv-viewer__thumbs">
          {gallery.slice(0, 20).map(ss => (
            <button
              key={ss.id}
              className={`bqv-viewer__thumb ${(selected?.id === ss.id) ? 'bqv-viewer__thumb--active' : ''}`}
              onClick={() => setSelectedId(ss.id)}
              title={ss.description || ss.objective_title || 'Screenshot'}
            >
              <img
                src={getGalleryImageUrl(orgId, ss.id, 'thumb')}
                alt=""
                className="bqv-viewer__thumb-img"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────

export default function BrowserQView() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id
  const diag = usePluginLicenseDiagnosis(PLUGIN_NAME)
  const licensed = diag.licensed

  const [activeTab, setActiveTab] = useState('runs')
  const [secondaryView, setSecondaryView] = useState(null) // null | 'library' | 'monitoring' | 'security'
  const [showSidebar, setShowSidebar] = useState(() => {
    try {
      const v = localStorage.getItem('bqv-sidebar-visible')
      return v !== null ? v === 'true' : true
    } catch { return true }
  })

  // ─── Data State ────────────────────────────────────────────────────
  const [data, setData] = useState({ sessions: [], sequences: [], monitors: [], videos: [], gallery: [], objectives: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  // ─── Fetch All Data ────────────────────────────────────────────────
  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const result = await fetchDashboardStats(authFetch, orgId)
      setData(result)
      // BQF-4: Surface partial API failures as a warning
      if (result.failures && result.failures.length > 0) {
        console.warn('[BrowserQ] Partial data — failed APIs:', result.failures.join(', '))
      }
    } catch (err) {
      console.error('[BrowserQ] Fetch error:', err)
      setError(err.message || 'Failed to load Browser-Q data')
    } finally {
      setLoading(false)
    }
  }, [authFetch, orgId])

  // Initial load
  useEffect(() => {
    if (!licensed) return
    fetchData(true)
  }, [fetchData, licensed])

  // Poll sessions every 10s
  useEffect(() => {
    if (!licensed) return

    pollRef.current = setInterval(() => {
      fetchData(false)
    }, 30000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchData, licensed])

  // Persist sidebar state
  useEffect(() => {
    try { localStorage.setItem('bqv-sidebar-visible', String(showSidebar)) } catch {}
  }, [showSidebar])

  // Refresh callback for child components
  const handleRefresh = useCallback(() => {
    fetchData(false)
  }, [fetchData])

  // ─── Wizard State (BQ-W2-2) — persisted to sessionStorage (BQ-RC-1.4) ──
  const [wizardStep, setWizardStep] = useState(() => {
    try {
      const saved = sessionStorage.getItem('bq-wizard-state')
      if (saved) {
        const parsed = JSON.parse(saved)
        return parsed.wizardStep || null
      }
    } catch {}
    return null
  })
  const [wizardData, setWizardData] = useState(() => {
    try {
      const saved = sessionStorage.getItem('bq-wizard-state')
      if (saved) {
        const parsed = JSON.parse(saved)
        return parsed.wizardData || { url: '', intent: '', needsLogin: false, recordVideo: false, credentialId: null, selectedTemplate: null, objectiveId: null, plan: null, results: null }
      }
    } catch {}
    return { url: '', intent: '', needsLogin: false, recordVideo: false, credentialId: null, selectedTemplate: null, objectiveId: null, plan: null, results: null }
  })

  // Persist wizard state to sessionStorage on every change
  useEffect(() => {
    if (wizardStep) {
      try { sessionStorage.setItem('bq-wizard-state', JSON.stringify({ wizardStep, wizardData })) } catch {}
    } else {
      try { sessionStorage.removeItem('bq-wizard-state') } catch {}
    }
  }, [wizardStep, wizardData])

  const openWizard = useCallback((prefilledIntent = '') => {
    setWizardStep('input')
    setWizardData({
      url: '',
      intent: prefilledIntent,
      needsLogin: false,
      recordVideo: false,
      credentialId: null,
      selectedTemplate: null,
      objectiveId: null,
      plan: null,
      results: null
    })
  }, [])

  const closeWizard = useCallback(() => {
    // W2-7: Mark first automation done to hide How-it-works permanently
    if (wizardData.results && !wizardData.results.error) {
      try { localStorage.setItem('bqv-first-automation-done', '1') } catch {}
    }
    setWizardStep(null)
    setWizardData({
      url: '',
      intent: '',
      needsLogin: false,
      recordVideo: false,
      credentialId: null,
      selectedTemplate: null,
      objectiveId: null,
      plan: null,
      results: null
    })
    // Refresh data after wizard closes (may have new sequences)
    fetchData(false)
  }, [fetchData, wizardData.results])

  // ─── Suggestion State (welcome chips → sidebar chat) ───────────────
  const [suggestion, setSuggestion] = useState('')

  const handleChipClick = useCallback((prompt) => {
    // Open sidebar if collapsed
    if (!showSidebar) setShowSidebar(true)
    // Send suggestion to sidebar
    setSuggestion(prompt)
  }, [showSidebar])

  const handleSuggestionConsumed = useCallback(() => {
    setSuggestion('')
  }, [])

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Browser-Q" accentColor="#06b6d4" />
  }

  const activeSessions = data.sessions.filter(s => s.idle_ms < 60000)
  // BQF: First-use = no gallery screenshots (from objectives) AND no saved sequences
  // Previously checked all 4 resource types, which was too strict
  const isFirstUse = !loading && data.gallery.length === 0 && data.sequences.length === 0

  // Secondary views (Library, Monitoring, Security) render as overlays
  const SECONDARY_TABS = [
    { id: 'results', label: 'Results', icon: '\u{1F4CA}' },
    { id: 'library', label: 'Library', icon: '\u{1F4DA}' },
    { id: 'monitoring', label: 'Monitoring', icon: '\u{1F4F7}' },
    { id: 'security', label: 'Security', icon: '\u{1F6E1}' },
  ]

  return (
    <div className="bqv">
      {/* Main area */}
      <div className="bqv-main">

        {/* 1. Header Toolbar */}
        <div className="bqv-toolbar">
          <div className="bqv-toolbar__identity">
            <div className="bqv-toolbar__icon">{'\u{1F310}'}</div>
            <span className="bqv-toolbar__name">BROWSER-Q</span>
            <span className="bqv-toolbar__badge">Web Automation</span>
          </div>

          <SafetyIndicator />

          <button
            className="bqw-new-btn"
            onClick={() => openWizard()}
            disabled={!!wizardStep && wizardStep !== 'complete'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Automation
          </button>

          <div className="bqv-toolbar__spacer" />

          {/* Secondary view tabs */}
          {SECONDARY_TABS.map(t => (
            <button
              key={t.id}
              className={`bqv-toolbar__sec-tab ${secondaryView === t.id ? 'bqv-toolbar__sec-tab--active' : ''}`}
              onClick={() => setSecondaryView(prev => prev === t.id ? null : t.id)}
            >
              {t.label}
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          <div className="bqv-toolbar__engine">
            <div className={`bqv-toolbar__engine-dot ${error ? 'bqv-toolbar__engine-dot--error' : ''}`} />
            <span className="bqv-toolbar__engine-label">
              {error ? 'CONNECTION ERROR' : loading ? 'CONNECTING...' : 'ENGINE RUNNING'}
            </span>
          </div>

          <button
            className={`bqv-sidebar-toggle ${showSidebar ? 'active' : ''}`}
            onClick={() => setShowSidebar(v => !v)}
            title={showSidebar ? 'Hide BROWSER-Q Chat' : 'Show BROWSER-Q Chat'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: showSidebar ? '#06b6d4' : 'rgba(255, 255, 255, 0.6)' }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Chat
          </button>
        </div>

        {/* 2. Content: Wizard OR Three-Column Layout OR Secondary View */}
        {wizardStep ? (
          <div className="bqv-tab-content">
            <AutomationWizard
              authFetch={authFetch}
              orgId={orgId}
              wizardStep={wizardStep}
              setWizardStep={setWizardStep}
              wizardData={wizardData}
              setWizardData={setWizardData}
              onClose={closeWizard}
            />
          </div>
        ) : secondaryView === 'results' ? (
          /* Results view (BQ-CA-2) */
          <div className="bqv-tab-content">
            <ExtractionResultsPanel authFetch={authFetch} orgId={orgId} />
          </div>
        ) : secondaryView ? (
          /* Secondary view (Library, Monitoring, Security) */
          <div className="bqv-tab-content">
            <TabContent
              activeTab={secondaryView}
              data={data}
              loading={loading}
              error={error}
              onRetry={() => fetchData(true)}
              orgId={orgId}
              authFetch={authFetch}
              onRefresh={handleRefresh}
            />
          </div>
        ) : isFirstUse ? (
          /* First-use welcome */
          <ActiveSessions
            sessions={data.sessions}
            loading={loading}
            error={error}
            onRetry={() => fetchData(true)}
            isFirstUse={isFirstUse}
            onChipClick={handleChipClick}
            onNewAutomation={openWizard}
          />
        ) : (
          /* Three-column layout: Viewer (left) + Runs stream (right) */
          <div className="bqv-columns">
            {/* Left: Screenshot viewer + gallery */}
            <div className="bqv-columns__viewer">
              <ScreenshotViewer
                gallery={data.gallery || []}
                orgId={orgId}
                loading={loading}
              />
            </div>

            {/* Right: Runs stream */}
            <div className="bqv-columns__stream">
              <RunsTab
                authFetch={authFetch}
                orgId={orgId}
                onNewAutomation={openWizard}
                objectives={data.objectives || []}
                loading={loading}
                onRefresh={handleRefresh}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right: Chat Sidebar (320px, collapsible) */}
      <div className={`bqv-sidebar ${showSidebar ? '' : 'collapsed'}`}>
        <BrowserQSidebar
          suggestion={suggestion}
          onSuggestionConsumed={handleSuggestionConsumed}
          activeTab={activeTab}
          isFirstUse={isFirstUse}
        />
      </div>
    </div>
  )
}
