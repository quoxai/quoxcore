/**
 * chatStreamService - SSE Streaming Service for Chat
 *
 * Streams SSE from POST /chat/stream (prompt in the body, never the URL; quox#782).
 * Provides real-time thinking events, response chunks, and completion signals.
 *
 * Usage:
 *   const stream = createChatStream({
 *     prompt: 'Hello',
 *     assistant: 'quox',
 *     onThinking: (step) => console.log('Thinking:', step),
 *     onChunk: (text) => setResponse(prev => prev + text),
 *     onDone: (result) => console.log('Done:', result),
 *     onError: (error) => console.error('Error:', error)
 *   });
 *
 *   // To cancel:
 *   stream.abort();
 */

// Collector base URL (proxied through nginx)
const COLLECTOR_URL = '/collector';

/**
 * Create a unique query ID for tracking
 */
function generateQueryId() {
    return `Q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a chat stream connection
 *
 * @param {Object} options
 * @param {string} options.prompt - The user's query
 * @param {string} options.assistant - Assistant ID (e.g., 'quox', 'cipher')
 * @param {string} options.sessionId - Optional session ID for conversation continuity
 * @param {Object} options.context - Optional context object to pass
 * @param {Function} options.onThinking - Called for each thinking step
 * @param {Function} options.onChunk - Called for each text chunk
 * @param {Function} options.onDone - Called when stream completes
 * @param {Function} options.onError - Called on error
 * @param {Function} options.onConnected - Called when connection established
 * @returns {Object} Stream controller with abort() method
 */
export function createChatStream({
    prompt,
    assistant = 'quox',
    sessionId,
    context,
    onThinking,
    onChunk,
    onDone,
    onError,
    onConnected
}) {
    const queryId = generateQueryId();
    let abortController = null;
    let isAborted = false;
    let thinkingSteps = [];
    let fullResponse = '';

    // quox#782: the prompt and context travel in a POST body, never in the URL
    // (access logs, browser history, proxies). The SSE response streams back on
    // the same POST connection, read with fetch instead of EventSource.
    const body = {
        query_id: queryId,
        prompt,
        assistant
    };

    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) body.timezone = tz;
    } catch (_) { /* timezone is best-effort */ }

    if (sessionId) body.session_id = sessionId;
    if (context) body.context = context;

    const streamUrl = `${COLLECTOR_URL}/chat/stream`;

    const handleEvent = (data) => {
        switch (data.type) {
            case 'connected':
                console.log('[ChatStream] Stream connected:', data.query_id);
                onConnected?.({ queryId: data.query_id });
                break;

            case 'thinking': {
                const step = {
                    id: `${queryId}_${thinkingSteps.length}`,
                    agent: data.agent,
                    message: data.message,
                    stage: data.stage,
                    ts: data.ts,
                    routing: data.routing
                };
                thinkingSteps.push(step);
                onThinking?.(step, thinkingSteps);
                break;
            }

            case 'chunk':
                fullResponse += data.content;
                onChunk?.(data.content, fullResponse);
                break;

            case 'done':
                console.log('[ChatStream] Complete:', queryId);
                finished = true;
                abortController.abort();
                onDone?.({
                    queryId,
                    fullResponse: data.full_response || fullResponse,
                    sessionId: data.session_id,
                    costUsd: data.cost_usd,
                    agentUsed: data.agent_used,
                    elapsedMs: data.elapsed_ms,
                    thinkingSteps,
                    routing: data.routing
                });
                break;

            case 'error':
                console.error('[ChatStream] Error:', data.error);
                finished = true;
                abortController.abort();
                onError?.(new Error(data.error));
                break;

            default:
                console.log('[ChatStream] Unknown event type:', data.type);
        }
    };

    let finished = false;

    const run = async () => {
        abortController = new AbortController();
        const response = await fetch(streamUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            credentials: 'include',
            body: JSON.stringify(body),
            signal: abortController.signal
        });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.json())?.message || ''; } catch (_) { /* not json */ }
            throw new Error(detail || `Failed to connect to stream (${response.status})`);
        }
        console.log('[ChatStream] Connected:', queryId);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!finished && !isAborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
                if (dataLines.length === 0) continue; // keep-alive comment
                const payload = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
                if (isAborted) return;
                try {
                    handleEvent(JSON.parse(payload));
                } catch (parseError) {
                    console.warn('[ChatStream] Failed to parse event:', parseError);
                }
                if (finished) return;
            }
        }
        if (!finished && !isAborted) {
            finished = true;
            onError?.(new Error('Stream closed unexpectedly'));
        }
    };

    run().catch((err) => {
        if (isAborted || finished) return;
        finished = true;
        console.error('[ChatStream] Connection error:', err);
        onError?.(err instanceof Error ? err : new Error('Connection lost'));
    });

    // Return controller object
    return {
        queryId,
        abort: () => {
            isAborted = true;
            if (abortController) {
                abortController.abort();
                console.log('[ChatStream] Aborted:', queryId);
            }
        },
        getThinkingSteps: () => [...thinkingSteps],
        getFullResponse: () => fullResponse
    };
}

/**
 * Simple non-streaming chat fallback
 *
 * @param {Object} options
 * @param {string} options.prompt - The user's query
 * @param {string} options.assistant - Assistant ID
 * @param {string} options.sessionId - Optional session ID
 * @param {Object} options.context - Optional context
 * @returns {Promise<Object>} Response object
 */
export async function sendChatSimple({ prompt, assistant, sessionId, context }) {
    const response = await fetch(`${COLLECTOR_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt,
            selected_agent: assistant,
            session_id: sessionId,
            context,
            timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (_) { return undefined; } })()
        })
    });

    if (!response.ok) {
        throw new Error(`Chat failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

/**
 * Check if SSE streaming is supported and available
 *
 * @returns {Promise<boolean>} True if streaming is available
 */
export async function isStreamingAvailable() {
    try {
        const response = await fetch(`${COLLECTOR_URL}/health`, {
            method: 'GET',
            timeout: 3000
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Get the collector URL for debugging
 */
export function getCollectorUrl() {
    return COLLECTOR_URL;
}

export default {
    createChatStream,
    sendChatSimple,
    isStreamingAvailable,
    getCollectorUrl
};
