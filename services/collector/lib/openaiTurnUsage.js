'use strict';
/**
 * QUOX-MODEL: turn usage for the OpenAI stream path of POST /chat/stream.
 *
 * Tokens are the provider's own numbers (summed across model rounds by the
 * governed loop, or the toolless loop's inputTokens/outputTokens). Cost is
 * computed ONLY when lib/modelPricing.js has an exact `openai/<model>` row;
 * otherwise cost_usd is null. The pricing table's `default/unknown` fallback is
 * deliberately not used here: a guessed rate shown as a cost would be a lie.
 */
const { PRICING_MAP } = require('./modelPricing.js');

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Sum one round's provider usage into an accumulator (mutates acc). */
function addRoundUsage(acc, u) {
  acc.rounds += 1;
  if (!u || typeof u !== 'object') return acc;
  const p = num(u.prompt_tokens);
  const c = num(u.completion_tokens);
  if (p != null) acc.prompt_tokens = (acc.prompt_tokens || 0) + p;
  if (c != null) acc.completion_tokens = (acc.completion_tokens || 0) + c;
  // CLI-QUOX B5: a provider-reported per-call cost (OpenRouter usage.cost), summed when present.
  // The field appears only when some round reported it; other providers keep the legacy shape.
  const cost = num(u.cost);
  if (cost != null) acc.cost = (acc.cost || 0) + cost;
  return acc;
}
const newUsageAccumulator = () => ({ prompt_tokens: null, completion_tokens: null, rounds: 0 });

/** -> { input_tokens, output_tokens, cost_usd, cost_source } ; nulls when not reported. */
function openaiTurnUsage(u, model) {
  const o = u && typeof u === 'object' ? u : {};
  const input = num(o.prompt_tokens ?? o.inputTokens ?? o.input_tokens);
  const output = num(o.completion_tokens ?? o.outputTokens ?? o.output_tokens);
  const key = `openai/${String(model || '')}`;
  const row = model ? PRICING_MAP[key] : null;
  let cost = null;
  if (row && input != null && output != null) {
    cost = Math.round(((input / 1e6) * row.input_per_million + (output / 1e6) * row.output_per_million) * 1e6) / 1e6;
  }
  return { input_tokens: input, output_tokens: output, cost_usd: cost, cost_source: cost == null ? null : `modelPricing:${key}` };
}

module.exports = { openaiTurnUsage, addRoundUsage, newUsageAccumulator };
