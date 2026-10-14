'use strict';
/**
 * CLI-QUOX B1: read an OpenAI-compatible chat-completions SSE stream
 * (`stream: true`) into the SAME shape the non-streaming JSON path returns:
 *   { choices: [{ finish_reason, message: { role, content, tool_calls? } }], usage }
 * so executeOpenAICompatibleToolLoop's assembly after the call is unchanged.
 *
 * - Text deltas are handed to onTextDelta as they arrive.
 * - tool_calls arrive as fragments keyed by `index` (id and name usually in the
 *   first fragment, arguments split across many); they are concatenated in index order.
 * - An error frame from the provider fails the call (never a silent success).
 * - A stream that closes with neither a finish_reason nor `[DONE]` is incomplete
 *   and fails the call (a half answer must not be reported as complete).
 * - idleTimeoutMs bounds the wait for each next chunk (fetch's own timeout ends
 *   when the headers arrive). The caller's AbortSignal cancels the body read.
 */

function streamError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function readWithIdle(reader, idleTimeoutMs) {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return reader.read();
  let timer;
  const idle = new Promise((_, reject) => {
    timer = setTimeout(() => reject(streamError(`provider stream idle for ${idleTimeoutMs} ms`, 'provider_stream_idle')), idleTimeoutMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

async function readOpenAIChatStream(response, { onTextDelta, idleTimeoutMs = 0, providerLabel = 'OpenAI', interruptWhen } = {}) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    throw streamError(`${providerLabel} returned no stream body`, 'provider_stream_missing');
  }
  const slots = new Map(); // index -> { id, name, args }
  const idToIndex = new Map();
  let lastIndex = 0;
  let content = '';
  // QUOXON: model reasoning (Ollama `reasoning`, vLLM/DeepSeek `reasoning_content`), kept apart
  // from the answer: never handed to onTextDelta, never in content.
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let sawDone = false;
  let interrupted = false;
  // QUOXON steer: checked after every event; never true once a tool call has begun
  // (a call being emitted is never cut off: the loop applies the steer after it).
  const shouldInterrupt = () => {
    if (typeof interruptWhen !== 'function' || slots.size > 0) return false;
    try { return interruptWhen() === true; } catch { return false; }
  };

  const handleData = (raw) => {
    if (raw === '[DONE]') { sawDone = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { return; } // keep-alive or a vendor comment
    if (data && data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error).slice(0, 200));
      throw streamError(`${providerLabel} stream error: ${msg}`, 'provider_stream_error');
    }
    if (data && data.usage) usage = data.usage;
    const choice = Array.isArray(data && data.choices) ? data.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    for (const k of ['reasoning', 'reasoning_content']) {
      if (typeof delta[k] === 'string' && delta[k].length > 0) reasoning += delta[k];
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      if (typeof onTextDelta === 'function') onTextDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        let idx;
        if (Number.isInteger(tc.index)) idx = tc.index;
        else if (tc.id && idToIndex.has(tc.id)) idx = idToIndex.get(tc.id);
        else if (tc.id) idx = slots.size;
        else idx = lastIndex;
        lastIndex = idx;
        const slot = slots.get(idx) || { id: null, name: '', args: '' };
        if (tc.id && !slot.id) { slot.id = tc.id; idToIndex.set(tc.id, idx); }
        const n = tc.function && typeof tc.function.name === 'string' ? tc.function.name : '';
        // Some compatible servers repeat the full name on every fragment; never double it.
        if (n && slot.name !== n) slot.name = slot.name ? slot.name + n : n;
        if (tc.function && typeof tc.function.arguments === 'string') slot.args += tc.function.arguments;
        slots.set(idx, slot);
      }
    }
  };

  const handleEvent = (rawEvent) => {
    const dataLines = [];
    let eventName = null;
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    if (eventName === 'error') {
      let msg = raw;
      try { const j = JSON.parse(raw); msg = (j.error && j.error.message) || j.message || raw; } catch { /* raw text */ }
      throw streamError(`${providerLabel} stream error: ${String(msg).slice(0, 200)}`, 'provider_stream_error');
    }
    handleData(raw);
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

  if (!interrupted && !sawDone && !finishReason) {
    throw streamError(`${providerLabel} stream ended before the answer was complete`, 'provider_stream_incomplete');
  }

  const toolCalls = Array.from(slots.keys()).sort((a, b) => a - b).map((i) => {
    const s = slots.get(i);
    return { id: s.id, type: 'function', function: { name: s.name, arguments: s.args || '{}' } };
  });

  return {
    ...(interrupted ? { steerInterrupted: true } : {}),
    choices: [{
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: content || null,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: usage || {},
  };
}

module.exports = { readOpenAIChatStream, readWithIdle, streamError };
