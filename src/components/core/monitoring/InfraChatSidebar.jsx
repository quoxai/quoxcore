/**
 * InfraChatSidebar — Multi-agent chat for QuoxAgents page.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agent dropdown lets operator switch between DAEDALUS, WARDEN, CIPHER, BOB.
 *
 * DEVSUITE-HUB Phase 4: BOB (the Dev Suite's own agent) is bound to this
 * exact sidebar rather than a new mechanism. DevServersHubPanel already
 * renders in this same view's centre column (InfraView.jsx), and this
 * sidebar already has the precise "NOCView + Daedalus" shape the plan doc names
 * as precedent — a generic AgentChatSidebar plus an agent-switch dropdown,
 * per-agent suggestions, and a per-agent context builder. Reusing it here
 * means BOB gets that mechanism for free instead of a second one
 * (pluginApi.chat.openSidebar was the other named precedent, but it opens a
 * transient event-driven sidebar elsewhere in the dashboard — this view
 * already has a persistent, purpose-built multi-agent sidebar sitting right
 * next to the panel BOB is meant to observe).
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../../chat/AgentChatSidebar'
import './infra-chat.css'

const INFRA_AGENTS = [
  { id: 'nova', name: 'DAEDALUS', role: 'Fleet / DevOps', color: '#30ff90' },
  { id: 'sentinel', name: 'WARDEN', role: 'Security', color: '#ff4444' },
  { id: 'cipher', name: 'CIPHER', role: 'Network', color: '#38bdf8' },
  { id: 'bob', name: 'BOB', role: 'Dev Suite', color: '#f59e0b' },
]

const AGENT_SUGGESTIONS = {
  nova: [
    'Show fleet health summary',
    'Which agents are offline?',
    'Deploy QuoxAgent to a new host',
    'List all running jobs across the fleet',
    'Check disk usage across all agents',
  ],
  sentinel: [
    'Run security posture check',
    'Show recent security events',
    'Audit firewall rules across hosts',
    'Check for CVE vulnerabilities',
  ],
  cipher: [
    'Check network connectivity between hosts',
    'Test DNS resolution across the fleet',
    'Show network bandwidth usage',
    'Diagnose connectivity to external services',
  ],
  bob: [
    'Did the last dashboard build pass?',
    'Show build history for collector',
    'Verify the collector deploy actually came up',
    'What imports capabilityPanelRegistry.js?',
  ],
}

export function InfraChatSidebar({
  agents,
  fleetSummary,
  selectedAgent: selectedFleetAgent,
  selectedChatAgent,
  onChatAgentChange,
  sendRef,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const chatAgent = INFRA_AGENTS.find(a => a.id === selectedChatAgent) || INFRA_AGENTS[0]

  const buildContext = useCallback(async () => {
    const agentList = agents || []
    const connected = agentList.filter(a => a.status?.connection === 'connected').length
    const total = agentList.length
    const degradedAgents = agentList
      .filter((entry) => entry.status?.connection !== 'connected' || entry.status?.health === 'degraded')
      .slice(0, 6)
    const summary = [
      { label: 'Selected agent lane', value: chatAgent.name },
      { label: 'Fleet connectivity', value: `${connected}/${total} connected` },
    ]

    if (fleetSummary) {
      summary.push({ label: 'Average CPU', value: `${fleetSummary.avg_cpu || 'N/A'}%` })
      summary.push({ label: 'Average memory', value: `${fleetSummary.avg_memory || 'N/A'}%` })
    }

    const evidence = []

    // DEVSUITE-HUB Phase 4: when BOB is the selected chat lane, pull the
    // real build-status snapshot into evidence so BOB's first answer is
    // grounded in what the daemon actually recorded, not just its own tool
    // call mid-conversation. Same collector route BOB's own bob_build_status
    // tool calls (GET /api/v1/build-status) — no new client, no new store.
    if (selectedChatAgent === 'bob') {
      try {
        const res = await fetch(`${window.location.origin}/collector/api/v1/build-status`)
        if (res.ok) {
          const data = await res.json()
          const recent = (data.targets || []).slice(0, 6)
          recent.forEach((t) => {
            evidence.push({
              label: `${t.target} build`,
              text: [`result ${t.result}`, t.message, t.created_at ? new Date(t.created_at).toLocaleString() : null].filter(Boolean).join(' • '),
            })
          })
        }
      } catch {
        // Non-fatal: BOB's own tools can still fetch this mid-conversation.
      }
    }

    if (selectedFleetAgent) {
      const r = selectedFleetAgent.resources || {}
      evidence.push({
        label: `Focused host ${selectedFleetAgent.host_id || selectedFleetAgent.agent?.host_id || 'unknown'}`,
        text: [
          `status ${selectedFleetAgent.status?.connection || 'unknown'}`,
          `health ${selectedFleetAgent.status?.health || 'unknown'}`,
          selectedFleetAgent.ip_address || selectedFleetAgent.agent?.ip_address || null,
          r.cpu_percent != null ? `CPU ${Number(r.cpu_percent).toFixed(1)}%` : null,
          r.memory_percent != null ? `memory ${Number(r.memory_percent).toFixed(1)}%` : null,
          r.disk_percent != null ? `disk ${Number(r.disk_percent).toFixed(1)}%` : null,
          selectedFleetAgent.agent?.version ? `version ${selectedFleetAgent.agent.version}` : null,
        ].filter(Boolean).join(' • ')
      })
    }

    degradedAgents.forEach((entry) => {
      evidence.push({
        label: entry.host_id || entry.agent?.host_id || entry.agent?.hostname || 'Fleet alert',
        text: [
          `status ${entry.status?.connection || 'unknown'}`,
          `health ${entry.status?.health || 'unknown'}`,
          entry.ip_address || entry.agent?.ip_address || null,
        ].filter(Boolean).join(' • ')
      })
    })

    const preambles = {
      nova: 'You are DAEDALUS, the fleet and DevOps specialist for QuoxAgent. You oversee all agents, jobs, playbooks, deployments, and system health. Be structured and concise.',
      sentinel: 'You are WARDEN, the security specialist. You handle SOC events, threat detection, compliance checks, firewall audits, and security posture. Be structured and concise.',
      cipher: 'You are CIPHER, the network specialist. You handle connectivity testing, DNS resolution, bandwidth analysis, routing, and network diagnostics. Be structured and concise.',
      bob: 'You are BOB, the Dev Suite\'s own agent. You answer questions about the DevServersHub build queue: build status/history, log-tail diagnosis (short receipt message only, be honest about the raw-log gap), preflight blast-radius checks, and post-deploy verification. Never call a build green without running bob_verify_deploy first. You are pull-only — never suggest a scheduled/recurring check.',
    }

    return {
      surface: 'sidebar',
      page: 'QuoxAgents',
      panel: `${chatAgent.name} infrastructure sidebar`,
      focus: selectedFleetAgent
        ? {
            type: 'Agent host',
            label: selectedFleetAgent.host_id || selectedFleetAgent.agent?.host_id || 'Unknown host',
            id: selectedFleetAgent.agent?.id || selectedFleetAgent.host_id || null,
            detail: `${selectedFleetAgent.status?.connection || 'unknown'} • ${selectedFleetAgent.status?.health || 'unknown'}`
          }
        : {
            type: 'Fleet view',
            label: 'QuoxAgent fleet overview',
            detail: `${connected}/${total} connected`
          },
      summary,
      evidenceTitle: selectedChatAgent === 'bob' ? 'Recent build receipts' : (selectedFleetAgent ? 'Focused host and fleet signals' : 'Fleet signals'),
      evidence,
      instructions: [preambles[selectedChatAgent] || preambles.nova],
    }
  }, [agents, chatAgent.name, fleetSummary, selectedFleetAgent, selectedChatAgent])

  const headerContent = (
    <div className="ifc-header__agent-wrap">
      <button
        className="ifc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': chatAgent.color }}
      >
        <span className="ifc-header__dot" style={{ background: chatAgent.color }} />
        <span className="ifc-header__name">{chatAgent.name}</span>
        <span className="ifc-header__chevron">{dropdownOpen ? '▴' : '▾'}</span>
      </button>
      {dropdownOpen && (
        <div className="ifc-dropdown">
          {INFRA_AGENTS.map(a => (
            <button
              key={a.id}
              className={`ifc-dropdown__item ${a.id === selectedChatAgent ? 'ifc-dropdown__item--active' : ''}`}
              onClick={() => { onChatAgentChange(a.id); setDropdownOpen(false); }}
            >
              <span className="ifc-dropdown__dot" style={{ background: a.color }} />
              <span className="ifc-dropdown__name">{a.name}</span>
              <span className="ifc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="ifc-header__role">{chatAgent.role}</span>
    </div>
  )

  return (
    <AgentChatSidebar
      agentId={selectedChatAgent || 'nova'}
      agentName={chatAgent.name}
      agentColor={chatAgent.color}
      agentRole={chatAgent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={AGENT_SUGGESTIONS[selectedChatAgent] || AGENT_SUGGESTIONS.nova}
      sessionPrefix={`INFRA_${(selectedChatAgent || 'nova').toUpperCase()}_CHAT`}
      vizStorageKey="infra-viz-collapsed"
      placeholder={selectedFleetAgent ? `Ask about ${selectedFleetAgent.host_id}...` : `Ask ${chatAgent.name}...`}
      emptyText={`Ask ${chatAgent.name} about your agents...`}
      sendRef={sendRef}
    />
  )
}

export default InfraChatSidebar
