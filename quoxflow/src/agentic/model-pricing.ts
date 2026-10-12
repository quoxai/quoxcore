/**
 * QSKL-7.fix2 — Skill-domain model pricing helper
 *
 * Provides estimateCostUsd() for computing the USD cost of a single LLM call
 * from token counts and a model name. Used by skillViewHandler to populate
 * cost_usd in skill_invoked telemetry envelopes.
 *
 * Keys use short names (without provider/ prefix) since the executor passes
 * the model key from the collector /invoke response, which matches the short
 * model-id format used in dashboard agent configs.
 *
 * // REFRESH QUARTERLY — rates sourced from public pricing pages as of 2026-05.
 * Anthropic: anthropic.com/pricing
 */

interface SkillModelPricingEntry {
  /** USD per 1M input tokens */
  input_per_million: number;
  /** USD per 1M output tokens */
  output_per_million: number;
}

// ─── Short-key pricing table ──────────────────────────────────────────────────

const SKILL_PRICING_MAP: Record<string, SkillModelPricingEntry> = {
  // Claude Sonnet 4.6 — balanced performance/cost
  'claude-sonnet-4-6': {
    input_per_million: 3.00,
    output_per_million: 15.00,
  },
  // Claude Haiku 4.5 — fast and cheap
  // Note: full version string variants also map here via prefix-match fallback
  'claude-haiku-4-5': {
    input_per_million: 0.80,
    output_per_million: 4.00,
  },
  // Claude Opus 4.7 — premium flagship
  'claude-opus-4-7': {
    input_per_million: 15.00,
    output_per_million: 75.00,
  },
  // LLM-CHOICE Phase 2.4 — OpenAI models added so failover-produced usage
  // (collector policy may route to OpenAI) doesn't cost-attribute as 0/unknown.
  // No existing rate found in quox-dashboard (modelCatalog.js only carries
  // catalog metadata for gpt-5.4* — no pricing table). Rates below are sourced
  // from OpenAI's published list pricing. // verify rates
  'gpt-5.4': {
    input_per_million: 5.00,
    output_per_million: 20.00,
  },
  'gpt-5.4-mini': {
    input_per_million: 0.50,
    output_per_million: 2.00,
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Estimate the USD cost for an LLM call given a model name and token counts.
 *
 * Model key matching:
 *   1. Exact key match (e.g. 'claude-sonnet-4-6').
 *   2. Prefix match — 'claude-haiku-4-5-20251001' matches 'claude-haiku-4-5'.
 *   3. If no match: logs a console.warn and returns 0. Does NOT throw.
 *
 * @param model      - Model identifier (short or full version string).
 * @param inputTokens  - Number of input/prompt tokens.
 * @param outputTokens - Number of output/completion tokens.
 * @returns Cost in USD (floating-point, not micro-dollars).
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  // 1. Exact match
  let entry = SKILL_PRICING_MAP[model];

  // 2. Prefix match (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
  if (!entry) {
    for (const key of Object.keys(SKILL_PRICING_MAP)) {
      if (model.startsWith(key)) {
        entry = SKILL_PRICING_MAP[key];
        break;
      }
    }
  }

  if (!entry) {
    console.warn(
      `[estimateCostUsd] Unknown model "${model}" — no pricing entry found. ` +
      `Returning 0 cost. Add it to src/agentic/model-pricing.ts.`
    );
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * entry.input_per_million;
  const outputCost = (outputTokens / 1_000_000) * entry.output_per_million;
  return inputCost + outputCost;
}
