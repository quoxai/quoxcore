/**
 * QuoxCORE Memory Dashboard
 *
 * Unified dashboard integrating all memory system panels.
 * Provides navigation between different memory views and quick access
 * to key memory operations.
 *
 * Supports tiered memory features (Free/Premium)
 */

import { useState, useEffect, useCallback } from 'react'
import { MemoryVisualization } from './MemoryVisualization'
import { StyleEnginePanel } from './StyleEnginePanel'
import { BeliefMemoryPanel } from './BeliefMemoryPanel'
import { FailureMemoryPanel } from './FailureMemoryPanel'
import { MemoryPromotionPanel } from './MemoryPromotionPanel'
import { WorkingSetMemoryPanel } from './WorkingSetMemoryPanel'
import { UnifiedImportPanel } from './UnifiedImportPanel'
import { ContextCompilerPanel } from './ContextCompilerPanel'
import { MemorySearchPanel } from './MemorySearchPanel'
import { MemoryView } from './MemoryView'
import { ConversationArchive } from './ConversationArchive'
import { getMemoryManager } from '../../services/memoryManager'
import { getMemoryClient } from '../../services/memoryClient'
import { getColdStorageSummary } from '../../services/memoryPromotion'
import { getWorkingSet } from '../../services/workingSetMemory'
import { getFailureSummary } from '../../services/failureMemory'
import {
  getTierStatus,
  getUsageSummary,
  TIER_LIMITS,
  initializeMemoryTier
} from '../../services/memoryTier'
import './memory.css'

// Colors for the dynamic Memory Breakdown bars (FIX #2). Any memory_type not
// listed here falls back to BREAKDOWN_COLORS.default so new/unexpected
// server-side types still render (honestly) instead of being silently
// dropped or left uncolored.
const BREAKDOWN_COLORS = {
  fact: '#3498db',
  preference: '#f39c12',
  constraint: '#e74c3c',
  decision: '#38bdf8',
  observation: '#9b59b6',
  reflection: '#1abc9c',
  error: '#e74c3c',
  fix: '#27ae60',
  note: '#95a5a6',
  intent: '#3498db',
  imported: '#7f8c8d',
  default: '#7f8c8d'
}

// Panel configuration with tier requirements
const PANELS = {
  overview: {
    id: 'overview',
    label: 'Overview',
    description: 'Memory system overview and quick stats',
    premium: false
  },
  search: {
    id: 'search',
    label: 'Search',
    description: 'Find any memory by keyword, type, or source',
    premium: false  // Free tier gets keyword search, premium gets semantic
  },
  visualization: {
    id: 'visualization',
    label: 'Visualize',
    description: 'Timeline and graph views of your memory landscape',
    premium: true,
    featureFlag: 'hasMemoryVisualization'
  },
  workingSet: {
    id: 'workingSet',
    label: 'Working Set',
    description: 'Currently active context — focus items and open loops',
    premium: true,  // Full WSM is premium (basic focus is free)
    featureFlag: 'hasWSM'
  },
  beliefs: {
    id: 'beliefs',
    label: 'Beliefs',
    description: 'Track facts, assumptions, and hypotheses with confidence levels',
    premium: true,
    featureFlag: 'hasBeliefMemory'
  },
  failures: {
    id: 'failures',
    label: 'Failures',
    description: 'Learn from errors — pattern detection prevents repeat mistakes',
    premium: true,
    featureFlag: 'hasFailureMemory'
  },
  style: {
    id: 'style',
    label: 'Style',
    description: 'Your communication preferences learned from conversations',
    premium: true,
    featureFlag: 'hasStyleEngine'
  },
  promotion: {
    id: 'promotion',
    label: 'Promotion',
    description: 'Move memories between cold, warm, and hot storage tiers',
    premium: true,
    featureFlag: 'hasMemoryPromotion'
  },
  contextCompiler: {
    id: 'contextCompiler',
    label: 'Context',
    description: 'Preview what the AI sees — token budget allocation',
    premium: false  // Available to all, but limited budget for free
  },
  import: {
    id: 'import',
    label: 'Import',
    description: 'Import conversations from ChatGPT, Claude, and other AI tools',
    premium: true,
    featureFlag: 'hasChatGPTImport'
  },
  conversations: {
    id: 'conversations',
    label: 'Conversations',
    description: 'Browse and search your imported conversation history',
    premium: false
  },
  memories: {
    id: 'memories',
    label: 'Classic Memory',
    description: 'Profile, Episodic, Learned, Projects, Candidates',
    premium: false  // Basic memory available, but limited for free tier
  }
}

/**
 * Small inline SVG icon set, one semantic icon per panel id (14-16px,
 * currentColor, stroke-based — replaces the old ASCII glyphs like [M],
 * ~*~, {}, RAM per the glass design system's zero-ASCII-icon rule).
 * Reused across the tab bar, KPI tiles, quick actions, and the system
 * panels grid so there's a single source per icon.
 */
function PanelIcon({ id, size = 16 }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true
  }
  switch (id) {
    case 'overview':
      return (
        <svg {...p}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      )
    case 'search':
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      )
    case 'visualization':
      return (
        <svg {...p}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      )
    case 'workingSet':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" />
          <line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      )
    case 'beliefs':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      )
    case 'failures':
      return (
        <svg {...p}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      )
    case 'style':
      return (
        <svg {...p}>
          <path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-.5-.2-1-.6-1.4-.5-.5-.3-1.4.4-1.8h1.7c1.9 0 3.5-1.5 3.5-3.5C19 6.6 15.9 3 12 3z" />
          <circle cx="7.5" cy="10.5" r="1.1" />
          <circle cx="12" cy="7.3" r="1.1" />
          <circle cx="16.2" cy="10.5" r="1.1" />
          <circle cx="9.8" cy="14.8" r="1.1" />
        </svg>
      )
    case 'promotion':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="16 12 12 8 8 12" />
          <line x1="12" y1="16" x2="12" y2="8" />
        </svg>
      )
    case 'contextCompiler':
      return (
        <svg {...p}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      )
    case 'import':
      return (
        <svg {...p}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      )
    case 'conversations':
      return (
        <svg {...p}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'entities':
      return (
        <svg {...p}>
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="4" y1="15" x2="20" y2="15" />
          <line x1="10" y1="3" x2="8" y2="21" />
          <line x1="16" y1="3" x2="14" y2="21" />
        </svg>
      )
    case 'memories':
    default:
      return (
        <svg {...p}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      )
  }
}

function BrainIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5c-2 1-3 3.5-2 5.5s3.5 3 5.5 2c1.5 1.5 4 1.5 5.5 0s1.5-4 0-5.5c2-1 3-3.5 2-5.5s-3.5-3-5.5-2z" />
      <path d="M12 4.5v15" />
      <path d="M6.5 10h11" />
      <path d="M8 15h8" />
    </svg>
  )
}

function LockIcon({ size = 10 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

/**
 * Memory Dashboard
 */
export function MemoryDashboard({ initialPanel = 'overview', onClose }) {
  const [activePanel, setActivePanel] = useState(initialPanel)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tierStatus, setTierStatus] = useState(null)

  // Initialize tier and load stats
  useEffect(() => {
    initializeMemoryTier().then(tier => {
      loadTierStatus()
    })
    loadStats()
    const interval = setInterval(loadStats, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [])

  // Load tier status
  const loadTierStatus = useCallback(async () => {
    try {
      const status = await getTierStatus()
      setTierStatus(status)
    } catch (err) {
      console.error('Failed to load tier status:', err)
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const mm = getMemoryManager()
      const ws = getWorkingSet()
      const coldSummary = getColdStorageSummary()
      const failureSummary = getFailureSummary()
      const client = getMemoryClient()

      // Try server-side stats first (authoritative — server is the source of
      // truth per data-persistence rules). FIX #2: use the FULL by_type map
      // and the server's own total, rather than re-summing a hardcoded
      // subset of types (fact/preference/constraint/decision/project) which
      // silently dropped observation/reflection/error/etc. and undercounted
      // the real store.
      let memoryCounts = null
      let statsSource = 'local'
      try {
        const serverStats = await client.getStats()
        if (serverStats?.memories) {
          memoryCounts = {
            total: serverStats.memories.total || 0,
            byType: serverStats.memories.by_type || {},
            entities: serverStats.entities?.total ?? mm.getAllEntities?.()?.length ?? 0
          }
          statsSource = 'server'
        }
      } catch {
        // Server unavailable — fall through to localStorage
      }

      // Fallback to localStorage counts (only reached when the server is
      // truly unreachable)
      if (!memoryCounts) {
        const byType = {
          fact: mm.getLearnedItemsByType('fact').length,
          preference: mm.getLearnedItemsByType('preference').length,
          constraint: mm.getLearnedItemsByType('constraint').length,
          decision: mm.getLearnedItemsByType('decision').length
        }
        memoryCounts = {
          total: Object.values(byType).reduce((a, b) => a + b, 0),
          byType,
          entities: mm.getAllEntities?.()?.length || 0
        }
      }

      // Get usage summary for tier (local)
      const usage = getUsageSummary(mm)

      // Try server-side quota for authoritative counts
      let serverQuota = null
      try {
        serverQuota = await client.getQuota()
      } catch {
        // Server quota unavailable — use local counts
      }

      setStats({
        memories: memoryCounts,
        totalMemories: memoryCounts.total,
        statsSource,
        workingSet: {
          hasFocus: !!ws.currentFocus?.task,
          openLoops: ws.openLoops?.filter(l => l.status === 'active').length || 0,
          activeProjects: ws.activeProjects?.filter(p => p.status === 'active').length || 0
        },
        coldStorage: {
          pending: coldSummary.pendingPromotion || 0,
          total: coldSummary.total || 0
        },
        failures: {
          active: failureSummary.active || 0,
          critical: failureSummary.bySeverity?.critical || 0,
          recent: failureSummary.recentFailures || 0
        },
        tierUsage: usage,
        serverQuota  // Server-authoritative quota (null if unavailable)
      })
      setLoading(false)
    } catch (err) {
      console.error('Failed to load dashboard stats:', err)
      setLoading(false)
    }
  }, [])

  // Check if panel requires premium
  const isPanelAvailable = useCallback((panel) => {
    if (!panel.premium) return true
    if (!tierStatus) return false
    if (tierStatus.isPremium) return true
    if (panel.featureFlag && tierStatus.features) {
      return tierStatus.features[panel.featureFlag.replace('has', '').charAt(0).toLowerCase() + panel.featureFlag.replace('has', '').slice(1)]
    }
    return false
  }, [tierStatus])

  // Handle panel selection with tier check
  const handlePanelSelect = useCallback((panelId) => {
    const panel = PANELS[panelId]
    if (panel.premium && !isPanelAvailable(panel)) {
      // Could show purchase modal here
      // Show upgrade prompt by navigating to the panel (renders upgrade placeholder)
      setActivePanel(panelId)
      return
    }
    setActivePanel(panelId)
  }, [isPanelAvailable])

  // Render premium upgrade placeholder
  const renderUpgradePlaceholder = (panel) => (
    <div className="md-upgrade-placeholder">
      <div className="upgrade-hero">
        <div className="upgrade-badge">PREMIUM FEATURE</div>
        <div className="upgrade-brain-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5c-2 1-3 3.5-2 5.5s3.5 3 5.5 2c1.5 1.5 4 1.5 5.5 0s1.5-4 0-5.5c2-1 3-3.5 2-5.5s-3.5-3-5.5-2z"/>
            <path d="M12 4.5v15"/>
            <path d="M6.5 10h11"/>
            <path d="M8 15h8"/>
          </svg>
          <div className="brain-glow" />
        </div>
        <h2>Unlock {panel.label}</h2>
        <p className="upgrade-tagline">Give Your AI a Brain</p>
      </div>

      <p className="upgrade-desc">{panel.description}</p>

      <div className="upgrade-comparison">
        <div className="comparison-col free-col">
          <h4>Free</h4>
          <ul>
            <li className="limit">10 memories max</li>
            <li className="limit">3 preferences max</li>
            <li className="limit">500 token context</li>
            <li className="disabled">Keyword search only</li>
          </ul>
        </div>
        <div className="comparison-col premium-col">
          <h4>Premium</h4>
          <ul>
            <li className="check">Unlimited memories</li>
            <li className="check">Unlimited preferences</li>
            <li className="check">4000+ token context</li>
            <li className="check">Semantic AI search</li>
          </ul>
        </div>
      </div>

      <div className="upgrade-features">
        <div className="feature-item">
          <span className="feature-icon">&#x221E;</span>
          <span>Unlimited Storage</span>
        </div>
        <div className="feature-item">
          <span className="feature-icon">&#x1F50D;</span>
          <span>Semantic Search</span>
        </div>
        <div className="feature-item">
          <span className="feature-icon">&#x1F3A8;</span>
          <span>Style Engine</span>
        </div>
        <div className="feature-item">
          <span className="feature-icon">&#x1F4E5;</span>
          <span>ChatGPT Import</span>
        </div>
      </div>

      <div className="upgrade-cta">
        <div className="upgrade-price-box">
          <span className="upgrade-price">$99</span>
          <span className="upgrade-price-note">one-time purchase</span>
        </div>
        <div className="upgrade-buttons">
          <button
            className="upgrade-btn primary"
            onClick={() => window.location.href = '/plugins'}
          >
            Get Advanced Memory
          </button>
          <button
            className="upgrade-btn secondary"
            onClick={() => window.location.href = '/plugins?trial=true'}
          >
            Try Free for 30 Days
          </button>
        </div>
      </div>
    </div>
  )

  // Render current panel
  const renderPanel = () => {
    const panel = PANELS[activePanel]

    // Check if premium panel is locked
    if (panel?.premium && !isPanelAvailable(panel)) {
      return renderUpgradePlaceholder(panel)
    }

    switch (activePanel) {
      case 'overview':
        return <DashboardOverview stats={stats} tierStatus={tierStatus} onNavigate={handlePanelSelect} />
      case 'search':
        return <MemorySearchPanel />
      case 'visualization':
        return <MemoryVisualization />
      case 'workingSet':
        return <WorkingSetMemoryPanel />
      case 'beliefs':
        return <BeliefMemoryPanel />
      case 'failures':
        return <FailureMemoryPanel />
      case 'style':
        return <StyleEnginePanel />
      case 'promotion':
        return <MemoryPromotionPanel />
      case 'contextCompiler':
        return <ContextCompilerPanel />
      case 'import':
        return <UnifiedImportPanel onImportComplete={() => {
          loadStats()
          setActivePanel('promotion')
        }} />
      case 'conversations':
        return <ConversationArchive />
      case 'memories':
        return <MemoryView />
      default:
        return <DashboardOverview stats={stats} tierStatus={tierStatus} onNavigate={handlePanelSelect} />
    }
  }

  return (
    <div className="memory-dashboard qx-view" style={{ gap: 16, height: '100%' }}>
      {/* Header */}
      <section className="qx-card qx-card--bar">
        <div className="qx-row qx-row--apart">
          <div className="qx-row qx-row--tight">
            <span style={{ color: '#38bdf8', display: 'inline-flex' }}>
              <BrainIcon size={20} />
            </span>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Memory Systems</h1>
            {tierStatus && (
              <span className={`qx-pill qx-pill--sm ${tierStatus.isPremium ? 'qx-pill--purple' : 'qx-pill--online'}`}>
                {tierStatus.displayName}
              </span>
            )}
          </div>
          <div className="qx-row qx-row--tight">
            <button
              className="qx-btn qx-btn--ghost qx-btn--sm"
              onClick={() => setActivePanel('search')}
            >
              <PanelIcon id="search" size={14} />
              Search
            </button>
            {onClose && (
              <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close memory dashboard">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Navigation */}
      <section className="qx-card qx-card--bar" style={{ padding: '4px 20px' }}>
        <nav className="qx-tabs qx-tabs--underline" role="tablist" aria-label="Memory system panels" style={{ overflowX: 'auto', flexWrap: 'nowrap' }}>
          {Object.values(PANELS).map((panel) => {
            const isLocked = panel.premium && !isPanelAvailable(panel)
            const panelIds = Object.keys(PANELS)
            return (
              <button
                key={panel.id}
                role="tab"
                aria-selected={activePanel === panel.id}
                aria-controls={`md-panel-${panel.id}`}
                id={`md-tab-${panel.id}`}
                tabIndex={activePanel === panel.id ? 0 : -1}
                className={`qx-tab ${activePanel === panel.id ? 'qx-tab--active' : ''}`}
                style={isLocked ? { opacity: 0.55 } : undefined}
                onClick={() => handlePanelSelect(panel.id)}
                onKeyDown={(e) => {
                  const currentIndex = panelIds.indexOf(panel.id)
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    const nextIndex = (currentIndex + 1) % panelIds.length
                    handlePanelSelect(panelIds[nextIndex])
                    document.getElementById(`md-tab-${panelIds[nextIndex]}`)?.focus()
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const prevIndex = (currentIndex - 1 + panelIds.length) % panelIds.length
                    handlePanelSelect(panelIds[prevIndex])
                    document.getElementById(`md-tab-${panelIds[prevIndex]}`)?.focus()
                  } else if (e.key === 'Home') {
                    e.preventDefault()
                    handlePanelSelect(panelIds[0])
                    document.getElementById(`md-tab-${panelIds[0]}`)?.focus()
                  } else if (e.key === 'End') {
                    e.preventDefault()
                    handlePanelSelect(panelIds[panelIds.length - 1])
                    document.getElementById(`md-tab-${panelIds[panelIds.length - 1]}`)?.focus()
                  }
                }}
                title={isLocked ? `${panel.description} (Premium)` : panel.description}
                aria-disabled={isLocked}
              >
                <PanelIcon id={panel.id} size={14} />
                <span className="nav-label">{panel.label}</span>
                {/* Premium badge for locked panels */}
                {isLocked && (
                  <span className="qx-badge" style={{ background: 'rgba(168,85,247,0.18)', borderColor: 'rgba(168,85,247,0.4)', color: '#c084fc' }} aria-label="Premium feature">
                    <LockIcon size={9} />
                  </span>
                )}
                {/* Badge for panels with pending items */}
                {!isLocked && panel.id === 'promotion' && stats?.coldStorage?.pending > 0 && (
                  <span className="qx-badge" aria-label={`${stats.coldStorage.pending} pending`}>{stats.coldStorage.pending}</span>
                )}
                {!isLocked && panel.id === 'failures' && stats?.failures?.active > 0 && (
                  <span className="qx-badge qx-badge--alert" aria-label={`${stats.failures.active} active failures`}>{stats.failures.active}</span>
                )}
                {!isLocked && panel.id === 'workingSet' && stats?.workingSet?.openLoops > 0 && (
                  <span className="qx-badge" aria-label={`${stats.workingSet.openLoops} open loops`}>{stats.workingSet.openLoops}</span>
                )}
              </button>
            )
          })}
        </nav>
      </section>

      {/* Content */}
      <section
        className="qx-card"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        role="tabpanel"
        id={`md-panel-${activePanel}`}
        aria-labelledby={`md-tab-${activePanel}`}
      >
        {loading && activePanel === 'overview' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 14 }} role="status" aria-live="polite">
            <span className="qx-spinner qx-spinner--lg" aria-hidden="true" />
            <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Loading memory systems...</p>
          </div>
        ) : (
          renderPanel()
        )}
      </section>
    </div>
  )
}

/**
 * Usage meter with color-coded progress bar
 */
function UsageMeter({ label, current, limit, icon }) {
  const isUnlimited = limit === Infinity || limit === null
  const pct = isUnlimited ? 0 : Math.min(Math.round((current / limit) * 100), 100)
  const variant = pct >= 100 ? 'qx-progress--crit' : pct >= 75 ? 'qx-progress--warn' : 'qx-progress--success'

  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
          <span style={{ color: 'rgba(255,255,255,0.6)', display: 'inline-flex' }}>{icon}</span>
          {label}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
          {current}{isUnlimited ? '' : ` / ${limit}`}
        </span>
      </div>
      {!isUnlimited && (
        <div className={`qx-progress ${variant}`} style={{ '--qx-progress': pct / 100 }} />
      )}
    </div>
  )
}

/**
 * Dashboard Overview - Quick access and stats
 */
function DashboardOverview({ stats, tierStatus, onNavigate }) {
  if (!stats) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 14 }}>
        <span className="qx-spinner qx-spinner--lg" />
        <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Loading stats...</p>
      </div>
    )
  }

  const isFreeTier = !tierStatus?.isPremium
  const tierUsage = stats.tierUsage

  // Use server quota when available, fall back to local counts
  const sq = stats.serverQuota?.quota
  const sl = stats.serverQuota?.limits
  const learnedCurrent = sq?.learned_count ?? tierUsage?.learned?.current ?? 0
  const learnedLimit = sl?.maxLearnedItems ?? tierUsage?.learned?.limit ?? 10
  const prefCurrent = sq?.preference_count ?? tierUsage?.preferences?.current ?? 0
  const prefLimit = sl?.maxPreferences ?? tierUsage?.preferences?.limit ?? 3
  const entityCurrent = sq?.entity_count ?? stats.memories?.entities ?? 0
  const entityLimit = sl?.maxEntities ?? 50
  const atLimit = learnedCurrent >= learnedLimit && learnedLimit !== Infinity

  // FIX #2: full type breakdown from the server's by_type map (not a
  // hardcoded subset) — sorted by count so the biggest real categories show
  // first (e.g. this store is dominated by "observation", not "fact").
  const byType = stats.memories?.byType || {}
  const sortedTypes = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  const topTypes = sortedTypes.slice(0, 3)
  const totalForBars = Math.max(stats.totalMemories, 1)

  const QUICK_ACTIONS = [
    { id: 'search', icon: 'search', label: 'Search Memories', desc: 'Find anything in your memory' },
    { id: 'import', icon: 'import', label: 'Import ChatGPT', desc: 'Import conversation history' },
    { id: 'visualization', icon: 'visualization', label: 'Visualize', desc: 'Timeline and graph views' },
    { id: 'contextCompiler', icon: 'contextCompiler', label: 'Test Context', desc: 'Preview context compilation' },
    { id: 'memories', icon: 'memories', label: 'Classic Memory', desc: 'Profile, Episodic, Projects' }
  ]

  return (
    <div className="qx-stack">
      {/* Tier Status Banner (Free tier only) */}
      {isFreeTier && (
        <div className="qx-card qx-card--compact qx-stack qx-stack--compact">
          <div className="qx-row qx-row--apart">
            <span className="qx-pill qx-pill--online qx-pill--sm">Free Tier</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
              {learnedCurrent} / {learnedLimit} memories used
            </span>
          </div>
          {atLimit && (
            <div className="qx-banner qx-banner--error">
              Memory limit reached. Purchase the Advanced Memory Plugin for unlimited storage.
            </div>
          )}

          <div className="qx-grid-3">
            <UsageMeter label="Learned Items" current={learnedCurrent} limit={learnedLimit} icon={<PanelIcon id="memories" size={13} />} />
            <UsageMeter label="Preferences" current={prefCurrent} limit={prefLimit} icon={<PanelIcon id="style" size={13} />} />
            <UsageMeter label="Entities" current={entityCurrent} limit={entityLimit} icon={<PanelIcon id="entities" size={13} />} />
          </div>

          <button
            className="qx-btn qx-btn--primary"
            onClick={() => window.location.href = '/plugins'}
          >
            Purchase Advanced Memory - $99 one-time
          </button>
        </div>
      )}

      {/* Quick Stats Row */}
      <div className="qx-grid-4">
        <div className="qx-card qx-card--compact">
          <div className="qx-stat">
            <span className="qx-stat__head"><PanelIcon id="memories" size={13} /> Total Memories</span>
            <span className="qx-stat__value">{stats.totalMemories}</span>
            <span className="qx-stat__sub">
              {topTypes.map(([type, count]) => `${count} ${type}`).join(' · ')}
              {topTypes.length ? ' · ' : ''}{stats.memories.entities} entities
              {isFreeTier && learnedLimit !== Infinity && ` · (${Math.max(0, learnedLimit - learnedCurrent)} remaining)`}
            </span>
          </div>
        </div>

        <div
          className="qx-card qx-card--compact qx-card--lift"
          onClick={() => onNavigate('workingSet')}
        >
          <div className="qx-stat">
            <span className="qx-stat__head"><PanelIcon id="workingSet" size={13} /> Working Set <em style={{ opacity: 0.6, fontStyle: 'normal' }}>(local)</em></span>
            <span className="qx-stat__value">
              {stats.workingSet.hasFocus ? 'Focused' : 'No Focus'}
            </span>
            <span className="qx-stat__sub">{stats.workingSet.openLoops} open loops · {stats.workingSet.activeProjects} projects</span>
          </div>
        </div>

        <div
          className="qx-card qx-card--compact qx-card--lift"
          onClick={() => onNavigate('promotion')}
        >
          <div className="qx-stat">
            <span className="qx-stat__head"><PanelIcon id="promotion" size={13} /> Pending Promotion <em style={{ opacity: 0.6, fontStyle: 'normal' }}>(local)</em></span>
            <span className="qx-stat__value">{stats.coldStorage.pending}</span>
            <span className="qx-stat__sub">{stats.coldStorage.total} in cold storage</span>
          </div>
        </div>

        <div
          className="qx-card qx-card--compact qx-card--lift"
          onClick={() => onNavigate('failures')}
        >
          <div className="qx-stat">
            <span className="qx-stat__head"><PanelIcon id="failures" size={13} /> Active Failures <em style={{ opacity: 0.6, fontStyle: 'normal' }}>(local)</em></span>
            <span className="qx-stat__value" style={stats.failures.critical > 0 ? { WebkitTextFillColor: '#f87171', background: 'none' } : undefined}>
              {stats.failures.active}
            </span>
            <span className="qx-stat__sub">
              {stats.failures.critical > 0 && <span style={{ color: '#f87171' }}>{stats.failures.critical} critical · </span>}
              {stats.failures.recent} last 24h
            </span>
          </div>
        </div>
      </div>

      {/* FIX #4: Default browse — real server rows on load, not a blank
          screen that only fills in once you type a search query. */}
      <RecentMemoriesList total={stats.totalMemories} onNavigate={onNavigate} />

      {/* Quick Actions */}
      <div>
        <div className="qx-section-title">Quick Actions</div>
        <div className="qx-grid-3">
          {QUICK_ACTIONS.map(qa => (
            <button
              key={qa.id}
              className="qx-action-card"
              onClick={() => onNavigate(qa.id)}
            >
              <span className="qx-action-card__icon"><PanelIcon id={qa.icon} size={18} /></span>
              <span className="qx-action-card__body">
                <div className="qx-action-card__title">{qa.label}</div>
                <div className="qx-action-card__desc">{qa.desc}</div>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Memory Types Breakdown — FIX #2: dynamic, driven by the server's
          full by_type map so every real category shows up (not just the 4
          the UI used to hardcode). Falls back to a generic color for any
          type not in the known palette. */}
      <div className="qx-card qx-card--compact">
        <div className="qx-section-title">Memory Breakdown{sortedTypes.length > 0 ? ` (${sortedTypes.length} types)` : ''}</div>

        {sortedTypes.length === 0 && stats.memories.entities === 0 ? (
          <div className="qx-empty">
            <span className="qx-empty__icon"><PanelIcon id="memories" size={24} /></span>
            <p className="qx-empty__title">No memories yet</p>
          </div>
        ) : (
          <>
            <div className="qx-segbar">
              {sortedTypes.map(([type, count]) => (
                <div
                  key={type}
                  className="qx-segbar__seg"
                  style={{ '--qx-seg-w': `${(count / totalForBars) * 100}%`, '--qx-seg-color': BREAKDOWN_COLORS[type] || BREAKDOWN_COLORS.default }}
                  title={`${type}: ${count}`}
                />
              ))}
              {stats.memories.entities > 0 && (
                <div
                  className="qx-segbar__seg"
                  style={{ '--qx-seg-w': `${(stats.memories.entities / totalForBars) * 100}%`, '--qx-seg-color': '#27ae60' }}
                  title={`entities: ${stats.memories.entities}`}
                />
              )}
            </div>

            <div className="qx-segbar-legend" style={{ marginTop: 14 }}>
              {sortedTypes.map(([type, count]) => (
                <button
                  key={type}
                  className="qx-segbar-legend__item"
                  onClick={() => onNavigate('memories')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'rgba(255,255,255,0.85)', fontSize: 12 }}
                >
                  <span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': BREAKDOWN_COLORS[type] || BREAKDOWN_COLORS.default }} />
                  <span style={{ textTransform: 'capitalize' }}>{type}</span>
                  <span style={{ color: '#fff', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                </button>
              ))}
              {stats.memories.entities > 0 && (
                <button
                  className="qx-segbar-legend__item"
                  onClick={() => onNavigate('memories')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'rgba(255,255,255,0.85)', fontSize: 12 }}
                >
                  <span className="qx-segbar-legend__swatch" style={{ '--qx-seg-color': '#27ae60' }} />
                  <span>Entities</span>
                  <span style={{ color: '#fff', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{stats.memories.entities}</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* System Panels */}
      <div>
        <div className="qx-section-title">Memory Systems</div>
        <div className="qx-grid-3">
          {Object.values(PANELS).filter(p => p.id !== 'overview').map((panel) => (
            <button
              key={panel.id}
              className="qx-action-card"
              onClick={() => onNavigate(panel.id)}
            >
              <span className="qx-action-card__icon"><PanelIcon id={panel.id} size={18} /></span>
              <span className="qx-action-card__body">
                <div className="qx-action-card__title">{panel.label}</div>
                <div className="qx-action-card__desc">{panel.description}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Recent Memories — default browse list (FIX #4)
 *
 * Backed by GET /api/memory via memoryClient.getMemories({ limit, offset }),
 * the same server endpoint the Classic "Learned" tab already uses. Shown by
 * default on the Overview panel so the dashboard renders real server rows
 * on load instead of staying blank until the user types a search query.
 */
const RECENT_PAGE_SIZE = 25

function RecentMemoriesList({ total, onNavigate }) {
  const [items, setItems] = useState([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async (newOffset) => {
    setLoading(true)
    setError(null)
    try {
      const client = getMemoryClient()
      const results = await client.getMemories({ limit: RECENT_PAGE_SIZE, offset: newOffset })
      setItems(results)
      setOffset(newOffset)
    } catch (err) {
      setError(err.message || 'Failed to load memories')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(0)
  }, [load])

  const knownTotal = total || 0
  const showingFrom = items.length > 0 ? offset + 1 : 0
  const showingTo = offset + items.length

  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-section-title">Recent Memories</div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
        {knownTotal > 0
          ? `Showing ${showingFrom}-${showingTo} of ${knownTotal} memories`
          : loading ? 'Loading...' : 'No memories found on the server.'}
      </p>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 }}>
          <span className="qx-spinner" />
          <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Loading memories...</p>
        </div>
      ) : error ? (
        <div className="qx-banner qx-banner--error">Failed to load recent memories: {error}</div>
      ) : (
        <>
          <div style={{ minHeight: 0, maxHeight: 420, overflowY: 'auto', borderRadius: 12, border: '1px solid var(--m-border-default)' }}>
            <table className="qx-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Content</th>
                  <th style={{ textAlign: 'right' }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {items.map(m => (
                  <tr
                    key={m.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onNavigate('memories')}
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className="qx-pill qx-pill--ghost qx-pill--sm" style={{ textTransform: 'capitalize' }}>
                        {m.memory_type || 'unknown'}
                      </span>
                    </td>
                    <td style={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.content}>
                      {m.content}
                    </td>
                    <td style={{ textAlign: 'right', color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>
                      {m.created_at ? new Date(m.created_at).toLocaleDateString() : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && (
              <div className="qx-empty">
                <p className="qx-empty__title">No memories on this page</p>
              </div>
            )}
          </div>

          <div className="qx-row qx-row--tight" style={{ marginTop: 12 }}>
            <button
              className="qx-btn qx-btn--sm"
              disabled={offset === 0}
              onClick={() => load(Math.max(0, offset - RECENT_PAGE_SIZE))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Prev
            </button>
            <button
              className="qx-btn qx-btn--sm"
              disabled={offset + RECENT_PAGE_SIZE >= knownTotal}
              onClick={() => load(offset + RECENT_PAGE_SIZE)}
            >
              Next
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => onNavigate('memories')}>
              <PanelIcon id="memories" size={14} />
              Open Classic Memory
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default MemoryDashboard
