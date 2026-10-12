'use strict';

/**
 * QUOXCHAT-BRUTALOOP wave 5 product P7: monthly LLM spend budget.
 *
 * Auth owns the spend counter (widget_usage_monthly.llm_cost_micro_usd) and
 * reports it in usage/current as `budget`. The collector only decides what to
 * do with it. Actions mirror website_widgets.budget_action:
 *   continue    keep answering, spend is only surfaced to the operator
 *   downgrade   keep answering on the cheapest tier (the default)
 *   unavailable / message / hide   stop answering, visitor-safe message
 */

const { computeCostUsdMicro } = require('./modelPricing');

const STOP_MESSAGES = {
  unavailable: 'Our assistant is currently unavailable. Please contact us directly for help.',
  message: 'Chat is temporarily unavailable. Please try again later.',
  hide: 'Chat is temporarily unavailable. Please try again later.',
};

/** @param {object|null} budget  usage/current `budget` block */
function decideBudget(budget) {
  if (!budget || !Number.isFinite(budget.monthly_budget_cents) || budget.monthly_budget_cents <= 0 || budget.exceeded !== true) {
    return { stop: false, downgrade: false, exceeded: false, action: 'continue' };
  }
  const action = ['continue', 'downgrade', 'unavailable', 'message', 'hide'].includes(budget.action) ? budget.action : 'downgrade';
  if (action === 'continue') return { stop: false, downgrade: false, exceeded: true, action };
  if (action === 'downgrade') return { stop: false, downgrade: true, exceeded: true, action };
  return { stop: true, downgrade: false, exceeded: true, action, message: STOP_MESSAGES[action], hide: action === 'hide' };
}

/** Estimated answer cost in micro-USD from the shared price table (unknown models priced as Sonnet, an over-estimate). */
function estimateAnswerCostMicro(provider, model, inputTokens, outputTokens) {
  return computeCostUsdMicro(Number(inputTokens) || 0, Number(outputTokens) || 0, `${provider}/${model}`);
}

module.exports = { decideBudget, estimateAnswerCostMicro, STOP_MESSAGES };
