/**
 * CognitiveCore3DView — Fullscreen Immersive 3D Cognitive Visualiser
 *
 * Shell file: license gate, fullscreen management, state management,
 * keyboard shortcuts, Canvas mount, and HUD composition.
 *
 * Scene logic lives in CognitiveCore.jsx, mock data in mock-data.js,
 * and HUD components in hud/*.jsx.
 */
import React, { useState, useEffect, useCallback, useRef, Suspense, useMemo, lazy, Component } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'

import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { DEFAULTS } from '../../components/opsdeck3d/lib/design-system'
import { MOCK_AGENTS, MOCK_IMPLANTS, MOCK_OBJECTIVES, MOCK_MEMORIES } from '../../components/opsdeck3d/lib/mock-data'

// Data bridge lazy-loaded in separate chunk — avoids R3F reconciler conflict
const CogCore3DDataBridge = lazy(() => import('../../components/opsdeck3d/hooks/CogCore3DDataBridge'))

import CognitiveCore, { FpsCounter, GlInfoReporter } from '../../components/opsdeck3d/CognitiveCore'
import { LAYER_PRESETS, PRESET_NAMES } from '../../components/opsdeck3d/hud/TogglePanel'
import SearchOverlay from '../../components/opsdeck3d/hud/SearchOverlay'
import EliteHUD, { PulseBar, ZoneLabel, FpsDisplay, ZONE_LABEL_MAP, QuickActions, LeftBezelGauges } from '../../components/opsdeck3d/hud/EliteHUD'
import PerformanceHUD from '../../components/opsdeck3d/hud/PerformanceHUD'
import ScannerDisc from '../../components/opsdeck3d/hud/ScannerDisc'
import BottomControls from '../../components/opsdeck3d/hud/BottomControls'
import SidebarRail from '../../components/opsdeck3d/hud/SidebarRail'
import CoreyNotifier from '../../components/opsdeck3d/hud/CoreyNotifier'
import SpatialChat from '../../components/opsdeck3d/hud/SpatialChat'

import { cc3dAudit } from '../../components/opsdeck3d/lib/cc3dAudit'
import { OVERLAY_MODES, OVERLAY_LABELS, OVERLAY_COLORS } from '../../components/opsdeck3d/lib/colorOverlays'
import { autoQualityTier, QUALITY_TIERS } from '../../components/opsdeck3d/lib/sharedGeometry'
import { TOURS, runTour } from '../../components/opsdeck3d/lib/tourSystem'
import { recordZoneVisit, recordFeatureUsage, getSuggestion } from '../../components/opsdeck3d/lib/cc3dWisdom'
import { saveBookmark, loadBookmark } from '../../components/opsdeck3d/lib/cameraBookmarks'
import './cogcore3d.css'

// ─── Error Boundary ─────────────────────────────────────
class CC3DErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null } }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed', inset: 0, background: '#050510',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.7)',
          flexDirection: 'column', gap: 16,
        }}>
          <div style={{ fontSize: 40, opacity: 0.3 }}>&#x26A0;</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>Cognitive Core 3D Error</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', maxWidth: 400, textAlign: 'center' }}>
            {this.state.error?.message || 'An unexpected error occurred in the 3D renderer.'}
          </div>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }) }}
            style={{
              padding: '8px 20px', border: '1px solid #8b5cf630', borderRadius: 4,
              background: 'rgba(139,92,246,0.1)', color: '#8b5cf6', cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            }}
          >Try Again</button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Constants ──────────────────────────────────────────
const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const BRAND_VIOLET = '#8b5cf6'

// ─── Default visibility toggles ─────────────────────────
const DEFAULT_VISIBLE = {
  holoGrid: true,
  particles: true,
  nucleus: true,
  shell: true,
  implants: true,
  agents: true,
  zoneRings: true,
  focusBeam: true,
  heartbeat: true,
  execution: true,
  memory: true,
  highways: true,
  nestedShells: true,
  services: true,
  protocols: true,
  infra: true,
  orgs: true,
  jumpNodes: true,
  teams: true,
  plugins: true,
  tools: true,
  workflows: true,
  integrations: true,
  llmProviders: true,
  horus: true,
  floatingPanels: false,
  simulation: false,
}

// ─── Settings persistence ───────────────────────────────
const SETTINGS_KEY = 'cogcore3d_settings'

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* noop */ }
}

// ─── Info Panel (Right Side) — Rich detail panel ────────
const SECTION_LABEL = { fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: 4, marginTop: 10 }
const TAG_STYLE = { padding: '2px 6px', borderRadius: 3, fontSize: 8, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)' }
const STAT_ROW = { display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10 }

function InfoPanel({ selected, onClose, onAskCorey }) {
  if (!selected) return null

  const accent = selected.color || BRAND_VIOLET
  const stateColors = {
    idle: '#555570', active: '#818cf8', thinking: '#6366f1', executing: '#22c55e',
    reading: '#06b6d4', writing: '#0891b2', blocked: '#ef4444', done: '#10b981',
    healthy: '#22c55e', degraded: '#f59e0b', down: '#ef4444', unknown: '#555570',
    running: '#22c55e', pending: '#f59e0b', completed: '#10b981', failed: '#ef4444',
  }
  const stateColor = stateColors[selected.state] || '#555570'
  const isAgent = selected.type === 'agent' || selected.role === 'team-member'
  const isImplant = selected.type === 'implant'
  const isObjective = selected.type === 'objective'
  const isMemory = selected.type === 'memory'
  const isTeam = selected.type === 'team'
  const isService = selected.type === 'service'

  return (
    <div style={{
      position: 'fixed', top: 60, right: 52, zIndex: 30,
      width: 280, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto',
      padding: '14px 16px 16px',
      background: 'rgba(5, 5, 16, 0.9)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderRadius: 8, border: `1px solid ${accent}30`,
      fontFamily: FONT_STACK, fontSize: 11, letterSpacing: '0.03em',
      color: 'rgba(255,255,255,0.85)',
      boxShadow: `0 4px 30px rgba(0,0,0,0.5), 0 0 30px ${accent}10`,
    }}>
      {/* Close */}
      <div onClick={onClose} style={{ position: 'absolute', top: 8, right: 10, cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>&#10005;</div>

      {/* Type badge */}
      <div style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 7, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', background: `${accent}20`, color: accent, border: `1px solid ${accent}30`, marginBottom: 6 }}>
        {selected.type}
      </div>

      {/* Name */}
      <div style={{ fontWeight: 700, fontSize: 16, color: accent, marginBottom: 2, lineHeight: 1.2 }}>
        {selected.name}
      </div>
      <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, textTransform: 'uppercase', marginBottom: 8 }}>
        {selected.role || selected.type} {selected.id ? `\u00B7 ${selected.id}` : ''}
      </div>

      {/* State indicator */}
      {selected.state && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 8px', background: `${stateColor}12`, borderRadius: 4, border: `1px solid ${stateColor}25` }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor, boxShadow: `0 0 8px ${stateColor}` }} />
          <span style={{ color: stateColor, fontWeight: 600, textTransform: 'capitalize', fontSize: 11 }}>
            {selected.state.replace(/_/g, ' ')}
          </span>
        </div>
      )}

      {/* Description */}
      {selected.description && (
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, lineHeight: 1.6, marginBottom: 6, borderLeft: `2px solid ${accent}30`, paddingLeft: 8 }}>
          {selected.description}
        </div>
      )}

      {/* ─── Implant-specific stats ─── */}
      {isImplant && (
        <>
          <div style={SECTION_LABEL}>Implant Health</div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ height: '100%', width: `${selected.health || 0}%`, background: stateColor, borderRadius: 3, transition: 'width 0.5s' }} />
          </div>
          <div style={{ ...STAT_ROW }}>
            <span style={{ color: 'rgba(255,255,255,0.5)' }}>Health</span>
            <span style={{ color: stateColor, fontWeight: 700, fontFamily: FONT_STACK }}>{selected.health ?? '?'}%</span>
          </div>
          {selected.layer && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Layer</span><span style={{ color: 'rgba(255,255,255,0.7)' }}>{selected.layer}</span></div>}
          {selected.locked !== undefined && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Status</span><span style={{ color: selected.locked ? '#ef4444' : '#22c55e' }}>{selected.locked ? 'LOCKED' : 'ACTIVE'}</span></div>}
        </>
      )}

      {/* ─── Service stats ─── */}
      {isService && (
        <>
          <div style={SECTION_LABEL}>Service Info</div>
          {selected.port && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Port</span><span style={{ fontFamily: FONT_STACK }}>{selected.port}</span></div>}
          {selected.status && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Status</span><span style={{ color: stateColor }}>{selected.status.toUpperCase()}</span></div>}
        </>
      )}

      {/* ─── Team stats ─── */}
      {isTeam && (
        <>
          <div style={SECTION_LABEL}>Team Composition</div>
          {selected.memberCount && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Members</span><span style={{ fontFamily: FONT_STACK }}>{selected.memberCount}</span></div>}
        </>
      )}

      {/* ─── Objective stats ─── */}
      {isObjective && (
        <>
          <div style={SECTION_LABEL}>Objective Status</div>
          {selected.status && <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Status</span><span style={{ color: stateColor }}>{selected.status.toUpperCase()}</span></div>}
        </>
      )}

      {/* ─── Memory info ─── */}
      {isMemory && (
        <>
          <div style={SECTION_LABEL}>Memory Record</div>
          <div style={STAT_ROW}><span style={{ color: 'rgba(255,255,255,0.5)' }}>Type</span><span style={{ color: accent }}>{selected.role || 'unknown'}</span></div>
        </>
      )}

      {/* Tools */}
      {isAgent && selected.tools && selected.tools.length > 0 && (
        <>
          <div style={SECTION_LABEL}>Tools ({selected.tools.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {selected.tools.map(t => (<span key={t} style={TAG_STYLE}>{t}</span>))}
          </div>
        </>
      )}

      {/* Capabilities */}
      {isAgent && selected.capabilities && selected.capabilities.length > 0 && (
        <>
          <div style={SECTION_LABEL}>Capabilities</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {selected.capabilities.map(c => (
              <span key={c} style={{ ...TAG_STYLE, background: `${accent}12`, color: accent, border: `1px solid ${accent}20` }}>{c}</span>
            ))}
          </div>
        </>
      )}

      {/* Position (always show — useful reference) */}
      {selected.position && (
        <>
          <div style={SECTION_LABEL}>Position</div>
          <div style={{ fontFamily: FONT_STACK, fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
            [{selected.position.map(v => typeof v === 'number' ? v.toFixed(1) : v).join(', ')}]
          </div>
        </>
      )}

      {/* View in 2D dashboard link */}
      {selected.type === 'agent' && (
        <a href={`/agents/${selected.id}`} style={{
          display: 'block', marginTop: 8, padding: '5px 8px', borderRadius: 3,
          fontSize: 9, color: 'rgba(255,255,255,0.4)', textDecoration: 'none',
          border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center',
        }}>View in 2D Dashboard</a>
      )}

      {/* Ask COREY button */}
      {onAskCorey && (
        <button
          onClick={() => onAskCorey(`Tell me about ${selected.name} (${selected.type})`)}
          style={{
            width: '100%', marginTop: 10, padding: '7px 10px',
            border: '1px solid #00d4aa30', borderRadius: 4,
            background: 'rgba(0, 212, 170, 0.08)', color: '#00d4aa',
            fontFamily: FONT_STACK, fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => { e.target.style.background = 'rgba(0, 212, 170, 0.2)' }}
          onMouseLeave={(e) => { e.target.style.background = 'rgba(0, 212, 170, 0.08)' }}
        >
          Ask COREY about this
        </button>
      )}
    </div>
  )
}

// ─── Delegation passthrough (real delegations only, no mock loop) ───
function useDelegations(liveDelegations) {
  return (liveDelegations && liveDelegations.length > 0) ? liveDelegations : []
}

// ─── Licensed View (Full 3D Scene) ──────────────────────
function LicensedView({ preset, objectiveId, entityParam, depthParam }) {
  const [settings, setSettings] = useState(loadSettings)
  const [fps, setFps] = useState(0)
  const [glInfo, setGlInfo] = useState(null)
  const [visible, setVisible] = useState(DEFAULT_VISIBLE)
  const [selected, setSelected] = useState(null)
  const [orbitTarget, setOrbitTarget] = useState([0, 0, 0])
  const [activeZone, setActiveZone] = useState('AGT')
  const [activePreset, setActivePreset] = useState('Full Core')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hudHidden, setHudHidden] = useState(false)
  const [perfHudVisible, setPerfHudVisible] = useState(false)

  // Data bridge — lazy-loaded separately to avoid R3F reconciler conflict.
  // Static import of useCogCore3DState breaks R3F because its import chain
  // (useOpsDeckState → opsdeck components) has module-level side effects.
  const [liveData, setLiveData] = useState(null)
  const handleData = useCallback((data) => setLiveData(data), [])

  const coreState = liveData || {
    agents: MOCK_AGENTS, objectives: MOCK_OBJECTIVES, implants: MOCK_IMPLANTS,
    memories: MOCK_MEMORIES, delegations: [], events: [], systemState: 'idle',
    connectionState: 'disconnected', activeAgents: 0, totalAgents: MOCK_AGENTS.length,
    workingSet: null, currentFocus: null,
    activeImplantCount: MOCK_IMPLANTS.filter(i => !i.locked && i.health > 0).length, isLive: false,
  }
  const delegations = useDelegations(coreState.delegations)

  // Build flat entity list for scanner disc (derived from live data)
  const scannerEntities = useMemo(() => {
    const entities = []
    // Agents — positioned on a ring at r~15
    coreState.agents.forEach((a, i) => {
      const angle = (i / coreState.agents.length) * Math.PI * 2
      const r = a.role === 'orchestrator' ? 0 : (a.role === 'manager' || a.role === 'analyst') ? 17 : 25
      entities.push({
        id: a.id, type: 'agent', name: a.name,
        position: [Math.cos(angle) * r, a.role === 'orchestrator' ? 2 : 0.5, Math.sin(angle) * r],
        color: a.color, state: a.state,
      })
    })
    // Objectives — positioned at r~28
    coreState.objectives.forEach((o, i) => {
      const angle = (i / Math.max(coreState.objectives.length, 1)) * Math.PI * 2
      entities.push({
        id: o.id, type: 'objective', name: o.title,
        position: [Math.cos(angle) * 80, 0, Math.sin(angle) * 80],
        color: o.accentColor || '#6366f1', state: o.status,
      })
    })
    // Memories — positioned at r~42
    coreState.memories.forEach((m, i) => {
      const angle = (i / coreState.memories.length) * Math.PI * 2
      const r = 98 + (m.age || 0) * 14
      const yOffset = m.type === 'entity' ? 3 : m.type === 'fact' ? 1.5 : 0
      entities.push({
        id: m.id, type: 'memory', name: m.content.slice(0, 20),
        position: [Math.cos(angle) * r, yOffset, Math.sin(angle) * r],
        color: '#ec4899', state: 'idle',
      })
    })
    // Implants — positioned at r~8
    coreState.implants.forEach((imp, i) => {
      const angle = (i / coreState.implants.length) * Math.PI * 2
      entities.push({
        id: imp.id, type: 'implant', name: imp.name,
        position: [Math.cos(angle) * 7, 0, Math.sin(angle) * 7],
        color: imp.color, state: imp.health > 50 ? 'active' : imp.health > 0 ? 'degraded' : 'offline',
      })
    })
    return entities
  }, [coreState.agents, coreState.objectives, coreState.memories, coreState.implants])

  const [activeDepth, setActiveDepth] = useState('eq')
  const zoneEnteredAt = useRef(Date.now())
  const handleZoneChange = useCallback((zone) => {
    // Record dwell time for the zone we're leaving
    const dwell = Date.now() - zoneEnteredAt.current
    if (dwell > 2000) recordZoneVisit(activeZone, dwell, activeDepth)
    zoneEnteredAt.current = Date.now()
    setActiveZone(zone)
  }, [activeZone, activeDepth])

  const handleToggle = useCallback((key) => {
    setVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      cc3dAudit.layerToggle(key, next[key])
      return next
    })
    setActivePreset(null)
  }, [])

  const handlePreset = useCallback((name) => {
    const p = LAYER_PRESETS[name]
    if (p) {
      setVisible(p)
      setActivePreset(name)
    }
  }, [])

  const cyclePreset = useCallback(() => {
    setActivePreset((prev) => {
      const idx = PRESET_NAMES.indexOf(prev)
      const next = PRESET_NAMES[(idx + 1) % PRESET_NAMES.length]
      setVisible(LAYER_PRESETS[next])
      return next
    })
  }, [])

  const handleZoneJump = useCallback((position) => {
    if (position && Array.isArray(position)) {
      setOrbitTarget(position)
      setSelected(null)
      cc3dAudit.navigate(activeZone, position, 'jump')
    }
  }, [activeZone])

  const handleResetView = useCallback(() => {
    setOrbitTarget([0, 0, 0])
    setSelected(null)
  }, [])

  const handleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {})
    }
  }, [])

  const handleHorusAlert = useCallback((anomaly) => {
    cc3dAudit.horusAlert(anomaly?.type, anomaly?.id, anomaly?.severity)
  }, [])

  const handleSearchResultsChange = useCallback((results, activeIdx) => {
    setSearchBeaconResults(results)
    setSearchBeaconIndex(activeIdx)
    if (results.length > 0) cc3dAudit.search(results[0]?.name || '', results.length)
  }, [])

  const handleSearchSelect = useCallback((entity) => {
    setSelected({ ...entity, role: entity.type })
    cc3dAudit.select(entity.type, entity.id, entity.name)
    if (entity.position) {
      setOrbitTarget(entity.position)
      setZoomToTarget(true)
      setTimeout(() => setZoomToTarget(false), 3000)
    }
  }, [])

  const [zoomToTarget, setZoomToTarget] = useState(false)
  const [orbitLocked, setOrbitLocked] = useState(false)
  const [minimapVisible, setMinimapVisible] = useState(true)
  const [searchBeaconResults, setSearchBeaconResults] = useState([])
  const [searchBeaconIndex, setSearchBeaconIndex] = useState(-1)
  const [activeTour, setActiveTour] = useState(null)
  const cancelTourRef = useRef(null)
  const [cameraState, setCameraState] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInitialPrompt, setChatInitialPrompt] = useState('')
  const [overlayMode, setOverlayMode] = useState('default')
  const [qualityTier, setQualityTier] = useState('high')
  const [showHelp, setShowHelp] = useState(false)
  const qualityCheckRef = useRef(0)

  // Auto-adjust quality based on FPS (check every 5s)
  useEffect(() => {
    if (fps === 0) return
    qualityCheckRef.current++
    if (qualityCheckRef.current % 5 !== 0) return // only check every 5 fps updates (~5s)
    const newTier = autoQualityTier(fps, qualityTier)
    if (newTier !== qualityTier) setQualityTier(newTier)
  }, [fps, qualityTier])
  const [speechBubbles, setSpeechBubbles] = useState([])
  const bubbleIdRef = useRef(0)

  // Agent speak → create speech bubble at agent's position
  const handleAgentSpeak = useCallback((agentId, text) => {
    // Find agent position from scanner entities
    const agent = coreState.agents.find(a => a.id === agentId)
    if (!agent) return
    // Compute position (same as AgentMesh)
    const role = agent.role || 'specialist'
    const agents = coreState.agents.filter(a => a.role === role)
    const idx = agents.findIndex(a => a.id === agentId)
    const total = agents.length || 1
    const angle = (idx / total) * Math.PI * 2
    const r = role === 'orchestrator' ? 0 : (role === 'manager' || role === 'analyst') ? 17 : 25
    const pos = role === 'orchestrator' ? [0, 2, 0] : [Math.cos(angle) * r, 0.5, Math.sin(angle) * r]

    const id = bubbleIdRef.current++
    setSpeechBubbles(prev => [...prev.slice(-4), {
      id, position: pos, text, color: agent.color || '#8b5cf6',
      agentName: agent.name,
    }])
  }, [coreState.agents])

  const handleDismissBubble = useCallback((id) => {
    setSpeechBubbles(prev => prev.filter(b => b.id !== id))
  }, [])
  const lastClickRef = useRef({ id: null, time: 0 })

  const handleSelect = useCallback((item) => {
    const now = Date.now()
    const isDoubleClick = item?.id === lastClickRef.current.id && (now - lastClickRef.current.time) < 400
    lastClickRef.current = { id: item?.id, time: now }

    setSelected(item)
    if (item) cc3dAudit.select(item.type, item.id, item.name)
    if (item?.position) {
      setOrbitTarget(item.position)
      // Double-click = zoom to target
      if (isDoubleClick) {
        setZoomToTarget(true)
        // Reset zoom flag after animation
        setTimeout(() => setZoomToTarget(false), 3000)
      } else {
        setZoomToTarget(false)
      }
    }
  }, [])

  const handleVoidClick = useCallback(() => {
    setSelected(null)
    setOrbitTarget([0, 0, 0])
  }, [])

  const handleInfoClose = useCallback(() => {
    setSelected(null)
    setOrbitTarget([0, 0, 0])
  }, [])

  const handleScannerSelect = useCallback((entity) => {
    setSelected({ ...entity, role: entity.type })
    if (entity.position) {
      setOrbitTarget(entity.position)
    }
  }, [])

  // Request fullscreen on mount
  useEffect(() => {
    const el = document.documentElement
    if (el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => { /* user declined or not allowed */ })
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // Skip if focus is on an input field
      const tag = document.activeElement?.tagName
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      if (e.key === 'Escape') {
        if (cancelTourRef.current) { cancelTourRef.current(); cancelTourRef.current = null; setActiveTour(null); return }
        if (searchOpen) { setSearchOpen(false); return }
        if (selected) { setSelected(null); setOrbitTarget([0, 0, 0]); return }
        if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}) }
        return
      }

      if (showHelp) { setShowHelp(false); return }
      if (isInput || searchOpen) return
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) { setShowHelp(true); return }

      // Camera bookmarks: Ctrl+1-9 save, 1-9 load
      const numKey = parseInt(e.key)
      if (numKey >= 1 && numKey <= 9) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const camPos = cameraState?.position || [0, 12, 60]
          saveBookmark(numKey, camPos, orbitTarget)
        } else {
          const bm = loadBookmark(numKey)
          if (bm) {
            setOrbitTarget(bm.target)
            setSelected(null)
            cc3dAudit.navigate('bookmark', bm.position, `bookmark-${numKey}`)
          }
        }
        return
      }

      if (e.key === '/' ) {
        e.preventDefault()
        setSearchOpen((prev) => !prev)
      } else if (e.key === 'l' || e.key === 'L') {
        cyclePreset()
      } else if (e.key === 'h' || e.key === 'H') {
        setHudHidden((prev) => !prev)
      } else if (e.key === '`') {
        setPerfHudVisible((prev) => !prev)
      } else if (e.key === 'c' || e.key === 'C') {
        setChatOpen((prev) => !prev)
      } else if (e.key === 's' || e.key === 'S') {
        setVisible((prev) => ({ ...prev, simulation: !prev.simulation }))
      } else if (e.key === 'p' || e.key === 'P') {
        setVisible((prev) => ({ ...prev, floatingPanels: !prev.floatingPanels }))
      } else if (e.key === 'o' || e.key === 'O') {
        setOverlayMode(prev => {
          const idx = OVERLAY_MODES.indexOf(prev)
          return OVERLAY_MODES[(idx + 1) % OVERLAY_MODES.length]
        })
      } else if (e.key === 't' || e.key === 'T') {
        // Cycle tours: welcome → health → infra → investor → (cancel)
        const tourIds = Object.keys(TOURS)
        const currentIdx = activeTour ? tourIds.indexOf(activeTour) : -1
        const nextIdx = currentIdx + 1
        // Cancel current tour
        if (cancelTourRef.current) { cancelTourRef.current(); cancelTourRef.current = null }
        if (nextIdx >= tourIds.length) {
          setActiveTour(null)
        } else {
          const tourId = tourIds[nextIdx]
          setActiveTour(tourId)
          cc3dAudit.tourStart(tourId)
          cancelTourRef.current = runTour(tourId, {
            onStop: () => {},
            onNavigate: (pos) => handleZoneJump(pos),
            onComplete: () => { setActiveTour(null); cancelTourRef.current = null },
          })
        }
      } else if (e.key === 'd' || e.key === 'D') {
        // Cycle depth: eq → deep → sky → eq
        setActiveDepth(prev => {
          const order = ['eq', 'deep', 'sky']
          const next = order[(order.indexOf(prev) + 1) % order.length]
          // Also jump camera to the depth position
          const depthPositions = { sky: [0, 30, 50], eq: [0, 5, 60], deep: [12, -12, 22] }
          handleZoneJump(depthPositions[next])
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, selected, cyclePreset, showHelp, activeTour, cameraState, orbitTarget, handleZoneJump])

  // Deep link: navigate to entity from URL params on mount
  useEffect(() => {
    if (depthParam && ['sky', 'eq', 'deep'].includes(depthParam)) setActiveDepth(depthParam)
    if (entityParam && scannerEntities.length > 0) {
      const found = scannerEntities.find(e => e.id === entityParam || e.name?.toLowerCase() === entityParam.toLowerCase())
      if (found) {
        handleSelect(found)
        if (found.position) { setOrbitTarget(found.position); setZoomToTarget(true); setTimeout(() => setZoomToTarget(false), 3000) }
      }
    }
  }, [entityParam, depthParam, scannerEntities.length]) // eslint-disable-line

  // Persist settings on change
  useEffect(() => { saveSettings(settings) }, [settings])

  const handleSettingChange = useCallback((key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      saveSettings(next)
      return next
    })
  }, [])

  const handleFps = useCallback((f) => setFps(f), [])

  const gaugeData = useMemo(() => {
    const activeAgents = coreState.agents.filter(a => a.state && a.state !== 'idle').length
    const healthyImplants = coreState.implants.filter(i => !i.locked && i.health > 0)
    const avgHealth = healthyImplants.length > 0
      ? healthyImplants.reduce((sum, i) => sum + (i.health || 0), 0) / healthyImplants.length
      : 0
    const allTasks = coreState.objectives.flatMap(o => o.tasks || [])
    const runningTasks = allTasks.filter(t => t.status === 'running').length
    return {
      agentCount: activeAgents,
      totalAgents: coreState.agents.length,
      objectiveCount: coreState.objectives.length,
      memoryCount: coreState.memories.length,
      implantHealth: avgHealth,
      taskCount: runningTasks,
      totalTasks: allTasks.length,
    }
  }, [coreState.agents, coreState.objectives, coreState.memories, coreState.implants])

  const visibleCount = useMemo(() => Object.values(visible).filter(Boolean).length, [visible])
  const zoneName = ZONE_LABEL_MAP[activeZone] || activeZone

  return (
    <div className="cc3d-scene" style={{ position: 'fixed', inset: 0, background: '#050510', overflow: 'hidden' }}>
      {/* Data bridge — loads in separate chunk, calls useCogCore3DState, pipes data up */}
      <Suspense fallback={null}>
        <CogCore3DDataBridge onData={handleData} />
      </Suspense>
      <CC3DErrorBoundary>
      <Canvas
        camera={{ position: [0, 12, 60], fov: 60, near: 0.1, far: 800 }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.2,
        }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Suspense fallback={null}>
          <CognitiveCore
            settings={settings}
            visible={visible}
            overlayMode={overlayMode}
            systemState={coreState.systemState}
            agents={coreState.agents}
            objectives={coreState.objectives}
            implants={coreState.implants}
            memories={coreState.memories}
            agentPositions={coreState.agentPositions}
            aeeEnvelopes={coreState.aeeEnvelopes || []}
            voltRuns={coreState.voltRuns || []}
            aoclStats={coreState.aoclStats || []}
            currentFocus={coreState.currentFocus}
            speechBubbles={speechBubbles}
            onDismissBubble={handleDismissBubble}
            searchResults={searchBeaconResults}
            searchActiveIndex={searchBeaconIndex}
            onHorusAlert={handleHorusAlert}
            activeImplantCount={coreState.activeImplantCount}
            orbitTarget={orbitTarget}
            onSelect={handleSelect}
            onVoidClick={handleVoidClick}
            onZoneChange={handleZoneChange}
            delegations={delegations}
            onZoneSelect={handleZoneJump}
            zoomToTarget={zoomToTarget}
            orbitLocked={orbitLocked}
            onCameraUpdate={setCameraState}
          />
          <FpsCounter onFps={handleFps} />
          <GlInfoReporter onGlInfo={setGlInfo} />
        </Suspense>
      </Canvas>
      </CC3DErrorBoundary>

      {!hudHidden && (
        <>
          <EliteHUD systemState={coreState.systemState} activeZone={activeZone} gaugeData={gaugeData} />
          <PulseBar agentCount={coreState.agents.length} objectiveCount={coreState.objectives.length} memoryCount={coreState.memories.length} isLive={coreState.isLive} />
          <ZoneLabel activeZone={activeZone} activeDepth={activeDepth} />
          {overlayMode !== 'default' && (
            <div style={{
              position: 'fixed', top: 66, left: '50%', transform: 'translateX(-50%)',
              zIndex: 19, pointerEvents: 'none',
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: OVERLAY_COLORS[overlayMode] || '#8b5cf6',
              opacity: 0.6,
            }}>
              OVERLAY: {OVERLAY_LABELS[overlayMode]}
            </div>
          )}
          {/* Quick action buttons in top bar area */}
          <div style={{
            position: 'fixed', top: 14, right: 80, zIndex: 21,
            display: 'flex', alignItems: 'center',
          }}>
            <QuickActions
              onSearch={() => setSearchOpen(prev => !prev)}
              onPreset={cyclePreset}
              onToggleHud={() => setHudHidden(true)}
              onFullscreen={handleFullscreen}
            />
          </div>
          {minimapVisible && (
            <ScannerDisc
              entities={scannerEntities}
              selectedId={selected?.id || null}
              onSelect={handleScannerSelect}
              size={440}
              camera={cameraState}
            />
          )}
          <BottomControls
            minimapVisible={minimapVisible}
            onToggleMinimap={() => setMinimapVisible(p => !p)}
            orbitLocked={orbitLocked}
            onToggleOrbitLock={() => setOrbitLocked(p => !p)}
            gridVisible={visible.holoGrid}
            onToggleGrid={() => handleToggle('holoGrid')}
            particlesVisible={visible.particles}
            onToggleParticles={() => handleToggle('particles')}
            perfHudVisible={perfHudVisible}
            onTogglePerfHud={() => setPerfHudVisible(p => !p)}
            shellVisible={visible.shell}
            onToggleShell={() => handleToggle('shell')}
            onResetView={handleResetView}
            visible={visible}
            settings={settings}
            activePreset={activePreset}
            onLoadSlot={(slot) => {
              if (slot.visible) setVisible(prev => ({ ...prev, ...slot.visible }))
              if (slot.settings) setSettings(slot.settings)
              if (slot.activePreset) setActivePreset(slot.activePreset)
            }}
          />
          <SidebarRail
            visible={visible}
            onToggle={handleToggle}
            activePreset={activePreset}
            onPreset={handlePreset}
            onZoneJump={handleZoneJump}
            onSearch={() => setSearchOpen(prev => !prev)}
            onResetView={handleResetView}
            settings={settings}
            onSettingChange={handleSettingChange}
            activeDepth={activeDepth}
            onDepthChange={setActiveDepth}
          />
          <InfoPanel selected={selected} onClose={handleInfoClose} onAskCorey={(prompt) => { setChatInitialPrompt(prompt); setChatOpen(true) }} />
          <SpatialChat
            open={chatOpen}
            onClose={() => { setChatOpen(false); setChatInitialPrompt('') }}
            initialPrompt={chatInitialPrompt}
            onAgentSpeak={handleAgentSpeak}
            onNavigate={(query) => {
              const lower = query.toLowerCase()
              const found = coreState.agents.find(a => lower.includes(a.id) || lower.includes(a.name.toLowerCase()))
              if (found) handleSelect(found)
            }}
            cc3dContext={{
              activeZone,
              activeDepth,
              selectedEntity: selected ? { name: selected.name, type: selected.type, id: selected.id } : null,
              anomalyCount: coreState.agents?.filter(a => a.state === 'blocked').length || 0,
              agentCount: coreState.agents?.length || 0,
              implantCount: coreState.implants?.length || 0,
            }}
            onTourStart={(stops) => {
              // HORUS-driven tour: run stops from guided_tour tool
              if (cancelTourRef.current) { cancelTourRef.current(); cancelTourRef.current = null }
              setActiveTour('horus')
              cc3dAudit.tourStart('horus-dynamic')
              let cancelled = false
              let timer = null
              let stopIdx = 0
              const playStop = () => {
                if (cancelled || stopIdx >= stops.length) { setActiveTour(null); cancelTourRef.current = null; return }
                const stop = stops[stopIdx]
                handleZoneJump(stop.position)
                cc3dAudit.horusAlert('witness', stop.label, 'info')
                stopIdx++
                timer = setTimeout(playStop, (stop.dwell || 5) * 1000)
              }
              playStop()
              cancelTourRef.current = () => { cancelled = true; clearTimeout(timer); setActiveTour(null) }
            }}
          />
          <CoreyNotifier isLive={coreState.isLive} agentCount={coreState.agents.length} implantCount={coreState.implants.length} objectives={coreState.objectives} agents={coreState.agents} implants={coreState.implants} systemState={coreState.systemState} />
          {!perfHudVisible && <FpsDisplay fps={fps} />}
          {perfHudVisible && (
            <PerformanceHUD fps={fps} presetName={activePreset} zoneName={zoneName} visibleCount={visibleCount} glInfo={glInfo} />
          )}
        </>
      )}

      {/* Glass cockpit overlay — subtle window frame effect */}
      <div className="cc3d-cockpit-glass" />

      {/* Offline/reconnecting indicator */}
      {!coreState.isLive && (
        <div style={{
          position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)',
          zIndex: 25, padding: '4px 12px', borderRadius: 4,
          background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.08em',
          color: '#ef4444', textTransform: 'uppercase',
        }}>
          OFFLINE — Using cached data
        </div>
      )}

      {/* Accessibility: screen reader live region */}
      <div className="cc3d-sr-only" aria-live="polite" aria-atomic="true">
        {`Cognitive Core 3D. Zone: ${zoneName}. Depth: ${activeDepth}. `}
        {selected ? `Selected: ${selected.name}, ${selected.type}, ${selected.state || 'unknown'}.` : 'No selection.'}
        {` ${coreState.agents?.length || 0} agents. ${coreState.isLive ? 'Live data.' : 'Cached data.'}`}
        {overlayMode !== 'default' ? ` Overlay: ${overlayMode}.` : ''}
      </div>

      {/* Keyboard help overlay (? key) */}
      {showHelp && (
        <div onClick={() => setShowHelp(false)} style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--cc3d-glass-bg-heavy, rgba(5,5,16,0.95))', borderRadius: 8,
            border: '1px solid rgba(139,92,246,0.25)', padding: '20px 28px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.8)',
            maxWidth: 400, lineHeight: 2,
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: '#8b5cf6' }}>Keyboard Shortcuts</div>
            <div><kbd>/</kbd> Search &nbsp; <kbd>L</kbd> Presets &nbsp; <kbd>H</kbd> HUD</div>
            <div><kbd>D</kbd> Depth &nbsp; <kbd>O</kbd> Overlay &nbsp; <kbd>T</kbd> Tour</div>
            <div><kbd>S</kbd> Simulation &nbsp; <kbd>P</kbd> Panels &nbsp; <kbd>C</kbd> Chat</div>
            <div><kbd>1-9</kbd> Bookmarks &nbsp; <kbd>Ctrl+1-9</kbd> Save</div>
            <div><kbd>`</kbd> Perf HUD &nbsp; <kbd>Esc</kbd> Cancel/Close</div>
            <div style={{ color: 'rgba(255,255,255,0.3)', marginTop: 8, fontSize: 9 }}>Press any key to close</div>
          </div>
        </div>
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} entities={scannerEntities} onSelect={handleSearchSelect} onResultsChange={handleSearchResultsChange} />
    </div>
  )
}

// ─── Main Export ─────────────────────────────────────────
export default function CognitiveCore3DView() {
  const diag = usePluginLicenseDiagnosis('cogcore3d')
  const [searchParams] = useSearchParams()
  const preset = searchParams.get('preset') || null
  const objectiveId = searchParams.get('objective') || null
  const entityParam = searchParams.get('entity') || null
  const depthParam = searchParams.get('depth') || null

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Cognitive Core 3D" accentColor="#8b5cf6" />
  }

  return <LicensedView preset={preset} objectiveId={objectiveId} entityParam={entityParam} depthParam={depthParam} />
}
