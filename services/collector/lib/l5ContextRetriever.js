/**
 * AOCL-FULL-5 — L5 context.retrieve.
 *
 * Retrieves episodic/semantic memory, working-set context, RAG chunks, and
 * any session files for the current chat. Populates aoclCtx.C3. Emits
 * aocl.layer.L5.complete via runPipeline once returned.
 *
 * Budget: 300ms (set in layerBudget.js DEFAULT_BUDGETS_MS). On timeout the
 * wrapper returns bypass with reason 'l5.timeout' — the pipeline proceeds
 * to L6 without context, audit still complete.
 *
 * Dependency injection: L5 does not import memory clients directly. The
 * caller passes providers: { fetchMemory, fetchWorkingSet, fetchRAG }.
 * Each provider is async, gets the aoclCtx, and returns its slice. This
 * keeps L5 a pure module, makes it testable without booting Qdrant, and
 * lets server.js plug in the real clients at run time.
 *
 * Providers can be undefined — L5 simply skips that source and records
 * an empty bucket. The caller opts in to what's available.
 */

const DEFAULT_MAX_ITEMS = 20;

/**
 * Run the L5 context retrieval.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {(ctx) => Promise<Array|{items,tokens}>} [opts.fetchMemory]
 * @param {(ctx) => Promise<Array|{items,tokens}>} [opts.fetchWorkingSet]
 * @param {(ctx) => Promise<Array|{items,tokens}>} [opts.fetchRAG]
 * @param {number} [opts.maxItems]  per-source cap (default 20)
 */
async function runL5(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const c3 = aoclCtx.C3 || (aoclCtx.C3 = {});
  const sources = [];
  const warnings = [];

  async function pull(name, provider, targetKey) {
    if (typeof provider !== 'function') return null;
    try {
      const r = await provider(aoclCtx);
      if (!r) return null;
      // Normalise: accept either Array (items only) or { items, tokens }
      const items = Array.isArray(r) ? r : Array.isArray(r.items) ? r.items : [];
      const tokens = typeof r.tokens === 'number' ? r.tokens : 0;
      const capped = items.slice(0, maxItems);
      c3[targetKey] = capped;
      if (tokens > 0 && targetKey === 'workingSet') c3.workingSetTokens = tokens;
      sources.push({ name, items: capped.length, tokens, truncated: items.length > capped.length });
      return capped;
    } catch (err) {
      warnings.push(`L5:${name} provider failed: ${err?.message || 'unknown'}`);
      return null;
    }
  }

  await pull('memory',     opts.fetchMemory,     'memoryItems');
  await pull('workingSet', opts.fetchWorkingSet, 'workingSet');
  await pull('rag',        opts.fetchRAG,        'ragChunks');

  c3.sources = sources;

  const duration_ms = Date.now() - startedAt;
  const memoryCount = (c3.memoryItems || []).length;
  const wsmCount = (c3.workingSet || []).length;
  const ragCount = (c3.ragChunks || []).length;

  return {
    proceed: true,
    warnings,
    extras: {
      memory_items: memoryCount,
      wsm_items: wsmCount,
      wsm_tokens: c3.workingSetTokens || 0,
      rag_chunks: ragCount,
      sources: sources.map(s => s.name),
      duration_ms,
    },
  };
}

module.exports = { runL5, DEFAULT_MAX_ITEMS };
