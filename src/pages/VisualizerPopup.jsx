import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import VisualizerHost from '../components/visualizations-v2/VisualizerHost'
import useQuoxVoiceSession from '../components/quox-voice/useQuoxVoiceSession'
import VoicePopupErrorBoundary from '../components/quox-voice/VoicePopupErrorBoundary'
import { getAssistant, getAllAssistants } from '../config/assistants'
import './visualizer-popup.css'

// Fixed status copy per phase (the authoritative contract — never render
// blank). Some phases append a dynamic suffix computed in the component
// (reconnect attempt count, "taking longer" notice, session duration).
const PHASE_COPY = {
  idle: 'Tap to talk to CommanderQ',
  'requesting-mic': 'Waiting for microphone permission…',
  'error-mic-denied': "Microphone access was blocked. Allow it in your browser's address bar, then retry.",
  connecting: 'Connecting to the voice service…',
  'error-media': 'Connected, but audio could not flow. You may be off the dev network, or a firewall is blocking media.',
  'waiting-for-agent': 'Connected. Waking CommanderQ…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: '',
  reconnecting: 'Connection dropped. Reconnecting…',
  ended: 'Session ended.',
}

const STATE_LABELS = {
  idle: 'Standby',
  'requesting-mic': 'Mic permission',
  'error-mic-denied': 'Mic blocked',
  connecting: 'Connecting',
  'error-media': 'Error',
  'waiting-for-agent': 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  reconnecting: 'Reconnecting',
  ended: 'Ended',
}

const STATE_COLORS = {
  idle: '#ff3d3d',
  'requesting-mic': '#fbbf24',
  'error-mic-denied': '#fbbf24',
  connecting: '#fbbf24',
  'error-media': '#f87171',
  'waiting-for-agent': '#fbbf24',
  listening: '#60a5fa',
  thinking: '#fbbf24',
  speaking: '#34d399',
  reconnecting: '#fbbf24',
  ended: 'rgba(255,255,255,0.6)',
}

// Phases whose visual "eye state" should read as the calmer idle/error look
// rather than a busy in-progress animation.
function eyeStateFor(phase) {
  if (phase === 'error-media' || phase === 'error-mic-denied' || phase === 'ended') return 'error'
  if (phase === 'requesting-mic' || phase === 'connecting' || phase === 'waiting-for-agent' || phase === 'reconnecting') return 'thinking'
  return phase
}

// Best-effort: colour the live tool-activity dot with the delegated
// specialist's brand colour, by matching their shortName/name against the
// tool's detail text (e.g. "Delegating to SENTINEL: scanning fleet").
function specialistColorFromText(text) {
  if (!text) return null
  const lower = text.toLowerCase()
  const match = getAllAssistants().find((a) => {
    const label = (a.shortName || a.name || '').toLowerCase()
    return label && label.length > 1 && lower.includes(label)
  })
  return match?.color || null
}

function DiagnosticsBody({ phase, diag }) {
  const svcKnown = diag.serviceReachable !== null
  const svcOk = diag.serviceReachable === true
  const mediaKnown = diag.mediaOk !== null
  const mediaOk = diag.mediaOk === true
  let cause = 'microphone permission is blocked in the browser.'
  if (phase !== 'error-mic-denied') {
    cause = svcOk
      ? 'you may not be on the dev network, so audio cannot route (a TURN relay is not set up yet).'
      : 'the voice service itself could not be reached.'
  }
  return (
    <div className="qx-disclosure__body qx-stack" style={{ gap: 8 }}>
      <div className="qx-row" style={{ gap: 8, alignItems: 'center' }}>
        <span className={`qx-dot ${!svcKnown ? 'qx-dot--idle' : svcOk ? 'qx-dot--online' : 'qx-dot--offline'}`} />
        <span>Voice service reachable: {!svcKnown ? 'not tested' : svcOk ? 'yes' : 'no'}</span>
      </div>
      <div className="qx-row" style={{ gap: 8, alignItems: 'center' }}>
        <span className={`qx-dot ${!mediaKnown ? 'qx-dot--idle' : mediaOk ? 'qx-dot--online' : 'qx-dot--offline'}`} />
        <span>Media path (WebRTC): {!mediaKnown ? 'not tested' : mediaOk ? 'ok' : 'failed'}</span>
      </div>
      <div className="qx-row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="qx-dot qx-dot--degraded" />
        <span>Likely cause: {cause}</span>
      </div>
    </div>
  )
}

// A 5-segment mic-level meter driven by input RMS. Updates the DOM directly
// via rAF + refs — NOT React state — so a busy conversation never forces a
// re-render just to redraw a meter.
function MicLevelMeter({ micAnalyserRef, active }) {
  const wrapRef = useRef(null)
  const rafRef = useRef(null)
  const bufRef = useRef(null)

  useEffect(() => {
    if (!active) return undefined
    const tick = () => {
      const an = micAnalyserRef.current
      const wrap = wrapRef.current
      if (an && wrap) {
        if (!bufRef.current || bufRef.current.length !== an.fftSize) {
          bufRef.current = new Uint8Array(an.fftSize)
        }
        an.getByteTimeDomainData(bufRef.current)
        let sum = 0
        for (let i = 0; i < bufRef.current.length; i++) {
          const v = (bufRef.current[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / bufRef.current.length)
        const lit = Math.min(5, Math.round(rms * 5 * 4))
        const kids = wrap.children
        for (let i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('popup-mic-meter__seg--lit', i < lit)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [active, micAnalyserRef])

  return (
    <div className="popup-mic-meter" ref={wrapRef} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <span key={i} className="popup-mic-meter__seg" />)}
    </div>
  )
}

function VisualizerPopupCrashCard() {
  return (
    <div className="visualizer-popup">
      <div className="popup-overlay">
        <div className="qx-card popup-error-card">
          <div className="qx-row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span className="qx-dot qx-dot--degraded" style={{ marginTop: 6 }} />
            <p style={{ margin: 0, color: '#fff' }}>
              Something went wrong rendering this popout. Reload the window to try again.
            </p>
          </div>
          <div className="qx-row" style={{ gap: 8, marginTop: 16 }}>
            <button className="qx-btn qx-btn--primary" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * VisualizerPopup — the hands-free voice + visual surface ("Jarvis screen").
 *
 * A detachable, central-visualiser popup built for a rack monitor / external
 * display. The eye IS the interface: you tap once to start, then it's a
 * continuous, interruptible conversation with CommanderQ over the governed
 * realtime stack (shared engine: useQuoxVoiceSession). Q answers with real
 * governed tools; the eye reacts to the live audio. No chat log, no typing —
 * a hands-free voice-and-visual thing.
 *
 * Rebuilt 2026-09-25: every connection/failure phase now renders explicit
 * status copy and at least one action — a media-signalling-succeeds-but-
 * audio-never-flows failure (off the dev LAN, no TURN) used to leave this
 * page looking dead. See useQuoxVoiceSession for the detection rules.
 */
function VisualizerPopupInner() {
  const [searchParams] = useSearchParams()
  const assistantId = searchParams.get('assistant') || 'quox'
  const initialState = searchParams.get('state') || 'idle'

  // Resolve identity BEFORE the session so the voice front is served AS this
  // agent (agent_name/role flow to the worker) and the copy names it, not
  // CommanderQ (owner bug 2026-09-29: voice on every agent page said CommanderQ).
  const assistant = getAssistant(assistantId)
  const agentColor = assistant?.color || '#38bdf8'
  const agentLabel = assistant?.name || 'CommanderQ'

  const {
    phase, phaseSince, statusMsg, segments, toolEvents, live, muted,
    reconnectAttempt, reconnectMax, diag, sessionDurationLabel,
    start, stop, cancel, reconnectNow, toggleMute, sampleFrequency,
    micAnalyserRef,
  } = useQuoxVoiceSession({
    agentId: assistantId, agentName: assistant?.name, agentRole: assistant?.specialty,
    nativeTools: true, analyse: true,
  })

  // Per-render phase copy: the two agent-identifying lines name the served
  // agent; all other phases are identity-neutral and come straight from the
  // module constant.
  const phaseCopy = useMemo(() => ({
    ...PHASE_COPY,
    idle: `Tap to talk to ${agentLabel}`,
    'waiting-for-agent': `Connected. Waking ${agentLabel}…`,
  }), [agentLabel])

  // Local audio (this popup's own session) vs mirrored state from the main
  // dashboard window (detached-display case, when no local session is running).
  const [localAudio, setLocalAudio] = useState(null)
  const [remoteState, setRemoteState] = useState(initialState)
  const [remoteAudio, setRemoteAudio] = useState(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [kebabOpen, setKebabOpen] = useState(false)
  const [waitingLong, setWaitingLong] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const containerRef = useRef(null)
  const hideTimeoutRef = useRef(null)
  const channelRef = useRef(null)
  const rafRef = useRef(null)
  const freqBufRef = useRef(null)

  // The eye's state: a live local session wins; otherwise mirror the main
  // window (or the initial ?state= for a cold-opened display).
  const effectiveState = live ? eyeStateFor(phase) : (remoteState || 'idle')
  const audioData = live ? localAudio : remoteAudio

  const currentLabel = STATE_LABELS[phase] || 'Standby'
  const currentColor = STATE_COLORS[phase] || '#ff3d3d'

  // Retry/reconnect buttons unmount their own card the instant phase moves
  // on; this just gives the click a visible beat before that happens.
  useEffect(() => { if (phase !== 'error-media' && phase !== 'error-mic-denied') setRetrying(false) }, [phase])

  // "Taking longer than usual" — only meaningful while waiting-for-agent.
  useEffect(() => {
    if (phase !== 'waiting-for-agent') { setWaitingLong(false); return undefined }
    setWaitingLong(false)
    const t = setInterval(() => {
      if (Date.now() - phaseSince > 8000) setWaitingLong(true)
    }, 1000)
    return () => clearInterval(t)
  }, [phase, phaseSince])

  // BroadcastChannel: keep the visualiser customisation live (refresh) and
  // mirror the main window's state when we don't have our own session.
  useEffect(() => {
    try {
      channelRef.current = new BroadcastChannel('quox-visualizer-sync')
    } catch (e) {
      console.warn('[VisualizerPopup] BroadcastChannel not supported:', e)
      return undefined
    }
    channelRef.current.onmessage = (event) => {
      const { type, payload } = event.data || {}
      if (type === 'state') {
        if (payload?.halState) setRemoteState(payload.halState)
        if (payload?.audioData) setRemoteAudio(payload.audioData)
      } else if (type === 'refresh') {
        setRefreshKey((k) => k + 1)
      }
    }
    channelRef.current.postMessage({ type: 'request-state' })
    const heartbeat = setInterval(() => {
      channelRef.current?.postMessage({ type: 'request-state' })
    }, 10000)
    return () => { clearInterval(heartbeat); channelRef.current?.close() }
  }, [])

  // Drive the eye from THIS popup's live audio while a session is up.
  useEffect(() => {
    if (!live) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      setLocalAudio(null)
      return undefined
    }
    // Throttle the audio state to ~30fps. setLocalAudio re-renders the WHOLE
    // popup (captions, panels, eye), so sampling every animation frame (~60fps)
    // was double the needed re-renders and read as flicker while talking. The
    // eye animates fine at 30fps; halving the render churn kills the flicker.
    let lastPush = 0
    const tick = (ts) => {
      if (ts - lastPush >= 33) {
        const arr = sampleFrequency(freqBufRef.current)
        if (arr) { freqBufRef.current = arr; setLocalAudio(Array.from(arr)); lastPush = ts }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [live, sampleFrequency])

  // Fullscreen tracking
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) await containerRef.current?.requestFullscreen()
      else await document.exitFullscreen()
    } catch (err) { console.error('Fullscreen error:', err) }
  }, [])

  // Auto-hide controls in fullscreen after inactivity.
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimeoutRef.current)
    hideTimeoutRef.current = setTimeout(() => {
      if (document.fullscreenElement) setShowControls(false)
    }, 3000)
  }, [])
  useEffect(() => {
    const onMove = () => resetHideTimer()
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [resetHideTimer])

  const handleClose = useCallback(() => {
    try { window.close() } catch { /* not opened via script */ }
    // Fallback if the window refuses to close (opened as a normal tab): drop
    // back to idle rather than leaving the operator stuck on a dead card.
    setTimeout(() => cancel(), 250)
  }, [cancel])

  const handleRetry = useCallback(() => { setRetrying(true); start() }, [start])

  // Keyboard: F = fullscreen, Space = start / mute-toggle (hands-free, NOT
  // push-to-talk), Esc = close.
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return
      if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
        e.preventDefault(); toggleFullscreen()
      } else if (e.code === 'Space') {
        e.preventDefault()
        if (phase === 'idle') start()
        else if (['listening', 'thinking', 'speaking', 'waiting-for-agent', 'reconnecting'].includes(phase)) toggleMute()
      } else if (e.key === 'Escape' && !document.fullscreenElement) {
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, start, toggleMute, toggleFullscreen, handleClose])

  // A single, subtle live caption — the latest thing said, either side. Not a
  // scrollable log: this is a voice surface, the transcript is ambient.
  // Stays visible through `thinking` (no new segment yet), fades only once a
  // fresh one lands. Interim text reads dimmer than a solidified final line.
  const caption = useMemo(() => {
    const last = segments[segments.length - 1]
    if (live && last && last.text.trim()) {
      return { who: last.who, text: last.text, final: !!last.final }
    }
    return null
  }, [segments, live])

  const latestTool = toolEvents.length ? toolEvents[toolEvents.length - 1] : null
  const toolText = latestTool ? (latestTool.detail || latestTool.name) : null
  const toolColor = specialistColorFromText(toolText) || '#6ab7ff'

  const clickEye = () => { if (phase === 'idle') start() }

  const showConnectingHint = ['requesting-mic', 'connecting', 'waiting-for-agent'].includes(phase)
  const showConnectRing = phase === 'connecting' || phase === 'reconnecting'
  const micMeterActive = phase === 'listening' || phase === 'speaking'

  return (
    <div
      ref={containerRef}
      className={`visualizer-popup ${isFullscreen ? 'fullscreen' : ''} ${live ? 'live' : ''} popup-phase--${phase}`}
      onMouseMove={resetHideTimer}
    >
      {/* Phone-only persistent state line — panels collapse below 600px, this
          never does, so no phone view is ever blank. */}
      <div className="popup-statusline">
        <span className="qx-dot" style={{ '--qx-dot-color': currentColor }} />
        <span className="popup-statusline__text">{phaseCopy[phase] || currentLabel}</span>
      </div>

      {/* Non-modal reconnect banner — eye stays visible underneath. */}
      {phase === 'reconnecting' && (
        <div className="qx-banner qx-banner--warn popup-reconnect-banner">
          <span className="qx-banner__icon"><span className="qx-dot qx-dot--degraded" /></span>
          <span>Connection dropped. Reconnecting… (attempt {Math.min(reconnectAttempt, reconnectMax)} of {reconnectMax})</span>
          <span className="qx-banner__actions">
            <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={reconnectNow}>Reconnect now</button>
            <button className="qx-btn qx-btn--sm qx-btn--danger" onClick={stop}>End</button>
          </span>
        </div>
      )}

      <div className="popup-layout">
        {/* Left — agent identity + live state */}
        <div className={`popup-panel popup-panel--left ${showControls ? 'visible' : ''}`}>
          <div className="popup-panel__agent">
            <div className="popup-panel__avatar" style={{ borderColor: agentColor, boxShadow: `0 0 20px ${agentColor}33` }}>
              <span style={{ color: agentColor }}>{assistant?.shortName || 'Q'}</span>
            </div>
            <div className="popup-panel__name" style={{ color: agentColor }}>{assistant?.name || 'CommanderQ'}</div>
            <div className="popup-panel__role">{assistant?.specialty || 'Orchestrator'}</div>
          </div>
          <div className="popup-panel__divider" style={{ background: `linear-gradient(180deg, transparent, ${agentColor}33, transparent)` }} />
          <div className="popup-panel__state">
            <div className="popup-panel__state-dot" style={{ background: currentColor, boxShadow: `0 0 8px ${currentColor}88` }} />
            <span className="popup-panel__state-label" style={{ color: currentColor }}>{currentLabel}</span>
          </div>
          {latestTool && (phase === 'thinking' || latestTool.status === 'running') && (
            <div className={`popup-tool popup-tool--${latestTool.status}`} title={latestTool.detail} style={{ '--tool-color': toolColor }}>
              <span className="popup-tool-dot" />
              <span className="popup-tool-name">{toolText}</span>
            </div>
          )}
        </div>

        {/* Center — the eye. Click to begin when idle. */}
        <div className="popup-visualizer-wrapper">
          <div
            className="popup-visualizer-container"
            onClick={clickEye}
            role="button"
            tabIndex={0}
            title={phase === 'idle' ? 'Tap to start talking' : ''}
            style={{ cursor: phase === 'idle' ? 'pointer' : 'default' }}
          >
            <VisualizerHost
              assistantId={assistantId}
              state={effectiveState}
              audioData={audioData}
              refreshKey={refreshKey}
            />
            {showConnectRing && (
              <svg className="qx-connect-ring" viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="46" />
              </svg>
            )}
            {phase === 'idle' && (
              <div className="popup-start-hint">
                <span>Tap to talk</span>
              </div>
            )}
            {showConnectingHint && (
              <div className="popup-start-hint popup-start-hint--connecting">
                <span>
                  {phaseCopy[phase]}{phase === 'waiting-for-agent' && waitingLong ? ' Taking longer than usual.' : ''}
                </span>
                <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={cancel}>Cancel</button>
              </div>
            )}
          </div>
          {/* Ambient caption — one line, fades; never a chat window */}
          <div className={`popup-caption ${caption ? `visible popup-caption--${caption.who}` : ''}`}>
            {caption && (
              <>
                <span className={`popup-caption__who popup-caption__who--${caption.who}`}>
                  {caption.who === 'you' ? 'You' : (assistant?.shortName || 'Q')}
                </span>
                <span className={`popup-caption__text ${caption.final ? 'popup-caption__text--final' : 'popup-caption__text--interim'}`}>
                  {caption.text}
                </span>
              </>
            )}
          </div>

          {/* Error / ended cards float over the (dimmed) eye — never replace the page. */}
          {(phase === 'error-media' || phase === 'error-mic-denied') && (
            <div className="popup-overlay">
              <div className="qx-card popup-error-card">
                <div className="qx-row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <span className="qx-dot qx-dot--degraded" style={{ marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, color: '#fff' }}>{phaseCopy[phase]}</p>
                    {statusMsg && statusMsg !== phaseCopy[phase] && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{statusMsg}</p>
                    )}
                  </div>
                </div>
                <div className="qx-row" style={{ gap: 8, marginTop: 16 }}>
                  <button className="qx-btn qx-btn--primary" onClick={handleRetry} disabled={retrying}>
                    {retrying ? <span className="qx-spinner qx-spinner--sm" /> : 'Retry'}
                  </button>
                  <button className="qx-btn qx-btn--ghost" onClick={handleClose}>Close</button>
                </div>
                <details className="qx-disclosure" style={{ marginTop: 14 }}>
                  <summary className="qx-disclosure__head"><span className="qx-disclosure__chev">▸</span>Diagnostics</summary>
                  <DiagnosticsBody phase={phase} diag={diag} />
                </details>
              </div>
            </div>
          )}
          {phase === 'ended' && (
            <div className="popup-overlay">
              <div className="qx-card popup-error-card">
                <p style={{ margin: 0, color: '#fff' }}>Session ended. {sessionDurationLabel || '00:00'}.</p>
                <div className="qx-row" style={{ gap: 8, marginTop: 16 }}>
                  <button className="qx-btn qx-btn--primary" onClick={start}>Start again</button>
                  <button className="qx-btn qx-btn--ghost" onClick={handleClose}>Close</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right — hands-free controls */}
        <div className={`popup-panel popup-panel--right ${showControls ? 'visible' : ''}`}>
          <div className="popup-panel__ptt">
            {phase === 'idle' ? (
              <button className="popup-ptt-btn" onClick={() => start()} title="Start hands-free (or Space)">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </button>
            ) : (
              <button
                className={`popup-ptt-btn popup-ptt-btn--live ${muted ? 'muted' : ''}`}
                onClick={() => toggleMute()}
                disabled={!live}
                title={muted ? 'Resume listening (Space)' : 'Stop listening (Space)'}
              >
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2">
                  {muted ? (
                    <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><line x1="3" y1="3" x2="21" y2="21"/></>
                  ) : (
                    <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></>
                  )}
                </svg>
              </button>
            )}
            {micMeterActive && <MicLevelMeter micAnalyserRef={micAnalyserRef} active={micMeterActive} />}
            <span className="popup-panel__ptt-label">
              {phase === 'idle' ? 'Tap to start' : (muted ? 'Muted — tap to resume' : currentLabel)}
            </span>
          </div>

          <div className="popup-panel__divider" style={{ background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.06), transparent)' }} />

          <div className="popup-panel__actions">
            {['listening', 'thinking', 'speaking', 'waiting-for-agent', 'reconnecting'].includes(phase) && (
              <button className="popup-panel__action-btn popup-panel__action-btn--close" onClick={() => stop()} title="End session">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
                <span>End</span>
              </button>
            )}
            <button className="popup-panel__action-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}>
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
                  <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                  <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                </svg>
              )}
              <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            </button>
          </div>

          {/* Desktop-only hints row; tablet/phone get the kebab in the bottom bar. */}
          <div className="popup-panel__hints">
            <div className="popup-panel__hint"><kbd>Space</kbd> {live ? 'Mute' : 'Start'}</div>
            <div className="popup-panel__hint"><kbd>F</kbd> Fullscreen</div>
            <div className="popup-panel__hint"><kbd>Esc</kbd> Close</div>
          </div>
        </div>
      </div>

      {/* Tablet + phone: side panels collapse into this single bottom bar. */}
      <div className="popup-bottombar">
        <div className="popup-bottombar__chip">
          <span className="popup-bottombar__avatar" style={{ borderColor: agentColor, color: agentColor }}>{assistant?.shortName || 'Q'}</span>
          <span className="qx-dot" style={{ '--qx-dot-color': currentColor }} />
          <span>{currentLabel}</span>
        </div>
        <div className="popup-bottombar__controls">
          {phase === 'idle' ? (
            <button className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => start()}>Start</button>
          ) : (
            <button className="qx-btn qx-btn--sm" onClick={() => toggleMute()} disabled={!live}>{muted ? 'Resume' : 'Mute'}</button>
          )}
          {['listening', 'thinking', 'speaking', 'waiting-for-agent', 'reconnecting'].includes(phase) && (
            <button className="qx-btn qx-btn--danger qx-btn--sm" onClick={() => stop()}>End</button>
          )}
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={toggleFullscreen}>{isFullscreen ? 'Exit' : 'Fullscreen'}</button>
          <div className="popup-kebab">
            <button className="qx-btn qx-btn--ghost qx-btn--sm popup-kebab__trigger" onClick={() => setKebabOpen((v) => !v)} title="More">⋮</button>
            {kebabOpen && (
              <div className="qx-menu popup-kebab__menu">
                <div className="qx-menu__header">Shortcuts</div>
                <div className="qx-menu__item" style={{ cursor: 'default' }}><kbd className="qx-menu__kbd">Space</kbd> {live ? 'Mute' : 'Start'}</div>
                <div className="qx-menu__item" style={{ cursor: 'default' }}><kbd className="qx-menu__kbd">F</kbd> Fullscreen</div>
                <div className="qx-menu__item" style={{ cursor: 'default' }}><kbd className="qx-menu__kbd">Esc</kbd> Close</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function VisualizerPopup() {
  return (
    <VoicePopupErrorBoundary fallback={<VisualizerPopupCrashCard />}>
      <VisualizerPopupInner />
    </VoicePopupErrorBoundary>
  )
}
