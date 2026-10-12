/**
 * ToolsmithChatSidebar — thin AgentChatSidebar wrapper for the Script Forge surface.
 *
 * Follows the Quox convention documented in §3 of STREAM_TOOLSMITH_UX_REDESIGN_PLAN.md:
 * ~80-100 lines, contextBuilder only, pass-through for extraSections/chatHandleRef.
 *
 * extraSections is plumbed but unused in Slice 1; Slices 4-5 will populate Diff
 * and Live Analysis sections without modifying this wrapper.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'

const TOOLSMITH_SUGGESTIONS = [
  'Build me a tool that returns the current time',
  'Add error handling to this script',
  'What permissions should this tool request?',
  'Refactor for clarity',
  'Explain what the pipeline step "analyse" does',
]

export function ToolsmithChatSidebar({
  draftId,
  activeFile,
  files,
  validationState,
  chatHandleRef,
  extraSections,
  activeSection,
  onSectionChange,
  collapsed,
  onToggle,
  renderMessageAddon,
  onAssistantMessage,
  // Auto-apply toggle — when true, proposed patches are applied automatically
  autoApply = false,
  onAutoApplyChange,
}) {
  const contextBuilder = useCallback(async () => {
    return {
      surface: 'sidebar',
      page: '/tools/add?type=script-forge',
      panel: 'Toolsmith — Tool Builder',
      focus: activeFile ? `editing ${activeFile}` : 'no active file',
      summary: draftId
        ? `Draft ID ${draftId} · ${files?.length ?? 0} files · validation ${validationState?.status || 'unknown'}`
        : 'No active draft',
      evidence: {
        draftId,
        activeFile,
        fileNames: (files || []).map(f => f.name).slice(0, 20),
      },
      instructions: 'Help the author build, refactor, and validate Python tools. Stay within the pipeline (validate → analyse → sandbox → install). One clarifying question before coding.',
    }
  }, [draftId, activeFile, files, validationState])

  return (
    <AgentChatSidebar
      agentId="toolsmith"
      agentName="Toolsmith"
      agentColor="#f97316"
      agentRole="Tool Builder"
      contextBuilder={contextBuilder}
      suggestions={TOOLSMITH_SUGGESTIONS}
      sessionPrefix={draftId ? `TOOLSMITH_DRAFT_${draftId}` : 'TOOLSMITH_SIDEBAR'}
      chatHandleRef={chatHandleRef}
      extraSections={extraSections}
      activeSection={activeSection}
      onSectionChange={onSectionChange}
      collapsed={collapsed}
      onToggle={onToggle}
      renderMessageAddon={renderMessageAddon}
      onAssistantMessage={onAssistantMessage}
      headerExtra={onAutoApplyChange ? (
        <button
          data-testid="auto-apply-toggle"
          onClick={() => onAutoApplyChange(!autoApply)}
          title={autoApply ? 'Auto-apply on (click to disable)' : 'Auto-apply off (click to enable)'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: autoApply ? 'rgba(249,115,22,0.15)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${autoApply ? 'rgba(249,115,22,0.4)' : 'rgba(255,255,255,0.12)'}`,
            borderRadius: 5,
            color: autoApply ? '#f97316' : 'rgba(255,255,255,0.4)',
            cursor: 'pointer',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.04em',
            padding: '2px 6px',
            fontFamily: "'JetBrains Mono','Fira Code',monospace",
            flexShrink: 0,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          AUTO
        </button>
      ) : null}
      placeholder="Ask Toolsmith to build, refactor, or explain..."
    />
  )
}

export default ToolsmithChatSidebar
