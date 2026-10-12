const { applyLenses } = require('./lensComposer');

// QUOXLENS P0: the direct-provider path is the only one that ever had the
// Execution Integrity block baked in, so it is the only path that ships
// with a non-empty default. The MCP and Messages-API dispatchers default to
// [] (true no-op) until QUOXLENS P1 decides they should carry it too.
const DEFAULT_LENSES = ['quox-execution-integrity'];

function extractMirrorSection(quoxContext) {
  if (!quoxContext || typeof quoxContext !== 'string' || !quoxContext.includes('## QuoxMind Mirror')) {
    return '';
  }

  const mirrorStart = quoxContext.indexOf('## QuoxMind Mirror');
  const mirrorEnd = quoxContext.indexOf('\n\n', mirrorStart + 20);
  return mirrorEnd > mirrorStart
    ? quoxContext.substring(mirrorStart, mirrorEnd)
    : quoxContext.substring(mirrorStart);
}

function buildDirectProviderSystemPrompt({
  baseSystemPrompt,
  persona,
  quoxContext,
  collectorMirror = '',
  selectedAgent = 'quox',
  agentTools = [],
  lenses = DEFAULT_LENSES
}) {
  let systemPrompt = `${baseSystemPrompt}\n\n## Voice Personality\n${persona}`;

  const mirrorSection = extractMirrorSection(quoxContext);
  if (mirrorSection) {
    systemPrompt += `\n\n${mirrorSection}`;
  } else if (collectorMirror) {
    systemPrompt += `\n\n## System Status\n${collectorMirror}`;
  }

  if (Array.isArray(agentTools) && agentTools.length > 0) {
    systemPrompt += `\n\n## Tool Use
- You are ${String(selectedAgent || 'quox').toUpperCase()} and you have real tools available in this conversation.
- If the user's request can be completed with a tool call, use the tool instead of describing a hypothetical workflow.
- Use the existing conversation context to resolve follow-ups like "send it", "do it", "retry", or "continue" when the prior turns already established the concrete action.
- Ask a clarifying question only when a required field is still genuinely missing after considering the prior turns and available tools.
- Do not say you lack tool access when a relevant tool is available.`;
  }

  // The Execution Integrity block used to be hardcoded here. It now lives at
  // src/config/lenses/house/quox-execution-integrity/LENS.md and is composed
  // in through applyLenses so it can be swapped, panel-composed, or measured
  // by the QUOXLENS P2 eval harness without touching this function again.
  return applyLenses(systemPrompt, lenses);
}

module.exports = {
  extractMirrorSection,
  buildDirectProviderSystemPrompt,
  DEFAULT_LENSES,
};
