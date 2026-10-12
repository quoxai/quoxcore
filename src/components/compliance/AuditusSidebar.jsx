/**
 * AuditusSidebar — Compliance AI Assistant Sidebar
 *
 * CRP-QXFY-3: Glass AUDITUS header + protocol strip + VisualizerSection +
 * quick actions + ChatTab. The ChatTab is constrained to fit the 300px
 * sidebar width with overflow hidden and keyboard hints suppressed.
 */

import { useState, useRef, useCallback, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useLlmRoutingPolicy } from '../../hooks/useLlmRoutingPolicy'
import useLLMStatus from '../../hooks/useLLMStatus'
import { resolveExecutionPlan } from '../../services/executionPlanResolver'
import { getAssistant } from '../../services/entityRegistry'
import { buildAuditusContext } from '../../services/compliance/auditusContext'
import ChatTab from '../chat/ChatTab'
import VisualizerSection from '../chat/sidebar/VisualizerSection'
import { GlassPanel, GlassPill, COLORS, PROTOCOL_COLORS, M, F } from './glass-primitives'

const AUDITUS_TAB_ID = 'auditus-compliance-sidebar'

/* ── Protocol Status Strip ────────────────────────────────────── */

function ProtocolStrip({ protocolHealth }) {
  if (!protocolHealth) return null
  const protocols = [
    { key: 'AEE', data: protocolHealth.AEE },
    { key: 'AOCL', data: protocolHealth.AOCL },
    { key: 'VOLT', data: protocolHealth.VOLT },
    { key: 'WARD', data: protocolHealth.WARD },
  ]
  function dotColor(status) {
    if (status === 'healthy' || status === 'ok' || status === 'active') return COLORS.green
    if (status === 'degraded' || status === 'warn' || status === 'partial') return COLORS.amber
    if (status === 'down' || status === 'fail' || status === 'error') return COLORS.red
    return 'rgba(255,255,255,0.3)'
  }
  return (
    <GlassPanel style={{ padding: '6px 10px', flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {protocols.map(({ key, data }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: dotColor(data?.status),
              boxShadow: data?.status === 'healthy' || data?.status === 'active'
                ? `0 0 6px ${dotColor(data?.status)}60` : 'none',
            }} />
            <span style={{ fontFamily: M, fontSize: 9, fontWeight: 700, color: PROTOCOL_COLORS[key] }}>{key}</span>
            <span style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>
              {(data?.count || 0).toLocaleString()}
            </span>
          </div>
        ))}
        {protocolHealth.WARD?.chainIntact != null && (
          <span style={{
            fontFamily: M, fontSize: 8, fontWeight: 600,
            color: protocolHealth.WARD.chainIntact ? COLORS.green : COLORS.red,
          }}>
            {protocolHealth.WARD.chainIntact ? '✓' : '✗'}
          </span>
        )}
      </div>
    </GlassPanel>
  )
}

/* ── Collapsed Strip ──────────────────────────────────────────── */

function CollapsedStrip({ onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 48, height: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 8, cursor: 'pointer',
        backdropFilter: 'var(--glass-blur-strong)',
        WebkitBackdropFilter: 'var(--glass-blur-strong)',
        background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
        borderTop: '1px solid rgba(255,255,255,0.40)',
        borderLeft: '1px solid rgba(255,255,255,0.31)',
        borderRight: '1px solid transparent',
        borderBottom: '1px solid transparent',
        borderRadius: 12,
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
        background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)',
      }} />
      <span style={{ fontSize: 18, color: COLORS.teal }}>◈</span>
      <span style={{
        fontFamily: M, fontSize: 9, fontWeight: 700, color: '#fff',
        writingMode: 'vertical-lr', letterSpacing: 2,
      }}>
        AUDITUS
      </span>
    </div>
  )
}

/* ── Main Sidebar ─────────────────────────────────────────────── */

export default function AuditusSidebar({
  protocolHealth,
  collapsed,
  onToggleCollapse,
  activeTab = 'posture',
  complianceData = {},
  investigation = null,
}) {
  const { authFetch, isAuthenticated, user } = useAuth()
  const { currentOrg } = useWorkspace()
  const llmRoutingPolicy = useLlmRoutingPolicy(authFetch, currentOrg?.id)
  const llmStatus = useLLMStatus()
  const [halState, setHalState] = useState('idle')
  const chatTabRef = useRef(null)

  const auditusConfig = getAssistant('auditus')
  const auditusLlmPolicy = auditusConfig?.llmPolicy || auditusConfig?.llm || null
  const executionPlan = resolveExecutionPlan({
    policy: llmRoutingPolicy?.policy,
    assistantLlmPolicy: auditusLlmPolicy,
    llmStatus,
  })

  const handleHalStateChange = useCallback((tabId, state) => {
    setHalState(state)
  }, [])

  // Build view-aware context for AUDITUS system prompt
  const auditusContext = useMemo(() =>
    buildAuditusContext(activeTab, complianceData, investigation),
    [activeTab, complianceData, investigation]
  )

  if (collapsed) {
    return <CollapsedStrip onClick={onToggleCollapse} />
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      height: '100%', minHeight: 0, overflow: 'hidden',
    }}>
      {/* AUDITUS Header */}
      <GlassPanel style={{ padding: '8px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, color: COLORS.teal }}>◈</span>
            <div>
              <div style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: '#fff' }}>AUDITUS</div>
              <div style={{ fontFamily: M, fontSize: 8, color: 'rgba(255,255,255,0.6)' }}>Governance Intelligence</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <GlassPill color={COLORS.green} style={{ fontSize: 8 }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', background: COLORS.green }} />
              ACTIVE
            </GlassPill>
            <div
              onClick={onToggleCollapse}
              style={{
                width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.6)', fontSize: 14, fontFamily: M,
              }}
            >
              −
            </div>
          </div>
        </div>
      </GlassPanel>

      {/* Protocol Status Strip */}
      <ProtocolStrip protocolHealth={protocolHealth} />

      {/* Visualizer */}
      <VisualizerSection
        agent="auditus"
        state={halState}
        showStatus={false}
        showVoice={false}
        showControls={false}
        defaultCollapsed={false}
        storageKey="auditus-visualizer-collapsed"
      />

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0, padding: '0 2px' }}>
        {[
          { label: '▣ Report', query: 'Generate a compliance posture report for all active frameworks' },
          { label: '✓ Verify', query: 'Verify the WARD evidence chain integrity' },
          { label: '◈ Schedule', query: 'Schedule a weekly SOC 2 compliance report' },
          { label: '◉ Bundle', query: 'Create a VOLT evidence bundle for the latest run' },
        ].map(action => (
          <GlassPill
            key={action.label}
            color={COLORS.teal}
            style={{
              fontSize: 9, cursor: 'pointer', padding: '4px 8px',
              flex: '1 1 auto', textAlign: 'center', justifyContent: 'center',
            }}
            onClick={() => chatTabRef.current?.sendMessage?.(action.query)}
          >
            {action.label}
          </GlassPill>
        ))}
      </div>

      {/* ChatTab — constrained to sidebar width, keyboard hints hidden via CSS */}
      <div className="auditus-chat-wrapper" style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: 8,
      }}>
        <ChatTab
          ref={chatTabRef}
          tabId={AUDITUS_TAB_ID}
          assistantId="auditus"
          isActive={true}
          onTabUpdate={() => {}}
          onHalStateChange={handleHalStateChange}
          authFetch={authFetch}
          orgId={currentOrg?.id}
          user={user}
          currentOrg={currentOrg}
          isAuthenticated={isAuthenticated}
          llmProvider={executionPlan?.provider}
          llmModel={executionPlan?.model}
          credentialId={null}
          executionPlan={executionPlan}
          routingPolicy={llmRoutingPolicy?.policy}
          llmStatus={llmStatus}
          additionalContext={auditusContext}
        />
      </div>

      {/* Scoped CSS overrides for ChatTab inside 300px sidebar */}
      <style>{`
        /* ── Layout ── */
        .auditus-chat-wrapper .chat-tab-content {
          overflow: hidden;
        }
        .auditus-chat-wrapper .chatgpt-layout__messages {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }

        /* ── Messages: remove 860px max-width, tighten padding ── */
        .auditus-chat-wrapper .chatgpt-layout__messages-inner {
          max-width: 100% !important;
          padding: 8px 8px 16px !important;
          gap: 12px !important;
        }

        /* ── Welcome: compact, no 60vh min-height ── */
        .auditus-chat-wrapper .chatgpt-layout__welcome {
          min-height: auto !important;
          padding: 16px 8px !important;
        }
        .auditus-chat-wrapper .cw-inline-welcome {
          padding: 8px !important;
        }
        .auditus-chat-wrapper .cw-inline-welcome__avatar {
          display: none !important;
        }

        /* ── Input area: full width, tight padding ── */
        .auditus-chat-wrapper .chatgpt-layout__input-area {
          padding: 6px 6px 8px !important;
        }
        .auditus-chat-wrapper .chatgpt-layout__input-form {
          max-width: 100% !important;
          gap: 0 !important;
        }
        .auditus-chat-wrapper .input-container {
          padding: 8px 10px !important;
          gap: 8px !important;
          border-radius: 12px !important;
        }
        .auditus-chat-wrapper .chat-textarea {
          font-size: 13px !important;
        }

        /* ── Hide keyboard hints — too wide for sidebar ── */
        .auditus-chat-wrapper .input-hints {
          display: none !important;
        }

        /* ── Hide edge panels — not useful in sidebar ── */
        .auditus-chat-wrapper .agent-edge-panels {
          display: none !important;
        }

        /* ── Thinking steps: compact in sidebar ── */
        .auditus-chat-wrapper .thinking-steps {
          font-size: 10px !important;
          padding: 4px 8px !important;
        }

        /* ── Message bubbles: no overflow ── */
        .auditus-chat-wrapper .chat-message,
        .auditus-chat-wrapper .message-content {
          max-width: 100% !important;
          overflow-wrap: break-word !important;
          word-break: break-word !important;
        }
        .auditus-chat-wrapper .message-content pre {
          max-width: 100% !important;
          overflow-x: auto !important;
        }
        .auditus-chat-wrapper .message-content table {
          font-size: 10px !important;
          display: block !important;
          overflow-x: auto !important;
        }
      `}</style>
    </div>
  )
}
