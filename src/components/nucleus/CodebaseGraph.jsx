/**
 * CodebaseGraph — 3D codebase visualization using 3d-force-graph
 *
 * Stream QN Phase QN-5.
 * Uses the same library as the working prototype (3d-force-graph).
 * QN Phase 3: embedded as a tab inside RepoBrainView (/nucleus?tab=graph),
 * fills its parent instead of the viewport.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useRepoBrainStatus } from './RepoBrainContext'

const GRAPH_DATA_URL = '/graph-data.json'

// CDN for 3d-force-graph (same version as prototype)
const FORCE_GRAPH_CDN = 'https://unpkg.com/3d-force-graph@1.73.3/dist/3d-force-graph.min.js'

const REPO_COLORS = {
  'quox-website': '#ff6b6b', 'quox-dashboard': '#a855f7', 'quoxflow': '#06b6d4',
  'QuoxBastion': '#f59e0b', 'quoxagent': '#10b981', 'quoxmcp': '#ec4899',
  'quoxterminal': '#3b82f6', 'quox-memory': '#8b5cf6', 'quox-plugin-sdk': '#14b8a6',
  'aee': '#f97316', 'aocl': '#ef4444', 'volt': '#eab308', 'ward': '#22d3ee',
}

const LANG_COLORS = {
  react: '#61dafb', javascript: '#f7df1e', typescript: '#3178c6', 'react-ts': '#007acc',
  go: '#00add8', rust: '#dea584', json: '#6b7280', css: '#264de4',
  html: '#e34c26', markdown: '#083fa1', yaml: '#cb171e', shell: '#89e051',
}

function getNodeColor(node, colorMode) {
  switch (colorMode) {
    case 'language': return LANG_COLORS[node.lang] || '#6b7280'
    case 'size': {
      const t = Math.min((node.size || 0) / 50000, 1)
      const h = Math.round(240 - t * 240)
      return `hsl(${h}, 80%, ${50 + t * 20}%)`
    }
    case 'connections': {
      if (!node.degree) return '#1a1a24'
      const t = Math.min(node.degree / 50, 1)
      const h = Math.round(270 - t * 200)
      return `hsl(${h}, 80%, ${40 + t * 30}%)`
    }
    default: return REPO_COLORS[node.repo] || '#6366f1'
  }
}

function getNodeSize(node) {
  if (node.type === 'folder') return 0.4
  if (!node.degree) return 0.2
  if (node.degree <= 2) return 0.8
  if (node.degree <= 10) return 1.5 + node.degree * 0.5
  if (node.degree <= 30) return 7 + (node.degree - 10) * 0.8
  return 23 + (node.degree - 30) * 0.6
}

// Given a clicked node id and the graph's current link list (post-simulation
// links have source/target resolved to node object refs, pre-simulation
// they're still plain string ids), returns the 1-hop neighbor node ids +
// the set of link objects directly touching that node.
function computeNeighbors(nodeId, links) {
  const neighborIds = new Set([nodeId])
  const neighborLinks = new Set()
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source
    const t = typeof l.target === 'object' ? l.target.id : l.target
    if (s === nodeId || t === nodeId) {
      neighborIds.add(s)
      neighborIds.add(t)
      neighborLinks.add(l)
    }
  })
  return { neighborIds, neighborLinks }
}

// Load script dynamically
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.ForceGraph3D) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
}

export default function CodebaseGraph() {
  const containerRef = useRef(null)
  const graphRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [colorMode, setColorMode] = useState('repo')
  const [searchFilter, setSearchFilter] = useState('')
  const [selectedNode, setSelectedNode] = useState(null)
  const [mutedRepos, setMutedRepos] = useState(() => new Set())
  const [copiedPath, setCopiedPath] = useState(false)
  const [stats, setStats] = useState({ nodes: 0, edges: 0 })
  const graphDataRef = useRef(null)
  const nodesByIdRef = useRef(new Map())
  const { health, reason } = useRepoBrainStatus()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  function toggleRepoMute(repo) {
    setMutedRepos(prev => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }

  function handleSearchThisFile(fileId) {
    navigate(`/nucleus?tab=search&file=${encodeURIComponent(fileId)}`)
  }

  function handleCopyPath(fileId) {
    navigator.clipboard?.writeText(fileId).then(() => {
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1500)
    })
  }

  // Initialize graph
  useEffect(() => {
    // Wait for the shared probe to resolve before doing anything, so this
    // effect runs exactly once (avoids re-initializing the force graph if
    // health flips from 'checking' to 'online' after mount).
    if (health === 'checking') return undefined

    // Session has no resolved organisation context (401). Not the same as the
    // engine being down, so the copy names the actual remedy instead.
    if (health === 'unauthorized') {
      setError(
        `${reason || 'Organisation context required for RepoBrain.'} The engine itself may be reachable. Try reloading the page or signing out and back in.`
      )
      setLoading(false)
      return undefined
    }

    // RepoBrain isn't licensed for this org (403): a licensing gate, not a
    // downed engine.
    if (health === 'unlicensed') {
      setError(
        `${reason || 'RepoBrain is not licensed for this organisation.'} Ask your workspace admin to enable the RepoBrain plugin for this organisation.`
      )
      setLoading(false)
      return undefined
    }

    // The shared probe already knows the engine is down; skip the graph-data
    // fetch entirely and show the same friendly not-connected message.
    if (health === 'offline') {
      setError(
        "The codebase graph isn't connected yet. It maps how your files and imports link together, and needs a RepoBrain engine connected to this workspace. If you manage this workspace, connect one and index a repository; otherwise your admin can turn it on."
      )
      setLoading(false)
      return undefined
    }

    let destroyed = false
    async function init() {
      try {
        // Load library and data in parallel
        const [, res] = await Promise.all([
          loadScript(FORCE_GRAPH_CDN),
          fetch(GRAPH_DATA_URL),
        ])
        if (destroyed) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (destroyed) return

        // Filter to files only (no folders by default)
        const nodes = data.nodes.filter(n => n.type === 'file')
        const nodeIds = new Set(nodes.map(n => n.id))
        const edges = data.edges.filter(e =>
          e.type === 'import' && nodeIds.has(e.source) && nodeIds.has(e.target)
        )

        graphDataRef.current = { nodes, edges: data.edges }
        nodesByIdRef.current = new Map(nodes.map(n => [n.id, n]))
        setStats({ nodes: nodes.length, edges: edges.length })

        // Build graph — same config as the working prototype
        const graph = window.ForceGraph3D({ controlType: 'orbit' })(containerRef.current)
          .graphData({ nodes, links: edges })
          .backgroundColor('#000005')
          .nodeLabel(n => `<div style="background:rgba(0,0,0,0.85);color:${getNodeColor(n,'repo')};padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px;border:1px solid ${getNodeColor(n,'repo')}33">${n.id}<br><span style="color:#888">${n.lang} · ${n.degree || 0} connections</span></div>`)
          .nodeColor(n => getNodeColor(n, 'repo'))
          .nodeVal(n => getNodeSize(n))
          .nodeOpacity(0.9)
          .nodeResolution(6)
          .linkColor(() => 'rgba(140,120,200,0.05)')
          .linkWidth(0.15)
          .linkOpacity(0.5)
          .d3AlphaDecay(0.05)
          .d3VelocityDecay(0.4)
          .warmupTicks(150)
          .cooldownTicks(0)
          .cooldownTime(5000)
          .enableNodeDrag(false)
          .onNodeClick(node => setSelectedNode(node))
          .onBackgroundClick(() => setSelectedNode(null))

        // Force tuning — same as prototype
        graph.d3Force('charge').strength(-15).distanceMax(500)
        graph.d3Force('link').distance(l => l.type === 'contains' ? 20 : 60).strength(l => l.type === 'contains' ? 0.3 : 0.05)
        graph.d3Force('center', null)

        // Cluster by repo
        const repos = Object.keys(REPO_COLORS)
        const repoPos = {}
        const angle = (2 * Math.PI) / repos.length
        repos.forEach((r, i) => {
          repoPos[r] = { x: Math.cos(angle * i) * 500, y: (Math.random() - 0.5) * 80, z: Math.sin(angle * i) * 500 }
        })
        graph.d3Force('cluster', alpha => {
          for (const node of graph.graphData().nodes) {
            const t = repoPos[node.repo]
            if (!t) continue
            const k = alpha * 0.03
            node.vx = (node.vx || 0) + (t.x - (node.x || 0)) * k
            node.vy = (node.vy || 0) + (t.y - (node.y || 0)) * k
            node.vz = (node.vz || 0) + (t.z - (node.z || 0)) * k
          }
        })

        graphRef.current = graph

        // Deep link: ?file=<id> selects that node + centers the camera on it.
        // Pairs with search-result cards (Wave 2) that link to ?tab=graph&file=...
        const fileParam = searchParams.get('file')
        if (fileParam) {
          const match = nodesByIdRef.current.get(fileParam)
            || nodes.find(n => n.id.endsWith(fileParam))
          if (match) {
            setSelectedNode(match)
            const x = match.x || 0, y = match.y || 0, z = match.z || 0
            const distRatio = 1 + 120 / Math.hypot(x, y, z, 1)
            graph.cameraPosition(
              { x: x * distRatio, y: y * distRatio, z: z * distRatio },
              match,
              1500
            )
          }
        }

        setLoading(false)
      } catch (err) {
        if (!destroyed) {
          // A 5xx/unreachable here means no RepoBrain engine is connected for this
          // workspace, not a real error. Say so in plain, user-facing language.
          const backendDown = /HTTP 5\d\d|Failed to fetch|NetworkError/i.test(err.message || '')
          setError(backendDown
            ? "The codebase graph isn't connected yet. It maps how your files and imports link together, and needs a RepoBrain engine connected to this workspace. If you manage this workspace, connect one and index a repository; otherwise your admin can turn it on."
            : err.message)
          setLoading(false)
        }
      }
    }
    init()
    return () => { destroyed = true; if (graphRef.current) graphRef.current._destructor?.() }
  }, [health, reason])

  // Repaint nodes/links whenever color mode, search filter, legend mute
  // toggles, or the node-focus selection changes. Also drives visibility
  // (legend mute hides a repo's nodes + its links entirely) and the 1-hop
  // neighbor highlight (focus mode: dim everything except the selected
  // node's direct neighbors).
  useEffect(() => {
    if (!graphRef.current) return
    const filter = searchFilter.toLowerCase()
    const links = graphRef.current.graphData().links || []
    const focusId = selectedNode?.id
    const { neighborIds, neighborLinks } = focusId
      ? computeNeighbors(focusId, links)
      : { neighborIds: null, neighborLinks: null }

    function linkRepos(l) {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      return [nodesByIdRef.current.get(s)?.repo, nodesByIdRef.current.get(t)?.repo]
    }

    graphRef.current
      .nodeColor(n => {
        if (filter && !n.id.toLowerCase().includes(filter)) return 'rgba(25,25,35,0.2)'
        if (neighborIds && !neighborIds.has(n.id)) return 'rgba(60,60,80,0.15)'
        return getNodeColor(n, colorMode)
      })
      .nodeVisibility(n => !mutedRepos.has(n.repo))
      .linkColor(l => {
        if (neighborLinks) return neighborLinks.has(l) ? 'rgba(56,189,248,0.55)' : 'rgba(140,120,200,0.02)'
        return 'rgba(140,120,200,0.05)'
      })
      .linkVisibility(l => {
        const [sRepo, tRepo] = linkRepos(l)
        return !mutedRepos.has(sRepo) && !mutedRepos.has(tRepo)
      })
  }, [colorMode, searchFilter, mutedRepos, selectedNode])

  return (
    <div className="qx-graph-canvas">
      {/* 3d-force-graph renders into this div — MUST always be in DOM for ref */}
      <div ref={containerRef} className="qx-graph-canvas__stage" />

      {/* Loading overlay */}
      {loading && (
        <div className="qx-graph-hud__overlay">
          Loading codebase graph...
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="qx-graph-hud__overlay qx-graph-hud__overlay--error">
          <div className="qx-graph-hud__overlay-title">Failed to load graph data</div>
          <div className="qx-hint">{error}</div>
        </div>
      )}

      {/* HUD Overlay */}
      <div className="qx-graph-hud">
        {/* Top bar */}
        <div className="qx-graph-hud__bar">
          <input
            type="text"
            className="qx-input"
            placeholder="Filter files..."
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
          />
          {['repo', 'language', 'size', 'connections'].map(mode => (
            <button
              key={mode}
              className={`qx-chip${colorMode === mode ? ' qx-chip--active' : ''}`}
              onClick={() => setColorMode(mode)}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
          <div className="qx-graph-hud__meta">
            {stats.nodes.toLocaleString()} nodes &middot; {stats.edges.toLocaleString()} edges
          </div>
        </div>

        {/* Repo legend — click a repo to hide/show its nodes */}
        <div className="qx-graph-hud__legend">
          {colorMode === 'repo' && Object.entries(REPO_COLORS).map(([repo, color]) => (
            <div
              key={repo}
              className={`qx-graph-hud__legend-item${mutedRepos.has(repo) ? ' qx-graph-hud__legend-item--muted' : ''}`}
              onClick={() => toggleRepoMute(repo)}
              role="button"
              tabIndex={0}
              title={mutedRepos.has(repo) ? `Show ${repo}` : `Hide ${repo}`}
            >
              <span className="qx-graph-hud__legend-dot" style={{ '--qx-node-color': color }} />
              {repo}
            </div>
          ))}
        </div>

        {/* Selected node info */}
        {selectedNode && (
          <div className="qx-card qx-graph-node-info">
            <div
              className="qx-graph-node-info__id"
              style={{ '--qx-node-color': REPO_COLORS[selectedNode.repo] || '#a855f7' }}
            >
              {selectedNode.id}
            </div>
            <div className="qx-graph-node-info__grid">
              <span className="qx-graph-node-info__label">Repo</span>
              <span className="qx-graph-node-info__value">{selectedNode.repo}</span>
              <span className="qx-graph-node-info__label">Language</span>
              <span className="qx-graph-node-info__value">{selectedNode.lang || 'unknown'}</span>
              <span className="qx-graph-node-info__label">Size</span>
              <span className="qx-graph-node-info__value">{(selectedNode.size || 0).toLocaleString()} bytes</span>
              <span className="qx-graph-node-info__label">Connections</span>
              <span className="qx-graph-node-info__value qx-graph-node-info__value--accent">{selectedNode.degree || 0}</span>
            </div>
            <div className="qx-row qx-row--tight" style={{ marginTop: 10 }}>
              <button
                className="qx-btn qx-btn--ghost qx-btn--sm"
                type="button"
                onClick={() => handleSearchThisFile(selectedNode.id)}
              >
                Search this file
              </button>
              <button
                className={`qx-btn qx-btn--ghost qx-btn--sm${copiedPath ? ' qx-btn--success' : ''}`}
                type="button"
                onClick={() => handleCopyPath(selectedNode.id)}
              >
                {copiedPath ? 'Copied' : 'Copy path'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
