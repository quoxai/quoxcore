import { useState, useRef, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import VisualizerHost from '../components/visualizations-v2/VisualizerHost'
import VoiceControls from '../components/hal/VoiceControls'
import Subtitles from '../components/hal/Subtitles'
import { resolveAssistantIdentity, getAssistantVoiceMode } from '../services/assistantIdentity'
import { queueSync } from '../services/serverSyncQueue'

const API_BASE = '/webhook'

// BroadcastChannel for cross-component visualization sync
const VISUALIZER_SYNC_CHANNEL = 'quox-visualizer-sync'

export function buildHalGreeting(assistantId) {
  const assistant = resolveAssistantIdentity(assistantId, { fallbackId: 'quox' })
  const assistantName = assistant?.name || 'Quox'
  const specialty = assistant?.specialty?.trim()
  if (specialty) {
    return `${assistantName} online. ${specialty}. How may I help you today?`
  }
  return `${assistantName} online. How may I help you today?`
}

function HALHome() {
  // State
  const [halState, setHalState] = useState('idle') // idle, listening, thinking, speaking, error
  const [currentAssistant, setCurrentAssistant] = useState(() => {
    return localStorage.getItem('quox-assistant') || 'quox'
  })

  // Get voice mode from current assistant
  const activeAssistantIdentity = resolveAssistantIdentity(currentAssistant, { fallbackId: 'quox' })
  const voiceMode = getAssistantVoiceMode(currentAssistant, { fallbackId: 'quox' }) || 'jarvis'
  const [isMuted, setIsMuted] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [currentText, setCurrentText] = useState('')
  const [inputText, setInputText] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [audioData, setAudioData] = useState(null)
  const [error, setError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [conversationHistory, setConversationHistory] = useState([])
  const [thinkingTime, setThinkingTime] = useState(0)
  const [visualizerRefreshKey, setVisualizerRefreshKey] = useState(0)

  // Refs for audio handling
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const animationFrameRef = useRef(null)
  const recordingTimeoutRef = useRef(null)
  const currentAudioRef = useRef(null)
  const audioQueueRef = useRef([])

  useEffect(() => {
    setCurrentText(buildHalGreeting(currentAssistant))
    localStorage.setItem('quox-assistant', currentAssistant)
    queueSync('defaultAssistant', currentAssistant)
  }, [currentAssistant])

  // Thinking timer
  useEffect(() => {
    let interval
    if (halState === 'thinking') {
      setThinkingTime(0)
      interval = setInterval(() => {
        setThinkingTime(t => t + 1)
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [halState])

  // Listen for visualizer settings changes from other components
  useEffect(() => {
    let channel
    try {
      channel = new BroadcastChannel(VISUALIZER_SYNC_CHANNEL)
      channel.onmessage = (event) => {
        const { type, payload } = event.data || {}
        if (type === 'refresh') {
          // Refresh visualizer when settings change (optionally filter by assistantId)
          if (!payload?.assistantId || payload.assistantId === currentAssistant) {
            setVisualizerRefreshKey(k => k + 1)
          }
        }
      }
    } catch (e) {
      // BroadcastChannel not supported
      console.warn('[HALHome] BroadcastChannel not supported:', e)
    }

    return () => {
      channel?.close()
    }
  }, [currentAssistant])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Spacebar for push-to-talk (only when not typing)
      if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault()
        if (!isListening && halState === 'idle') {
          startListening()
        }
      }
      // Escape to cancel
      if (e.code === 'Escape') {
        if (isListening) {
          stopListening()
        }
      }
    }

    const handleKeyUp = (e) => {
      if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
        if (isListening) {
          stopListening()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [isListening, halState])

  // Start listening (voice input)
  const startListening = async () => {
    try {
      // Check for secure context (HTTPS or localhost) before attempting mic access
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('SECURE_CONTEXT')
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // Set up audio analysis for visualization
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
      analyserRef.current = audioContextRef.current.createAnalyser()
      const source = audioContextRef.current.createMediaStreamSource(stream)
      source.connect(analyserRef.current)
      analyserRef.current.fftSize = 256

      // Start visualization
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
      const updateVisualization = () => {
        analyserRef.current.getByteFrequencyData(dataArray)
        setAudioData([...dataArray])
        animationFrameRef.current = requestAnimationFrame(updateVisualization)
      }
      updateVisualization()

      // Set up media recorder
      mediaRecorderRef.current = new MediaRecorder(stream)
      audioChunksRef.current = []

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data)
      }

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        await transcribeAudio(audioBlob)

        // Clean up
        stream.getTracks().forEach(track => track.stop())
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current)
        }
        setAudioData(null)
      }

      mediaRecorderRef.current.start()
      setIsListening(true)
      setHalState('listening')
      setCurrentText('Listening... (release to send)')

      // Auto-stop after 15 seconds to prevent indefinite listening
      recordingTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          console.log('Auto-stopping recording after 15s')
          stopListening()
        }
      }, 15000)
    } catch (err) {
      console.error('Microphone access error:', err)
      let errorMsg = 'Could not access microphone'
      let errorDetails = null

      if (err.message === 'SECURE_CONTEXT' || !navigator.mediaDevices || err.name === 'TypeError') {
        errorMsg = 'Microphone requires a secure connection'
        errorDetails = window.location.protocol === 'http:'
          ? `You're on HTTP (${window.location.host}). Either access via localhost, or use HTTPS.`
          : 'Your browser requires HTTPS for microphone access. Try accessing via localhost or configure HTTPS.'
      } else if (err.name === 'NotAllowedError') {
        errorMsg = 'Microphone access not granted'
        errorDetails = 'Click the lock/site icon in your address bar → Site settings → Allow microphone, then try again.'
      } else if (err.name === 'NotFoundError') {
        errorMsg = 'No microphone detected'
        errorDetails = 'Connect a microphone or headset and try again.'
      } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
        errorMsg = 'Microphone is in use'
        errorDetails = 'Another application may be using your microphone. Close other apps using audio input and try again.'
      }

      setError(errorDetails ? `${errorMsg}. ${errorDetails}` : errorMsg)
      setHalState('error')
    }
  }

  // Stop listening
  const stopListening = () => {
    // Clear the auto-timeout
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current)
      recordingTimeoutRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    setIsListening(false)
  }

  // Transcribe audio using Whisper API
  const transcribeAudio = async (audioBlob) => {
    setHalState('thinking')
    setCurrentText('Processing your voice...')

    try {
      const formData = new FormData()
      formData.append('audio', audioBlob, 'recording.webm')

      const response = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error('Transcription failed')
      }

      const data = await response.json()
      const transcribedText = data.text || data.transcript || ''

      if (transcribedText) {
        setInputText(transcribedText)
        await sendMessage(transcribedText)
      } else {
        setCurrentText("I didn't catch that. Could you try again?")
        setHalState('idle')
      }
    } catch (err) {
      console.error('Transcription error:', err)
      setCurrentText('Voice transcription is not configured yet. Please type your message.')
      setHalState('idle')
    }
  }

  // Send message to Quox
  const sendMessage = async (text) => {
    if (!text.trim()) return

    setHalState('thinking')
    setCurrentText(`Processing: "${text}"`)

    // Add user message to history
    setConversationHistory(prev => [...prev.slice(-14), { role: 'user', text }])

    try {
      // GTM-A1/B1: '/webhook/chat' has no nginx location and returns a 405 HTML
      // page. /speak and /transcribe below ARE routed under /webhook, so only
      // the chat call moves to the collector's canonical /chat handler.
      const response = await fetch('/collector/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          session_id: sessionId,
          voice_mode: voiceMode
        })
      })

      const data = await response.json()

      if (data.session_id) {
        setSessionId(data.session_id)
      }

      const responseText = data.result || data.error || 'No response received.'
      const voiceSummary = data.voice_summary || ''
      setCurrentText(responseText)

      // Add assistant response to history (with assistant ID for filtering/styling)
      setConversationHistory(prev => [...prev.slice(-14), {
        role: 'assistant',
        text: responseText,
        assistant: currentAssistant
      }])

      // Speak the voice summary (short, conversational) if not muted
      // Falls back to truncated result if no voice_summary
      if (!isMuted && (voiceSummary || data.result)) {
        const textToSpeak = voiceSummary || responseText.substring(0, 200)
        await speakText(textToSpeak)
      } else {
        setHalState('idle')
      }
    } catch (err) {
      console.error('Chat error:', err)
      setCurrentText('Connection error. Please check the backend.')
      setHalState('error')
      setTimeout(() => setHalState('idle'), 3000)
    }
  }

  // Play next audio in queue
  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0) {
      setHalState('idle')
      setAudioData(null)
      currentAudioRef.current = null
      return
    }

    const nextText = audioQueueRef.current.shift()
    await playAudio(nextText)
  }

  // Internal function to play audio
  const playAudio = async (text) => {
    setHalState('speaking')

    try {
      const response = await fetch(`${API_BASE}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          voice_mode: voiceMode
        })
      })

      if (!response.ok) {
        throw new Error('TTS failed')
      }

      const audioBlob = await response.blob()
      const audioUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(audioUrl)
      currentAudioRef.current = audio

      // Set up audio analysis for visualization during playback
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)()
      const source = audioContextRef.current.createMediaElementSource(audio)
      analyserRef.current = audioContextRef.current.createAnalyser()
      source.connect(analyserRef.current)
      analyserRef.current.connect(audioContextRef.current.destination)
      analyserRef.current.fftSize = 256

      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
      const updateVisualization = () => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray)
          setAudioData([...dataArray])
        }
        if (currentAudioRef.current && !currentAudioRef.current.paused) {
          animationFrameRef.current = requestAnimationFrame(updateVisualization)
        }
      }

      audio.onplay = () => updateVisualization()
      audio.onended = () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current)
        }
        URL.revokeObjectURL(audioUrl)
        currentAudioRef.current = null
        // Play next in queue
        playNextInQueue()
      }

      await audio.play()
    } catch (err) {
      console.error('TTS error:', err)
      currentAudioRef.current = null
      // Try next in queue even on error
      playNextInQueue()
    }
  }

  // Text-to-speech via ElevenLabs (with queue)
  const speakText = async (text) => {
    // If already speaking, add to queue
    if (currentAudioRef.current) {
      audioQueueRef.current.push(text)
      return
    }
    await playAudio(text)
  }

  // Handle text input submit
  const handleSubmit = (e) => {
    e.preventDefault()
    if (inputText.trim()) {
      sendMessage(inputText)
      setInputText('')
    }
  }

  // Toggle mute
  const toggleMute = () => {
    setIsMuted(!isMuted)
  }

  return (
    <div className="hal-home">
      {/* Navigation */}
      <nav className="hal-nav">
        <div className="nav-brand">
          <span className="brand-icon">M</span>
          <span className="brand-text">CommanderQ</span>
        </div>
        <button
          className={`nav-toggle ${menuOpen ? 'active' : ''}`}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
        <div className={`nav-links ${menuOpen ? 'open' : ''}`}>
          <Link to="/dashboard" className="nav-link" onClick={() => setMenuOpen(false)}>Dashboard</Link>
          <Link to="/soc" className="nav-link" onClick={() => setMenuOpen(false)}>SOC</Link>
          <Link to="/noc" className="nav-link" onClick={() => setMenuOpen(false)}>NOC</Link>
          <Link to="/agents" className="nav-link" onClick={() => setMenuOpen(false)}>Agents</Link>
          <Link to="/workspace" className="nav-link" onClick={() => setMenuOpen(false)}>Workspace</Link>
          <Link to="/settings" className="nav-link" onClick={() => setMenuOpen(false)}>Settings</Link>
        </div>
        <div className="nav-status">
          <span className={`status-indicator ${halState}`}></span>
          <span className="status-text">{halState.toUpperCase()}</span>
        </div>
      </nav>

      {/* Main HAL Interface */}
      <main className="hal-main">
        {/* The Eye - Uses VisualizerHost for the unified visualizer studio runtime */}
        <div className="hal-eye-container">
          <VisualizerHost
            assistantId={currentAssistant}
            state={halState}
            audioData={audioData}
            refreshKey={visualizerRefreshKey}
          />
        </div>

        {/* Voice Controls */}
        <VoiceControls
          onStartListening={startListening}
          onStopListening={stopListening}
          onToggleMute={toggleMute}
          isListening={isListening}
          isSpeaking={halState === 'speaking'}
          isMuted={isMuted}
          currentAssistant={currentAssistant}
          onAssistantChange={setCurrentAssistant}
        />

        {/* Subtitles / Response Display */}
        <Subtitles
          text={halState === 'thinking' ? `${currentText} (${thinkingTime}s)` : currentText}
          isTyping={halState === 'thinking'}
          role={halState === 'listening' ? 'user' : 'assistant'}
          history={conversationHistory}
          currentAssistant={currentAssistant}
        />

        {/* Text Input Fallback */}
        <form className="text-input-form" onSubmit={handleSubmit}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Or type your message here..."
            disabled={halState === 'thinking' || halState === 'speaking'}
            className="text-input"
          />
          <button
            type="submit"
            disabled={!inputText.trim() || halState === 'thinking' || halState === 'speaking'}
            className="send-btn"
          >
            Send
          </button>
        </form>

        {/* Error Display */}
        {error && (
          <div className="error-message">
            {error}
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="hal-footer">
        <span>Quox AI Command Center v2.0</span>
        <span className="keyboard-hint">Hold SPACE to talk • ESC to cancel</span>
        <span className="session-info">
          {sessionId ? `Session: ${sessionId.slice(0, 8)}...` : 'No active session'}
        </span>
          <span>{activeAssistantIdentity?.name || 'Assistant'} • Voice: {voiceMode.toUpperCase()}</span>
      </footer>
    </div>
  )
}

export default HALHome
