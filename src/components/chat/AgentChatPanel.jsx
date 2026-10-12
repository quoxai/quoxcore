/**
 * AgentChatPanel — Full-featured agent chat panel with multi-conversation support.
 *
 * PSDK-2: Wraps ChatTab with automatic context wiring (auth, workspace, LLM routing).
 * Plugin developers pass agentId + optional context; everything else is automatic.
 *
 * This is the "rich" chat pattern — full markdown, file uploads, AOCL layers,
 * thinking display, voice, image rendering. For lightweight sidebar chat,
 * use AgentChatSidebar instead.
 *
 * Usage:
 *   <AgentChatPanel
 *     agentId="auditus"
 *     additionalContext="Current compliance posture: ..."
 *     collapsed={collapsed}
 *     onToggle={() => setCollapsed(c => !c)}
 *     width={300}
 *   />
 */

import { useRef, useMemo } from 'react'
import ChatTab from './ChatTab'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useLlmRoutingPolicy } from '../../hooks/useLlmRoutingPolicy'
import useLLMStatus from '../../hooks/useLLMStatus'
import { resolveExecutionPlan } from '../../services/executionPlanResolver'
import { getAssistant } from '../../services/entityRegistry'

export function AgentChatPanel({
  agentId,
  agentName,
  agentColor,
  additionalContext,
  collapsed,
  onToggle,
  width = 300,
  headerContent,
  tabId,
  className = '',
}) {
  const { authFetch, user, isAuthenticated } = useAuth()
  const { currentOrg } = useWorkspace()
  const { policy: routingPolicy } = useLlmRoutingPolicy()
  const llmStatus = useLLMStatus()
  const chatRef = useRef(null)
  const orgId = currentOrg?.id

  const assistant = useMemo(() => getAssistant(agentId), [agentId])
  const name = agentName || assistant?.name || agentId?.toUpperCase() || 'Agent'
  const color = agentColor || assistant?.color || '#30ff90'

  const executionPlan = useMemo(() => {
    if (!routingPolicy) return null
    try {
      return resolveExecutionPlan(routingPolicy, { capability: 'general_assistant' })
    } catch { return null }
  }, [routingPolicy])

  // Collapsed state
  if (collapsed) {
    return (
      <div
        onClick={onToggle}
        style={{
          width: 48, height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer',
          backdropFilter: 'var(--glass-blur-strong)',
          WebkitBackdropFilter: 'var(--glass-blur-strong)',
          background: 'linear-gradient(145deg, rgba(255,255,255,0.015), rgba(255,255,255,0.003))',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '12px 0 0 12px',
        }}
      >
        <div style={{
          fontFamily: "'JetBrains Mono','Fira Code',monospace",
          fontSize: 10, fontWeight: 700, color,
          writingMode: 'vertical-rl', letterSpacing: 2,
        }}>
          {name}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`agent-chat-panel ${className}`}
      style={{
        width, display: 'flex', flexDirection: 'column', height: '100%',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '12px 0 0 12px',
        background: 'linear-gradient(145deg, rgba(255,255,255,0.015), rgba(255,255,255,0.003))',
        overflow: 'hidden',
      }}
    >
      {/* Optional custom header */}
      {headerContent && (
        <div style={{ flexShrink: 0 }}>{headerContent}</div>
      )}

      {/* ChatTab — full-featured chat.
          fleet #436: llmProvider must NOT carry a hardcoded default. ChatTab
          feeds it to resolveExecutionPlan as a USER SELECTION, so a default
          fabricates a choice the user never made: hasLlmSelection() turns
          true, the user-override branch runs, and the plan strip then claims
          a provider the request may not actually route to. Undefined lets the
          honest chain (assistant recommendation, then system default) decide,
          matching AuditusSidebar. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <ChatTab
          ref={chatRef}
          tabId={tabId || `${agentId}-panel`}
          assistantId={agentId}
          isActive={true}
          onTabUpdate={() => {}}
          onHalStateChange={() => {}}
          authFetch={authFetch}
          orgId={orgId}
          user={user}
          currentOrg={currentOrg}
          isAuthenticated={isAuthenticated}
          llmProvider={executionPlan?.provider}
          llmModel={executionPlan?.model}
          credentialId={executionPlan?.credentialId}
          executionPlan={executionPlan}
          routingPolicy={routingPolicy}
          llmStatus={llmStatus}
          additionalContext={additionalContext}
        />
      </div>
    </div>
  )
}

export default AgentChatPanel
