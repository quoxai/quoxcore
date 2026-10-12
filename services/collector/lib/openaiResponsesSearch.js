'use strict';

/**
 * OpenAI Responses API leg for native-web-search (research) turns.
 *
 * Research turns need no Quox function tools, so this sends ONLY the built-in
 * web_search tool. Any failure returns { ok: false } so the caller can fall
 * back to the Chat Completions path (with the "not available" line). Error
 * bodies are never parsed as data; only the status is reported.
 */

const { flattenOpenAIMessageContent } = require('./openaiRequest.js');

const DEFAULT_URL = 'https://api.openai.com/v1/responses';

function buildInput(userMessage, conversation_history) {
  const input = [];
  if (Array.isArray(conversation_history)) {
    for (const turn of conversation_history) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const content = flattenOpenAIMessageContent(turn.content);
      if (!content) continue;
      input.push({ role: turn.role, content });
    }
  }
  input.push({ role: 'user', content: userMessage });
  return input;
}

function parseResponsesOutput(data) {
  const items = Array.isArray(data?.output) ? data.output : [];
  let text = typeof data?.output_text === 'string' ? data.output_text : '';
  const urls = [];
  let searched = false;
  const parts = [];
  for (const item of items) {
    if (item?.type === 'web_search_call') searched = true;
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type !== 'output_text') continue;
        if (typeof c.text === 'string') parts.push(c.text);
        for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
          if (a?.type === 'url_citation' && typeof a.url === 'string' && /^https?:\/\//.test(a.url) && !urls.includes(a.url)) urls.push(a.url);
        }
      }
    }
  }
  if (!text) text = parts.join('\n');
  const missing = urls.filter((u) => !text.includes(u));
  if (text && missing.length > 0) text = `${text}\n\nSources:\n${missing.map((u) => `- ${u}`).join('\n')}`;
  return { text, searched };
}

async function invokeOpenAiResponsesSearch({ apiKey, model, systemPrompt, userMessage, conversation_history, fetchFn = fetch, url = DEFAULT_URL, timeoutMs = 120000 }) {
  try {
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: buildInput(userMessage, conversation_history),
        tools: [{ type: 'web_search' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      console.warn(`[OpenAI-Responses] web_search request failed status=${resp.status}`);
      return { ok: false, status: resp.status };
    }
    const data = await resp.json();
    const { text, searched } = parseResponsesOutput(data);
    if (!text) return { ok: false, status: 200 };
    return {
      ok: true,
      text,
      toolsUsed: searched ? ['web_search'] : [],
      tokensUsed: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
      model: data?.model || model,
    };
  } catch (e) {
    console.warn(`[OpenAI-Responses] web_search request errored: ${e?.name || 'error'}`);
    return { ok: false, status: 0 };
  }
}

module.exports = { invokeOpenAiResponsesSearch, parseResponsesOutput, buildInput };
