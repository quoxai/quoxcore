/**
 * quoxBrainRules/index.js — rule registry for Quox Brain V1
 *
 * Each rule exports { id, evaluate(ctx) } → { matches: bool, payload? }.
 * runAllRules gathers context per-rule, evaluates each, and returns
 * an array of firing suggestions scored by priority.
 *
 * Score hierarchy (higher = more urgent):
 *  - failing-workflow      40
 *  - tool-cost-spike       35
 *  - objective-stuck       30
 *  - usage-frequency-…     25
 *  - crystal-promotion-…   20
 *  - unused-agent          10
 */

const usageFrequencyCrystallise = require('./usageFrequencyCrystallise');
const unusedAgent = require('./unusedAgent');
const failingWorkflow = require('./failingWorkflow');
const objectiveStuck = require('./objectiveStuck');
const toolCostSpike = require('./toolCostSpike');
const crystalPromotionReady = require('./crystalPromotionReady');

const RULES = [
  usageFrequencyCrystallise,
  unusedAgent,
  failingWorkflow,
  objectiveStuck,
  toolCostSpike,
  crystalPromotionReady,
];

const RULE_SCORES = {
  'failing-workflow': 40,
  'tool-cost-spike': 35,
  'objective-stuck': 30,
  'usage-frequency-crystallise': 25,
  'crystal-promotion-ready': 20,
  'unused-agent': 10,
};

/**
 * Run all rules against the provided context and return all matches.
 *
 * @param {object} ctx — aggregated context built by the API handler
 * @param {string} ctx.orgId
 * @param {string} ctx.tier
 * @param {Array}  ctx.recentRuns
 * @param {Array}  ctx.crystals
 * @param {Array}  ctx.agents
 * @param {Array}  ctx.recentInvocations
 * @param {Array}  ctx.objectives
 * @param {Array}  ctx.progressEnvelopes
 * @param {Array}  ctx.toolCosts
 * @param {Array}  ctx.crystalCandidates
 * @returns {Array<{ id, score, payload }>}
 */
function runAllRules(ctx = {}) {
  const suggestions = [];

  for (const rule of RULES) {
    try {
      const result = rule.evaluate(ctx);
      if (result && result.matches) {
        suggestions.push({
          id: rule.id,
          score: RULE_SCORES[rule.id] ?? 0,
          payload: result.payload,
        });
      }
    } catch (err) {
      // Log but never crash — a bad rule should not block other suggestions
      console.warn(`[QuoxBrain] Rule ${rule.id} threw:`, err.message);
    }
  }

  // Sort descending by score
  suggestions.sort((a, b) => b.score - a.score);

  return suggestions;
}

module.exports = { RULES, runAllRules };
