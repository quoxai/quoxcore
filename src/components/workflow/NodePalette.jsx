/**
 * NodePalette - Browseable panel of QuoxFlow node types
 *
 * Displays all available node types grouped by category with
 * collapsible sections, search filtering, and click-to-select.
 *
 * Props:
 *   onSelectNode(nodeType: string) - called when a node is clicked
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { assistants } from '../../config/assistants'
import { useAuth } from '../../contexts/AuthContext'
import './NodePalette.css'

/**
 * Drop payload carried via `application/quoxflow-drop-item` (JSON).
 * Shape:
 *   { kind: 'node',  nodeType: 'trigger:schedule' }
 *   { kind: 'agent', nodeType: 'agent:agentic', agentId: 'nova', agentName: 'DAEDALUS' }
 *
 * For backwards compat with the legacy single-MIME drop path, every drag also
 * sets `application/quoxflow-node` to the resolved nodeType string. New
 * consumers should prefer the structured payload.
 */
export const DROP_MIME = 'application/quoxflow-drop-item'
export const LEGACY_DROP_MIME = 'application/quoxflow-node'

function setDragPayload(event, payload) {
  event.dataTransfer.setData(DROP_MIME, JSON.stringify(payload))
  event.dataTransfer.setData(LEGACY_DROP_MIME, payload.nodeType)
  event.dataTransfer.effectAllowed = 'move'
}

// =============================================================================
// INLINE SVG ICONS
// =============================================================================

const icons = {
  // Category icons
  triggers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  controlFlow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  ),
  actions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  data: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  errorHandling: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  utilities: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  human: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
      <path d="M17 11l2 2 4-4" />
    </svg>
  ),
  notifications: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  // Header icon
  palette: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  // Chevron for collapsible sections
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  // Search icon
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  // Empty state icon
  empty: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  ),
}

// =============================================================================
// NODE TYPE DEFINITIONS
// =============================================================================

export const NODE_CATEGORIES = [
  {
    id: 'triggers',
    label: 'Triggers',
    icon: icons.triggers,
    cssClass: 'triggers',
    nodes: [
      {
        type: 'trigger:webhook',
        name: 'Webhook',
        description: 'HTTP webhook trigger (POST, GET)',
      },
      {
        type: 'trigger:schedule',
        name: 'Schedule',
        description: 'Cron-based scheduled execution',
      },
      {
        type: 'trigger:event',
        name: 'Event',
        description: 'Event-driven trigger from event bus',
      },
    ],
  },
  {
    id: 'control-flow',
    label: 'Control Flow',
    icon: icons.controlFlow,
    cssClass: 'control-flow',
    nodes: [
      {
        type: 'flow:condition',
        name: 'Condition',
        description: 'If/else branching based on expressions',
      },
      {
        type: 'flow:switch',
        name: 'Switch',
        description: 'Multi-path routing with pattern matching',
      },
      {
        type: 'flow:loop',
        name: 'Loop',
        description: 'Iterate over arrays',
      },
      {
        type: 'flow:parallel',
        name: 'Parallel',
        description: 'Execute branches in parallel (all/race/any)',
      },
      {
        type: 'flow:merge',
        name: 'Merge',
        description: 'Combine results from parallel branches',
      },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    icon: icons.actions,
    cssClass: 'actions',
    nodes: [
      {
        type: 'call',
        name: 'HTTP Call',
        description: 'HTTP requests with retry, timeout, SSRF protection',
      },
      {
        type: 'agent:agentic',
        name: 'AI Model',
        description: 'Direct LLM call. Plans, executes tools, and re-observes up to 10 iterations. Use this when no predefined agent fits — drag a specific agent from the Agents section to use one.',
      },
      {
        type: 'proxy:n8n',
        name: 'n8n Connector',
        description: 'Run a step through n8n to reach 400+ SaaS integrations.',
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: icons.agents,
    cssClass: 'agents',
    nodes: [
      {
        type: 'agent:invoke',
        name: 'Agent',
        description: 'Invoke a predefined QuoxCORE agent by id and wait for its response.',
      },
      {
        type: 'team:invoke',
        name: 'Team',
        description: 'Dispatch an objective to a Stream AT agentic team and wait for completion (up to 30 min).',
      },
      {
        type: 'team:member',
        name: 'Team Member',
        description: 'Route work to a specific role inside a team.',
      },
      {
        type: 'assistant:invoke',
        name: 'Assistant',
        description: 'Invoke a pinned-persona assistant (DAEDALUS, CIPHER, etc.).',
      },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    icon: icons.data,
    cssClass: 'data',
    nodes: [
      {
        type: 'data:transform',
        name: 'Transform',
        description: 'Transform data using sandboxed expressions',
      },
      {
        type: 'data:set',
        name: 'Set Variable',
        description: 'Set variables in workflow context',
      },
      {
        type: 'data:aggregate',
        name: 'Aggregate',
        description: 'Aggregate data (sum, average, count)',
      },
    ],
  },
  {
    id: 'error-handling',
    label: 'Error Handling',
    icon: icons.errorHandling,
    cssClass: 'error-handling',
    nodes: [
      {
        type: 'error:try',
        name: 'Try/Catch',
        description: 'Try/catch blocks around node groups',
      },
      {
        type: 'error:throw',
        name: 'Throw Error',
        description: 'Throw errors with structured metadata',
      },
    ],
  },
  {
    id: 'utilities',
    label: 'Utilities',
    icon: icons.utilities,
    cssClass: 'utilities',
    nodes: [
      {
        type: 'util:wait',
        name: 'Wait',
        description: 'Delay or poll for a condition',
      },
      {
        type: 'util:log',
        name: 'Log',
        description: 'Emit structured log entries',
      },
      {
        type: 'util:subworkflow',
        name: 'Subworkflow',
        description: 'Execute nested workflows',
      },
    ],
  },
  {
    id: 'human',
    label: 'Human',
    icon: icons.human,
    cssClass: 'human',
    nodes: [
      {
        type: 'human:task',
        name: 'Human Task',
        description: 'Pause the workflow and wait for a human response. Routes to the HITL inbox; supports approve/deny, custom action buttons, or form responses.',
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: icons.notifications,
    cssClass: 'notifications',
    nodes: [
      {
        type: 'notification:deliver',
        name: 'Notification',
        description: 'Deliver a result to the user\'s inbox without pausing the workflow.',
      },
    ],
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: icons.integration,
    cssClass: 'integration',
    nodes: [
      {
        type: 'browser:navigate',
        name: 'Open URL',
        description: 'Open a URL in a headless browser.',
      },
      {
        type: 'browser:screenshot',
        name: 'Screenshot',
        description: 'Capture a screenshot of the current page.',
      },
      {
        type: 'browser:extract',
        name: 'Extract Data',
        description: 'Extract structured data from a web page.',
      },
      {
        type: 'browser:fill_form',
        name: 'Fill Form',
        description: 'Fill web form fields by label or selector.',
      },
      {
        type: 'browser:objective',
        name: 'Browser Agent',
        description: 'Multi-step browser automation that plans and acts toward a goal, with HITL gates.',
      },
    ],
  },
]

// Total node count across all categories
const TOTAL_NODE_COUNT = NODE_CATEGORIES.reduce(
  (sum, cat) => sum + cat.nodes.length,
  0
)

// =============================================================================
// AGENTS — drag any registry agent to drop an agent:agentic node prefilled
// with that agent's id. Sourced from assistants.js so additions show up here
// automatically.
//
// Visual hierarchy (the data model is flat — everyone reportsTo: 'quox' —
// but role + level give us enough to render a 3-tier tree):
//   • Orchestrator → CommanderQ alone
//   • Managers     → role: 'manager' or 'analyst' (broad domain agents)
//   • Specialists  → everyone else (single-purpose agents)
// =============================================================================

const AGENT_TIER_ORDER = ['orchestrator', 'manager', 'specialist']

function agentTier(a) {
  if (a.role === 'orchestrator' || a.level === 0) return 'orchestrator'
  if (a.role === 'manager' || a.role === 'analyst') return 'manager'
  return 'specialist'
}

const STATIC_AGENTS = Object.values(assistants).map((a) => ({
  id: a.id,
  name: a.name || a.id,
  color: a.color || '#10b981',
  description: a.description || a.specialty || '',
  tier: agentTier(a),
}))

function sortAgents(list) {
  return [...list].sort((a, b) => {
    const ta = AGENT_TIER_ORDER.indexOf(a.tier)
    const tb = AGENT_TIER_ORDER.indexOf(b.tier)
    if (ta !== tb) return ta - tb
    return a.name.localeCompare(b.name)
  })
}

// W2.5-1: team:invoke is now available — Teams placeholder removed.
// The team:invoke node type lives in the Agents category of NODE_CATEGORIES.

// =============================================================================
// COMPONENT
// =============================================================================

export function NodePalette({ onSelectNode, onSelectAgent }) {
  const [collapsedCategories, setCollapsedCategories] = useState({})
  const [searchQuery, setSearchQuery] = useState('')

  const [dbAgents, setDbAgents] = useState([])
  const orgId = (() => {
    try { return useAuth()?.user?.org_id || null } catch { return null }
  })()

  useEffect(() => {
    if (!orgId) return
    let cancelled = false
    fetch(`/api/orgs/${encodeURIComponent(orgId)}/agents`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((data) => { if (!cancelled) setDbAgents(data.agents || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [orgId])

  const AGENTS = useMemo(() => {
    const staticIds = new Set(STATIC_AGENTS.map((a) => a.id))
    const dbExtras = dbAgents
      .filter((a) => !staticIds.has(a.agent_id))
      .map((a) => ({
        id: a.agent_id,
        name: a.name || a.agent_id,
        color: a.icon || '#10b981',
        description: a.description || '',
        tier: a.level === 0 ? 'orchestrator' : a.level === 1 ? 'manager' : 'specialist',
      }))
    return sortAgents([...STATIC_AGENTS, ...dbExtras])
  }, [dbAgents])

  const toggleCategory = useCallback((categoryId) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }))
  }, [])

  const handleNodeClick = useCallback(
    (nodeType) => {
      if (onSelectNode) onSelectNode(nodeType)
    },
    [onSelectNode]
  )

  const handleAgentClick = useCallback(
    (agent) => {
      if (onSelectAgent) onSelectAgent(agent)
    },
    [onSelectAgent]
  )

  const query = searchQuery.toLowerCase().trim()
  const isFiltering = query.length > 0

  // Global filter across nodes + agents. Teams are static placeholder; they
  // disappear from view while a search is active so results stay focused.
  const filteredCategories = useMemo(() => {
    if (!isFiltering) return NODE_CATEGORIES
    return NODE_CATEGORIES.map((category) => ({
      ...category,
      nodes: category.nodes.filter(
        (node) =>
          node.name.toLowerCase().includes(query) ||
          node.type.toLowerCase().includes(query) ||
          node.description.toLowerCase().includes(query)
      ),
    })).filter((category) => category.nodes.length > 0)
  }, [isFiltering, query])

  const filteredAgents = useMemo(() => {
    if (!isFiltering) return AGENTS
    return AGENTS.filter(
      (a) =>
        a.name.toLowerCase().includes(query) ||
        a.id.toLowerCase().includes(query) ||
        a.description.toLowerCase().includes(query)
    )
  }, [isFiltering, query, AGENTS])

  const visibleNodeCount = useMemo(
    () => filteredCategories.reduce((sum, cat) => sum + cat.nodes.length, 0),
    [filteredCategories]
  )

  const totalVisible = visibleNodeCount + filteredAgents.length
  const noResults = isFiltering && totalVisible === 0

  const totalCount = TOTAL_NODE_COUNT + AGENTS.length

  return (
    <div className="node-palette">
      {/* Header */}
      <div className="node-palette__header">
        <div className="node-palette__header-icon">{icons.palette}</div>
        <h3 className="node-palette__title">Palette</h3>
        <span className="node-palette__count">
          {isFiltering ? `${totalVisible} / ${totalCount}` : totalCount}
        </span>
      </div>

      {/* Search */}
      <div className="node-palette__search">
        <div className="node-palette__search-wrapper">
          <div className="node-palette__search-icon">{icons.search}</div>
          <input
            type="text"
            className="node-palette__search-input"
            placeholder="Search nodes, agents, teams…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* List */}
      <div className="node-palette__list">
        {noResults ? (
          <div className="node-palette__empty">
            <div className="node-palette__empty-icon">{icons.empty}</div>
            <div className="node-palette__empty-text">
              No matches for "{searchQuery}"
            </div>
            <div className="node-palette__empty-hint">
              Try a different search term
            </div>
          </div>
        ) : (
          <>
            {/* ── Section 1: Node types ───────────────────────────────── */}
            {filteredCategories.length > 0 && (
              <>
                <div className="node-palette__section-header">
                  Node Types
                  <span className="node-palette__section-count">
                    {visibleNodeCount}
                  </span>
                </div>
                {filteredCategories.map((category) => {
                  const isCollapsed =
                    !isFiltering && collapsedCategories[category.id]
                  return (
                    <div
                      key={category.id}
                      className={`node-palette__category${isCollapsed ? ' node-palette__category--collapsed' : ''}`}
                    >
                      <button
                        className="node-palette__category-header"
                        onClick={() => toggleCategory(category.id)}
                        type="button"
                      >
                        <span className="node-palette__category-icon">
                          {category.icon}
                        </span>
                        <span className="node-palette__category-label">
                          {category.label}
                        </span>
                        <span className="node-palette__category-count">
                          {category.nodes.length}
                        </span>
                        <span className="node-palette__category-chevron">
                          {icons.chevron}
                        </span>
                      </button>

                      <div className="node-palette__items">
                        {category.nodes.map((node) => (
                          <button
                            key={node.type}
                            className="node-palette__node"
                            onClick={() => handleNodeClick(node.type)}
                            draggable
                            onDragStart={(e) =>
                              setDragPayload(e, {
                                kind: 'node',
                                nodeType: node.type,
                              })
                            }
                            type="button"
                            title={`Add ${node.name} node (${node.type})`}
                          >
                            <span
                              className={`node-palette__node-icon node-palette__node-icon--${category.cssClass}`}
                            >
                              {category.icon}
                            </span>
                            <span className="node-palette__node-info">
                              <span className="node-palette__node-name">
                                {node.name}
                              </span>
                              <span className="node-palette__node-type">
                                {node.type}
                              </span>
                              <span className="node-palette__node-desc">
                                {node.description}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {/* ── Section 2: Agents ────────────────────────────────────── */}
            {filteredAgents.length > 0 && (
              <>
                <div className="node-palette__section-header">
                  Agents
                  <span className="node-palette__section-count">
                    {filteredAgents.length}
                  </span>
                </div>
                <div className="node-palette__items node-palette__items--agents">
                  {filteredAgents.map((agent) => (
                    <button
                      key={agent.id}
                      className={`node-palette__node node-palette__node--agent node-palette__node--tier-${agent.tier}`}
                      onClick={() => handleAgentClick(agent)}
                      draggable
                      onDragStart={(e) =>
                        setDragPayload(e, {
                          kind: 'agent',
                          nodeType: 'agent:agentic',
                          agentId: agent.id,
                          agentName: agent.name,
                        })
                      }
                      type="button"
                      title={`Add ${agent.name} as agent:agentic node`}
                    >
                      <span
                        className="node-palette__node-icon node-palette__node-icon--agent"
                        style={{
                          background: `${agent.color}1a`,
                          color: agent.color,
                          borderColor: `${agent.color}33`,
                        }}
                      >
                        {agent.name.charAt(0)}
                      </span>
                      <span className="node-palette__node-info">
                        <span className="node-palette__node-name">
                          {agent.name}
                        </span>
                        <span className="node-palette__node-type">
                          {agent.id}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ── Section 3: Teams — team:invoke ships in W2.5-1 ──────── */}
            {/* Team node type is now in the Agents category above. */}
          </>
        )}
      </div>
    </div>
  )
}

export default NodePalette
