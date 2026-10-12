/**
 * GlassChatPanel — Unified glass-style chat panel
 *
 * Replaces the separate ThinkingDisplay + VisualizerSection + ChatInput
 * with a single cohesive component using the Quox Glass Design System.
 *
 * Variants:
 *   - full: Command Center chat (StatusBar + messages + Input with all features)
 *   - compact: Sidebar chats (minimal StatusBar + messages + compact Input)
 *
 * @see docs/UC_COMPONENT_SPEC.md
 */

import { useState, useEffect, useRef } from 'react';
import { StatusBar } from './StatusBar';
import { InputArea } from './InputArea';
import './GlassChatPanel.css';

export function GlassChatPanel({
    variant = 'full',
    agent = 'quox',
    halState = 'idle',
    isProcessing = false,
    thinkingSteps = [],
    currentCorr,
    onSend,
    placeholder,
    enableVoice = true,
    enableFileUpload = false,
    onFilesSelected,
    pendingFiles = [],
    onVoiceTranscription,
    maxRows,
    hints,
    disabled = false,
    voiceKeyboard = true,
    onStop,
    className = '',
    children,
}) {
    const [elapsedTime, setElapsedTime] = useState(0);
    const [debouncedProcessing, setDebouncedProcessing] = useState(isProcessing);
    const startTimeRef = useRef(null);
    const hideTimerRef = useRef(null);

    // Debounce isProcessing: show immediately, delay hide by 200ms
    useEffect(() => {
        if (isProcessing) {
            if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
            setDebouncedProcessing(true);
        } else {
            hideTimerRef.current = setTimeout(() => {
                setDebouncedProcessing(false);
            }, 200);
        }
        return () => {
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        };
    }, [isProcessing]);

    // Track elapsed time
    useEffect(() => {
        if (debouncedProcessing) {
            startTimeRef.current = Date.now();
            const interval = setInterval(() => {
                setElapsedTime(Date.now() - startTimeRef.current);
            }, 100);
            return () => clearInterval(interval);
        } else {
            setElapsedTime(0);
        }
    }, [debouncedProcessing]);

    const containerClass = [
        'gcp',
        `gcp--${variant}`,
        debouncedProcessing && 'gcp--active',
        className,
    ].filter(Boolean).join(' ');

    return (
        <div className={containerClass}>
            {/* Shimmer overlay */}
            <div className="gcp__shimmer" />

            {/* Status bar — AOCL layers + thinking */}
            <StatusBar
                variant={variant}
                isProcessing={debouncedProcessing}
                thinkingSteps={thinkingSteps}
                elapsedTime={elapsedTime}
            />

            {/* Message slot */}
            {children && (
                <div className="gcp__messages">
                    {children}
                </div>
            )}

            {/* Input area */}
            <InputArea
                variant={variant}
                onSend={onSend}
                onStop={onStop}
                placeholder={placeholder}
                isProcessing={isProcessing}
                disabled={disabled}
                enableVoice={enableVoice}
                enableFileUpload={enableFileUpload}
                voiceKeyboard={voiceKeyboard}
                onFilesSelected={onFilesSelected}
                pendingFiles={pendingFiles}
                maxRows={maxRows}
                hints={hints}
            />
        </div>
    );
}

export default GlassChatPanel;
