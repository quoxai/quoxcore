/**
 * Model Pricing Map — STUDY-REV-2 P8.B.2
 *
 * Token → USD pricing per model. Key: "provider/model".
 * Rates are per 1 million tokens (input and output tracked separately).
 *
 * Units: USD (not micro-dollars). Callers compute micro-dollars as:
 *   cost_usd_micro = round((tokens / 1_000_000) * rate_per_million * 1_000_000)
 *
 * // REFRESH QUARTERLY — rates sourced from public pricing pages as of 2026-05.
 * Anthropic: anthropic.com/pricing
 * OpenAI:    openai.com/pricing
 */

export interface ModelPricingEntry {
  /** USD per 1M input tokens */
  input_per_million: number;
  /** USD per 1M output tokens */
  output_per_million: number;
}

// ─── Pricing Table ────────────────────────────────────────────────────────────

const PRICING_MAP: Record<string, ModelPricingEntry> = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Claude Opus 4.7 — current premium flagship (Anthropic pricing 2026-Q2)
  'anthropic/claude-opus-4-7': {
    input_per_million: 15.00,
    output_per_million: 75.00,
  },
  // Claude Sonnet 4.6 — balanced performance/cost
  'anthropic/claude-sonnet-4-6': {
    input_per_million: 3.00,
    output_per_million: 15.00,
  },
  // Claude Haiku 4.5 — fast and cheap
  'anthropic/claude-haiku-4-5-20251001': {
    input_per_million: 0.80,
    output_per_million: 4.00,
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // GPT-4o — OpenAI flagship multimodal
  'openai/gpt-4o': {
    input_per_million: 2.50,
    output_per_million: 10.00,
  },
  // GPT-4o mini — economical OpenAI model
  'openai/gpt-4o-mini': {
    input_per_million: 0.15,
    output_per_million: 0.60,
  },
  // o1 — reasoning model (higher cost due to chain-of-thought)
  'openai/o1': {
    input_per_million: 15.00,
    output_per_million: 60.00,
  },
  // o1-mini — lightweight reasoning
  'openai/o1-mini': {
    input_per_million: 1.10,
    output_per_million: 4.40,
  },

  // ── Default fallback ──────────────────────────────────────────────────────
  // Use Sonnet pricing as a safe mid-tier estimate for unknown models.
  'default/unknown': {
    input_per_million: 3.00,
    output_per_million: 15.00,
  },
};

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Return the pricing entry for a given model key.
 * Falls back to `default/unknown` if the model is not in the table.
 *
 * @param model - Model key in "provider/model" format.
 */
export function getModelPricing(model: string): ModelPricingEntry {
  return PRICING_MAP[model] ?? PRICING_MAP['default/unknown'];
}

/**
 * Compute cost_usd_micro from tokens and model.
 * Rounds to nearest micro-dollar (integer).
 *
 * @param tokensIn  - Input token count
 * @param tokensOut - Output token count
 * @param model     - Model key ("provider/model")
 * @returns cost in micro-USD (integer, multiply USD by 1e6)
 */
export function computeCostUsdMicro(tokensIn: number, tokensOut: number, model: string): number {
  const p = getModelPricing(model);
  const inputCost = (tokensIn / 1_000_000) * p.input_per_million;
  const outputCost = (tokensOut / 1_000_000) * p.output_per_million;
  return Math.round((inputCost + outputCost) * 1_000_000);
}
