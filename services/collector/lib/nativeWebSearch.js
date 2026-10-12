'use strict';

/**
 * Native web search for research turns (owner decision 2026-10-10: research
 * "just uses the LLM", routed per task by the org LLM routing policy).
 *
 * Claude legs use the model's own web search (CLI WebSearch/WebFetch, Messages
 * API server tool). Legs without a native search tool get one honest line in
 * the USER turn so the model says so instead of answering from memory.
 */

const NO_WEB_SEARCH_LINE =
  'Web search is not available on this model right now; say so instead of answering from memory when the task needs current or sourced facts.';

// Anthropic server tool (Messages API). Max uses bounds cost per turn.
const ANTHROPIC_WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
});

// Only the research capability (SCHOLAR) gets native search.
function isNativeWebSearch({ features, plan } = {}) {
  if (features && typeof features.web_search === 'boolean') return features.web_search;
  return plan?.capability === 'research';
}

function withNoWebSearchNote(text, enabled) {
  if (!enabled) return text;
  return `${NO_WEB_SEARCH_LINE}\n\n${text || ''}`;
}

// Collect URLs from text-block citations and web_search_tool_result blocks and
// append a Sources list when the text does not already carry those URLs.
function appendSearchSources(text, blocks) {
  const urls = [];
  const add = (u) => { if (typeof u === 'string' && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u); };
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.type === 'text' && Array.isArray(b.citations)) b.citations.forEach((c) => add(c?.url));
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((r) => add(r?.url));
  }
  const missing = urls.filter((u) => !String(text || '').includes(u));
  if (missing.length === 0) return text;
  return `${text}\n\nSources:\n${missing.map((u) => `- ${u}`).join('\n')}`;
}

module.exports = { NO_WEB_SEARCH_LINE, ANTHROPIC_WEB_SEARCH_TOOL, isNativeWebSearch, withNoWebSearchNote, appendSearchSources };
