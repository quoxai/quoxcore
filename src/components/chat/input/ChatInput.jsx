/**
 * ChatInput - Reusable Chat Input Component
 *
 * Features:
 * - Auto-resizing textarea
 * - Voice input (push-to-talk)
 * - File upload button (optional)
 * - Send button (transforms to stop button when processing)
 * - Queue indicator when processing
 *
 * Customizable via props and CSS variables.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { VoiceButton } from './VoiceButton';
import './chat-input.css';

export function ChatInput({
    onSend,                    // Called with message text
    onStop,                    // Called to abort in-flight request
    placeholder = 'Type a message...',
    isProcessing = false,      // Show queue mode
    disabled = false,
    enableVoice = true,        // Show voice button
    enableFileUpload = false,  // Show file upload button
    voiceKeyboard = true,      // Enable Space bar for voice (disable in terminal)
    onFilesSelected,           // Called with File[]
    pendingFiles = [],         // Files waiting to be sent
    className = '',
    maxRows = 6,
    hints = true               // Show keyboard hints
}) {
    const [text, setText] = useState('');
    const [voiceError, setVoiceError] = useState(null);
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const voiceErrorTimerRef = useRef(null);

    // Auto-resize textarea
    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        textarea.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
        const maxHeight = lineHeight * maxRows;
        textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }, [text, maxRows]);

    // Cleanup voice error timer on unmount
    useEffect(() => {
        return () => clearTimeout(voiceErrorTimerRef.current);
    }, []);

    // Handle submit
    const handleSubmit = useCallback((e) => {
        e?.preventDefault();
        const trimmed = text.trim();
        if (trimmed || pendingFiles.length > 0) {
            onSend?.(trimmed || `[Attached ${pendingFiles.length} file(s)]`);
            setText('');
            if (textareaRef.current) {
                textareaRef.current.style.height = 'auto';
            }
        }
    }, [text, pendingFiles, onSend]);

    // Handle keyboard
    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    // Handle voice transcription
    const handleVoiceTranscription = useCallback((transcript) => {
        if (transcript) {
            onSend?.(transcript);
        }
    }, [onSend]);

    // Handle voice errors — show briefly then auto-clear
    const handleVoiceError = useCallback((errorMsg) => {
        setVoiceError(errorMsg);
        clearTimeout(voiceErrorTimerRef.current);
        voiceErrorTimerRef.current = setTimeout(() => setVoiceError(null), 6000);
    }, []);

    // Handle file selection
    const handleFileChange = useCallback((e) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
            onFilesSelected?.(files);
        }
        e.target.value = '';
    }, [onFilesSelected]);

    // Stop button handler
    const handleStop = useCallback((e) => {
        e?.preventDefault();
        e?.stopPropagation();
        onStop?.();
    }, [onStop]);

    const containerClass = [
        'chat-input',
        isProcessing && 'chat-input--processing',
        pendingFiles.length > 0 && 'chat-input--has-files',
        disabled && 'chat-input--disabled',
        className
    ].filter(Boolean).join(' ');

    const showStopButton = isProcessing && onStop && !text.trim();

    return (
        <div className={containerClass}>
            <form className="chat-input__form" onSubmit={handleSubmit}>
                <div className="chat-input__row">
                    {/* File upload button */}
                    {enableFileUpload && (
                        <>
                            <button
                                type="button"
                                className="chat-input__file-btn"
                                onClick={() => fileInputRef.current?.click()}
                                title="Attach files"
                            >
                                <svg viewBox="0 0 24 24" width="18" height="18" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.6)', strokeWidth: 2 }}>
                                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                                </svg>
                                {pendingFiles.length > 0 && (
                                    <span className="chat-input__file-badge">{pendingFiles.length}</span>
                                )}
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                onChange={handleFileChange}
                                style={{ display: 'none' }}
                            />
                        </>
                    )}

                    {/* Voice button */}
                    {enableVoice && (
                        <VoiceButton
                            onTranscription={handleVoiceTranscription}
                            onError={handleVoiceError}
                            disabled={disabled}
                            size="small"
                            className="chat-input__voice-btn"
                            showTimer={false}
                            enableKeyboard={voiceKeyboard}
                        />
                    )}

                    {/* Text input */}
                    <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={
                            isProcessing
                                ? 'Type to queue a follow-up...'
                                : pendingFiles.length > 0
                                    ? `${pendingFiles.length} file(s) attached...`
                                    : placeholder
                        }
                        className="chat-input__textarea"
                        rows={1}
                        disabled={disabled}
                    />

                    {/* Send or Stop button */}
                    {showStopButton ? (
                        <button
                            type="button"
                            onClick={handleStop}
                            className="chat-input__stop-btn"
                            title="Stop generating (Esc)"
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: '#ff6050', stroke: 'none' }}>
                                <rect x="6" y="6" width="12" height="12" rx="2"/>
                            </svg>
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={disabled || (!text.trim() && pendingFiles.length === 0)}
                            className={`chat-input__send-btn ${isProcessing ? 'chat-input__send-btn--queue' : ''}`}
                            title={isProcessing ? 'Message will be queued' : 'Send message'}
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" style={{ fill: 'none', stroke: '#38bdf8', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                            </svg>
                        </button>
                    )}
                </div>

                {/* Keyboard hints */}
                {hints && (
                    <div className="chat-input__hints">
                        <span><kbd>Enter</kbd> send</span>
                        <span><kbd>Shift+Enter</kbd> new line</span>
                        {enableVoice && <span><kbd>Space</kbd> voice</span>}
                    </div>
                )}

                {/* Voice error feedback */}
                {voiceError && (
                    <div className="chat-input__voice-error" onClick={() => setVoiceError(null)}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        {voiceError}
                    </div>
                )}
            </form>
        </div>
    );
}

export default ChatInput;
