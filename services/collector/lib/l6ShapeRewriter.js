/**
 * AOCL-FULL-5 — L6 shape.rewrite.
 *
 * Assembles the final LLM prompt from the raw user input + context gathered
 * by L5 + the agent persona. Populates aoclCtx.C5.finalPrompt. Emits
 * aocl.layer.L6.complete with metadata about prompt length, style profile,
 * persona applied, token budget.
 *
 * Critical: this module absorbs what used to live inline at
 * `server.js:11892`:
 *     userMessage = contextParts.join(...) + '\n\nQuery: ' + prompt
 * That inline mix is why the Activity Centre was showing injected system
 * context as the "user's prompt". Now:
 *     C2.rawUserPrompt  — exactly what the user typed (for audit + list row)
 *     C5.finalPrompt    — what goes to the LLM (for dispatch)
 * Two fields, one canonical answer to "what did the user ask?".
 *
 * Dependency injection same as L5: providers are passed in by the caller,
 * so the module itself is pure and testable without the frontend style
 * engine or persona registry.
 */

/** Build the context preamble from C3 memory + passed-in quox/memory context. */
function buildPreamble(aoclCtx, opts = {}) {
  const parts = [];
  const quoxContext = opts.quoxContext || null;
  const memoryContext = opts.memoryContext || null;
  const recalled = aoclCtx.C3?.memoryItems || [];

  if (quoxContext && typeof quoxContext === 'string' && quoxContext.trim()) {
    parts.push('Context: ' + quoxContext.trim());
  }
  if (memoryContext && typeof memoryContext === 'string' && memoryContext.trim()) {
    parts.push('Memory: ' + memoryContext.trim());
  } else if (recalled.length > 0) {
    const recalledText = recalled
      .map(r => typeof r === 'string' ? r : (r.text || r.content || ''))
      .filter(Boolean)
      .slice(0, 8)
      .join('\n');
    if (recalledText) parts.push('Recalled memories:\n' + recalledText);
  }

  const ragChunks = aoclCtx.C3?.ragChunks || [];
  if (ragChunks.length > 0) {
    const ragText = ragChunks
      .map(r => typeof r === 'string' ? r : (r.text || r.content || ''))
      .filter(Boolean)
      .slice(0, 6)
      .join('\n---\n');
    if (ragText) parts.push('Retrieved documents:\n' + ragText);
  }

  return parts;
}

/** Compose final prompt from preamble + raw user prompt. */
function composeFinalPrompt(preambleParts, rawUserPrompt) {
  if (!rawUserPrompt) return '';
  if (preambleParts.length === 0) return rawUserPrompt;
  return preambleParts.join('\n\n') + '\n\nQuery: ' + rawUserPrompt;
}

/**
 * Run the L6 shape rewriter.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {string} [opts.quoxContext]     already-sanitised quox self-awareness text
 * @param {string} [opts.memoryContext]   already-sanitised memory summary
 * @param {(aoclCtx, prompt) => Promise<string>|string} [opts.adaptStyle]
 *        optional style-engine hook. Receives the final prompt, returns a
 *        style-adapted version (adds tone markers, user's preferred verbosity,
 *        etc.). When omitted, final prompt passes through.
 * @param {(agentId) => string} [opts.getAssistantPersona]
 *        returns persona text to inject as system-level instructions.
 * @param {number} [opts.budgetTokens]  advisory max tokens for the final prompt
 */
async function runL6(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const rawUserPrompt = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';
  const preambleParts = buildPreamble(aoclCtx, opts);
  let finalPrompt = composeFinalPrompt(preambleParts, rawUserPrompt);

  let styleProfile = null;
  if (typeof opts.adaptStyle === 'function') {
    try {
      const adapted = await opts.adaptStyle(aoclCtx, finalPrompt);
      if (typeof adapted === 'string' && adapted.trim()) {
        finalPrompt = adapted;
        styleProfile = opts.styleProfile || 'adapted';
      }
    } catch (err) {
      // Style adaptation never blocks — log via warnings
      styleProfile = null;
    }
  }

  let personaApplied = false;
  let personaText = null;
  if (typeof opts.getAssistantPersona === 'function') {
    try {
      personaText = opts.getAssistantPersona(aoclCtx.C2?.agentId || 'quox');
      if (personaText && typeof personaText === 'string') {
        personaApplied = true;
      }
    } catch { /* ignore */ }
  }

  // Populate C5 execution partition
  const c5 = aoclCtx.C5 || (aoclCtx.C5 = {});
  c5.finalPrompt = finalPrompt;
  c5.personaText = personaText || null;
  c5.budgetTokens = opts.budgetTokens ?? null;

  const duration_ms = Date.now() - startedAt;
  return {
    proceed: true,
    extras: {
      prompt_length: finalPrompt.length,
      preamble_parts: preambleParts.length,
      raw_user_prompt_length: rawUserPrompt.length,
      style_profile: styleProfile,
      persona_applied: personaApplied,
      budget_tokens: opts.budgetTokens ?? null,
      duration_ms,
    },
  };
}

module.exports = {
  runL6,
  buildPreamble,
  composeFinalPrompt,
};
