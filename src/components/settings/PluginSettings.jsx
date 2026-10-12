/**
 * PluginSettings Component
 *
 * Main plugin management panel for Settings.
 * Features:
 * - Core platform hero panel (full-width, top)
 * - Search filter (instant, by name/description)
 * - Category filter pills
 * - License status tabs (All / Licensed / Unlicensed)
 * - Plugin grid with consistent card states
 * - License activation (contextual — hidden when licensed)
 * - Trial key generation
 * - Activation celebration animation (ripple burst)
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import PluginCard, { getPluginGlyph } from './PluginCard'
import LicenseActivation from './LicenseActivation'
import PluginConfigModal from './PluginConfigModal'
import FreeClaimPanel from './FreeClaimPanel'
import QHorn from '../ui/QHorn'
import './PluginSettings.css'
import {
  getLicenseStatus,
  getPlugins,
  enablePlugin,
  disablePlugin,
  getTierDisplayName,
  activateLicense
} from '../../services/pluginClient'
import {
  isPluginLicensed,
  isGovernedPlugin,
  getLicenseStatus as getLocalLicenseStatus
} from '../../services/licenseValidator'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { refreshPluginState } from '../../services/visualizationService'
import { getAllPluginManifests } from '../../config/plugins'
import { getInstalledPlugins, getPluginManifest, clearPluginCache, arePluginsHydrated, isInstalledPluginOfficial } from '../../services/thirdPartyPluginHost'
import ErrorBoundary from '../ErrorBoundary'
import ThirdPartyPluginCard from '../plugins/ThirdPartyPluginCard'
import ThirdPartyPluginInstaller from '../plugins/ThirdPartyPluginInstaller'
import {
  COMMUNITY_PLUGIN_TRUST_DETAIL,
  COMMUNITY_PLUGIN_TRUST_NOTICE,
  TRUSTED_ADMIN_ONLY_LABEL
} from '../../services/pluginTrustModel'

// Celebration particle burst on plugin activation
function CelebrationBurst({ position, onDone }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !position) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvas.offsetWidth * dpr
    canvas.height = canvas.offsetHeight * dpr
    ctx.scale(dpr, dpr)

    const particles = Array.from({ length: 24 }, () => ({
      x: position.x,
      y: position.y,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8 - 2,
      radius: Math.random() * 3 + 1.5,
      color: ['#34d399', '#10b981', '#6ee7b7', '#a78bfa', '#60a5fa'][Math.floor(Math.random() * 5)],
      life: 1,
      decay: Math.random() * 0.015 + 0.012
    }))

    let frame
    const animate = () => {
      ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight)
      let alive = false
      particles.forEach(p => {
        if (p.life <= 0) return
        alive = true
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.12
        p.life -= p.decay
        // The guard above ran BEFORE this decrement, so life can be negative
        // here: a particle at life 0.008 with decay 0.02 passes the check and
        // arrives at -0.012. `radius * life` is then a negative radius and
        // canvas throws IndexSizeError, killing the whole plugins screen.
        // Seen live as "radius provided (-0.0187372) is negative".
        if (p.life <= 0) return
        ctx.globalAlpha = Math.max(0, p.life)
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0, p.radius * p.life), 0, Math.PI * 2)
        ctx.fillStyle = p.color
        ctx.fill()
      })
      if (alive) {
        frame = requestAnimationFrame(animate)
      } else {
        onDone?.()
      }
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [position, onDone])

  if (!position) return null
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999,
        width: '100vw', height: '100vh'
      }}
    />
  )
}

// Category order for consistent display
const CATEGORY_ORDER = [
  'Infrastructure',
  'Monitoring',
  'Operations',
  'AI & Intelligence',
  'Productivity',
  'Compliance & Audit',
  'Communication',
]

// Category icons (small inline SVG paths)
const CATEGORY_ICONS = {
  'Infrastructure': 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  'Monitoring': 'M22 12h-4l-3 9L9 3l-3 9H2',
  'Operations': 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01',
  'AI & Intelligence': 'M12 2a10 10 0 100 20 10 10 0 000-20z M2 12h20 M12 2a15 15 0 014 10 15 15 0 01-4 10 15 15 0 01-4-10 15 15 0 014-10z',
  'Productivity': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8',
  'Compliance & Audit': 'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  'Communication': 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 01-3.46 0',
}

// Priority order for sorting within categories
const PLUGIN_PRIORITY = {
  'quoxmind-complete': 1, 'quoxmind-pro': 2,
  'advanced-memory': 3, 'cognitive-topology': 4, 'web-terminal': 5,
  'quoxagent-fleet': 6, 'bastion-fleet': 7, 'docker-fleet': 8,
  'opsdeck': 9, 'wazuh': 10, 'aocl-compliance-suite': 10,
  'aocl-developer-kit': 11, 'proxmox': 12, 'backup-restore': 13,
  'codebase-mirror': 14, 'advanced-voice': 15, 'files': 16,
  'core-comms': 17, 'mikrotik-routeros': 18, 'prometheus': 19,
  'grafana': 20, 'uptime-kuma': 21, 'system-maintenance': 22,
  'workflow-library': 23, 'action-tracker': 24, 'prompts-library': 25
}

// The "Core" plugin name — gets the hero treatment
const CORE_PLUGIN = 'system-maintenance'

// ─── Board-vision furniture (LICENSE-LAUNCH LL-8 v1, owner-approved mockup) ──
// The governed concepts that ship WITH QuoxCORE itself (not separate plugin
// rows) — shown as small always-there chips on the hero, same list + accents
// as the blessed /qx-lab/store prototype (QxLabStoreView.jsx). Presentational
// only: there is no separate per-concept entitlement to check, activating
// core is what lights every one of these.
const CORE_SYSTEMS = [
  { id: 'agents', name: 'AGENTS', c: '#38bdf8', d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75' },
  { id: 'flow', name: 'FLOW', c: '#a855f7', d: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9' },
  { id: 'vault', name: 'VAULT', c: '#fbbf24', d: 'M3 11h18v11H3z M7 11V7a5 5 0 0 1 10 0v4' },
  { id: 'hitl', name: 'HITL', c: '#34d399', d: 'M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' },
  { id: 'evidence', name: 'EVIDENCE', c: '#22d3ee', d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4' },
  { id: 'qloop', name: 'QLOOP', c: '#f97316', d: 'M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3' },
]

// Growth levels for the hero pill — driven by the REAL licensed-plugin count
// (licensedCount below), not mock state. Same ladder as the store prototype.
const HERO_LEVELS = [
  { at: 0, name: 'Core Online' }, { at: 3, name: 'Operator' },
  { at: 6, name: 'Command Deck' }, { at: 9, name: 'Flagship' },
]
const heroLevelFor = (n) => HERO_LEVELS.reduce((a, l) => (n >= l.at ? l : a), HERO_LEVELS[0])
const heroLevelIdx = (n) => HERO_LEVELS.indexOf(heroLevelFor(n))

const BOLT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
)
const CHEV_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

/**
 * PluginBoard — a collapsible board-vision section: glass panel, PCB
 * substrate, a bus rail that lights up when anything on it is seated, and
 * a chip grid of the real PluginCard components. Purely a presentation
 * shell around real plugin data passed in by the caller (LICENSE-LAUNCH
 * LL-8 v1) — no logic of its own, no mock state, mirrors the Board shape
 * already blessed in QxLabStoreView.jsx.
 */
function PluginBoard({ title, silk, pill, power = 0, live, defaultOpen = true, children, count }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!count) return null
  return (
    <section className="qx-card" style={{ padding: 12 }}>
      <div className="qx-board qx-board--flow" style={{ '--qx-board-power': power }}>
        <button type="button" className="qx-board__head" onClick={() => setOpen(o => !o)}>
          <span className="qx-board__title">{title}</span>
          <span className="qx-board__silkname">{silk}</span>
          <span className="qx-pill" style={{ marginLeft: 'auto' }}>{pill}</span>
          <span className={`qx-board__chev ${open ? '' : 'qx-board__chev--closed'}`}>{CHEV_ICON}</span>
        </button>
        <div className={`qx-busrail ${live ? 'qx-busrail--live' : ''}`} />
        {open && <div className="qx-chipgrid">{children}</div>}
      </div>
    </section>
  )
}

export default function PluginSettings({ onPluginChange, highlightPlugin }) {
  const { authFetch } = useAuth()
  // GATE-INSTALL-UI: the backend admin gate on plugin install/activate/backend
  // routes (requireAdminRole, see services/collector) is the real enforcement
  // and stays the source of truth. isOrgAdmin here only decides whether we
  // present the affordance at all — it exists so a non-admin is never led
  // into a multi-step install flow that the server will refuse partway
  // through (or, worse, one that "succeeds" locally while its backend never
  // starts). Removing this gate would not weaken security; it would just
  // bring back the confusing dead-end.
  const { isOrgAdmin } = useWorkspace()
  const navigate = useNavigate()
  const [licenseStatus, setLicenseStatus] = useState(null)
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [apiOffline, setApiOffline] = useState(false)
  const [showLicenseModal, setShowLicenseModal] = useState(false)
  const [pendingLicensePluginName, setPendingLicensePluginName] = useState(null)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [configPluginName, setConfigPluginName] = useState(null)
  const [showFreeClaimPanel, setShowFreeClaimPanel] = useState(false)
  const [freeClaimPlugins, setFreeClaimPlugins] = useState([])
  // LICENSE-LAUNCH LL-8: names to burst-celebrate on the real cards, held
  // until the panel actually closes (see handleFreeClaimed / triggerCardBurst)
  // so the in-modal cascade and the card burst don't fire at once behind
  // the modal overlay where the card burst can't even be seen.
  const [pendingCardBurst, setPendingCardBurst] = useState([])
  const [notification, setNotification] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(null)
  const [celebrationPos, setCelebrationPos] = useState(null)
  const [justActivated, setJustActivated] = useState(null)
  const [showInstaller, setShowInstaller] = useState(false)
  const [thirdPartyPlugins, setThirdPartyPlugins] = useState([])
  const [thirdPartyVersion, setThirdPartyVersion] = useState(0)
  const [coreDisableConfirm, setCoreDisableConfirm] = useState(false)
  const searchRef = useRef(null)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const pluginResult = await getPlugins().catch(() => ({ plugins: [], offline: true }))
      const localLicense = getLocalLicenseStatus()
      const license =
        pluginResult?.offline || localLicense?.licensed
          ? { ...localLicense, source: 'local', offline: Boolean(pluginResult?.offline) }
          : await getLicenseStatus()
      const agentPlugins = pluginResult?.plugins || []
      const offline = Boolean(license?.offline || pluginResult?.offline)

      const manifests = getAllPluginManifests()
      const mergedPlugins = manifests.map(manifest => {
        const agentStatus = agentPlugins.find(p => p.name === manifest.name)
        // LICENSE-LAUNCH LL-6c: the entitlement is the AUTHORITY here.
        // `agentStatus.licensed` (the QuoxAgent plugin row from getPlugins())
        // used to be ORed in, so an agent row claiming licensed=true rendered
        // a paid, unleased plugin as active — a second, weaker authority
        // overruling the signed-lease gate. It no longer votes.
        // LICENSE-LAUNCH LL-8: free plugins are licence-governed too. The
        // `|| manifest.tier === 'free'` short-circuit that used to live here
        // rendered every free-tier manifest active regardless of entitlement,
        // a false claim, since the free tier gets a one-click self-serve
        // claim (FreeClaimPanel), not an exemption from the gate. A governed
        // free plugin with no claimed entitlement is "claimable": locked,
        // but with a same-session unlock instead of a paid key.
        const licensed = isPluginLicensed(manifest.name)
        const claimable = !licensed && manifest.tier === 'free' && isGovernedPlugin(manifest.name)
        let enabled = agentStatus?.enabled ?? licensed
        try {
          const extState = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}')
          if (extState[manifest.name] !== undefined) enabled = extState[manifest.name]
        } catch { /* ignore */ }

        return {
          name: manifest.name,
          displayName: manifest.displayName,
          // Carried so PluginCard can fall back to the manifest's colour
          // instead of grey for plugins absent from its hardcoded icon map.
          accentColor: manifest.accentColor,
          version: manifest.version,
          description: manifest.shortDescription || manifest.description,
          tier: manifest.tier,
          price: manifest.price,
          priceDisplay: manifest.priceDisplay,
          featured: manifest.featured,
          badge: manifest.badge,
          category: manifest.category || 'Other',
          enabled,
          licensed,
          claimable,
          status: licensed ? (enabled ? 'active' : 'inactive') : (claimable ? 'claimable' : 'unlicensed'),
          capabilities: agentStatus?.capabilities || [],
          marketingPoints: manifest.marketingPoints,
          features: manifest.features,
          infoUrl: manifest.infoUrl
        }
      })

      // Only merge agent plugins that have manifests — ghost plugins
      // (core, noc, soc, visualizations) from QuoxAgent are internal
      // and should not appear in the UI without a manifest
      agentPlugins.forEach(ap => {
        if (!manifests.find(m => m.name === ap.name) && ap.displayName) {
          mergedPlugins.push({ ...ap, category: ap.category || 'Other' })
        }
      })

      setLicenseStatus(license)
      setPlugins(mergedPlugins)
      setApiOffline(offline)
    } catch (err) {
      console.error('Failed to load plugin data:', err)
      setApiOffline(true)
      const manifests = getAllPluginManifests()
      const localLicense = getLocalLicenseStatus()
      let offlineExtState = {}
      try { offlineExtState = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}') } catch { /* ignore */ }
      setLicenseStatus(localLicense)
      setPlugins(manifests.map(m => {
        const licensed = isPluginLicensed(m.name)
        // LICENSE-LAUNCH LL-8: entitlements are unreachable here (both
        // QuoxAgent and the local license cache came back empty), so a
        // governed free plugin's claim state cannot be proven either way.
        // Do not guess it active (the old free-tier short-circuit) or
        // claimable (the claim flow itself needs a live server): say so.
        const indeterminateFree = !licensed && m.tier === 'free' && isGovernedPlugin(m.name)
        return {
          name: m.name,
          displayName: m.displayName,
          accentColor: m.accentColor,
          version: m.version,
          description: m.shortDescription || m.description,
          tier: m.tier,
          price: m.price,
          priceDisplay: m.priceDisplay,
          featured: m.featured,
          badge: m.badge,
          category: m.category || 'Other',
          enabled: offlineExtState[m.name] ?? licensed,
          licensed,
          claimable: false,
          status: licensed ? 'active' : (indeterminateFree ? 'unknown' : 'unlicensed'),
          capabilities: [],
          marketingPoints: m.marketingPoints,
          features: m.features
        }
      }))
      if (localLicense.licensed) {
        showNotification('QuoxAgent offline — using local license', 'info')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Load third-party plugins list
  useEffect(() => {
    async function loadThirdParty() {
      const installed = getInstalledPlugins()
      // Per-plugin catch: one plugin's manifest read (IndexedDB miss/corrupt
      // record) must never reject the whole list and blank the section.
      // LICENSE-LAUNCH LL-8 v1: `official` is the VERIFIED (signed) status,
      // not manifest.official alone — see isInstalledPluginOfficial. It is
      // what separates genuine community installs from first-party bundles
      // delivered through this same install pipe (LL-7 strip).
      const withManifests = await Promise.all(installed.map(async p => {
        try {
          const manifest = await getPluginManifest(p.pluginId)
          const official = await isInstalledPluginOfficial(p.pluginId)
          return { ...p, manifest, official }
        } catch (err) {
          console.warn(`[PluginSettings] manifest read failed for ${p.pluginId}:`, err)
          return { ...p, manifest: null, official: false }
        }
      }))
      setThirdPartyPlugins(withManifests)
    }
    loadThirdParty().catch(err => console.error('[PluginSettings] third-party load failed:', err))
  }, [thirdPartyVersion])

  // Server hydration of installed third-party plugins settles asynchronously
  // AFTER this component mounts (loadInstalledPlugins fetches the org's server
  // registry a few seconds into boot). The synchronous getInstalledPlugins()
  // read above returns an empty in-memory mirror on a fresh cache, so without
  // this the Community Plugins section renders "0 / none installed" even though
  // the plugins are safely stored server-side and already activating. Re-read
  // when the host signals hydration is done. Guard covers the race where
  // hydration finished before this component mounted (event already fired).
  useEffect(() => {
    const onLoaded = () => setThirdPartyVersion(v => v + 1)
    window.addEventListener('quox-plugins-loaded', onLoaded)
    if (arePluginsHydrated()) onLoaded()
    return () => window.removeEventListener('quox-plugins-loaded', onLoaded)
  }, [])

  useEffect(() => {
    const handler = () => loadData()
    window.addEventListener('quox-settings-change', handler)
    return () => window.removeEventListener('quox-settings-change', handler)
  }, [loadData])

  // GATE-INSTALL-UI: activateThirdPartyPlugin() returns success as soon as
  // the plugin's bundle is running locally — starting a backend-declaring
  // plugin's container is a non-blocking follow-up call. If that call comes
  // back 401/403 (e.g. a stale session, or a role change mid-session dropped
  // the caller below admin) thirdPartyPluginHost previously only logged it
  // to console, so a plugin could sit "active" with a backend that will
  // never run and nothing on screen said so. Surface it as a real
  // notification instead.
  useEffect(() => {
    const handler = (e) => {
      const { message, name, pluginId } = e.detail || {}
      showNotification(message || `${name || pluginId || 'Plugin'} backend could not start — admin permission required`, 'error')
    }
    window.addEventListener('quox-plugin-backend-denied', handler)
    return () => window.removeEventListener('quox-plugin-backend-denied', handler)
  }, [])

  useEffect(() => {
    if (highlightPlugin) {
      showNotification(`Activate "${highlightPlugin}" plugin to unlock premium features`, 'info')
    }
  }, [highlightPlugin])

  // Keyboard shortcut: Cmd/Ctrl+F focuses search
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }

  const handleEnable = async (name, cardElement) => {
    const result = await enablePlugin(name)
    if (result.success) {
      if (cardElement) {
        const rect = cardElement.getBoundingClientRect()
        setCelebrationPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 })
        setJustActivated(name)
        setTimeout(() => setJustActivated(null), 1200)
      }
      showNotification(`${name} enabled`, 'success')
      await loadData()
      await refreshPluginState()
      onPluginChange?.()
    } else {
      showNotification(result.error || 'Failed to enable plugin', 'error')
    }
  }

  const handleDisable = async (name) => {
    const result = await disablePlugin(name)
    if (result.success) {
      showNotification(`${name} disabled`, 'success')
      await loadData()
      await refreshPluginState()
      onPluginChange?.()
    } else {
      showNotification(result.error || 'Failed to disable plugin', 'error')
    }
  }

  const handleGetLicense = (pluginName) => {
    setPendingLicensePluginName(pluginName)
    showNotification(`Enter a license key to unlock ${pluginName}`, 'info')
    setShowLicenseModal(true)
  }

  // LICENSE-LAUNCH LL-8: opens FreeClaimPanel with every currently-claimable
  // governed free plugin (the conversion-ladder cascade: one approval
  // unlocks all of them), the clicked plugin sorted first. Each entry
  // carries the same accent + glyph the card itself renders, so the
  // panel's unlock cascade chips visually match the cards they unlock.
  const handleClaimFree = (pluginName) => {
    const claimableNow = plugins.filter(p => p.claimable)
    const ordered = [
      ...claimableNow.filter(p => p.name === pluginName),
      ...claimableNow.filter(p => p.name !== pluginName)
    ]
    if (ordered.length === 0) {
      // Fallback for a stale click (e.g. right after a manifest refresh):
      // still let the user claim the plugin they actually clicked.
      const manifest = getAllPluginManifests().find(m => m.name === pluginName)
      if (manifest) ordered.push({ name: manifest.name, displayName: manifest.displayName, accentColor: manifest.accentColor })
    }
    setFreeClaimPlugins(ordered.map(p => {
      const { glyphPath, accent } = getPluginGlyph(p.name, p.accentColor)
      return { name: p.name, displayName: p.displayName, accent, glyphPath }
    }))
    setShowFreeClaimPanel(true)
  }

  // Staggered card-burst, extracted so it can be deferred until the claim
  // panel actually closes (see handleFreeClaimed) instead of firing behind
  // a still-open modal where it can't be seen. The panel's own in-modal
  // cascade is the beat the user sees first, this is the beat they see
  // when they dismiss it.
  const triggerCardBurst = useCallback((names) => {
    names.forEach((name, idx) => {
      setTimeout(() => {
        const card = document.querySelector(`[data-plugin-name="${name}"]`)
        if (card) {
          const rect = card.getBoundingClientRect()
          setCelebrationPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 })
          setJustActivated(name)
          setTimeout(() => setJustActivated(null), 1200)
        }
      }, idx * 180)
    })
  }, [])

  const handleFreeClaimed = async () => {
    // Snapshot which plugins were claimable before the reload
    const wereClaimable = new Set(plugins.filter(p => p.claimable).map(p => p.name))

    let extState = {}
    try { extState = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}') } catch { /* ignore */ }

    await loadData()

    const freshManifests = getAllPluginManifests()
    const nowUnlocked = freshManifests
      .map(m => m.name)
      .filter(name => wereClaimable.has(name) && isPluginLicensed(name))

    const toEnable = nowUnlocked.filter(name => extState[name] !== false)
    if (toEnable.length > 0) {
      await Promise.all(toEnable.map(name => enablePlugin(name)))
      await loadData()
    }

    await refreshPluginState()
    onPluginChange?.()

    if (nowUnlocked.length > 0) {
      showNotification(
        `Claimed: ${nowUnlocked.length} free plugin${nowUnlocked.length === 1 ? '' : 's'} unlocked`,
        'success'
      )
    } else {
      showNotification('Claim complete', 'success')
    }

    // Hold the burst for onClose: the panel is still open and celebrating
    // in-modal right now.
    setPendingCardBurst(nowUnlocked.slice(0, 6))
  }

  const handleConfigure = (pluginName) => {
    setConfigPluginName(pluginName)
    setShowConfigModal(true)
  }

  const handleConfigSaved = () => {
    showNotification('Plugin settings saved', 'success')
    setShowConfigModal(false)
    setConfigPluginName(null)
  }

  const handleLicenseActivated = async () => {
    const pluginToEnable = pendingLicensePluginName
    setShowLicenseModal(false)
    setPendingLicensePluginName(null)

    // Snapshot which plugins were locked before the reload
    const wereLocked = new Set(plugins.filter(p => p.licensed === false).map(p => p.name))

    // Read explicit user disables from localStorage
    let extState = {}
    try { extState = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}') } catch { /* ignore */ }

    if (pluginToEnable) {
      const enableResult = await enablePlugin(pluginToEnable)
      if (!enableResult.success) {
        showNotification(`License activated, but ${pluginToEnable} could not be enabled automatically`, 'error')
      } else {
        showNotification(`${pluginToEnable} activated and enabled`, 'success')
      }
      await loadData()
      await refreshPluginState()
      onPluginChange?.()
      return
    }

    // Reload to get fresh license state
    await loadData()

    // After loadData the `plugins` state is stale in this closure, so re-derive
    // via the same sources loadData uses
    const freshManifests = getAllPluginManifests()
    const nowUnlocked = freshManifests
      .map(m => m.name)
      .filter(name => wereLocked.has(name) && isPluginLicensed(name))

    // Respect explicit user disables — skip plugins the user explicitly turned off
    const toEnable = nowUnlocked.filter(name => extState[name] !== false)

    // Auto-enable newly unlocked plugins
    if (toEnable.length > 0) {
      await Promise.all(toEnable.map(name => enablePlugin(name)))
      // Reload again so UI reflects the newly enabled state
      await loadData()
    }

    await refreshPluginState()
    onPluginChange?.()

    // Notification
    if (nowUnlocked.length > 0) {
      showNotification(
        `License activated — ${nowUnlocked.length} plugin${nowUnlocked.length === 1 ? '' : 's'} unlocked`,
        'success'
      )
    } else {
      showNotification('License activated successfully!', 'success')
    }

    // Staggered CelebrationBurst — cap at 6 cards
    const burst = nowUnlocked.slice(0, 6)
    burst.forEach((name, idx) => {
      setTimeout(() => {
        const card = document.querySelector(`[data-plugin-name="${name}"]`)
        if (card) {
          const rect = card.getBoundingClientRect()
          setCelebrationPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 })
          setJustActivated(name)
          setTimeout(() => setJustActivated(null), 1200)
        }
      }, idx * 180)
    })
  }

  // LICENSE-ENFORCE: self-minted trial licences are gone — all keys (incl.
  // 30-day trials) are issued from quox.ai and activated via the seat flow.

  // Derive categories from plugins
  const categories = useMemo(() => {
    const cats = new Set(plugins.map(p => p.category).filter(Boolean))
    return CATEGORY_ORDER.filter(c => cats.has(c))
  }, [plugins])

  // Filter and sort plugins
  const filteredPlugins = useMemo(() => {
    const q = search.toLowerCase().trim()
    return plugins.filter(p => {
      // Exclude core plugin from grid (shown in hero)
      if (p.name === CORE_PLUGIN) return false
      // License filter
      if (filter === 'licensed' && !p.licensed) return false
      if (filter === 'unlicensed' && p.licensed) return false
      // Category filter
      if (categoryFilter && p.category !== categoryFilter) return false
      // Search filter
      if (q) {
        const haystack = `${p.displayName} ${p.description} ${p.name} ${p.category}`.toLowerCase()
        return haystack.includes(q)
      }
      return true
    }).sort((a, b) => {
      const pa = PLUGIN_PRIORITY[a.name] || 99
      const pb = PLUGIN_PRIORITY[b.name] || 99
      return pa - pb
    })
  }, [plugins, filter, categoryFilter, search])

  // First-party catalogue ids (id = name). Anything installed whose id is in
  // here already renders as a board card, so it is excluded from Community
  // below to kill the board/Community duplication.
  const catalogueIds = useMemo(() => new Set(plugins.map(p => p.name)), [plugins])

  const corePlugin = plugins.find(p => p.name === CORE_PLUGIN)
  const coreActive = Boolean(corePlugin?.licensed && corePlugin?.enabled)

  const licensedCount = useMemo(() => plugins.filter(p => p.licensed).length, [plugins])
  const activeCount = useMemo(() => plugins.filter(p => p.licensed && p.enabled).length, [plugins])

  const counts = {
    all: plugins.filter(p => p.name !== CORE_PLUGIN).length,
    licensed: plugins.filter(p => p.name !== CORE_PLUGIN && p.licensed).length,
    unlicensed: plugins.filter(p => p.name !== CORE_PLUGIN && !p.licensed).length,
    active: plugins.filter(p => p.enabled).length
  }

  const isLicensed = licenseStatus?.licensed

  // ─── Board-vision grouping (LICENSE-LAUNCH LL-8 v1) ───────────────────
  // Real plugin state -> chip state, off the SAME filteredPlugins list
  // (search + category + license-filter tabs already applied above), split
  // into the states the owner-approved mockup calls for. Community plugins
  // keep their own existing section below, unchanged.
  const licensedGroup = filteredPlugins.filter(p => p.licensed)
  const claimableGroup = filteredPlugins.filter(p => !p.licensed && (p.claimable || p.tier === 'free'))
  const premiumGroup = filteredPlugins.filter(p => !p.licensed && !p.claimable && p.tier !== 'free')
  const licensedActiveCount = licensedGroup.filter(p => p.enabled).length

  // LICENSE-LAUNCH LL-8 v1: Community must list ONLY genuine third-party
  // installs. `thirdPartyPlugins` (getInstalledPlugins()) is the whole
  // server install registry, which also carries first-party licence-gated
  // installs and official signed bundles (LL-7 strip uses this same pipe) —
  // those already render above in licensedGroup/claimableGroup/premiumGroup
  // as first-party manifests, so leaving them in here duplicated the boards.
  //
  // The dedup key is CATALOGUE MEMBERSHIP, not signature verification: the
  // boards render from the first-party catalogue (`plugins`, id = name), so
  // any installed plugin whose id is already in the catalogue definitionally
  // HAS a board and must not also appear under Community. This is the correct
  // signal because it is a display categorisation, not a privilege grant, and
  // because it can never hide a genuine community plugin — a plugin excluded
  // here is, by definition, one that already renders in a board. (The signed
  // `official` check alone under-matched: first-party installs on a fresh org
  // carry no verified signatureData, so it left 6 catalogue plugins —
  // prompts-library, youtube, telegram-pro, quoxsignal, quoxbox-macmini,
  // system-maintenance — duplicated under Community as "· by Quox".)
  const communityPlugins = thirdPartyPlugins.filter(
    p => !p.official && !catalogueIds.has(p.pluginId)
  )
  const communityActiveCount = communityPlugins.filter(p => p.enabled).length

  // Hero growth metrics — real counts (licensedCount/plugins already
  // computed above), not mock state.
  const heroTotal = plugins.length
  const heroPct = heroTotal > 0 ? Math.round((licensedCount / heroTotal) * 100) : 0
  const heroLevel = heroLevelFor(licensedCount)
  const heroLevelNum = heroLevelIdx(licensedCount) + 1

  return (
    <div className="plugin-settings">
      {/* Celebration canvas */}
      <CelebrationBurst
        position={celebrationPos}
        onDone={() => setCelebrationPos(null)}
      />

      {/* Notification toast */}
      {notification && (
        <div className={`qx-toast qx-toast--${notification.type === 'error' ? 'error' : notification.type === 'success' ? 'success' : ''} ps-toast-positioned`}>
          <div className="qx-toast__body">
            <div className="qx-toast__msg">{notification.message}</div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════
          CORE PLATFORM HERO — Full width, top
          ═══════════════════════════════════════════ */}
      {corePlugin && (
        // LICENSE-LAUNCH LL-8: the hero used to key its "Active" badge off
        // corePlugin.enabled alone, so an unclaimed free core plugin (a
        // local-storage toggle, not an entitlement) could read as Active
        // with nothing actually licensed. `coreActive` requires the real
        // entitlement, matching every other gate in this file.
        //
        // Board-vision v1: the core hero is now the qx-bcore package
        // (QHorn + halo, same as the blessed /qx-lab/store prototype),
        // sitting on its own PCB substrate with a real growth pill and the
        // "ships with core" minichip row. The license/claim/enable action
        // block (`ps-hero__right`) is untouched byte-for-byte below \u2014 every
        // handler, test hook (data-testid="free-claim-cta", "Enter Key",
        // .ps-license-pill) and entitlement gate is exactly what shipped
        // before this redesign.
        <div className={`ps-hero ${coreActive ? 'ps-hero--active' : ''}`}>
          <div className="qx-board qx-board--flow" style={{ '--qx-board-power': heroPct / 100 }}>
            <div className="qx-row" style={{ alignItems: 'center', gap: 24, padding: '18px 8px', flexWrap: 'wrap' }}>
              <div className={`qx-bcore qx-bcore--static ${coreActive ? '' : 'qx-bcore--socket'}`}>
                <span className="qx-chip-bloom" style={{ '--chip-c': '#38bdf8' }} />
                <QHorn size={38} animated={coreActive} />
                <span className="qx-bcore__silk">QUOX CORE</span>
                <span className="qx-bcore__sub">
                  {coreActive ? `${licensedCount} of ${heroTotal} \u00B7 ${heroPct}%` : (corePlugin.claimable ? 'CLAIMABLE' : 'UNSEATED')}
                </span>
              </div>

              <div className="ps-hero__info" style={{ flex: 1, minWidth: 260 }}>
                <div className="ps-hero__title-row">
                  <h3 className="ps-hero__title">QuoxCORE Platform</h3>
                  <span className={`ps-hero__status ${coreActive ? 'ps-hero__status--active' : 'ps-hero__status--inactive'}`}>
                    {coreActive ? 'Active' : corePlugin.claimable ? 'Not claimed' : 'Inactive'}
                  </span>
                  <span className="qx-pill">{BOLT_ICON} Level {heroLevelNum} · {heroLevel.name}</span>
                </div>
                <p className="ps-hero__desc">
                  Core platform services: system maintenance, backups, restore, updates, health monitoring, and data retention.
                  {corePlugin.version && <span className="ps-hero__version">v{corePlugin.version}</span>}
                </p>
                <div className="qx-progress" style={{ maxWidth: 420, marginTop: 10, '--qx-progress': heroPct / 100 }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 14 }}>
                <div className="ps-hero__right">
                  {/* License status inline */}
                  {isLicensed ? (
                    <button className="ps-license-pill" onClick={() => setShowLicenseModal(true)} title="Update license key">
                      <div className="ps-license-pill__dot" />
                      <span className="ps-license-pill__text">
                        Licensed{licenseStatus.days_remaining > 0 ? ` \u00B7 ${licenseStatus.days_remaining}d` : ''}
                      </span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-license-pill__edit">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                      </svg>
                    </button>
                  ) : (
                    <div className="ps-hero__actions">
                      <a
                        className="ps-btn ps-btn--trial"
                        href="https://quox.ai/store"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Licence keys (including trials) are issued at quox.ai"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-btn__icon">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                        </svg>
                        Get a Licence Key
                      </a>
                      <button className="ps-btn ps-btn--secondary" onClick={() => setShowLicenseModal(true)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-btn__icon">
                          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                        </svg>
                        Enter Key
                      </button>
                    </div>
                  )}
                  {corePlugin.claimable ? (
                    <button
                      className="ps-btn ps-btn--trial"
                      data-testid="free-claim-cta"
                      onClick={() => handleClaimFree(corePlugin.name)}
                      title="This is a free, licence-governed service. Claim it in one step, no key needed."
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-btn__icon">
                        <rect x="3" y="8" width="18" height="4" /><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
                        <path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 8 12 8s2.5-5 4.5-5a2.5 2.5 0 0 1 0 5" />
                      </svg>
                      Claim free to activate
                    </button>
                  ) : !corePlugin.licensed ? (
                    <button className="ps-btn ps-btn--small" disabled title="This core service is not entitled on this instance">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-btn__icon">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      Locked
                    </button>
                  ) : corePlugin.enabled ? (
                    <button className="ps-btn ps-btn--small" onClick={() => setCoreDisableConfirm(true)}>Disable</button>
                  ) : (
                    <button className="ps-btn ps-btn--trial" onClick={(e) => handleEnable(corePlugin.name, e.currentTarget)}>Enable</button>
                  )}
                </div>

                <div className="qx-minichip-row">
                  <span className="qx-minichip-row__silk">SHIPS WITH CORE · BUS-0</span>
                  {CORE_SYSTEMS.map((s, i) => (
                    <div
                      key={s.id}
                      className={`qx-minichip ${coreActive ? 'qx-minichip--on' : ''}`}
                      style={{ '--chip-c': s.c, animationDelay: coreActive ? `${i * 90}ms` : undefined }}
                      title={`${s.name} ships with QuoxCORE`}
                    >
                      <span className="qx-chip-bloom" />
                      <span className="qx-minichip__die">
                        <svg viewBox="0 0 24 24" fill="none" stroke={coreActive ? s.c : 'rgba(255,255,255,0.45)'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d={s.d} />
                        </svg>
                      </span>
                      <span className="qx-minichip__silk">{s.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Core platform disable confirmation — core services are not an
          optional plugin; spell out what stops before turning them off. */}
      {coreDisableConfirm && corePlugin && (
        <div
          className="ps-core-confirm__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Disable core platform services"
          onClick={() => setCoreDisableConfirm(false)}
        >
          <div className="qx-card ps-core-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="qx-banner qx-banner--warn" style={{ alignItems: 'flex-start', marginBottom: 16 }}>
              <svg className="qx-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <strong className="qx-banner__title">Disabling core platform services</strong>
                <div style={{ color: 'var(--m-text-tertiary)', fontSize: 12, marginTop: 4 }}>
                  This stops scheduled backups, health monitoring, updates, restore, and data retention. Existing data is kept, but no new backups or health checks will run until you re-enable it.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setCoreDisableConfirm(false)}>Cancel</button>
              <button
                className="qx-btn qx-btn--sm qx-btn--danger"
                onClick={() => { setCoreDisableConfirm(false); handleDisable(corePlugin.name); }}
              >
                Disable core services
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QuoxAgent offline banner */}
      {apiOffline && (
        <div className="ps-banner ps-banner--warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-banner__icon">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <div className="ps-banner__body">
            <span className="ps-banner__title">QuoxAgent not connected</span>
            <span className="ps-banner__sub">Plugins work with local licenses. QuoxAgent is optional.</span>
          </div>
          <button className="ps-btn ps-btn--small" onClick={loadData}>Retry</button>
        </div>
      )}

      {/* ═══ COMMUNITY PLUGINS ═══ */}
      <div className="ps-section-head">
        <div className="ps-section-head__left">
          <h3 className="ps-section-head__title">Community Plugins</h3>
          <span className="ps-section-head__count">{communityPlugins.length}</span>
        </div>
        {/* GATE-INSTALL-UI: disabled (not hidden) for non-admins, with a
            reason on the title tooltip and the note below — an element that
            silently vanishes reads as a bug, a disabled one with a reason
            reads as a permission boundary. The real enforcement is the
            backend admin gate on the install route; this only stops a
            non-admin from being led into a flow the server will refuse. */}
        <button
          className="ps-btn ps-btn--small"
          onClick={() => isOrgAdmin && setShowInstaller(true)}
          disabled={!isOrgAdmin}
          title={isOrgAdmin ? 'Install a community plugin' : 'Installing plugins requires an org admin'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ps-btn__icon">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Install Plugin
        </button>
      </div>
      {!isOrgAdmin && (
        <p className="ps-community__admin-note">Installing plugins requires an org admin. Ask an admin to install one for you.</p>
      )}
      {communityPlugins.length === 0 ? (
        <p className="ps-community__empty">
          {isOrgAdmin
            ? <>No community plugins installed yet. Click <strong>Install Plugin</strong> to add one.</>
            : 'No community plugins installed yet.'}
        </p>
      ) : (
        <>
          <div className="qx-banner qx-banner--warn ps-community__warn" role="note" style={{ alignItems: 'flex-start' }}>
            <svg className="qx-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div>
              <strong>{TRUSTED_ADMIN_ONLY_LABEL}.</strong> {COMMUNITY_PLUGIN_TRUST_NOTICE}
              <div className="ps-community__warn-detail">{COMMUNITY_PLUGIN_TRUST_DETAIL}</div>
            </div>
          </div>
          {/* Quarantine: a throwing plugin card must not blank this page.
              The fallback offers a local-cache reset — the recovery hatch for
              a stale/corrupt cached bundle that a plain reload can't clear. */}
          <ErrorBoundary
            fallback={({ retry }) => (
              <div className="ps-banner ps-banner--warn">
                <div className="ps-banner__body">
                  <span className="ps-banner__title">A community plugin failed to render</span>
                  <span className="ps-banner__sub">The rest of Settings is unaffected. If it persists, reset the local plugin cache and reload — your installs are kept server-side and re-fetched fresh.</span>
                </div>
                <button className="ps-btn ps-btn--small" onClick={retry}>Retry</button>
                <button
                  className="ps-btn ps-btn--small"
                  onClick={async () => { await clearPluginCache(); window.location.reload(); }}
                >
                  Reset cache &amp; reload
                </button>
              </div>
            )}
          >
            <PluginBoard
              title="Community"
              silk="BUS-C · THIRD-PARTY INSTALLS"
              pill={`${communityActiveCount} of ${communityPlugins.length} active`}
              power={communityPlugins.length ? communityActiveCount / communityPlugins.length : 0}
              live={communityActiveCount > 0}
              count={communityPlugins.length}
            >
              {communityPlugins.map(p => (
                <ThirdPartyPluginCard
                  key={p.pluginId}
                  plugin={p}
                  onUpdate={() => setThirdPartyVersion(v => v + 1)}
                />
              ))}
            </PluginBoard>
          </ErrorBoundary>
        </>
      )}

      {/* Third-Party Plugin Installer Modal */}
      {showInstaller && (
        <ThirdPartyPluginInstaller
          onClose={() => setShowInstaller(false)}
          onInstalled={() => {
            setThirdPartyVersion(v => v + 1)
            setShowInstaller(false)
          }}
        />
      )}

      {/* ═══════════════════════════════════════════
          SEARCH + FILTERS BAR
          ═══════════════════════════════════════════ */}
      <div className="ps-filters">
        {/* Search input */}
        <div className="ps-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ps-search__icon">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search plugins..."
            className="ps-search__input"
          />
          {search && (
            <button className="ps-search__clear" onClick={() => setSearch('')} title="Clear search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
          <kbd className="ps-search__kbd">
            {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}F
          </kbd>
        </div>

        {/* Category pills */}
        <div className="ps-categories">
          <button
            className={`ps-cat ${!categoryFilter ? 'ps-cat--active' : ''}`}
            onClick={() => setCategoryFilter(null)}
          >
            All
          </button>
          {categories.map(cat => {
            const count = plugins.filter(p => p.category === cat && p.name !== CORE_PLUGIN).length
            return (
              <button
                key={cat}
                className={`ps-cat ${categoryFilter === cat ? 'ps-cat--active' : ''}`}
                onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
              >
                {CATEGORY_ICONS[cat] && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="ps-cat__icon">
                    <path d={CATEGORY_ICONS[cat]} />
                  </svg>
                )}
                {cat}
                <span className="ps-cat__count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* License/status filter tabs + stats */}
      <div className="ps-controls">
        <div className="qx-seg" role="tablist" aria-label="Filter plugins by license">
          {[
            { key: 'all', label: 'Show all', count: counts.all },
            { key: 'licensed', label: 'Licensed', count: counts.licensed },
            { key: 'unlicensed', label: 'Unlicensed', count: counts.unlicensed }
          ].map(tab => (
            <button
              key={tab.key}
              className={`qx-seg__item ${filter === tab.key ? 'qx-seg__item--active' : ''}`}
              role="tab"
              aria-selected={filter === tab.key}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
              <span className="qx-seg__count">{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="ps-stats">
          {search && (
            <span className="ps-stat">
              <span className="ps-stat__val">{filteredPlugins.length}</span>
              <span className="ps-stat__label">matching</span>
            </span>
          )}
          {licensedCount > 0 && (
            <span
              className="ps-active-pill"
              title="Active plugins of licensed total"
              style={licensedCount === activeCount ? { color: '#34d399' } : {}}
            >
              {activeCount} of {licensedCount} active
            </span>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════
          PLUGIN BOARDS — board-vision v1 (LICENSE-LAUNCH LL-8)
          Same real filteredPlugins list, grouped into the states the
          owner-approved mockup calls for: licensed & active, free &
          claimable, premium (buy). Each PluginCard keeps its full
          existing entitlement logic and test hooks; only the container
          changed, from one flat .ps-grid to per-state qx-board sections.
          ═══════════════════════════════════════════ */}
      {loading ? (
        <div className="ps-loading">
          <div className="ps-loading__spinner">
            <div className="ps-loading__ring" />
            <div className="ps-loading__ring ps-loading__ring--2" />
          </div>
          <span className="ps-loading__text">Discovering plugins...</span>
        </div>
      ) : filteredPlugins.length === 0 ? (
        <div className="ps-grid">
          <div className="ps-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="ps-empty__icon">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <h4>{search ? `No plugins matching "${search}"` : 'No plugins match this filter'}</h4>
            <p>{search ? 'Try a different search term or clear the filter.' : 'Try switching to "All" to see every plugin.'}</p>
            <button className="ps-btn ps-btn--secondary" onClick={() => { setSearch(''); setFilter('all'); setCategoryFilter(null) }}>
              Clear All Filters
            </button>
          </div>
        </div>
      ) : (
        <>
          <PluginBoard
            title="Licensed & Active"
            silk="BUS-0 · YOUR PLUGINS"
            pill={`${licensedActiveCount} of ${licensedGroup.length} active`}
            power={licensedGroup.length ? licensedActiveCount / licensedGroup.length : 0}
            live={licensedActiveCount > 0}
            count={licensedGroup.length}
          >
            {licensedGroup.map(plugin => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                justActivated={justActivated === plugin.name}
                onEnable={handleEnable}
                onDisable={handleDisable}
                onGetLicense={handleGetLicense}
                onClaimFree={handleClaimFree}
                onConfigure={handleConfigure}
              />
            ))}
          </PluginBoard>

          <PluginBoard
            title="Free Plugins"
            silk="BUS-A · FREE WITH YOUR ACCOUNT"
            pill={`${claimableGroup.length} claimable`}
            power={0}
            live={false}
            count={claimableGroup.length}
          >
            {claimableGroup.map(plugin => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                justActivated={justActivated === plugin.name}
                onEnable={handleEnable}
                onDisable={handleDisable}
                onGetLicense={handleGetLicense}
                onClaimFree={handleClaimFree}
                onConfigure={handleConfigure}
              />
            ))}
          </PluginBoard>

          <PluginBoard
            title="Premium"
            silk="BUS-B · SIGNED BUNDLES · quox.ai/store"
            pill={`${premiumGroup.length} available`}
            power={0}
            live={false}
            count={premiumGroup.length}
          >
            {premiumGroup.map(plugin => (
              <PluginCard
                key={plugin.name}
                plugin={plugin}
                justActivated={justActivated === plugin.name}
                onEnable={handleEnable}
                onDisable={handleDisable}
                onGetLicense={handleGetLicense}
                onClaimFree={handleClaimFree}
                onConfigure={handleConfigure}
              />
            ))}
          </PluginBoard>
        </>
      )}

      {/* License Modal */}
      {showLicenseModal && (
        <LicenseActivation
          onClose={() => {
            setShowLicenseModal(false)
            setPendingLicensePluginName(null)
          }}
          onActivated={handleLicenseActivated}
        />
      )}

      {/* Free claim panel (LICENSE-LAUNCH LL-8) */}
      {showFreeClaimPanel && (
        <FreeClaimPanel
          pluginIds={freeClaimPlugins.map(p => p.name)}
          pluginNames={freeClaimPlugins.map(p => p.displayName || p.name)}
          plugins={freeClaimPlugins}
          authFetch={authFetch}
          onClose={() => {
            setShowFreeClaimPanel(false)
            if (pendingCardBurst.length > 0) {
              triggerCardBurst(pendingCardBurst)
              setPendingCardBurst([])
            }
          }}
          onClaimed={handleFreeClaimed}
        />
      )}

      {/* Plugin Config Modal */}
      {showConfigModal && configPluginName && (
        <PluginConfigModal
          pluginName={configPluginName}
          onClose={() => {
            setShowConfigModal(false)
            setConfigPluginName(null)
          }}
          onSave={handleConfigSaved}
        />
      )}

      <style>{`
        /* ================================================================
           PLUGIN SETTINGS — Redesigned with search, categories, hero
           ================================================================ */

        /* --- Toast notification --- */
        .ps-toast {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 18px;
          border-radius: 10px;
          font-size: 0.875rem;
          animation: psToastIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
          position: relative;
          overflow: hidden;
          backdrop-filter: blur(12px);
        }
        .ps-toast__accent {
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: 3px;
          border-radius: 3px 0 0 3px;
        }
        .ps-toast__msg { position: relative; z-index: 1; }
        @keyframes psToastIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .ps-toast--success { background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.2); color: #6ee7b7; }
        .ps-toast--success .ps-toast__accent { background: #34d399; }
        .ps-toast--error { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #fca5a5; }
        .ps-toast--error .ps-toast__accent { background: #ef4444; }
        .ps-toast--info { background: rgba(96, 165, 250, 0.1); border: 1px solid rgba(96, 165, 250, 0.2); color: #93c5fd; }
        .ps-toast--info .ps-toast__accent { background: #60a5fa; }

        /* ═══ HERO — Core Platform Panel ═══ */
        .ps-hero {
          position: relative;
          padding: 24px 28px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: linear-gradient(135deg, rgba(56, 189, 248, 0.04) 0%, rgba(167, 139, 250, 0.04) 100%);
          overflow: hidden;
        }
        .ps-hero--active {
          border-color: rgba(52, 211, 153, 0.2);
          background: linear-gradient(135deg, rgba(52, 211, 153, 0.05) 0%, rgba(56, 189, 248, 0.03) 100%);
        }
        .ps-hero__glow {
          position: absolute;
          top: -40px; right: -40px;
          width: 180px; height: 180px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(56, 189, 248, 0.08) 0%, transparent 70%);
          pointer-events: none;
        }
        .ps-hero__content {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          flex-wrap: wrap;
        }
        .ps-hero__left {
          display: flex;
          align-items: center;
          gap: 18px;
          flex: 1;
          min-width: 280px;
        }
        .ps-hero__icon-wrap {
          width: 48px; height: 48px;
          border-radius: 12px;
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .ps-hero--active .ps-hero__icon-wrap {
          background: rgba(52, 211, 153, 0.1);
          border-color: rgba(52, 211, 153, 0.2);
        }
        .ps-hero__icon {
          width: 24px; height: 24px;
          color: #38bdf8;
        }
        .ps-hero--active .ps-hero__icon { color: #34d399; }
        .ps-hero__info { flex: 1; }
        .ps-hero__title-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 6px;
          flex-wrap: wrap;
        }
        .ps-hero__title {
          margin: 0;
          font-size: 1.15rem;
          font-weight: 700;
          color: #f4f4f5;
        }
        .ps-hero__status {
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 2px 8px;
          border-radius: 4px;
        }
        .ps-hero__status--active {
          background: rgba(52, 211, 153, 0.15);
          color: #34d399;
        }
        .ps-hero__status--inactive {
          background: rgba(255, 255, 255, 0.06);
          color: #71717a;
        }
        .ps-hero__tier {
          font-size: 0.7rem;
          color: #52525b;
          font-weight: 500;
        }
        .ps-hero__desc {
          margin: 0;
          font-size: 0.825rem;
          color: rgba(255, 255, 255, 0.5);
          line-height: 1.5;
        }
        .ps-hero__version {
          margin-left: 8px;
          font-family: 'SF Mono', 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          color: #52525b;
        }
        .ps-hero__right {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }
        .ps-hero__actions {
          display: flex;
          gap: 8px;
        }

        /* ═══ SEARCH + FILTERS TOOLBAR (glass) ═══ */
        .ps-filters {
          position: relative;
          isolation: isolate;
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 16px;
          background: var(--m-bg-base, rgba(255, 255, 255, 0.08));
          backdrop-filter: var(--qx-blur);
          -webkit-backdrop-filter: var(--qx-blur);
          border: 1px solid var(--m-border-default, rgba(255, 255, 255, 0.18));
          border-radius: var(--qx-radius, 20px);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 -1px 0 rgba(0, 0, 0, 0.45);
        }
        .ps-filters::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: var(--qx-edges);
          pointer-events: none;
          z-index: 1;
        }
        .ps-filters > * { position: relative; z-index: 2; }
        /* Search + category pill styling lives in PluginSettings.css only.
           Do not re-add rules for .ps-search* / .ps-cat* here: this inline
           block renders after the stylesheet and silently wins the cascade. */

        /* ═══ License pill ═══ */
        .ps-license-pill {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 14px;
          background: rgba(52, 211, 153, 0.08);
          border: 1px solid rgba(52, 211, 153, 0.2);
          border-radius: 100px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .ps-license-pill:hover {
          background: rgba(52, 211, 153, 0.14);
          border-color: rgba(52, 211, 153, 0.35);
        }
        .ps-license-pill__edit { width: 12px; height: 12px; color: rgba(110, 231, 183, 0.5); transition: color 0.2s; }
        .ps-license-pill:hover .ps-license-pill__edit { color: #6ee7b7; }
        .ps-license-pill__dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #34d399;
          box-shadow: 0 0 6px rgba(52, 211, 153, 0.5);
          animation: psDotPulse 2.5s ease-in-out infinite;
        }
        @keyframes psDotPulse {
          0%, 100% { opacity: 0.7; box-shadow: 0 0 4px rgba(52, 211, 153, 0.3); }
          50%      { opacity: 1;   box-shadow: 0 0 10px rgba(52, 211, 153, 0.6); }
        }
        .ps-license-pill__text { font-size: 0.8rem; font-weight: 500; color: #6ee7b7; }

        /* ═══ Buttons ═══ */
        .ps-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 16px; border-radius: 8px;
          font-size: 0.825rem; font-weight: 600;
          cursor: pointer; transition: all 0.2s ease;
          border: 1px solid; white-space: nowrap;
        }
        .ps-btn__icon { width: 14px; height: 14px; flex-shrink: 0; }
        .ps-btn--trial {
          background: linear-gradient(135deg, rgba(52, 211, 153, 0.15), rgba(16, 185, 129, 0.1));
          border-color: rgba(52, 211, 153, 0.3); color: #34d399;
        }
        .ps-btn--trial:hover:not(:disabled) {
          background: linear-gradient(135deg, rgba(52, 211, 153, 0.25), rgba(16, 185, 129, 0.18));
          border-color: rgba(52, 211, 153, 0.5);
          transform: translateY(-1px);
          box-shadow: 0 4px 14px rgba(52, 211, 153, 0.15);
        }
        .ps-btn--trial:disabled { opacity: 0.45; cursor: not-allowed; }
        .ps-btn--secondary {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.12); color: #a1a1aa;
        }
        .ps-btn--secondary:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.2); color: #e4e4e7; }
        .ps-btn--small {
          padding: 5px 12px; font-size: 0.75rem; border-radius: 6px;
          background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.12); color: #a1a1aa;
        }
        .ps-btn--small:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }

        /* ═══ Warning banner ═══ */
        .ps-banner { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 10px; }
        .ps-banner--warn { background: rgba(251, 191, 36, 0.06); border: 1px solid rgba(251, 191, 36, 0.15); }
        .ps-banner__icon { width: 18px; height: 18px; color: #fbbf24; flex-shrink: 0; }
        .ps-banner__body { flex: 1; display: flex; flex-direction: column; gap: 1px; }
        .ps-banner__title { font-size: 0.825rem; font-weight: 600; color: #fbbf24; }
        .ps-banner__sub { font-size: 0.75rem; color: rgba(255, 255, 255, 0.5); }

        /* ═══ Controls bar (tabs + stats) — glass toolbar ═══ */
        .ps-controls {
          position: relative;
          isolation: isolate;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 12px 16px;
          background: var(--m-bg-base, rgba(255, 255, 255, 0.08));
          backdrop-filter: var(--qx-blur);
          -webkit-backdrop-filter: var(--qx-blur);
          border: 1px solid var(--m-border-default, rgba(255, 255, 255, 0.18));
          border-radius: var(--qx-radius, 20px);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 -1px 0 rgba(0, 0, 0, 0.45);
        }
        .ps-controls::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: var(--qx-edges);
          pointer-events: none;
          z-index: 1;
        }
        .ps-controls > * { position: relative; z-index: 2; }

        /* ═══ Stats ═══ */
        .ps-stats { display: flex; align-items: center; gap: 14px; padding: 0 12px; }
        .ps-stat { display: flex; align-items: center; gap: 5px; }
        .ps-stat__dot { width: 6px; height: 6px; border-radius: 50%; }
        .ps-stat__dot--active { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.4); animation: psDotPulse 2.5s ease-in-out infinite; }
        .ps-stat__val {
          font-family: 'SF Mono', 'JetBrains Mono', monospace;
          font-size: 0.825rem; font-weight: 700; color: #e4e4e7; font-variant-numeric: tabular-nums;
        }
        .ps-stat__label { font-size: 0.7rem; color: #52525b; text-transform: uppercase; letter-spacing: 0.04em; }

        /* ═══ Licensed-but-active pill ═══ */
        .ps-active-pill {
          display: inline-flex; align-items: center;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 0.75rem;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }

        /* ═══ Plugin grid ═══ */
        .ps-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
          gap: 16px;
        }

        /* ═══ Loading ═══ */
        .ps-loading { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 72px 40px; color: #71717a; }
        .ps-loading__spinner { position: relative; width: 48px; height: 48px; }
        .ps-loading__ring {
          position: absolute; inset: 0;
          border: 2px solid transparent; border-top-color: rgba(157, 78, 221, 0.6);
          border-radius: 50%; animation: psRingSpin 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
        }
        .ps-loading__ring--2 { inset: 6px; border-top-color: rgba(52, 211, 153, 0.4); animation-delay: -0.25s; animation-duration: 1.6s; }
        @keyframes psRingSpin { to { transform: rotate(360deg); } }
        .ps-loading__text { font-size: 0.9rem; color: #a1a1aa; font-weight: 500; }

        /* ═══ Empty state ═══ */
        .ps-empty {
          text-align: center; padding: 56px 40px; grid-column: 1 / -1;
          background: rgba(255, 255, 255, 0.015);
          border: 1px dashed rgba(255, 255, 255, 0.08);
          border-radius: 14px;
        }
        .ps-empty__icon { width: 48px; height: 48px; color: #3f3f46; margin-bottom: 16px; }
        .ps-empty h4 { margin: 0 0 6px; font-size: 1rem; color: #a1a1aa; font-weight: 600; }
        .ps-empty p { margin: 0 0 20px; color: #52525b; font-size: 0.85rem; line-height: 1.5; }

        /* ═══ Responsive ═══ */
        @media (max-width: 640px) {
          .ps-hero__content { flex-direction: column; align-items: stretch; }
          .ps-hero__right { justify-content: flex-end; }
          .ps-controls { flex-direction: column; align-items: stretch; }
          .ps-stats { justify-content: center; padding: 6px 0; }
          .ps-grid { grid-template-columns: 1fr; }
          .ps-search__kbd { display: none; }
          .ps-categories { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .ps-license-pill__dot, .ps-stat__dot--active { animation: none; }
          .ps-toast { animation: none; }
        }
      `}</style>
    </div>
  )
}
