/**
 * CognitiveTopologyView - Cognitive System Topology
 *
 * Simplified topology page with:
 * - Single file, minimal state
 * - Live data legend + real implant health cards (CoreVisualizer's decorative
 *   canvas hero was removed here per TRUST-GATE 1.18e — it rendered fabricated
 *   Math.sin/Math.random pulse data next to genuinely real health data. It
 *   still exists as a selectable theme in the visualizations-v2 picker.)
 * - Three tabs: Topology, COREY, and Mirror (ArchivistView-style layout)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { getCognitiveData } from '../../services/cognitiveDataCache'
import { getLockedImplants, deriveCoreStatus } from '../../services/cognitiveTopologyService'
import { COGNITIVE_IMPLANTS } from '../../config/cognitiveImplants'
import { getActiveQuoxMindTier, isPluginLicensed } from '../../services/licenseValidator'
import { ChatEngine, ChatInput, VisualizerSection, GlassChatPanel } from '../../components/chat'
import { buildCoreyContext } from '../../services/coreyContext'
import { assistants } from '../../config/assistants'
import { getAgentSuggestions } from '../../config/agentRegistry'
import MirrorTab, { MirrorIcon } from '../../components/topology/MirrorTab'
import './CognitiveTopologyView.css'

// Icons
const TopologyIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="20" cy="12" r="2" />
    <circle cx="12" cy="20" r="2" />
    <circle cx="4" cy="12" r="2" />
    <line x1="12" y1="6" x2="12" y2="9" />
    <line x1="14" y1="12" x2="18" y2="12" />
    <line x1="12" y1="15" x2="12" y2="18" />
    <line x1="6" y1="12" x2="10" y2="12" />
  </svg>
)

const CoreyIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
)

const ChipIcon = ({ color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.5">
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill={color || 'currentColor'} fillOpacity="0.2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" strokeLinecap="round" />
  </svg>
)

const FullscreenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
  </svg>
)

// Format metric values
function formatValue(value, format) {
  if (value === null || value === undefined) return '---'
  switch (format) {
    case 'percent': return `${Math.round(value)}%`
    case 'number': return typeof value === 'number' ? value.toLocaleString() : value
    case 'ratio': return value
    case 'ms': return `${value}ms`
    case 'bytes':
      if (value < 1024) return `${value}B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
      return `${(value / (1024 * 1024)).toFixed(1)}MB`
    case 'timeago':
      if (!value) return 'Never'
      const diff = Date.now() - new Date(value).getTime()
      if (diff < 60000) return 'Just now'
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
      return `${Math.round(diff / 86400000)}d ago`
    default: return String(value)
  }
}

// Get primary value for an implant
function getPrimaryValue(implant, data) {
  const primaryMetric = implant.metrics?.find(m => m.primary)
  if (!primaryMetric || !data) return null
  return { value: data[primaryMetric.key], format: primaryMetric.format }
}

// Implant legend order (matching user's list)
const LEGEND_ORDER = [
  'quox-memory',
  'quox-value',
  'quox-insight',
  'quox-temporal',
  'quox-focus',
  'quox-executive',
  'quox-guard',
  'quox-dream',
  'quox-reflect',
  'quox-learn'
]

/**
 * DataLegend - Shows all implant values next to visualizer
 */
function DataLegend({ data, selectedId, onSelect }) {
  return (
    <div className="ct2-legend">
      <div className="ct2-legend__header">
        <span>Cognitive Implants</span>
      </div>
      <div className="ct2-legend__items">
        {LEGEND_ORDER.map(id => {
          const implant = COGNITIVE_IMPLANTS[id]
          if (!implant) return null
          const primary = getPrimaryValue(implant, data[id])
          const isSelected = selectedId === id

          return (
            <button
              key={id}
              className={`ct2-legend__item ${isSelected ? 'ct2-legend__item--selected' : ''}`}
              onClick={() => onSelect(id)}
              style={{ '--item-color': implant.color }}
            >
              <span className="ct2-legend__dot" />
              <span className="ct2-legend__name">{implant.name}</span>
              <span className="ct2-legend__value">
                {primary ? formatValue(primary.value, primary.format) : '---'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * ImplantChip - Single cognitive implant chip
 */
function ImplantChip({ implant, data, isSelected, onSelect, isLocked }) {
  const primaryMetric = implant.metrics?.find(m => m.primary)
  const value = data?.[primaryMetric?.key]
  const color = implant.color || 'var(--m-accent)'

  return (
    <button
      className={`ct2-chip ${isSelected ? 'ct2-chip--selected' : ''} ${isLocked ? 'ct2-chip--locked' : ''}`}
      style={{ '--chip-color': color, opacity: isLocked ? 0.5 : 1 }}
      onClick={() => onSelect(implant.id)}
    >
      <span className="ct2-chip__icon">
        <ChipIcon color={isLocked ? 'rgba(255,255,255,0.3)' : color} />
      </span>
      <div className="ct2-chip__content">
        <span className="ct2-chip__name">
          {implant.name}
          {isLocked ? (
            <span style={{
              marginLeft: 6, padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700,
              background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase', letterSpacing: 0.5,
            }}>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: 2 }}>
                <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              {implant.tier}
            </span>
          ) : implant.tier && implant.tier !== 'free' ? (
            <span style={{
              marginLeft: 6, padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700,
              background: implant.tier === 'pro' ? 'rgba(245,158,11,0.15)' : 'rgba(168,85,247,0.15)',
              color: implant.tier === 'pro' ? '#f59e0b' : '#a855f7',
              textTransform: 'uppercase', letterSpacing: 0.5,
            }}>{implant.tier}</span>
          ) : null}
        </span>
        <span className="ct2-chip__value">
          {isLocked ? 'Locked' : formatValue(value, primaryMetric?.format)}
        </span>
      </div>
    </button>
  )
}

/**
 * ImplantDetails - Fixed panel showing selected implant details
 */
function ImplantDetails({ implant, data, isLocked, onAskCorey }) {
  if (!implant) {
    return (
      <div className="ct2-details ct2-details--empty">
        <div className="ct2-details__placeholder">
          <ChipIcon />
          <p>Select an implant to see details</p>
        </div>
      </div>
    )
  }

  const primaryMetric = implant.metrics?.find(m => m.primary)
  const secondaryMetrics = implant.metrics?.filter(m => !m.primary) || []
  const color = implant.color || 'var(--m-accent)'
  const tierLabel = implant.tier === 'pro' ? 'QuoxMind Pro' : 'QuoxMind Complete'

  return (
    <div className="ct2-details" style={{ '--detail-color': color }}>
      {isLocked && (
        <div style={{
          padding: '10px 14px', marginBottom: 12, borderRadius: 8,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <span style={{ fontSize: 12, color: '#f59e0b' }}>
            Upgrade to {tierLabel} to activate this implant
          </span>
        </div>
      )}
      <div className="ct2-details__header">
        <span className="ct2-details__icon">
          <ChipIcon color={isLocked ? 'rgba(255,255,255,0.3)' : color} />
        </span>
        <div className="ct2-details__title">
          <h3>{implant.name} Implant</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            {implant.inspiredBy && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                Inspired by the {implant.inspiredBy.toLowerCase()}
              </span>
            )}
            {implant.tier && (
              <span style={{
                padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: implant.tier === 'free' ? 'rgba(34,197,94,0.12)' : implant.tier === 'pro' ? 'rgba(245,158,11,0.12)' : 'rgba(168,85,247,0.12)',
                color: implant.tier === 'free' ? '#22c55e' : implant.tier === 'pro' ? '#f59e0b' : '#a855f7',
                textTransform: 'uppercase', letterSpacing: 0.5,
              }}>{implant.tier === 'free' ? 'Free' : implant.tier === 'pro' ? 'Pro $29' : 'Complete $49'}</span>
            )}
          </div>
        </div>
      </div>

      {primaryMetric && data && (
        <div className="ct2-details__primary">
          <span className="ct2-details__primary-value">
            {formatValue(data[primaryMetric.key], primaryMetric.format)}
          </span>
          <span className="ct2-details__primary-label">{primaryMetric.label}</span>
        </div>
      )}

      {/* QMH-5/2: per-license card copy. Shows what THIS org's tier gets,
          falls back to the generic description when tierBehavior isn't set. */}
      {(() => {
        const activeTier = getActiveQuoxMindTier()
        const tb = implant.tierBehavior
        const tierCopy = tb?.[activeTier] || implant.description
        const upsell = tb?.upsell && activeTier !== 'complete' ? tb.upsell : null
        return (
          <>
            <p className="ct2-details__desc">{tierCopy}</p>
            {upsell && (
              <div style={{
                padding: '8px 12px', marginTop: 8, borderRadius: 6, fontSize: 12,
                background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)',
                color: '#f59e0b',
              }}>
                {upsell}
              </div>
            )}
          </>
        )
      })()}

      {data && secondaryMetrics.length > 0 && (
        <div className="ct2-details__metrics">
          {secondaryMetrics.map(m => {
            // QMH-5/2: a metric flagged with requiresPlugin renders as a
            // license badge instead of an honest-looking zero. The data
            // may legitimately be 0, but for license-blocked metrics the
            // truth is "this is gated", not "you have nothing".
            const metricLocked = m.requiresPlugin && !isPluginLicensed(m.requiresPlugin)
            return (
              <div key={m.key} className="ct2-details__metric">
                <span className="ct2-details__metric-label">{m.label}</span>
                <span className="ct2-details__metric-value">
                  {metricLocked
                    ? <span style={{ color: '#f59e0b' }}>🔒 {m.requiresPlugin === 'quoxmind-pro' ? 'Pro' : 'Complete'}</span>
                    : formatValue(data[m.key], m.format)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Connected implants */}
      {implant.connectedTo && implant.connectedTo.length > 0 && (
        <div className="ct2-details__growth">
          <span className="ct2-details__growth-label">Connected to</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {implant.connectedTo.map(cId => {
              const connected = COGNITIVE_IMPLANTS[cId]
              if (!connected) return null
              return (
                <span key={cId} style={{
                  padding: '3px 8px', borderRadius: 4, fontSize: 11,
                  background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)',
                  cursor: 'pointer',
                }} onClick={() => onAskCorey(`Tell me how ${implant.name} and ${connected.name} work together.`)}>
                  {connected.name}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {implant.howToGrow && (
        <div className="ct2-details__growth">
          <span className="ct2-details__growth-label">How to grow</span>
          <p>{implant.howToGrow}</p>
        </div>
      )}

      {/* Breakdown if available */}
      {implant.breakdown && data && (
        <div className="ct2-details__growth">
          <span className="ct2-details__growth-label">Breakdown</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: 8, marginTop: 4 }}>
            {implant.breakdown.map(b => (
              <div key={b.key} style={{
                padding: '6px 8px', borderRadius: 6, textAlign: 'center',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>
                  {data[b.key] ?? '-'}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{b.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        className="ct2-details__ask"
        onClick={() => onAskCorey(`Tell me about my ${implant.name.toLowerCase()} status and how to improve it.`)}
      >
        <CoreyIcon />
        Ask COREY
      </button>
    </div>
  )
}

/**
 * TopologyTab - Visualizer with legend + Core banner + chips grid + details panel
 */
function TopologyTab({ data, loading, onAskCorey }) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState(null)
  const lockedImplants = getLockedImplants()

  if (loading) {
    return (
      <div className="ct2-loading">
        <div className="ct2-loading__spinner" />
        <p>Initializing cognitive topology...</p>
      </div>
    )
  }

  const coreData = data['quox-sense'] || {}
  // GTM-P2 A5: cold start (fresh org, no data yet) must NOT read as "0% CRITICAL".
  // deriveCoreStatus maps no-data -> 'unknown' (honest), not 'critical'.
  const { status, health: derivedHealth } = deriveCoreStatus(coreData)
  const health = derivedHealth ?? 0
  const implants = Object.values(COGNITIVE_IMPLANTS).filter(i => i.id !== 'quox-sense')
  const selectedImplant = selectedId ? COGNITIVE_IMPLANTS[selectedId] : null
  const isSelectedLocked = selectedId ? lockedImplants.includes(selectedId) : false

  return (
    <div className="ct2-topology">
      {/* Left Column: Legend + Core + Chips */}
      <div className="ct2-topology__main">
        {/* Live Data Legend (real implant values — no decorative visualizer) */}
        <div className="ct2-visualizer-section">
          <DataLegend
            data={data}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {/* Fullscreen Button */}
        <button
          className="ct2-fullscreen-btn"
          onClick={() => navigate('/quoxcore')}
          title="Open QuoxCore fullscreen visualizer"
        >
          <FullscreenIcon />
          <span>Full Screen Visualizer</span>
        </button>

        {/* Core Banner */}
        <div className={`ct2-core ct2-core--${status}`}>
          <div className="ct2-core__icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
          </div>
          <div className="ct2-core__info">
            <h2 className="ct2-core__title">QuoxMind</h2>
            <span className="ct2-core__status">{status.toUpperCase()}</span>
          </div>
          <div className="ct2-core__health">
            <span className="ct2-core__health-value">{Math.round(health)}%</span>
            <span className="ct2-core__health-label">Health</span>
          </div>
          <div className="ct2-core__stats">
            <div className="ct2-core__stat">
              <span>{coreData.activeServices ?? '-'}/{coreData.totalServices ?? '-'}</span>
              <span>Services</span>
            </div>
            <div className="ct2-core__stat">
              <span>{data['quox-executive']?.totalAgents ?? '-'}</span>
              <span>Agents</span>
            </div>
            <div className="ct2-core__stat">
              <span>{data['quox-memory']?.totalMemories ?? '-'}</span>
              <span>Memories</span>
            </div>
          </div>
        </div>

        {/* Implant Chips Grid */}
        <div className="ct2-chips">
          {implants.map(implant => (
            <ImplantChip
              key={implant.id}
              implant={implant}
              data={data[implant.id]}
              isSelected={selectedId === implant.id}
              isLocked={lockedImplants.includes(implant.id)}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      </div>

      {/* Right Sidebar: Details Panel */}
      <div className="ct2-topology__sidebar">
        <ImplantDetails
          implant={selectedImplant}
          data={selectedId ? data[selectedId] : null}
          isLocked={isSelectedLocked}
          onAskCorey={onAskCorey}
        />
      </div>
    </div>
  )
}

/**
 * ChatMessage - Chat message component
 */
function ChatMessage({ message }) {
  const isUser = message.role === 'user'
  const content = message.text || message.content || ''
  const assistantData = assistants.corey || assistants.quox

  return (
    <div className={`ct2-msg ${isUser ? 'ct2-msg--user' : 'ct2-msg--assistant'}`}>
      <div className="ct2-msg__avatar">
        {isUser ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
        ) : (
          <span style={{ color: assistantData?.color || '#00d4aa' }}>C</span>
        )}
      </div>
      <div className="ct2-msg__content">{content}</div>
    </div>
  )
}

/**
 * CoreyTab - Full COREY chat interface (ArchivistView pattern)
 */
function CoreyTab({ pendingQuery, onQueryConsumed, setHalState }) {
  const chatContainerRef = useRef(null)

  const contextBuilder = useCallback(async (query) => {
    return buildCoreyContext(query)
  }, [])

  return (
    <ChatEngine
      agent="corey"
      contextBuilder={contextBuilder}
      sessionPrefix="COREY"
      onStateChange={setHalState}
      enableMemory={true}
    >
      {({ messages, isProcessing, halState, audioData, isMuted, sendMessage, abortMessage, stopAudio, clearConversation, toggleMute }) => {
        // Consume pending query
        if (pendingQuery && sendMessage) {
          setTimeout(() => {
            sendMessage(pendingQuery)
            onQueryConsumed()
          }, 100)
        }

        return (
          <div className="ct2-corey">
            {/* Main Chat Area */}
            <div className="ct2-corey__main">
              {/* Header */}
              <div className="ct2-corey__header">
                <div className="ct2-corey__header-left">
                  <CoreyIcon />
                  <span>COREY</span>
                  <span className="ct2-corey__subtitle">Core Specialist</span>
                </div>
                <div className="ct2-corey__header-right">
                  <button
                    className={`ct2-corey__action ${isMuted ? 'muted' : ''}`}
                    onClick={toggleMute}
                    title={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .46-.04.92-.13 1.36"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                      </svg>
                    )}
                  </button>
                  <button
                    className="ct2-corey__action"
                    onClick={clearConversation}
                    title="Clear chat"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div className="ct2-corey__chat" ref={chatContainerRef}>
                {messages.length === 0 ? (
                  <div className="ct2-corey__welcome">
                    <div className="ct2-corey__welcome-icon">
                      <CoreyIcon />
                    </div>
                    <h2>COREY</h2>
                    <p>Core Specialist - I monitor the cognitive system, implants, and layers.</p>
                    <div className="ct2-corey__suggestions">
                      {getAgentSuggestions('corey', 3).map((suggestion, i) => (
                        <button key={i} onClick={() => sendMessage(suggestion)}>
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((msg, i) => <ChatMessage key={i} message={msg} />)
                )}
                {isProcessing && (
                  <div className="ct2-msg ct2-msg--assistant">
                    <div className="ct2-msg__avatar">
                      <span style={{ color: '#00d4aa' }}>C</span>
                    </div>
                    <div className="ct2-msg__content ct2-msg__typing">
                      <span></span><span></span><span></span>
                    </div>
                  </div>
                )}
              </div>

              {/* Input - Full Width like ArchivistView */}
              <ChatInput
                onSend={sendMessage}
                onStop={abortMessage}
                placeholder="Ask COREY about your cognitive system..."
                isProcessing={isProcessing}
                enableVoice={true}
                className="ct2-corey__input"
              />
            </div>

            {/* Right Sidebar */}
            <div className="ct2-corey__sidebar">
              <VisualizerSection
                agent="corey"
                state={halState}
                audioData={audioData}
                showStatus={true}
                showVoice={true}
                onVoiceTranscription={sendMessage}
                storageKey="corey-visualizer-collapsed"
              />

              {halState === 'speaking' && (
                <div className="ct2-corey__stop">
                  <button onClick={stopAudio}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="6" y="6" width="12" height="12"/>
                    </svg>
                    Stop Audio
                  </button>
                </div>
              )}

              <div className="ct2-corey__section">
                <h4>Quick Actions</h4>
                <div className="ct2-corey__actions">
                  <button onClick={() => sendMessage('What is the current core health status?')} disabled={isProcessing}>
                    Core Health
                  </button>
                  <button onClick={() => sendMessage('Which implants need the most attention?')} disabled={isProcessing}>
                    Weak Implants
                  </button>
                  <button onClick={() => sendMessage('Explain the 5 CORE layers.')} disabled={isProcessing}>
                    Explain Layers
                  </button>
                  <button onClick={() => sendMessage('What can I do to grow my capabilities?')} disabled={isProcessing}>
                    Growth Plan
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }}
    </ChatEngine>
  )
}

/**
 * Main CognitiveTopologyView2 Component
 */
export default function CognitiveTopologyView2() {
  const { setHalState } = useOutletContext() || { setHalState: () => {} }
  // QUOXHAT P1: tabs are hash-addressable (/topology#mirror) so the Mirror —
  // the load-bearing index — is directly linkable from Settings, docs and
  // governed inspection, instead of living only in local click state.
  const VALID_CT_TABS = ['topology', 'corey', 'mirror']
  const initialTab = (() => {
    const hash = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '')
    return VALID_CT_TABS.includes(hash) ? hash : 'topology'
  })()
  const [activeTab, setActiveTab] = useState(initialTab)
  const [data, setData] = useState({})
  const [loading, setLoading] = useState(true)
  const [pendingQuery, setPendingQuery] = useState(null)

  // Data fetch with proper cleanup
  useEffect(() => {
    let cancelled = false

    const fetchData = async () => {
      try {
        const result = await getCognitiveData()
        if (!cancelled && result.data) {
          setData(result.data)
          setLoading(false)
        }
      } catch (err) {
        console.error('Failed to fetch cognitive data:', err)
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 30000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const askCorey = useCallback((query) => {
    setPendingQuery(query)
    setActiveTab('corey')
  }, [])

  return (
    <div className="ct2 view-page">
      {/* Tab Switcher */}
      <div className="ct2-tabs">
        <button
          className={`ct2-tab ${activeTab === 'topology' ? 'ct2-tab--active' : ''}`}
          onClick={() => setActiveTab('topology')}
        >
          <TopologyIcon />
          <span>Topology</span>
        </button>
        <button
          className={`ct2-tab ${activeTab === 'corey' ? 'ct2-tab--active' : ''}`}
          onClick={() => setActiveTab('corey')}
        >
          <CoreyIcon />
          <span>COREY</span>
        </button>
        <button
          className={`ct2-tab ${activeTab === 'mirror' ? 'ct2-tab--active' : ''}`}
          onClick={() => setActiveTab('mirror')}
        >
          <MirrorIcon />
          <span>Mirror</span>
        </button>
      </div>

      {/* Tab Content */}
      <div className="ct2-content">
        {activeTab === 'topology' ? (
          <TopologyTab data={data} loading={loading} onAskCorey={askCorey} />
        ) : activeTab === 'corey' ? (
          <CoreyTab
            pendingQuery={pendingQuery}
            onQueryConsumed={() => setPendingQuery(null)}
            setHalState={setHalState}
          />
        ) : (
          <MirrorTab />
        )}
      </div>
    </div>
  )
}
