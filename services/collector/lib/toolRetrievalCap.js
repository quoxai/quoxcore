'use strict';

const OPENAI_TOOL_CAP = 128;

// TOOL-RETRIEVAL P1 — the 128-tool cap.
//
// The 128-tool limit is an OpenAI API constraint, NOT an Anthropic one. The
// original collector code truncated the resolved tool set unconditionally,
// before the provider was known, so the Claude path (the default provider) was
// silently capped too: the last 20 of quox's 148 tools (the security_, system_,
// uptime_ and wazuh_ families) became permanently unreachable on the default
// path, even though those specialist tools are also reachable by delegation to
// their owning agents (argus/nova/sentinel/beacon).
//
// This helper isolates the decision so it is unit-testable and so the cap can
// only ever apply to the provider that actually needs it.
//
// @param {Array} agentTools  resolved tool definitions for the agent
// @param {string|null} provider  effective provider ('anthropic' | 'openai' | ...)
// @param {number} [cap=128]  the OpenAI tool limit
// @returns {{ tools: Array, truncated: boolean, cap: number }}
function applyOpenAiToolCap(agentTools, provider, explicitCap) {
  const tools = Array.isArray(agentTools) ? agentTools : [];
  const cap = explicitCap ?? OPENAI_TOOL_CAP;
  // CLI-QUOX B3: ollama is capped only when the caller passes its own (smaller) cap.
  // CLI-QUOX B5: openai_compatible likewise (the caller passes its preset's cap).
  const truncated = (provider === 'openai' || ((provider === 'ollama' || provider === 'openai_compatible') && explicitCap != null)) && tools.length > cap;
  return {
    tools: truncated ? tools.slice(0, cap) : tools,
    truncated,
    cap,
  };
}

// TOOL-RETRIEVAL P3 — query-aware smart truncation.
//
// Same trigger as applyOpenAiToolCap (openai + over cap): the D0 problem this
// stream was opened for is that when truncation DOES fire, it drops the last
// N tools in arbitrary array order, which happened to be the entire
// security_/system_/uptime_/wazuh_ families every single time (P0 baseline).
// Instead of an arbitrary slice(0, cap), this keeps the query-relevant top-K
// (via tool-RAG searchTools) and only fills any remaining slots from the
// original order — the "ordered truncation as a floor" design in the
// TOOL-RETRIEVAL plan (D4). Never drops more than the plain cap would.
//
// Any failure in the smart path (no embedding key resolved, Qdrant
// unreachable, search error, no query text) falls back to the EXACT same
// result applyOpenAiToolCap would already give — a smart-cap outage must
// never break or even change chat behaviour beyond what already ships today,
// it can only make an already-truncated set smarter.
//
// @param {Array} agentTools
// @param {string|null} provider
// @param {string} query  the user's message, used to rank relevance
// @param {object} deps  { searchToolsFn, embedText, providerKeys, qdrantUrl }
// @param {number} [cap=128]
// @returns {Promise<{ tools: Array, truncated: boolean, cap: number, smart: boolean }>}
async function applySmartToolCap(agentTools, provider, query, deps = {}, cap = OPENAI_TOOL_CAP) {
  const base = applyOpenAiToolCap(agentTools, provider, cap);
  if (!base.truncated) return { ...base, smart: false };

  const { searchToolsFn, embedText, providerKeys, qdrantUrl } = deps;
  if (typeof searchToolsFn !== 'function' || typeof embedText !== 'function' || !query) {
    return { ...base, smart: false };
  }

  try {
    const tools = Array.isArray(agentTools) ? agentTools : [];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const { tools: ranked } = await searchToolsFn(query, { embedText, providerKeys, qdrantUrl }, cap);
    const picked = [];
    const pickedNames = new Set();
    for (const r of ranked || []) {
      const t = byName.get(r.name);
      if (t && !pickedNames.has(r.name)) {
        picked.push(t);
        pickedNames.add(r.name);
      }
      if (picked.length >= cap) break;
    }
    // Floor: fill any remaining slots from the original order so the final
    // set is never smaller than the plain cap would produce, even if search
    // returns fewer than `cap` usable matches.
    if (picked.length < cap) {
      for (const t of tools) {
        if (picked.length >= cap) break;
        if (!pickedNames.has(t.name)) {
          picked.push(t);
          pickedNames.add(t.name);
        }
      }
    }
    return { tools: picked, truncated: true, cap, smart: true };
  } catch (err) {
    console.warn('[TOOL-RETRIEVAL P3] smart cap failed, falling back to arbitrary truncation:', err.message);
    return { ...base, smart: false };
  }
}

module.exports = { applyOpenAiToolCap, applySmartToolCap, OPENAI_TOOL_CAP };
