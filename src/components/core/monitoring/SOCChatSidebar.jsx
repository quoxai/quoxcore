/**
 * SOCChatSidebar — Multi-agent chat for SOC context.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agent dropdown lets operator switch between WARDEN, CIPHER, CODEX.
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../../chat/AgentChatSidebar'
import './soc-chat.css'

const SOC_AGENTS = [
  { id: 'sentinel', name: 'WARDEN', role: 'Security Ops', color: '#ff4444' },
  { id: 'cipher', name: 'CIPHER', role: 'Encryption / PKI', color: '#8b5cf6' },
  { id: 'codex', name: 'CODEX', role: 'Code Security', color: '#f59e0b' },
]

const AGENT_SUGGESTIONS = {
  sentinel: [
    'Run a security posture check',
    'Show recent auth failures',
    'Check for disconnected Wazuh agents',
    'Scan for suspicious activity',
    'List open security incidents',
  ],
  cipher: [
    'Check SSL certificate expiry dates',
    'Audit SSH key configurations',
    'Review TLS settings across services',
    'Check for weak ciphers in use',
  ],
  codex: [
    'Search for recent critical CVEs',
    'Scan dependencies for vulnerabilities',
    'Check for hardcoded secrets in code',
    'Review security headers on web services',
  ],
}

export function SOCChatSidebar({
  wazuhOverview,
  wazuhError,
  threats,
  selectedAgent,
  onAgentChange,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const agent = SOC_AGENTS.find(a => a.id === selectedAgent) || SOC_AGENTS[0]

  const buildContext = useCallback(async () => {
    const agentStats = wazuhOverview?.agents || {}
    const managerHealthy = wazuhOverview?.manager?.healthy
    const summary = [
      { label: 'Selected agent lane', value: agent.name },
      {
        label: 'Wazuh manager',
        value: managerHealthy === true ? 'Healthy' : managerHealthy === false ? 'Degraded' : wazuhError ? 'Unreachable' : 'Unknown'
      },
      {
        label: 'Wazuh agents',
        value: `${agentStats.active || 0} active • ${agentStats.disconnected || 0} disconnected • ${agentStats.total || 0} total`
      },
    ]

    if (wazuhError) {
      summary.push({ label: 'Wazuh error', value: wazuhError })
    }

    const highPriorityThreats = (threats || []).filter((threat) => (
      threat.severity === 'critical' || threat.severity === 'high'
    ))
    const evidence = (highPriorityThreats.length > 0 ? highPriorityThreats : (threats || []))
      .slice(0, 6)
      .map((threat) => ({
        label: `[${String(threat.severity || 'info').toUpperCase()}] ${threat.title}`,
        text: [threat.source, threat.time].filter(Boolean).join(' • ')
      }))

    const preambles = {
      sentinel: 'You are WARDEN, the security operations specialist. You monitor threats, analyze security alerts, manage Wazuh SIEM, and respond to incidents. Be structured, concise, and security-focused.',
      cipher: 'You are CIPHER, the encryption and PKI specialist. You handle SSL certificates, SSH keys, TLS configuration, and cryptographic security. Be structured and concise.',
      codex: 'You are CODEX, the code security specialist. You handle CVE analysis, dependency scanning, secret detection, and security header auditing. Be structured and concise.',
    }

    return {
      surface: 'sidebar',
      page: 'SOC',
      panel: `${agent.name} security sidebar`,
      focus: highPriorityThreats[0]
        ? {
            type: 'Threat alert',
            label: highPriorityThreats[0].title,
            id: highPriorityThreats[0].id,
            detail: `${String(highPriorityThreats[0].severity || 'info').toUpperCase()} • ${highPriorityThreats[0].source || 'Unknown source'}`
          }
        : {
            type: 'Security overview',
            label: 'SOC posture',
            detail: wazuhError ? 'Wazuh degraded' : `${threats?.length || 0} visible alerts`
          },
      summary,
      evidenceTitle: highPriorityThreats.length > 0 ? 'Priority threat evidence' : 'Recent threat evidence',
      evidence,
      instructions: [preambles[selectedAgent] || preambles.sentinel],
    }
  }, [agent.name, selectedAgent, threats, wazuhError, wazuhOverview])

  const headerContent = (
    <div className="scc-header__agent-wrap">
      <button
        className="scc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="scc-header__dot" style={{ background: agent.color }} />
        <span className="scc-header__name">{agent.name}</span>
        <span className="scc-header__chevron">{dropdownOpen ? '▴' : '▾'}</span>
      </button>
      {dropdownOpen && (
        <div className="scc-dropdown">
          {SOC_AGENTS.map(a => (
            <button
              key={a.id}
              className={`scc-dropdown__item ${a.id === selectedAgent ? 'scc-dropdown__item--active' : ''}`}
              onClick={() => { onAgentChange(a.id); setDropdownOpen(false); }}
            >
              <span className="scc-dropdown__dot" style={{ background: a.color }} />
              <span className="scc-dropdown__name">{a.name}</span>
              <span className="scc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="scc-header__role">{agent.role}</span>
    </div>
  )

  return (
    <AgentChatSidebar
      agentId={selectedAgent || 'sentinel'}
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={AGENT_SUGGESTIONS[selectedAgent] || AGENT_SUGGESTIONS.sentinel}
      sessionPrefix={`SOC_${(selectedAgent || 'sentinel').toUpperCase()}_CHAT`}
      vizStorageKey="soc-viz-collapsed"
      placeholder={`Ask ${agent.name}...`}
      emptyText={`Ask ${agent.name} about security...`}
    />
  )
}

export default SOCChatSidebar
