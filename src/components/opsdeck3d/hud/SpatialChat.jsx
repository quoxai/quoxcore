/**
 * SpatialChat — Chat panel overlay for CC3D.
 *
 * Sends messages to /collector/chat. Displays responses inline.
 * When an agent responds, triggers onAgentSpeak callback with agent ID
 * and message text so the 3D scene can show speech bubbles on nodes.
 *
 * Glass design, compact, slides from right edge.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { getRuntimeAssistantConfig } from '../../../services/entityRegistry'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const GLASS_BG = 'var(--cc3d-glass-bg-heavy, rgba(5, 5, 16, 0.92))'
const BRAND = '#8b5cf6'
const MAX_MESSAGES = 50
const coreyLlm = getRuntimeAssistantConfig('corey')?.llm

export default function SpatialChat({ open, onClose, onAgentSpeak, onNavigate, onCoreyResponse, onTourStart, cc3dContext = {}, initialPrompt = '' }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
      if (initialPrompt) setInput(initialPrompt)
    }
  }, [open, initialPrompt])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return
    const userMsg = input.trim()
    setInput('')
    setMessages(prev => [...prev.slice(-MAX_MESSAGES), { role: 'user', text: userMsg, ts: Date.now() }])
    setLoading(true)

    try {
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'user' ? 'human' : 'assistant',
        content: m.text,
      }))

      // Build context-enriched prompt for COREY
      const contextLines = []
      if (cc3dContext.activeZone) contextLines.push(`User is viewing zone: ${cc3dContext.activeZone}`)
      if (cc3dContext.activeDepth) contextLines.push(`Depth layer: ${cc3dContext.activeDepth}`)
      if (cc3dContext.selectedEntity) contextLines.push(`Selected entity: ${cc3dContext.selectedEntity.name} (${cc3dContext.selectedEntity.type})`)
      if (cc3dContext.anomalyCount > 0) contextLines.push(`Active anomalies: ${cc3dContext.anomalyCount}`)
      if (cc3dContext.agentCount) contextLines.push(`Agents: ${cc3dContext.agentCount}, Implants: ${cc3dContext.implantCount || 0}`)
      const contextBlock = contextLines.length > 0 ? `\n[CC3D Context: ${contextLines.join('. ')}]\n` : ''

      const res = await fetch('/collector/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: contextBlock + userMsg,
          selected_agent: 'corey',
          conversationHistory: history,
          provider: coreyLlm?.provider,
          model: coreyLlm?.model,
          settings: { agentMode: 'corey' },
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const agentId = data.delegated_to || data.agent_id || 'quox'
        const responseText = data.result || 'No response.'

        setMessages(prev => [...prev.slice(-MAX_MESSAGES), {
          role: 'assistant', text: responseText, ts: Date.now(),
          agent: agentId, tools: data.tools_used || [],
        }])

        // Trigger speech bubble on the responding agent's 3D node
        onAgentSpeak?.(agentId, responseText.slice(0, 80))
        // Feed response to CoreyNotifier for toast narration
        onCoreyResponse?.(responseText.slice(0, 120), agentId)

        // Check for spatial navigation hints
        if (userMsg.toLowerCase().includes('show me') || userMsg.toLowerCase().includes('go to')) {
          onNavigate?.(userMsg)
        }

        // Detect tour data in response — GOLDENEYE guided_tour returns stops
        if (data.tools_used?.includes('guided_tour') && responseText.includes('position')) {
          try {
            // Try to extract tour stops from the response text
            const stopsMatch = responseText.match(/\[[\s\S]*?\{[\s\S]*?position[\s\S]*?\}[\s\S]*?\]/)?.[0]
            if (stopsMatch) {
              const stops = JSON.parse(stopsMatch)
              if (Array.isArray(stops) && stops.length > 0 && stops[0].position) {
                onTourStart?.(stops)
              }
            }
          } catch { /* response wasn't parseable tour data — that's fine */ }
        }
        // Also detect tour keywords in plain response
        if (data.tools_used?.includes('guided_tour') && onTourStart) {
          // Tool was called — try to extract from raw tool results if available
          const toolResult = data.tool_results?.find(t => t.name === 'guided_tour')
          if (toolResult?.result?.tour?.stops) {
            onTourStart(toolResult.result.tour.stops)
          }
        }
      } else {
        const status = res.status
        const hint = status === 401 ? ' (auth required — chat needs API key or OAuth)' : ''
        setMessages(prev => [...prev, { role: 'error', text: `Chat failed (${status})${hint}`, ts: Date.now() }])
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', text: `Connection error: ${err.message}`, ts: Date.now() }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, onAgentSpeak, onNavigate])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
    if (e.key === 'Escape') onClose?.()
  }, [sendMessage, onClose])

  if (!open) return null

  return (
    <div style={{
      position: 'fixed', top: 50, right: 52, bottom: 60, width: 320, zIndex: 35,
      background: GLASS_BG, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderRadius: 8, border: `1px solid ${BRAND}25`,
      display: 'flex', flexDirection: 'column', fontFamily: FONT_STACK,
      boxShadow: `0 4px 30px rgba(0,0,0,0.5), 0 0 20px ${BRAND}08`,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: `1px solid ${BRAND}15`,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.7)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          COREY Chat
        </span>
        <span onClick={onClose} style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>&#10005;</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {messages.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, textAlign: 'center', marginTop: 20 }}>
            Ask COREY about the system. Try "health check" or "what agents are active?"
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
          }}>
            {msg.agent && (
              <div style={{ fontSize: 8, color: BRAND, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                {msg.agent}
              </div>
            )}
            <div style={{
              padding: '6px 10px', borderRadius: 6, fontSize: 10, lineHeight: 1.5,
              letterSpacing: '0.02em',
              background: msg.role === 'user' ? `${BRAND}20` : msg.role === 'error' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.04)',
              color: msg.role === 'error' ? '#ef4444' : 'rgba(255,255,255,0.75)',
              border: `1px solid ${msg.role === 'user' ? BRAND + '30' : 'rgba(255,255,255,0.05)'}`,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {msg.text.length > 1500 ? msg.text.slice(0, 1500) + '...' : msg.text}
            </div>
            {msg.tools && msg.tools.length > 0 && (
              <div style={{ fontSize: 8, color: '#22c55e', marginTop: 2 }}>
                Tools: {msg.tools.join(', ')}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: '8px 12px', borderTop: `1px solid ${BRAND}15` }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask COREY..."
          style={{
            width: '100%', padding: '8px 10px', border: `1px solid ${BRAND}20`,
            borderRadius: 4, background: 'rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.85)', fontFamily: FONT_STACK, fontSize: 11,
            outline: 'none', letterSpacing: '0.02em',
          }}
        />
      </div>
    </div>
  )
}
