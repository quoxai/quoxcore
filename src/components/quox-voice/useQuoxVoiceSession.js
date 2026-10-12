/**
 * useQuoxVoiceSession — the shared governed realtime voice engine.
 *
 * One engine, two surfaces: the compact plugin card (QuoxVoiceView) and the
 * full-screen CommanderQ voice mode (HALHome) both drive this hook, so the
 * LiveKit connection, transcript streaming, agent-state phase, voice switching
 * and tool-activity feed live in exactly one place (no parallel stack).
 *
 * All control-plane calls ride the collector proxy /api/v1/quox-voice/* so
 * every create/end is witnessed (quox.voice.* AEE). Media rides WebRTC to the
 * LiveKit node; the signal URL is derived from THIS install's own origin so it
 * rides the operator's nginx + cert (see /quox-voice/rtc in nginx.conf).
 *
 * The reasoning model, tools, history and policy all live server-side in the
 * worker. With nativeTools on (the default), the worker runs REAL governed
 * function tools and cannot confabulate an action — either a tool ran and
 * returned data, or the agent says it can't.
 *
 * FAILURE MODEL (2026-09-25 rebuild): room.connect() resolving means the
 * *signalling* channel is up — it does NOT mean media (WebRTC/RTP audio) is
 * actually flowing. Off the dev LAN, with no TURN relay configured, the
 * signalling handshake can succeed while ICE never completes, leaving a
 * connected-looking room with no audio in either direction and no error ever
 * thrown. Every phase transition below exists to catch a specific way that
 * can go quiet, so the UI is never blank on a dead connection.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent } from 'livekit-client'

const API = '/collector/api/v1/quox-voice'
const CONNECT_TIMEOUT_MS = 10000
const MEDIA_CONFIRM_MS = 6000
const WAITING_AGENT_SLOW_MS = 8000
const MAX_RECONNECT_ATTEMPTS = 5

// Phases: idle | requesting-mic | connecting | waiting-for-agent | listening
// | thinking | speaking | reconnecting | error-media | error-mic-denied | ended
const ACTIVE_PHASES = new Set([
  'requesting-mic', 'connecting', 'waiting-for-agent',
  'listening', 'thinking', 'speaking', 'reconnecting',
])

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  let body = null
  try { body = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
  }
  return body
}

/**
 * @param {object} opts
 * @param {string} opts.agentId       agent to serve (server enforces its tools)
 * @param {string} opts.voiceId       ElevenLabs voice id ('' = agent default)
 * @param {boolean} opts.nativeTools  run the real governed tool loop (default true)
 * @param {boolean} opts.analyse      wire Web Audio analysers for visualization
 */
export default function useQuoxVoiceSession(opts = {}) {
  const {
    agentId = 'quox',
    agentName = null,   // display identity for the voice front (dashboard owns names)
    agentRole = null,
    voiceId: initialVoiceId = '',
    nativeTools = true,
    analyse = false,
  } = opts

  const [phase, setPhase] = useState('idle')
  const [phaseSince, setPhaseSince] = useState(() => Date.now())
  const [statusMsg, setStatusMsg] = useState('Tap to talk to CommanderQ')
  const [segments, setSegments] = useState([]) // {id, who, text, final}
  const [toolEvents, setToolEvents] = useState([]) // {id, name, status, detail, ts}
  const [sessionId, setSessionId] = useState(null)
  const [voiceId, setVoiceId] = useState(initialVoiceId)
  const [muted, setMuted] = useState(false)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [diag, setDiag] = useState({ serviceReachable: null, mediaOk: null })
  const [sessionDurationLabel, setSessionDurationLabel] = useState(null)

  const roomRef = useRef(null)
  const audioElRef = useRef(null)
  const audioCtxRef = useRef(null)
  const agentAnalyserRef = useRef(null)
  const micAnalyserRef = useRef(null)

  // Race/lifecycle guards. sessionGenRef invalidates in-flight async work from
  // a previous start() (Retry/Cancel/reconnectNow all bump it). phaseRef lets
  // event handlers registered once per room read the CURRENT phase without
  // going stale inside a closure.
  const sessionGenRef = useRef(0)
  const phaseRef = useRef('idle')
  const intentionalRef = useRef(false)
  const mediaConfirmedRef = useRef(false)
  const reconnectAttemptsRef = useRef(0)
  const sessionStartRef = useRef(null)
  const connectTimeoutRef = useRef(null)
  const mediaCheckTimeoutRef = useRef(null)
  const mediaCheckPollRef = useRef(null)

  useEffect(() => { phaseRef.current = phase }, [phase])

  const goPhase = useCallback((p, msg) => {
    phaseRef.current = p
    setPhase(p)
    setPhaseSince(Date.now())
    if (msg !== undefined) setStatusMsg(msg)
  }, [])

  const clearAllTimers = useCallback(() => {
    if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    if (mediaCheckTimeoutRef.current) { clearTimeout(mediaCheckTimeoutRef.current); mediaCheckTimeoutRef.current = null }
    if (mediaCheckPollRef.current) { clearInterval(mediaCheckPollRef.current); mediaCheckPollRef.current = null }
  }, [])

  const upsertSegment = useCallback((id, who, text, final) => {
    setSegments((prev) => {
      const i = prev.findIndex((s) => s.id === id)
      if (i === -1) return [...prev, { id, who, text, final }]
      const next = prev.slice()
      next[i] = { ...next[i], text, final }
      return next
    })
  }, [])

  const _ensureCtx = useCallback(() => {
    if (!analyse) return null
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      audioCtxRef.current = new Ctx()
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {})
    }
    return audioCtxRef.current
  }, [analyse])

  const _teardownAudio = useCallback(() => {
    agentAnalyserRef.current = null
    micAnalyserRef.current = null
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    if (ctx) { try { ctx.close() } catch { /* already closed */ } }
  }, [])

  // Shared teardown for every exit path (end/cancel/fail). Never leaves a
  // room, audio element or AudioContext dangling.
  const _teardownSession = useCallback(() => {
    clearAllTimers()
    const room = roomRef.current
    roomRef.current = null
    if (room) { try { room.disconnect() } catch { /* already down */ } }
    if (audioElRef.current) { audioElRef.current.remove(); audioElRef.current = null }
    _teardownAudio()
    setSessionId((sid) => {
      if (sid) api(`/sessions/${sid}/end`, { method: 'POST' }).catch(() => {})
      return null
    })
    setReconnectAttempt(0)
    reconnectAttemptsRef.current = 0
  }, [clearAllTimers, _teardownAudio])

  // End the session deliberately (the "End" action). Lands on `ended` with a
  // duration summary rather than snapping back to idle.
  const stop = useCallback(async () => {
    sessionGenRef.current += 1
    intentionalRef.current = true
    _teardownSession()
    const durMs = sessionStartRef.current ? Date.now() - sessionStartRef.current : 0
    setSessionDurationLabel(formatDuration(durMs))
    setMuted(false)
    goPhase('ended', 'Session ended')
  }, [_teardownSession, goPhase])

  // Abort an in-flight connection attempt (the "Cancel" action from
  // requesting-mic / connecting / waiting-for-agent) — straight back to idle,
  // no session ever really started so no summary is shown.
  const cancel = useCallback(() => {
    sessionGenRef.current += 1
    intentionalRef.current = true
    _teardownSession()
    setMuted(false)
    goPhase('idle', 'Tap to talk to CommanderQ')
  }, [_teardownSession, goPhase])

  // A media/service failure (any exit that is NOT the user choosing to end
  // or cancel). Always lands on error-media with the diagnostics patch that
  // drove the decision, so the Diagnostics disclosure can be honest.
  const failMedia = useCallback((message, diagPatch = {}) => {
    intentionalRef.current = true
    _teardownSession()
    setDiag((d) => ({ ...d, ...diagPatch }))
    goPhase('error-media', message)
  }, [_teardownSession, goPhase])

  const failMicDenied = useCallback((message) => {
    intentionalRef.current = true
    setDiag({ serviceReachable: null, mediaOk: null })
    goPhase('error-mic-denied', message)
  }, [goPhase])

  // Hands-free "stop/resume listening" — disables the mic publish without
  // tearing down the session (the agent keeps its voice; you just aren't heard).
  const toggleMute = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next = !muted
    setMuted(next)
    try { await room.localParticipant.setMicrophoneEnabled(!next) } catch { /* best-effort */ }
  }, [muted])

  const start = useCallback(async () => {
    const gen = ++sessionGenRef.current
    intentionalRef.current = false
    mediaConfirmedRef.current = false
    reconnectAttemptsRef.current = 0
    setReconnectAttempt(0)
    setDiag({ serviceReachable: null, mediaOk: null })
    setSessionDurationLabel(null)
    setSegments([])
    setToolEvents([])
    sessionStartRef.current = Date.now()
    goPhase('requesting-mic', 'Waiting for microphone permission…')

    // Pre-flight the mic permission BEFORE touching the network, so a denial
    // is reported precisely instead of surfacing later as an opaque media
    // failure. Release the device immediately — LiveKit re-acquires its own.
    let preflight = null
    try {
      preflight = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      if (gen !== sessionGenRef.current) return
      // Any getUserMedia failure (denied, no device, OS-blocked) lands here —
      // it is the mic-permission bucket regardless of the exact browser error.
      failMicDenied("Microphone access was blocked. Allow it in your browser's address bar, then retry.")
      return
    }
    preflight.getTracks().forEach((t) => { try { t.stop() } catch { /* noop */ } })
    if (gen !== sessionGenRef.current) return

    goPhase('connecting', 'Connecting to the voice service…')
    connectTimeoutRef.current = setTimeout(() => {
      if (gen !== sessionGenRef.current) return
      failMedia('Connecting to the voice service timed out.', { serviceReachable: false, mediaOk: null })
    }, CONNECT_TIMEOUT_MS)

    let s
    try {
      s = await api('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          native_tools: nativeTools,
          ...(agentName ? { agent_name: agentName } : {}),
          ...(agentRole ? { agent_role: agentRole } : {}),
          ...(voiceId ? { voice_id: voiceId } : {}),
        }),
      })
    } catch (e) {
      if (gen !== sessionGenRef.current) return
      failMedia(`Session refused: ${e.message}`, { serviceReachable: false, mediaOk: null })
      return
    }
    if (gen !== sessionGenRef.current) { api(`/sessions/${s.session_id}/end`, { method: 'POST' }).catch(() => {}); return }
    setSessionId(s.session_id)

    const room = new Room()
    roomRef.current = room

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== 'audio' || !participant.identity.startsWith('agent-')) return
      // First agent audio proves media is actually flowing — cancel the
      // media-confirm watchdog and, if we were still waiting, move on.
      mediaConfirmedRef.current = true
      if (mediaCheckTimeoutRef.current) { clearTimeout(mediaCheckTimeoutRef.current); mediaCheckTimeoutRef.current = null }
      if (mediaCheckPollRef.current) { clearInterval(mediaCheckPollRef.current); mediaCheckPollRef.current = null }
      if (phaseRef.current === 'waiting-for-agent') goPhase('listening', 'Listening, just talk')

      const el = track.attach()
      el.style.display = 'none'
      document.body.appendChild(el)
      audioElRef.current = el
      const ctx = _ensureCtx()
      if (ctx) {
        try {
          const src = ctx.createMediaElementSource(el)
          const an = ctx.createAnalyser()
          an.fftSize = 256
          src.connect(an)
          an.connect(ctx.destination)
          agentAnalyserRef.current = an
        } catch { /* analyser is best-effort chrome, never block audio */ }
      }
    })
    // The agent's own lifecycle state is the truthful signal, not a guess.
    // Only apply while a session is actually active — never let a late event
    // clobber an error/idle/ended screen.
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (!participant.identity.startsWith('agent-')) return
      if (!ACTIVE_PHASES.has(phaseRef.current)) return
      const st = participant.attributes['lk.agent.state']
      if (st === 'thinking') goPhase('thinking', 'Thinking…')
      else if (st === 'speaking') goPhase('speaking', 'Speaking, interrupt any time')
      else if (st === 'listening') goPhase('listening', 'Listening, just talk')
    })
    // Transcripts stream on lk.transcription; segments key by lk.segment_id
    // (interim + final are separate streams for the SAME segment), and the
    // speaker is decided by whose audio track was transcribed.
    room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
      const attrs = reader.info.attributes || {}
      const segId = attrs['lk.segment_id'] || reader.info.id
      const myTrackSids = new Set(
        Array.from(room.localParticipant.trackPublications.values()).map((p) => p.trackSid))
      const isYou = myTrackSids.has(attrs['lk.transcribed_track_id']) ||
        (participantInfo?.identity === room.localParticipant.identity)
      let text = ''
      for await (const chunk of reader) {
        text += chunk
        upsertSegment(segId, isYou ? 'you' : 'agent', text,
          attrs['lk.transcription_final'] === 'true')
      }
      upsertSegment(segId, isYou ? 'you' : 'agent', text, true)
    })
    // Tool activity: the worker publishes a JSON event on the quox-voice-tool
    // topic whenever a governed native tool starts/finishes, so the browser can
    // SHOW the real capability firing (honesty made visible). Harmless if the
    // worker is tool-less — no events, no strip.
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== 'quox-voice-tool') return
      let ev
      try { ev = JSON.parse(new TextDecoder().decode(payload)) } catch { return }
      if (!ev || !ev.name) return
      setToolEvents((prev) => {
        const id = ev.id || `${ev.name}-${ev.ts || prev.length}`
        const i = prev.findIndex((t) => t.id === id)
        const rec = {
          id,
          name: ev.name,
          status: ev.status || 'running', // running|ok|error
          detail: ev.detail || ev.summary || '',
          ts: ev.ts || Date.now(),
        }
        if (i === -1) return [...prev.slice(-19), rec]
        const next = prev.slice()
        next[i] = { ...next[i], ...rec }
        return next
      })
    })
    // Signalling drops / LiveKit's own auto-reconnect. We keep a small,
    // user-visible attempt counter on top of it (capped at 5) so a wedged
    // reconnect loop surfaces as error-media instead of spinning forever.
    room.on(RoomEvent.Reconnecting, () => {
      if (gen !== sessionGenRef.current) return
      reconnectAttemptsRef.current += 1
      setReconnectAttempt(reconnectAttemptsRef.current)
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        failMedia('Connection dropped and could not be restored.', { serviceReachable: true, mediaOk: false })
        return
      }
      goPhase('reconnecting', 'Connection dropped. Reconnecting…')
    })
    room.on(RoomEvent.Reconnected, () => {
      if (gen !== sessionGenRef.current) return
      reconnectAttemptsRef.current = 0
      setReconnectAttempt(0)
      // Best-effort landing phase; the next ParticipantAttributesChanged
      // (or TrackSubscribed) corrects it within moments.
      goPhase('listening', 'Listening, just talk')
    })
    room.on(RoomEvent.Disconnected, () => {
      if (gen !== sessionGenRef.current) return
      if (intentionalRef.current) return // stop()/cancel()/failMedia() already handled it
      failMedia('The connection was lost unexpectedly.', { serviceReachable: true, mediaOk: false })
    })

    try {
      // livekit-client appends /rtc to this base; derive from our own origin so
      // it rides the install's nginx + cert on any operator domain.
      const wsBase = (typeof window !== 'undefined' && window.location)
        ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/quox-voice`
        : s.livekit_url
      await room.connect(wsBase, s.join_token)
      if (gen !== sessionGenRef.current) { try { await room.disconnect() } catch { /* noop */ }; return }
      if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      setDiag({ serviceReachable: true, mediaOk: null })

      await room.localParticipant.setMicrophoneEnabled(true)
      // Wire the mic into its own analyser so the eye reacts while you speak.
      const ctx = _ensureCtx()
      if (ctx) {
        try {
          const micPub = Array.from(room.localParticipant.trackPublications.values())
            .find((p) => p.kind === 'audio' && p.track)
          const mst = micPub?.track?.mediaStreamTrack
          if (mst) {
            const stream = new MediaStream([mst])
            const src = ctx.createMediaStreamSource(stream)
            const an = ctx.createAnalyser()
            an.fftSize = 256
            src.connect(an) // do NOT connect to destination (would echo the mic)
            micAnalyserRef.current = an
          }
        } catch { /* mic analyser is best-effort */ }
      }
    } catch (e) {
      if (gen !== sessionGenRef.current) return
      if (connectTimeoutRef.current) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      roomRef.current = null
      try { await room.disconnect() } catch { /* already down */ }
      failMedia(`Media failed: ${e.message || e}`, { serviceReachable: true, mediaOk: false })
      return
    }

    goPhase('waiting-for-agent', 'Connected. Waking CommanderQ…')

    // room.connect() resolving proves signalling only. Require EITHER the
    // agent's audio track (TrackSubscribed, handled above) OR the transport's
    // own ICE state reaching 'connected' within MEDIA_CONFIRM_MS — otherwise
    // this is exactly the "signalling up, media never flows" failure the
    // owner hit off the dev LAN with no TURN relay.
    mediaCheckTimeoutRef.current = setTimeout(() => {
      if (gen !== sessionGenRef.current) return
      if (mediaConfirmedRef.current) return
      failMedia(
        'Connected, but audio could not flow. You may be off the dev network, or a firewall is blocking media.',
        { serviceReachable: true, mediaOk: false })
    }, MEDIA_CONFIRM_MS)
    mediaCheckPollRef.current = setInterval(() => {
      if (mediaConfirmedRef.current) return
      // @internal LiveKit API — best-effort only, never throws past this guard.
      try {
        const pcManager = room.engine?.pcManager
        const ice = pcManager?.subscriber?.pc?.iceConnectionState
          || pcManager?.publisher?.pc?.iceConnectionState
        if (ice === 'connected' || ice === 'completed') {
          mediaConfirmedRef.current = true
          if (mediaCheckTimeoutRef.current) { clearTimeout(mediaCheckTimeoutRef.current); mediaCheckTimeoutRef.current = null }
          if (mediaCheckPollRef.current) { clearInterval(mediaCheckPollRef.current); mediaCheckPollRef.current = null }
        }
      } catch { /* internal shape can change under us; ignore */ }
    }, 500)
  }, [agentId, agentName, agentRole, nativeTools, voiceId, goPhase, failMedia, failMicDenied, upsertSegment, _ensureCtx])

  // Force a full restart from a reconnecting/error state ("Reconnect now").
  const reconnectNow = useCallback(() => {
    cancel()
    start()
  }, [cancel, start])

  // Mid-session voice switch rides the data channel; applies from the agent's
  // next sentence.
  const setVoice = useCallback((vid) => {
    setVoiceId(vid)
    const room = roomRef.current
    if (room && vid) {
      const data = new TextEncoder().encode(
        JSON.stringify({ type: 'set_voice', voice_id: vid }))
      room.localParticipant.publishData(data,
        { reliable: true, topic: 'quox-voice-control' })
      setStatusMsg('Voice switched, applies from the next reply')
    }
  }, [])

  // Sample the currently-relevant analyser into a Uint8Array of frequency bins.
  // Speaking → the agent's voice; otherwise → the mic. Returns null if no audio
  // graph is live (caller should fall back to an idle animation).
  const sampleFrequency = useCallback((out) => {
    const an = (phase === 'speaking' ? agentAnalyserRef.current : null)
      || micAnalyserRef.current || agentAnalyserRef.current
    if (!an) return null
    const arr = out && out.length === an.frequencyBinCount
      ? out : new Uint8Array(an.frequencyBinCount)
    an.getByteFrequencyData(arr)
    return arr
  }, [phase])

  useEffect(() => () => { // unmount: tear down media + session
    sessionGenRef.current += 1
    intentionalRef.current = true
    _teardownSession()
  }, [_teardownSession])

  const live = ACTIVE_PHASES.has(phase)

  return {
    phase, phaseSince, statusMsg, segments, toolEvents, sessionId, voiceId, live, muted,
    reconnectAttempt, reconnectMax: MAX_RECONNECT_ATTEMPTS, diag, sessionDurationLabel,
    start, stop, cancel, reconnectNow, setVoice, toggleMute, sampleFrequency,
    agentAnalyserRef, micAnalyserRef,
  }
}
