/**
 * Topology Health — Agent health tracking, fallback selection, health-aware scheduling
 *
 * Stream AT Phase AT-4: QuoxEngine fallback routing
 *
 * - getTopologyHealth(): Cached health snapshot per agent (60s TTL)
 * - findFallbackAgent(): Find domain-compatible replacement when an agent fails
 * - sortTasksByAgentHealth(): Order tasks so healthy agents execute first
 * - computeHealthAdjustedConcurrency(): Reduce parallelism when agents are degraded
 */

import { getDatabase } from '../db/index.js'
import { selectBestAgent } from './agentSelector.js'

const CACHE_TTL_MS = 60000  // 60 seconds
const HEALTHY_THRESHOLD = 0.5  // >50% success = healthy

let healthCache = null
let healthCacheTime = 0
let healthCacheOrgId = null

/**
 * Get health snapshot for all agents in an org (last 1 hour of data).
 * Cached for 60 seconds.
 *
 * @param {string} orgId
 * @returns {Object} map of agentId → { status, successRate, avgLatency, taskCount }
 */
export function getTopologyHealth(orgId) {
  if (healthCache && healthCacheOrgId === orgId && Date.now() - healthCacheTime < CACHE_TTL_MS) {
    return healthCache
  }

  const db = getDatabase()
  const agents = db.prepare(`
    SELECT agent_id,
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      AVG(latency_ms) as avg_latency
    FROM agent_performance
    WHERE org_id = ? AND created_at > datetime('now', '-1 hour')
    GROUP BY agent_id
  `).all(orgId)

  const result = agents.reduce((acc, a) => {
    const successRate = a.total > 0 ? a.successes / a.total : 0
    acc[a.agent_id] = {
      status: a.total === 0 ? 'unknown' : (successRate > HEALTHY_THRESHOLD ? 'healthy' : 'degraded'),
      successRate,
      avgLatency: Math.round(a.avg_latency || 0),
      taskCount: a.total,
    }
    return acc
  }, {})

  healthCache = result
  healthCacheTime = Date.now()
  healthCacheOrgId = orgId
  return result
}

/**
 * Reset the health cache (for testing).
 */
export function _resetCache() {
  healthCache = null
  healthCacheTime = 0
  healthCacheOrgId = null
}

/**
 * Find a fallback agent when the original agent has exhausted retries.
 * Looks for agents in the same team that share at least one domain.
 *
 * @param {string} orgId
 * @param {string} failedAgentId — the agent that failed
 * @param {Object} manifest — team manifest
 * @param {string[]} [failedDomains] — domains to match (auto-detected from manifest if omitted)
 * @returns {Promise<{ agentId: string, score: number, reason: string } | null>}
 */
export async function findFallbackAgent(orgId, failedAgentId, manifest, failedDomains = null) {
  if (!manifest?.members) return null

  // Find the failed agent's domains
  if (!failedDomains) {
    const failedMember = manifest.members.find(m => m.agentId === failedAgentId)
    failedDomains = failedMember?.domains || []
  }
  if (!failedDomains || failedDomains.length === 0) return null

  // Find candidates: other agents that share at least one domain
  const candidates = manifest.members
    .filter(m => m.agentId !== failedAgentId && m.domains?.some(d => failedDomains.includes(d)))
    .map(m => m.agentId)

  if (candidates.length === 0) return null

  // Use learning router to pick the best candidate (QMH-4e: bandit if
  // licensed, round-robin otherwise — async).
  const best = await selectBestAgent(orgId, failedDomains[0], candidates)
  return best.agentId ? best : null
}

/**
 * Sort tasks by agent health — healthy agents first.
 *
 * @param {Array} tasks — array of task objects with agent_id
 * @param {string} orgId
 * @returns {Array} sorted copy
 */
export function sortTasksByAgentHealth(tasks, orgId) {
  const health = getTopologyHealth(orgId)

  return [...tasks].sort((a, b) => {
    const ha = health[a.agent_id]?.successRate ?? 0.5
    const hb = health[b.agent_id]?.successRate ?? 0.5
    return hb - ha  // higher success rate first
  })
}

/**
 * Compute health-adjusted concurrency limit.
 * Reduces max parallel tasks when many agents are degraded.
 *
 * @param {string} orgId
 * @param {number} maxParallel — configured maximum
 * @returns {number} adjusted maximum (at least 1)
 */
export function computeHealthAdjustedConcurrency(orgId, maxParallel) {
  const health = getTopologyHealth(orgId)
  const agents = Object.values(health)

  if (agents.length === 0) return maxParallel

  const healthyCount = agents.filter(a => a.status === 'healthy').length
  const totalCount = agents.length

  if (totalCount === 0) return maxParallel
  const healthRatio = healthyCount / totalCount

  if (healthRatio >= 0.5) return maxParallel
  // <50% healthy: reduce proportionally, never below 1
  return Math.max(1, Math.floor(maxParallel * Math.max(healthRatio, 0) * 2))
}
