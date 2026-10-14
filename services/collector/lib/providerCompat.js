'use strict';

/**
 * QUOXHAT P3 — provider certification matrix (QUOXHAT_STUDY.md §10).
 *
 * Per-provider tool-calling constraints, learned from LIVE DRIVES rather
 * than vendor docs alone. Every constraint below traces to a real incident
 * or a real certification run:
 *   - openai.toolCap 128: HTTP 400 array_above_max_length killed the
 *     governed fallback platform-wide (gripe #653, fix 1a91645c).
 *   - gemini array_items_required: live 400 at declaration 82 of quox's
 *     real grant ("items: missing field"), 2026-10-01.
 *   - gemini verbatim_model_turn_replay: live 400 "Function call is
 *     missing a thought_signature", 2026-10-01.
 *   - gemini.toolCap 512: documented Vertex declaration ceiling; NOT yet
 *     probed live (no real manifest approaches it).
 *   - perplexity/local: no collector tool loop exists for them.
 *
 * `proof` is the honesty field: live_proven means a real turn on the real
 * API through the real executeTool choke; unit_tested means mocked
 * transport only; none means nobody has driven it. The Settings surface
 * renders this verbatim — this matrix is the single source for any
 * "works on provider X" claim (STATUS_AND_LIMITS_QUOXHAT.md defers here).
 *
 * Failover use: under an ENFORCED hat manifest the walk must never mutate
 * the tool set per leg (failover changes the model, never the tools), so
 * a candidate whose constraints the manifest violates is SKIPPED with a
 * named reason instead of capped. Legacy (no-hat) turns keep the existing
 * cap-at-the-leg behaviour — annotateCandidatesForManifest is a no-op
 * without a manifest size.
 */

const PROVIDER_COMPAT = {
  anthropic: {
    label: 'Anthropic (Messages API / CLI)',
    toolLoop: true,
    toolCap: null, // no documented tool-count ceiling
    quirks: [],
    proof: { primary: 'live_proven', fallback: 'live_proven' },
    notes: 'Default provider; full resolved set ships uncapped.',
  },
  openai: {
    label: 'OpenAI (Chat Completions)',
    toolLoop: true,
    toolCap: 128, // hard API limit, #653
    quirks: ['tool_cap_400_array_above_max_length'],
    proof: { primary: 'live_proven', fallback: 'live_proven' },
    notes: 'Cap proven live both as primary and on the governed fallback leg (fix 1a91645c).',
  },
  gemini: {
    label: 'Google Gemini (generateContent)',
    toolLoop: true,
    toolCap: 512, // documented declaration ceiling; not yet probed live
    quirks: ['array_items_required', 'verbatim_model_turn_replay', 'schema_openapi_subset'],
    proof: { primary: 'live_proven', fallback: 'unit_tested' },
    notes: 'Primary live-proven 2026-10-01 (gemini-3.8-flash drove hat_catalogue). PLAN-TIME fallback also live-proven 2026-10-01 (scratch org: Anthropic primary unattemptable, gemini carried the tool turn). The RUNTIME mid-walk failover leg (the #653 shape: primary fails at attempt time) remains unit-tested only.',
  },
  perplexity: {
    label: 'Perplexity',
    toolLoop: false, // no collector tool loop exists
    toolCap: 0,
    quirks: [],
    proof: { primary: 'none', fallback: 'n/a' },
    notes: 'Text-only path; any tool-carrying manifest is incompatible.',
  },
  ollama: {
    label: 'Ollama (self-hosted, OpenAI-compatible)',
    toolLoop: true, // CLI-QUOX B3: the B1 governed loop on /chat/stream
    toolCap: 24, // local context windows are small; lib/ollamaProvider.js OLLAMA_TOOL_CAP
    quirks: ['tools_unsupported_400_per_model'],
    proof: { primary: 'unit_tested', fallback: 'n/a' },
    notes: 'Stub-server tested (streaming, tools, no-tools retry). Not yet driven against a real Ollama. Models without tool support answer once without tools.',
  },
  openai_compatible: {
    label: 'OpenAI-compatible presets (OpenRouter, Hugging Face, Groq, Together, LM Studio, vLLM, custom)',
    toolLoop: true, // CLI-QUOX B5: the B1 governed loop on /chat/stream
    toolCap: 64, // lib/openaiCompatProvider.js COMPAT_TOOL_CAP (self-hosted presets pass 24)
    quirks: ['tools_unsupported_per_model', 'openrouter_404_no_tool_endpoints'],
    proof: { primary: 'unit_tested', fallback: 'n/a' },
    notes: 'Stub-server tested (request shape per preset, streaming, tools, no-tools retry, OpenRouter cost). Not yet driven against a real vendor.',
  },
  local: {
    label: 'Local inference (OpenAI-compatible)',
    toolLoop: false, // chat path sends no tools today
    toolCap: 0,
    quirks: [],
    proof: { primary: 'none', fallback: 'n/a' },
    notes: 'Ollama/vLLM/llama.cpp chat path carries no tools on this dispatch route.',
  },
};

/**
 * Can `provider` carry a manifest of `manifestSize` tools without mutation?
 * Unknown providers fail closed with a named reason — an uncertified
 * provider must never silently pass a certification check.
 */
function checkManifestCompat(provider, manifestSize) {
  const entry = PROVIDER_COMPAT[provider];
  const size = Number.isInteger(manifestSize) ? manifestSize : 0;
  if (!entry) {
    return { compatible: false, reasons: [`provider '${provider}' is uncertified (not in the compatibility matrix)`] };
  }
  const reasons = [];
  if (size > 0 && !entry.toolLoop) {
    reasons.push(`provider '${provider}' has no governed tool loop; a ${size}-tool manifest cannot be carried`);
  }
  if (entry.toolCap !== null && entry.toolLoop && size > entry.toolCap) {
    reasons.push(`manifest of ${size} tools exceeds '${provider}' cap of ${entry.toolCap}`);
  }
  return { compatible: reasons.length === 0, reasons };
}

/**
 * Annotate failover candidates against an enforced manifest: incompatible
 * candidates become attemptable:false with skipReason
 * 'manifest_incompatible: …' so the walk records WHY a leg was skipped.
 * No-op when manifestSize is null/undefined (legacy turns) and never
 * resurrects an already-unattemptable candidate.
 */
function annotateCandidatesForManifest(candidates, { manifestSize } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!Number.isInteger(manifestSize)) return list;
  return list.map((c) => {
    if (!c || c.attemptable === false) return c;
    const { compatible, reasons } = checkManifestCompat(c.provider, manifestSize);
    if (compatible) return c;
    return { ...c, attemptable: false, skipReason: `manifest_incompatible: ${reasons.join('; ')}` };
  });
}

module.exports = { PROVIDER_COMPAT, checkManifestCompat, annotateCandidatesForManifest };
