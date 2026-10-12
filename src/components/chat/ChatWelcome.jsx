/**
 * ChatWelcome - Agent identity & briefing panel
 *
 * Accordion-style panels: each section expands individually to use full width.
 * Quick actions aggregates ALL agent suggestions with search.
 * Collapses to a slim bar when conversation starts; re-expandable.
 */

import { useState, useMemo, useCallback } from 'react'
import { agentRegistry, getAgentSuggestions } from '../../config/agentRegistry'
import { getRuntimeAssistantConfig } from '../../services/entityRegistry'
import { useAgentToolsTruth } from '../../services/agentToolsTruth'
import './chat-welcome.css'

// ─── Data Resolution ───────────────────────────────────────────

function getAssistantIdentity(id) {
    return getRuntimeAssistantConfig(id)
}

function resolveAgentData(assistantId, currentAssistantData, toolsTruth) {
    const core = getAssistantIdentity(assistantId)
    const reg = agentRegistry.agents[assistantId]

    const isOrchestrator = reg?.role === 'orchestrator'
    const role = reg?.role || currentAssistantData?.role || 'specialist'
    const level = reg?.level ?? currentAssistantData?.level ?? 1

    let typeLabel = 'Assistant'
    if (isOrchestrator) typeLabel = 'Orchestrator'
    else if (role === 'manager') typeLabel = 'Agent'
    else if (role === 'specialist') typeLabel = 'Specialist'

    const description = reg?.description || core?.description || currentAssistantData?.specialty || ''
    const sysPrompt = reg?.systemPrompt || core?.systemPrompt || ''
    const fullDescription = sysPrompt
        ? sysPrompt.split('\n\n').slice(0, 2).join('\n\n').replace(/^You are .*?\.\s*/i, '').trim()
        : ''

    const color = core?.color?.primary || core?.color || currentAssistantData?.color?.primary || currentAssistantData?.color || '#38bdf8'
    const capabilities = reg?.capabilities || core?.capabilities || []

    const canDelegateTo = (core?.canDelegateTo || reg?.canDelegateTo || [])
        .map(id => {
            const identity = getAssistantIdentity(id)
            return {
            id,
            name: identity?.name || agentRegistry.agents[id]?.name || id,
            domain: agentRegistry.agents[id]?.domain || identity?.specialty || '',
            color: identity?.color?.primary || identity?.color || '#666',
        }})
        .filter(a => a.id !== assistantId)

    // AGENT-OVERHAUL-2: tools come from the runtime truth (collector's actual
    // grant), not the registry's declared list — see agentToolsTruth.js.
    const tools = (toolsTruth?.tools || []).filter(t => !t.startsWith('memory_') && t !== 'entity_note')
    const toolsSource = toolsTruth?.source || 'fallback'
    const workflows = reg?.workflows || []

    const collaboratesWith = (reg?.collaboratesWith || []).map(id => {
        const identity = getAssistantIdentity(id)
        return {
        id,
        name: identity?.name || agentRegistry.agents[id]?.name || id,
        color: identity?.color?.primary || identity?.color || '#666',
    }})

    const reportsTo = reg?.reportsTo
        ? { id: reg.reportsTo, name: getAssistantIdentity(reg.reportsTo)?.name || reg.reportsTo }
        : null

    return { typeLabel, role, level, isOrchestrator, description, fullDescription, color, capabilities, canDelegateTo, tools, toolsSource, workflows, collaboratesWith, reportsTo }
}

/**
 * Collect ALL quick actions across all agents (for orchestrator)
 * Groups by agent with the agent's own suggestions
 */
function collectAllSuggestions(assistantId) {
    const reg = agentRegistry.agents[assistantId]
    const isOrchestrator = reg?.role === 'orchestrator'

    if (!isOrchestrator) {
        const own = getAgentSuggestions(assistantId, 10, false)
        const identity = getAssistantIdentity(assistantId)
        return [{ agentId: assistantId, agentName: identity?.name || assistantId, color: identity?.color?.primary || identity?.color || '#38bdf8', suggestions: own }]
    }

    // Orchestrator: collect from self + all delegatable agents
    const groups = []
    const ownSuggestions = reg?.suggestions || []
    if (ownSuggestions.length > 0) {
        groups.push({ agentId: assistantId, agentName: 'CommanderQ', color: '#38bdf8', suggestions: ownSuggestions })
    }

    const delegatees = reg?.canDelegateTo || []
    for (const id of delegatees) {
        const agent = agentRegistry.agents[id]
        if (!agent?.suggestions?.length) continue
        const identity = getAssistantIdentity(id)
        groups.push({
            agentId: id,
            agentName: agent.name || identity?.name || id,
            color: identity?.color?.primary || identity?.color || '#666',
            suggestions: agent.suggestions,
        })
    }
    return groups
}

const TOOL_LABELS = {
    ssh_exec: 'ssh exec', fleet_status: 'fleet status', docker_status: 'docker status',
    docker_extended: 'docker ext', system_admin: 'sys admin', network_check: 'net check',
    proxmox_vms: 'proxmox vms', proxmox_cluster_status: 'px cluster', proxmox_vm_action: 'vm action',
    security_audit: 'sec audit', ssl_certificates: 'ssl certs', metrics_query: 'metrics',
    uptime_status: 'uptime', log_search: 'log search',
}

// ─── Sub-components ────────────────────────────────────────────

function AccordionPanel({ label, count, icon, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className={`cw-card ${open ? 'cw-card--open' : ''}`}>
            <button className="cw-card__header" onClick={() => setOpen(o => !o)}>
                <div className="cw-section-label" style={{ marginBottom: 0 }}>
                    {icon}
                    <span className="cw-section-label__text">{label}</span>
                    {count != null && <span className="cw-section-label__count">{count}</span>}
                </div>
                <svg className={`cw-card__chevron ${open ? 'cw-card__chevron--open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none"
                    style={{ stroke: 'rgba(255,255,255,0.4)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            {open && <div className="cw-card__body">{children}</div>}
        </div>
    )
}

function AgentChip({ agent }) {
    return (
        <span className="cw-agent-chip">
            <span className="cw-dot" style={{ background: agent.color, color: agent.color, width: 6, height: 6 }} />
            <span className="cw-agent-chip__name">{agent.name}</span>
            {agent.domain && <span className="cw-agent-chip__domain">{agent.domain}</span>}
        </span>
    )
}

function ToolBadge({ tool }) {
    return (
        <span className="cw-tool-badge">
            {TOOL_LABELS[tool] || tool.replace(/_/g, ' ')}
        </span>
    )
}

function WorkflowBadge({ name }) {
    return (
        <span className="cw-workflow-badge">
            {name}
        </span>
    )
}

// ─── SVG Icons ─────────────────────────────────────────────────

const Ico = ({ children, size = 10, color = 'rgba(255,255,255,0.4)' }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        style={{ stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0 }}>
        {children}
    </svg>
)

const Icons = {
    users: <Ico><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></Ico>,
    tool: <Ico><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></Ico>,
    workflow: <Ico color="rgba(139,92,246,0.55)"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></Ico>,
    collab: <Ico><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></Ico>,
    zap: <Ico><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></Ico>,
    search: <Ico size={13} color="rgba(255,255,255,0.45)"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></Ico>,
}

// ─── Quick Actions Panel (searchable, grouped) ─────────────────

function QuickActionsPanel({ groups, onAction, accent }) {
    const [search, setSearch] = useState('')
    const lc = search.toLowerCase()

    const filtered = useMemo(() => {
        if (!lc) return groups
        return groups.map(g => ({
            ...g,
            suggestions: g.suggestions.filter(s => s.toLowerCase().includes(lc)),
        })).filter(g => g.suggestions.length > 0)
    }, [groups, lc])

    const totalCount = groups.reduce((n, g) => n + g.suggestions.length, 0)
    const filteredCount = filtered.reduce((n, g) => n + g.suggestions.length, 0)

    return (
        <div>
            {/* Search bar */}
            <div className="cw-search-wrap">
                {Icons.search}
                <input
                    className="cw-search"
                    type="text"
                    placeholder={`Search ${totalCount} actions across ${groups.length} agents...`}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                {search && (
                    <button className="cw-search-clear" onClick={() => setSearch('')} aria-label="Clear">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2, strokeLinecap: 'round' }}>
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                )}
            </div>

            {/* Grouped results */}
            <div className="cw-actions-list">
                {filtered.length === 0 && (
                    <p style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 8, margin: 0 }}>
                        No matching actions
                    </p>
                )}
                {filtered.map(group => (
                    <div key={group.agentId} className="cw-action-group">
                        <div className="cw-action-group__label">
                            <span className="cw-dot" style={{ background: group.color, color: group.color, width: 5, height: 5 }} />
                            <span>{group.agentName}</span>
                        </div>
                        {group.suggestions.map((s, i) => (
                            <button key={i} className="cw-action" onClick={() => onAction?.(s)}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                                    style={{ stroke: group.color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0, opacity: 0.4 }}>
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                                </svg>
                                {s}
                            </button>
                        ))}
                    </div>
                ))}
            </div>

            {search && filteredCount < totalCount && (
                <p style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textAlign: 'center', marginTop: 6 }}>
                    Showing {filteredCount} of {totalCount}
                </p>
            )}
        </div>
    )
}

// ─── Main Component ────────────────────────────────────────────

export default function ChatWelcome({
    assistantId,
    currentAssistantData,
    onQuickAction,
    isCollapsed,
    onToggleCollapse,
}) {
    const [descExpanded, setDescExpanded] = useState(false)

    const toolsTruth = useAgentToolsTruth(assistantId)

    const data = useMemo(
        () => resolveAgentData(assistantId, currentAssistantData, toolsTruth),
        [assistantId, currentAssistantData, toolsTruth]
    )

    const allSuggestionGroups = useMemo(
        () => collectAllSuggestions(assistantId),
        [assistantId]
    )

    const name = currentAssistantData?.name || 'QuoxCORE'
    const specialty = currentAssistantData?.specialty || 'Infrastructure Command Center'
    const accent = data.color

    const descText = data.description
    const fullDescText = data.fullDescription
    const hasLongDesc = fullDescText && fullDescText.length > descText.length + 20

    const hasTeam = data.canDelegateTo.length > 0
    const hasCollab = data.collaboratesWith.length > 0 && !data.isOrchestrator
    const hasTools = data.tools.length > 0
    const hasWorkflows = data.workflows.length > 0
    const totalActions = allSuggestionGroups.reduce((n, g) => n + g.suggestions.length, 0)

    // ── Collapsed bar ──
    if (isCollapsed) {
        return (
            <button className="cw-collapsed" onClick={onToggleCollapse} title="Expand assistant info">
                <span className="cw-dot" style={{ background: accent, color: accent }} />
                <span style={{ fontWeight: 500, color: 'rgba(255,255,255,0.75)' }}>{name}</span>
                <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{data.typeLabel}</span>
                <span style={{ color: 'rgba(255,255,255,0.2)' }}>/</span>
                <span style={{ color: 'rgba(255,255,255,0.5)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{specialty}</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    style={{ stroke: 'rgba(255,255,255,0.4)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
        )
    }

    return (
        <div className="cw-panel">
            {/* Identity header */}
            <div className="cw-avatar" style={{
                background: `linear-gradient(135deg, ${accent}18, ${accent}08)`,
                '--cw-accent': accent,
            }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{
                    stroke: accent, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.7,
                }}>
                    {data.isOrchestrator ? (
                        <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>
                    ) : (
                        <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5C7.5 16 9.5 14.5 12 14.5s4.5 1.5 5.5 4"/></>
                    )}
                </svg>
            </div>

            <span className="cw-type-badge" style={{
                background: `${accent}10`, border: `1px solid ${accent}20`, color: accent,
            }}>
                <span className="cw-dot" style={{ background: accent, color: accent, width: 5, height: 5 }} />
                {data.typeLabel}
                {data.level != null && <span style={{ opacity: 0.5 }}>&middot; L{data.level}</span>}
            </span>

            <h1 className="cw-name">{name}</h1>
            <p className="cw-specialty">{specialty}</p>

            <p className="cw-description">
                {descExpanded ? fullDescText : descText}
                {hasLongDesc && (
                    <button className="cw-expand-btn" onClick={() => setDescExpanded(!descExpanded)} style={{ color: accent }}>
                        {descExpanded ? 'less' : 'more...'}
                    </button>
                )}
            </p>

            {data.reportsTo && <p className="cw-reports-to">Reports to {data.reportsTo.name}</p>}

            <div className="cw-divider" />

            {/* Accordion panels */}
            <div className="cw-panels">
                {/* Quick actions — default open, searchable */}
                {totalActions > 0 && (
                    <AccordionPanel label="Quick actions" count={totalActions} icon={Icons.zap} defaultOpen>
                        <QuickActionsPanel groups={allSuggestionGroups} onAction={onQuickAction} accent={accent} />
                    </AccordionPanel>
                )}

                {/* Team roster */}
                {hasTeam && (
                    <AccordionPanel
                        label={data.isOrchestrator ? 'Agents under command' : 'Can delegate to'}
                        count={data.canDelegateTo.length}
                        icon={Icons.users}
                    >
                        <div className="cw-chips">
                            {data.canDelegateTo.map(a => <AgentChip key={a.id} agent={a} />)}
                        </div>
                    </AccordionPanel>
                )}

                {/* Collaborators */}
                {hasCollab && (
                    <AccordionPanel label="Collaborates with" count={data.collaboratesWith.length} icon={Icons.collab}>
                        <div className="cw-chips">
                            {data.collaboratesWith.map(a => <AgentChip key={a.id} agent={a} />)}
                        </div>
                    </AccordionPanel>
                )}

                {/* Tools — runtime-granted list; registry fallback marked as unverified */}
                {hasTools && (
                    <AccordionPanel label={data.toolsSource === 'fallback' ? 'Tools (unverified)' : 'Tools'} count={data.tools.length} icon={Icons.tool}>
                        <div className="cw-chips">
                            {data.tools.map(t => <ToolBadge key={t} tool={t} />)}
                        </div>
                    </AccordionPanel>
                )}

                {/* Workflows */}
                {hasWorkflows && (
                    <AccordionPanel label="Workflows" count={data.workflows.length} icon={Icons.workflow}>
                        <div className="cw-chips">
                            {data.workflows.map(w => <WorkflowBadge key={w} name={w} />)}
                        </div>
                    </AccordionPanel>
                )}
            </div>

            {/* Collapse */}
            {onToggleCollapse && (
                <button className="cw-collapse-btn" onClick={onToggleCollapse}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                        style={{ stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <polyline points="18 15 12 9 6 15"/>
                    </svg>
                    Collapse
                </button>
            )}
        </div>
    )
}
