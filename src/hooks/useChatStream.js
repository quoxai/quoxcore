/**
 * useChatStream - React Hook for SSE Streaming Chat
 *
 * Provides a React-friendly interface for the chat streaming service.
 * Manages thinking steps, streaming text, and connection state.
 *
 * Usage:
 *   const {
 *     sendMessage,
 *     streamingText,
 *     thinkingSteps,
 *     isStreaming,
 *     isConnected,
 *     error
 *   } = useChatStream({
 *     assistant: 'quox',
 *     onComplete: (result) => addToHistory(result)
 *   });
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createChatStream, sendChatSimple, isStreamingAvailable } from '../services/chatStreamService';
import { useSettings } from './useSettings';

/**
 * useChatStream hook
 *
 * @param {Object} options
 * @param {string} options.assistant - Assistant ID
 * @param {string} options.sessionId - Optional session ID
 * @param {Function} options.onThinking - Called for each thinking step
 * @param {Function} options.onChunk - Called for each text chunk
 * @param {Function} options.onComplete - Called when response is complete
 * @param {Function} options.onError - Called on error
 * @returns {Object} Stream state and controls
 */
export function useChatStream({
    assistant = 'quox',
    sessionId,
    onThinking,
    onChunk,
    onComplete,
    onError
} = {}) {
    const { getSetting } = useSettings();

    // State
    const [isStreaming, setIsStreaming] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [streamingText, setStreamingText] = useState('');
    const [thinkingSteps, setThinkingSteps] = useState([]);
    const [error, setError] = useState(null);
    const [streamAvailable, setStreamAvailable] = useState(null);

    // Refs
    const streamControllerRef = useRef(null);
    const currentSessionIdRef = useRef(sessionId);

    // Update session ref when prop changes
    useEffect(() => {
        currentSessionIdRef.current = sessionId;
    }, [sessionId]);

    // Check streaming availability on mount
    useEffect(() => {
        isStreamingAvailable().then(setStreamAvailable);
    }, []);

    /**
     * Send a message with streaming
     *
     * @param {string} prompt - The user's message
     * @param {Object} context - Optional context to pass
     * @returns {Promise<Object|null>} Result or null if streaming
     */
    const sendMessage = useCallback(async (prompt, context = {}) => {
        if (!prompt?.trim()) return null;

        // Check settings for streaming preference
        const useStreaming = getSetting('useStreaming', true);
        const showThinking = getSetting('showThinking', false);

        // Abort any existing stream
        if (streamControllerRef.current) {
            streamControllerRef.current.abort();
        }

        // Reset state
        setError(null);
        setStreamingText('');
        setThinkingSteps([]);
        setIsStreaming(true);
        setIsConnected(false);

        // If streaming is disabled or unavailable, use simple fallback
        if (!useStreaming || streamAvailable === false) {
            try {
                const result = await sendChatSimple({
                    prompt,
                    assistant,
                    sessionId: currentSessionIdRef.current,
                    context
                });
                setIsStreaming(false);
                onComplete?.(result);
                return result;
            } catch (err) {
                setError(err);
                setIsStreaming(false);
                onError?.(err);
                throw err;
            }
        }

        // Use SSE streaming
        return new Promise((resolve, reject) => {
            streamControllerRef.current = createChatStream({
                prompt,
                assistant,
                sessionId: currentSessionIdRef.current,
                context,

                onConnected: ({ queryId }) => {
                    setIsConnected(true);
                },

                onThinking: (step, allSteps) => {
                    // Only update state if showThinking is enabled
                    if (showThinking) {
                        setThinkingSteps([...allSteps]);
                    }
                    onThinking?.(step, allSteps);
                },

                onChunk: (chunk, fullText) => {
                    setStreamingText(fullText);
                    onChunk?.(chunk, fullText);
                },

                onDone: (result) => {
                    setIsStreaming(false);
                    setIsConnected(false);
                    streamControllerRef.current = null;
                    onComplete?.(result);
                    resolve(result);
                },

                onError: (err) => {
                    setError(err);
                    setIsStreaming(false);
                    setIsConnected(false);
                    streamControllerRef.current = null;
                    onError?.(err);
                    reject(err);
                }
            });
        });
    }, [assistant, getSetting, streamAvailable, onThinking, onChunk, onComplete, onError]);

    /**
     * Abort the current stream
     */
    const abort = useCallback(() => {
        if (streamControllerRef.current) {
            streamControllerRef.current.abort();
            streamControllerRef.current = null;
            setIsStreaming(false);
            setIsConnected(false);
        }
    }, []);

    /**
     * Clear thinking steps
     */
    const clearThinking = useCallback(() => {
        setThinkingSteps([]);
    }, []);

    /**
     * Clear all state
     */
    const reset = useCallback(() => {
        abort();
        setStreamingText('');
        setThinkingSteps([]);
        setError(null);
    }, [abort]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (streamControllerRef.current) {
                streamControllerRef.current.abort();
            }
        };
    }, []);

    return {
        // State
        isStreaming,
        isConnected,
        streamingText,
        thinkingSteps,
        error,
        streamAvailable,

        // Actions
        sendMessage,
        abort,
        clearThinking,
        reset
    };
}

/**
 * useThinkingSteps - Convenience hook for just thinking steps
 *
 * @param {boolean} enabled - Whether thinking display is enabled
 * @returns {Object} Thinking state and controls
 */
export function useThinkingSteps(enabled = true) {
    const [steps, setSteps] = useState([]);
    const [isActive, setIsActive] = useState(false);

    const addStep = useCallback((step) => {
        if (!enabled) return;
        setSteps(prev => [...prev, step]);
        setIsActive(true);
    }, [enabled]);

    const complete = useCallback(() => {
        setIsActive(false);
    }, []);

    const clear = useCallback(() => {
        setSteps([]);
        setIsActive(false);
    }, []);

    return {
        steps,
        isActive,
        addStep,
        complete,
        clear
    };
}

export default useChatStream;
