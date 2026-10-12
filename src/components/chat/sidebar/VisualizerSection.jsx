/**
 * VisualizerSection - Collapsible Visualizer for Sidebars
 *
 * Features:
 * - Agent-specific visualizer via VisualizerHost
 * - Collapse/expand toggle
 * - Popout button for external display
 * - Push-to-talk button
 * - Status badge
 * - Persists collapse preference
 *
 * Works with any agent's visualizer theme.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import VisualizerHost from '../../visualizations-v2/VisualizerHost';
import { VoiceButton } from '../input/VoiceButton';
import { useMuteState } from '../../../hooks/useVoiceSettings';
import { getAgentVoice, getVerbosityConfig, updateSettings, loadSettings, VERBOSITY_MODES, VOICE_LIBRARY } from '../../../services/voiceSettings';
import { getBackgroundOpacity } from '../../../services/visualizationStudioService';
import './visualizer-section.css';

/**
 * QuickVoiceControls — Compact inline voice controls
 * Mute toggle, verbosity switcher (Q/N/V), current voice name
 */
function QuickVoiceControls({ agent }) {
    const { muted, toggle: toggleMute } = useMuteState();
    const [verbosity, setVerbosity] = useState(() => loadSettings().verbosity || 'normal');
    const agentVoice = getAgentVoice(agent);

    const cycleVerbosity = (key) => {
        updateSettings({ verbosity: key });
        setVerbosity(key);
    };

    const verbosityKeys = ['quiet', 'normal', 'verbose'];
    const verbosityLabels = { quiet: 'Q', normal: 'N', verbose: 'V' };
    const verbosityTitles = { quiet: 'Quiet (150 chars)', normal: 'Normal (500 chars)', verbose: 'Verbose (1000 chars)' };

    return (
        <div className="visualizer-section__quick-voice">
            {/* Mute toggle */}
            <button
                className={`visualizer-section__qv-btn ${muted ? 'visualizer-section__qv-btn--active' : ''}`}
                onClick={toggleMute}
                title={muted ? 'Unmute voice' : 'Mute voice'}
            >
                {muted ? (
                    <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <path d="M11 5L6 9H2v6h4l5 5V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                    </svg>
                ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/>
                    </svg>
                )}
            </button>

            {/* Verbosity switcher */}
            <div className="visualizer-section__qv-verbosity">
                {verbosityKeys.map(key => (
                    <button
                        key={key}
                        className={`visualizer-section__qv-verb-btn ${verbosity === key ? 'visualizer-section__qv-verb-btn--active' : ''}`}
                        onClick={() => cycleVerbosity(key)}
                        title={verbosityTitles[key]}
                    >
                        {verbosityLabels[key]}
                    </button>
                ))}
            </div>

            {/* Current voice label */}
            <span className="visualizer-section__qv-voice-label" title={agentVoice?.displayName || 'Default'}>
                {(agentVoice?.displayName || 'Default').split(' (')[0]}
            </span>
        </div>
    );
}

export function VisualizerSection({
    agent = 'quox',
    state = 'idle',
    audioData = null,
    showStatus = true,
    showControls = true,
    showVoice = true,
    onVoiceTranscription,
    defaultCollapsed = false,
    storageKey = 'quox-visualizer-collapsed',
    className = ''
}) {
    const navigate = useNavigate();
    const [voiceState, setVoiceState] = useState('idle');
    const [voiceError, setVoiceError] = useState(null);
    const voiceErrorTimerRef = useRef(null);
    const [bgOpacity, setBgOpacity] = useState(() => getBackgroundOpacity());
    const [isCollapsed, setIsCollapsed] = useState(() => {
        if (storageKey) {
            const stored = localStorage.getItem(storageKey);
            // Honour defaultCollapsed when there's no stored preference yet,
            // so callers (e.g. DevShell-mode sidebars) can default-collapse.
            if (stored !== null) return stored === 'true';
        }
        return defaultCollapsed;
    });

    // Listen for background opacity changes
    useEffect(() => {
        const handleChange = (event) => {
            if (event.detail?.backgroundOpacity) {
                setBgOpacity(getBackgroundOpacity());
            }
        };
        window.addEventListener('quox-viz-studio-change', handleChange);
        return () => window.removeEventListener('quox-viz-studio-change', handleChange);
    }, []);

    // Cleanup error timer on unmount
    useEffect(() => {
        return () => clearTimeout(voiceErrorTimerRef.current);
    }, []);

    const handleVoiceError = useCallback((errorMsg) => {
        setVoiceError(errorMsg);
        setVoiceState('idle');
        clearTimeout(voiceErrorTimerRef.current);
        voiceErrorTimerRef.current = setTimeout(() => setVoiceError(null), 8000);
    }, []);

    // Persist collapse state
    useEffect(() => {
        if (storageKey) {
            localStorage.setItem(storageKey, isCollapsed);
        }
    }, [isCollapsed, storageKey]);

    const openPopout = () => {
        const params = new URLSearchParams({
            assistant: agent,
            state: state
        });
        window.open(
            `/visualizer-popup?${params}`,
            'QuoxCORE Visualizer',
            'width=800,height=800,resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no,location=no'
        );
    };

    const openAgentVisualiserSettings = () => {
        navigate('/settings', { state: { section: 'assistants', editAgent: agent, editTab: 'visualization' } });
    };

    const openAgentVoiceSettings = () => {
        navigate('/settings', { state: { section: 'voice' } });
    };

    const containerClass = [
        'visualizer-section',
        isCollapsed && 'visualizer-section--collapsed',
        className
    ].filter(Boolean).join(' ');

    const stateLabels = {
        idle: 'System Ready',
        thinking: 'Processing...',
        speaking: 'Speaking...',
        listening: 'Listening...',
        error: 'Error'
    };

    return (
        <div className={containerClass}>
            {/* Controls */}
            {showControls && !isCollapsed && (
                <div className="visualizer-section__controls">
                    <button
                        className="visualizer-section__btn"
                        onClick={() => setIsCollapsed(true)}
                        title="Hide visualizer"
                    >
                        <svg viewBox="0 0 24 24" width="12" height="12" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M18 15l-6-6-6 6"/></svg>
                    </button>
                    <button
                        className="visualizer-section__btn"
                        onClick={openAgentVoiceSettings}
                        title="Voice settings"
                    >
                        <svg viewBox="0 0 24 24" width="12" height="12" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
                    </button>
                    <button
                        className="visualizer-section__btn"
                        onClick={openAgentVisualiserSettings}
                        title="Visualiser settings"
                    >
                        <svg viewBox="0 0 24 24" width="12" height="12" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                    </button>
                    <button
                        className="visualizer-section__btn"
                        onClick={openPopout}
                        title="Open in popup window"
                    >
                        <svg viewBox="0 0 24 24" width="12" height="12" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                </div>
            )}

            {/* Restore bar when collapsed */}
            {showControls && isCollapsed && (
                <button
                    className="visualizer-section__restore"
                    onClick={() => setIsCollapsed(false)}
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(56,189,248,0.8)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                    Show Visualizer
                </button>
            )}

            {/* Collapsible content */}
            <div className="visualizer-section__content">
                <div className="visualizer-section__visualizer">
                    <VisualizerHost
                        assistantId={agent}
                        state={voiceState !== 'idle' ? voiceState : state}
                        audioData={audioData}
                    />
                </div>

                {/* Push-to-talk button */}
                {showVoice && onVoiceTranscription && (
                    <div className="visualizer-section__voice">
                        <VoiceButton
                            onTranscription={onVoiceTranscription}
                            onStateChange={(s) => setVoiceState(s === 'recording' ? 'listening' : s === 'transcribing' ? 'thinking' : s === 'error' ? 'error' : 'idle')}
                            onError={handleVoiceError}
                            size="large"
                            showTimer={true}
                        />
                        <span className="visualizer-section__voice-hint">
                            {voiceState === 'recording' ? 'Release to send' : voiceState === 'transcribing' ? 'Transcribing...' : 'Hold to speak'}
                        </span>
                        {voiceError && (
                            <div className="visualizer-section__voice-error" onClick={() => setVoiceError(null)}>
                                <span style={{ fontSize: 14, flexShrink: 0 }}>⚠</span>
                                <span>{voiceError}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Quick voice controls */}
                <QuickVoiceControls agent={agent} />

                {/* Status badge */}
                {showStatus && (
                    <div className={`visualizer-section__status visualizer-section__status--${voiceState !== 'idle' ? voiceState : state}`}>
                        <span className="visualizer-section__status-dot"></span>
                        <span className="visualizer-section__status-label">
                            {voiceState === 'recording' ? 'Listening...' :
                             voiceState === 'transcribing' ? 'Processing...' :
                             stateLabels[state] || state}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

export default VisualizerSection;
