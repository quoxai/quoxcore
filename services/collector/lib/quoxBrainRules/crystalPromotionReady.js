/**
 * QuoxBrain Rule: crystal-promotion-ready
 *
 * Trigger: A candidate Crystal has consecutive_success ≥ 2 AND
 * the org is on tier_b or higher.
 *
 * Only fires for tier_b+; free tier orgs are excluded.
 *
 * ctx: {
 *   crystalCandidates: Array<{ id, name, consecutive_success, status }>
 *   tier: string  e.g. 'tier_free' | 'tier_b' | 'tier_a'
 * }
 */

const TIER_RANKS = {
  tier_free: 0,
  tier_b: 1,
  tier_a: 2,
  enterprise: 3,
};

const MIN_CONSECUTIVE = 2;
const id = 'crystal-promotion-ready';

function evaluate(ctx = {}) {
  const { crystalCandidates = [], tier = 'tier_free' } = ctx;

  // Enforce tier gate
  const tierRank = TIER_RANKS[tier] ?? 0;
  if (tierRank < TIER_RANKS['tier_b']) {
    return { matches: false };
  }

  if (crystalCandidates.length === 0) {
    return { matches: false };
  }

  // Find first qualifying candidate
  const qualifying = crystalCandidates.find(
    (c) => (c.consecutive_success || 0) >= MIN_CONSECUTIVE,
  );

  if (!qualifying) {
    return { matches: false };
  }

  return {
    matches: true,
    payload: {
      crystalId: qualifying.id,
      name: qualifying.name,
    },
  };
}

module.exports = { id, evaluate };
