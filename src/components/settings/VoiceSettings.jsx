/**
 * VoiceSettings V2 - Voice configuration panel for Settings
 *
 * Features:
 * - Mute toggle with persistence
 * - Verbosity mode selector (Quiet/Normal/Verbose)
 * - TTS model selection
 * - Per-agent voice assignment (dynamic, all agents)
 * - Grouped voice selector (20 voices by category)
 * - Preprocessing toggle options
 * - Voice preview/testing
 */

import { useState } from 'react';
import {
  useVoiceSettings,
  useVoiceSelector,
  useVerbositySelector
} from '../../hooks/useVoiceSettings';
import { preprocessForTTS, getPreprocessingStats } from '../../services/ttsPreprocessor';
import { isPremiumVoiceAvailable, VOICE_LIBRARY } from '../../services/voiceSettings';
import { getAssistantDisplayName as resolveAssistantDisplayName } from '../../services/assistantIdentity';
import './voice-settings.css';

// Test text for preview
const TEST_TEXTS = {
  simple: "Hello! I've completed the analysis you requested.",
  withCode: "Here's the fix:\n```javascript\nconst x = 42;\nconsole.log(x);\n```\nThis should resolve the issue.",
  withTechnical: "Server 192.168.1.100 is responding. The hash a4f8b2c3e9d1f0 matches. Check /var/log/nginx/error.log for details.",
  withList: "Found 8 issues:\n- Memory leak in module A\n- Timeout on API calls\n- Missing error handling\n- Deprecated function usage\n- Unoptimized queries\n- Missing tests\n- Documentation gaps\n- Security vulnerability",
};

// Generate consistent color from agent ID
function getAgentColor(agentId) {
  const colors = [
    '#38bdf8', '#ef4444', '#22c55e', '#a855f7', '#fbbf24',
    '#0ea5e9', '#ec4899', '#f97316', '#6366f1', '#14b8a6',
    '#8b5cf6', '#84cc16', '#06b6d4', '#f43f5e', '#10b981'
  ];
  const hash = agentId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function VoiceSettings() {
  const {
    settings,
    update,
    toggleMute,
    reset,
    isMuted,
    isEnabled,
    TTS_MODELS,
  } = useVoiceSettings();

  const { voicesByCategory, agents, setAgentVoice, setAgentSynthetic, VOICE_CATEGORIES } = useVoiceSelector();
  const { modes, current: currentVerbosity, setVerbosity } = useVerbositySelector();

  // Preview state
  const [previewText, setPreviewText] = useState('withTechnical');
  const [showPreview, setShowPreview] = useState(false);

  // Voice test state
  const [testingVoice, setTestingVoice] = useState(null);
  const [testAudio, setTestAudio] = useState(null);
  const [testError, setTestError] = useState(null);

  // Test a voice by calling the TTS endpoint
  const testVoice = async (voiceKey) => {
    if (testingVoice) return; // Already testing

    const voice = VOICE_LIBRARY[voiceKey];
    if (!voice) return;

    setTestingVoice(voiceKey);
    setTestError(null);

    // Get the actual model ID from TTS_MODELS
    const modelConfig = TTS_MODELS[settings.model] || TTS_MODELS.multilingual;
    const modelId = modelConfig.id;

    try {
      const response = await fetch('/webhook/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hello, I'm ${voice.displayName.split(' (')[0]}. This is how I sound.`,
          voice_id: voice.voiceId,
          model_id: modelId
        })
      });

      if (response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('audio')) {
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          setTestAudio(audio);
          audio.onended = () => {
            setTestingVoice(null);
            URL.revokeObjectURL(url);
          };
          audio.onerror = (e) => {
            setTestError('Audio playback failed');
            setTestingVoice(null);
            URL.revokeObjectURL(url);
          };
          audio.play().catch((e) => {
            setTestError('Browser blocked audio playback');
            setTestingVoice(null);
          });
        } else {
          // Response is not audio, probably an error message
          const text = await response.text();
          setTestError(text.slice(0, 100) || 'Invalid response from TTS');
          setTestingVoice(null);
        }
      } else {
        let errorMsg;
        if (response.status === 401 || response.status === 403) {
          errorMsg = 'ElevenLabs API key is invalid or missing. Update it in Settings → Core Integrations.';
        } else if (response.status === 404) {
          errorMsg = 'Voice service not running. Check your API keys in Settings → Core Integrations.';
        } else if (response.status >= 500) {
          errorMsg = 'Voice service error. Check collector logs for details.';
        } else {
          const errorText = await response.text().catch(() => '');
          errorMsg = `TTS error (${response.status}): ${errorText.slice(0, 80) || 'Unknown error'}`;
        }
        setTestError(errorMsg);
        setTestingVoice(null);
      }
    } catch (err) {
      console.error('Voice test failed:', err);
      const errMsg = err.message?.includes('Failed to fetch')
        ? 'Cannot reach voice service. Check your API keys in Settings → Core Integrations.'
        : `Network error: ${err.message}`;
      setTestError(errMsg);
      setTestingVoice(null);
    }
  };

  const stopTest = () => {
    if (testAudio) {
      testAudio.pause();
      testAudio.currentTime = 0;
      setTestAudio(null);
    }
    setTestingVoice(null);
  };

  // Get preview result
  const getPreviewResult = () => {
    const text = TEST_TEXTS[previewText];
    const processed = preprocessForTTS(text);
    const stats = getPreprocessingStats(text);
    return { original: text, processed, stats };
  };

  const preview = showPreview ? getPreviewResult() : null;

  // Get display name for agent
  const getAgentDisplayName = (agentId) => {
    return resolveAssistantDisplayName(agentId, { fallbackName: agentId.toUpperCase() });
  };

  return (
    <div className="voice-settings">
      <div className="voice-settings__header">
        <h2>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>
          </svg>
          Voice Settings
        </h2>
        <p className="voice-settings__description">
          Configure how QuoxCORE speaks responses to you
        </p>
      </div>

      {/* Master Controls */}
      <section className="voice-settings__section">
        <h3>Voice Output</h3>

        <div className="voice-settings__row">
          <div className="voice-settings__control">
            <label className="voice-settings__toggle">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                aria-label="Enable voice responses"
              />
              <span className="toggle-track"><span className="toggle-thumb"></span></span>
              <span className="toggle-label">Enable Voice Responses</span>
            </label>
          </div>

          <div className="voice-settings__control">
            <label className="voice-settings__toggle">
              <input
                type="checkbox"
                checked={isMuted}
                onChange={toggleMute}
                aria-label="Mute all voice output"
              />
              <span className="toggle-track"><span className="toggle-thumb"></span></span>
              <span className="toggle-label">Mute All</span>
            </label>
            <span className="voice-settings__hint">Persists across sessions</span>
          </div>
        </div>
      </section>

      {/* Verbosity Mode */}
      <section className="voice-settings__section">
        <h3>Verbosity</h3>
        <p className="voice-settings__section-desc">
          Control how much detail is spoken in responses
        </p>

        <div className="voice-settings__verbosity-grid" role="radiogroup" aria-label="Verbosity mode">
          {modes.map((mode) => (
            <button
              key={mode.key}
              className={`verbosity-card ${currentVerbosity.key === mode.key ? 'verbosity-card--active' : ''}`}
              onClick={() => setVerbosity(mode.key)}
              role="radio"
              aria-checked={currentVerbosity.key === mode.key}
            >
              <div className="verbosity-card__icon">
                {mode.key === 'quiet' && (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 5V5z"/>
                  </svg>
                )}
                {mode.key === 'normal' && (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/>
                  </svg>
                )}
                {mode.key === 'verbose' && (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>
                  </svg>
                )}
              </div>
              <div className="verbosity-card__content">
                <div className="verbosity-card__name">{mode.name}</div>
                <div className="verbosity-card__desc">{mode.description}</div>
              </div>
              <div className="verbosity-card__limit">{mode.maxLength}</div>
            </button>
          ))}
        </div>
      </section>

      {/* TTS Model */}
      <section className="voice-settings__section">
        <h3>Voice Quality</h3>

        <div className="voice-settings__model-select">
          <label htmlFor="tts-model">TTS Model</label>
          <select
            id="tts-model"
            value={settings.model}
            onChange={(e) => update({ model: e.target.value })}
          >
            {Object.entries(TTS_MODELS).map(([key, model]) => (
              <option key={key} value={key}>
                {model.name} - {model.description}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Agent Voices */}
      <section className="voice-settings__section">
        <h3>Agent Voices</h3>
        <p className="voice-settings__section-desc">
          Assign different voices to each agent ({agents.length} agents)
        </p>

        <div className="vs-agents">
          {agents.map((agent) => {
            const color = getAgentColor(agent.agentId);
            const isPlaying = testingVoice === agent.voiceKey;
            const currentVoiceName = VOICE_LIBRARY[agent.voiceKey]?.displayName || agent.voiceKey;
            return (
              <div key={agent.agentId} className="vs-agent" style={{ '--vs-agent-color': color }}>
                <div className="vs-agent__head">
                  <span className="vs-agent__dot" />
                  <span className="vs-agent__name">{getAgentDisplayName(agent.agentId)}</span>
                  <button
                    className={`vs-agent__play ${isPlaying ? 'vs-agent__play--active' : ''}`}
                    onClick={() => isPlaying ? stopTest() : testVoice(agent.voiceKey)}
                    title={isPlaying ? 'Stop' : 'Test voice'}
                    disabled={testingVoice && !isPlaying}
                    aria-label={isPlaying ? 'Stop playing' : 'Test this voice'}
                  >
                    {isPlaying ? (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none">
                        <rect x="6" y="6" width="12" height="12" rx="1"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none">
                        <polygon points="6 4 20 12 6 20"/>
                      </svg>
                    )}
                  </button>
                </div>
                <div className="vs-agent__voice-row">
                  <span className="vs-agent__voice-label">Voice</span>
                  <select
                    className="vs-agent__select"
                    value={agent.voiceKey}
                    onChange={(e) => setAgentVoice(agent.agentId, e.target.value)}
                    aria-label={`Voice for ${getAgentDisplayName(agent.agentId)}`}
                  >
                    {VOICE_CATEGORIES.map((category) => {
                      const categoryVoices = voicesByCategory[category.key]?.voices || [];
                      if (categoryVoices.length === 0) return null;
                      return (
                        <optgroup key={category.key} label={category.label}>
                          {categoryVoices.map((voice) => (
                            <option key={voice.key} value={voice.key}>
                              {voice.displayName}{voice.isClassic ? ' · classic' : ''}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
                <label
                  className="vs-agent__synthetic"
                  title="Adds a subtle robotic edge at playback. Free: no extra provider cost."
                >
                  <input
                    type="checkbox"
                    checked={agent.synthetic}
                    onChange={(e) => setAgentSynthetic(agent.agentId, e.target.checked)}
                    aria-label={`Synthetic voice effect for ${getAgentDisplayName(agent.agentId)}`}
                  />
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 12h3l3-7 4 14 3-9 2 2h5"/>
                  </svg>
                  <span>Synthetic</span>
                </label>
              </div>
            );
          })}
        </div>

        {/* Test error message */}
        {testError && (
          <div className="voice-settings__test-error">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>{testError}</span>
            <button onClick={() => setTestError(null)} aria-label="Dismiss error">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        )}

        {/* Premium upsell */}
        {!isPremiumVoiceAvailable() && (
          <div className="voice-settings__premium-upsell">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span>Voice parameter controls available with <strong>Advanced Voice</strong> plugin</span>
          </div>
        )}
      </section>

      {/* Preprocessing Options */}
      <section className="voice-settings__section">
        <h3>Content Filtering</h3>
        <p className="voice-settings__section-desc">
          Choose what content types to skip when speaking
        </p>

        <div className="voice-settings__preprocessing">
          <label className="voice-settings__toggle">
            <input
              type="checkbox"
              checked={settings.preprocessing.skipCodeBlocks}
              onChange={(e) => update({
                preprocessing: { ...settings.preprocessing, skipCodeBlocks: e.target.checked }
              })}
              aria-label="Skip code blocks"
            />
            <span className="toggle-track"><span className="toggle-thumb"></span></span>
            <span className="toggle-label">Skip Code Blocks</span>
          </label>

          <label className="voice-settings__toggle">
            <input
              type="checkbox"
              checked={settings.preprocessing.skipTables}
              onChange={(e) => update({
                preprocessing: { ...settings.preprocessing, skipTables: e.target.checked }
              })}
              aria-label="Skip tables"
            />
            <span className="toggle-track"><span className="toggle-thumb"></span></span>
            <span className="toggle-label">Skip Tables</span>
          </label>

          <label className="voice-settings__toggle">
            <input
              type="checkbox"
              checked={settings.preprocessing.skipIpAddresses}
              onChange={(e) => update({
                preprocessing: { ...settings.preprocessing, skipIpAddresses: e.target.checked }
              })}
              aria-label="Skip IP addresses"
            />
            <span className="toggle-track"><span className="toggle-thumb"></span></span>
            <span className="toggle-label">Skip IP Addresses</span>
          </label>

          <label className="voice-settings__toggle">
            <input
              type="checkbox"
              checked={settings.preprocessing.skipUrls}
              onChange={(e) => update({
                preprocessing: { ...settings.preprocessing, skipUrls: e.target.checked }
              })}
              aria-label="Skip URLs"
            />
            <span className="toggle-track"><span className="toggle-thumb"></span></span>
            <span className="toggle-label">Skip URLs</span>
          </label>

          <label className="voice-settings__toggle">
            <input
              type="checkbox"
              checked={settings.preprocessing.skipPaths}
              onChange={(e) => update({
                preprocessing: { ...settings.preprocessing, skipPaths: e.target.checked }
              })}
              aria-label="Skip file paths"
            />
            <span className="toggle-track"><span className="toggle-thumb"></span></span>
            <span className="toggle-label">Skip File Paths</span>
          </label>
        </div>
      </section>

      {/* Preview Section */}
      <section className="voice-settings__section">
        <h3>Preview Preprocessing</h3>

        <div className="voice-settings__preview-controls">
          <select
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            aria-label="Select preview text type"
          >
            <option value="simple">Simple response</option>
            <option value="withCode">With code block</option>
            <option value="withTechnical">With IPs & paths</option>
            <option value="withList">Long list</option>
          </select>
          <button
            className="btn btn--secondary"
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            )}
            {showPreview ? 'Hide' : 'Preview'}
          </button>
        </div>

        {preview && (
          <div className="voice-settings__preview">
            <div className="preview-panel preview-panel--original">
              <h4>Original ({preview.original.length} chars)</h4>
              <pre>{preview.original}</pre>
            </div>
            <div className="preview-arrow">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
            </div>
            <div className="preview-panel preview-panel--processed">
              <h4>Spoken ({preview.processed.length} chars)</h4>
              <pre>{preview.processed}</pre>
            </div>
          </div>
        )}
      </section>

      {/* Reset */}
      <section className="voice-settings__section voice-settings__section--actions">
        <button className="btn btn--danger" onClick={() => {
          if (confirm('Reset all voice settings to defaults?')) {
            reset();
          }
        }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
          </svg>
          Reset to Defaults
        </button>
      </section>
    </div>
  );
}

export default VoiceSettings;
