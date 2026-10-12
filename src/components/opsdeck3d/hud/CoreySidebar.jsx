/**
 * CoreySidebar — COREY Narrator HUD Panel (CC-8)
 *
 * A narrow panel on the right edge of the Cognitive Core 3D view.
 * COREY narrates system events via drip-fed, mood-tagged messages.
 * Self-contained with internal timers — no props needed.
 *
 * COREY is not a chatbot. He is a narrator. There is no input field.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Constants ──────────────────────────────────────────
const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const COREY_COLOR = '#00d4aa'
const GLASS_BG = 'rgba(5, 5, 16, 0.92)'
const SIDEBAR_WIDTH = 240
const COLLAPSED_WIDTH = 32
const MAX_VISIBLE_MESSAGES = 20

// ─── Mood Colours ───────────────────────────────────────
const MOOD_COLORS = {
  calm: '#06b6d4',
  alert: '#f59e0b',
  observant: '#818cf8',
  impressed: '#22c55e',
  philosophical: '#a78bfa',
  worried: '#ef4444',
}

// ─── Startup Messages (minimal — quiet until real events are wired) ──
// Returns messages based on live/offline status and current counts.
function getStartupMessages(isLive, agentCount, implantCount) {
  if (isLive) {
    return [
      { delay: 3000, text: `Connected. ${agentCount} agents, ${implantCount} implants online.`, mood: 'calm' },
      { delay: 8000, text: `Topology scan complete. ${implantCount} implant${implantCount !== 1 ? 's' : ''} monitored, ${agentCount} agent${agentCount !== 1 ? 's' : ''} registered.`, mood: 'impressed' },
      { delay: 13000, text: 'Observing...', mood: 'observant' },
    ]
  }
  return [
    { delay: 3000, text: 'Running on cached data. Live feeds not available.', mood: 'observant' },
    { delay: 8000, text: `Topology snapshot: ${implantCount} implant${implantCount !== 1 ? 's' : ''}, ${agentCount} agent${agentCount !== 1 ? 's' : ''} from last sync.`, mood: 'calm' },
    { delay: 13000, text: 'Observing...', mood: 'calm' },
  ]
}

// ─── Typing Indicator ───────────────────────────────────
function TypingIndicator() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '8px 12px',
    }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5, height: 5, borderRadius: '50%',
            background: COREY_COLOR,
            opacity: 0.7,
            animation: `corey-bounce 1.2s ${i * 0.15}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  )
}

// ─── Single Message ─────────────────────────────────────
function CoreyMessage({ text, mood, timestamp }) {
  const moodColor = MOOD_COLORS[mood] || MOOD_COLORS.calm

  return (
    <div style={{
      padding: '8px 12px',
      borderLeft: `2px solid ${moodColor}`,
      marginLeft: 10,
      marginRight: 10,
      marginBottom: 6,
      animation: 'corey-fade-in 0.4s ease-out',
    }}>
      {/* Timestamp + mood badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 3,
      }}>
        <span style={{
          fontSize: 8, color: 'rgba(255,255,255,0.3)',
          fontFamily: FONT_STACK, letterSpacing: '0.04em',
        }}>
          {timestamp}
        </span>
        <span style={{
          padding: '1px 5px', borderRadius: 3,
          fontSize: 7, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em',
          background: `${moodColor}20`,
          color: moodColor,
          border: `1px solid ${moodColor}30`,
        }}>
          {mood}
        </span>
      </div>
      {/* Content */}
      <div style={{
        fontSize: 10, lineHeight: 1.55,
        color: 'rgba(255,255,255,0.75)',
        fontFamily: FONT_STACK,
        letterSpacing: '0.02em',
      }}>
        {text}
      </div>
    </div>
  )
}

// ─── Collapsed State ────────────────────────────────────
function CollapsedSidebar({ onExpand }) {
  return (
    <div
      onClick={onExpand}
      style={{
        position: 'fixed',
        top: 44,
        right: 0,
        bottom: 60,
        width: COLLAPSED_WIDTH,
        zIndex: 30,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 14,
        gap: 8,
        background: GLASS_BG,
        borderLeft: `1px solid rgba(0, 212, 170, 0.1)`,
        transition: 'width 0.25s ease',
      }}
    >
      {/* Pulsing dot */}
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: COREY_COLOR,
        boxShadow: `0 0 8px ${COREY_COLOR}`,
        animation: 'corey-pulse 2s ease-in-out infinite',
      }} />
      {/* Vertical "COREY" */}
      <span style={{
        writingMode: 'vertical-lr',
        textOrientation: 'mixed',
        fontFamily: FONT_STACK,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.15em',
        color: COREY_COLOR,
        opacity: 0.8,
      }}>
        COREY
      </span>
    </div>
  )
}

// ─── Main Sidebar ───────────────────────────────────────
export default function CoreySidebar({ isLive = false, agentCount = 0, implantCount = 0 }) {
  const [collapsed, setCollapsed] = useState(false)
  const [messages, setMessages] = useState([])
  const [typing, setTyping] = useState(false)
  const scrollRef = useRef(null)
  const timersRef = useRef([])
  const mountTimeRef = useRef(Date.now())

  // Schedule all drip-feed messages on mount
  useEffect(() => {
    mountTimeRef.current = Date.now()

    const resolvedMessages = getStartupMessages(isLive, agentCount, implantCount)

    resolvedMessages.forEach((msg, idx) => {
      // Show typing indicator slightly before message appears
      const typingDelay = msg.delay - (800 + Math.random() * 400)
      const typingTimer = setTimeout(() => {
        setTyping(true)
      }, Math.max(typingDelay, msg.delay - 1000))

      // Show the actual message
      const msgTimer = setTimeout(() => {
        setTyping(false)
        const elapsed = Date.now() - mountTimeRef.current
        const mins = Math.floor(elapsed / 60000)
        const secs = Math.floor((elapsed % 60000) / 1000)
        const timestamp = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`

        setMessages((prev) => {
          const next = [...prev, { id: idx, text: msg.text, mood: msg.mood, timestamp }]
          // Trim to max visible
          if (next.length > MAX_VISIBLE_MESSAGES) {
            return next.slice(next.length - MAX_VISIBLE_MESSAGES)
          }
          return next
        })
      }, msg.delay)

      timersRef.current.push(typingTimer, msgTimer)
    })

    return () => {
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [isLive, agentCount, implantCount])

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, typing])

  const handleCollapse = useCallback(() => setCollapsed(true), [])
  const handleExpand = useCallback(() => setCollapsed(false), [])

  if (collapsed) {
    return <CollapsedSidebar onExpand={handleExpand} />
  }

  return (
    <div style={{
      position: 'fixed',
      top: 44,
      right: 0,
      bottom: 60,
      width: SIDEBAR_WIDTH,
      zIndex: 30,
      display: 'flex',
      flexDirection: 'column',
      background: GLASS_BG,
      borderLeft: `1px solid rgba(0, 212, 170, 0.1)`,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      fontFamily: FONT_STACK,
      transition: 'width 0.25s ease',
    }}>
      {/* Header */}
      <div
        onClick={handleCollapse}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px',
          cursor: 'pointer',
          borderBottom: '1px solid rgba(0, 212, 170, 0.08)',
          flexShrink: 0,
        }}
      >
        {/* Pulsing green dot */}
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: COREY_COLOR,
          boxShadow: `0 0 10px ${COREY_COLOR}`,
          animation: 'corey-pulse 2s ease-in-out infinite',
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: COREY_COLOR,
            letterSpacing: '0.1em',
          }}>
            COREY
          </div>
          <div style={{
            fontSize: 8, color: 'rgba(255,255,255,0.35)',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            core systems
          </div>
        </div>
        {/* Collapse chevron */}
        <span style={{
          fontSize: 10, color: 'rgba(255,255,255,0.3)',
        }}>&#9654;</span>
      </div>

      {/* Message area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        {messages.map((m) => (
          <CoreyMessage
            key={m.id}
            text={m.text}
            mood={m.mood}
            timestamp={m.timestamp}
          />
        ))}
        {typing && <TypingIndicator />}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid rgba(0, 212, 170, 0.06)',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 8, color: 'rgba(255,255,255,0.2)',
          letterSpacing: '0.04em', fontStyle: 'italic',
          lineHeight: 1.4,
        }}>
          COREY observes. COREY speaks. COREY does not ask.
        </div>
      </div>

      {/* Injected CSS keyframes */}
      <style>{`
        @keyframes corey-pulse {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
        @keyframes corey-bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-5px); }
        }
        @keyframes corey-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
