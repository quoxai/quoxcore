/**
 * AOCL-FULL-4 — L2 route.smart.
 *
 * Second layer of the pipeline. Fast-path deterministic router that matches
 * known patterns BEFORE the expensive LLM dispatch. On match, sets a halt
 * signal on aoclCtx; the runner then emits .bypass for every downstream
 * layer (L3/L5/L6/L7/L8/L9) with reason: 'l2.fastpath' — producing a full
 * audit trail even for cached/fast responses.
 *
 * Patterns ship as a registry: { intent, test(prompt), respond(ctx) }.
 * Only deterministic rules here. Semantic routing (LLM embeddings) is a
 * separate concern and lives outside L2.
 */

/**
 * Built-in patterns. Extend via aoclCtx.C5.toolRegistry.l2_patterns in
 * future. Each pattern:
 *   - intent: canonical intent name
 *   - test(prompt): returns { matched, confidence, captures }
 *   - respond(aoclCtx, captures): returns the answer text
 */
const BUILTIN_PATTERNS = [
  {
    intent: 'meta.what_is_quox',
    test: (p) => {
      const t = (p || '').toLowerCase().trim();
      const match = /^(what is|what's|who is) (quox|you)(\?)?$/i.test(t);
      return { matched: match, confidence: match ? 0.95 : 0 };
    },
    respond: () => 'Quox is an AI orchestration platform for enterprise. Ask me anything about the infrastructure, fleet, or your data.',
  },
  {
    intent: 'meta.help',
    test: (p) => {
      const t = (p || '').toLowerCase().trim();
      const match = /^(help|what can you do|what commands|list commands)(\?)?$/i.test(t);
      return { matched: match, confidence: match ? 0.92 : 0 };
    },
    respond: () => 'Try: "status", "what is quox", "help", or ask anything in natural language.',
  },
  {
    intent: 'meta.status',
    test: (p) => {
      const t = (p || '').toLowerCase().trim();
      const match = /^(status|ping|are you there|ok\?)$/i.test(t);
      return { matched: match, confidence: match ? 0.98 : 0 };
    },
    respond: () => 'All systems nominal.',
  },
];

/**
 * Evaluate every pattern against the prompt; pick the highest-confidence
 * match (if any meets the threshold).
 */
function matchPrompt(prompt, patterns = BUILTIN_PATTERNS, { threshold = 0.85 } = {}) {
  let best = null;
  for (const p of patterns) {
    try {
      const r = p.test(prompt);
      if (r?.matched && (r.confidence ?? 0) >= threshold) {
        if (!best || r.confidence > best.confidence) {
          best = { pattern: p, confidence: r.confidence, captures: r.captures };
        }
      }
    } catch { /* bad matcher — skip */ }
  }
  return best;
}

/** L2 run function — conforms to the pipeline LayerResult contract. */
async function runL2(aoclCtx, { patterns } = {}) {
  if (!aoclCtx) return { proceed: true };
  const prompt = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';
  const match = matchPrompt(prompt, patterns);

  if (!match) {
    return {
      proceed: true,
      extras: { handled: false, pattern: null, confidence: 0 },
    };
  }

  // Build the canned response. The halt signal tells runPipeline to emit
  // .bypass for every subsequent layer.
  let response;
  try {
    response = match.pattern.respond(aoclCtx, match.captures);
  } catch (err) {
    // If the responder blew up, treat as a miss so pipeline continues normally.
    return {
      proceed: true,
      extras: { handled: false, pattern: match.pattern.intent, confidence: match.confidence, error: err.message },
    };
  }

  aoclCtx.halt = { reason: 'l2.fastpath', response, intent: match.pattern.intent };
  return {
    proceed: true,
    extras: {
      handled: true,
      pattern: match.pattern.intent,
      confidence: match.confidence,
      response_length: (response || '').length,
    },
  };
}

module.exports = {
  runL2,
  matchPrompt,
  BUILTIN_PATTERNS,
};
