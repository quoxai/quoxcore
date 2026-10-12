/** LucidChatSidebar: thin AgentChatSidebar wrapper for the LUCID agent (id `lucid`). */
import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'

export const LUCID_SUGGESTIONS = [
  'What needs me right now?',
  'What changed since I last looked?',
  'What can you not see?',
  'Does anything not add up?',
]

export default function LucidChatSidebar({ onAgentActed, onClose }) {
  const contextBuilder = useCallback(async () => ({
    surface: 'lucid',
    page: '/lucid',
    panel: 'LUCID',
    focus: { type: 'LUCID view', label: 'Situation' },
    summary: [{ label: 'View', value: 'Situation (needs you, doesn\'t add up, since you looked)' }],
    evidenceTitle: 'LUCID state',
    evidence: [],
    instructions: [
      'The user is on the LUCID Situation page. Ground answers in lucid_situation / lucid_item and always say what you cannot see.',
    ],
  }), [])

  const handleAssistantMessage = useCallback(() => { onAgentActed?.() }, [onAgentActed])

  return (
    <AgentChatSidebar
      panel={false}
      agentId="lucid"
      agentName="LUCID"
      agentColor="#38bdf8"
      agentRole="Situational awareness"
      contextBuilder={contextBuilder}
      suggestions={LUCID_SUGGESTIONS}
      sessionPrefix="LUCID"
      placeholder="Ask LUCID what is going on..."
      emptyText="Ask LUCID about the situation..."
      onAssistantMessage={handleAssistantMessage}
      headerExtra={onClose ? (
        <button type="button" className="glass-btn" onClick={onClose} aria-label="Close agent" title="Close agent"
          style={{ display: 'inline-flex', padding: 4 }}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      ) : null}
    />
  )
}
