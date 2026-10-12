/**
 * QuoxbrainView — ONE BRAIN knowledge-graph explorer (Stream QUOXBRAIN #163, P2.5b-2)
 *
 * Reworked from a per-vault picker into a single scope-union brain with
 * sources/scopes/languages exposed as narrowing FACETS (chips), not separate
 * vaults to switch between. Backed entirely by the brain-level endpoints
 * (/brain/sources, /brain/graph, /brain/search — services/quoxbrain/server.js
 * P2.5b-1) which already union every vault visible to the caller
 * (org + own user-scope + shared) server-side; facet selection here only
 * ever narrows that union, never widens it.
 *
 * Zero fabricated data: every panel shows a real loading/empty/error state
 * driven by quoxbrainClient. There is no localStorage fallback here — this
 * is a server-authoritative knowledge graph.
 */

import { useSearchParams } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef, useMemo, useReducer, lazy, Suspense, Fragment } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { forceX, forceY } from 'd3-force-3d'
import ReactMarkdown from 'react-markdown'
import { stripFrontmatter } from '../../utils/stripFrontmatter'
import remarkGfm from 'remark-gfm'
import { getQuoxbrainClient, getBrainOverview } from '../../services/quoxbrainClient'
import { getMemoryClient } from '../../services/memoryClient'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import { useAuth } from '../../contexts/AuthContext'
import { interpretSearchResponse } from './quoxbrainSearchState'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { getStatus as getFeedStatus } from '../../services/brain2FeedClient'
import { LENS_OPTIONS, LENS_LEGENDS, resolveNodeColor } from '../../components/brain2/lib/brainLenses'
import { computeSearchMatchIds, computeNeighborIds } from '../../components/brain2/lib/brainEmphasis'
import BrainRendererBoundary from '../../components/brain2/BrainRendererBoundary'
import CortexDock from '../../components/brain2/CortexDock'
import BrainCapture from '../../components/brain2/BrainCapture'
import DecisionTimeline from '../../components/brain2/DecisionTimeline'
import Brain2Onboarding from '../../components/brain2/Brain2Onboarding'
import Brain2PaneRail from '../../components/brain2/Brain2PaneRail'
import { INITIAL_LAYOUT, layoutReducer, effectiveLayout, parseLayoutParam, persistable, hydrateFromPrefs, dockPlacement, dockMaxWidth, NARROW_PX, DRAWER_PX } from '../../components/brain2/lib/workspaceLayout'
import { shouldShowOnboarding } from '../../components/brain2/lib/onboarding'
import { preprocessWikilinks, parseWikilinkHref } from '../../components/brain2/lib/wikilinks'
import { readNoteParam, syncNoteParam, NOTE_SYNC_OPTIONS } from './quoxbrainDeepLink'
import { createLatestGuard } from './quoxbrainLatestRequest'
import { buildAskAboutNoteSeed, normalizeSpan, spanLoadState, citedPassage } from './quoxbrainCitedSpan'
import './QuoxbrainView.css'
import '../../components/brain2/brain-workspace.css'

// Lazy: react-force-graph-3d pulls in `three` (WebGL) — must not bloat the
// default 2D bundle. Vite emits this as its own dynamic chunk (three itself
// already lands in the shared 'three-stack' manual chunk, see vite.config).
const ForceGraph3D = lazy(() => import('react-force-graph-3d'))

// Lazy: BrainOrgan3D is an R3F view (@react-three/fiber + drei +
// postprocessing). R3F views must NEVER be statically imported — eager
// evaluation crashes every page (CLAUDE.md R3F rules) — and it shares the
// three-stack chunk with ForceGraph3D above, so 2D-only sessions still pay
// nothing.
const BrainOrgan3D = lazy(() => import('../../components/opsdeck3d/BrainOrgan3D'))

// THREE is only needed by the 3D branch's custom glowing node objects
// (nodeThreeObject below) — loaded on-demand the same way as
// react-force-graph-3d itself (which already depends on it internally) so a
// 2D-only session never fetches the three-stack chunk. Module-level promise
// + shared geometry: both are singletons, not per-render/per-node state.
let threeModulePromise = null
function loadThreeModule() {
  if (!threeModulePromise) threeModulePromise = import('three')
  return threeModulePromise
}
let sharedNodeSphereGeometry = null
function getSharedNodeSphereGeometry(threeMod) {
  // Unit-radius sphere, low segment count (perf budget) — every node scales
  // this SAME geometry instance rather than allocating its own, so 800 nodes
  // costs one geometry, not 800.
  if (!sharedNodeSphereGeometry) sharedNodeSphereGeometry = new threeMod.SphereGeometry(1, 12, 8)
  return sharedNodeSphereGeometry
}

// ─────────────────────────────────────────────────────────────────────────
// Inline SVG icons (14-24px, currentColor/stroke — no icon library, per repo
// UI rules; mirrors the icon-per-file pattern in MemoryDashboard.jsx).
// ─────────────────────────────────────────────────────────────────────────

function NetworkIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M12 7.5v6M12 13.5L6.6 17M12 13.5l5.4 3.5" />
    </svg>
  )
}
function PlusIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
function RefreshIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}
function SearchIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
function CloseIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
function LinkIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.5" />
    </svg>
  )
}
function FitIcon({ size = 14 }) {
  // "Fit / recenter" — a framed target with a centre dot. Deliberately NOT
  // corner-arrows: the fullscreen Expand/Collapse icons own the corner-arrow
  // metaphor, so Fit uses a distinct viewfinder shape to avoid a look-alike.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
function ExpandIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H4v4M16 3h4v4M4 16v4h4M20 16v4h-4" />
    </svg>
  )
}
function CollapseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
    </svg>
  )
}
function ChevronDownIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
function LibraryIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="4" x2="4" y2="20" /><line x1="9" y1="4" x2="9" y2="20" />
      <path d="M14 5l4 15M14 5l4-1 4 15-4 1z" />
    </svg>
  )
}
function ChevronsLeftIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
    </svg>
  )
}
function ChevronsRightIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
    </svg>
  )
}
// Focus: four inward corners around a dot (hide the side panes); exit = outward.
function FocusIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}
function DockIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
    </svg>
  )
}
// Distinct from the org-chip dot avatar deliberately — a person glyph reads
// "this is you", not "this is an org", at a glance in the chip row (BRAIN2
// personal-layer honesty fix, owner catch 2026-08-25).
function PersonIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.9 3.13-7 7-7s7 3.1 7 7" />
    </svg>
  )
}
function TagIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  )
}
// Orbit ellipse + satellite dot — deliberately not the Reindex RefreshIcon's
// two-arrow shape (different action, different context, avoid a look-alike
// per the FitIcon convention above). Off-state dims the orbit and slashes it,
// the same "disabled" grammar as a muted mute icon.
function SpinIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-18 12 12)" />
      <circle cx="19.4" cy="8.6" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
function SpinOffIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-18 12 12)" opacity="0.5" />
      <circle cx="19.4" cy="8.6" r="1.6" fill="currentColor" stroke="none" opacity="0.5" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Constants / helpers
// ─────────────────────────────────────────────────────────────────────────

const LINK_TYPE_COLORS = {
  wikilink: '#38bdf8',
  markdown: '#a855f7',
  embed: '#30ff90',
  html: '#f59e0b'
}

// Cyan / violet / amber — the same scope palette drives node colour, facet
// dots, the legend, and the note-reader scope pill (mapped to the nearest
// existing .qx-pill accent below).
const SCOPE_COLORS = { org: '#38bdf8', user: '#a855f7', shared: '#f59e0b' }
const SCOPE_LABELS = { org: 'Org', user: 'You', shared: 'Shared' }
const SCOPE_PILL_CLASS = { org: 'qx-pill--info', user: 'qx-pill--purple', shared: 'qx-pill--degraded' }

// Deterministic per-source palette (assigned by stable sort order from the
// server's /brain/sources response) for the "colour by source" graph mode.
const SOURCE_PALETTE = ['#38bdf8', '#a855f7', '#f59e0b', '#30ff90', '#f472b6', '#facc15', '#60a5fa', '#fb7185']

// Node labels only paint on hover/neighbor OR once the user has zoomed in
// past this threshold — painting every label always is what turned the old
// per-vault graph into an unreadable hairball.
const LABEL_ZOOM_THRESHOLD = 3.2

function nodeRadius(degree) {
  // Bigger base + steeper hub scaling so nodes stay perceptible even when the
  // whole field is zoomed out to fit hundreds of them, and hubs read as hubs.
  return 5 + Math.min(degree || 0, 24) * 1.15
}

// Living-pulse tuning — see the phase/amplitude precompute in the graphData
// memo and the oscillation read in paintNode below. Period is the full
// breathe-in/breathe-out cycle length; kept slow so the field reads as
// "alive" rather than flickering.
const PULSE_PERIOD_MS = 4200

// Deterministic 0..2π phase offset from a node id string, so nodes breathe
// out of phase with each other instead of blinking in lockstep. Computed
// ONCE per node (see the graphData memo, which caches the result on the node
// object itself) — paintNode must never hash anything per frame.
function hashPhase(id) {
  const s = String(id)
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return ((h >>> 0) % 6283) / 1000 // ~0..2π (2π * 1000 ≈ 6283)
}

// How hard nodes are pulled toward their group's centroid each tick (as a
// fraction of the sim's alpha). This is the single biggest legibility win
// for a low-edge corpus: force-layout alone has nothing to organize around
// when there are few cross-links, so we give it something — visible
// "regions" (one per scope, or one per source) instead of a scatter.
// Re-enabled at a modest strength: the centroid ring radius is already capped
// (see the per-group centroid effect below) so 2+ groups no longer fling
// nodes far enough off-centre for zoomToFit to shrink them to sub-pixel
// specks. At this strength lobes are visibly distinct without going rigid —
// link/charge forces still win locally, so nodes inside a lobe keep an
// organic shape instead of snapping onto a ring.
const CLUSTER_STRENGTH = 0.15

// A custom d3-force plugin — same contract as d3-force's built-ins
// (`force.initialize(nodes)` once, then `force(alpha)` every tick, mutating
// vx/vy in place) — that pulls each node toward a per-group centroid read
// from `groupsRef.current` ({ keyOf, centers }). Reading from a ref (rather
// than closing over state) means the force object itself never needs to be
// recreated when centroids move — only reassigned when the grouping
// dimension (scope vs source) itself changes.
function makeClusterForce(groupsRef, strength) {
  let nodes = []
  function force(alpha) {
    const { keyOf, centers } = groupsRef.current
    if (!centers || centers.size === 0 || !keyOf) return
    const l = alpha * strength
    for (const node of nodes) {
      const center = centers.get(keyOf(node))
      if (!center) continue
      node.vx += (center.x - node.x) * l
      node.vy += (center.y - node.y) * l
    }
  }
  force.initialize = (ns) => { nodes = ns }
  return force
}

function toggleInArray(arr, value) {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

// Header growth affordances (BRAIN2-PRODUCT P2d) — mirrors Brain2Settings.jsx's
// own local `timeAgo` helper exactly (that one isn't exported, so this is a
// deliberate small duplicate rather than a new shared util for one caller).
function timeAgo(dateStr) {
  if (!dateStr) return null
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

// Minutes-since helper for the feed-status breathing-dot threshold (35min) —
// separate from timeAgo's display string since the threshold check needs a
// raw number, not formatted text.
function minutesSince(dateStr) {
  if (!dateStr) return null
  return (Date.now() - new Date(dateStr).getTime()) / 60000
}

function linkEndId(end) {
  return typeof end === 'object' && end !== null ? end.id : end
}

// Mirrors GpuSetupView's reduced-motion hook — the graph's idle settle
// animation (warmup ticks + the zoomToFit pan) is skipped/instant for users
// who've asked the OS for reduced motion, per repo convention.
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ))
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setReduced(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', handler)
    else mq.addListener(handler)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
    }
  }, [])
  return reduced
}

// Simple debounce hook (mirrors QuoxMCPView's useDebounce).
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// Track a container's pixel size so ForceGraph2D (which requires explicit
// width/height) fills its flex parent.
//
// Uses a CALLBACK ref, not a useRef object: the observed `.qx-canvas` mounts
// LATE (only once brain sources have loaded — the view first renders the
// empty/loading state without it). A useRef + `[ref]` effect runs once at
// mount with ref.current === null, then never re-runs when the element later
// attaches, so the observer never wires up and size stays {0,0}. A callback
// ref re-fires the effect whenever the node attaches; we also measure
// synchronously on attach so we don't depend on the observer's first async
// callback.
function useContainerSize() {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [node, setNode] = useState(null)
  const ref = useCallback((n) => setNode(n), [])
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const rect = node.getBoundingClientRect()
    setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) })
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        const { width, height } = entry.contentRect
        setSize({ width: Math.floor(width), height: Math.floor(height) })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [ref, size]
}

// ─────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────

// Renders the full Qortex experience (facets, graph, note reader). Split out
// from the exported QuoxbrainView so the license gate below (Qortex —
// BRAIN2-PRODUCT Phase A) can early-return a locked state WITHOUT
// conditionally calling any of this component's many hooks (Rules of
// Hooks) — mirrors the DockerView/GrafanaView gate-then-content pattern.
function QuoxbrainViewContent() {
  const client = useMemo(() => getQuoxbrainClient(), [])
  const { authFetch, user } = useAuth()
  const { orgs: workspaceOrgs, currentOrg, selectOrg } = useWorkspace()

  // Brain-wide facet metadata (/brain/sources)
  const [sourcesMeta, setSourcesMeta] = useState(null) // {sources, scopes, languages, totalNotes}
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState(null)

  // ── "One brain, visibly growing" header (BRAIN2-PRODUCT P2a+P2d) ────────
  // /brain/overview -> {total, orgs:[{org_id, noteCount, newestNoteAt|null,
  // error?}]}. `overviewSupported` starts true (assume it exists) and flips
  // to false permanently on the FIRST 404 — feature-detect once, then stop
  // polling a route that isn't there, rather than 404ing every 60s forever.
  const [overview, setOverview] = useState(null)
  const [overviewSupported, setOverviewSupported] = useState(true)
  const totalPulseTimerRef = useRef(null)
  const [totalPulsing, setTotalPulsing] = useState(false)
  const prevOverviewTotalRef = useRef(null)

  // Empty-org honesty banner dismiss (BRAIN2-PRODUCT, owner catch 2026-08-25:
  // "the brain is the same for every org" confusion) — session state only,
  // reset on org switch (below) so re-visiting a genuinely-empty org later in
  // the same session shows the explanation again rather than staying hidden.
  const [emptyOrgBannerDismissed, setEmptyOrgBannerDismissed] = useState(false)

  const loadOverview = useCallback(async () => {
    if (!authFetch || !overviewSupported) return
    try {
      const data = await getBrainOverview({ authFetch })
      if (data == null) {
        // 404 (or no authFetch yet) — the collector hasn't shipped this
        // route yet. Fall back silently; do not console.error, this is
        // expected during the parallel-backend rollout window.
        setOverviewSupported(false)
        return
      }
      // All-error overview (every org row failed, e.g. quoxbrain timing out):
      // headlining its total of 0 asserts an empty brain that isn't (live
      // incident 2026-08-25). Treat it like a failed load instead — keep the
      // previous overview if any, or fall back to the single-org count.
      if (Array.isArray(data.orgs) && data.orgs.length > 0 && data.orgs.every((o) => o.error)) {
        console.warn('[Qortex] overview degraded: every org entry errored; keeping fallback count')
        setOverview(null)
        return
      }
      setOverview(data)
    } catch {
      // Any other failure (network, 5xx) — degrade for THIS load only, keep
      // overviewSupported true so the next 60s tick retries.
      setOverview(null)
    }
  }, [authFetch, overviewSupported])

  useEffect(() => { loadOverview() }, [loadOverview])

  // Auto-refresh every 60s (P2d-a) — only while the route is known to exist.
  useEffect(() => {
    if (!overviewSupported) return
    const id = setInterval(loadOverview, 60000)
    return () => clearInterval(id)
  }, [overviewSupported, loadOverview])

  // Reload on org switch too, same as the facet metadata below.
  useEffect(() => {
    const onOrgSwitch = () => loadOverview()
    window.addEventListener('quox-org-switch', onOrgSwitch)
    return () => window.removeEventListener('quox-org-switch', onOrgSwitch)
  }, [loadOverview])

  // Brief count-up glow whenever the TOTAL increases (P2d-a). Reduced-motion
  // users still get the number update, just no pulse class (CSS also guards
  // this via prefers-reduced-motion, belt-and-braces since the class is
  // applied from JS not purely CSS-driven).
  useEffect(() => {
    if (overview?.total == null) return
    const prev = prevOverviewTotalRef.current
    if (prev != null && overview.total > prev && !prefersReducedMotion) {
      setTotalPulsing(true)
      clearTimeout(totalPulseTimerRef.current)
      totalPulseTimerRef.current = setTimeout(() => setTotalPulsing(false), 1400)
    }
    prevOverviewTotalRef.current = overview.total
  }, [overview?.total])
  useEffect(() => () => clearTimeout(totalPulseTimerRef.current), [])

  // "+N since your last visit" pill (P2d-b) — an ephemeral UX affordance, so
  // localStorage as the store is acceptable here (unlike everywhere else in
  // this repo): the server-side `total` stays authoritative, this is purely
  // "what changed since I last looked", scoped per-user (not per-org, since
  // the headline number is the all-orgs total).
  const [sinceLastVisit, setSinceLastVisit] = useState(null)
  useEffect(() => {
    if (overview?.total == null || !user?.id) return
    const key = `quox_brain2_last_seen_total_${user.id}`
    const stored = localStorage.getItem(key)
    const storedTotal = stored != null ? Number(stored) : null
    if (storedTotal != null && Number.isFinite(storedTotal) && overview.total > storedTotal) {
      setSinceLastVisit(overview.total - storedTotal)
    }
    localStorage.setItem(key, String(overview.total))
    // Deliberately only on the first overview load of this mount (empty dep
    // beyond the guard above would re-stamp on every 60s refresh, which
    // would make the delta pill immediately zero itself out).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview != null && overview.total != null && overviewSupported, user?.id])

  // Feed-status chip (P2d-d) — existing /api/feed/status endpoint (see
  // Brain2Settings.jsx). Best-effort: failures leave feedStatus null and the
  // chip simply doesn't render, same non-fatal pattern as brainStatus below.
  const [feedStatus, setFeedStatus] = useState(null)
  const loadFeedStatus = useCallback(async () => {
    if (!authFetch) return
    try {
      setFeedStatus(await getFeedStatus({ authFetch }))
    } catch {
      setFeedStatus(null)
    }
  }, [authFetch])
  useEffect(() => { loadFeedStatus() }, [loadFeedStatus])
  useEffect(() => {
    const id = setInterval(loadFeedStatus, 60000)
    return () => clearInterval(id)
  }, [loadFeedStatus])

  const feedLastSync = useMemo(() => {
    const sync = (feedStatus?.sources || [])
      .map((s) => s.last_sync)
      .filter(Boolean)
      .sort()
      .pop()
    return sync || null
  }, [feedStatus])
  const feedLastSyncMinutes = minutesSince(feedLastSync)

  // Facet selections — empty array in any group = "all" for that group
  const [selectedScopes, setSelectedScopes] = useState([])
  const [selectedSources, setSelectedSources] = useState([])
  const [selectedLanguages, setSelectedLanguages] = useState([])

  // Graph colour mode
  const [colorBy, setColorBy] = useState('scope') // 'scope' | 'source' | 'recency' | 'citations' | 'consolidation'

  // Register form
  const [showRegister, setShowRegister] = useState(false)
  const [vaultName, setVaultName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [registerScope, setRegisterScope] = useState('org')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  // Reindex — only meaningful once exactly one Source chip is selected,
  // since reindex is still a per-vault operation server-side.
  const [reindexing, setReindexing] = useState(false)
  const [reindexError, setReindexError] = useState(null)

  // Union graph (/brain/graph)
  const [graph, setGraph] = useState(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState(null)

  // Hover (for label-on-hover + link/neighbor highlight)
  const [hoverNodeId, setHoverNodeId] = useState(null)

  // Note reader
  const [selectedNoteId, setSelectedNoteId] = useState(null)
  // Deep link /brain2?note=<id>: held until the graph has loaded (the graph
  // load effect resets selection), then applied once.
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingDeepLinkRef = useRef(readNoteParam(searchParams))
  const [note, setNote] = useState(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState(null)
  const [loadingMoreNote, setLoadingMoreNote] = useState(false)

  // BRAIN2-CORTEX P1b — right-panel dock: 'note' (reader) | 'cortex' (agent chat).
  // cortexHighlightIds = the notes Cortex cited this turn, unioned into the same
  // highlight path as search matches so cited notes light up in the brain.
  const [dockTab, setDockTab] = useState(() => (parseLayoutParam(searchParams.get('layout'))?.cortex ? 'cortex' : 'note'))
  // Pane layout (the NotesQ pattern, components/brain2/lib/workspaceLayout.js):
  // user-chosen library/dock state (null = no opinion) + focus. What renders is
  // derived from it and the WORKSPACE width (not the viewport), further down.
  // ?layout=library,dock,focus,cortex applies explicit state for this load only.
  const urlLayoutRef = useRef(parseLayoutParam(searchParams.get('layout')))
  const [layoutState, dispatchLayout] = useReducer(layoutReducer, undefined, () => {
    const u = urlLayoutRef.current
    return u ? { library: u.library, dock: u.dock, focus: u.focus, wide: u.wide } : INITIAL_LAYOUT
  })
  const [workspaceRef, { width: workspaceWidth }] = useContainerSize()
  const [railDrawerOpen, setRailDrawerOpen] = useState(false)
  // BRAIN2-V2 P2c — Read mode: expand the selected note to a comfortable 72ch
  // reading column filling the workspace, graph paused (still mounted) beneath.
  // Session-only; exits on Esc and whenever the selection clears.
  const [readMode, setReadMode] = useState(false)
  // P2c — resizable evidence dock. null = use the per-tab default (Cortex wants
  // a touch more room); once the user drags/keys the separator, this pins px.
  // Resize adjusts the --bw-dock-w CSS var only — it never reparents the graph,
  // so the R3F scene is not remounted (Phase-2 review, riskiest-step guard).
  const [dockWidth, setDockWidth] = useState(null)
  // "Ask about this note" (NoteReader) → flip to Cortex and seed its composer
  // with the note's title as context. The user can edit/clear before sending.
  const [cortexSeed, setCortexSeed] = useState('')
  const handleAskAboutNote = useCallback((n) => {
    setCortexSeed(buildAskAboutNoteSeed(n))
    setDockTab('cortex')
    dispatchLayout({ type: 'REVEAL_DOCK' })
  }, [])
  // P2c — dock resize (pointer + keyboard). Dock sits on the right, so dragging
  // the separator LEFT widens it; ArrowLeft widens, ArrowRight narrows, Home/dbl
  // click resets. Clamped 320px up to whatever leaves the graph 360px (dockMaxRef,
  // set from the workspace width below; was a fixed 720px).
  const dockMaxRef = useRef(720)
  const dockDefaultWidth = dockTab === 'cortex' ? 500 : 440
  const startDockResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const base = Math.min(dockWidth ?? (dockTab === 'cortex' ? 500 : 440), dockMaxRef.current)
    const onMove = (ev) => setDockWidth(Math.max(320, Math.min(dockMaxRef.current, base + (startX - ev.clientX))))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [dockWidth, dockTab])
  const onDockResizeKey = useCallback((e) => {
    const base = Math.min(dockWidth ?? (dockTab === 'cortex' ? 500 : 440), dockMaxRef.current)
    if (e.key === 'ArrowLeft') { e.preventDefault(); setDockWidth(Math.min(dockMaxRef.current, base + 24)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setDockWidth(Math.max(320, base - 24)) }
    else if (e.key === 'Home') { e.preventDefault(); setDockWidth(440) }
  }, [dockWidth, dockTab])
  const [cortexHighlightIds, setCortexHighlightIds] = useState(null)
  // Real Cortex turn activity ('idle' | 'searching' | 'answering'), derived
  // from CortexDock's isProcessing state — feeds BrainOrgan3D's `activity` prop.
  const [cortexActivity, setCortexActivity] = useState({ phase: 'idle' })
  // STABLE identity (useCallback) is load-bearing: CortexDock's activity effect
  // lists this in its deps and calls it when a turn is in flight. An inline
  // arrow here gets a new identity every render, so the effect re-ran → setState
  // → re-render → new identity → re-ran … an infinite loop that crashed the whole
  // route. The functional update also no-ops when the phase is unchanged so we
  // don't churn a new activity object (and reset the brain's phase clock) needlessly.
  const handleCortexActivity = useCallback((phase) => {
    setCortexActivity((prev) => (prev.phase === phase ? prev : { phase }))
  }, [])

  // BRAIN2-AUTONOMIC — derived from real /brain/activity polling (below,
  // placed after graphData exists) so the living brain reacts to actual
  // ingest/dream/embedding activity rather than only Cortex turns.
  // sparkIds: newly-ingested note ids present in the current graph.
  // dreamPulse: monotonic counter, increments on each new dream run detected.
  // shimmer: 0..1 recent embedding intensity.
  const [autonomic, setAutonomic] = useState({ sparkIds: null, dreamPulse: 0, shimmer: 0, ingestPulse: 0 })
  const seenNoteIdsRef = useRef(null)
  const lastDreamRunAtRef = useRef(null)
  const dreamPulseRef = useRef(0)
  // Monotonic counter bumped on ANY real ingest (even notes not in the rendered
  // snapshot) → a whole-brain "new knowledge arrived" glow, so ingestion is
  // visible regardless of graph membership. sparkIds still flashes the specific
  // new neurons when they ARE rendered.
  const ingestPulseRef = useRef(0)

  // Search (/brain/search)
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebounce(searchQuery, 300)
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [searchInsufficient, setSearchInsufficient] = useState(false) // BRAIN2-W5 140
  const [searchReranked, setSearchReranked] = useState(false) // BRAIN2-W11 B
  const [searchOpen, setSearchOpen] = useState(false)
  // "Ask Qortex" starter questions generated from this org's own corpus.
  const [suggestions, setSuggestions] = useState([])

  const fgRef = useRef(null)
  const fg3dRef = useRef(null)
  const [canvasWrapRef, { width: canvasWidth, height: canvasHeight }] = useContainerSize()
  const canvasElRef = useRef(null)
  const prefersReducedMotion = useReducedMotion()

  // ── 2d/3d/brain renderer toggle — starts at 2d; once the brain-status
  // fetch confirms the org actually HAS notes, the signature living-brain
  // view becomes the default (unless the user has already picked a mode by
  // hand — see chooseViewMode / viewModeTouchedRef below). Only one of
  // fgRef/fg3dRef is ever mounted at a time, so `fgRef.current ||
  // fg3dRef.current` always resolves to the live force-graph instance
  // (brain mode mounts neither — both refs null, all `?.` calls no-op).
  const [viewMode, setViewMode] = useState('2d')
  const viewModeTouchedRef = useRef(false)
  const chooseViewMode = useCallback((mode) => {
    viewModeTouchedRef.current = true
    setViewMode(mode)
  }, [])
  const activeGraphInstance = useCallback(() => fgRef.current || fg3dRef.current, [])

  // ── Brain-mode spin toggle (BRAIN2-PRODUCT P1c) — persisted per user+org
  // in the memory service's identity_blobs 'personalization' namespace (the
  // sanctioned server-side store; see services/memory/server.js
  // IDENTITY_NAMESPACES — NOT localStorage, per the data-persistence rule).
  // Best-effort on both legs: a memory-service hiccup leaves the toggle
  // working in-session with the default (spinning); it never blocks the view.
  const [spinEnabled, setSpinEnabled] = useState(true)
  // Last-loaded personalization doc, so the write-through merges instead of
  // clobbering other personalization keys.
  const personalizationRef = useRef(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { getMemoryClient } = await import('../../services/memoryClient')
        const blob = await getMemoryClient().getIdentity('personalization')
        if (cancelled) return
        personalizationRef.current = (blob?.data && typeof blob.data === 'object') ? blob.data : {}
        if (typeof personalizationRef.current.brainSpinEnabled === 'boolean') {
          setSpinEnabled(personalizationRef.current.brainSpinEnabled)
        }
      } catch {
        // Server unavailable — keep the in-session default; the next toggle
        // still attempts the write-through below.
        if (!cancelled) personalizationRef.current = personalizationRef.current || {}
      }
    })()
    return () => { cancelled = true }
  }, [])
  const toggleSpin = useCallback(() => {
    setSpinEnabled((s) => {
      const next = !s
      ;(async () => {
        try {
          const { getMemoryClient } = await import('../../services/memoryClient')
          const merged = { ...(personalizationRef.current || {}), brainSpinEnabled: next }
          await getMemoryClient().setIdentity('personalization', merged)
          personalizationRef.current = merged
        } catch (err) {
          console.warn('[Qortex] spin preference not persisted (memory service unavailable):', err?.message)
        }
      })()
      return next
    })
  }, [])

  // ── Living-brain organ data (/brain/status: real noteCount + growth band
  // + next-milestone). Non-fatal — on error brain mode falls back to the
  // sources-meta total and a 'dormant' band.
  const [brainStatus, setBrainStatus] = useState(null)
  const loadBrainStatus = useCallback(async () => {
    try {
      setBrainStatus(await client.getBrainStatus())
    } catch {
      setBrainStatus(null)
    }
  }, [client])
  useEffect(() => { loadBrainStatus() }, [loadBrainStatus])

  // First-run onboarding (BRAIN2-W8). Progress is server-derived inside the card;
  // localStorage only remembers that the user dismissed it (a UI preference).
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try { return localStorage.getItem('brain2.onboarding.dismissed') === '1' } catch { return false }
  })
  const [onboardingStarted, setOnboardingStarted] = useState(false)
  const onboardingNoteCount = brainStatus?.noteCount ?? sourcesMeta?.totalNotes ?? null
  useEffect(() => {
    if (onboardingNoteCount === 0) setOnboardingStarted(true)
  }, [onboardingNoteCount])
  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true)
    try { localStorage.setItem('brain2.onboarding.dismissed', '1') } catch { /* preference only */ }
  }, [])
  const showOnboarding = onboardingNoteCount !== null && shouldShowOnboarding({ noteCount: onboardingNoteCount, dismissed: onboardingDismissed, started: onboardingStarted })

  // Default to the living-brain view once we know the org's brain actually
  // has notes. Empty brains keep the 2d default — a fully dark dormant organ
  // is a worse first impression than the (equally empty) 2d canvas + its
  // guidance copy. Never overrides a mode the user picked by hand.
  useEffect(() => {
    if (viewModeTouchedRef.current || sourcesLoading) return
    if ((sourcesMeta?.totalNotes || 0) > 0) setViewMode('brain')
  }, [sourcesLoading, sourcesMeta])

  // ── 3D glow parity — load THREE only once the user actually opens 3D mode,
  // so 2D-only sessions never pay for it.
  const [threeMod, setThreeMod] = useState(null)
  useEffect(() => {
    if (viewMode !== '3d' || threeMod) return
    let cancelled = false
    loadThreeModule().then((mod) => { if (!cancelled) setThreeMod(mod) })
    return () => { cancelled = true }
  }, [viewMode, threeMod])

  // ── Fullscreen (graph canvas only — same idiom as TopologyPopup.jsx) ────
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      canvasElRef.current?.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }, [])

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
      // Canvas re-measures async (ResizeObserver) after the viewport jump —
      // re-fit once it's settled rather than staying at the old boxed zoom.
      setTimeout(() => activeGraphInstance()?.zoomToFit(400, 70), 80)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
      e.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  // ── Fullscreen note popup (BRAIN2-PRODUCT P1d) — the NoteReader panel is
  // hidden while fullscreen (see the render below), so clicking a node there
  // needs its own in-fullscreen surface. `fullscreenNoteOpen` is separate from
  // `selectedNoteId` so closing the popup (X or Escape) doesn't deselect the
  // node or blank the (still-mounted, just off-screen) side panel.
  const [fullscreenNoteOpen, setFullscreenNoteOpen] = useState(false)
  useEffect(() => {
    if (!isFullscreen) setFullscreenNoteOpen(false)
  }, [isFullscreen])

  useEffect(() => {
    if (!isFullscreen || !fullscreenNoteOpen) return
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return
      // Close the popup on the FIRST Escape and swallow it — native fullscreen
      // exit only fires from an Escape the browser itself sees, so a second,
      // un-intercepted Escape (popup already closed) exits fullscreen as
      // normal. preventDefault here is best-effort: some browsers reserve the
      // fullscreen-exit shortcut and won't honor it, which is an acceptable
      // fallback (double-Escape), not a bug.
      e.preventDefault()
      e.stopPropagation()
      setFullscreenNoteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isFullscreen, fullscreenNoteOpen])

  // { keyOf, centers } for the active colour-by grouping — read every tick
  // by the cluster force (below) and by the region-label backdrop painter.
  // A ref, not state: it's written from inside a d3 force callback's outer
  // effect and must never trigger its own re-render.
  const groupClusterRef = useRef({ keyOf: null, centers: new Map() })
  const clusterForceRef = useRef(null)
  if (!clusterForceRef.current) {
    clusterForceRef.current = makeClusterForce(groupClusterRef, CLUSTER_STRENGTH)
  }

  // ── Load brain facet metadata ────────────────────────────────────────
  const loadSources = useCallback(async () => {
    setSourcesLoading(true)
    setSourcesError(null)
    try {
      const data = await client.getBrainSources()
      setSourcesMeta(data)
    } catch (err) {
      setSourcesError(err.message || 'Failed to load brain sources')
      setSourcesMeta(null)
    } finally {
      setSourcesLoading(false)
    }
  }, [client])

  useEffect(() => { loadSources() }, [loadSources])

  // Re-load on org switch — the brain is org-scoped-union, so without this
  // the user has to hard-refresh after switching orgs (App.jsx fires
  // `quox-org-switch` app-wide already).
  useEffect(() => {
    const onOrgSwitch = () => {
      setSelectedScopes([])
      setSelectedSources([])
      setSelectedLanguages([])
      graphGuardRef.current.invalidate()
      setGraph(null)
      setSelectedNoteId(null)
      setNote(null)
      setSearchResults([])
      setEmptyOrgBannerDismissed(false)
      loadSources()
      loadBrainStatus()
    }
    window.addEventListener('quox-org-switch', onOrgSwitch)
    return () => window.removeEventListener('quox-org-switch', onOrgSwitch)
  }, [loadSources, loadBrainStatus])

  const hasSources = (sourcesMeta?.sources?.length || 0) > 0
  const graphGuardRef = useRef(null)
  if (!graphGuardRef.current) graphGuardRef.current = createLatestGuard()

  // ── Load the union graph whenever facet selection changes ───────────
  const loadGraph = useCallback(async (facets) => {
    const token = graphGuardRef.current.begin()
    setGraphLoading(true)
    setGraphError(null)
    try {
      const data = await client.getBrainGraph({ ...facets, limit: 800 })
      if (!graphGuardRef.current.isCurrent(token)) return // BRAIN2-W7 E 132: stale response
      setGraph(data)
    } catch (err) {
      if (!graphGuardRef.current.isCurrent(token)) return
      setGraphError(err.message || 'Failed to load graph')
      setGraph(null)
    } finally {
      if (graphGuardRef.current.isCurrent(token)) setGraphLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (sourcesLoading || !hasSources) return
    setSelectedNoteId(null)
    setNote(null)
    setNoteError(null)
    loadGraph({ sources: selectedSources, scopes: selectedScopes, languages: selectedLanguages })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesLoading, hasSources, selectedSources, selectedScopes, selectedLanguages, loadGraph])

  // ── Load note whenever selection changes ─────────────────────────────
  useEffect(() => {
    if (!selectedNoteId) { setNote(null); return }
    let cancelled = false
    setNoteLoading(true)
    setNoteError(null)
    client.getNote(selectedNoteId)
      .then((data) => { if (!cancelled) setNote(data) })
      .catch((err) => { if (!cancelled) setNoteError(err.message || 'Failed to load note') })
      .finally(() => { if (!cancelled) setNoteLoading(false) })
    return () => { cancelled = true }
  }, [selectedNoteId, client])

  // P2d — durable layout prefs. Stored in a DEDICATED per-user identity
  // namespace ('brain_workspace') that nothing else writes, so a full-document
  // PUT there has no cross-writer clobber (Phase-2 review: isolate in a
  // protected namespace). Pure disposable geometry only — rail + dock collapse and dock
  // width; no saved views. Best-effort: a failed save must never break the UI.
  const prefsLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getMemoryClient().getIdentity('brain_workspace')
        const blob = res?.data // getIdentity returns { namespace, data, updated_at }
        if (!cancelled && blob) {
          // Never overwrite an in-flight interaction with late-arriving stored state.
          // HYDRATE fills only panes the user has no opinion on yet (a ?layout= load
          // or an early click wins), so late-arriving prefs never undo a choice.
          if (!urlLayoutRef.current) dispatchLayout({ type: 'HYDRATE', ...hydrateFromPrefs(blob) })
          if (typeof blob.dockWidth === 'number') setDockWidth((cur) => (cur === null ? Math.max(320, Math.min(2400, blob.dockWidth)) : cur))
        }
      } catch { /* best-effort: layout memory is not load-bearing */ }
      finally { if (!cancelled) prefsLoadedRef.current = true }
    })()
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!prefsLoadedRef.current) return
    const t = setTimeout(() => {
      // A ?layout= load is a one-off view (screenshots, shared links): never persisted.
      if (urlLayoutRef.current) return
      getMemoryClient().setIdentity('brain_workspace', { ...persistable(layoutState), dockWidth }).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [layoutState.library, layoutState.dock, dockWidth])

  // Effective layout from the WORKSPACE width. 0 = not measured yet: treat as
  // wide so the first paint never flashes a collapse it is about to undo.
  const wsW = workspaceWidth || 0
  const drawer = wsW > 0 && wsW <= DRAWER_PX
  const baseLayout = effectiveLayout(layoutState, {
    narrow: wsW > 0 && wsW < NARROW_PX,
    drawer,
    dockHasContent: !!selectedNoteId || dockTab === 'cortex',
  })
  // An open dock sits beside the stage only while the graph keeps STAGE_MIN; else it drops below.
  const layout = {
    ...baseLayout,
    stacked: dockPlacement({ width: wsW, libraryCollapsed: baseLayout.libraryCollapsed, drawer, focus: baseLayout.focus, wide: baseLayout.wide, dockWidth: Math.min(dockWidth ?? dockDefaultWidth, dockMaxWidth({ width: wsW, libraryCollapsed: baseLayout.libraryCollapsed, drawer })) }) === 'stacked',
  }
  const dockMax = dockMaxWidth({ width: wsW, libraryCollapsed: layout.libraryCollapsed, drawer })
  dockMaxRef.current = dockMax
  const renderedDockWidth = Math.min(dockWidth ?? dockDefaultWidth, dockMax)
  const toggleWide = () => dispatchLayout({ type: 'TOGGLE_WIDE' })
  const activeFilterCount = selectedScopes.length + selectedSources.length + selectedLanguages.length
  const toggleLibrary = () => dispatchLayout({ type: 'TOGGLE_LIBRARY', current: layout.libraryCollapsed })
  const toggleDock = () => dispatchLayout({ type: 'TOGGLE_DOCK', current: layout.dockCollapsed })
  const toggleFocus = () => dispatchLayout({ type: 'TOGGLE_FOCUS' })
  // The library drawer only exists in drawer mode: leaving it closes the drawer.
  useEffect(() => { if (!layout.drawer && railDrawerOpen) setRailDrawerOpen(false) }, [layout.drawer, railDrawerOpen])

  // Focus: Esc leaves it (Read mode, an overlay above it, takes Esc first).
  useEffect(() => {
    if (!(layoutState.focus || layoutState.wide) || readMode) return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) dispatchLayout({ type: 'ESCAPE' }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layoutState.focus, layoutState.wide, readMode])

  // P2c — Read mode lifecycle: clearing the selection leaves Read mode; Esc
  // exits it (capture phase so it wins over lower-priority Escape handlers).
  useEffect(() => {
    if (readMode && !selectedNoteId) setReadMode(false)
  }, [readMode, selectedNoteId])
  useEffect(() => {
    if (!readMode) return
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setReadMode(false) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [readMode])

  // Note preview page size — mirrors the server's NOTE_PREVIEW_CHARS
  // (services/quoxbrain/server.js) so a "Load more" click fetches roughly one
  // more page of body text via the existing ?range=a:b contract.
  const NOTE_CHUNK_CHARS = 8 * 1024

  // ── "Load more" for a truncated note body (BRAIN2-PRODUCT P1d) — fetches
  // the next char range and appends. `body_length` (parallel backend change,
  // see note contract) gives an exact remaining-length check when present;
  // without it yet, fall back to "the chunk came back full-size, so there's
  // probably more" — an honest heuristic, not a guarantee, until that field
  // ships.
  const handleLoadMoreNote = useCallback(async () => {
    if (!selectedNoteId || !note || loadingMoreNote) return
    const start = note.body?.length || 0
    const end = start + NOTE_CHUNK_CHARS
    setLoadingMoreNote(true)
    setNoteError(null)
    try {
      const chunk = await client.getNote(selectedNoteId, { range: `${start}:${end}` })
      setNote((prev) => {
        if (!prev || prev.id !== chunk.id) return prev
        const appended = (prev.body || '') + (chunk.body || '')
        const bodyLength = chunk.body_length ?? prev.body_length ?? null
        const stillTruncated = bodyLength != null
          ? appended.length < bodyLength
          : (chunk.body || '').length >= NOTE_CHUNK_CHARS
        return { ...prev, body: appended, truncated: stillTruncated }
      })
    } catch (err) {
      setNoteError(err.message || 'Failed to load more of the note')
    } finally {
      setLoadingMoreNote(false)
    }
  }, [client, selectedNoteId, note, loadingMoreNote])

  // BRAIN2-W7 E 134: a cited span beyond the loaded preview is fetched, not left to a manual hunt.
  // Declared before the effect below that depends on it (TDZ crash 2026-10-06).
  const [citedSpan, setCitedSpan] = useState(null)
  useEffect(() => {
    if (!citedSpan || !note || note.id !== citedSpan.noteId || loadingMoreNote) return
    const st = spanLoadState(citedSpan, note.body?.length || 0, note.truncated)
    if (st.state !== 'load') return
    let cancelled = false
    setLoadingMoreNote(true)
    client.getNote(citedSpan.noteId, { range: `${st.start}:${st.end}` })
      .then((chunk) => {
        if (cancelled) return
        setNote((prev) => {
          if (!prev || prev.id !== chunk.id) return prev
          const appended = (prev.body || '') + (chunk.body || '')
          const bodyLength = chunk.body_length ?? prev.body_length ?? null
          return { ...prev, body: appended, truncated: bodyLength != null ? appended.length < bodyLength : prev.truncated }
        })
      })
      .catch(() => {})
      .finally(() => setLoadingMoreNote(false))
    return () => { cancelled = true }
  }, [citedSpan, note, loadingMoreNote, client])

  // ── Suggestions — best-effort; the empty-search state just shows none on failure
  useEffect(() => {
    let cancelled = false
    client.brainSuggestions({ count: 8 })
      .then((data) => { if (!cancelled) setSuggestions(data.suggestions || []) })
      .catch(() => { if (!cancelled) setSuggestions([]) })
    return () => { cancelled = true }
  }, [client, currentOrg?.id])

  // ── Search — brain-wide, honors the active facet selection ──────────
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSearchResults([])
      setSearchError(null)
      setSearchInsufficient(false)
      setSearchReranked(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)
    client.brainSearch(debouncedQuery.trim(), {
      sources: selectedSources, scopes: selectedScopes, languages: selectedLanguages, limit: 20
    })
      .then((data) => {
        if (cancelled) return
        const outcome = interpretSearchResponse(data)
        setSearchInsufficient(outcome.insufficient)
        setSearchReranked(outcome.reranked)
        setSearchResults(outcome.results)
      })
      .catch((err) => { if (!cancelled) { setSearchError(err.message || 'Search failed'); setSearchResults([]); setSearchInsufficient(false) } })
      .finally(() => { if (!cancelled) setSearchLoading(false) })
    return () => { cancelled = true }
  }, [debouncedQuery, selectedSources, selectedScopes, selectedLanguages, client])

  // ── Actions ───────────────────────────────────────────────────────────
  const handleRegister = useCallback(async (e) => {
    e.preventDefault()
    if (!vaultName.trim()) return
    if (registerScope === 'org' && !sourcePath.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      await client.createVault({
        name: vaultName.trim(),
        source_path: registerScope === 'org' ? sourcePath.trim() : undefined,
        source_type: registerScope === 'org' ? 'local' : 'push',
        scope: registerScope
      })
      setShowRegister(false)
      setVaultName('')
      setSourcePath('')
      setRegisterScope('org')
      await loadSources()
      await loadGraph({ sources: selectedSources, scopes: selectedScopes, languages: selectedLanguages })
    } catch (err) {
      setCreateError(err.message || 'Failed to register source')
    } finally {
      setCreating(false)
    }
  }, [client, vaultName, sourcePath, registerScope, loadSources, loadGraph, selectedSources, selectedScopes, selectedLanguages])

  const handleReindex = useCallback(async () => {
    if (selectedSources.length !== 1) return
    setReindexing(true)
    setReindexError(null)
    try {
      await client.reindexVault(selectedSources[0])
      await loadSources()
      await loadGraph({ sources: selectedSources, scopes: selectedScopes, languages: selectedLanguages })
    } catch (err) {
      setReindexError(err.message || 'Reindex failed')
    } finally {
      setReindexing(false)
    }
  }, [client, selectedSources, selectedScopes, selectedLanguages, loadSources, loadGraph])

  const focusNode = useCallback((id) => {
    const n = graph?.nodes?.find((x) => x.id === id)
    if (n && fgRef.current && typeof n.x === 'number') {
      fgRef.current.centerAt(n.x, n.y, 500)
      fgRef.current.zoom(4, 500)
    }
  }, [graph])

  // Apply a pending ?note= deep link once the graph is loaded (or failed/empty).
  useEffect(() => {
    const id = pendingDeepLinkRef.current
    if (!id || sourcesLoading || graphLoading) return
    if (hasSources && !graph && !graphError) return
    pendingDeepLinkRef.current = null
    setSelectedNoteId(id)
    setDockTab('note')
    // A link to a note is a request to read it: open the reader even when the
    // viewer's saved layout keeps the dock collapsed (2026-10-11: shared links
    // landed on the graph with the note hidden).
    dispatchLayout({ type: 'REVEAL_DOCK' })
    focusNode(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesLoading, graphLoading, graph, graphError, hasSources])

  // Keep ?note= in sync with the selection (replace, never push).
  useEffect(() => {
    if (pendingDeepLinkRef.current) return
    const next = syncNoteParam(searchParams, selectedNoteId)
    if (next) setSearchParams(next, NOTE_SYNC_OPTIONS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId])

  const selectNote = useCallback((id) => {
    setSelectedNoteId(id)
    setFullscreenNoteOpen(true)
    if (id) dispatchLayout({ type: 'NOTE_SELECTED' })
    focusNode(id)
  }, [focusNode])

  const handleSearchResultClick = useCallback((result) => {
    selectNote(result.noteId)
    setSearchOpen(false)
  }, [selectNote])

  // BRAIN2-CORTEX P1b — a citation click from Cortex reveals the note in the
  // side reader (NOT the fullscreen overlay selectNote opens) and frames the
  // graph on it, so the brain and the chat stay visible: the ask -> cited notes
  // light up -> click -> read loop happens without leaving the workspace.
  // BRAIN2-W7 E 134: the clicked citation's exact span, shown as a highlighted passage.
  const revealCitedNote = useCallback((noteId, span) => {
    const s = normalizeSpan(span)
    setCitedSpan(s ? { noteId, ...s } : null)
    setSelectedNoteId(noteId)
    setDockTab('note')
    dispatchLayout({ type: 'REVEAL_DOCK' })
    focusNode(noteId)
  }, [focusNode])

  const handleFitToView = useCallback(() => {
    activeGraphInstance()?.zoomToFit(400, 60)
  }, [activeGraphInstance])

  const toggleScope = useCallback((scope) => setSelectedScopes((prev) => toggleInArray(prev, scope)), [])
  const toggleSource = useCallback((vaultId) => setSelectedSources((prev) => toggleInArray(prev, vaultId)), [])
  const toggleLanguage = useCallback((lang) => setSelectedLanguages((prev) => toggleInArray(prev, lang)), [])

  // ── Graph render data (kept by reference so the sim can mutate x/y in place) ──
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    // Living-pulse precompute: stamp each node with a deterministic phase
    // offset + degree-scaled amplitude ONCE, cached directly on the node
    // object (same pattern as d3 stamping x/y on it). paintNode reads these
    // every frame but never computes them — that's the perf-critical part.
    for (const node of graph.nodes) {
      if (node._pulsePhase === undefined) {
        node._pulsePhase = hashPhase(node.id)
        // 12%..18% amplitude — hub nodes (high degree) breathe more.
        node._pulseAmp = 0.12 + Math.min(node.degree || 0, 20) * 0.003
      }
    }
    return {
      nodes: graph.nodes,
      links: (graph.edges || []).map((e) => ({ source: e.source, target: e.target, type: e.type }))
    }
  }, [graph])

  // Mirror graphData into a ref so the autonomic-activity poll below can read
  // the CURRENT rendered node ids without listing graphData in its own effect
  // deps — that would tear down + restart the 20s interval on every graph
  // reload, which isn't a leak (cleanup still runs) but is unnecessary churn.
  const graphDataRef = useRef(graphData)
  useEffect(() => { graphDataRef.current = graphData }, [graphData])

  // BRAIN2-AUTONOMIC — poll the REAL /brain/activity endpoint so the living
  // brain reacts to actual ingest/dream/embedding events, not just Cortex
  // turns. Visualization-only: this is a live-tab poll (not a background
  // job — CLAUDE.md's browser-timer rule bars scheduling durable work this
  // way, not a UI refresh that stops the moment the tab closes), and it
  // never persists anything or throws on failure.
  useEffect(() => {
    if (!authFetch) return
    let cancelled = false
    const poll = async () => {
      let j
      try {
        const res = await authFetch('/collector/api/brain/activity?window=60')
        if (!res || !res.ok) return // non-2xx is not data — skip this tick
        j = await res.json()
      } catch {
        return // best-effort: the brain simply doesn't react this tick
      }
      if (cancelled || !j) return

      const graphIds = new Set((graphDataRef.current?.nodes || []).map((n) => String(n.id)))

      let sparkIds = null
      const seen = seenNoteIdsRef.current
      const incomingIds = (j.ingest?.noteIds || []).map(String)
      if (seen === null) {
        // First successful poll: seed the seen-set from the current backlog
        // so we don't spark every existing note on load.
        seenNoteIdsRef.current = new Set(incomingIds)
      } else {
        const newIds = incomingIds.filter((id) => !seen.has(id))
        for (const id of incomingIds) seen.add(id)
        const sparkInGraph = newIds.filter((id) => graphIds.has(id))
        sparkIds = sparkInGraph.length ? new Set(sparkInGraph) : null
        // Ambient glow on ANY real ingest, even if the new notes aren't rendered.
        if (newIds.length > 0) ingestPulseRef.current += 1
      }

      let pulse = dreamPulseRef.current
      const last = j.dream?.lastRunAt || null
      if (last && last !== lastDreamRunAtRef.current) {
        const wasFirstPoll = lastDreamRunAtRef.current === null
        lastDreamRunAtRef.current = last
        if (!wasFirstPoll) {
          pulse = dreamPulseRef.current + 1
          dreamPulseRef.current = pulse
        }
      }

      const shimmer = Math.max(0, Math.min(1, (j.embedding?.recentlyEmbeddedChunks || 0) / 50))

      setAutonomic({ sparkIds, dreamPulse: pulse, shimmer, ingestPulse: ingestPulseRef.current })
    }
    poll() // immediate first poll — don't wait 20s to react
    const id = setInterval(poll, 20000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [authFetch])

  // Stronger cluster separation — the whole-brain union graph is denser than
  // a single vault ever was, so the default d3-force charge/link-distance
  // collapses everything into a hairball. Configure the sim directly via the
  // ref once it's live for this data set, and (re)register the clustering
  // force alongside it so a fresh node array is always clustered from tick 1.
  useEffect(() => {
    if (!fgRef.current) return
    // Weak repulsion + short links + a gentle centre gravity => the whole-brain
    // union graph settles into a DENSE glowing disc rather than a wide scatter.
    // Wide spacing (the old -420 / 100) made zoomToFit pull the camera so far
    // back that every node became a sub-pixel speck. Pack tight; let the
    // additive glow in paintNode build luminous cores where nodes cluster.
    const charge = fgRef.current.d3Force('charge')
    if (charge) charge.strength(-90).distanceMax(320)
    const link = fgRef.current.d3Force('link')
    if (link) link.distance(30)
    // Mild gravity toward origin so a near-linkless corpus condenses into a
    // disc instead of drifting apart. forceX/forceY come from d3-force (a
    // transitive dep of react-force-graph); the graph already runs a 'center'
    // force, these just add the pull that makes the field compact.
    fgRef.current.d3Force('x', forceX(0).strength(0.05))
    fgRef.current.d3Force('y', forceY(0).strength(0.05))
    fgRef.current.d3Force('cluster', clusterForceRef.current)
  }, [graphData])

  // Deterministic vaultId -> colour for "colour by source" mode + legend,
  // assigned from the stable server-sorted /brain/sources list.
  const sourceColorMap = useMemo(() => {
    const map = new Map()
    ;(sourcesMeta?.sources || []).forEach((s, i) => map.set(s.vaultId, SOURCE_PALETTE[i % SOURCE_PALETTE.length]))
    return map
  }, [sourcesMeta])

  // Recompute per-group centroids whenever the active grouping dimension,
  // the source roster, or the node set changes — one centroid per scope (3)
  // or per source (up to 8), arranged evenly around the origin so the sim
  // has visible "regions" to pull toward even when the corpus has almost no
  // cross-links. Reheats the sim so nodes visibly migrate to their new
  // region when the "By scope"/"By source" toggle changes.
  useEffect(() => {
    // BRAIN2-V2 lens contract: only the SPATIAL lenses (scope, source) drive
    // clustering + a reheat. The recolour-only lenses (recency, citations,
    // consolidation) must NOT move a single node — they repaint the fixed map.
    // For those, retain the last grouping's centroids and skip the reheat so
    // positions stay deterministic across a lens switch.
    const groupBy = colorBy === 'source' ? 'source' : colorBy === 'scope' ? 'scope' : null
    if (!groupBy) return
    const scopeOrder = ['org', 'user', 'shared']
    const sourceOrder = (sourcesMeta?.sources || []).map((s) => s.vaultId)
    const baseOrder = groupBy === 'source' ? sourceOrder : scopeOrder
    const keyOf = groupBy === 'source'
      ? (n) => n.vaultId || 'unknown'
      : (n) => n.scope || 'unknown'

    const nodes = graphData.nodes || []
    const present = new Set(nodes.map(keyOf))
    const orderedIds = [
      ...baseOrder.filter((id) => present.has(id)),
      ...[...present].filter((id) => !baseOrder.includes(id))
    ]
    const count = orderedIds.length
    // Centroid ring radius scales with the NUMBER OF GROUPS, not the node
    // count — a node-count radius (e.g. sqrt(800)*42 ≈ 1188) flings 2-3 groups
    // ~2400px apart, and zoomToFit then shrinks every node to an invisible
    // speck. Bounded so the whole graph stays within a frame that fits after
    // zoomToFit while still giving each group a distinct region.
    const radius = count <= 1 ? 0 : Math.min(460, 150 + count * 60)

    const centers = new Map()
    orderedIds.forEach((id, i) => {
      if (count <= 1) { centers.set(id, { x: 0, y: 0 }); return }
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2 // start at 12 o'clock
      centers.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
    })

    groupClusterRef.current = { keyOf, centers }
    fgRef.current?.d3ReheatSimulation()
  }, [colorBy, sourcesMeta, graphData])

  // Always returns a 6-digit hex string (never rgba()) — paintNode appends a
  // 2-digit alpha suffix directly onto this for the glow gradient, which
  // only works cleanly against a hex literal.
  const nodeColor = useCallback((node) => (
    resolveNodeColor(node, { colorBy, sourceColorMap, scopeColors: SCOPE_COLORS })
  ), [colorBy, sourceColorMap])

  // Search-visual coupling (BRAIN2-PRODUCT P1e) — the set of note ids the
  // current /brain/search results matched, shared by all three render modes
  // below (2D paintNode, 3D nodeThreeObject, brain mode's highlightIds prop).
  // null (not an empty Set) when there's nothing to couple to, so every
  // consumer can use a single `Boolean(searchMatchIds)` active check.
  // MUST be declared before nodeThreeObject below: its deps array reads this
  // at render time, and a later declaration is a TDZ crash that killed the
  // whole /brain2 route on 2026-08-25 ("Cannot access 'be' before
  // initialization" in the minified chunk).
  const searchMatchIds = useMemo(() => (
    computeSearchMatchIds(searchResults)
  ), [searchResults])

  // Neighbor set of the FOCUSED node — drives the label reveal and the
  // dim-the-rest node highlight. Focus = the hovered node when hovering, else
  // the selected note (BRAIN2-V2 ego-focus): hover is transient and takes
  // precedence; a selection persists, so the graph stays framed on the note
  // being read even after the pointer leaves. Null when neither is active.
  // MUST be declared before nodeThreeObject below (which reads it in its deps
  // array) for the same TDZ reason searchMatchIds is — see the note above.
  const neighborIds = useMemo(() => {
    const focusId = hoverNodeId || selectedNoteId
    return computeNeighborIds(focusId, graphData.links, linkEndId)
  }, [hoverNodeId, selectedNoteId, graphData])

  // BRAIN2-CORTEX P1b — the union of search matches and the notes Cortex cited
  // this turn. Both mean "these notes are relevant, brighten them and dim the
  // rest", so they share one highlight set feeding the brighten/dim path in
  // nodeThreeObject, paintNode and the brain's highlightIds prop. null (not an
  // empty Set) when neither is active, so the Boolean(...) gates below stay valid.
  // MUST be declared before nodeThreeObject/paintNode read it (same TDZ rule as
  // searchMatchIds above — a later declaration crashes the minified chunk).
  const activeHighlightIds = useMemo(() => {
    if (!searchMatchIds && !cortexHighlightIds) return null
    const set = new Set()
    if (searchMatchIds) for (const id of searchMatchIds) set.add(String(id))
    if (cortexHighlightIds) for (const id of cortexHighlightIds) set.add(String(id))
    return set.size > 0 ? set : null
  }, [searchMatchIds, cortexHighlightIds])

  // 3D parity for paintNode's additive glow look: a self-illuminating
  // (emissive) sphere, scaled by degree, coloured by the same scope/source
  // palette as 2D — so switching to 3D reads as deeper immersion, not a
  // downgrade to plain default spheres. Returns undefined until THREE has
  // loaded, in which case react-force-graph-3d falls back to its own default
  // sphere (still coloured via the nodeColor prop) for that first frame.
  const nodeThreeObject = useCallback((node) => {
    if (!threeMod) return undefined
    const color = nodeColor(node)
    // Search-visual coupling (P1e): since this custom object replaces
    // react-force-graph-3d's default sphere entirely, nodeColor/opacity only
    // reach the scene through the material built here, not through separate
    // accessor props — dim non-matches, brighten + enlarge matches.
    const isMatch = activeHighlightIds ? activeHighlightIds.has(String(node.id)) : false
    const isSearchDim = Boolean(activeHighlightIds) && !isMatch
    // Ego-focus parity with 2D: when a note is selected, dim nodes outside its
    // neighbour set. In 3D hoverNodeId is never set (no onNodeHover wired), so
    // neighborIds here reflects the selection only — this callback's identity
    // therefore changes on select, not on every hover, so no per-frame mesh
    // churn. Search dimming takes precedence over focus dimming, as in 2D.
    const isFocusDim = !isSearchDim && Boolean(neighborIds) && !neighborIds.has(node.id)
    const dim = isSearchDim || isFocusDim
    const mesh = new threeMod.Mesh(
      getSharedNodeSphereGeometry(threeMod),
      new threeMod.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: isMatch ? 2.0 : dim ? 0.4 : 1.3,
        roughness: 0.35,
        metalness: 0.05,
        transparent: true,
        opacity: isSearchDim ? 0.15 : isFocusDim ? 0.3 : 0.94
      })
    )
    mesh.scale.setScalar(nodeRadius(node.degree) * (isMatch ? 1.35 : 1))
    return mesh
  }, [threeMod, nodeColor, activeHighlightIds, neighborIds])

  const paintNode = useCallback((node, ctx, globalScale) => {
    // Guard: on the first force ticks node.x/node.y are NaN until d3 assigns
    // positions. createRadialGradient() throws on a non-finite value, which
    // would crash the whole view via the ErrorBoundary (blank page). Skip the
    // frame until coords are valid — invisible, the force settles in a tick.
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return
    const r = nodeRadius(node.degree)
    const isHover = node.id === hoverNodeId
    const isNeighbor = neighborIds ? neighborIds.has(node.id) : false
    const hoverDim = Boolean(neighborIds) && !isNeighbor
    // Search-visual coupling (P1e): a search match takes precedence over the
    // hover-neighbor dim (0.15 vs 0.22) so a query result reads unambiguously
    // even mid-hover.
    const isSearchMatch = activeHighlightIds ? activeHighlightIds.has(String(node.id)) : false
    const searchDim = Boolean(activeHighlightIds) && !isSearchMatch
    const dim = hoverDim || searchDim
    const color = nodeColor(node)

    ctx.globalAlpha = searchDim ? 0.15 : (dim ? 0.22 : 1)

    // ADDITIVE neuron glow: with 'lighter' compositing, overlapping halos SUM,
    // so dense regions bloom into bright cores while sparse edges stay dim.
    // This is the single biggest lever that makes the field read as a living
    // brain/nebula instead of flat, evenly-lit scatter dots.
    const prevOp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = dim ? 'source-over' : 'lighter'
    // Living pulse: the glow (never the solid core dot, so layout/hit-testing
    // stay stable) breathes on a slow sine keyed off each node's precomputed
    // phase/amplitude (see graphData memo) — hub nodes breathe more. Reading
    // performance.now() here (rather than a separate RAF loop) works because
    // autoPauseRedraw={false} keeps the canvas repainting every frame even
    // after the sim has cooled; reduced-motion users get autoPauseRedraw
    // restored AND pulse=0, so the render is fully static for them.
    const pulse = prefersReducedMotion
      ? 0
      : Math.sin((performance.now() / PULSE_PERIOD_MS) * 2 * Math.PI + (node._pulsePhase || 0)) * (node._pulseAmp || 0.15)
    const glowR = r * (isHover ? 4.6 : isNeighbor ? 3.6 : 3.0) * (1 + pulse)
    const glowAlpha = dim ? '10' : isHover ? '66' : isNeighbor ? '4a' : '34'
    const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR)
    glow.addColorStop(0, `${color}${glowAlpha}`)
    glow.addColorStop(0.5, `${color}${dim ? '05' : '18'}`)
    glow.addColorStop(1, `${color}00`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(node.x, node.y, glowR, 0, 2 * Math.PI, false)
    ctx.fill()
    ctx.globalCompositeOperation = prevOp

    // Solid core dot.
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false)
    ctx.fillStyle = color
    ctx.fill()

    // Small offset specular highlight -> lit-sphere depth, so nodes read as
    // rounded beads catching light rather than flat 2D discs.
    if (!dim) {
      ctx.globalAlpha = 0.55
      ctx.beginPath()
      ctx.arc(node.x - r * 0.3, node.y - r * 0.32, r * 0.4, 0, 2 * Math.PI, false)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.globalAlpha = 1
    }

    if (node.id === selectedNoteId) {
      ctx.lineWidth = 2 / globalScale
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
    }

    // Search-match ring: a pulsing stroke distinct from the ambient glow
    // breathe, so a result reads as "found" rather than just "less dim".
    // Static (mid-pulse) for reduced-motion users, same convention as the
    // glow's own `pulse` above.
    if (isSearchMatch) {
      const ringPulse = prefersReducedMotion ? 0.5 : (0.5 + 0.5 * Math.sin((performance.now() / 900) * 2 * Math.PI))
      ctx.globalAlpha = 1
      ctx.lineWidth = (1.6 + ringPulse * 1.4) / globalScale
      ctx.strokeStyle = `${color}${Math.round((0.45 + ringPulse * 0.5) * 255).toString(16).padStart(2, '0')}`
      ctx.beginPath()
      ctx.arc(node.x, node.y, r * (1.8 + ringPulse * 0.6), 0, 2 * Math.PI, false)
      ctx.stroke()
    }

    // Labels only on hover/neighbor OR once zoomed in past the threshold —
    // never paint every node's label unconditionally (that was the hairball).
    const showLabel = !dim && (isHover || isNeighbor || isSearchMatch || globalScale > LABEL_ZOOM_THRESHOLD)
    if (showLabel) {
      const fontSize = Math.max((isHover ? 13 : 11) / globalScale, 2.6)
      ctx.font = `${isHover ? 700 : 500} ${fontSize}px Inter, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = isHover ? '#ffffff' : 'rgba(255,255,255,0.85)'
      ctx.fillText(node.title || node.id, node.x, node.y + r + 2)
    }
    ctx.globalAlpha = 1
  }, [hoverNodeId, neighborIds, nodeColor, selectedNoteId, prefersReducedMotion, activeHighlightIds])

  const paintNodePointerArea = useCallback((node, color, ctx) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return
    ctx.fillStyle = color
    const r = nodeRadius(node.degree)
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false)
    ctx.fill()
  }, [])

  // Drawn via onRenderFramePre — BEFORE nodes/links — so a large, very faint
  // label sits behind each cluster's node cloud at its centroid. This is what
  // makes the regions read as *labeled* regions at a glance rather than
  // requiring hover: node-title labels stay hover/zoom-gated (unchanged),
  // this is a separate, always-on backdrop layer.
  const paintBackdropRegions = useCallback((ctx, globalScale) => {
    const { centers } = groupClusterRef.current
    if (!centers || centers.size === 0) return
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const fontSize = Math.min(46, Math.max(9, 22 / globalScale))
    ctx.font = `700 ${fontSize}px Inter, sans-serif`
    centers.forEach((center, id) => {
      const label = colorBy === 'source'
        ? (sourcesMeta?.sources || []).find((s) => s.vaultId === id)?.name || id
        : (SCOPE_LABELS[id] || id)
      const color = colorBy === 'source' ? (sourceColorMap.get(id) || '#94a3b8') : (SCOPE_COLORS[id] || '#94a3b8')
      ctx.fillStyle = `${color}1c`
      ctx.fillText(String(label).toUpperCase(), center.x, center.y)
    })
    ctx.restore()
  }, [colorBy, sourcesMeta, sourceColorMap])

  const linkColor = useCallback((link) => {
    if (!hoverNodeId) return LINK_TYPE_COLORS[link.type] ? `${LINK_TYPE_COLORS[link.type]}55` : 'rgba(255,255,255,0.14)'
    const s = linkEndId(link.source)
    const t = linkEndId(link.target)
    const connected = s === hoverNodeId || t === hoverNodeId
    return connected ? (LINK_TYPE_COLORS[link.type] || '#38bdf8') : 'rgba(255,255,255,0.04)'
  }, [hoverNodeId])

  const linkWidth = useCallback((link) => {
    if (!hoverNodeId) return 1
    const s = linkEndId(link.source)
    const t = linkEndId(link.target)
    return (s === hoverNodeId || t === hoverNodeId) ? 2.2 : 0.5
  }, [hoverNodeId])

  const handleNodeHover = useCallback((node) => setHoverNodeId(node ? node.id : null), [])

  const hasNodes = (graph?.nodes?.length || 0) > 0
  const hasEdges = (graph?.edges?.length || 0) > 0
  const languagesFacets = (sourcesMeta?.languages || []).filter((l) => l.language)
  const showLanguageFacet = languagesFacets.length > 1

  const shownCount = graph?.nodes?.length || 0
  const totalNotes = sourcesMeta?.totalNotes ?? 0

  // Truncation copy reads the RESPONSE, never the requested cap — the banner
  // used to hard-code "top 800" while the server's node cap is configurable
  // (and the page can be smaller than the cap). `edgesInPage` is the links
  // between the returned nodes before the server's edge cap, so a capped
  // graph can say so instead of silently dropping links.
  const notesTruncated = shownCount < (graph?.total ?? 0)
  const shownEdges = graph?.edges?.length || 0
  const edgesInPage = graph?.edgesInPage ?? shownEdges
  const edgesTruncated = edgesInPage > shownEdges

  // Headline TOTAL (P2a) — the all-orgs overview total when the collector
  // supports it, falling back to the current-org sourcesMeta total the view
  // already had (graceful degradation: no overview route yet == same header
  // as before this stream, never a blank/zero flash).
  // Trust the cross-org overview total only when it actually resolved orgs
  // without errors. An empty or failed overview answers {total: 0}, and `??`
  // does not fall through on 0, so the header read "0 notes" over a 4,470-note
  // brain (BRAIN2-AUDIT 2026-10-05, live screenshot).
  const overviewTrusted = Array.isArray(overview?.orgs) && overview.orgs.length > 0 && overview.orgs.every((o) => !o.error)
  const headlineTotal = overviewTrusted ? overview.total : totalNotes
  const orgOverviewEntries = overview?.orgs || []
  const currentOrgEntry = orgOverviewEntries.find((o) => o.org_id === currentOrg?.id) || null
  const newestNoteAgo = currentOrgEntry?.newestNoteAt ? timeAgo(currentOrgEntry.newestNoteAt) : null

  // Personal-layer honesty (BRAIN2-PRODUCT, owner catch 2026-08-25) —
  // `personal` is the caller's own note count, counted once regardless of
  // which org is active; `null` on a backend that predates the split, in
  // which case neither the chip nor the banner below render anything new.
  const hasPersonalCount = typeof overview?.personal === 'number'
  const showPersonalChip = hasPersonalCount && overview.personal > 0
  const orgDisplayName = currentOrg?.name || currentOrgEntry?.org_id || 'This org'
  const showEmptyOrgBanner = !emptyOrgBannerDismissed
    && hasPersonalCount && overview.personal > 0
    && currentOrgEntry && !currentOrgEntry.error && currentOrgEntry.noteCount === 0

  const feedDotClass = feedLastSync == null
    ? 'qx-dot--idle'
    : (feedLastSyncMinutes != null && feedLastSyncMinutes < 35 ? 'qx-dot--online' : 'qx-dot--degraded')
  const feedLabel = feedLastSync ? `feed: last ingest ${timeAgo(feedLastSync)}` : 'feed: no ingest yet'

  return (
    <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, overflowY: 'auto' }}>
      {/* Header — ONE BRAIN identity + the all-orgs TOTAL + growth affordances
          (BRAIN2-PRODUCT P2a/P2d), no vault-picker. */}
      {/* Top identity bar — only in the loading/empty/error states. In the
          workspace (hasSources) the identity, actions and orgs live in the
          Library rail so the brain gets the full height (BRAIN2-V2 P2b-2). */}
      {!hasSources && (
      <section className="qx-card qx-card--bar">
        <div className="qx-row qx-row--apart" style={{ flexWrap: 'wrap', rowGap: 12 }}>
          <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: '#38bdf8', display: 'inline-flex' }}><NetworkIcon size={20} /></span>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Qortex</h1>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'baseline', marginLeft: 4 }}>
              <span
                className={`qx-brain-total${totalPulsing ? ' qx-brain-total--pulse' : ''}`}
                data-testid="brain2-header-total"
              >
                {sourcesLoading ? '—' : headlineTotal}
              </span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>notes across your brain</span>
              {sinceLastVisit > 0 && (
                <span
                  className="qx-pill qx-pill--online qx-pill--sm"
                  title="Notes indexed since your last visit"
                  data-testid="brain2-since-last-visit"
                >
                  +{sinceLastVisit} since your last visit
                </span>
              )}
            </div>
          </div>
          <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap' }}>
            <span
              className="qx-pill qx-pill--ghost qx-pill--sm qx-row qx-row--tight"
              style={{ alignItems: 'center', gap: 6 }}
              title={feedLastSync ? `Last feed ingest: ${new Date(feedLastSync).toLocaleString()}` : 'No feed ingest recorded yet'}
              data-testid="brain2-feed-status-chip"
            >
              <span className={`qx-dot qx-dot--sm ${feedDotClass}`} />
              {feedLabel}
            </span>
            <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setShowRegister((s) => !s)}>
              <PlusIcon />
              Register Source
            </button>
            <button
              className="qx-btn qx-btn--ghost qx-btn--sm"
              disabled={selectedSources.length !== 1 || reindexing}
              title={selectedSources.length === 1 ? undefined : 'Select exactly one Source chip below to reindex it'}
              onClick={handleReindex}
            >
              <RefreshIcon />
              {reindexing ? 'Reindexing…' : 'Reindex'}
            </button>
          </div>
        </div>

        {/* Per-org subtotals (P2a) — only renders once the overview route has
            answered; RBAC-scoped server-side to orgs the caller belongs to. */}
        {orgOverviewEntries.length > 0 && (
          <div className="qx-row qx-row--wrap qx-row--tight" style={{ marginTop: 12, alignItems: 'center' }}>
            <span className="qx-section-title" style={{ margin: 0, minWidth: 60 }}>Orgs</span>
            {orgOverviewEntries.map((entry) => {
              const workspaceOrg = workspaceOrgs.find((o) => o.id === entry.org_id)
              const isCurrent = entry.org_id === currentOrg?.id
              const label = workspaceOrg?.name || entry.org_id
              const canSwitch = Boolean(workspaceOrg) && !isCurrent
              return (
                <button
                  key={entry.org_id}
                  className={`qx-chip${isCurrent ? ' qx-chip--active' : ''}`}
                  onClick={canSwitch ? () => selectOrg(workspaceOrg) : undefined}
                  disabled={!canSwitch}
                  title={canSwitch ? `Switch to ${label}` : (isCurrent ? `${label} (current)` : label)}
                  style={canSwitch ? undefined : { cursor: isCurrent ? 'default' : 'not-allowed' }}
                >
                  <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': isCurrent ? '#38bdf8' : 'rgba(255,255,255,0.4)' }} />
                  {label}
                  {entry.error ? (
                    <span style={{ opacity: 0.7, marginLeft: 4, color: '#f59e0b' }}>unavailable</span>
                  ) : (
                    <span style={{ opacity: 0.6, marginLeft: 4 }}>{entry.noteCount}</span>
                  )}
                </button>
              )
            })}
            {showPersonalChip && (
              <span
                className="qx-chip qx-chip--personal"
                title="Your notes. They follow you into every org."
                data-testid="brain2-personal-chip"
              >
                <PersonIcon size={12} />
                Personal
                <span style={{ opacity: 0.6, marginLeft: 4 }}>{overview.personal}</span>
              </span>
            )}
            {newestNoteAgo && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginLeft: 4 }}>
                newest note {newestNoteAgo}
              </span>
            )}
          </div>
        )}

        {reindexError && (
          <div className="qx-banner qx-banner--error" style={{ marginTop: 12 }}>{reindexError}</div>
        )}
      </section>
      )}

      {/* Register form */}
      {showRegister && (
        <section className="qx-card qx-card--compact">
          <form onSubmit={handleRegister} className="qx-stack qx-stack--tight">
            <div className="qx-row qx-row--wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
              <div className="qx-field">
                <label className="qx-field__label">Scope</label>
                <div className="qx-seg">
                  {['org', 'user', 'shared'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`qx-seg__btn${registerScope === s ? ' qx-seg__btn--active' : ''}`}
                      onClick={() => setRegisterScope(s)}
                    >
                      {SCOPE_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="qx-field" style={{ flex: '1 1 200px' }}>
                <label className="qx-field__label qx-field__label--required">Source name</label>
                <input
                  className="qx-input"
                  value={vaultName}
                  onChange={(e) => setVaultName(e.target.value)}
                  placeholder="NodeBrain"
                  required
                />
              </div>
              {registerScope === 'org' ? (
                <div className="qx-field" style={{ flex: '2 1 280px' }}>
                  <label className="qx-field__label qx-field__label--required">Source path</label>
                  <input
                    className="qx-input qx-input--mono"
                    value={sourcePath}
                    onChange={(e) => setSourcePath(e.target.value)}
                    placeholder="/vaults/nodebrain"
                    required
                  />
                  <span className="qx-field__hint">Must resolve under the server's configured vault root.</span>
                </div>
              ) : (
                <div className="qx-field" style={{ flex: '2 1 280px' }}>
                  <span className="qx-field__hint">
                    {SCOPE_LABELS[registerScope]}-scope sources are push-based readers — content arrives via API, not a filesystem path.
                    {registerScope === 'shared' && ' Requires admin.'}
                  </span>
                </div>
              )}
              <button className="qx-btn qx-btn--primary" type="submit" disabled={creating || !vaultName.trim() || (registerScope === 'org' && !sourcePath.trim())}>
                {creating ? 'Registering…' : 'Register'}
              </button>
              <button className="qx-btn qx-btn--ghost" type="button" onClick={() => setShowRegister(false)}>
                <CloseIcon />
                Cancel
              </button>
            </div>
          </form>
          {createError && <div className="qx-banner qx-banner--error" style={{ marginTop: 12 }}>{createError}</div>}
        </section>
      )}

      {/* Sources load error */}
      {sourcesError && (
        <section className="qx-card qx-card--compact">
          <div className="qx-banner qx-banner--error">Failed to load brain sources: {sourcesError}</div>
        </section>
      )}

      {/* Initial facet-metadata load */}
      {sourcesLoading && (
        <section className="qx-card" style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, flexDirection: 'column' }}>
            <span className="qx-spinner qx-spinner--lg" />
            <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Loading your brain…</p>
          </div>
        </section>
      )}

      {showOnboarding && (
        <Brain2Onboarding
          noteCount={onboardingNoteCount}
          orgId={currentOrg?.id}
          userId={user?.id}
          onCitationSelect={revealCitedNote}
          onChanged={() => { loadSources(); loadBrainStatus() }}
          onDismiss={dismissOnboarding}
        />
      )}

      {/* Empty state: no sources yet */}
      {!sourcesLoading && !sourcesError && !hasSources && (
        <section className="qx-card" style={{ flex: 1 }}>
          <div className="qx-empty">
            <span className="qx-empty__icon"><NetworkIcon size={28} /></span>
            <p className="qx-empty__title">Your brain is empty</p>
            <p className="qx-empty__body">
              Sources populate automatically as content is indexed (org vaults, your personal notes, shared knowledge).
              Register one below to get started.
            </p>
            <button className="qx-btn qx-btn--primary" onClick={() => setShowRegister(true)} style={{ marginTop: 12 }}>
              <PlusIcon />
              Register your first source
            </button>
          </div>
        </section>
      )}

      {/* Main content: facets + graph + note reader */}
      {!sourcesLoading && !sourcesError && hasSources && (
        <div className="bw-workspace" ref={workspaceRef} data-testid="brain2-workspace"
          data-library={layout.libraryHidden ? 'hidden' : layout.libraryCollapsed ? 'collapsed' : 'open'}
          data-dock={layout.dockHidden ? 'hidden' : layout.dockCollapsed ? 'collapsed' : 'open'}
          data-focus={layout.focus ? 'true' : 'false'}
          data-wide={layout.wide ? 'true' : 'false'}
          data-stacked={layout.stacked ? 'true' : 'false'}
          data-drawer={layout.drawer ? 'true' : 'false'}>
          {/* Mobile rail drawer scrim (tap to close) */}
          <div
            className={`bw-rail-scrim${railDrawerOpen ? ' bw-rail-scrim--visible' : ''}`}
            onClick={() => setRailDrawerOpen(false)}
            aria-hidden={!railDrawerOpen}
          />
          {/* Library rail (BRAIN2-V2 P2b) — Scope/Source/Language filters moved
              off the crammed header into independently collapsible sections.
              Filters COMBINE, so these are accordion sections (not tabs) with
              all active constraints visible. Hidden, it becomes a labelled rail
              (Brain2PaneRail); collapse persists in the brain_workspace namespace. */}
          {layout.libraryHidden ? null : layout.libraryCollapsed ? (
            <Brain2PaneRail
              side="left"
              className="bw-pane-rail--library"
              icon={<LibraryIcon size={16} />}
              label="Library"
              count={activeFilterCount || null}
              countLabel={`${activeFilterCount} active filters`}
              expandLabel="Show library"
              onExpand={toggleLibrary}
              testId="brain2-rail-library"
            />
          ) : (
          <aside
            className={`qx-card bw-rail${railDrawerOpen ? ' bw-rail--drawer-open' : ''}`}
            aria-label="Library filters"
          >
            <div className="bw-rail__identity">
              <div className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#38bdf8', display: 'inline-flex' }}><NetworkIcon size={18} /></span>
                <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em', flex: 1 }}>Qortex</h1>
                {layout.drawer ? (
                  <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm bw-pane-hide" onClick={() => setRailDrawerOpen(false)}
                    aria-label="Close library" title="Close library">
                    <CloseIcon size={13} />
                  </button>
                ) : (
                  <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm bw-pane-hide" onClick={toggleLibrary}
                    aria-label="Hide library" title="Hide library (more room for the graph)" data-testid="brain2-hide-library">
                    <ChevronsLeftIcon size={13} />
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span className={`qx-brain-total${totalPulsing ? ' qx-brain-total--pulse' : ''}`} data-testid="brain2-header-total">
                  {sourcesLoading ? '—' : headlineTotal}
                </span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>notes across your brain</span>
                {sinceLastVisit > 0 && (
                  <span className="qx-pill qx-pill--online qx-pill--sm" title="Notes indexed since your last visit" data-testid="brain2-since-last-visit">
                    +{sinceLastVisit} new
                  </span>
                )}
              </div>
            </div>

            <div className="bw-rail__actions">
              <span
                className="qx-pill qx-pill--ghost qx-pill--sm qx-row qx-row--tight"
                style={{ alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
                title={feedLastSync ? `Last feed ingest: ${new Date(feedLastSync).toLocaleString()}` : 'No feed ingest recorded yet'}
                data-testid="brain2-feed-status-chip"
              >
                <span className={`qx-dot qx-dot--sm ${feedDotClass}`} />
                {feedLabel}
              </span>
              <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', gap: 6 }}>
                <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setShowRegister((s) => !s)}>
                  <PlusIcon />
                  Register
                </button>
                <button
                  className="qx-btn qx-btn--ghost qx-btn--sm"
                  disabled={selectedSources.length !== 1 || reindexing}
                  title={selectedSources.length === 1 ? undefined : 'Select exactly one Source below to reindex it'}
                  onClick={handleReindex}
                >
                  <RefreshIcon />
                  {reindexing ? 'Reindexing…' : 'Reindex'}
                </button>
              </div>
              {reindexError && (
                <div className="qx-banner qx-banner--error" style={{ fontSize: 11, padding: '6px 8px' }}>{reindexError}</div>
              )}
              <BrainCapture onSaved={() => { loadSources(); loadBrainStatus() }} />
            </div>

           <details className="bw-rail__section">
              <summary className="bw-rail__section-head">
                <span className="bw-rail__section-title">Decisions</span>
                <span className="bw-rail__section-chevron"><ChevronDownIcon size={14} /></span>
              </summary>
              <div className="bw-rail__section-body">
                <DecisionTimeline />
              </div>
            </details>

           <div className="bw-rail__scroll">
            <details className="bw-rail__section" open>
              <summary className="bw-rail__section-head">
                <span className="bw-rail__section-title">Scope</span>
                <span className="bw-rail__section-count">{(sourcesMeta.scopes || []).length}</span>
                <span className="bw-rail__section-chevron"><ChevronDownIcon size={14} /></span>
              </summary>
              <div className="bw-rail__section-body">
                <div className="bw-rail__chips">
                  {(sourcesMeta.scopes || []).map((s) => (
                    <button
                      key={s.scope}
                      className={`qx-chip${selectedScopes.includes(s.scope) ? ' qx-chip--active' : ''}`}
                      onClick={() => toggleScope(s.scope)}
                    >
                      <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': SCOPE_COLORS[s.scope] || 'rgba(255,255,255,0.5)' }} />
                      {SCOPE_LABELS[s.scope] || s.scope}
                      <span style={{ opacity: 0.6, marginLeft: 4 }}>{s.noteCount}</span>
                    </button>
                  ))}
                </div>
              </div>
            </details>

            <details className="bw-rail__section" open>
              <summary className="bw-rail__section-head">
                <span className="bw-rail__section-title">Source</span>
                <span className="bw-rail__section-count">{sourcesMeta.sources.length}</span>
                <span className="bw-rail__section-chevron"><ChevronDownIcon size={14} /></span>
              </summary>
              <div className="bw-rail__section-body">
                <div className="bw-rail__chips">
                  {sourcesMeta.sources.map((s) => (
                    <button
                      key={s.vaultId}
                      className={`qx-chip${selectedSources.includes(s.vaultId) ? ' qx-chip--active' : ''}`}
                      onClick={() => toggleSource(s.vaultId)}
                    >
                      <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': sourceColorMap.get(s.vaultId) }} />
                      {s.name}
                      <span style={{ opacity: 0.6, marginLeft: 4 }}>{s.noteCount}</span>
                    </button>
                  ))}
                </div>
              </div>
            </details>

            {showLanguageFacet && (
              <details className="bw-rail__section">
                <summary className="bw-rail__section-head">
                  <span className="bw-rail__section-title">Language</span>
                  <span className="bw-rail__section-count">{languagesFacets.length}</span>
                  <span className="bw-rail__section-chevron"><ChevronDownIcon size={14} /></span>
                </summary>
                <div className="bw-rail__section-body">
                  <div className="bw-rail__chips">
                    {languagesFacets.map((l) => (
                      <button
                        key={l.language}
                        className={`qx-chip${selectedLanguages.includes(l.language) ? ' qx-chip--active' : ''}`}
                        onClick={() => toggleLanguage(l.language)}
                      >
                        {l.language}
                        <span style={{ opacity: 0.6, marginLeft: 4 }}>{l.noteCount}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </details>
            )}

            {orgOverviewEntries.length > 0 && (
              <details className="bw-rail__section">
                <summary className="bw-rail__section-head">
                  <span className="bw-rail__section-title">Orgs</span>
                  <span className="bw-rail__section-count">{orgOverviewEntries.length}</span>
                  <span className="bw-rail__section-chevron"><ChevronDownIcon size={14} /></span>
                </summary>
                <div className="bw-rail__section-body">
                  <div className="bw-rail__chips">
                    {orgOverviewEntries.map((entry) => {
                      const workspaceOrg = workspaceOrgs.find((o) => o.id === entry.org_id)
                      const isCurrent = entry.org_id === currentOrg?.id
                      const label = workspaceOrg?.name || entry.org_id
                      const canSwitch = Boolean(workspaceOrg) && !isCurrent
                      return (
                        <button
                          key={entry.org_id}
                          className={`qx-chip${isCurrent ? ' qx-chip--active' : ''}`}
                          onClick={canSwitch ? () => selectOrg(workspaceOrg) : undefined}
                          disabled={!canSwitch}
                          title={canSwitch ? `Switch to ${label}` : (isCurrent ? `${label} (current)` : label)}
                          style={canSwitch ? undefined : { cursor: isCurrent ? 'default' : 'not-allowed' }}
                        >
                          <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': isCurrent ? '#38bdf8' : 'rgba(255,255,255,0.4)' }} />
                          {label}
                          {entry.error ? (
                            <span style={{ opacity: 0.7, marginLeft: 4, color: '#f59e0b' }}>unavailable</span>
                          ) : (
                            <span style={{ opacity: 0.6, marginLeft: 4 }}>{entry.noteCount}</span>
                          )}
                        </button>
                      )
                    })}
                    {showPersonalChip && (
                      <span className="qx-chip qx-chip--personal" title="Your notes. They follow you into every org." data-testid="brain2-personal-chip">
                        <PersonIcon size={12} />
                        Personal
                        <span style={{ opacity: 0.6, marginLeft: 4 }}>{overview.personal}</span>
                      </span>
                    )}
                  </div>
                  {newestNoteAgo && (
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>newest note {newestNoteAgo}</span>
                  )}
                </div>
              </details>
            )}

           </div>
          </aside>
          )}

          {/* Graph + note reader — guaranteed usable height (the graph is the star;
              the view scrolls if the facet bar + graph exceed the viewport). */}
          <div className="bw-main">
            <section className="qx-card bw-stage" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="qx-row qx-row--apart" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                <span className="qx-section-title qx-row qx-row--tight" style={{ margin: 0, alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="qx-btn qx-btn--ghost qx-btn--sm bw-rail-trigger"
                    onClick={() => setRailDrawerOpen(true)}
                    aria-label="Open library filters"
                  >
                    <LibraryIcon size={14} />
                    Filters
                  </button>
                  Knowledge Graph
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.55)', marginLeft: 4 }}>
                    · {shownCount} of {totalNotes}{graph?.truncated ? ' (narrow with filters)' : ''}
                  </span>
                </span>
                <div className="qx-row qx-row--wrap qx-row--tight" style={{ alignItems: 'center', rowGap: 8 }}>
                  {layout.focus ? (
                    <button type="button" className="qx-btn qx-btn--primary qx-btn--sm bw-exit-focus" onClick={toggleFocus}
                      aria-label="Exit focus" title="Exit focus (Esc)" data-testid="brain2-exit-focus">
                      <CollapseIcon size={13} /> Exit focus <kbd className="qx-kbd">Esc</kbd>
                    </button>
                  ) : (
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm bw-focus-btn" onClick={toggleFocus}
                      aria-pressed={false} title="Focus: hide the library and the evidence panel" data-testid="brain2-focus">
                      <FocusIcon size={13} /> <span className="bw-btn-label">Focus</span>
                    </button>
                  )}
                  {/* Lens picker (BRAIN2-V2): a compact native select rather than
                      a 5-way segmented control — one dropdown never overflows the
                      390px card the way five inline buttons would, and it stays
                      keyboard-accessible for free. */}
                  <label className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
                    <span>Lens</span>
                    <select
                      className="qx-select qx-select--auto"
                      style={{ minWidth: 128, fontSize: 12, padding: '6px 32px 6px 12px' }}
                      value={colorBy}
                      onChange={(e) => setColorBy(e.target.value)}
                      aria-label="Colour lens"
                    >
                      {LENS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <div style={{ position: 'relative', width: 240 }}>
                    <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.6)', pointerEvents: 'none', display: 'inline-flex' }}>
                      <SearchIcon size={14} />
                    </span>
                    <input
                      type="text"
                      className="qx-input"
                      placeholder="Search your brain…"
                      value={searchQuery}
                      onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true) }}
                      onFocus={() => setSearchOpen(true)}
                      style={{ paddingLeft: 32, paddingRight: searchQuery ? 30 : 12, fontSize: 12 }}
                    />
                    {searchQuery && (
                      <button
                        className="qx-row-action"
                        style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
                        onClick={() => { setSearchQuery(''); setSearchOpen(false) }}
                        aria-label="Clear search"
                      >
                        <CloseIcon size={12} />
                      </button>
                    )}
                    {searchOpen && !searchQuery && suggestions.length > 0 && (
                      <div className="qx-menu" data-testid="brain2-suggestions" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 20, maxWidth: 'none' }}>
                        <div className="qx-menu__header">Ask your brain</div>
                        {suggestions.slice(0, 5).map((sg) => (
                          <button
                            key={sg.question}
                            className="qx-menu__item"
                            title={`${sg.reason} (${sg.source})`}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { setSearchQuery(sg.question); setSearchOpen(true) }}
                          >
                            <SearchIcon size={13} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sg.question}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {searchOpen && searchQuery && (
                      <div className="qx-menu" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 20, maxWidth: 'none' }}>
                        <div className="qx-menu__header">
                          {searchLoading ? 'Searching…' : searchError ? 'Search error' : searchInsufficient ? 'No relevant notes' : `${searchResults.length} results`}
                          {!searchLoading && !searchError && !searchInsufficient && searchReranked && (
                            <span data-testid="search-ai-reranked" title="These results were re-ordered by your chat model (Qortex setting: AI Reranking)" style={{ marginLeft: 8, fontSize: 11, opacity: 0.8 }}>AI-reranked</span>
                          )}
                        </div>
                        {searchError && (
                          <div style={{ padding: '4px 10px 8px', fontSize: 12, color: '#fca5a5' }}>{searchError}</div>
                        )}
                        {!searchLoading && !searchError && searchInsufficient && (
                          <div style={{ padding: '4px 10px 8px', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>No relevant notes. Nothing in your brain matched that closely enough to show.</div>
                        )}
                        {!searchLoading && !searchError && !searchInsufficient && searchResults.length === 0 && (
                          <div style={{ padding: '4px 10px 8px', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>No matching notes.</div>
                        )}
                        {searchResults.map((r) => (
                          <button key={r.chunkId} className="qx-menu__item" onClick={() => handleSearchResultClick(r)}>
                            <SearchIcon size={13} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title || r.relPath}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Colour legend for whichever lens is active — one active lens at
                  a time. scope/source are data-driven from sourcesMeta; the three
                  new lenses render their fixed bands from LENS_LEGENDS. Wraps at
                  narrow widths (qx-row--wrap). */}
              <div className="qx-row qx-row--wrap qx-row--tight" style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {colorBy === 'scope'
                  ? (sourcesMeta.scopes || []).map((s) => (
                      <span key={s.scope} className="qx-row qx-row--tight" style={{ gap: 4, alignItems: 'center' }}>
                        <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': SCOPE_COLORS[s.scope] }} />
                        {SCOPE_LABELS[s.scope] || s.scope}
                      </span>
                    ))
                  : colorBy === 'source'
                  ? (sourcesMeta.sources || []).map((s) => (
                      <span key={s.vaultId} className="qx-row qx-row--tight" style={{ gap: 4, alignItems: 'center' }}>
                        <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': sourceColorMap.get(s.vaultId) }} />
                        {s.name}
                      </span>
                    ))
                  : (LENS_LEGENDS[colorBy] || []).map((b) => (
                      <span key={b.label} className="qx-row qx-row--tight" style={{ gap: 4, alignItems: 'center' }}>
                        <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': b.color }} />
                        {b.label}
                      </span>
                    ))}
                {/* Ego-focus hint: only while a selection (not a transient hover)
                    is framing the graph. neighborIds includes the focused node
                    itself, so connected count is size - 1. */}
                {selectedNoteId && !hoverNodeId && neighborIds && (
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>
                    Focused on {neighborIds.size - 1} connected note{neighborIds.size - 1 === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {showEmptyOrgBanner && (
                <div className="qx-banner" data-testid="brain2-empty-org-banner">
                  <span className="qx-banner__icon"><PersonIcon size={16} /></span>
                  <span>
                    {orgDisplayName}&rsquo;s brain has no organisation notes yet. The notes you see are your personal layer, which follows you into every org.
                  </span>
                  <div className="qx-banner__actions">
                    <button
                      className="qx-row-action"
                      onClick={() => setEmptyOrgBannerDismissed(true)}
                      aria-label="Dismiss"
                      title="Dismiss"
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                </div>
              )}

              {!hasEdges && hasNodes && !graphLoading && (
                <div className="qx-banner">
                  {graph.nodes.length} note{graph.nodes.length === 1 ? '' : 's'} shown but no resolved links between them yet — the graph will show isolated nodes.
                </div>
              )}

              {graph?.truncated && (
                <div className="qx-banner">
                  {`${notesTruncated ? `Showing top ${shownCount} of ${graph.total} matching notes` : `Showing all ${shownCount} matching notes`}${edgesTruncated ? `, ${shownEdges} of ${edgesInPage} links shown` : ''}, narrow with the facets above to see more.`}
                </div>
              )}

              <div
                ref={(el) => { canvasWrapRef(el); canvasElRef.current = el }}
                className="qx-canvas"
                style={{ flex: 1, minHeight: 0, ...(isFullscreen ? { backgroundColor: 'var(--qx-bg-cinematic)' } : {}) }}
              >
                {hasNodes && (
                  <div className="qx-canvas__toolbar">
                    <div className="qx-seg">
                      <button
                        className={`qx-seg__btn${viewMode === 'brain' ? ' qx-seg__btn--active' : ''}`}
                        onClick={() => chooseViewMode('brain')}
                        title="Living brain — your notes as neurons"
                      >
                        Brain
                      </button>
                      <button
                        className={`qx-seg__btn${viewMode === '2d' ? ' qx-seg__btn--active' : ''}`}
                        onClick={() => chooseViewMode('2d')}
                        title="2D force graph"
                      >
                        2D
                      </button>
                      <button
                        className={`qx-seg__btn${viewMode === '3d' ? ' qx-seg__btn--active' : ''}`}
                        onClick={() => chooseViewMode('3d')}
                        title="3D force graph"
                      >
                        3D
                      </button>
                    </div>
                    {/* Fit only applies to the force-graph modes — the brain
                        organ frames itself. Spin is the brain organ's own
                        equivalent slot (BRAIN2-PRODUCT P1c). */}
                    {viewMode !== 'brain' && (
                      <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={handleFitToView} title="Fit graph to view">
                        <FitIcon />
                      </button>
                    )}
                    {viewMode === 'brain' && (
                      <button
                        className="qx-btn qx-btn--ghost qx-btn--sm"
                        onClick={toggleSpin}
                        aria-pressed={spinEnabled}
                        title={spinEnabled ? 'Pause brain rotation' : 'Resume brain rotation'}
                      >
                        {spinEnabled ? <SpinIcon /> : <SpinOffIcon />}
                      </button>
                    )}
                    <button
                      className="qx-btn qx-btn--ghost qx-btn--sm"
                      onClick={toggleFullscreen}
                      title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                    >
                      {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
                    </button>
                  </div>
                )}

                {graphLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, flexDirection: 'column' }}>
                    <span className="qx-spinner qx-spinner--lg" />
                    <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Loading graph...</p>
                  </div>
                ) : graphError ? (
                  <div className="qx-empty" style={{ height: '100%' }}>
                    <span className="qx-empty__icon"><NetworkIcon size={24} /></span>
                    <p className="qx-empty__title">Failed to load graph</p>
                    <p className="qx-empty__body">{graphError}</p>
                  </div>
                ) : !hasNodes ? (
                  <div className="qx-empty" style={{ height: '100%' }}>
                    <span className="qx-empty__icon"><NetworkIcon size={24} /></span>
                    <p className="qx-empty__title">No notes match the current filters</p>
                    <p className="qx-empty__body">Clear a facet above, or reindex the source if it was just registered.</p>
                  </div>
                ) : canvasWidth > 0 && canvasHeight > 0 ? (
                  <BrainRendererBoundary mode={viewMode} onUse2D={() => chooseViewMode('2d')}>
                    {viewMode === 'brain' ? (
                    <Suspense
                      fallback={
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                          <span className="qx-spinner qx-spinner--lg" />
                        </div>
                      }
                    >
                      {/* The organ now shows the loaded graph's REAL notes as
                          bright neurons (deterministic per-note-id placement)
                          with real links drawn as axons and click-to-select
                          into the NoteReader. The caption count stays
                          whole-brain from /brain/status (falls back to the
                          sources-meta total if status errored), so the number
                          can exceed the on-screen neuron count when the graph
                          is server-capped. */}
                      <BrainOrgan3D
                        noteCount={brainStatus?.noteCount ?? totalNotes}
                        status={brainStatus?.status || 'dormant'}
                        milestone={brainStatus?.milestone || null}
                        nodes={graphData.nodes}
                        links={graphData.links}
                        onSelectNote={(node) => selectNote(node.id)}
                        selectedNoteId={selectedNoteId}
                        getNodeColor={nodeColor}
                        spinEnabled={spinEnabled && !readMode}
                        highlightIds={activeHighlightIds}
                        activity={cortexActivity}
                        autonomic={autonomic}
                      />
                    </Suspense>
                  ) : viewMode === '3d' ? (
                    <Suspense
                      fallback={
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                          <span className="qx-spinner qx-spinner--lg" />
                        </div>
                      }
                    >
                      <ForceGraph3D
                        ref={fg3dRef}
                        graphData={graphData}
                        width={canvasWidth}
                        height={canvasHeight}
                        backgroundColor="rgba(0,0,0,0)"
                        nodeColor={(node) => nodeColor(node)}
                        nodeVal={(node) => nodeRadius(node.degree)}
                        nodeThreeObject={nodeThreeObject}
                        nodeLabel={(node) => node.title || node.id}
                        linkColor={linkColor}
                        linkWidth={linkWidth}
                        onNodeClick={(node) => selectNote(node.id)}
                        onEngineStop={() => fg3dRef.current?.zoomToFit(prefersReducedMotion ? 0 : 500, 70)}
                        enableNodeDrag={!prefersReducedMotion}
                        cooldownTicks={prefersReducedMotion ? 0 : 300}
                        warmupTicks={prefersReducedMotion ? 300 : 0}
                      />
                    </Suspense>
                  ) : (
                    <ForceGraph2D
                      ref={fgRef}
                      graphData={graphData}
                      width={canvasWidth}
                      height={canvasHeight}
                      backgroundColor="rgba(0,0,0,0)"
                      onRenderFramePre={paintBackdropRegions}
                      nodeCanvasObject={paintNode}
                      nodePointerAreaPaint={paintNodePointerArea}
                      linkColor={linkColor}
                      linkWidth={linkWidth}
                      linkCurvature={0.15}
                      onNodeClick={(node) => selectNote(node.id)}
                      onNodeHover={handleNodeHover}
                      onEngineStop={() => fgRef.current?.zoomToFit(prefersReducedMotion ? 0 : 500, 70)}
                      // Clustering needs settle time to organize regions even
                      // when there are few/no edges — that's the whole point
                      // for a low-edge corpus, so ticks are no longer edge-gated.
                      // Reduced-motion: skip the animated settle entirely by
                      // running all ticks in one synchronous warmup instead.
                      cooldownTicks={prefersReducedMotion ? 0 : 300}
                      warmupTicks={prefersReducedMotion ? 300 : 0}
                      // Living pulse: react-force-graph pauses repaints once the
                      // sim cools by default (autoPauseRedraw), which is why the
                      // graph used to go dead the moment it settled. Keep
                      // repainting every frame so paintNode's glow breathes —
                      // EXCEPT for reduced-motion users, who get the original
                      // static-once-settled behaviour back.
                      autoPauseRedraw={prefersReducedMotion}
                    />
                    )}
                  </BrainRendererBoundary>
                ) : null}

                {/* Fullscreen note popup (BRAIN2-PRODUCT P1d) — native
                    fullscreen only paints descendants of the fullscreened
                    element, so this MUST live inside .qx-canvas (the element
                    requestFullscreen() targets), not beside it like the
                    regular side-panel NoteReader below. Works identically
                    across all three modes since selectNote() (the click
                    handler every mode wires to) is what opens it. */}
                {(isFullscreen || layout.focus) && fullscreenNoteOpen && selectedNoteId && (
                  <div
                    className="qx-brain-note-overlay"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Note"
                    onClick={(e) => { if (e.target === e.currentTarget) setFullscreenNoteOpen(false) }}
                  >
                    <div className="qx-card qx-brain-note-overlay__panel">
                      <button
                        className="qx-row-action qx-brain-note-overlay__close"
                        onClick={() => setFullscreenNoteOpen(false)}
                        aria-label="Close note"
                        title="Close (Esc)"
                      >
                        <CloseIcon size={14} />
                      </button>
                      <NoteReader
                      citedSpan={citedSpan}
                        selectedNoteId={selectedNoteId}
                        note={note}
                        loading={noteLoading}
                        error={noteError}
                        onSelectNote={selectNote}
                        sourcesMeta={sourcesMeta}
                        onLoadMore={handleLoadMoreNote}
                        loadingMore={loadingMoreNote}
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Note reader — hidden while the graph owns fullscreen (the
                fullscreen note popup above takes over instead). */}
            {/* BRAIN2-CORTEX P1b — evidence dock: a tabbed right panel sharing
                the reader's slot. Note tab = the existing NoteReader; Cortex tab
                = the brain-scoped agent chat. A citation click in Cortex flips to
                the Note tab and reveals the cited note here while it stays lit in
                the brain. Hidden while the graph owns fullscreen (Phase 4). */}
            {!isFullscreen && !layout.dockHidden && layout.dockCollapsed && (
              <Brain2PaneRail
                side={layout.stacked ? 'bottom' : 'right'}
                className="bw-pane-rail--dock"
                icon={<DockIcon size={16} />}
                label={dockTab === 'cortex' ? 'Cortex' : (selectedNoteId ? 'Note' : 'Note · Cortex')}
                expandLabel="Show evidence panel"
                onExpand={toggleDock}
                testId="brain2-rail-dock"
              />
            )}
            {!isFullscreen && !layout.dockHidden && !layout.dockCollapsed && !layout.stacked && !layout.wide && (
              <div
                className="bw-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize evidence panel (arrow keys), double-click to reset"
                aria-valuenow={renderedDockWidth}
                aria-valuemin={320}
                aria-valuemax={dockMax}
                tabIndex={0}
                onPointerDown={startDockResize}
                onKeyDown={onDockResizeKey}
                onDoubleClick={() => setDockWidth(440)}
                title="Drag to resize · double-click to reset"
              />
            )}
            {!isFullscreen && !layout.dockHidden && !layout.dockCollapsed && (
              <section
                className="qx-card qx-dock bw-dock"
                style={{ '--bw-dock-w': `${renderedDockWidth}px`, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              >
                <div className="qx-dock__tabs" role="tablist" aria-label="Evidence dock">
                  <button
                    role="tab"
                    aria-selected={dockTab === 'note'}
                    className={`qx-dock__tab${dockTab === 'note' ? ' qx-dock__tab--active' : ''}`}
                    onClick={() => setDockTab('note')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>
                    Note
                  </button>
                  <button
                    role="tab"
                    aria-selected={dockTab === 'cortex'}
                    className={`qx-dock__tab${dockTab === 'cortex' ? ' qx-dock__tab--active' : ''}`}
                    onClick={() => setDockTab('cortex')}
                    title="Ask Cortex — your brain's agent"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a4 4 0 0 0-4 4c-1.7.7-3 2.5-3 4.5 0 1 .4 2 1 2.7-.3.6-.5 1.2-.5 1.8a3 3 0 0 0 4.5 2.6A3.5 3.5 0 0 0 12 21a3.5 3.5 0 0 0 2-6.5"/><path d="M12 3a4 4 0 0 1 4 4c1.7.7 3 2.5 3 4.5 0 1-.4 2-1 2.7"/><path d="M12 3v18"/></svg>
                    Cortex
                  </button>
                  <button type="button" className={`qx-btn qx-btn--sm bw-pane-hide bw-dock__wide ${layout.wide ? 'qx-btn--primary' : 'qx-btn--ghost'}`} onClick={toggleWide}
                    aria-pressed={layout.wide} aria-label={layout.wide ? 'Restore panel size' : 'Expand panel'}
                    title={layout.wide ? 'Restore panel size (Esc)' : 'Expand: give the note or chat most of the screen'} data-testid="brain2-wide-dock">
                    {layout.wide ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
                    <span className="bw-btn-label">{layout.wide ? 'Restore' : 'Expand'}</span>
                  </button>
                  <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm bw-pane-hide bw-dock__hide" onClick={toggleDock}
                    aria-label="Hide evidence panel" title="Hide evidence panel (more room for the graph)" data-testid="brain2-hide-dock">
                    {layout.stacked ? <ChevronDownIcon size={13} /> : <ChevronsRightIcon size={13} />}
                  </button>
                </div>
                {dockTab === 'cortex' ? (
                  <div className="qx-dock__body qx-dock__body--flush" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                    <CortexDock
                      orgId={currentOrg?.id}
                      userId={user?.id}
                      authFetch={authFetch}
                      onCitationSelect={revealCitedNote}
                      onCitedNotesChange={setCortexHighlightIds}
                      onClose={() => setDockTab('note')}
                      onActivityChange={handleCortexActivity}
                      seedDraft={cortexSeed}
                      suggestions={suggestions}
                    />
                  </div>
                ) : (
                  <div className="qx-dock__body" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    <NoteReader
                      citedSpan={citedSpan}
                      selectedNoteId={selectedNoteId}
                      note={note}
                      loading={noteLoading}
                      error={noteError}
                      onSelectNote={selectNote}
                      sourcesMeta={sourcesMeta}
                      onLoadMore={handleLoadMoreNote}
                      loadingMore={loadingMoreNote}
                      onAskAboutNote={handleAskAboutNote}
                      onEnterReadMode={() => setReadMode(true)}
                    />
                  </div>
                )}
              </section>
            )}

            {readMode && selectedNoteId && (
              <div className="qx-card bw-readmode" role="dialog" aria-modal="false" aria-label="Read note">
                <div className="bw-readmode__bar">
                  <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setReadMode(false)}>
                    <CollapseIcon size={13} />
                    Back to graph
                  </button>
                  <span className="bw-readmode__title">{note?.title || 'Note'}</span>
                  <button
                    className="qx-row-action"
                    onClick={() => { setReadMode(false); selectNote(null) }}
                    aria-label="Close note"
                    title="Close (Esc)"
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
                <div className="bw-readmode__scroll">
                  <div className="bw-readmode__col">
                    <NoteReader
                      citedSpan={citedSpan}
                      selectedNoteId={selectedNoteId}
                      note={note}
                      loading={noteLoading}
                      error={noteError}
                      onSelectNote={selectNote}
                      sourcesMeta={sourcesMeta}
                      onLoadMore={handleLoadMoreNote}
                      loadingMore={loadingMoreNote}
                      onAskAboutNote={handleAskAboutNote}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .qx-brain-note-overlay {
          position: absolute;
          inset: 0;
          z-index: 30;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(4,8,16,0.6);
        }
        .qx-brain-note-overlay__panel {
          position: relative;
          width: 100%;
          max-width: 640px;
          max-height: 70vh;
          overflow-y: auto;
          padding: 24px 24px 20px;
        }
        .qx-brain-note-overlay__close {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 1;
        }
      `}</style>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Note reader panel
// ─────────────────────────────────────────────────────────────────────────

// Format an ISO timestamp for the reader header (e.g. "12 Sep 2026"). Returns
// null for missing/unparseable values so the caller can omit the line entirely
// rather than print "Invalid Date" — honest absence over a fabricated date.
function formatNoteDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function NoteReader({ citedSpan, selectedNoteId, note, loading, error, onSelectNote, sourcesMeta, onLoadMore, loadingMore, onAskAboutNote, onEnterReadMode }) {
  if (!selectedNoteId) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon"><LinkIcon size={22} /></span>
        <p className="qx-empty__title">No note selected</p>
        <p className="qx-empty__body">Click a node in the graph, or use search, to read a note here.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="qx-stack qx-stack--tight">
        <span className="qx-skeleton qx-skeleton--line-lg" />
        <span className="qx-skeleton qx-skeleton--block" />
        <span className="qx-skeleton qx-skeleton--block" />
      </div>
    )
  }

  if (error) {
    return <div className="qx-banner qx-banner--error">Couldn’t load this note: {error}</div>
  }

  if (!note) return null

  const sourceName = sourcesMeta?.sources?.find((s) => s.vaultId === note.vault_id)?.name
  const occurred = formatNoteDate(note.occurredAt)
  const updated = formatNoteDate(note.updatedAt)
  // quox#681: the Properties panel shows the frontmatter; never render it twice.
  const bodyText = stripFrontmatter(note.body)
  const hasBody = Boolean(bodyText.trim())
  const bodyLen = typeof note.body_length === 'number' ? note.body_length : null
  const loadedChars = note.body?.length ?? 0
  const backCount = note.backlinks?.length || 0
  const outCount = note.outlinks?.length || 0
  const frontmatter = note.frontmatter && typeof note.frontmatter === 'object' ? note.frontmatter : null
  const frontmatterKeys = frontmatter ? Object.keys(frontmatter) : []

  return (
    <div className="qx-stack qx-note-reader">
      <style>{`
        .qx-note-reader .qx-note-md { font-size: 16px; line-height: 1.65; color: rgba(255,255,255,0.92); }
        .qx-note-reader .qx-note-md > *:first-child { margin-top: 0; }
        .qx-note-reader .qx-note-md pre,
        .qx-note-reader .qx-note-md table { max-width: 100%; overflow-x: auto; display: block; }
        .qx-note-reader .qx-note-md img { max-width: 100%; height: auto; }
        .qx-note-reader .qx-note-md code { word-break: break-word; }
        .qx-note-reader .qx-note-dates { margin-top: 6px; font-size: 11px; color: rgba(255,255,255,0.6); }
        .qx-note-reader .qx-note-metaonly {
          border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
          background: rgba(255,255,255,0.03); padding: 14px 16px;
        }
        .qx-note-reader .qx-note-summary { font-size: 12px; color: rgba(255,255,255,0.65); }
        .qx-note-reader .qx-note-props summary { cursor: pointer; }
        .qx-note-reader .qx-note-props dl { margin: 8px 0 0; display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 4px 12px; }
        .qx-note-reader .qx-note-props dt { font-size: 11px; color: rgba(255,255,255,0.55); font-family: var(--qx-font-mono); }
        .qx-note-reader .qx-note-props dd { margin: 0; font-size: 12px; color: rgba(255,255,255,0.85); word-break: break-word; }
      `}</style>

      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff', lineHeight: 1.3, overflowWrap: 'anywhere' }}>{note.title}</h2>
        <div className="qx-row qx-row--tight" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {sourceName && (
            <span className="qx-chip qx-chip--xs">
              <span className="qx-dot qx-dot--sm" style={{ '--qx-dot-color': SCOPE_COLORS[note.scope] || 'rgba(255,255,255,0.5)' }} />
              {sourceName}
            </span>
          )}
          {note.scope && (
            <span className={`qx-pill qx-pill--xs ${SCOPE_PILL_CLASS[note.scope] || 'qx-pill--ghost'}`}>
              {SCOPE_LABELS[note.scope] || note.scope}
            </span>
          )}
        </div>
        {(occurred || updated) && (
          <div className="qx-note-dates">
            {occurred && <span>Occurred {occurred}</span>}
            {occurred && updated && <span> · </span>}
            {updated && <span>Updated {updated}</span>}
          </div>
        )}
        {note.rel_path && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--qx-font-mono)', overflowWrap: 'anywhere' }}>{note.rel_path}</div>
        )}
      </div>

      {note.tags?.length > 0 && (
        <div className="qx-row qx-row--wrap qx-row--tight">
          {note.tags.map((tag) => (
            <span key={tag} className="qx-chip qx-chip--xs">
              <TagIcon />
              {tag}
            </span>
          ))}
        </div>
      )}

      {(onAskAboutNote || onEnterReadMode) && (
        <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', gap: 8 }}>
          {onEnterReadMode && (
            <button
              className="qx-btn qx-btn--ghost qx-btn--sm"
              onClick={onEnterReadMode}
              title="Read mode — expand this note across the workspace"
            >
              <ExpandIcon size={13} />
              Read
            </button>
          )}
          {onAskAboutNote && (
            <button
              className="qx-btn qx-btn--ghost qx-btn--sm"
              onClick={() => onAskAboutNote(note)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a4 4 0 0 0-4 4c-1.7.7-3 2.5-3 4.5 0 1 .4 2 1 2.7-.3.6-.5 1.2-.5 1.8a3 3 0 0 0 4.5 2.6A3.5 3.5 0 0 0 12 21a3.5 3.5 0 0 0 2-6.5"/><path d="M12 3a4 4 0 0 1 4 4c1.7.7 3 2.5 3 4.5 0 1-.4 2-1 2.7"/></svg>
              Ask about this note
            </button>
          )}
        </div>
      )}

      {(() => {
        const passage = citedSpan && citedSpan.noteId === note.id ? citedPassage(note.body, citedSpan) : null
        return passage ? (
          <blockquote className="qx-note-cited-span" aria-label="Cited passage" style={{ margin: '0 0 12px', padding: '8px 12px', borderLeft: '3px solid rgba(120,200,255,0.8)', background: 'rgba(120,200,255,0.1)', whiteSpace: 'pre-wrap', fontSize: 14 }}>
            <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4 }}>Cited passage (characters {citedSpan.charStart.toLocaleString()} to {citedSpan.charEnd.toLocaleString()})</div>
            <mark style={{ background: 'transparent', color: 'inherit' }}>{passage}</mark>
          </blockquote>
        ) : null
      })()}

      {hasBody ? (
        <div className="qx-note-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, node: _node, ...rest }) => {
                const wl = parseWikilinkHref(href)
                if (wl?.kind === 'note') {
                  return (
                    <a
                      href={href}
                      className="qx-note-wikilink"
                      onClick={(e) => { e.preventDefault(); onSelectNote(wl.id) }}
                    >{children}</a>
                  )
                }
                if (wl?.kind === 'missing') {
                  return (
                    <span
                      className="qx-note-wikilink qx-note-wikilink--missing"
                      title={`No note named ${wl.target}`}
                      style={{ opacity: 0.5, cursor: 'not-allowed', textDecoration: 'underline dotted' }}
                    >{children}</span>
                  )
                }
                return <a href={href} {...rest}>{children}</a>
              }
            }}
          >{preprocessWikilinks(bodyText, note.outlinks)}</ReactMarkdown>
        </div>
      ) : (
        <div className="qx-note-metaonly">
          <p style={{ margin: 0, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>This source contains metadata only.</p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>Its properties and connections are available below.</p>
          {(backCount > 0 || outCount > 0 || note.tags?.length > 0) && (
            <p className="qx-note-summary" style={{ margin: '10px 0 0' }}>
              {backCount} backlink{backCount === 1 ? '' : 's'} · {outCount} outlink{outCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      {note.truncated && onLoadMore && (
        <div className="qx-stack qx-stack--tight" style={{ alignItems: 'flex-start' }}>
          {bodyLen != null && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
              Loaded {loadedChars.toLocaleString()} of {bodyLen.toLocaleString()} characters
            </span>
          )}
          <button
            className="qx-btn qx-btn--ghost qx-btn--sm"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            <PlusIcon />
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      <div className="qx-divider" />

      <div>
        <div className="qx-section-title">Backlinks ({note.backlinks?.length || 0})</div>
        {note.backlinks?.length > 0 ? (
          <div className="qx-stack qx-stack--tight">
            {note.backlinks.map((bl) => (
              <button
                key={bl.id}
                className="qx-host-row"
                style={{ width: '100%', textAlign: 'left', background: 'rgba(255,255,255,0.03)', border: 'none' }}
                onClick={() => onSelectNote(bl.id)}
              >
                <span className="qx-dot qx-dot--online qx-dot--sm qx-host-row__dot" />
                <span className="qx-host-row__body">
                  <span className="qx-host-row__primary">{bl.title}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>No backlinks yet.</p>
        )}
      </div>

      <div>
        <div className="qx-section-title">Outlinks ({note.outlinks?.length || 0})</div>
        {note.outlinks?.length > 0 ? (
          <div className="qx-stack qx-stack--tight">
            {note.outlinks.map((ol, idx) => (
              <button
                key={`${ol.id || ol.targetRaw}-${idx}`}
                className="qx-host-row"
                style={{
                  width: '100%', textAlign: 'left', background: 'rgba(255,255,255,0.03)', border: 'none',
                  cursor: ol.resolved ? 'pointer' : 'default', opacity: ol.resolved ? 1 : 0.6
                }}
                onClick={() => ol.resolved && ol.id && onSelectNote(ol.id)}
                disabled={!ol.resolved}
              >
                <span className={`qx-dot ${ol.resolved ? 'qx-dot--online' : 'qx-dot--offline'} qx-dot--sm qx-host-row__dot`} />
                <span className="qx-host-row__body">
                  <span className="qx-host-row__primary">{ol.title || ol.targetRaw}</span>
                  {!ol.resolved && <span className="qx-host-row__secondary">dangling link</span>}
                </span>
                <span className="qx-pill qx-pill--ghost qx-pill--xs qx-host-row__meta">{ol.type}</span>
              </button>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>No outlinks.</p>
        )}
      </div>

      {frontmatterKeys.length > 0 && (
        <details className="qx-note-props">
          <summary className="qx-section-title" style={{ marginBottom: 0 }}>Properties ({frontmatterKeys.length})</summary>
          <dl>
            {frontmatterKeys.map((key) => {
              const val = frontmatter[key]
              const text = val == null ? '—' : typeof val === 'object' ? JSON.stringify(val) : String(val)
              return (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>{text}</dd>
                </Fragment>
              )
            })}
          </dl>
        </details>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// License gate — Qortex is a licensed, opt-in plugin (id: 'quox-brain2',
// BRAIN2-PRODUCT Phase A). Same gating mechanism as every other paid plugin
// view (isPluginLicensed() reads the server-fetched entitlement cache, see
// GrafanaView/DockerView) — unlicensed orgs get the standard locked/upsell
// state below; licensed+enabled orgs get the full graph explorer. The
// internal `quoxbrain` route id, service, and QuoxbrainViewContent component
// are unchanged — only the user-facing brand + license gate are new.
// ─────────────────────────────────────────────────────────────────────────

function QuoxbrainView() {
  const diag = usePluginLicenseDiagnosis('quox-brain2')

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Qortex" accentColor="#8fd6ff" icon={<NetworkIcon size={38} />} />
  }

  return <QuoxbrainViewContent />
}

export default QuoxbrainView
