/**
 * VoiceTab — Voice selector, preview, info
 * Extracted from AssistantEditor.jsx (AUX-1: zero functional change)
 */

export default function VoiceTab({
  draft,
  assistantId,
  currentVoiceKey,
  currentVoice,
  voicesByCategory,
  VOICE_CATEGORIES,
  setAgentVoice,
  voicePreviewing,
  onVoicePreview,
}) {
  return (
    <div className="editor-section">
      <div className="voice-section-header">
        <p className="section-description">
          Select the voice for this assistant. Changes sync with Settings &rarr; Voice.
        </p>
      </div>

      <div className="form-group">
        <label>Current Voice</label>
        <div className="current-voice-display">
          <span className="voice-badge" style={{ background: 'rgba(56, 189, 248, 0.2)', color: '#38bdf8' }}>
            {currentVoice?.displayName || 'Not set'}
          </span>
          {currentVoice && (
            <span className="voice-meta">{currentVoice.accent} &bull; {currentVoice.tone}</span>
          )}
        </div>
      </div>

      <div className="form-group">
        <label>Select Voice</label>
        <select
          value={currentVoiceKey}
          onChange={(e) => setAgentVoice(assistantId, e.target.value)}
          className="voice-select"
        >
          {VOICE_CATEGORIES.map((category) => {
            const categoryVoices = voicesByCategory[category.key]?.voices || []
            if (categoryVoices.length === 0) return null
            return (
              <optgroup key={category.key} label={category.label}>
                {categoryVoices.map((voice) => (
                  <option key={voice.key} value={voice.key}>
                    {voice.displayName}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
      </div>

      <div className="voice-preview-row">
        <button
          className={`voice-preview-btn ${voicePreviewing ? 'voice-preview-btn--playing' : ''}`}
          onClick={onVoicePreview}
          disabled={voicePreviewing}
        >
          <span>{voicePreviewing ? '◼' : '▶'}</span>
          {voicePreviewing ? 'Playing...' : 'Preview Voice'}
        </button>
        <span className="voice-preview-text">
          "I am {draft?.identity?.name || assistantId}. {draft?.identity?.tagline || '...'}"
        </span>
      </div>

      <div className="voice-info-box">
        <h4>Voice Settings</h4>
        <p>
          Voice assignments are shared across the app. Changing the voice here
          will also update it in <strong>Settings &gt; Voice</strong>.
        </p>
        <p className="voice-tip">
          Try the <strong>Character Voices</strong> for more personality.
        </p>
      </div>
    </div>
  )
}
