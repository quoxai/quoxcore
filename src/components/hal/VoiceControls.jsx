import { getAllAssistants } from '../../config/assistants'
import { buildAssistantIdentityList, resolveAssistantIdentity } from '../../services/assistantIdentity'

function VoiceControls({
  onStartListening,
  onStopListening,
  onToggleMute,
  isListening = false,
  isSpeaking = false,
  isMuted = false,
  currentAssistant = 'quox',
  onAssistantChange
}) {
  const allAssistants = buildAssistantIdentityList(getAllAssistants())
  const activeAssistant = resolveAssistantIdentity(currentAssistant, { fallbackId: 'quox' })

  return (
    <div className="voice-controls">
      {/* Microphone button */}
      <button
        className={`voice-btn mic-btn ${isListening ? 'active' : ''}`}
        onClick={isListening ? onStopListening : onStartListening}
        disabled={isSpeaking}
        title={isListening ? 'Stop listening' : 'Start listening'}
        aria-label={isListening ? `Stop listening to ${activeAssistant.name}` : `Start listening to ${activeAssistant.name}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
          <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        {isListening && <span className="pulse-ring"></span>}
      </button>

      {/* Assistant selector */}
      <div className="assistant-selector">
        {allAssistants.map(assistant => (
          <button
            key={assistant.id}
            className={`assistant-btn ${currentAssistant === assistant.id ? 'active' : ''}`}
            onClick={() => onAssistantChange(assistant.id)}
            title={`${assistant.name} - ${assistant.specialty}`}
            style={{
              '--btn-color': assistant.color,
              '--btn-rgb': assistant.colorRgb
            }}
          >
            <span className="assistant-icon">{assistant.shortName}</span>
            <span className="assistant-name">{assistant.name}</span>
          </button>
        ))}
      </div>

      {/* Mute/unmute speaker */}
      <button
        className={`voice-btn speaker-btn ${isMuted ? 'muted' : ''} ${isSpeaking ? 'active' : ''}`}
        onClick={onToggleMute}
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
            <path d="M11 5L6 9H2v6h4l5 5V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
            <path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>
          </svg>
        )}
        {isSpeaking && <span className="pulse-ring speaking"></span>}
      </button>
    </div>
  )
}

export default VoiceControls
