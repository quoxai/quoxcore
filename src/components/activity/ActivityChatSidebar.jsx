/**
 * ActivityChatSidebar — Multi-agent chat for Activity & Audit context.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agent dropdown: WARDEN (audit/compliance), INSIGHT (pattern analysis), QUOX (general).
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import { summarizeEnvelopeForSidebar } from '../../services/sidebarContext'
import './activity-chat.css'

const ACTIVITY_AGENTS = [
  { id: 'sentinel', name: 'WARDEN', role: 'Audit & Compliance', color: '#ef4444' },
  { id: 'insight', name: 'INSIGHT', role: 'Pattern Analysis', color: '#f46800' },
  { id: 'quox', name: 'CommanderQ', role: 'General', color: '#38bdf8' },
]

const AGENT_SUGGESTIONS = {
  sentinel: [
    'Show recent security events',
    'Any failed auth attempts today?',
    'Audit trail for the last objective run',
    'Which agents triggered the most actions?',
    'Check for anomalous activity patterns',
  ],
  insight: [
    'Summarise today\'s activity',
    'What were the busiest agents this week?',
    'Show conversation volume over time',
    'Any unusual patterns in the audit log?',
  ],
  quox: [
    'What happened in the last hour?',
    'Show me recent objective runs',
    'List all active workflows',
    'What actions need my approval?',
  ],
}

export function ActivityChatSidebar({
  conversations,
  selectedConversation,
  selectedMessages = [],
  filters,
  onClose,
  selectedAgent: externalAgent,
  onAgentChange: externalAgentChange,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [internalAgent, setInternalAgent] = useState('sentinel')

  const selectedAgent = externalAgent || internalAgent
  const onAgentChange = externalAgentChange || setInternalAgent

  const agent = ACTIVITY_AGENTS.find(a => a.id === selectedAgent) || ACTIVITY_AGENTS[0]

  const buildContext = useCallback(async () => {
    const preambles = {
      sentinel: 'You are WARDEN, the security and compliance specialist. You analyse audit trails, detect anomalies, review access patterns, and ensure compliance. Be precise and structured.',
      insight: 'You are INSIGHT, the analytics specialist. You find patterns in activity data, summarise trends, and highlight unusual behaviour. Be concise and data-driven.',
      quox: 'You are CommanderQ, the orchestrator. You provide a high-level view of system activity, recent operations, and pending actions. Be concise.',
    }
    const selectedCorr = selectedConversation?.corr || selectedConversation?.corr_id || selectedConversation?.id || null
    const activeFilters = filters
      ? Object.entries(filters).filter(([, v]) => Boolean(v)).map(([key]) => key)
      : []

    const summary = [
      { label: 'Selected agent lane', value: agent.name },
      { label: 'Loaded conversations', value: conversations?.length || 0 },
      { label: 'Loaded envelopes for focus', value: selectedMessages.length || 0 },
    ]

    if (activeFilters.length > 0) {
      summary.push({ label: 'Active filters', value: activeFilters.join(', ') })
    }
    if (selectedConversation?.agent) {
      summary.push({ label: 'Focused agent', value: selectedConversation.agent })
    }
    if (selectedConversation?.timestamp || selectedConversation?.lastTs) {
      summary.push({
        label: 'Focused time',
        value: new Date(selectedConversation.timestamp || selectedConversation.lastTs).toLocaleString()
      })
    }

    const evidence = selectedMessages
      .slice(-8)
      .map((envelope) => summarizeEnvelopeForSidebar(envelope))
      .filter(Boolean)

    return {
      surface: 'sidebar',
      page: 'Activity Centre',
      panel: `${agent.name} activity sidebar`,
      focus: selectedConversation
        ? {
            type: 'Conversation',
            label: selectedCorr,
            id: selectedCorr,
            detail: `${selectedMessages.length} loaded envelope${selectedMessages.length === 1 ? '' : 's'}`
          }
        : {
            type: 'View',
            label: 'Activity overview',
            detail: 'No conversation selected yet'
          },
      summary,
      evidenceTitle: selectedConversation ? 'Recent envelopes from the selected conversation' : 'Visible page evidence',
      evidence,
      instructions: [preambles[selectedAgent] || preambles.sentinel],
    }
  }, [agent.name, conversations, filters, selectedConversation, selectedMessages, selectedAgent])

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button
        className="acc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
        <span className="acc-header__chevron">{dropdownOpen ? '▴' : '▾'}</span>
      </button>
      {dropdownOpen && (
        <div className="acc-dropdown">
          {ACTIVITY_AGENTS.map(a => (
            <button
              key={a.id}
              className={`acc-dropdown__item ${a.id === selectedAgent ? 'acc-dropdown__item--active' : ''}`}
              onClick={() => { onAgentChange(a.id); setDropdownOpen(false); }}
            >
              <span className="acc-dropdown__dot" style={{ background: a.color }} />
              <span className="acc-dropdown__name">{a.name}</span>
              <span className="acc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="acc-header__role">{agent.role}</span>
      {onClose && (
        <button className="acc-header__close" onClick={onClose} title="Close sidebar">
          <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      )}
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
      sessionPrefix={`ACTIVITY_${(selectedAgent || 'sentinel').toUpperCase()}_CHAT`}
      vizStorageKey="activity-viz-collapsed"
      placeholder={`Ask ${agent.name} about audit activity...`}
      emptyText={`Ask ${agent.name} about activity...`}
    />
  )
}

export default ActivityChatSidebar
