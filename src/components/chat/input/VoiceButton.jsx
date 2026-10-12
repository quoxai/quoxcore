/**
 * VoiceButton - Reusable Push-to-Talk Component
 *
 * Handles voice recording with visual feedback.
 * Can be used standalone or as part of ChatInput.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import './voice-button.css';

const API_BASE = '/webhook';

export function VoiceButton({
    onTranscription,      // Called with transcribed text
    onStateChange,        // Called with 'idle' | 'recording' | 'transcribing' | 'error'
    onError,              // Called with error message string
    disabled = false,
    size = 'medium',      // 'small' | 'medium' | 'large'
    className = '',
    showTimer = true,
    maxDuration = 30000,  // Max recording duration in ms
    enableKeyboard = true // Enable Space bar push-to-talk (disable in terminal context)
}) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [isTranscribing, setIsTranscribing] = useState(false);

    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const timerRef = useRef(null);
    const maxTimeoutRef = useRef(null);
    const voiceStatusRef = useRef(null); // cached voice key status

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearInterval(timerRef.current);
            clearTimeout(maxTimeoutRef.current);
            if (mediaRecorderRef.current?.state === 'recording') {
                mediaRecorderRef.current.stop();
            }
        };
    }, []);

    const startRecording = useCallback(async () => {
        if (disabled || isRecording || isTranscribing) return;

        try {
            // Preflight: check if voice API keys are configured (cached after first check)
            if (!voiceStatusRef.current) {
                try {
                    const resp = await fetch('/webhook/voice-status', { signal: AbortSignal.timeout(3000) });
                    if (resp.ok) voiceStatusRef.current = await resp.json();
                } catch { /* continue — will fail at transcription step with a clear error */ }
            }
            if (voiceStatusRef.current && !voiceStatusRef.current.stt) {
                onStateChange?.('error');
                onError?.('Speech-to-text is not configured. Add your OpenAI API key in Settings \u2192 Core Integrations.');
                return;
            }

            // Check for secure context (HTTPS or localhost) before attempting mic access
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('SECURE_CONTEXT');
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                stream.getTracks().forEach(track => track.stop());
                clearInterval(timerRef.current);
                clearTimeout(maxTimeoutRef.current);

                // Transcribe
                setIsTranscribing(true);
                onStateChange?.('transcribing');

                try {
                    const formData = new FormData();
                    formData.append('audio', audioBlob, 'recording.webm');

                    const response = await fetch(`${API_BASE}/transcribe`, {
                        method: 'POST',
                        body: formData
                    });

                    if (!response.ok) {
                        let errorMsg = 'Voice transcription failed.';
                        // Try to parse the JSON error from backend
                        let serverError = null;
                        try { serverError = await response.json(); } catch { /* ignore */ }

                        if (response.status === 503 || response.status === 401 || response.status === 403) {
                            // API key not configured — give clear instructions
                            const detail = serverError?.error || '';
                            if (detail.includes('ElevenLabs')) {
                                errorMsg = 'ElevenLabs API key not configured. Go to Settings → Core Integrations to add it.';
                            } else if (detail.includes('OpenAI') || detail.includes('API key')) {
                                errorMsg = 'OpenAI API key not configured. Go to Settings → Core Integrations to add it.';
                            } else {
                                errorMsg = 'Voice API key not configured. Go to Settings → Core Integrations to add your API keys.';
                            }
                        } else if (response.status === 404) {
                            errorMsg = 'Voice transcription service not available. Check that the collector service is running.';
                        } else if (response.status >= 500) {
                            errorMsg = `Voice service error (${response.status}). ${serverError?.error || 'Check collector logs for details.'}`;
                        }
                        onStateChange?.('error');
                        onError?.(errorMsg);
                        return;
                    }

                    const data = await response.json();
                    const transcript = data.transcription || data.text || '';

                    if (transcript.trim()) {
                        onTranscription?.(transcript.trim());
                    } else {
                        onError?.('No speech detected. Try speaking louder or closer to your microphone.');
                    }
                } catch (err) {
                    console.error('[VoiceButton] Transcription error:', err);
                    const errMsg = err.message?.includes('Failed to fetch')
                        ? 'Cannot reach voice service. Check your API keys in Settings → Core Integrations.'
                        : `Transcription error: ${err.message}`;
                    onError?.(errMsg);
                } finally {
                    setIsTranscribing(false);
                    setRecordingTime(0);
                    onStateChange?.('idle');
                }
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
            setRecordingTime(0);
            onStateChange?.('recording');

            // Start timer
            timerRef.current = setInterval(() => {
                setRecordingTime(t => t + 1);
            }, 1000);

            // Max duration timeout
            maxTimeoutRef.current = setTimeout(() => {
                stopRecording();
            }, maxDuration);

        } catch (err) {
            console.error('[VoiceButton] Microphone access error:', err);
            let errorMsg = 'Could not access microphone';

            if (err.message === 'SECURE_CONTEXT' || !navigator.mediaDevices || err.name === 'TypeError') {
                errorMsg = window.location.protocol === 'http:'
                    ? `Microphone requires a secure connection. You're on HTTP (${window.location.host}) - use localhost or HTTPS.`
                    : 'Microphone requires HTTPS. Try accessing via localhost or configure HTTPS.';
            } else if (err.name === 'NotAllowedError') {
                errorMsg = 'Microphone access not granted. Click the lock icon in your address bar → Site settings → Allow microphone.';
            } else if (err.name === 'NotFoundError') {
                errorMsg = 'No microphone detected. Connect a microphone and try again.';
            } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
                errorMsg = 'Microphone is in use by another application. Close other apps using audio and try again.';
            }

            onStateChange?.('error');
            onError?.(errorMsg);
        }
    }, [disabled, isRecording, isTranscribing, maxDuration, onTranscription, onStateChange, onError]);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    }, []);

    // Keyboard support (Space bar) — disabled in terminal context to avoid conflicts
    useEffect(() => {
        if (!enableKeyboard) return;

        const handleKeyDown = (e) => {
            // Only trigger if not in an input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.code === 'Space' && !isRecording && !e.repeat) {
                e.preventDefault();
                startRecording();
            }
        };

        const handleKeyUp = (e) => {
            if (e.code === 'Space' && isRecording) {
                e.preventDefault();
                stopRecording();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [enableKeyboard, isRecording, startRecording, stopRecording]);

    const buttonClass = [
        'voice-button',
        `voice-button--${size}`,
        isRecording && 'voice-button--recording',
        isTranscribing && 'voice-button--transcribing',
        disabled && 'voice-button--disabled',
        className
    ].filter(Boolean).join(' ');

    return (
        <button
            type="button"
            className={buttonClass}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={isRecording ? stopRecording : undefined}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            disabled={disabled || isTranscribing}
            title={isRecording ? 'Release to send' : isTranscribing ? 'Transcribing...' : 'Hold to speak'}
        >
            {isRecording ? (
                <>
                    <svg viewBox="0 0 24 24" className="voice-button__icon" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <circle cx="12" cy="12" r="6"/>
                    </svg>
                    {showTimer && <span className="voice-button__timer">{recordingTime}s</span>}
                </>
            ) : isTranscribing ? (
                <svg viewBox="0 0 24 24" className="voice-button__icon voice-button__icon--spin" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                    <path d="M12 2v4m0 12v4m-8-10H2m20 0h-2m-2.93-6.07l-1.41 1.41m-9.32 9.32l-1.41 1.41m0-12.14l1.41 1.41m9.32 9.32l1.41 1.41"/>
                </svg>
            ) : (
                <svg viewBox="0 0 24 24" className="voice-button__icon" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
            )}
        </button>
    );
}

export default VoiceButton;
