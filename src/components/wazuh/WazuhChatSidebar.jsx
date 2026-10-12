/**
 * WazuhChatSidebar — ARGUS, the SIEM Specialist.
 *
 * Sidebar for /wazuh. Wraps AgentChatSidebar with ARGUS context:
 * manager health, agent counts, top alert summary, current tab.
 * V1: conversational and advisory — reads SIEM state, guides triage, explains CVEs.
 * V2 (future): gains destructive actions (deploy/remove agents, active-response) via HITL inbox.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import '../activity/activity-chat.css'
import * as wazuh from '../../services/wazuhClient'

const ARGUS_AGENT = { id: 'argus', name: 'ARGUS', role: 'SIEM Specialist', color: '#ff6b35' }

const TAB_SUGGESTIONS = {
  overview: [
    'All hundred eyes are open — give me a health summary.',
    'Which Wazuh daemons are currently down?',
    'How many agents are disconnected right now?',
    'What does a healthy Wazuh manager look like?',
    'Show me a quick status brief across the entire SIEM fleet.',
  ],
  agents: [
    'Which agents haven\'t reported in the last hour?',
    'Show fleet agent coverage — any hosts without a Wazuh agent?',
    'Walk me through registering a new agent manually.',
    'Why would an agent show "never_connected"?',
    'List agents by status — active, disconnected, pending.',
  ],
  setup: [
    'Walk me through deploying the Wazuh agent to a new host.',
    'What SSH access does bastion need for agent deployment?',
    'Explain the two-hop deployment flow through the bastion.',
    'What happens if agent deployment fails partway through?',
    'How do I bulk-deploy to multiple hosts at once?',
  ],
  alerts: [
    'Triage today\'s alerts — show me the top threats in priority order.',
    'Show me MITRE ATT&CK technique distribution from this week\'s alerts.',
    'Which rule IDs are generating the most noise?',
    'Walk me through reading a rule-level 12 alert.',
    'How do I suppress low-signal alerts without losing visibility?',
  ],
  vulnerabilities: [
    'Prioritise CVEs on this fleet by exploit availability.',
    'Which hosts have critical-severity unpatched CVEs?',
    'Explain the difference between CVSS score and exploit-aware prioritisation.',
    'What packages need patching most urgently?',
    'Walk me through the vulnerability scan workflow for a new host.',
  ],
  fim: [
    'Review the latest FIM changes — any unexpected file modifications?',
    'Show me recent syscheck alerts for system binaries.',
    'How do I distinguish a rootkit indicator from routine file churn?',
    'Walk me through triggering a FIM scan on a specific agent.',
    'What file paths should I add to the monitored list?',
  ],
  sca: [
    'Run an SCA gap report — which CIS controls are failing?',
    'What\'s our current SCA pass rate across the fleet?',
    'Explain why a specific CIS benchmark control is marked as failed.',
    'Which compliance frameworks are covered by the active SCA policies?',
    'How do I remediate a PCI-DSS SCA finding?',
  ],
  compliance: [
    'Run an SCA gap report — which CIS controls are failing?',
    'What\'s our current SCA pass rate across the fleet?',
    'Explain why a specific CIS benchmark control is marked as failed.',
    'Which compliance frameworks are covered by the active SCA policies?',
    'How do I remediate a PCI-DSS SCA finding?',
  ],
}

export function WazuhChatSidebar({ activeTab = 'overview', onClose }) {
  const agent = ARGUS_AGENT

  const buildContext = useCallback(async () => {
    const summary = []
    const evidence = []

    // Overview snapshot (manager + agents)
    let overview = null
    try {
      overview = await wazuh.getOverview()
      if (overview?.manager) {
        summary.push({ label: 'Manager health', value: overview.manager.healthy ? 'Healthy' : 'Daemons down' })
      }
      if (overview?.agents) {
        summary.push({ label: 'Total agents', value: overview.agents.total })
        if (overview.agents.active != null) summary.push({ label: 'Active', value: overview.agents.active })
        if (overview.agents.disconnected != null) summary.push({ label: 'Disconnected', value: overview.agents.disconnected })
        if (overview.agents.neverConnected != null) summary.push({ label: 'Never connected', value: overview.agents.neverConnected })
      }
    } catch { /* backend offline, carry on */ }

    // Top alerts if on alerts tab or as background signal
    try {
      const alertsData = await wazuh.getAlerts({ limit: '5' })
      const alerts = alertsData?.alerts || alertsData?.data?.affected_items || []
      if (alerts.length) {
        summary.push({ label: 'Recent alerts (sample)', value: alerts.length })
        alerts.slice(0, 5).forEach(a => {
          const rule = a.rule?.description || a.description || 'alert'
          const level = a.rule?.level || a.level || '?'
          const agent_name = a.agent?.name || 'unknown'
          evidence.push({ label: `L${level} · ${agent_name}`, text: rule })
        })
      }
    } catch { /* optional */ }

    // Daemons detail when manager is unhealthy
    if (overview?.manager?.daemons && !overview.manager.healthy) {
      const daemons = overview.manager.daemons
      Object.entries(daemons).forEach(([name, status]) => {
        if (status !== 'running') {
          evidence.push({ label: name, text: `status: ${status}` })
        }
      })
    }

    const focus = {
      type: 'Wazuh',
      label: 'SIEM overview',
      detail: `Active tab: ${activeTab}${overview?.agents?.total ? ` · ${overview.agents.total} agents` : ''}`,
    }

    return {
      surface: 'sidebar',
      page: 'Wazuh SIEM',
      panel: `ARGUS SIEM sidebar — ${activeTab} tab`,
      focus,
      summary,
      evidenceTitle: 'SIEM signals',
      evidence,
      instructions: [
        `User is on the ${activeTab} tab of the Wazuh SIEM view. Tailor guidance and suggestions to that tab.`,
        'V1 mode: you cannot directly execute Wazuh actions or modify agent state. Guide the user to the right panel action, or explain how to do it in the Setup/Agents tab.',
        'When triaging alerts, always cite rule level, MITRE technique (if available), and agent name. Prioritise by exploitability, not raw CVSS.',
        'For CVE questions, distinguish exploit-available vulnerabilities from theoretical ones.',
      ],
    }
  }, [activeTab])

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button className="acc-header__agent-btn" style={{ '--agent-color': agent.color }} disabled>
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
      </button>
      <span className="acc-header__role">{agent.role}</span>
      {onClose && (
        <button className="acc-header__close" onClick={onClose} title="Close sidebar">
          <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )

  return (
    <AgentChatSidebar
      agentId="argus"
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={TAB_SUGGESTIONS[activeTab] || TAB_SUGGESTIONS.overview}
      sessionPrefix="WAZUH_ARGUS_CHAT"
      vizStorageKey="wazuh-argus-viz-collapsed"
      placeholder="Ask ARGUS about your SIEM..."
      emptyText="Ask ARGUS about alerts, CVEs, FIM, SCA, or agent health..."
    />
  )
}

export default WazuhChatSidebar
