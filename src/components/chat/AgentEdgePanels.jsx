/**
 * AgentEdgePanels — Left-edge mounted panel buttons + slide-out panels
 *
 * Sits at the left boundary of the chat area. Small icon buttons that
 * open glassmorphic overlay panels with agent info (team, tools, workflows,
 * quick actions). Only one panel open at a time.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { agentRegistry, getAgentSuggestions } from '../../config/agentRegistry'
import { getRuntimeAssistantConfig } from '../../services/entityRegistry'
import { useAgentToolsTruth } from '../../services/agentToolsTruth'
import { getAgentTools } from '../../services/agentToolCatalogClient'
import './agent-edge-panels.css'

// ─── Data Resolution ─────────────────────────────────────────

function getAssistantIdentity(id) {
    return getRuntimeAssistantConfig(id)
}

function resolveAgentData(assistantId, toolsTruth) {
    const core = getAssistantIdentity(assistantId)
    const reg = agentRegistry.agents[assistantId]
    const isOrchestrator = reg?.role === 'orchestrator'
    const color = core?.color?.primary || core?.color || '#38bdf8'

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

    const name = core?.name || reg?.name || assistantId
    const role = reg?.role || core?.role || null

    return { isOrchestrator, name, role, color, canDelegateTo, tools, toolsSource, workflows, collaboratesWith }
}

function collectAllSuggestions(assistantId) {
    const reg = agentRegistry.agents[assistantId]
    const isOrchestrator = reg?.role === 'orchestrator'

    if (!isOrchestrator) {
        const own = getAgentSuggestions(assistantId, 10, false)
        const identity = getAssistantIdentity(assistantId)
        return [{ agentId: assistantId, agentName: identity?.name || assistantId, color: identity?.color?.primary || identity?.color || '#38bdf8', suggestions: own }]
    }

    const groups = []
    const ownSuggestions = reg?.suggestions || []
    if (ownSuggestions.length > 0) {
        groups.push({ agentId: assistantId, agentName: 'CommanderQ', color: '#38bdf8', suggestions: ownSuggestions })
    }

    for (const id of (reg?.canDelegateTo || [])) {
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
    ssh_exec: 'ssh exec', fleet_status: 'fleet status', docker_status: 'docker',
    docker_extended: 'docker ext', system_admin: 'sys admin', network_check: 'net check',
    proxmox_vms: 'proxmox vms', proxmox_cluster_status: 'px cluster', proxmox_vm_action: 'vm action',
    security_audit: 'sec audit', ssl_certificates: 'ssl certs', metrics_query: 'metrics',
    uptime_status: 'uptime', log_search: 'log search',
}

// Humanise a slug/id into a readable label ("ssh_exec" → "ssh exec").
function humanise(s) {
    return String(s || '').replace(/[_-]/g, ' ').trim()
}

// Static fallback descriptions for the common fleet tools — used only when the
// live catalog (getAgentTools → {name, description}) hasn't resolved. The live
// catalog is the real source; this keeps a genuine description on hover offline
// rather than echoing the label back.
const TOOL_DESCRIPTIONS = {
    ssh_exec: 'Run a shell command on a fleet host over SSH (via the bastion)',
    fleet_status: 'Report health and reachability across all managed hosts',
    docker_status: 'List running containers and their state on a host',
    docker_extended: 'Extended Docker ops: logs, restart, image and volume inspection',
    system_admin: 'Privileged host administration (services, packages, users)',
    network_check: 'Probe connectivity, DNS and port reachability',
    proxmox_vms: 'List Proxmox VMs and their run state',
    proxmox_cluster_status: 'Proxmox cluster health, quorum and node status',
    proxmox_vm_action: 'Start, stop or reconfigure a Proxmox VM',
    security_audit: 'Scan a host or surface for security findings',
    ssl_certificates: 'Inspect TLS certificates and expiry',
    metrics_query: 'Query time-series metrics (Prometheus/Grafana)',
    uptime_status: 'Uptime and probe results from monitoring',
    log_search: 'Search aggregated logs across hosts',
}

// Real one-line descriptions for the agent workflow/capability slugs declared in
// agentRegistry (a fixed vocabulary). The chip shows the slug; the tooltip says
// what the flow actually does — not the slug echoed back.
const WORKFLOW_DESCRIPTIONS = {
    activity: 'Recent activity and event timeline for this domain',
    'analyze-logs': 'Parse and summarise log output for errors and anomalies',
    'auth-audit': 'Audit authentication events and access for anomalies',
    'backup-schedule': 'Review and manage scheduled backup jobs',
    'chain-verify': 'Verify the evidence hash-chain integrity',
    'classify-task': 'Classify an incoming task by intent and route it',
    'cluster-status': 'Report cluster node health and quorum',
    'code-review': 'Review code changes for issues and quality',
    'compliance-audit': 'Check controls against compliance frameworks',
    'container-health': 'Inspect container health and restart state',
    'content-synthesis': 'Synthesise content from multiple sources',
    'core-health-check': 'Run a health check across core services',
    'cross-check': 'Cross-check a claim against independent sources',
    'cve-search': 'Search for known CVEs affecting the fleet',
    dashboards: 'Open and summarise monitoring dashboards',
    deployments: 'Review recent deployments and their status',
    'device-onboarding': 'Onboard a new device or host to the fleet',
    'dhcp-management': 'Inspect and manage DHCP leases and scopes',
    'disk-usage': 'Report disk usage across hosts',
    'docker-cleanup': 'Reclaim space by pruning unused Docker resources',
    'docker-status': 'List container status on each host',
    'error-logs': 'Surface recent error log entries',
    'evidence-export': 'Export a signed evidence bundle',
    'fact-check': 'Verify a statement against trusted sources',
    'file-compare': 'Compare two files and report the differences',
    'file-extract': 'Extract structured data from a file',
    'file-summarize': 'Summarise the contents of a file',
    'firewall-check': 'Review firewall rules and exposure',
    'fleet-scan': 'Scan the fleet for status and configuration drift',
    'folder-chat': "Chat grounded in a folder's documents",
    'grafana-alerts': 'List active Grafana alerts',
    'growth-plan': 'Draft a growth plan from current metrics',
    health: 'Overall health summary for this domain',
    'horus-patrol': 'Autonomous security patrol sweep',
    'horus-tour': 'Guided walkthrough of the security posture',
    'host-metrics': 'CPU, memory and load metrics per host',
    'implant-diagnose': "Diagnose a cognitive implant's health",
    'key-rotation': 'Rotate credentials and signing keys',
    'layer-audit': 'Audit the AOCL processing layers',
    'mesh-health-check': 'Check VPN / mesh network health',
    'migration-export': 'Export data for a migration',
    'network-scan': 'Scan the network for hosts and open ports',
    'network-troubleshoot': 'Diagnose a network connectivity problem',
    'posture-check': 'Assess overall security posture',
    'prom-alerts': 'List active Prometheus alerts',
    'prom-targets': 'Report Prometheus scrape-target health',
    'regression-test': 'Run the regression test suite',
    'restore-workflow': 'Restore from a backup snapshot',
    'roadmap-review': 'Review roadmap streams and their status',
    'router-health': 'Check router / RouterOS device health',
    'run-all-tests': 'Run the full test suite',
    'smoke-test': 'Run a quick smoke test of the core paths',
    snapshots: 'List and manage VM / disk snapshots',
    'sprint-planning': 'Plan the next sprint from the backlog',
    'test-category': 'Run tests for a specific category',
    'threat-scan': 'Scan hosts for active threats and intrusions',
    troubleshoot: 'General guided troubleshooting',
    'update-pipeline': 'Review and run the update pipeline',
    'uptime-status': 'Report uptime and probe results',
    'vm-list': 'List virtual machines and their state',
    'web-research': 'Research a topic across the web',
    'youtube-publish': 'Publish or schedule a YouTube video',
}

// Tool description: prefer the live catalog (passed in), then the static
// fallback, then a humanised name. Never echo a bare "Tool: <id>" label.
function toolDescription(t, liveDescs) {
    return (liveDescs && liveDescs[t]) || TOOL_DESCRIPTIONS[t] || humanise(t)
}

function workflowDescription(w) {
    return WORKFLOW_DESCRIPTIONS[w] || humanise(w)
}

// ─── Panel Definitions ───────────────────────────────────────

const PANELS = [
    { id: 'actions', label: 'Actions', icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
    )},
    { id: 'team', label: 'Team', icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
        </svg>
    )},
    { id: 'tools', label: 'Tools', icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
        </svg>
    )},
    { id: 'workflows', label: 'Flows', icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
    )},
]

// ─── Sub-components ──────────────────────────────────────────

function SearchBar({ value, onChange, placeholder }) {
    return (
        <div className="aep-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                style={{ stroke: 'rgba(255,255,255,0.45)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
                type="text"
                placeholder={placeholder}
                value={value}
                onChange={e => onChange(e.target.value)}
            />
            {value && (
                <button className="aep-search__clear" onClick={() => onChange('')} aria-label="Clear search">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2.5, strokeLinecap: 'round' }}>
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            )}
        </div>
    )
}

function ActionsContent({ groups, onAction }) {
    const [search, setSearch] = useState('')
    const lc = search.toLowerCase()

    const filtered = useMemo(() => {
        if (!lc) return groups
        return groups.map(g => ({
            ...g,
            suggestions: g.suggestions.filter(s => s.toLowerCase().includes(lc)),
        })).filter(g => g.suggestions.length > 0)
    }, [groups, lc])

    const total = groups.reduce((n, g) => n + g.suggestions.length, 0)

    return (
        <>
            <SearchBar value={search} onChange={setSearch} placeholder={`Search ${total} actions...`} />
            <div className="aep-scroll">
                {filtered.length === 0 && (
                    <p className="aep-empty">No matching actions</p>
                )}
                {filtered.map(group => (
                    <div key={group.agentId} className="aep-group">
                        <div className="aep-group__label">
                            <span className="aep-dot" style={{ background: group.color }} />
                            <span>{group.agentName}</span>
                        </div>
                        {/* Actions indented under their agent, with a left rail
                            tinted to the agent colour, so the grouping reads. */}
                        <div className="aep-group__actions" style={{ borderColor: `${group.color}33` }}>
                            {group.suggestions.map((s, i) => (
                                <button key={i} className="aep-action" onClick={() => onAction?.(s)} title={s}>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                                        style={{ stroke: group.color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', flexShrink: 0, opacity: 0.5 }}>
                                        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                                    </svg>
                                    <span className="aep-action__text">{s}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </>
    )
}

function TeamContent({ agents, leadName, leadColor, isOrchestrator }) {
    // The "team" is the network the active agent can delegate to. Give it a
    // name (owner ask) + a member count so the tab reads as a roster, and a
    // hover description on each member consistent with the Tools/Flows tabs.
    const teamName = isOrchestrator ? 'Command team' : `${leadName}'s team`
    return (
        <>
            <div className="aep-team-head">
                <span className="aep-dot" style={{ background: leadColor }} />
                <span className="aep-team-head__name">{teamName}</span>
                <span className="aep-team-head__count">{agents.length} specialist{agents.length === 1 ? '' : 's'}</span>
            </div>
            <div className="aep-chips">
                {agents.map(a => (
                    <span
                        key={a.id}
                        className="aep-chip"
                        title={a.domain ? `${a.name} — ${a.domain}` : a.name}
                    >
                        <span className="aep-dot" style={{ background: a.color }} />
                        <span className="aep-chip__name">{a.name}</span>
                        {a.domain && <span className="aep-chip__domain">{a.domain}</span>}
                    </span>
                ))}
            </div>
        </>
    )
}

function ToolsContent({ tools, source, toolDescs }) {
    return (
        <div className="aep-chips">
            {source === 'fallback' && (
                <span style={{ fontSize: 10, opacity: 0.5, width: '100%' }}>Unverified — showing declared tools, collector unreachable</span>
            )}
            {tools.map(t => (
                <span key={t} className="aep-tool" title={toolDescription(t, toolDescs)}>
                    {TOOL_LABELS[t] || humanise(t)}
                </span>
            ))}
        </div>
    )
}

function WorkflowsContent({ workflows }) {
    return (
        <div className="aep-chips">
            {workflows.map(w => (
                <span key={w} className="aep-wf" title={workflowDescription(w)}>{w}</span>
            ))}
        </div>
    )
}

// ─── Main Component ──────────────────────────────────────────

export default function AgentEdgePanels({ assistantId, onQuickAction }) {
    const [activePanel, setActivePanel] = useState(null)

    const toolsTruth = useAgentToolsTruth(assistantId)
    const data = useMemo(() => resolveAgentData(assistantId, toolsTruth), [assistantId, toolsTruth])
    const suggestionGroups = useMemo(() => collectAllSuggestions(assistantId), [assistantId])

    // Live tool descriptions from the collector catalog ({name, description}),
    // so hover text is a real description, not the label echoed back.
    const [toolDescs, setToolDescs] = useState({})
    useEffect(() => {
        let cancelled = false
        getAgentTools(assistantId)
            .then(list => {
                if (cancelled || !Array.isArray(list)) return
                const map = {}
                for (const t of list) { if (t?.name && t?.description) map[t.name] = t.description }
                setToolDescs(map)
            })
            .catch(() => { /* fallback descriptions still apply */ })
        return () => { cancelled = true }
    }, [assistantId])

    const toggle = useCallback((id) => {
        setActivePanel(prev => prev === id ? null : id)
    }, [])

    const close = useCallback(() => setActivePanel(null), [])

    // Determine which panels have content
    const hasActions = suggestionGroups.some(g => g.suggestions.length > 0)
    const hasTeam = data.canDelegateTo.length > 0
    const hasTools = data.tools.length > 0
    const hasWorkflows = data.workflows.length > 0

    const visiblePanels = PANELS.filter(p => {
        if (p.id === 'actions') return hasActions
        if (p.id === 'team') return hasTeam
        if (p.id === 'tools') return hasTools
        if (p.id === 'workflows') return hasWorkflows
        return false
    })

    if (visiblePanels.length === 0) return null

    const activeDef = PANELS.find(p => p.id === activePanel)

    return (
        <>
            {/* Edge button strip */}
            <div className="aep-strip">
                {visiblePanels.map(p => (
                    <button
                        key={p.id}
                        className={`aep-btn ${activePanel === p.id ? 'aep-btn--active' : ''}`}
                        onClick={() => toggle(p.id)}
                        title={p.label}
                        aria-label={`Toggle ${p.label} panel`}
                        style={activePanel === p.id ? { color: data.color, borderColor: `${data.color}40` } : undefined}
                    >
                        {p.icon}
                        <span className="aep-btn__label">{p.label}</span>
                    </button>
                ))}
            </div>

            {/* Slide-out panel overlay */}
            {activePanel && (
                <>
                    <div className="aep-backdrop" onClick={close} />
                    <div className="aep-panel">
                        <div className="aep-panel__header">
                            <span className="aep-panel__title">{activeDef?.label}</span>
                            <button className="aep-panel__close" onClick={close} aria-label="Close panel">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <div className="aep-panel__body">
                            {activePanel === 'actions' && <ActionsContent groups={suggestionGroups} onAction={(s) => { onQuickAction?.(s); close() }} />}
                            {activePanel === 'team' && <TeamContent agents={data.canDelegateTo} leadName={data.name} leadColor={data.color} isOrchestrator={data.isOrchestrator} />}
                            {activePanel === 'tools' && <ToolsContent tools={data.tools} source={data.toolsSource} toolDescs={toolDescs} />}
                            {activePanel === 'workflows' && <WorkflowsContent workflows={data.workflows} />}
                        </div>
                    </div>
                </>
            )}
        </>
    )
}
