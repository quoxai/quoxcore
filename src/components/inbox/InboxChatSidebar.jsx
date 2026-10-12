/**
 * InboxChatSidebar — TRIAGE-Q agent chat for HITL Inbox pages.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agents: TRIAGE-Q (default), WARDEN (security items), QUOX (general).
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import '../activity/activity-chat.css'

const INBOX_AGENTS = [
  { id: 'triage-q', name: 'TRIAGE-Q', role: 'Inbox Triage', color: '#8b5cf6' },
  { id: 'sentinel', name: 'WARDEN', role: 'Security Review', color: '#ef4444' },
  { id: 'quox', name: 'CommanderQ', role: 'General', color: '#38bdf8' },
]

const INBOX_SUGGESTIONS = {
  'triage-q': [
    'Summarise my pending items',
    'What needs my attention first?',
    'Any overdue approvals?',
    'Explain this item',
    'What should I approve?',
  ],
  sentinel: [
    'Any security incidents pending?',
    'Review this approval for risk',
    'Check for anomalous patterns',
    'What triggered this alert?',
  ],
  quox: [
    'What actions need my approval?',
    'Show me recent workflow runs',
    'How many items resolved today?',
    'Help me clear my inbox',
  ],
}

export function InboxChatSidebar({
  items,
  selectedItem,
  stats,
  selectedAgent: externalAgent,
  onAgentChange: externalAgentChange,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [internalAgent, setInternalAgent] = useState('triage-q')

  const selectedAgentId = externalAgent || internalAgent
  const onAgentChange = externalAgentChange || setInternalAgent

  const agent = INBOX_AGENTS.find(a => a.id === selectedAgentId) || INBOX_AGENTS[0]

  const buildContext = useCallback(async () => {
    const summary = [
      { label: 'Selected agent lane', value: agent.name },
    ]
    const evidence = []

    if (stats) {
      summary.push({ label: 'Open', value: stats.open || 0 })
      summary.push({ label: 'In progress', value: stats.in_progress || 0 })
      summary.push({ label: 'Total', value: stats.total || 0 })
    }

    if (items && items.length > 0) {
      items.slice(0, 10).forEach(item => {
        const due = item.due_at ? ` [due: ${new Date(item.due_at).toLocaleDateString()}]` : ''
        evidence.push({
          label: item.title,
          text: `${item.kind} • ${item.priority || 'normal'}${due}`
        })
      })
    }

    if (selectedItem) {
      summary.push({ label: 'Focused kind', value: selectedItem.kind })
      summary.push({ label: 'Focused priority', value: selectedItem.priority || 'normal' })
      summary.push({ label: 'Focused status', value: selectedItem.status })
      if (selectedItem.workflow_name) {
        summary.push({ label: 'Workflow', value: selectedItem.workflow_name })
      }
      if (selectedItem.body_md) {
        evidence.unshift({
          label: `Focused item ${selectedItem.title}`,
          text: selectedItem.body_md.replace(/\s+/g, ' ').trim().slice(0, 220)
        })
      }
      if (selectedItem.payload && Object.keys(selectedItem.payload).length > 0) {
        evidence.push({
          label: 'Focused payload',
          text: JSON.stringify(selectedItem.payload).slice(0, 220)
        })
      }
    }

    const preambles = {
      'triage-q': 'You are TRIAGE-Q, the inbox triage specialist. Help the user make fast, informed decisions on their inbox items. Summarise, recommend, and explain. Be concise and decisive.',
      sentinel: 'You are WARDEN, the security specialist. Review inbox items for security implications, risk levels, and compliance. Be precise and flag anything suspicious.',
      quox: 'You are CommanderQ, the orchestrator. Provide high-level guidance on inbox items, pending actions, and workflow status. Be concise.',
    }

    return {
      surface: 'sidebar',
      page: 'Inbox',
      panel: `${agent.name} inbox sidebar`,
      focus: selectedItem
        ? {
            type: 'Inbox item',
            label: selectedItem.title,
            id: selectedItem.id,
            detail: `${selectedItem.kind} • ${selectedItem.status}`
          }
        : {
            type: 'Inbox view',
            label: 'Inbox overview',
            detail: `${items?.length || 0} visible item${(items?.length || 0) === 1 ? '' : 's'}`
          },
      summary,
      evidenceTitle: selectedItem ? 'Focused item and visible inbox items' : 'Visible inbox items',
      evidence,
      instructions: [preambles[selectedAgentId] || preambles['triage-q']],
    }
  }, [agent.name, items, selectedAgentId, selectedItem, stats])

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button
        className="acc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
        <span className="acc-header__chevron">{dropdownOpen ? '\u25B4' : '\u25BE'}</span>
      </button>
      {dropdownOpen && (
        <div className="acc-dropdown">
          {INBOX_AGENTS.map(a => (
            <button
              key={a.id}
              className={`acc-dropdown__item ${a.id === selectedAgentId ? 'acc-dropdown__item--active' : ''}`}
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
    </div>
  )

  return (
    <AgentChatSidebar
      /* The parent <aside> already carries the glass recipe, so the sidebar must not
         add its own or the surface renders glass on glass. */
      panel={false}
      agentId={selectedAgentId || 'triage-q'}
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={INBOX_SUGGESTIONS[selectedAgentId] || INBOX_SUGGESTIONS['triage-q']}
      sessionPrefix={`INBOX_${(selectedAgentId || 'triage-q').toUpperCase()}_CHAT`}
      vizStorageKey="inbox-viz-collapsed"
      placeholder={`Ask ${agent.name} about inbox items...`}
      emptyText={`Ask ${agent.name} about your inbox...`}
    />
  )
}

export default InboxChatSidebar
