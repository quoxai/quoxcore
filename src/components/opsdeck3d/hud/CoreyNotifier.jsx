/**
 * CoreyNotifier — COREY as a notification popup + slide-out panel.
 *
 * Default: small avatar circle in bottom-right corner.
 * New message: toast notification (auto-dismiss after 5s).
 * Click avatar: slide-out panel with full message history.
 *
 * Replaces the always-open CoreySidebar.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const COREY_COLOR = '#00d4aa'
const GLASS_BG = 'var(--cc3d-glass-bg-heavy, rgba(5, 5, 16, 0.92))'
const PANEL_WIDTH = 240
const TOAST_DURATION = 5000
const MAX_MESSAGES = 30

const MOOD_COLORS = {
  calm: '#06b6d4',
  alert: '#f59e0b',
  observant: '#818cf8',
  impressed: '#22c55e',
  philosophical: '#a78bfa',
  worried: '#ef4444',
}

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

function Toast({ message, onDismiss }) {
  const [opacity, setOpacity] = useState(0)

  useEffect(() => {
    const fadeIn = requestAnimationFrame(() => setOpacity(1))
    const dismiss = setTimeout(() => {
      setOpacity(0)
      setTimeout(() => onDismiss(message.id), 400)
    }, TOAST_DURATION)
    return () => {
      cancelAnimationFrame(fadeIn)
      clearTimeout(dismiss)
    }
  }, [message.id, onDismiss])

  const moodColor = MOOD_COLORS[message.mood] || MOOD_COLORS.calm

  return (
    <div style={{
      padding: '8px 12px',
      background: GLASS_BG,
      border: `1px solid ${moodColor}30`,
      borderLeft: `3px solid ${moodColor}`,
      borderRadius: 4,
      fontFamily: FONT_STACK,
      fontSize: 10,
      lineHeight: 1.5,
      color: 'rgba(255,255,255,0.75)',
      maxWidth: 260,
      opacity,
      transform: opacity === 1 ? 'translateX(0)' : 'translateX(20px)',
      transition: 'all 0.4s ease',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      pointerEvents: 'auto',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: COREY_COLOR, flexShrink: 0,
        }} />
        <span style={{
          fontSize: 9, fontWeight: 700, color: COREY_COLOR,
          letterSpacing: '0.08em',
        }}>COREY</span>
        <span style={{
          fontSize: 7, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto',
        }}>{message.timestamp}</span>
      </div>
      <div>{message.text}</div>
    </div>
  )
}

function PanelMessage({ message }) {
  const moodColor = MOOD_COLORS[message.mood] || MOOD_COLORS.calm

  return (
    <div style={{
      padding: '6px 10px',
      borderLeft: `2px solid ${moodColor}`,
      marginLeft: 8, marginRight: 8, marginBottom: 5,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2,
      }}>
        <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.3)', fontFamily: FONT_STACK }}>
          {message.timestamp}
        </span>
        <span style={{
          padding: '1px 4px', borderRadius: 2,
          fontSize: 7, fontWeight: 600, textTransform: 'uppercase',
          background: `${moodColor}20`, color: moodColor,
        }}>{message.mood}</span>
      </div>
      <div style={{
        fontSize: 10, lineHeight: 1.5, color: 'rgba(255,255,255,0.75)',
        fontFamily: FONT_STACK,
      }}>{message.text}</div>
    </div>
  )
}

export default function CoreyNotifier({ isLive = false, agentCount = 0, implantCount = 0, objectives = [], agents = [], implants = [], systemState = 'idle' }) {
  const [messages, setMessages] = useState([])
  const [toasts, setToasts] = useState([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [hasUnread, setHasUnread] = useState(false)
  const [avatarHovered, setAvatarHovered] = useState(false)
  const timersRef = useRef([])
  const mountTimeRef = useRef(Date.now())
  const nextIdRef = useRef(0)
  const scrollRef = useRef(null)
  const panelRef = useRef(null)
  const prevObjectivesRef = useRef(null)
  const lastNarrationRef = useRef(0)

  const pushMessage = useCallback((text, mood) => {
    const elapsed = Date.now() - mountTimeRef.current
    const mins = Math.floor(elapsed / 60000)
    const secs = Math.floor((elapsed % 60000) / 1000)
    const timestamp = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    const id = nextIdRef.current++

    const msg = { id, text, mood, timestamp }
    setMessages(prev => {
      const next = [...prev, msg]
      return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
    })
    setToasts(prev => [...prev, msg])
    setHasUnread(true)
  }, [])

  // Startup messages
  useEffect(() => {
    mountTimeRef.current = Date.now()
    const resolved = getStartupMessages(isLive, agentCount, implantCount)

    resolved.forEach((msg) => {
      const t = setTimeout(() => pushMessage(msg.text, msg.mood), msg.delay)
      timersRef.current.push(t)
    })

    return () => {
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [isLive, agentCount, implantCount, pushMessage])

  // Real event narration — detect objective/task status changes
  useEffect(() => {
    if (!isLive || !objectives || objectives.length === 0) return
    const now = Date.now()
    // Rate limit: max 1 narration per 15s
    if (now - lastNarrationRef.current < 15000) return

    const prev = prevObjectivesRef.current
    prevObjectivesRef.current = objectives

    if (!prev) return // First load, skip diff

    // Build status maps
    const prevTasks = new Map()
    prev.forEach(o => (o.tasks || []).forEach(t => prevTasks.set(t.id, t.status)))

    for (const obj of objectives) {
      for (const task of (obj.tasks || [])) {
        const oldStatus = prevTasks.get(task.id)
        if (!oldStatus || oldStatus === task.status) continue

        lastNarrationRef.current = now

        if (task.status === 'completed' && oldStatus === 'running') {
          pushMessage(`Task completed: ${task.title || task.id} in "${obj.title}".`, 'impressed')
          return
        }
        if (task.status === 'failed') {
          pushMessage(`Task failed: ${task.title || task.id} in "${obj.title}". Investigating...`, 'worried')
          return
        }
        if (task.status === 'running' && oldStatus === 'pending') {
          pushMessage(`Task started: ${task.title || task.id} in "${obj.title}".`, 'observant')
          return
        }
      }

      // Check objective-level status
      const prevObj = prev.find(p => p.id === obj.id)
      if (prevObj && prevObj.status !== obj.status) {
        lastNarrationRef.current = now
        if (obj.status === 'completed') {
          pushMessage(`Objective completed: "${obj.title}".`, 'impressed')
          return
        }
        if (obj.status === 'failed') {
          pushMessage(`Objective failed: "${obj.title}". Review needed.`, 'alert')
          return
        }
      }
    }

    // Detect new objectives
    const prevIds = new Set(prev.map(o => o.id))
    for (const obj of objectives) {
      if (!prevIds.has(obj.id)) {
        lastNarrationRef.current = now
        pushMessage(`New objective: "${obj.title}".`, 'observant')
        return
      }
    }
  }, [objectives, isLive, pushMessage])

  // Agent state change narration — detect agents going blocked/executing
  const prevAgentsRef = useRef(null)
  useEffect(() => {
    if (!isLive || !agents || agents.length === 0) return
    const now = Date.now()
    if (now - lastNarrationRef.current < 15000) return

    const prev = prevAgentsRef.current
    prevAgentsRef.current = agents
    if (!prev) return

    const prevMap = new Map(prev.map(a => [a.id, a.state]))
    for (const agent of agents) {
      const oldState = prevMap.get(agent.id)
      if (!oldState || oldState === agent.state) continue

      if (agent.state === 'blocked' && oldState !== 'blocked') {
        lastNarrationRef.current = now
        pushMessage(`${agent.name} is blocked. Attention may be needed.`, 'alert')
        return
      }
      if (agent.state === 'executing' && oldState === 'idle') {
        lastNarrationRef.current = now
        pushMessage(`${agent.name} activated — executing.`, 'observant')
        return
      }
    }
  }, [agents, isLive, pushMessage])

  // Implant health degradation narration
  const prevImplantsRef = useRef(null)
  useEffect(() => {
    if (!isLive || !implants || implants.length === 0) return
    const now = Date.now()
    if (now - lastNarrationRef.current < 20000) return

    const prev = prevImplantsRef.current
    prevImplantsRef.current = implants
    if (!prev) return

    const prevMap = new Map(prev.map(i => [i.id, i.health]))
    for (const implant of implants) {
      const oldHealth = prevMap.get(implant.id)
      if (oldHealth == null) continue

      // Alert if health drops below 30% (from above 30%)
      if (implant.health < 30 && oldHealth >= 30) {
        lastNarrationRef.current = now
        pushMessage(`${implant.name} health critical: ${implant.health}%. Diagnostic recommended.`, 'worried')
        return
      }
    }
  }, [implants, isLive, pushMessage])

  // System state change narration
  const prevSystemStateRef = useRef(systemState)
  useEffect(() => {
    if (!isLive) return
    const prev = prevSystemStateRef.current
    prevSystemStateRef.current = systemState
    if (prev === systemState) return
    const now = Date.now()
    if (now - lastNarrationRef.current < 10000) return

    if (systemState === 'alert' && prev !== 'alert') {
      lastNarrationRef.current = now
      pushMessage('System alert detected. Scanning for anomalies.', 'alert')
    } else if (systemState === 'error' && prev !== 'error') {
      lastNarrationRef.current = now
      pushMessage('System error state. Circuit breaker may be open.', 'worried')
    } else if (systemState === 'idle' && prev === 'active') {
      lastNarrationRef.current = now
      pushMessage('All activity completed. System idle.', 'calm')
    }
  }, [systemState, isLive, pushMessage])

  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const togglePanel = useCallback(() => {
    setPanelOpen(prev => {
      if (!prev) setHasUnread(false)
      return !prev
    })
  }, [])

  useEffect(() => {
    if (!panelOpen) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [panelOpen])

  useEffect(() => {
    if (panelOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, panelOpen])

  return (
    <>
      {/* Toast stack */}
      <div style={{
        position: 'fixed',
        bottom: 56,
        right: 12,
        zIndex: 35,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 6,
        pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <Toast key={t.id} message={t} onDismiss={dismissToast} />
        ))}
      </div>

      {/* Avatar button */}
      <div
        onClick={togglePanel}
        onMouseEnter={() => setAvatarHovered(true)}
        onMouseLeave={() => setAvatarHovered(false)}
        style={{
          position: 'fixed',
          bottom: 14,
          right: 14,
          zIndex: 31,
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: panelOpen ? COREY_COLOR : 'rgba(5, 5, 16, 0.9)',
          border: `2px solid ${COREY_COLOR}`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease',
          pointerEvents: 'auto',
        }}
      >
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          fontFamily: FONT_STACK,
          color: panelOpen ? '#050510' : COREY_COLOR,
          letterSpacing: '0.05em',
        }}>C</span>
        {hasUnread && !panelOpen && (
          <span style={{
            position: 'absolute',
            top: -2, right: -2,
            width: 8, height: 8,
            borderRadius: '50%',
            background: '#ef4444',
            border: '1px solid #050510',
          }} />
        )}
        {avatarHovered && !panelOpen && (
          <div style={{
            position: 'absolute', bottom: '100%', right: 0,
            marginBottom: 6, padding: '4px 8px',
            background: 'rgba(5, 5, 16, 0.95)', border: `1px solid ${COREY_COLOR}30`,
            borderRadius: 3, whiteSpace: 'nowrap', fontSize: 9, fontFamily: FONT_STACK,
            letterSpacing: '0.04em', color: 'rgba(255,255,255,0.8)', pointerEvents: 'none', zIndex: 50,
          }}>COREY — Click to open</div>
        )}
      </div>

      {/* Slide-out panel */}
      {panelOpen && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: 44,
            right: 0,
            bottom: 50,
            width: PANEL_WIDTH,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            background: GLASS_BG,
            borderLeft: '1px solid rgba(0, 212, 170, 0.12)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            fontFamily: FONT_STACK,
            pointerEvents: 'auto',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid rgba(0, 212, 170, 0.08)',
            flexShrink: 0,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: COREY_COLOR,
              boxShadow: `0 0 10px ${COREY_COLOR}`,
              flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: COREY_COLOR,
                letterSpacing: '0.1em',
              }}>COREY</div>
              <div style={{
                fontSize: 8, color: 'rgba(255,255,255,0.35)',
                letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>core observer</div>
            </div>
            <span
              onClick={(e) => { e.stopPropagation(); setPanelOpen(false) }}
              style={{
                cursor: 'pointer', fontSize: 12,
                color: 'rgba(255,255,255,0.4)',
              }}
            >{'\u2715'}</span>
          </div>

          <div
            ref={scrollRef}
            style={{
              flex: 1, minHeight: 0, overflowY: 'auto',
              paddingTop: 6, paddingBottom: 6,
            }}
          >
            {messages.length === 0 && (
              <div style={{
                padding: '20px 12px', textAlign: 'center',
                fontSize: 10, color: 'rgba(255,255,255,0.3)',
              }}>Waiting for events...</div>
            )}
            {messages.map(m => (
              <PanelMessage key={m.id} message={m} />
            ))}
          </div>

          <div style={{
            padding: '6px 12px',
            borderTop: '1px solid rgba(0, 212, 170, 0.06)',
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: 8, color: 'rgba(255,255,255,0.2)',
              letterSpacing: '0.04em', fontStyle: 'italic',
            }}>
              COREY observes. COREY speaks. COREY does not ask.
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes corey-pulse {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
      `}</style>
    </>
  )
}
