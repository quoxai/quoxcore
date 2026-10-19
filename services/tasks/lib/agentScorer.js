/**
 * Agent Scorer — Performance tracking and composite scoring for the learning router
 *
 * Stream AT Phase AT-3: QuoxEngine learning router
 *
 * Tracks per-agent task outcomes and computes a composite score used by
 * the epsilon-greedy selector to route tasks to the best-performing agent.
 *
 * Scoring weights: success_rate 35%, speed 20%, cost_efficiency 20%, quality 25%
 * Confidence: ramps from 0→1 over WINDOW tasks. Cold start returns neutral 50.
 */

import { getDatabase } from '../db/index.js'
import { ulid } from 'ulid'

const WINDOW = 30  // rolling window of recent tasks

// AT-3: Simple domain inference from task title keywords. Shared by the
// decomposer (routing lookup) and the QuoxFlow poller (performance recording)
// so a recorded row lands in the same domain the router later queries.
export function inferDomainFromTitle(title) {
  const t = (title || '').toLowerCase()
  if (t.match(/security|audit|scan|vuln|cve|firewall/)) return 'security'
  if (t.match(/deploy|docker|ci|cd|build|release/)) return 'devops'
  if (t.match(/network|dns|route|vpn|ssl|cert/)) return 'network'
  if (t.match(/monitor|metric|alert|health|status/)) return 'monitoring'
  if (t.match(/database|sql|migration|backup|restore/)) return 'database'
  if (t.match(/test|qa|quality|validate|verify/)) return 'testing'
  if (t.match(/api|rest|graphql|endpoint/)) return 'api'
  if (t.match(/frontend|ui|react|css|component/)) return 'frontend'
  if (t.match(/backend|server|service/)) return 'backend'
  if (t.match(/doc|readme|changelog|report/)) return 'documentation'
  if (t.match(/browser|website|web page|screenshot|scrape|fill form|login to|navigate to|extract from.*site|download.*from|monitor.*site|open.*url/)) return 'web-automation'
  return 'general'
}

/**
 * Record a task's performance outcome.
 *
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} taskId
 * @param {string} objectiveId
 * @param {Object} metrics
 * @param {boolean} metrics.success
 * @param {number} metrics.latencyMs
 * @param {number} metrics.tokensUsed
 * @param {string} [metrics.domain]
 * @param {number} [metrics.qualityScore] — override from heuristic or orchestrator
 */
export function recordPerformance(orgId, agentId, taskId, objectiveId, { success, latencyMs, tokensUsed, domain, qualityScore }) {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO agent_performance (id, org_id, agent_id, task_id, objective_id, success, quality_score, latency_ms, tokens_used, domain, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    ulid(), orgId, agentId, taskId, objectiveId,
    success ? 1 : 0,
    qualityScore ?? 50,
    latencyMs || 0,
    tokensUsed || 0,
    domain || 'general'
  )
}

/**
 * Compute quality score from automated heuristics (no LLM call).
 *
 * Base: 50
 * +20 if schema validation passed
 * +10 if result length > 100 chars
 * +10 if tools were used
 * +10 if no retry was needed (first attempt)
 * Max: 100
 *
 * @param {Object} metrics
 * @returns {number} 50-100
 */
export function computeQualityScore({ result, schemaValid, toolsUsed, wasRetry }) {
  let score = 50
  if (schemaValid) score += 20
  if (result && result.length > 100) score += 10
  if (toolsUsed && toolsUsed > 0) score += 10
  if (!wasRetry) score += 10
  return Math.min(score, 100)
}

/**
 * Get composite score for an agent, optionally filtered by domain.
 *
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} [domain] — filter to specific domain
 * @returns {{ score: number, successRate: number, avgQuality: number, latencyP95: number, avgCost: number, confidence: number, taskCount: number }}
 */
export function getAgentScore(orgId, agentId, domain = null) {
  const db = getDatabase()

  const params = [orgId, agentId]
  let domainClause = ''
  if (domain) {
    domainClause = 'AND domain = ?'
    params.push(domain)
  }
  params.push(WINDOW)

  const rows = db.prepare(`
    SELECT success, quality_score, latency_ms, tokens_used
    FROM agent_performance
    WHERE org_id = ? AND agent_id = ? ${domainClause}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params)

  if (rows.length === 0) return coldStartScore()

  const successRate = rows.filter(r => r.success).length / rows.length
  const avgQuality = rows.reduce((s, r) => s + (r.quality_score || 50), 0) / rows.length
  const latencies = rows.map(r => r.latency_ms).filter(Boolean).sort((a, b) => a - b)
  const latencyP95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 5000
  const avgTokens = rows.reduce((s, r) => s + (r.tokens_used || 0), 0) / rows.length

  // Normalised sub-scores (0-100)
  const speedScore = Math.max(0, Math.min(100, 100 - (latencyP95 / 100)))  // 0ms=100, 10000ms=0
  const costScore = Math.max(0, Math.min(100, 100 - (avgTokens / 500)))     // 0tok=100, 50000tok=0

  const composite = (
    successRate * 100 * 0.35 +
    speedScore * 0.20 +
    costScore * 0.20 +
    (avgQuality / 100) * 100 * 0.25
  )

  // Confidence: ramps linearly from 0→1 over WINDOW tasks
  const confidence = Math.min(rows.length / WINDOW, 1.0)

  // Guard against NaN from edge cases
  const safeComposite = isFinite(composite) ? composite : 50

  // Blend composite with neutral prior based on confidence
  const prior = 50
  const blendedScore = safeComposite * confidence + prior * (1 - confidence)

  return {
    score: Math.round(blendedScore * 100) / 100,
    successRate,
    avgQuality: Math.round(avgQuality),
    latencyP95,
    avgCost: avgTokens,
    confidence: Math.round(confidence * 100) / 100,
    taskCount: rows.length,
  }
}

function coldStartScore() {
  return {
    score: 50,
    successRate: 0,
    avgQuality: 50,
    latencyP95: 5000,
    avgCost: 0,
    confidence: 0,
    taskCount: 0,
  }
}
