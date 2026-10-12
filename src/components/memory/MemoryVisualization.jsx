/**
 * QuoxCORE Memory Visualization
 *
 * Visual representations of memory relationships, timelines, and knowledge graphs.
 * Rebuilt on the glass design system (qx-canvas/qx-node/qx-edge, qx-heatmap,
 * qx-bars, qx-tree) — real server-sourced data throughout, deterministic
 * layout (no Math.random() node placement).
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { getMemoryManager } from '../../services/memoryManager'
import { getMemoryClient } from '../../services/memoryClient'
import { getActiveIntents } from '../../services/intentMemory'
import { LocalOnlyNotice } from './LocalOnlyNotice'
import './memory.css'

// FIX #3 (MEMORY DATA-LAYER audit): cap on how many server memories feed
// the timeline/heatmap. The real store can hold tens of thousands of
// rows — we show the most recent MAX_VIZ_MEMORIES honestly rather than
// trying to render everything at once.
const MAX_VIZ_MEMORIES = 500

// The knowledge graph renders each node as a real (blurred glass) DOM
// element, which does not scale to hundreds of items the way the old
// <canvas> dots did. Cap node counts separately and say so honestly in
// the panel intro, reusing the same "showing N of M" pattern already
// used elsewhere in this view.
const GRAPH_MAX_MEMORY_NODES = 90
const GRAPH_MAX_ENTITY_NODES = 40

// Convert a server memories-table row (memory_type, content, created_at,
// provenance as a plain string, superseded_by, ...) into the shape the
// existing graph/timeline/heatmap views expect (type, provenance.createdAt,
// provenance.source, provenance.supersedes).
function normalizeServerMemories(rows) {
  // supersededByToSupersedes: newRowId -> oldRowId it replaces (server only
  // stores the inverse pointer — old row knows who superseded IT)
  const supersedes = new Map()
  for (const row of rows) {
    if (row.superseded_by) supersedes.set(row.superseded_by, row.id)
  }

  return rows.map(row => ({
    id: row.id,
    type: row.memory_type,
    content: row.content,
    confidence: { score: row.confidence ?? 0.8 },
    provenance: {
      source: row.provenance,
      createdAt: row.created_at,
      supersedes: supersedes.get(row.id) || null
    }
    // Note: the memories table has no "conflicts" concept server-side, so
    // conflict edges are intentionally omitted for server-sourced data
    // rather than fabricated.
  }))
}

// Fetch the visualization's memories, completely independently of
// stats/entities/relations, with one short retry to absorb a transient
// blip (e.g. a dropped health probe) rather than declaring the whole tab
// "server unavailable" from a single failed round-trip.
//
// Note: memoryClient.getMemories() deliberately never throws — on any
// HTTP/network failure it logs a warning, flips client.serverAvailable to
// false, and silently returns a localStorage-derived array instead (so
// other callers, e.g. the Overview tab's RecentMemoriesList, always get
// *something* back). That means a plain try/catch around getMemories()
// can't detect a real failure — client.serverAvailable is the only
// reliable signal, and it must be read immediately after this call,
// before getStats()/getEntities() get a chance to flip it for an
// unrelated reason.
async function loadMemoriesFromServer(client, attempt = 0) {
  try {
    const serverOk = await client.checkHealth()
    if (!serverOk) throw new Error('memory server health check failed')

    const rows = await client.getMemories({ limit: MAX_VIZ_MEMORIES })
    if (client.serverAvailable === false) {
      throw new Error('memories fetch fell back to localStorage')
    }

    return { memories: normalizeServerMemories(rows), total: rows.length, source: 'server' }
  } catch (err) {
    if (attempt < 1) {
      await new Promise(resolve => setTimeout(resolve, 400))
      return loadMemoriesFromServer(client, attempt + 1)
    }
    console.warn('[MemoryVisualization] Memories fetch failed after retry, falling back to localStorage:', err.message)
    return { memories: [], total: 0, source: 'local' }
  }
}

// Given a bounded list of entities, fetch each entity's relations (server
// route only supports per-entity lookup, GET /api/entity/:id) and build a
// deduplicated edge list. Never fabricated — entities/relations that fail
// to load are simply skipped.
async function loadEntityRelationEdges(client, entities) {
  const seen = new Set()
  const edges = []
  const results = await Promise.all(entities.map(e => client.getEntity(e.id).catch(() => null)))
  for (const full of results) {
    if (!full?.relations) continue
    for (const rel of full.relations) {
      const a = full.id
      const b = rel.related?.id
      if (!b) continue
      const key = [a, b].sort().join('::') + `::${rel.type}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        id: `rel-${rel.id || key}`,
        from: `ent-${rel.direction === 'outgoing' ? a : b}`,
        to: `ent-${rel.direction === 'outgoing' ? b : a}`,
        type: rel.type,
        context: rel.context
      })
    }
  }
  return edges
}

// Memory type colors. "observation" added because it is, in practice, the
// dominant real memory_type in the server-side store (see MEMORY DATA-LAYER
// audit) — without an explicit color it silently fell back to gray and was
// indistinguishable in the legend.
const TYPE_COLORS = {
  fact: '#4a9eff',
  preference: '#ffd700',
  constraint: '#67e8f9',
  decision: '#0ea5e9',
  error: '#e74c3c',
  reflection: '#1abc9c',
  intent: '#3498db',
  observation: '#9b59b6'
}

// Entity kind colors — matches the entity_type values the memory service
// actually writes (see services/memory/migrations/000-baseline.sql).
const ENTITY_TYPE_COLORS = {
  person: '#30ff90',
  host: '#f59e0b',
  service: '#38bdf8',
  concept: '#a855f7',
  location: '#67e8f9',
  container: '#fb923c',
  network: '#0ea5e9',
  file: '#94a3b8'
}

// Source colors
const SOURCE_COLORS = {
  tool_output: '#27ae60',
  explicit_command: '#3498db',
  user_stated: '#38bdf8',
  model_inference: '#95a5a6'
}

// Deterministic fallback color for any type/kind not in the maps above —
// hashed from the string itself, so it never changes across renders and
// never involves Math.random().
function hashColor(str = '') {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 62%, 58%)`
}

function colorForNode(kind, type) {
  if (kind === 'entity') return ENTITY_TYPE_COLORS[type] || hashColor(type || 'entity')
  return TYPE_COLORS[type] || hashColor(type || 'memory')
}

/** Small inline icon set — 14-16px, matches the rest of the dashboard. */
function Icon({ id, size = 14 }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true
  }
  switch (id) {
    case 'graph':
      return <svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8.2 7l7.6 3.6M8.2 17l7.6-3.6" /></svg>
    case 'timeline':
      return <svg {...p}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
    case 'heatmap':
      return <svg {...p}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
    case 'intents':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.5" fill="currentColor" /></svg>
    case 'close':
      return <svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
    case 'link':
      return <svg {...p}><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5" /><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.5" /></svg>
    default:
      return <svg {...p}><circle cx="12" cy="12" r="3" /></svg>
  }
}

/**
 * Memory Visualization Container
 */
export function MemoryVisualization({ view = 'graph' }) {
  const [memories, setMemories] = useState([])
  const [memoriesTotal, setMemoriesTotal] = useState(0)
  const [memoriesSource, setMemoriesSource] = useState('local') // 'server' | 'local'
  const [entities, setEntities] = useState([])
  const [entitiesTotal, setEntitiesTotal] = useState(0)
  const [relationEdges, setRelationEdges] = useState([])
  const [intents, setIntents] = useState([])
  const [activeView, setActiveView] = useState(view)
  const [selectedNode, setSelectedNode] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  // FIX #3: feed the graph/timeline/heatmap from the SERVER memory store
  // (the real 21k+ row source of truth) instead of localStorage, which is
  // empty on a fresh browser. localStorage is used only as a last-resort
  // fallback if the server is genuinely unreachable.
  //
  // RESILIENCE FIX (VIZ Server-unavailable false-positive, 2026-07):
  // memories are loaded independently of stats/entities/relations. Those
  // three enrichments are wrapped in their OWN try/catch and can never flip
  // `memoriesSource` to 'local' or wipe out memories that already loaded —
  // previously a single failing sibling inside one Promise.all (e.g. a
  // slow/erroring getEntities) took down the whole tab and showed the
  // false "Server unavailable" message even when memories loaded fine.
  const loadData = async () => {
    const client = getMemoryClient()
    let allEntities = []
    let entityTotal = 0
    let edges = []

    // Memories are the ONLY signal that sets memoriesSource. See
    // loadMemoriesFromServer() for why a bounded retry is needed here.
    const { memories: allMemories, total: memTotal, source } = await loadMemoriesFromServer(client)
    let total = memTotal

    if (source === 'server') {
      // Enrichments only — a failure here must never downgrade `source`
      // (memories already loaded successfully) or blank the graph.
      try {
        const [stats, entityRows] = await Promise.all([
          client.getStats().catch(() => null),
          client.getEntities({ limit: 200 }).catch(() => [])
        ])
        if (stats?.memories?.total != null) total = stats.memories.total

        allEntities = entityRows || []
        entityTotal = stats?.entities?.total ?? allEntities.length

        // Relations are only fetchable per-entity (no bulk endpoint) — bound
        // the fan-out to the entities we'll actually render as graph nodes.
        const relationCandidates = allEntities.slice(0, GRAPH_MAX_ENTITY_NODES)
        edges = await loadEntityRelationEdges(client, relationCandidates)
      } catch (err) {
        console.warn('[MemoryVisualization] Stats/entities/relations enrichment failed — memories still shown:', err.message)
      }
    } else {
      const mm = getMemoryManager()
      const types = ['fact', 'preference', 'constraint', 'decision', 'error', 'reflection', 'intent']
      for (const type of types) {
        const items = mm.getLearnedItemsByType(type)
        allMemories.push(...items.map(item => ({ ...item, type })))
      }
      total = allMemories.length
    }

    setMemories(allMemories)
    setMemoriesTotal(total)
    setMemoriesSource(source)
    setEntities(allEntities)
    setEntitiesTotal(entityTotal)
    setRelationEdges(edges)

    try {
      const activeIntents = await getActiveIntents()
      setIntents(activeIntents)
    } catch (err) {
      console.warn('Failed to load intents:', err)
    }
  }

  const subtabs = [
    { id: 'graph', label: 'Knowledge Graph', icon: 'graph' },
    { id: 'timeline', label: 'Timeline', icon: 'timeline' },
    { id: 'heatmap', label: 'Activity Heatmap', icon: 'heatmap' },
    { id: 'intents', label: 'Intent Hierarchy', icon: 'intents' }
  ]

  return (
    <div className="qx-stack">
      {/* View Selector */}
      <div className="qx-seg" role="tablist" aria-label="Memory visualization views">
        {subtabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeView === tab.id}
            className={`qx-seg__btn ${activeView === tab.id ? 'qx-seg__btn--active' : ''}`}
            onClick={() => setActiveView(tab.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Icon id={tab.icon} size={13} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Visualization Content */}
      <div className="qx-stack">
        {activeView === 'graph' && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              Your memory universe — each node is a real memory or entity from the server store.
              {memoriesSource === 'server' && memoriesTotal === 0 && entitiesTotal === 0
                ? ' No memories yet — nothing saved to server memory for this account.'
                : ''}
              {memoriesSource === 'server' && (memoriesTotal > 0 || entitiesTotal > 0) && (memoriesTotal > memories.length || entitiesTotal > entities.length)
                ? ` Showing the most recent ${Math.min(memories.length, GRAPH_MAX_MEMORY_NODES)} of ${memoriesTotal} memories and ${Math.min(entities.length, GRAPH_MAX_ENTITY_NODES)} of ${entitiesTotal} entities (capped for legibility).`
                : ''}
              {memoriesSource === 'local' && ' Server unavailable — showing localStorage data only.'}
            </p>
            <KnowledgeGraphView
              memories={memories}
              entities={entities}
              relationEdges={relationEdges}
              onSelectNode={setSelectedNode}
            />
          </>
        )}
        {activeView === 'timeline' && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              Memory creation over time. See when you learned what, grouped by day.
              {memoriesSource === 'server' && memoriesTotal === 0
                ? ' No memories yet — nothing saved to server memory for this account.'
                : ''}
              {memoriesSource === 'server' && memoriesTotal > memories.length
                ? ` Showing the ${memories.length} most recent of ${memoriesTotal} total.`
                : ''}
              {memoriesSource === 'local' && ' Server unavailable — showing localStorage data only.'}
            </p>
            <TimelineView
              memories={memories}
              onSelectNode={setSelectedNode}
            />
          </>
        )}
        {activeView === 'heatmap' && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              When you learn — real daily activity, colored by the dominant memory type that day.
              {memoriesSource === 'server' && memoriesTotal === 0
                ? ' No memories yet — nothing saved to server memory for this account.'
                : ''}
              {memoriesSource === 'server' && memoriesTotal > memories.length
                ? ` Based on the ${memories.length} most recent of ${memoriesTotal} total memories.`
                : ''}
              {memoriesSource === 'local' && ' Server unavailable — showing localStorage data only.'}
            </p>
            <ActivityHeatmap memories={memories} />
          </>
        )}
        {activeView === 'intents' && (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              Your goals organized by scope — strategic (long-term), tactical (mid-term), and operational (immediate). Progress bars show completion.
            </p>
            <LocalOnlyNotice label="intent hierarchy data" />
            <IntentHierarchy intents={intents} />
          </>
        )}
      </div>

      {/* Selected Node Detail */}
      {selectedNode && (
        <NodeDetail
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  )
}

/**
 * Timeline View — real per-day memory counts (qx-bars) + a chronological list.
 */
function TimelineView({ memories, onSelectNode }) {
  const [timeRange, setTimeRange] = useState('week') // day | week | month | all

  // Group memories by date
  const groupedMemories = useMemo(() => {
    const now = new Date()
    let cutoff = new Date(0)

    switch (timeRange) {
      case 'day':
        cutoff = new Date(now - 24 * 60 * 60 * 1000)
        break
      case 'week':
        cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000)
        break
      case 'month':
        cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000)
        break
    }

    const filtered = memories.filter(m => {
      const date = new Date(m.provenance?.createdAt || 0)
      return date >= cutoff
    })

    // Group by day
    const groups = {}
    for (const memory of filtered) {
      const date = new Date(memory.provenance?.createdAt || 0)
      const day = date.toISOString().split('T')[0]
      if (!groups[day]) {
        groups[day] = []
      }
      groups[day].push(memory)
    }

    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
  }, [memories, timeRange])

  // Real per-day bar chart, chronological (oldest → newest), capped to the
  // most recent 30 active days so the chart stays legible.
  const barDays = useMemo(() => [...groupedMemories].sort((a, b) => a[0].localeCompare(b[0])).slice(-30), [groupedMemories])
  const maxCount = Math.max(1, ...barDays.map(([, items]) => items.length))

  return (
    <div className="qx-stack">
      {/* Time Range Selector */}
      <div className="qx-seg">
        {['day', 'week', 'month', 'all'].map(range => (
          <button
            key={range}
            className={`qx-seg__btn ${timeRange === range ? 'qx-seg__btn--active' : ''}`}
            onClick={() => setTimeRange(range)}
          >
            {range.charAt(0).toUpperCase() + range.slice(1)}
          </button>
        ))}
      </div>

      {barDays.length > 0 && (
        <div className="qx-card qx-card--compact">
          <div className="qx-bars" style={{ height: 72 }}>
            {barDays.map(([day, items]) => (
              <div
                key={day}
                className="qx-bars__bar"
                style={{ '--qx-h': items.length / maxCount }}
                title={`${new Date(day).toLocaleDateString()}: ${items.length} memories`}
              />
            ))}
          </div>
          <div className="qx-row qx-row--apart" style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
            <span>{new Date(barDays[0][0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            <span>{new Date(barDays[barDays.length - 1][0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </div>
        </div>
      )}

      {/* Chronological (newest-first) list */}
      <div className="qx-stack qx-stack--tight">
        {groupedMemories.map(([date, items]) => (
          <div key={date} className="qx-stack qx-stack--tight">
            <div className="qx-row qx-row--tight" style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>
              <span>{new Date(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              <span className="qx-chip qx-chip--xs">{items.length}</span>
            </div>
            <div className="qx-stack qx-stack--tight">
              {items.map(memory => (
                <div
                  key={memory.id}
                  className="qx-result"
                  style={{ gridTemplateColumns: '4px 1fr auto', cursor: 'pointer' }}
                  onClick={() => onSelectNode({ kind: 'memory', type: memory.type, raw: memory })}
                >
                  <span style={{ background: colorForNode('memory', memory.type), borderRadius: 2, alignSelf: 'stretch' }} />
                  <div className="qx-result__body">
                    <span className="qx-result__title" style={{ color: colorForNode('memory', memory.type) }}>{memory.type}</span>
                    <div className="qx-result__snippet">
                      {memory.content?.substring(0, 140)}{memory.content?.length > 140 ? '…' : ''}
                    </div>
                    <div className="qx-result__meta">
                      <span style={{ color: SOURCE_COLORS[memory.provenance?.source] || 'rgba(255,255,255,0.8)' }}>
                        {memory.provenance?.source || 'unknown'}
                      </span>
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap' }}>
                    {memory.provenance?.createdAt ? new Date(memory.provenance.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {groupedMemories.length === 0 && (
          <div className="qx-empty">
            <div className="qx-empty__icon"><Icon id="timeline" size={22} /></div>
            <div className="qx-empty__title">No memories in this time range</div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Knowledge Graph View — real memories + entities positioned with a
 * deterministic golden-angle (Vogel) spiral layout. No Math.random() is
 * used for node placement, so positions are stable across renders for the
 * same underlying data. Edges are memory "supersedes" links and real
 * entity_relations — nothing fabricated.
 */
function KnowledgeGraphView({ memories, entities, relationEdges, onSelectNode }) {
  const containerRef = useRef(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const [hoveredId, setHoveredId] = useState(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) setDims({ width, height })
      }
    })
    ro.observe(el)
    if (el.clientWidth > 0) setDims({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const { nodes, edges } = useMemo(() => {
    const memNodes = memories.slice(0, GRAPH_MAX_MEMORY_NODES).map(m => ({
      id: `mem-${m.id}`,
      kind: 'memory',
      type: m.type || 'memory',
      label: (m.content || '(empty)').slice(0, 44),
      color: colorForNode('memory', m.type),
      raw: m
    }))
    const entNodes = entities.slice(0, GRAPH_MAX_ENTITY_NODES).map(e => ({
      id: `ent-${e.id}`,
      kind: 'entity',
      type: e.entity_type || 'entity',
      label: e.name || '(unnamed)',
      color: colorForNode('entity', e.entity_type),
      raw: e
    }))
    const allNodes = [...memNodes, ...entNodes]
    const nodeIds = new Set(allNodes.map(n => n.id))

    const edgeList = []
    for (const m of memNodes) {
      const supersedes = m.raw.provenance?.supersedes
      if (supersedes) {
        const fromId = `mem-${supersedes}`
        if (nodeIds.has(fromId)) {
          edgeList.push({ id: `sup-${fromId}-${m.id}`, from: fromId, to: m.id, kind: 'supersedes' })
        }
      }
    }
    for (const rel of relationEdges) {
      if (nodeIds.has(rel.from) && nodeIds.has(rel.to)) {
        edgeList.push({ id: rel.id, from: rel.from, to: rel.to, kind: 'relation', label: rel.type })
      }
    }

    return { nodes: allNodes, edges: edgeList }
  }, [memories, entities, relationEdges])

  // Deterministic golden-angle (Vogel/sunflower) spiral — index-based, no
  // randomness. Stable across renders as long as the node list is stable.
  const positioned = useMemo(() => {
    const { width, height } = dims
    if (!width || !height || nodes.length === 0) return []
    const cx = width / 2
    const cy = height / 2
    const maxR = Math.max(0, Math.min(width, height) / 2 - 52)
    const golden = Math.PI * (3 - Math.sqrt(5))
    return nodes.map((n, i) => {
      const r = nodes.length <= 1 ? 0 : maxR * Math.sqrt((i + 0.5) / nodes.length)
      const theta = i * golden
      return { ...n, x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) }
    })
  }, [nodes, dims])

  const posById = useMemo(() => new Map(positioned.map(n => [n.id, n])), [positioned])

  const legendEntries = useMemo(() => {
    const seen = new Map()
    for (const n of nodes) {
      const key = `${n.kind}:${n.type}`
      if (!seen.has(key)) seen.set(key, { kind: n.kind, type: n.type, color: n.color })
    }
    return [...seen.values()]
  }, [nodes])

  return (
    <div className="qx-stack">
      <div ref={containerRef} className="qx-canvas" style={{ height: 460, position: 'relative' }}>
        {nodes.length === 0 ? (
          <div className="qx-empty" style={{ height: '100%' }}>
            <div className="qx-empty__icon"><Icon id="graph" size={22} /></div>
            <div className="qx-empty__title">No memories or entities yet</div>
            <div className="qx-empty__body">Once you have memories and linked entities, they will appear here as a graph.</div>
          </div>
        ) : (
          <>
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {edges.map(e => {
                const from = posById.get(e.from)
                const to = posById.get(e.to)
                if (!from || !to) return null
                const active = hoveredId && (hoveredId === e.from || hoveredId === e.to)
                return (
                  <path
                    key={e.id}
                    d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
                    className={`qx-edge ${e.kind === 'relation' ? 'qx-edge--animated' : ''}`}
                    style={{ opacity: active ? 0.95 : e.kind === 'supersedes' ? 0.3 : 0.5 }}
                  />
                )
              })}
            </svg>
            {positioned.map(n => (
              <div
                key={n.id}
                className={`qx-node ${hoveredId === n.id ? 'qx-node--selected' : ''}`}
                style={{
                  '--qx-node-color': n.color,
                  position: 'absolute',
                  left: n.x,
                  top: n.y,
                  transform: 'translate(-50%, -50%)',
                  minWidth: 'auto',
                  maxWidth: 132,
                  padding: '5px 9px',
                  gap: 2,
                  zIndex: hoveredId === n.id ? 2 : 1
                }}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => onSelectNode(n)}
              >
                <div className="qx-node__head" style={{ fontSize: 8 }}>{n.kind === 'entity' ? 'ENTITY' : n.type}</div>
                <div
                  className="qx-node__title"
                  style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {n.label}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {nodes.length > 0 && edges.length === 0 && (
        <div className="qx-empty" style={{ padding: '20px 16px' }}>
          <div className="qx-empty__icon" style={{ width: 40, height: 40 }}><Icon id="link" size={18} /></div>
          <div className="qx-empty__title" style={{ fontSize: 13 }}>No links between memories or entities yet</div>
          <div className="qx-empty__body">
            Entity relationships and memory supersessions will appear as connecting lines once they exist —
            expected while entity-linking is still early.
          </div>
        </div>
      )}

      {legendEntries.length > 0 && (
        <div className="qx-row qx-row--wrap qx-row--tight">
          {legendEntries.map(item => (
            <span key={`${item.kind}-${item.type}`} className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, display: 'inline-block' }} />
              {item.kind === 'entity' ? `entity: ${item.type}` : item.type}
            </span>
          ))}
          {edges.some(e => e.kind === 'supersedes') && (
            <span className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#30ff90', display: 'inline-block' }} />
              supersedes
            </span>
          )}
          {edges.some(e => e.kind === 'relation') && (
            <span className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8', display: 'inline-block' }} />
              relation
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Activity Heatmap — real per-day memory counts, colored by the dominant
 * memory type that day. Only days with real activity are shown (no
 * fabricated empty calendar padding).
 */
function ActivityHeatmap({ memories }) {
  const daily = useMemo(() => {
    const map = new Map()
    for (const memory of memories) {
      const date = new Date(memory.provenance?.createdAt || 0)
      if (Number.isNaN(date.getTime()) || date.getTime() === 0) continue
      const key = date.toISOString().split('T')[0]
      if (!map.has(key)) map.set(key, { total: 0, byType: {} })
      const entry = map.get(key)
      entry.total++
      const t = memory.type || 'unknown'
      entry.byType[t] = (entry.byType[t] || 0) + 1
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [memories])

  if (daily.length === 0) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__icon"><Icon id="heatmap" size={22} /></div>
        <div className="qx-empty__title">No dated memories yet</div>
        <div className="qx-empty__body">Once memories have timestamps, daily activity will appear here.</div>
      </div>
    )
  }

  const displayDays = daily.slice(-42)
  const truncated = daily.length > displayDays.length
  const maxCount = Math.max(1, ...displayDays.map(([, v]) => v.total))

  const legendTypes = useMemo(() => {
    const seen = new Set()
    for (const [, v] of displayDays) {
      const dominant = Object.entries(v.byType).sort((a, b) => b[1] - a[1])[0]?.[0]
      if (dominant) seen.add(dominant)
    }
    return [...seen]
  }, [displayDays])

  return (
    <div className="qx-stack">
      {truncated && (
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
          Showing the most recent {displayDays.length} active days of {daily.length} total.
        </p>
      )}
      <div className="qx-heatmap">
        {displayDays.map(([day, v]) => {
          const dominant = Object.entries(v.byType).sort((a, b) => b[1] - a[1])[0]?.[0]
          const color = colorForNode('memory', dominant)
          const intensity = v.total / maxCount
          const label = new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return (
            <div
              key={day}
              className="qx-heatmap__cell"
              style={{ '--qx-cell-intensity': Math.max(intensity, 0.12), '--qx-cell-color': color }}
              title={`${new Date(day).toLocaleDateString()}: ${v.total} memories (mostly ${dominant})`}
            >
              <span className="qx-heatmap__label">{label}</span>
              <span className="qx-heatmap__val">{v.total}</span>
            </div>
          )
        })}
      </div>
      <div className="qx-row qx-row--wrap qx-row--tight">
        {legendTypes.map(type => (
          <span key={type} className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorForNode('memory', type), display: 'inline-block' }} />
            {type}
          </span>
        ))}
      </div>
    </div>
  )
}

const INTENT_STATUS_PILL = {
  active: 'qx-pill--online',
  paused: 'qx-pill--medium',
  blocked: 'qx-pill--danger',
  completed: 'qx-pill--success'
}

/**
 * Intent Hierarchy — Shows strategic goals structure
 */
function IntentHierarchy({ intents }) {
  const [expanded, setExpanded] = useState(new Set())

  // Group by level
  const byLevel = useMemo(() => ({
    strategic: intents.filter(i => i.goal?.level === 'strategic'),
    tactical: intents.filter(i => i.goal?.level === 'tactical'),
    operational: intents.filter(i => i.goal?.level === 'operational')
  }), [intents])

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderIntent = (intent, depth = 0) => {
    const children = intents.filter(i => i.goal?.parent === intent.id)
    const isExpanded = expanded.has(intent.id)
    const progressPercent = Math.round((intent.progress || 0) * 100)

    return (
      <div key={intent.id}>
        <div
          className={`qx-tree__item ${isExpanded ? 'qx-tree__item--open' : ''}`}
          style={{ '--qx-tree-depth': depth }}
          onClick={() => children.length > 0 && toggleExpand(intent.id)}
        >
          {children.length > 0 && <span className="qx-tree__chev">▶</span>}
          <span className="qx-pill qx-pill--xs qx-pill--ghost">{intent.goal?.level?.[0]?.toUpperCase()}</span>
          <span className="qx-tree__label">{intent.name}</span>
          <div className="qx-progress" style={{ width: 90, flexShrink: 0, '--qx-progress': progressPercent / 100 }} />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', minWidth: 30, textAlign: 'right', flexShrink: 0 }}>{progressPercent}%</span>
          <span className={`qx-pill qx-pill--xs ${INTENT_STATUS_PILL[intent.status] || 'qx-pill--ghost'}`}>{intent.status}</span>
        </div>

        {isExpanded && children.length > 0 && (
          <div>{children.map(child => renderIntent(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  if (intents.length === 0) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__icon"><Icon id="intents" size={22} /></div>
        <div className="qx-empty__title">No active intents tracked yet</div>
        <div className="qx-empty__body">Start conversations about your goals to see them here.</div>
      </div>
    )
  }

  return (
    <div className="qx-stack">
      {['strategic', 'tactical', 'operational'].map(level => (
        <div key={level} className="qx-card qx-card--compact qx-stack qx-stack--tight">
          <div className="qx-row qx-row--apart">
            <span className="qx-section-title">{level} goals</span>
            <span className="qx-chip qx-chip--xs">{byLevel[level].length}</span>
          </div>
          <div className="qx-tree">
            {byLevel[level]
              .filter(i => !i.goal?.parent || !intents.find(p => p.id === i.goal.parent))
              .map(intent => renderIntent(intent))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Node Detail Popup — handles both memory and entity nodes.
 */
function NodeDetail({ node, onClose }) {
  const isEntity = node.kind === 'entity'
  const raw = node.raw || node
  const color = node.color || colorForNode(node.kind || 'memory', node.type)

  return (
    <div className="qx-modal-overlay" onClick={onClose}>
      <div className="qx-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="qx-modal__header">
          <h3 style={{ color, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon id={isEntity ? 'link' : 'timeline'} size={16} />
            {isEntity ? 'Entity' : (node.type?.charAt(0).toUpperCase() + node.type?.slice(1) || 'Memory')}
          </h3>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close">
            <Icon id="close" />
          </button>
        </div>

        <div className="qx-modal__body qx-stack qx-stack--tight">
          <p style={{ margin: 0, fontSize: 13, color: '#fff', lineHeight: 1.5 }}>
            {isEntity ? raw.name : raw.content}
          </p>

          <div className="qx-stat-row">
            <span className="qx-stat-row__label">ID</span>
            <code className="qx-code">{raw.id}</code>
          </div>

          {isEntity ? (
            <>
              <div className="qx-stat-row">
                <span className="qx-stat-row__label">Entity Type</span>
                <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: 'inherit', color: '#fff' }}>{raw.entity_type}</span>
              </div>
              {raw.reference_count != null && (
                <div className="qx-stat-row">
                  <span className="qx-stat-row__label">References</span>
                  <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: 'inherit', color: '#fff' }}>{raw.reference_count}</span>
                </div>
              )}
              {raw.last_referenced && (
                <div className="qx-stat-row">
                  <span className="qx-stat-row__label">Last Referenced</span>
                  <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: 'inherit', color: '#fff' }}>{new Date(raw.last_referenced).toLocaleString()}</span>
                </div>
              )}
              {raw.attributes && Object.keys(raw.attributes).length > 0 && (
                <div className="qx-stack qx-stack--tight">
                  {Object.entries(raw.attributes).map(([k, v]) => (
                    <div key={k} className="qx-stat-row">
                      <span className="qx-stat-row__label">{k}</span>
                      <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: 'inherit', color: '#fff' }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {raw.provenance?.source && (
                <div className="qx-stat-row"><span className="qx-stat-row__label">Source</span>
                        <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: "inherit", color: "#fff" }}>{raw.provenance.source}</span></div>
              )}
              {raw.provenance?.createdAt && (
                <div className="qx-stat-row"><span className="qx-stat-row__label">Created</span>
                        <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: "inherit", color: "#fff" }}>{new Date(raw.provenance.createdAt).toLocaleString()}</span></div>
              )}
              {raw.confidence?.score != null && (
                <div className="qx-stack qx-stack--tight">
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>Confidence</span>
                  <div className="qx-progress qx-progress--brand" style={{ '--qx-progress': raw.confidence.score }} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default MemoryVisualization
