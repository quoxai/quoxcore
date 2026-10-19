/**
 * QuoxMind Wisdom Store — Persistent execution intelligence
 *
 * Stream QM Phase QM-1: The data foundation for QuoxMind.
 *
 * Stores distilled execution patterns (not raw logs) that compound over time.
 * Wisdom entries have a confidence lifecycle:
 *   1st occurrence → 0.5 (tentative)
 *   2nd occurrence → 0.7 (established)
 *   3rd+ → 0.85+ (core wisdom)
 *   90 days unseen → decay by 0.1/month
 *   Contradicted → -0.2
 *   User confirmed → 1.0
 */

import { getDatabase } from '../db/index.js'
import { ulid } from 'ulid'
import { NOT_EVENT_LOG_SQL, rankWisdom, keywords, markInjected, decayWisdom } from './wisdomHygiene.js'

// ── Seed Patterns ────────────────────────────────────────────────────
// Patterns proven at high confidence from overnight runs.
// New wisdom entries for these patterns start at 0.7 instead of 0.5.
const SEED_PATTERNS = new Set([
  'unbounded_fleet_operation',
  'fan_in_context_overload',
  'task_duration_anomaly',
  'collector_fetch_failure',
  'near_timeout_failure',
  'checkpoint_blocked_automation',
])

// ── Wisdom CRUD ──────────────────────────────────────────────────────

/**
 * Create or update a wisdom entry. If a pattern with the same name exists,
 * increment its occurrence count and update confidence.
 */
export function recordWisdom(orgId, { patternName, category, lesson, directive, severity, tags, sourceObjectiveId }) {
  const db = getDatabase()

  // Check if pattern already exists
  const existing = db.prepare(`
    SELECT * FROM execution_wisdom WHERE pattern_name = ? AND (org_id = ? OR org_id IS NULL) AND active = 1
  `).get(patternName, orgId)

  if (existing) {
    // Update existing — increment occurrence, raise confidence
    const newCount = existing.occurrence_count + 1
    const newConfidence = Math.min(0.98, existing.confidence + (newCount === 2 ? 0.2 : 0.08))
    const sourceIds = JSON.parse(existing.source_objective_ids || '[]')
    if (sourceObjectiveId && !sourceIds.includes(sourceObjectiveId)) {
      sourceIds.push(sourceObjectiveId)
    }

    db.prepare(`
      UPDATE execution_wisdom
      SET occurrence_count = ?, confidence = ?, last_seen_at = datetime('now'),
          source_objective_ids = ?, updated_at = datetime('now'),
          lesson = CASE WHEN ? != '' THEN ? ELSE lesson END,
          decomposition_directive = CASE WHEN ? IS NOT NULL THEN ? ELSE decomposition_directive END
      WHERE id = ?
    `).run(
      newCount, newConfidence,
      JSON.stringify(sourceIds),
      lesson || '', lesson || '',
      directive !== undefined ? directive : null, directive !== undefined ? directive : null,
      existing.id
    )

    console.log(`[QuoxMind] Wisdom updated: "${patternName}" — confidence ${existing.confidence.toFixed(2)} → ${newConfidence.toFixed(2)} (seen ${newCount}×)`)
    return { ...existing, occurrence_count: newCount, confidence: newConfidence, updated: true }
  }

  // Create new wisdom entry
  // Seed patterns start at higher confidence (0.7) — they are proven from overnight runs
  const initialConfidence = SEED_PATTERNS.has(patternName) ? 0.7 : 0.5
  const id = ulid()
  db.prepare(`
    INSERT INTO execution_wisdom (id, org_id, pattern_name, category, lesson, decomposition_directive,
      severity, confidence, occurrence_count, first_seen_at, last_seen_at, source_objective_ids, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), ?, ?)
  `).run(
    id, orgId, patternName, category || 'execution', lesson, directive || null,
    severity || 'medium', initialConfidence,
    JSON.stringify(sourceObjectiveId ? [sourceObjectiveId] : []),
    JSON.stringify(tags || [])
  )

  console.log(`[QuoxMind] New wisdom: "${patternName}" — confidence ${initialConfidence.toFixed(2)} (first occurrence${SEED_PATTERNS.has(patternName) ? ', seed pattern' : ''})`)
  return { id, patternName, confidence: initialConfidence, occurrence_count: 1, created: true }
}

/**
 * Search wisdom by keyword (FTS-like using LIKE).
 */
export function searchWisdom(orgId, query, { limit = 10, minConfidence = 0, activeOnly = true, includeEvents = false } = {}) {
  const db = getDatabase()
  const conditions = ['(org_id = ? OR org_id IS NULL)']
  const params = [orgId]

  if (activeOnly) {
    conditions.push('active = 1')
  }
  // #1112: plugin event logs are not lessons; recall must not surface them as wisdom.
  if (!includeEvents) {
    conditions.push(NOT_EVENT_LOG_SQL)
  }
  if (minConfidence > 0) {
    conditions.push('confidence >= ?')
    params.push(minConfidence)
  }
  if (query) {
    conditions.push('(lesson LIKE ? OR pattern_name LIKE ? OR tags LIKE ?)')
    const q = `%${query}%`
    params.push(q, q, q)
  }

  params.push(limit)
  return db.prepare(`
    SELECT * FROM execution_wisdom
    WHERE ${conditions.join(' AND ')}
    ORDER BY confidence DESC, occurrence_count DESC
    LIMIT ?
  `).all(...params)
}

/**
 * Get wisdom relevant to a given text (title + description), ready for prompt
 * injection by the Advisor. #1112: event logs excluded, one row per pattern
 * (org-scoped beats global), fresh and confident first, capped at `limit`
 * items and `charBudget` characters. `markInjected: true` (the advisor only)
 * records consumption so /mind can tell used wisdom from shelf wisdom.
 */
export function getRelevantWisdom(orgId, text, { minConfidence = 0.5, limit = 5, charBudget = 1500, markInjected: mark = false } = {}) {
  const db = getDatabase()
  if (!text) return []

  const words = keywords(text, 8)
  if (words.length === 0) return []

  const likeConditions = words.map(() => '(lesson LIKE ? OR pattern_name LIKE ? OR tags LIKE ? OR decomposition_directive LIKE ?)')
  const likeParams = words.flatMap(w => {
    const p = `%${w}%`
    return [p, p, p, p]
  })

  // Over-fetch candidates, then de-duplicate, freshness-rank and budget in JS.
  const candidates = db.prepare(`
    SELECT *, (${likeConditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(' + ')}) as relevance_score
    FROM execution_wisdom
    WHERE (org_id = ? OR org_id IS NULL) AND active = 1 AND confidence >= ?
      AND ${NOT_EVENT_LOG_SQL}
      AND (${likeConditions.join(' OR ')})
    ORDER BY relevance_score DESC, confidence DESC
    LIMIT ?
  `).all(...likeParams, orgId, minConfidence, ...likeParams, Math.max(limit * 4, 20))

  const picked = rankWisdom(candidates, { orgId, limit, charBudget })
  if (mark && picked.length > 0) markInjected(db, picked.map(w => w.id))
  return picked
}

/**
 * Reduce confidence when a pattern is contradicted by success.
 */
export function contradictWisdom(wisdomId) {
  const db = getDatabase()
  const wisdom = db.prepare('SELECT * FROM execution_wisdom WHERE id = ?').get(wisdomId)
  if (!wisdom) return null

  const newConfidence = Math.max(0.1, wisdom.confidence - 0.2)
  db.prepare(`
    UPDATE execution_wisdom SET confidence = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newConfidence, wisdomId)

  console.log(`[QuoxMind] Wisdom contradicted: "${wisdom.pattern_name}" — confidence ${wisdom.confidence.toFixed(2)} → ${newConfidence.toFixed(2)}`)

  // Deactivate if confidence drops too low
  if (newConfidence < 0.2) {
    db.prepare('UPDATE execution_wisdom SET active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(wisdomId)
    console.log(`[QuoxMind] Wisdom deactivated: "${wisdom.pattern_name}" (confidence below 0.2)`)
  }

  return { ...wisdom, confidence: newConfidence }
}

/**
 * User confirms a wisdom entry — sets confidence to 1.0.
 */
export function confirmWisdom(wisdomId) {
  const db = getDatabase()
  db.prepare(`
    UPDATE execution_wisdom SET confidence = 1.0, updated_at = datetime('now') WHERE id = ?
  `).run(wisdomId)
  return db.prepare('SELECT * FROM execution_wisdom WHERE id = ?').get(wisdomId)
}

/**
 * List all wisdom entries for an org.
 */
export function listWisdom(orgId, { activeOnly = true, limit = 50 } = {}) {
  const db = getDatabase()
  const where = activeOnly ? 'AND active = 1' : ''
  return db.prepare(`
    SELECT * FROM execution_wisdom
    WHERE (org_id = ? OR org_id IS NULL) ${where}
    ORDER BY confidence DESC, occurrence_count DESC
    LIMIT ?
  `).all(orgId, limit)
}

// ── Outcome Recording ────────────────────────────────────────────────

/**
 * Record the outcome of a completed objective.
 * Called from checkObjectiveCompletion() after status is set.
 */
export function recordOutcome(objective, tasks) {
  const db = getDatabase()

  const completed = tasks.filter(t => t.status === 'completed')
  const failed = tasks.filter(t => t.status === 'failed')
  const skipped = tasks.filter(t => t.status === 'skipped')

  const qualityScore = tasks.length > 0 ? completed.length / tasks.length : 0
  const totalDuration = tasks.reduce((sum, t) => sum + (t.duration_ms || 0), 0)

  const failureSummary = failed.map(t => ({
    task: t.title,
    agent: t.agent_id,
    error: (t.result || '').substring(0, 200),
    duration_ms: t.duration_ms || 0,
  }))

  const successSummary = completed.map(t => ({
    task: t.title,
    agent: t.agent_id,
    duration_ms: t.duration_ms || 0,
    tokens: t.tokens_used || 0,
  }))

  // Detect pattern signals
  const signals = detectPatternSignals(objective, tasks)

  const id = ulid()
  db.prepare(`
    INSERT INTO objective_outcomes (id, objective_id, org_id, title, team_id, status,
      quality_score, total_duration_ms, task_count, tasks_completed, tasks_failed, tasks_skipped,
      failure_summary, success_summary, pattern_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, objective.id, objective.org_id, objective.title, objective.team_id || null, objective.status,
    qualityScore, totalDuration, tasks.length, completed.length, failed.length, skipped.length,
    JSON.stringify(failureSummary), JSON.stringify(successSummary), JSON.stringify(signals)
  )

  console.log(`[QuoxMind] Outcome recorded: "${objective.title}" — quality ${(qualityScore * 100).toFixed(0)}%, ${signals.length} pattern signals`)
  return { id, qualityScore, signals }
}

/**
 * Query past outcomes similar to a given objective (by keyword matching on title).
 */
export function findSimilarOutcomes(orgId, title, { limit = 3 } = {}) {
  const db = getDatabase()
  if (!title) return []

  const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5)
  if (words.length === 0) return []

  const conditions = words.map(() => 'LOWER(title) LIKE ?')
  const params = words.map(w => `%${w}%`)

  return db.prepare(`
    SELECT * FROM objective_outcomes
    WHERE org_id = ? AND (${conditions.join(' OR ')})
    ORDER BY created_at DESC
    LIMIT ?
  `).all(orgId, ...params, limit)
}

// ── Pattern Detection ────────────────────────────────────────────────

/**
 * Detect pattern signals from a completed objective.
 * These are heuristic flags that the Analyser can use.
 */
function detectPatternSignals(objective, tasks) {
  const signals = []

  // Single agent did all tasks
  const agents = new Set(tasks.map(t => t.agent_id).filter(Boolean))
  if (agents.size === 1 && tasks.length > 2) {
    signals.push('single_agent_bottleneck')
  }

  // Detect fleet-like operations (many tasks with SSH-like prompts)
  const sshTasks = tasks.filter(t => (t.prompt || '').toLowerCase().includes('ssh') || (t.prompt || '').toLowerCase().includes('host'))
  if (sshTasks.length >= 3) {
    signals.push('fleet_ssh_operation')
  }

  // Fan-in: last task depends on 3+ others
  const lastTask = tasks[tasks.length - 1]
  if (lastTask) {
    const deps = JSON.parse(lastTask.depends_on || '[]')
    if (deps.length >= 3) {
      signals.push('fan_in_synthesis')
    }
  }

  // High failure rate
  const failRate = tasks.filter(t => t.status === 'failed').length / Math.max(tasks.length, 1)
  if (failRate > 0.3) {
    signals.push('high_failure_rate')
  }

  // Timeout pattern: any task took > 4 minutes
  if (tasks.some(t => (t.duration_ms || 0) > 240000)) {
    signals.push('long_running_task')
  }

  // Skipped cascade: >50% tasks skipped
  const skipRate = tasks.filter(t => t.status === 'skipped').length / Math.max(tasks.length, 1)
  if (skipRate > 0.5) {
    signals.push('skip_cascade')
  }

  return signals
}

// ── NOC Tool Outcome Recording (NQ-5) ───────────────────────────────

/**
 * Ensure the noc_tool_outcomes table exists.
 * Called lazily on first recordNocOutcome().
 */
let _nocTableReady = false
function ensureNocTable() {
  if (_nocTableReady) return
  const db = getDatabase()
  db.exec(`
    CREATE TABLE IF NOT EXISTS noc_tool_outcomes (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      tool_name TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER DEFAULT 0,
      error TEXT,
      agent_id TEXT,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_noc_outcomes_tool ON noc_tool_outcomes(tool_name);
    CREATE INDEX IF NOT EXISTS idx_noc_outcomes_org ON noc_tool_outcomes(org_id);
    CREATE INDEX IF NOT EXISTS idx_noc_outcomes_created ON noc_tool_outcomes(created_at);
  `)
  _nocTableReady = true
}

/**
 * Record the outcome of an individual NOC tool execution.
 * Lightweight — stores one row per tool call for pattern detection.
 *
 * @param {string} toolName - Tool identifier (e.g. 'docker_fleet_container_action')
 * @param {boolean} success - Whether the tool succeeded
 * @param {number} durationMs - Execution time in milliseconds
 * @param {object} opts - Additional context
 * @param {string} [opts.orgId] - Organization ID
 * @param {string} [opts.agentId] - Agent that invoked the tool
 * @param {string} [opts.userId] - User ID
 * @param {string} [opts.error] - Error message (truncated to 500 chars)
 */
export function recordNocOutcome(toolName, success, durationMs, opts = {}) {
  try {
    ensureNocTable()
    const db = getDatabase()
    const id = ulid()
    db.prepare(`
      INSERT INTO noc_tool_outcomes (id, org_id, tool_name, success, duration_ms, error, agent_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      opts.orgId || null,
      toolName,
      success ? 1 : 0,
      durationMs || 0,
      opts.error ? String(opts.error).substring(0, 500) : null,
      opts.agentId || null,
      opts.userId || null
    )
  } catch (err) {
    // Non-blocking — never fail the tool execution due to outcome recording
    console.warn(`[QuoxMind] NOC outcome recording failed: ${err.message}`)
  }
}

// ── Confidence Decay ─────────────────────────────────────────────────

/**
 * Run confidence decay on stale wisdom entries. #1112: at most 0.1 per 30
 * days per row (was 0.1 per call), never on user-confirmed rows, and rows
 * below 0.2 retire with a reason. Scheduled by mindRetirementScheduler.
 */
export function decayStaleWisdom(daysThreshold = 90) {
  const decayed = decayWisdom(getDatabase(), { staleDays: daysThreshold })
  if (decayed > 0) {
    console.log(`[QuoxMind] Decayed ${decayed} stale wisdom entries (older than ${daysThreshold} days)`)
  }
  return decayed
}
