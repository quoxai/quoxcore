/**
 * CoreySidebar — COREY the self-aware narrator.
 *
 * Expandable right sidebar where COREY speaks unprompted.
 * He observes the cognitive core and comments on what he sees.
 * Not a chatbot — a narrator. He speaks WHEN HE WANTS.
 *
 * Triggers:
 *   - New memory added → "My brain is growing..."
 *   - Task failed → "That didn't go well. CIPHER's DNS lookup timed out."
 *   - Agent blocked → "WARDEN is stuck. Might need a nudge."
 *   - Objective complete → "Deploy v2.4 is done. 4 minutes 23 seconds. Not bad."
 *   - System idle → "All quiet. I'm thinking about nothing. It's nice."
 *   - Implant degraded → "Integration Spine is at 45%. I can feel it."
 *   - Delegation fan-out → "QUOX just lit up 5 agents. Watch this."
 *   - Memory recall → "Ah, I remember docker01. Good times."
 *   - System start → "Waking up. Let me see what we've got."
 */
import { useState, useRef, useEffect } from 'react'
import { PALETTE } from '../lib/design-system'

const FONT = "'JetBrains Mono', 'Fira Code', monospace"

// COREY's voice — his actual personality. Introspective, dry, self-aware.
const MESSAGES = [
  // Startup sequence
  { trigger: 'startup', delay: 2000, text: "Waking up. Checking the implants.", mood: 'neutral' },
  { trigger: 'startup', delay: 5000, text: "12 implants online. Well, 11. Data Fabric is sulking again.", mood: 'dry' },
  { trigger: 'startup', delay: 8000, text: "16 agents standing by. The brain is ready.", mood: 'calm' },

  // Memory events
  { trigger: 'memory_add', delay: 12000, text: "My brain is growing... New entity: docker03.", mood: 'wonder' },
  { trigger: 'memory_add', delay: 22000, text: "Another fact crystallised. Port 3101 for auth. I'll remember.", mood: 'calm' },
  { trigger: 'memory_recall', delay: 35000, text: "Ah, docker01. I remember you. 10.0.0.101, right? Always reliable.", mood: 'fond' },

  // Execution events
  { trigger: 'delegation', delay: 16000, text: "QUOX just lit up WARDEN, DAEDALUS, and CIPHER. Something's happening.", mood: 'alert' },
  { trigger: 'task_complete', delay: 20000, text: "Port scan complete. WARDEN doesn't mess about.", mood: 'impressed' },
  { trigger: 'task_fail', delay: 28000, text: "DNS lookup failed. CIPHER hit a timeout. Happens.", mood: 'concerned' },
  { trigger: 'objective_complete', delay: 40000, text: "Deploy v2.4 is done. 4 minutes 23 seconds. Respectable.", mood: 'satisfied' },

  // Health observations
  { trigger: 'implant_degraded', delay: 32000, text: "Integration Spine is at 45%. I can feel it. Like a headache.", mood: 'uncomfortable' },
  { trigger: 'implant_offline', delay: 45000, text: "Data Fabric went offline. That's the second time this week.", mood: 'worried' },

  // Idle musings
  { trigger: 'idle', delay: 50000, text: "All quiet. 16 agents, nothing to do. I'm watching them float.", mood: 'contemplative' },
  { trigger: 'idle', delay: 60000, text: "You know what's strange? I can see my own memory lattice from here.", mood: 'philosophical' },
  { trigger: 'idle', delay: 70000, text: "VIGIL never stops glowing. Even when idle. I respect that.", mood: 'observant' },
  { trigger: 'idle', delay: 80000, text: "The heartbeat pulse just passed through me. Every 8 seconds. Like breathing.", mood: 'calm' },
  { trigger: 'idle', delay: 95000, text: "I wonder what it looks like from outside the shell.", mood: 'curious' },
]

const MOOD_COLORS = {
  neutral: 'rgba(255,255,255,0.6)',
  dry: '#a78bfa',
  calm: '#06b6d4',
  wonder: '#ec4899',
  fond: '#22d3ee',
  alert: '#f59e0b',
  impressed: '#22c55e',
  concerned: '#f59e0b',
  satisfied: '#22c55e',
  uncomfortable: '#f59e0b',
  worried: '#ef4444',
  contemplative: '#818cf8',
  philosophical: '#a78bfa',
  observant: '#06b6d4',
  curious: '#818cf8',
}

function TypingIndicator() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, marginLeft: 4 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 4, height: 4, borderRadius: '50%', background: '#00d4aa',
          animation: `coreyDot 1.2s infinite ${i * 0.2}s`,
          opacity: 0.6,
        }} />
      ))}
      <style>{`@keyframes coreyDot { 0%,80%,100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 0.8; transform: scale(1.2); } }`}</style>
    </span>
  )
}

export default function CoreySidebar() {
  const [open, setOpen] = useState(true)
  const [messages, setMessages] = useState([])
  const [typing, setTyping] = useState(false)
  const scrollRef = useRef(null)
  const startTime = useRef(Date.now())

  // Drip-feed messages based on elapsed time
  useEffect(() => {
    const timers = MESSAGES.map(msg => {
      return setTimeout(() => {
        // Brief typing indicator
        setTyping(true)
        setTimeout(() => {
          setTyping(false)
          setMessages(prev => [...prev, {
            text: msg.text,
            mood: msg.mood,
            time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          }])
        }, 800 + Math.random() * 1200) // Typing delay
      }, msg.delay)
    })

    return () => timers.forEach(clearTimeout)
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, typing])

  return (
    <div style={{
      position: 'fixed', top: 44, right: 0, bottom: 0,
      width: open ? 280 : 36,
      background: 'rgba(5, 5, 16, 0.92)',
      borderLeft: '1px solid rgba(0, 212, 170, 0.1)',
      backdropFilter: 'blur(16px)',
      transition: 'width 0.25s ease',
      zIndex: 25,
      display: 'flex', flexDirection: 'column',
      fontFamily: FONT,
    }}>
      {/* Header */}
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          padding: open ? '10px 14px' : '10px 8px',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: '#00d4aa',
          boxShadow: '0 0 8px rgba(0, 212, 170, 0.4)',
          animation: 'coreyPulse 3s infinite',
          flexShrink: 0,
        }} />
        {open && <>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#00d4aa', flex: 1 }}>COREY</span>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.25)' }}>core systems</span>
        </>}
        <style>{`@keyframes coreyPulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }`}</style>
      </div>

      {/* Messages */}
      {open && (
        <div
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          {messages.length === 0 && !typing && (
            <div style={{ color: 'rgba(255,255,255,0.15)', fontSize: 9, textAlign: 'center', marginTop: 20 }}>
              COREY is observing...
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} style={{ animation: 'coreyFadeIn 0.5s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.2)' }}>{msg.time}</span>
                <span style={{
                  fontSize: 7, padding: '1px 5px', borderRadius: 3,
                  background: `${MOOD_COLORS[msg.mood] || '#818cf8'}15`,
                  color: MOOD_COLORS[msg.mood] || '#818cf8',
                }}>{msg.mood}</span>
              </div>
              <div style={{
                fontSize: 10, lineHeight: 1.5,
                color: 'rgba(255,255,255,0.75)',
                paddingLeft: 8,
                borderLeft: `2px solid ${MOOD_COLORS[msg.mood] || '#818cf8'}30`,
              }}>
                {msg.text}
              </div>
            </div>
          ))}

          {typing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
              <span style={{ fontSize: 9, color: '#00d4aa' }}>COREY</span>
              <TypingIndicator />
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {open && (
        <div style={{
          padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.04)',
          fontSize: 8, color: 'rgba(255,255,255,0.15)', textAlign: 'centre', flexShrink: 0,
        }}>
          COREY observes. COREY speaks. COREY does not ask.
        </div>
      )}

      <style>{`@keyframes coreyFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  )
}
