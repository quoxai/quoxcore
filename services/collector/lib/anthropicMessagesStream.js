'use strict';
/**
 * CLI-QUOX B2: read an Anthropic Messages SSE stream (`stream: true`) into the
 * SAME shape the non-streaming Messages API returns:
 *   { role: 'assistant', content: [blocks], stop_reason, usage }
 * so the governed tool loop assembles the turn the way it would from JSON.
 *
 * - text_delta fragments are handed to onTextDelta as they arrive.
 * - tool_use blocks start with { id, name, input: {} }; their input arrives as
 *   input_json_delta partial_json fragments, concatenated per block index and
 *   parsed at content_block_stop (or at the end). An input that is not valid
 *   JSON is left as {} with `_inputError` set: the loop answers it as an error
 *   tool result and never dispatches a guessed input.
 * - thinking / redacted_thinking blocks are kept (with their signature) so they
 *   can be echoed back verbatim on the next round, as the API requires.
 * - usage: input and cache token counts from message_start, output_tokens from
 *   message_delta (cumulative for the message).
 * - An `error` event fails the call; a stream that closes before message_stop
 *   is incomplete and fails the call (a half answer is never a completed turn).
 * - idleTimeoutMs bounds the wait for each next chunk; the caller's AbortSignal
 *   cancels the body read (AbortError surfaces).
 */

const { readWithIdle, streamError } = require('./openaiChatStream.js');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function readAnthropicMessagesStream(response, { onTextDelta, idleTimeoutMs = 0, providerLabel = 'Anthropic', interruptWhen } = {}) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    throw streamError(`${providerLabel} returned no stream body`, 'provider_stream_missing');
  }
  const blocks = new Map(); // index -> block (tool_use carries _json while open)
  let stopReason = null;
  let sawStop = false;
  let interrupted = false;
  // QUOXON steer: never once a tool_use block has started (finish that call first).
  const shouldInterrupt = () => {
    if (typeof interruptWhen !== 'function') return false;
    for (const b of blocks.values()) if (b.type === 'tool_use') return false;
    try { return interruptWhen() === true; } catch { return false; }
  };
  const usage = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };

  const closeBlock = (b) => {
    if (!b || b.type !== 'tool_use' || b._closed) return;
    b._closed = true;
    const raw = b._json;
    delete b._json;
    if (!raw) { b.input = b.input && typeof b.input === 'object' ? b.input : {}; return; }
    try {
      const parsed = JSON.parse(raw);
      b.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      b.input = {};
      b._inputError = `invalid JSON input (${err.message})`;
    }
  };

  const handleData = (data) => {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'message_start': {
        const u = (data.message && data.message.usage) || {};
        usage.input_tokens = num(u.input_tokens);
        usage.cache_read_input_tokens = num(u.cache_read_input_tokens);
        usage.cache_creation_input_tokens = num(u.cache_creation_input_tokens);
        if (num(u.output_tokens) !== null) usage.output_tokens = u.output_tokens;
        return;
      }
      case 'content_block_start': {
        const cb = data.content_block || {};
        let b;
        if (cb.type === 'text') b = { type: 'text', text: typeof cb.text === 'string' ? cb.text : '' };
        else if (cb.type === 'tool_use') b = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
        else b = { ...cb }; // thinking, redacted_thinking, or a future type: kept as sent
        blocks.set(data.index, b);
        if (b.type === 'text' && b.text && typeof onTextDelta === 'function') onTextDelta(b.text);
        return;
      }
      case 'content_block_delta': {
        const b = blocks.get(data.index);
        const d = data.delta || {};
        if (!b) return;
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          b.text = (b.text || '') + d.text;
          if (typeof onTextDelta === 'function') onTextDelta(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && b.type === 'tool_use') {
          b._json += d.partial_json;
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking = (b.thinking || '') + d.thinking;
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature = (b.signature || '') + d.signature;
        }
        return;
      }
      case 'content_block_stop':
        closeBlock(blocks.get(data.index));
        return;
      case 'message_delta': {
        if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
        const u = data.usage || {};
        if (num(u.output_tokens) !== null) usage.output_tokens = u.output_tokens;
        if (num(u.input_tokens) !== null) usage.input_tokens = u.input_tokens;
        return;
      }
      case 'message_stop':
        sawStop = true;
        return;
      case 'error': {
        const e = data.error || {};
        const msg = e.message || e.type || 'provider_error';
        throw streamError(`${providerLabel} stream error: ${String(msg).slice(0, 200)}`, 'provider_stream_error');
      }
      default: // ping and unknown events
    }
  };

  const handleEvent = (rawEvent) => {
    const dataLines = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return; } // keep-alive or a vendor comment
    handleData(data);
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    outer: for (;;) {
      const { value, done } = await readWithIdle(reader, idleTimeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleEvent(rawEvent);
        if (shouldInterrupt()) { interrupted = true; break outer; }
      }
    }
    if (interrupted) {
      try { await reader.cancel(); } catch { /* already closed */ }
    } else {
      buffer += decoder.decode().replace(/\r/g, '');
      if (buffer.trim()) handleEvent(buffer);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* released by cancel */ }
  }

  if (!interrupted && !sawStop) {
    throw streamError(`${providerLabel} stream ended before the answer was complete`, 'provider_stream_incomplete');
  }

  const content = Array.from(blocks.keys()).sort((a, b) => a - b).map((i) => {
    const b = blocks.get(i);
    if (b.type === 'tool_use' && !b._closed) {
      // Never closed (a max_tokens cut): parse what arrived, mark it incomplete.
      closeBlock(b);
      b._incomplete = true;
    }
    delete b._closed;
    return b;
  });

  return { role: 'assistant', content, stop_reason: stopReason, usage, ...(interrupted ? { steerInterrupted: true } : {}) };
}

module.exports = { readAnthropicMessagesStream };
