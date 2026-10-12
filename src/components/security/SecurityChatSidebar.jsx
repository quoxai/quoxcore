/**
 * SecurityChatSidebar — DRAGO, the QUOX-SECURITY engagement lead.
 *
 * Sidebar for /quox-security. Wraps AgentChatSidebar with DRAGO context:
 * the selected engagement, its targets, its findings, current tab.
 * Same pattern as BastionChatSidebar (JANUS) / WazuhChatSidebar (ARGUS):
 * conversational only, guides the user, does not itself execute tools.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import '../activity/activity-chat.css'
import { useAuth } from '../../contexts/AuthContext'
import { listFindings } from '../../services/securityEngagementClient'

const DRAGO_AGENT = { id: 'security_lead', name: 'DRAGO', role: 'Security Engagement Lead', color: '#c9302c' }

const TAB_SUGGESTIONS = {
  overview: [
    'What is this engagement authorized to do?',
    'Why is our risk ceiling what it is?',
    'Summarise our targets and their verification status',
    'Walk me through creating a new engagement',
  ],
  targets: [
    'Why did my target fail verification?',
    'What is quoxagent_install verification and when do I use it?',
    'Which verification method should I use for a private IP?',
    'Add a domain target and walk me through DNS TXT verification',
  ],
  tools: [
    'What does sectest_inspect_tls actually do?',
    'Why did a tool run fail with "command not found"?',
    'Which tools can I run at my current risk ceiling?',
    'Explain the difference between discovery and safe_active risk',
  ],
  findings: [
    'Summarise open findings for this engagement',
    'Why can\'t I confirm my own finding?',
    'What happens after a finding is confirmed?',
    'Draft a finding description for a closed-port result',
  ],
}

export function SecurityChatSidebar({ activeTab = 'overview', engagement, targets, onClose }) {
  const { authFetch } = useAuth()
  const agent = DRAGO_AGENT

  const buildContext = useCallback(async () => {
    const summary = []
    const evidence = []

    if (engagement) {
      summary.push({ label: 'Engagement', value: engagement.name })
      summary.push({ label: 'Environment', value: engagement.environment_tier })
      summary.push({ label: 'Risk ceiling', value: engagement.risk_ceiling })
      summary.push({ label: 'Status', value: engagement.status })
    }

    if (targets?.length) {
      const verified = targets.filter((t) => t.verification_status === 'verified').length
      summary.push({ label: 'Targets', value: targets.length })
      summary.push({ label: 'Verified', value: verified })
      targets.slice(0, 6).forEach((t) => {
        evidence.push({ label: t.value, text: `${t.type} · ${t.verification_status}` })
      })
    }

    if (engagement) {
      try {
        const findings = await listFindings({ authFetch, engagementId: engagement.id })
        if (findings?.length) {
          summary.push({ label: 'Findings', value: findings.length })
          const candidates = findings.filter((f) => f.status === 'candidate').length
          if (candidates) summary.push({ label: 'Unverified findings', value: candidates })
        }
      } catch { /* optional */ }
    }

    const focus = engagement
      ? {
          type: 'Engagement',
          label: engagement.name,
          id: engagement.id,
          detail: `${engagement.environment_tier} · ${engagement.risk_ceiling} · tab: ${activeTab}`,
        }
      : {
          type: 'QUOX-SECURITY',
          label: 'No engagement selected',
          detail: `Active tab: ${activeTab}`,
        }

    return {
      surface: 'sidebar',
      page: 'QUOX-SECURITY',
      panel: `DRAGO engagement lead sidebar — ${activeTab} tab`,
      focus,
      summary,
      evidenceTitle: 'Target signals',
      evidence,
      instructions: [
        `User is on the ${activeTab} tab of the QUOX-SECURITY view. Tailor guidance to that tab.`,
        'You own scope and risk, not execution: guide the user to the right form or button rather than claiming to run a tool yourself.',
        'Never imply a target is verified or a capability is authorized without checking the actual engagement/target state given above.',
        'If asked about intrusive/credential_sensitive/exploit_emulation capabilities, say plainly that no tool exists at those tiers yet (Phase 4, not built).',
      ],
    }
  }, [activeTab, engagement, targets, authFetch])

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
      /* The parent <aside> already carries the glass recipe, so the sidebar must not
         add its own or the surface renders glass on glass. */
      panel={false}
      agentId="security_lead"
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={TAB_SUGGESTIONS[activeTab] || TAB_SUGGESTIONS.overview}
      sessionPrefix="SECURITY_DRAGO_CHAT"
      vizStorageKey="security-drago-viz-collapsed"
      placeholder="Ask DRAGO about scope, risk, or targets…"
      emptyText="Ask DRAGO about engagements, targets, tools, or findings…"
    />
  )
}

export default SecurityChatSidebar
