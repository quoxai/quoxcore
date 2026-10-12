/**
 * AOCL-CUTOVER-2 — provider adapters for L5 / L6 / L9.
 *
 * Each layer module (l5ContextRetriever, l6ShapeRewriter, l9Assembler) was
 * built with a pure DI contract — they take providers as options and never
 * import collector-specific services directly. This module closes that gap:
 * it wraps the real memoryClient / persona registry / sanitiser / style
 * engine into the exact provider shape each layer expects.
 *
 * Used by Phase 2b wiring: buildChatStack({ ...buildChatProviders(deps) }).
 *
 * All providers are defensive — provider errors become empty results, not
 * pipeline failures. The underlying layer modules already absorb warnings,
 * but we short-circuit here so the stack path is at least as resilient as
 * the inline legacy path.
 */

function buildChatProviders(deps = {}) {
  const memoryClient = deps.memoryClient || null;
  const wsmClient = deps.wsmClient || null;
  const ragClient = deps.ragClient || null;
  const personas = deps.personas || {};
  const sanitise = typeof deps.sanitise === 'function' ? deps.sanitise : null;
  const adaptStyleFn = typeof deps.adaptStyle === 'function' ? deps.adaptStyle : null;

  async function fetchMemory(aoclCtx) {
    if (!memoryClient || typeof memoryClient.searchMemories !== 'function') return [];
    try {
      const query = aoclCtx?.C2?.rawUserPrompt || aoclCtx?.query || '';
      const limit = deps.maxMemoryItems || 10;
      const r = await memoryClient.searchMemories({ query, limit });
      return Array.isArray(r) ? r : Array.isArray(r?.results) ? r.results : [];
    } catch {
      return [];
    }
  }

  async function fetchWorkingSet(aoclCtx) {
    if (!wsmClient || typeof wsmClient.getContext !== 'function') return null;
    try {
      return await wsmClient.getContext(aoclCtx);
    } catch {
      return null;
    }
  }

  async function fetchRAG(aoclCtx) {
    if (!ragClient || typeof ragClient.retrieve !== 'function') return [];
    try {
      const query = aoclCtx?.C2?.rawUserPrompt || aoclCtx?.query || '';
      const r = await ragClient.retrieve({ query, limit: deps.maxRagChunks || 5 });
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  function getAssistantPersona(agentId) {
    if (!agentId) return null;
    return personas[agentId] || personas[String(agentId).toLowerCase()] || null;
  }

  async function redact(text) {
    if (!sanitise || typeof text !== 'string') return text;
    try {
      return await sanitise(text);
    } catch {
      return text;
    }
  }

  async function adaptStyle(aoclCtx, prompt) {
    if (!adaptStyleFn) return null;
    try {
      return await adaptStyleFn(aoclCtx, prompt);
    } catch {
      return null;
    }
  }

  return {
    fetchMemory,
    fetchWorkingSet,
    fetchRAG,
    getAssistantPersona,
    quoxContext: deps.quoxContext || null,
    redact,
    adaptStyle,
  };
}

module.exports = { buildChatProviders };
