/**
 * Agent Selector — Learning router for agent selection.
 *
 * Stream AT Phase AT-3: epsilon-greedy bandit (90% exploit, 10% explore).
 * QMH-4e: bandit gated to quoxmind-pro and above. Free orgs get round-
 * robin across the candidate list — deterministic, no scores read.
 *
 * 90% of the time, selects the highest-scoring agent (exploit).
 * 10% of the time, selects a random agent (explore).
 * This simple multi-armed bandit converges in 50-100 tasks without ML
 * infrastructure. Without quoxmind-pro it falls back to round-robin so
 * that free orgs still get even agent distribution but without the
 * adaptive learning behaviour.
 */

import { getAgentScore } from './agentScorer.js'
import { isPluginLicensed } from './licenseGate.js'

const EPSILON = 0.10  // 10% exploration rate

// Per-(org, domain) cursor for the round-robin fallback. Module-scoped —
// resets on process restart, which is fine for "even distribution"; we
// don't need durable state.
const roundRobinCursor = new Map()

function nextRoundRobin(orgId, domain, candidates) {
  const key = `${orgId}:${domain}`
  const i = (roundRobinCursor.get(key) ?? 0) % candidates.length
  roundRobinCursor.set(key, i + 1)
  return candidates[i]
}

/**
 * Test-only: reset the round-robin cursor.
 */
export function _resetRouterState() {
  roundRobinCursor.clear()
}

/**
 * Select the best agent for a task from a list of candidates.
 *
 * @param {string} orgId
 * @param {string} domain — task domain for domain-specific scoring
 * @param {string[]} candidateAgentIds — agents eligible for this task
 * @returns {Promise<{ agentId: string, score: number, confidence: number, reason: string }>}
 */
export async function selectBestAgent(orgId, domain, candidateAgentIds) {
  if (!candidateAgentIds || candidateAgentIds.length === 0) {
    return {
      agentId: null,
      score: 50,
      successRate: 0,
      avgQuality: 50,
      latencyP95: 5000,
      avgCost: 0,
      confidence: 0,
      taskCount: 0,
      reason: 'no_candidates',
    }
  }

  if (candidateAgentIds.length === 1) {
    const score = getAgentScore(orgId, candidateAgentIds[0], domain)
    return { agentId: candidateAgentIds[0], ...score, reason: 'only_candidate' }
  }

  // QMH-4e — bandit is licensed; round-robin is the free-tier fallback.
  const banditLicensed =
    (await isPluginLicensed(orgId, 'quoxmind-pro')) ||
    (await isPluginLicensed(orgId, 'quoxmind-complete'))

  if (!banditLicensed) {
    const agentId = nextRoundRobin(orgId, domain, candidateAgentIds)
    return {
      agentId,
      score: 50,
      successRate: 0,
      avgQuality: 50,
      latencyP95: 5000,
      avgCost: 0,
      confidence: 0,
      taskCount: 0,
      reason: 'round_robin',
    }
  }

  const scores = candidateAgentIds.map(id => ({
    agentId: id,
    ...getAgentScore(orgId, id, domain),
  }))

  // Epsilon-greedy: 90% exploit best, 10% explore random
  if (Math.random() < EPSILON) {
    const pick = scores[Math.floor(Math.random() * scores.length)]
    return { ...pick, reason: 'explore' }
  }

  // Exploit: pick highest score
  scores.sort((a, b) => b.score - a.score)
  return { ...scores[0], reason: 'exploit' }
}
