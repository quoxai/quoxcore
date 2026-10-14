'use strict';
/**
 * GET /chat/stream (what `quox chat` uses by default) used to send every agent a
 * generic "You are X, a QuoxCORE AI assistant" prompt and an empty tool list,
 * so `quox chat --agent notesq` on the Claude CLI guessed tool names that do
 * not exist (2026-10-10). This resolves the agent's real identity prompt and
 * granted tool list, the same sources POST /chat uses.
 *
 * The tool list is a catalogue only: on the CLI path every call still goes
 * through `quox tool exec`, i.e. the Tools API and its QuoxHat authz, so a
 * listed tool the hat denies is refused there with a reason.
 * Fails soft to the generic prompt and no tools, and says so in the log.
 */
// Entity prompts describe tools; on a branch with none, the model must not pretend.
const NO_TOOLS_NOTE = '\n\n## This conversation\nNo tools are connected in this conversation. Do not claim to have searched, read, saved or changed anything. If the request needs a tool, say so plainly and suggest asking again from the dashboard or with `quox chat --no-stream`.';
const genericPrompt = (name) => `You are ${name}, a QuoxCORE AI assistant. You help users with questions and tasks. Always identify yourself as ${name}.`;

async function resolveStreamAgentContext({ agent, orgId, withTools = false }, { getAssistantPrompt, getToolsWithConnectors, log = console } = {}) {
  const name = String(agent || 'cipher').toUpperCase();
  let systemPrompt = genericPrompt(name);
  let tools = [];
  try {
    const entity = typeof getAssistantPrompt === 'function' ? await getAssistantPrompt(String(agent || '').toLowerCase()) : null;
    if (typeof entity === 'string' && entity.trim()) systemPrompt = entity;
  } catch (e) {
    log.warn?.(`[ChatStream] entity prompt for '${agent}' failed, generic prompt used: ${e?.message}`);
  }
  if (withTools) {
    try {
      const t = typeof getToolsWithConnectors === 'function' ? await getToolsWithConnectors(String(agent || '').toLowerCase(), orgId || null) : [];
      tools = Array.isArray(t) ? t : [];
    } catch (e) {
      log.warn?.(`[ChatStream] tools for '${agent}' failed, none listed: ${e?.message}`);
    }
  }
  if (!tools.length && systemPrompt !== genericPrompt(name)) systemPrompt += NO_TOOLS_NOTE;
  return { systemPrompt, tools };
}

/** Opt-in governed tool turns: the honesty note must follow the RESOLVED tool set. */
function applyToolHonesty(prompt, toolCount) {
  const p = String(prompt || '');
  if (toolCount > 0) return p.endsWith(NO_TOOLS_NOTE) ? p.slice(0, -NO_TOOLS_NOTE.length) : p;
  return p.endsWith(NO_TOOLS_NOTE) ? p : p + NO_TOOLS_NOTE;
}

/** D3: 'compact' | 'full'. Ollama (small local context) defaults to compact; /model can opt in. */
const PROMPT_PROFILES = new Set(['compact', 'full']);
function resolvePromptProfile(requested, provider) {
  const r = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (PROMPT_PROFILES.has(r)) return r;
  return require('./turnToolSelection.js').isSmallLocalProvider(provider) ? 'compact' : 'full';
}

/**
 * D3: the system prompt for one governed API turn. compact swaps in the entity's compact
 * prompt (falls back to the full one when there is none); the honesty note follows the
 * RESOLVED tool count; a tool turn adds the state-change rule and the more_tools hint.
 */
function buildTurnSystemPrompt({ agent, fullPrompt, profile = 'full', toolCount = 0, getCompactPrompt }) {
  let base = String(fullPrompt || '');
  if (profile === 'compact') {
    let compact = null;
    try {
      compact = typeof getCompactPrompt === 'function'
        ? getCompactPrompt(String(agent || '').toLowerCase())
        : require('./entityAssistantLoader.js').getAssistantPromptCompact(String(agent || '').toLowerCase());
    } catch { compact = null; }
    if (typeof compact === 'string' && compact.trim()) base = compact;
  }
  const p = applyToolHonesty(base, toolCount);
  if (toolCount <= 0) return p;
  const { STATE_CHANGE_RULE, CLAIM_RULES } = require('./turnToolSelection.js');
  return `${p}\n\n## Tools this turn\n- ${STATE_CHANGE_RULE}\n- Only the tools listed are offered. If none fits, call more_tools with what you need before saying you cannot.\n${CLAIM_RULES.map((r) => `- ${r}`).join('\n')}`;
}

module.exports = { resolvePromptProfile, buildTurnSystemPrompt, applyToolHonesty, resolveStreamAgentContext, genericPrompt, NO_TOOLS_NOTE };
