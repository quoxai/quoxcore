'use strict';
/**
 * CLI-QUOXON R1 (#2, #34): incremental parser for the Anthropic Messages SSE
 * stream. fetch() yields Uint8Array chunks, so decode with ONE streaming
 * TextDecoder (a multi-byte character may straddle chunks) and keep partial
 * lines across chunks. Completion is only claimed after message_stop: a
 * provider `error` event or a premature EOF is a failure, never success.
 */

function createAnthropicSseParser({ onText } = {}) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const state = { text: '', chunkCount: 0, sawStop: false, error: null };

  function handleLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).replace(/^ /, '');
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    if (event.type === 'content_block_delta' && event.delta?.text) {
      state.text += event.delta.text;
      state.chunkCount++;
      if (typeof onText === 'function') onText(event.delta.text);
    } else if (event.type === 'message_stop') {
      state.sawStop = true;
    } else if (event.type === 'error') {
      state.error = (event.error && (event.error.message || event.error.type)) || 'provider_error';
    }
  }

  function push(chunk) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const l of lines) handleLine(l);
  }

  /** Flush the decoder and any final unterminated line; returns the state. */
  function end() {
    buffer += decoder.decode();
    if (buffer) { handleLine(buffer); buffer = ''; }
    return state;
  }

  return { push, end, state };
}

module.exports = { createAnthropicSseParser };
