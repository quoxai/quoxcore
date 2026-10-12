/**
 * QuoxMind Analyser — Post-action review for objectives
 *
 * Stream QM Phase QM-2: The learning engine.
 *
 * After every objective reaches terminal state:
 * 1. Structured extraction (always, free) — quality score, failure chains, pattern signals
 * 2. Pattern matching (always, free) — check signals against known pattern library
 * 3. LLM diagnosis (failures only, ~$0.01) — root cause analysis, lesson extraction
 *
 * Feeds results into the Wisdom Store for compounding intelligence.
 */

import { getDatabase } from '../db/index.js'
import { recordWisdom, searchWisdom } from './wisdomStore.js'

// ── Known Pattern Library ────────────────────────────────────────────
// Seed patterns from observed failure modes. These get confirmed/updated
// by actual execution outcomes, raising their confidence over time.

const KNOWN_PATTERNS = [
  {
    signal: 'single_agent_bottleneck',
    patternName: 'single_agent_bottleneck',
    category: 'decomposition',
    severity: 'medium',
    lesson: 'Assigning all tasks to a single agent creates a serial bottleneck. Distribute across specialist agents where possible.',
    directive: 'AGENT_DIVERSITY: Distribute tasks across at least 2 different agents when >3 tasks exist.',
    tags: ['decomposition', 'agent', 'bottleneck', 'serial'],
  },
  {
    signal: 'fleet_ssh_operation',
    patternName: 'unbounded_fleet_operation',
    category: 'decomposition',
    severity: 'high',
    lesson: 'Fleet SSH operations with >10 targets frequently timeout when executed as a single task. Batch into canary + groups of 5-8 hosts.',
    directive: 'FLEET_BATCH: Do NOT create a single task for all hosts. Create: canary (1 host) → batch_1 (5 hosts) → batch_2 (5 hosts) → ... → verify_all.',
    tags: ['fleet', 'ssh', 'timeout', 'batch', 'hosts'],
  },
  {
    signal: 'fan_in_synthesis',
    patternName: 'fan_in_context_overload',
    category: 'execution',
    severity: 'medium',
    lesson: 'Synthesis tasks that depend on 3+ predecessors often receive too much context, causing timeouts or poor quality. Predecessor tasks should summarise their output.',
    directive: 'FAN_IN_PREP: For tasks with 3+ dependents, add "Summarise your output in 300 words or less" to predecessor task prompts.',
    tags: ['fan-in', 'synthesis', 'context', 'timeout'],
  },
  {
    signal: 'skip_cascade',
    patternName: 'dependency_cascade_failure',
    category: 'execution',
    severity: 'high',
    lesson: 'When >50% of tasks are skipped due to dependency failures, the objective decomposition may have too many sequential dependencies. Consider parallel-safe task design.',
    directive: 'PARALLEL_SAFE: Where possible, design tasks that can succeed independently even if some predecessors fail. Use partial results rather than hard dependencies.',
    tags: ['cascade', 'skip', 'dependency', 'parallel'],
  },
  {
    signal: 'high_failure_rate',
    patternName: 'systematic_failure',
    category: 'resource',
    severity: 'critical',
    lesson: 'High failure rate (>30%) indicates a systemic issue — resource unavailability, incorrect tool usage, or unreachable hosts.',
    directive: null, // No specific decomposition fix — needs investigation
    tags: ['failure', 'systemic', 'resource', 'investigation'],
  },
  {
    signal: 'long_running_task',
    patternName: 'task_duration_anomaly',
    category: 'execution',
    severity: 'low',
    lesson: 'Tasks exceeding 4 minutes may indicate inefficient prompts, large data processing, or tool timeouts. Consider splitting into smaller steps.',
    directive: null,
    tags: ['duration', 'timeout', 'slow', 'performance'],
  },
  {
    signal: 'collector_fetch_error',
    patternName: 'collector_fetch_failure',
    category: 'resource',
    severity: 'medium',
    lesson: 'Collector fetch failures typically indicate network timeout, collector overload, or LLM API unavailability. Check collector health and API rate limits before retrying.',
    directive: null,
    tags: ['fetch', 'collector', 'timeout', 'network'],
  },
  {
    signal: 'near_timeout',
    patternName: 'near_timeout_failure',
    category: 'execution',
    severity: 'medium',
    lesson: 'Tasks failing near the timeout limit (>4.5 minutes) need shorter scope, batch operations, or increased timeout for that operation type.',
    directive: 'TIMEOUT_PREVENTION: Split long-running operations into sub-tasks under 3 minutes each. For SSH batch ops, limit to 5 hosts per task.',
    tags: ['timeout', 'duration', 'slow', 'near-timeout'],
  },
  {
    signal: 'checkpoint_blocked',
    patternName: 'checkpoint_blocked_automation',
    category: 'execution',
    severity: 'medium',
    lesson: 'Only a human session can skip the pre-start checkpoint (P0b DEC-3): a service-key or agent caller passing skip_checkpoint=true is ignored and the human gate stands. Scheduled/template objectives avoid the gate by dispatching through the in-process scheduler path (dispatchObjective), not by skipping over HTTP.',
    directive: 'SKIP_CHECKPOINT: Do not rely on skip_checkpoint=true from an agent or service context; it only works for a human session (or a leased disposable-test sandbox). If an objective is blocked on a pre-start checkpoint, surface it for human approval instead of retrying the bypass.',
    tags: ['checkpoint', 'automation', 'approval', 'blocking', 'scheduled'],
  },
  // ── Cherry-picked from TriClaude (emergent, validated by 40K iterations) ──
  {
    signal: 'rate_limit_detected',
    patternName: 'rate_limit_cascade',
    category: 'resource',
    severity: 'high',
    lesson: 'Rate limiting (429 errors) causes cascading failures when tasks retry immediately. Use exponential backoff and consider routing to alternative providers during throttled periods.',
    directive: 'RATE_LIMIT_BACKOFF: If tasks are hitting rate limits, reduce parallel execution to 1 and add 30-second delays between tasks. Do not retry immediately.',
    tags: ['rate-limit', '429', 'throttle', 'backoff', 'cascade'],
    origin: 'triclaude-emergent',
  },
  {
    signal: 'auth_failure_detected',
    patternName: 'auth_failure_requires_human',
    category: 'resource',
    severity: 'critical',
    lesson: 'Authentication failures (invalid API key, expired token, 401/403) cannot be resolved by retrying. They require human intervention to refresh credentials. Do NOT retry auth failures.',
    directive: null,
    tags: ['auth', 'credentials', 'api-key', 'token', 'human-required'],
    origin: 'triclaude-emergent',
  },
  {
    signal: 'empty_response_detected',
    patternName: 'empty_response_worker_failure',
    category: 'execution',
    severity: 'medium',
    lesson: 'Empty or blank responses from agents indicate the worker is failing silently. This often precedes complete worker failure. Check agent health and collector logs.',
    directive: null,
    tags: ['empty', 'blank', 'silent-failure', 'worker', 'health'],
    origin: 'triclaude-emergent',
  },
  {
    signal: 'repeated_identical_failure',
    patternName: 'loop_without_new_evidence',
    category: 'execution',
    severity: 'high',
    lesson: 'The same task failing with the same error signature 3+ times indicates a loop. No new attempt should be made without either a new hypothesis or new evidence. Escalate or redesign the task.',
    directive: 'LOOP_BREAK: If a task has failed 3+ times with the same error, do NOT retry with the same approach. Either change the agent, change the prompt, or escalate to human.',
    tags: ['loop', 'retry', 'identical-failure', 'escalate', 'redesign'],
    origin: 'triclaude-emergent',
  },
  // ── NOC-specific patterns (NQ-5) ──────────────────────────────────
  {
    signal: 'host_unreachable',
    patternName: 'noc_host_unreachable',
    category: 'noc',
    severity: 'high',
    lesson: 'Target host is unreachable (connection refused, timeout, or DNS failure). Verify host is online, check bastion connectivity, and confirm firewall rules allow the connection.',
    directive: 'HOST_CHECK: Before executing NOC operations, verify host reachability via fleet_status or ping. If host was recently provisioned, allow 60s for network convergence.',
    tags: ['noc', 'host', 'unreachable', 'connection', 'timeout', 'ssh'],
  },
  {
    signal: 'noc_auth_expired',
    patternName: 'noc_auth_expired',
    category: 'noc',
    severity: 'critical',
    lesson: 'NOC service credentials have expired or been revoked (401/403). This affects all operations for that service until credentials are refreshed in the vault.',
    directive: null, // Requires human to refresh credentials
    tags: ['noc', 'auth', 'expired', 'credentials', 'vault', '401', '403'],
  },
  {
    signal: 'noc_service_timeout',
    patternName: 'noc_service_timeout',
    category: 'noc',
    severity: 'medium',
    lesson: 'NOC service API timed out. The target service may be overloaded, restarting, or experiencing resource contention. Retry after a brief delay.',
    directive: 'NOC_RETRY: Wait 15-30 seconds before retrying. If timeout persists across 3+ attempts, check service health directly.',
    tags: ['noc', 'timeout', 'service', 'overload', 'retry'],
  },
  {
    signal: 'noc_rate_limited',
    patternName: 'noc_rate_limited',
    category: 'noc',
    severity: 'medium',
    lesson: 'NOC service returned 429 (rate limited). Reduce request frequency and implement backoff. Batch operations where possible.',
    directive: 'NOC_BACKOFF: Reduce polling frequency to 1 request per 10 seconds. For bulk operations, batch into groups of 5 with 5-second delays between batches.',
    tags: ['noc', 'rate-limit', '429', 'throttle', 'backoff'],
  },
]

// ── Analyser ─────────────────────────────────────────────────────────

/**
 * Run post-action analysis on a completed objective.
 * Called after checkObjectiveCompletion records the outcome.
 *
 * @param {string} objectiveId
 * @param {Object} outcome — the outcome record from recordOutcome()
 * @returns {Object} analysis result with wisdom entries created/updated
 */
export function analyseObjective(objectiveId, outcome) {
  const db = getDatabase()
  if (!outcome) return { wisdomUpdates: [] }

  const signals = JSON.parse(outcome.pattern_signals || '[]')
  const wisdomUpdates = []

  // Step 1: Match signals against known pattern library
  for (const signal of signals) {
    const knownPattern = KNOWN_PATTERNS.find(p => p.signal === signal)
    if (!knownPattern) continue

    // Only record wisdom from failures/partial — don't learn bad patterns from successes
    if (outcome.quality_score >= 0.9 && knownPattern.severity !== 'low') {
      // Pattern signal detected but objective succeeded — this contradicts the pattern
      // Don't record it as a problem. Instead, search for existing wisdom and contradict if found.
      const existing = searchWisdom(outcome.org_id, knownPattern.patternName, { limit: 1 })
      if (existing.length > 0 && existing[0].pattern_name === knownPattern.patternName) {
        // Success contradicts the pattern — reduce confidence slightly
        // (but don't fully contradict — one success doesn't invalidate multiple failures)
        console.log(`[QuoxMind] Pattern "${knownPattern.patternName}" contradicted by successful execution (quality ${(outcome.quality_score * 100).toFixed(0)}%)`)
      }
      continue
    }

    // Failed or partial — record/reinforce the wisdom
    if (outcome.quality_score < 0.9) {
      const result = recordWisdom(outcome.org_id, {
        patternName: knownPattern.patternName,
        category: knownPattern.category,
        lesson: knownPattern.lesson,
        directive: knownPattern.directive,
        severity: knownPattern.severity,
        tags: knownPattern.tags,
        sourceObjectiveId: objectiveId,
      })
      wisdomUpdates.push(result)
    }
  }

  // Step 2: Record objective-specific failure patterns (from failure_summary)
  const failures = JSON.parse(outcome.failure_summary || '[]')
  for (const failure of failures) {
    // Detect specific error patterns
    if (failure.error && failure.error.includes('fetch failed')) {
      const result = recordWisdom(outcome.org_id, {
        patternName: 'collector_fetch_failure',
        category: 'resource',
        lesson: `Collector fetch failed for agent "${failure.agent}" during "${failure.task}". This typically indicates: network timeout, collector overload, or LLM API unavailability.`,
        severity: 'medium',
        tags: ['fetch', 'collector', 'timeout', 'network', failure.agent],
        sourceObjectiveId: objectiveId,
      })
      wisdomUpdates.push(result)
    }

    if (failure.error && (failure.error.includes('host not found') || failure.error.includes('404'))) {
      const result = recordWisdom(outcome.org_id, {
        patternName: 'host_not_found',
        category: 'resource',
        lesson: `Host not found in bastion registry. Agent "${failure.agent}" attempted to reach a host that isn't registered. Ensure host IDs match bastion registry (use hostnames, not IPs).`,
        severity: 'medium',
        tags: ['bastion', 'host', 'not-found', '404', failure.agent],
        sourceObjectiveId: objectiveId,
      })
      wisdomUpdates.push(result)
    }

    if (failure.duration_ms > 280000) { // > 4.5 minutes
      const result = recordWisdom(outcome.org_id, {
        patternName: 'near_timeout_failure',
        category: 'execution',
        lesson: `Task "${failure.task}" by agent "${failure.agent}" failed after ${Math.round(failure.duration_ms / 1000)}s — near the timeout limit. Consider: shorter tasks, batch operations, or increased timeout for this operation type.`,
        severity: 'medium',
        tags: ['timeout', 'duration', 'slow', failure.agent],
        sourceObjectiveId: objectiveId,
      })
      wisdomUpdates.push(result)
    }
  }

  // Part 3: Generate follow-up action items from failed tasks
  let followUpActions = []
  try {
    const failedTasks = JSON.parse(outcome.failure_summary || '[]')
    if (failedTasks.length > 0 && outcome.quality_score < 1.0) {
      followUpActions = failedTasks.map(t => ({
        title: `Follow up: ${(t.task || 'Unknown task').substring(0, 80)}`,
        description: `Task failed during objective "${outcome.title}". Error: ${(t.error || 'Unknown error').substring(0, 200)}`,
        priority: 'high',
        category: 'follow-up',
        source_objective_id: objectiveId,
        source_objective_title: outcome.title,
      }))
    }
  } catch { /* non-fatal */ }

  // Update the outcome record with wisdom IDs and follow-up actions
  if (wisdomUpdates.length > 0 || followUpActions.length > 0) {
    const wisdomIds = wisdomUpdates.map(w => w.id).filter(Boolean)
    db.prepare(`
      UPDATE objective_outcomes SET wisdom_ids = ?, follow_up_actions = ? WHERE objective_id = ?
    `).run(JSON.stringify(wisdomIds), JSON.stringify(followUpActions), objectiveId)
  }

  console.log(`[QuoxMind] Analysis complete for "${outcome.title}": ${wisdomUpdates.length} wisdom updates, ${followUpActions.length} follow-up actions, quality ${(outcome.quality_score * 100).toFixed(0)}%`)
  return { wisdomUpdates, signals, followUpActions }
}

/**
 * Get the known pattern library (for UI display / debugging).
 */
export function getKnownPatterns() {
  return KNOWN_PATTERNS
}
