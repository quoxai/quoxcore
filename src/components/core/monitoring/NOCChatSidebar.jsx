/**
 * NOCChatSidebar — Multi-agent chat for NOC context.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agent dropdown lets operator switch between DAEDALUS, HYPERION, METRICS, INSIGHT, VIGIL.
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../../chat/AgentChatSidebar'
import RichObjectCard from '../../chat/RichObjectCard'
import { useAuth } from '../../../contexts/AuthContext'
import './noc-chat.css'

const NOC_AGENTS = [
  { id: 'nova', name: 'DAEDALUS', role: 'Fleet / DevOps', color: '#30ff90' },
  { id: 'atlas', name: 'HYPERION', role: 'Proxmox VMs', color: '#ff8c00' },
  { id: 'metrics', name: 'METRICS', role: 'Prometheus', color: '#e6522c' },
  { id: 'insight', name: 'INSIGHT', role: 'Grafana', color: '#f46800' },
  { id: 'beacon', name: 'VIGIL', role: 'Uptime', color: '#10b981' },
]

const AGENT_SUGGESTIONS = {
  nova: [
    'Show fleet health summary',
    'Which hosts are offline?',
    'Run a full health check',
    'Check disk usage across all hosts',
    'List Docker containers on all hosts',
  ],
  atlas: [
    'List all VMs across the cluster',
    'Show Proxmox cluster status',
    'What VMs are running on hyp-01?',
    'Check resource usage on proxmox nodes',
  ],
  metrics: [
    'Show CPU usage trends',
    'Any anomalies detected?',
    'Query memory usage across fleet',
    'Show alerting rules status',
  ],
  insight: [
    'List active Grafana dashboards',
    'Show firing alerts',
    'What dashboards cover networking?',
    'Check Grafana data source health',
  ],
  beacon: [
    'Show uptime summary for all monitors',
    'Any services currently down?',
    'What is the 30-day uptime for quox.ai?',
    'List monitors with degraded response times',
  ],
}

export function NOCChatSidebar({
  hosts,
  pingResults,
  bastionStatus,
  selectedHost,
  selectedAgent,
  onAgentChange,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { authFetch } = useAuth()

  const agent = NOC_AGENTS.find(a => a.id === selectedAgent) || NOC_AGENTS[0]

  // #594: Save/Schedule for NOC results lives in RichObjectCard (noc_check_result
  // type — see RichObjectCard.jsx), not in NOCView. AgentChatSidebar's
  // renderMessageAddon is how sidebars surface it (same pattern as
  // QuartermasterSidebar's renderMessageAddon for SearchResultCards); NOCChatSidebar
  // never wired it, which is why Save/Schedule was unreachable from live NOC chat.
  const renderMessageAddon = useCallback((msg) => {
    if (!msg.richContent) return null
    return <RichObjectCard data={msg.richContent} authFetch={authFetch} />
  }, [authFetch])

  const buildContext = useCallback(async () => {
    const onlineCount = Object.values(pingResults || {}).filter(p => p.reachable).length
    const totalHosts = (hosts || []).length
    const selectedHostId = selectedHost?.id || selectedHost?.host_id || selectedHost?.hostname || null
    const selectedPing = selectedHostId ? pingResults?.[selectedHostId] : null
    const hostSignals = (hosts || [])
      .map((host) => {
        const key = host.id || host.host_id || host.hostname
        const ping = key ? pingResults?.[key] : null
        return { host, ping, key }
      })
      .filter(({ ping }) => ping && (!ping.reachable || ping.latency_ms > 150))
      .slice(0, 6)

    const summary = [
      { label: 'Selected agent lane', value: agent.name },
      { label: 'Bastion', value: bastionStatus?.available ? 'Online' : 'Offline' },
      { label: 'Hosts online', value: `${onlineCount}/${totalHosts}` },
    ]

    if (selectedHost && selectedPing?.latency_ms != null) {
      summary.push({ label: 'Focused host latency', value: `${selectedPing.latency_ms}ms` })
    }

    const evidence = []

    if (selectedHost) {
      evidence.push({
        label: `Focused host ${selectedHostId || 'unknown'}`,
        text: [
          selectedHost.address || selectedHost.ip_address || null,
          selectedHost.group || selectedHost.category || 'other',
          `status ${selectedPing ? (selectedPing.reachable ? 'reachable' : 'offline') : (selectedHost.status || 'unknown')}`,
          selectedPing?.latency_ms != null ? `latency ${selectedPing.latency_ms}ms` : null,
          selectedPing?.error || null,
        ].filter(Boolean).join(' • ')
      })
    }

    hostSignals.forEach(({ host, ping, key }) => {
      evidence.push({
        label: key || host.address || 'Host signal',
        text: [
          host.address || host.ip_address || null,
          host.group || host.category || 'other',
          ping?.reachable ? 'reachable' : 'offline',
          ping?.latency_ms != null ? `latency ${ping.latency_ms}ms` : null,
          ping?.error || null,
        ].filter(Boolean).join(' • ')
      })
    })

    const preambles = {
      nova: 'You are DAEDALUS, the fleet and DevOps specialist. You oversee all infrastructure hosts, Docker containers, and system health. Be structured and concise.',
      atlas: 'You are HYPERION, the Proxmox virtualization specialist. You manage VMs, containers, snapshots, and cluster operations. Be structured and concise.',
      metrics: 'You are METRICS, the Prometheus monitoring specialist. You handle PromQL queries, alerting rules, and performance analysis. Be structured and concise.',
      insight: 'You are INSIGHT, the Grafana visualization specialist. You manage dashboards, alert rules, and data sources. Be structured and concise.',
      beacon: 'You are VIGIL, the uptime monitoring specialist. You track service availability, response times, and SLA compliance. Be structured and concise.',
    }

    return {
      surface: 'sidebar',
      page: 'NOC',
      panel: `${agent.name} operations sidebar`,
      focus: selectedHost
        ? {
            type: 'Host',
            label: selectedHostId,
            id: selectedHostId,
            detail: selectedPing
              ? `${selectedPing.reachable ? 'reachable' : 'offline'}${selectedPing.latency_ms != null ? ` • ${selectedPing.latency_ms}ms` : ''}`
              : (selectedHost.status || 'unknown')
          }
        : {
            type: 'Fleet view',
            label: 'Network operations overview',
            detail: `${onlineCount}/${totalHosts} hosts online`
          },
      summary,
      evidenceTitle: selectedHost ? 'Focused host and fleet signals' : 'Fleet signals',
      evidence,
      instructions: [preambles[selectedAgent] || preambles.nova],
    }
  }, [agent.name, bastionStatus, hosts, pingResults, selectedAgent, selectedHost])

  const headerContent = (
    <div className="ncc-header__agent-wrap">
      <button
        className="ncc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="ncc-header__dot" style={{ background: agent.color }} />
        <span className="ncc-header__name">{agent.name}</span>
        <span className="ncc-header__chevron">{dropdownOpen ? '▴' : '▾'}</span>
      </button>
      {dropdownOpen && (
        <div className="ncc-dropdown">
          {NOC_AGENTS.map(a => (
            <button
              key={a.id}
              className={`ncc-dropdown__item ${a.id === selectedAgent ? 'ncc-dropdown__item--active' : ''}`}
              onClick={() => { onAgentChange(a.id); setDropdownOpen(false); }}
            >
              <span className="ncc-dropdown__dot" style={{ background: a.color }} />
              <span className="ncc-dropdown__name">{a.name}</span>
              <span className="ncc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="ncc-header__role">{agent.role}</span>
    </div>
  )

  return (
    <AgentChatSidebar
      agentId={selectedAgent || 'nova'}
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={AGENT_SUGGESTIONS[selectedAgent] || AGENT_SUGGESTIONS.nova}
      sessionPrefix={`NOC_${(selectedAgent || 'nova').toUpperCase()}_CHAT`}
      vizStorageKey="noc-viz-collapsed"
      placeholder={selectedHost ? `Ask about ${selectedHost.id || selectedHost.hostname}...` : `Ask ${agent.name}...`}
      emptyText={`Ask ${agent.name} about your fleet...`}
      renderMessageAddon={renderMessageAddon}
    />
  )
}

export default NOCChatSidebar
