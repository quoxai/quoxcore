// QuoxCORE Background Task Service
// Phase 4.B: Rate limiting, validation, decompose-only flow, AEE envelopes, team_id
import express from 'express'
import { readFileSync } from 'fs'
// Safety net: forward async (req,res) handler rejections to the error middleware
// instead of hanging the request (Express 4 doesn't do this by default).
import 'express-async-errors'
import cors from 'cors'
import helmet from 'helmet'
import { ulid } from 'ulid'

import { initDatabase, getDatabase, closeDatabase } from './db/index.js'
import { isRecognisedLoopBackend, normalizeLoopBackend, availableBackendsPhrase } from './lib/loopProviders.js'
import { authenticate, requireHumanApprover, requireHumanApproverUnlessSandbox, requireStepUpApprove } from './middleware/auth.js'
import { decomposeObjective } from './lib/decomposer.js'
import { computeDAG, checkObjectiveCompletion } from './lib/dagUtils.js'
import { dispatchObjective } from './lib/objectiveDispatch.js'
import { runBootReconciler, startReaper, stopReaper } from './lib/objectiveReconciler.js'
import { checkBudget } from './lib/budget.js'
import { validateExitPredicate } from './lib/exitPredicate.js'
import { subscribe, emitProgress } from './lib/progress.js'
import { validateTeamManifest, installTeam, uninstallTeam, getTeamDefinition, listTeamDefinitions, createTeamInstance, getTeamInstance, updateTeamInstanceStatus, getTeamContext, updateTeamContext } from './lib/teamLoader.js'
import { installPack as installPackFromManifest, exportTeam } from './lib/packLoader.js'
import { createSchedule, updateSchedule, deleteSchedule, getSchedule, listSchedules, toggleSchedule, getDailyUsage, startTeamScheduler, stopTeamScheduler } from './lib/teamScheduler.js'
import { createAgentSchedule, updateAgentSchedule, deleteAgentSchedule, getAgentSchedule, listAgentSchedules, toggleAgentSchedule, getAutonomySummary, startAgentScheduler, stopAgentScheduler } from './lib/agentScheduler.js'
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, getCalendarEvent, listCalendarEvents, startCalendarReminderPoller, stopCalendarReminderPoller } from './lib/calendarEvents.js'
import { naturalLanguageToCron } from './lib/nlCron.js'
import { getDecisionHistory, getDecisionStats } from './lib/autonomyDecision.js'
import { recordStandingEvent, resolveTaskClass, getStandingWithHistory } from './lib/agentStanding.js'
import { startDreamCycle, getDreamStats, runDreamCycle } from './lib/dreamCycle.js'
import { saveObjectiveTemplate, listObjectiveTemplates, getObjectiveTemplate, instantiateTemplate } from './lib/objectiveChaining.js'
import { searchWisdom, getRelevantWisdom, listWisdom, recordWisdom } from './lib/wisdomStore.js'
import { isValidCron, getNextCronRun } from './lib/cronParser.js'
import { getObjectiveFailureReason } from './lib/failureReason.js'
import { computeTemporalStats } from './lib/temporalStats.js'
import { computePredictStats } from './lib/predictStats.js'
import { createMindRetirementScheduler } from './lib/mindRetirementScheduler.js'
import { computeReflectStats } from './lib/reflectStats.js'
import { computeImplantActivity } from './lib/implantActivity.js'
import { computeLearnStats } from './lib/learnStats.js'
import { computeExecutiveStats } from './lib/executiveStats.js'
import { computeSenseStats } from './lib/senseStats.js'
import { computeGuardStats } from './lib/guardStats.js'
import { computeValueStats } from './lib/valueStats.js'
import { computeInsightStats } from './lib/insightStats.js'
import { computeFocusStats } from './lib/focusStats.js'
import { setCurrentFocus, clearCurrentFocus, getCurrentFocus, addOpenLoop, listOpenLoops, resolveOpenLoop, touchEntity, listRecentEntities } from './lib/wsmStore.js'
import { listPendingCheckpoints } from './lib/pendingCheckpoints.js'
import { raiseCheckpointInboxItem, closeCheckpointInboxItem, startCheckpointInboxReconciler } from './lib/checkpointInbox.js'

// quox#896: the Approvals card mirroring a checkpoint closes when the checkpoint
// is decided here. A decision forwarded FROM that card (auth respond) carries
// x-quox-inbox-item: auth resolves the card itself, so only mark it closed.
function settleCheckpointInbox(db, cpId, req, action) {
  if (req.headers['x-quox-inbox-item']) {
    db.prepare("UPDATE checkpoints SET inbox_closed_at = datetime('now') WHERE id = ? AND inbox_closed_at IS NULL").run(cpId)
    return
  }
  closeCheckpointInboxItem(db, cpId, { action, actorType: 'human', actorId: req.user_id })
    .then((r) => { if (!r.ok) console.warn(`[CheckpointInbox] close failed for ${cpId}: ${r.error || r.status} (reconciler retries)`) })
    .catch((e) => console.warn(`[CheckpointInbox] close error for ${cpId}: ${e.message} (reconciler retries)`))
}
import { isLoopCheckpointType, recordLoopCheckpointApproval, denyLoopCheckpoint, haltLoopObjective } from './lib/loopCheckpoints.js'
import { isPluginLicensed } from './lib/licenseGate.js'
import { recordTurnAndReadFocus, eraseUserWorkingSet } from './lib/turnFocus.js'
import { implantStatsResponse, implantStatsCollecting, implantStatsUnreachable, implantStatsLicenseRequired } from './lib/implantStats.js'
import { createTaskEnvelope, TASK_INTENTS } from './lib/envelopes.js'

// Version resolution: QUOXCORE_VERSION build arg → canonical /app/VERSION file
// → '0.0.0'. Prevents silently reporting the placeholder when the build arg is
// not passed. NOTE: this service's Docker build context is ./services/tasks
// (see docker-compose.yml), so the repo-root VERSION file is NOT COPY'd into the
// image — /app/VERSION will be absent unless the compose context is widened, and
// this resolver correctly falls back to the env var / '0.0.0'. Read once at load.
const RESOLVED_VERSION = (() => {
  if (process.env.QUOXCORE_VERSION) return process.env.QUOXCORE_VERSION
  try {
    const v = readFileSync('/app/VERSION', 'utf8').trim()
    if (v) return v
  } catch { /* file absent — fall through */ }
  return '0.0.0'
})()

const PORT = process.env.PORT || 3104
const JWT_SECRET = process.env.JWT_SECRET
const DB_PATH = process.env.DB_PATH || './data/tasks.db'

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required')
  process.exit(1)
}

// TRUST-GATE-OPS: refuse to boot with test-only env flags in production
// (same guard as collector — see lib/bootGuard.js)
const { guardTestEnvFlags } = await import('./lib/bootGuard.js')
const _bootGuardResult = guardTestEnvFlags(process.env)
if (_bootGuardResult.shouldAbort) {
  console.error(`[boot] Refusing to start with test-only env flags set: ${_bootGuardResult.presentFlags.join(',')}. Set ALLOW_TEST_FLAGS=true to bypass (test contexts only).`)
  process.exit(1)
} else if (_bootGuardResult.presentFlags.length > 0) {
  console.warn(`[boot] WARNING: test-only env flags active under ALLOW_TEST_FLAGS=true: ${_bootGuardResult.presentFlags.join(',')}`)
}

const app = express()

// Middleware
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '2mb' }))
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true)
    const allowed = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()) || ['http://localhost:3000']
    if (allowed.includes(origin)) return callback(null, true)
    try {
      const url = new URL(origin)
      const isLAN = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|localhost|127\.0\.0\.1)$/.test(url.hostname)
      const dashPorts = ['3000', '3443', '443', '80']
      const portMatch = dashPorts.includes(url.port) || (url.port === '' && dashPorts.includes(url.protocol === 'https:' ? '443' : '80'))
      if (isLAN && portMatch) return callback(null, true)
    } catch {}
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true
}))

// ==========================================
// Step 2: In-memory rate limiter (no dependency)
// ==========================================
const rateBuckets = new Map()

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = `${req.org_id || req.ip}:${req.route?.path || req.path}`
    const now = Date.now()

    if (!rateBuckets.has(key)) {
      rateBuckets.set(key, [])
    }

    const bucket = rateBuckets.get(key).filter(ts => now - ts < windowMs)
    rateBuckets.set(key, bucket)

    if (bucket.length >= maxRequests) {
      const retryAfter = Math.ceil((bucket[0] + windowMs - now) / 1000)
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ error: 'Too many requests', retry_after: retryAfter })
    }

    bucket.push(now)
    next()
  }
}

// Clean up stale rate buckets every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    const active = bucket.filter(ts => now - ts < 120000)
    if (active.length === 0) rateBuckets.delete(key)
    else rateBuckets.set(key, active)
  }
}, 300000)

const writeRateLimit = rateLimit(30, 60000)   // 30 req/min for writes
const readRateLimit = rateLimit(120, 60000)    // 120 req/min for reads

// ==========================================
// Step 4: Input validation helpers
// ==========================================
function validateObjectiveInput(body) {
  const errors = {}
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) errors.title = 'Title is required'
    else if (body.title.length > 200) errors.title = 'Title must be 200 characters or fewer'
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') errors.description = 'Description must be a string'
    else if (body.description.length > 5000) errors.description = 'Description must be 5000 characters or fewer'
  }
  if (body.max_tokens !== undefined) {
    const v = Number(body.max_tokens)
    if (isNaN(v) || v < 0 || v > 10000000) errors.max_tokens = 'max_tokens must be 0-10000000'
  }
  if (body.max_tool_calls !== undefined) {
    const v = Number(body.max_tool_calls)
    if (isNaN(v) || v < 0 || v > 1000) errors.max_tool_calls = 'max_tool_calls must be 0-1000'
  }
  if (body.max_duration_ms !== undefined) {
    const v = Number(body.max_duration_ms)
    if (isNaN(v) || v < 0 || v > 7200000) errors.max_duration_ms = 'max_duration_ms must be 0-7200000'
  }
  // MACH-FOLLOWUP WI-D: owner-authored per-objective system_prompt (rides
  // to every decomposed task verbatim — see decomposer.js insertTask)
  if (body.system_prompt !== undefined && body.system_prompt !== null) {
    if (typeof body.system_prompt !== 'string') errors.system_prompt = 'system_prompt must be a string'
    else if (body.system_prompt.length > 8000) errors.system_prompt = 'system_prompt must be 8000 characters or fewer'
  }
  // DEVSUITE-DEVMODE 5c: loop-mode creation surface. Explicit user choice,
  // default 'dag' — no auto-classifier by design (a silent classifier removes
  // the reviewable-plan value without consent).
  if (body.execution_mode !== undefined) {
    if (body.execution_mode !== 'dag' && body.execution_mode !== 'loop') {
      errors.execution_mode = "execution_mode must be 'dag' or 'loop'"
    }
  }
  if (body.loop_backend !== undefined) {
    if (!isRecognisedLoopBackend(body.loop_backend)) {
      errors.loop_backend = `loop_backend must be ${availableBackendsPhrase()}`
    }
  }
  if (body.capability_scope !== undefined && body.capability_scope !== null) {
    const scope = body.capability_scope
    if (!Array.isArray(scope) || scope.length > 200 || scope.some(t => typeof t !== 'string' || !t.trim() || t.length > 100)) {
      errors.capability_scope = 'capability_scope must be an array of up to 200 non-empty tool-name strings'
    }
  }
  // QLOOP-ENGINE P1: a malformed exit_predicate must be refused loudly, not
  // silently ignored (an ignored predicate = a loop that never exits on truth).
  if (body.metadata && typeof body.metadata === 'object' && body.metadata.exit_predicate !== undefined) {
    const v = validateExitPredicate(body.metadata.exit_predicate)
    if (!v.ok) errors.exit_predicate = v.error
  }
  return Object.keys(errors).length > 0 ? errors : null
}

// Request logging (except health)
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    if (req.path !== '/health') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
    }
  })
  next()
})

// ==========================================
// Health check (no auth)
// ==========================================
app.get('/health', (req, res) => {
  // Prove the DEPENDENCY, not just that this process can answer. See the
  // matching comment in services/memory/server.js: a hardcoded 'ok' tells a
  // caller nothing about whether the service can do its job, and the
  // collector demonstrated the cost of that on 2026-08-19.
  let db = true
  let dbError = null
  try {
    getDatabase().prepare('SELECT 1').get()
  } catch (err) {
    db = false
    dbError = err.message
  }
  res.json({
    status: db ? 'ok' : 'degraded',
    db,
    ...(dbError ? { db_error: dbError } : {}),
    service: 'quox-tasks',
    version: RESOLVED_VERSION,
    engine: 'quoxflow',
    timestamp: new Date().toISOString()
  })
})

// QuoxMind engine health — simplified (QuoxFlow manages execution)
app.get('/api/engine/health', (req, res) => {
  res.json({
    service: 'quox-tasks',
    engine: 'quoxflow',
    quoxflow_url: process.env.QUOXFLOW_URL || 'http://quoxflow:3200',
    timestamp: new Date().toISOString()
  })
})

// QMD-C: Temporal query endpoint — execution timing analytics.
// Cross-tenant fix (TRUST-PROOF sweep 2026-09-24): was unauthenticated and
// queried tasks with NO org filter, leaking every org's task titles/agent
// ids/timings. Now behind authenticate (sets req.org_id, like the sibling
// /temporal/stats) and every query — including the correlated subqueries used
// for anomaly averages — is scoped to req.org_id.
app.get('/api/engine/temporal', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const days = parseInt(req.query.days) || 7
    const orgId = req.org_id

    // P50/P95/P99 per agent over last N days
    const agentTimings = db.prepare(`
      SELECT agent_id,
        COUNT(*) as task_count,
        ROUND(AVG(duration_ms)) as avg_ms,
        ROUND(MIN(duration_ms)) as min_ms,
        ROUND(MAX(duration_ms)) as max_ms
      FROM tasks
      WHERE org_id = ?
        AND status IN ('completed', 'failed')
        AND duration_ms > 0
        AND completed_at > datetime('now', '-' || ? || ' days')
      GROUP BY agent_id
      ORDER BY task_count DESC
    `).all(orgId, days)

    // Hourly activity histogram (tasks started per hour of day)
    const hourly = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as count
      FROM tasks
      WHERE org_id = ?
        AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY hour
      ORDER BY hour
    `).all(orgId, days)

    // Build full 24-hour histogram (fill gaps with 0)
    const histogram = new Array(24).fill(0)
    for (const row of hourly) {
      histogram[row.hour] = row.count
    }
    const peakHour = histogram.indexOf(Math.max(...histogram))

    // Anomalies: tasks that took >2x the agent's average
    const anomalies = db.prepare(`
      SELECT t.id, t.title, t.agent_id, t.duration_ms, t.completed_at,
        (SELECT ROUND(AVG(t2.duration_ms)) FROM tasks t2
          WHERE t2.org_id = ? AND t2.agent_id = t.agent_id AND t2.status = 'completed' AND t2.duration_ms > 0
        ) as agent_avg_ms
      FROM tasks t
      WHERE t.org_id = ?
        AND t.status IN ('completed', 'failed')
        AND t.duration_ms > 0
        AND t.completed_at > datetime('now', '-' || ? || ' days')
        AND t.duration_ms > (
          SELECT AVG(t3.duration_ms) * 2 FROM tasks t3
          WHERE t3.org_id = ? AND t3.agent_id = t.agent_id AND t3.status = 'completed' AND t3.duration_ms > 0
        )
      ORDER BY t.duration_ms DESC
      LIMIT 10
    `).all(orgId, orgId, days, orgId)

    res.json({
      period_days: days,
      agents: agentTimings,
      hourly_histogram: histogram,
      peak_hour: peakHour,
      anomalies: anomalies.map(a => ({
        task_id: a.id,
        title: a.title,
        agent: a.agent_id,
        duration_ms: a.duration_ms,
        agent_avg_ms: a.agent_avg_ms,
        multiplier: a.agent_avg_ms > 0 ? Math.round(a.duration_ms / a.agent_avg_ms * 10) / 10 : null,
        completed_at: a.completed_at,
      })),
      anomaly_count: anomalies.length,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// QMH-2 QuoxTemporal: convention-shaped stats endpoint backed by computeTemporalStats.
// Read from durable tasks.duration_ms; no in-memory buffer.
app.get('/api/engine/temporal/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeTemporalStats(db, {
      orgId: req.org_id,
      sinceIso: req.query.since,
      agentId: req.query.agent,
    })
    if (stats.taskCount === 0) {
      return res.json(implantStatsCollecting('quox-temporal', 'Collecting — no completed tasks in window'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-temporal',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.p95_ms,
        unit: 'ms',
        label: `P95 ${stats.p95_ms}ms`,
      },
      fields: {
        taskCount: stats.taskCount,
        p50_ms: stats.p50_ms,
        p95_ms: stats.p95_ms,
        p99_ms: stats.p99_ms,
        anomalies_24h: stats.anomalies_24h,
        hourly_histogram: stats.hourly_histogram,
        windowSinceIso: stats.windowSinceIso,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-temporal', 'tasks-db', err))
  }
})

// QMD-E: Dream consolidation stats + manual trigger.
// Cross-tenant fix (TRUST-PROOF sweep 2026-09-24): was unauthenticated and
// called getDreamStats() with no org, returning cross-org consolidation stats.
// Now behind authenticate and scoped to req.org_id, matching /dream/stats.
app.get('/api/engine/dream', authenticate, (req, res) => {
  res.json(getDreamStats(req.org_id))
})

// QMH-2 QuoxDream: convention-shaped stats backed by dream_cycles table.
app.get('/api/engine/dream/stats', authenticate, (req, res) => {
  try {
    const stats = getDreamStats(req.org_id)
    if (!stats || stats.cycleCount === 0) {
      return res.json(implantStatsCollecting('quox-dream', 'Collecting — no consolidation cycles yet'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-dream',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.cycleCount,
        unit: 'cycles',
        label: `${stats.cycleCount} cycles, ${stats.themesExtracted} themes`,
      },
      fields: {
        cycleCount: stats.cycleCount,
        lastCycleAt: stats.lastCycleAt,
        themesExtracted: stats.themesExtracted,
        cycles24h: stats.cycles24h,
        journalsProcessed24h: stats.journalsProcessed24h,
        wisdomCreated24h: stats.wisdomCreated24h,
        skippedRatio: stats.skippedRatio,
        intervalHours: stats.intervalHours,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-dream', 'tasks-db', err))
  }
})

// QMH-2 QuoxPredict: convention-shaped stats backed by execution_wisdom.
// Replaces the topology card mapping to getCodebaseFabricStats() — codebase
// invariants have nothing to do with prediction. Real predictions live in the
// wisdom store populated by analyser/wisdomStore.
app.get('/api/engine/predict/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computePredictStats(db, { orgId: req.org_id })
    if (stats.wisdomCount === 0) {
      return res.json(implantStatsCollecting('quox-predict', 'Collecting — no wisdom patterns extracted yet'))
    }
    const avg = stats.avgConfidence !== null ? stats.avgConfidence.toFixed(2) : '—'
    return res.json(implantStatsResponse({
      implant: 'quox-predict',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.wisdomCount,
        unit: 'patterns',
        label: `${stats.wisdomCount} patterns, avg confidence ${avg}`,
      },
      fields: {
        wisdomCount: stats.wisdomCount,
        avgConfidence: stats.avgConfidence,
        coreCount: stats.coreCount,
        establishedCount: stats.establishedCount,
        tentativeCount: stats.tentativeCount,
        recentWisdom24h: stats.recentWisdom24h,
        lastWisdomAt: stats.lastWisdomAt,
        // #1112: event logs counted apart; consumption and retirement visible.
        eventLogCount: stats.eventLogCount,
        injectedWisdomCount: stats.injectedWisdomCount,
        lastInjectedAt: stats.lastInjectedAt,
        retirement: mindRetirement.status(),
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-predict', 'tasks-db', err))
  }
})

// QMH-2 QuoxReflect: convention-shaped stats backed by objective_outcomes.
// Replaces the topology card mapping to getGovernanceStats() — policy
// registry counts have nothing to do with reflection on completed work.
// Real reflection signal comes from analyser-written outcomes.
app.get('/api/engine/reflect/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeReflectStats(db, { orgId: req.org_id })
    if (stats.outcomeCount === 0) {
      return res.json(implantStatsCollecting('quox-reflect', 'Collecting — no objective outcomes recorded yet'))
    }
    const q = stats.avgQuality !== null ? stats.avgQuality.toFixed(2) : '—'
    return res.json(implantStatsResponse({
      implant: 'quox-reflect',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.outcomeCount,
        unit: 'outcomes',
        label: `${stats.outcomeCount} outcomes, avg quality ${q}`,
      },
      fields: {
        outcomeCount: stats.outcomeCount,
        avgQuality: stats.avgQuality,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        postMortemCount: stats.postMortemCount,
        wisdomLinkedCount: stats.wisdomLinkedCount,
        outcomes24h: stats.outcomes24h,
        lastOutcomeAt: stats.lastOutcomeAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-reflect', 'tasks-db', err))
  }
})

// QUOXMIND-PROOF: per-implant firing evidence (last fired + 7-day count) for
// `quox mind` and the TUI's /mind. Org-scoped; a failing source reports its
// error per implant rather than failing the whole read.
app.get('/api/engine/activity', authenticate, (req, res) => {
  try {
    res.json({ orgId: req.org_id, window_days: 7, implants: computeImplantActivity(getDatabase(), { orgId: req.org_id }), generatedAt: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// QMH-2 QuoxLearn: convention-shaped stats backed by agent_performance.
// Replaces the topology card mapping to getDataFabricStats() — file/folder
// counts have nothing to do with learning. Real learning signal is the
// per-agent performance log written by AT-3 agentScorer.
app.get('/api/engine/learn/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeLearnStats(db, { orgId: req.org_id })
    if (stats.observationCount === 0) {
      return res.json(implantStatsCollecting('quox-learn', 'Collecting — no agent performance recorded yet'))
    }
    const q = stats.avgQuality !== null ? Math.round(stats.avgQuality) : '—'
    return res.json(implantStatsResponse({
      implant: 'quox-learn',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.observationCount,
        unit: 'observations',
        label: `${stats.observationCount} observations across ${stats.agentsTracked} agents (avg quality ${q})`,
      },
      fields: {
        observationCount: stats.observationCount,
        agentsTracked: stats.agentsTracked,
        avgQuality: stats.avgQuality,
        avgLatencyMs: stats.avgLatencyMs,
        successRate: stats.successRate,
        observations24h: stats.observations24h,
        lastObservationAt: stats.lastObservationAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-learn', 'tasks-db', err))
  }
})

// QMH-2 QuoxExecutive: convention-shaped stats backed by objectives + tasks.
// Replaces the topology card mapping to getAgentMeshStats() — that read the
// static assistants registry (config counts, not operations). Real executive
// signal is what the orchestrator is actually doing: objectives in flight,
// delegations spread across agents, success rate.
app.get('/api/engine/executive/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeExecutiveStats(db, { orgId: req.org_id })
    if (stats.objectivesTotal === 0 && stats.tasksTotal === 0) {
      return res.json(implantStatsCollecting('quox-executive', 'Collecting — no objectives or tasks yet'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-executive',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.objectivesInFlight,
        unit: 'in flight',
        label: `${stats.objectivesInFlight} in flight, ${stats.tasksTotal} tasks across ${stats.agentsAssigned} agents`,
      },
      fields: {
        objectivesTotal: stats.objectivesTotal,
        objectivesInFlight: stats.objectivesInFlight,
        objectivesCompleted24h: stats.objectivesCompleted24h,
        objectivesFailed: stats.objectivesFailed,
        tasksTotal: stats.tasksTotal,
        tasksInFlight: stats.tasksInFlight,
        agentsAssigned: stats.agentsAssigned,
        avgTasksPerObjective: stats.avgTasksPerObjective,
        lastObjectiveAt: stats.lastObjectiveAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-executive', 'tasks-db', err))
  }
})

// QMH-2 QuoxSense: convention-shaped stats backed by implant_signals table.
// Replaces the in-memory browser buffer that vanished on every page reload.
// Other implants persist signals via persistImplantSignal(); senseStats
// aggregates them across the org.
app.get('/api/engine/sense/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeSenseStats(db, { orgId: req.org_id })
    if (stats.signalCount === 0) {
      return res.json(implantStatsCollecting('quox-sense', 'Collecting — no implant signals recorded yet'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-sense',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.signalCount,
        unit: 'signals',
        label: `${stats.signalCount} signals from ${stats.uniqueImplants} implants`,
      },
      fields: {
        signalCount: stats.signalCount,
        signals24h: stats.signals24h,
        signalRatePerMin: stats.signalRatePerMin,
        uniqueImplants: stats.uniqueImplants,
        breakdown: stats.breakdown,
        lastSignalAt: stats.lastSignalAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-sense', 'tasks-db', err))
  }
})

// QMH-2 QuoxGuard: convention-shaped stats backed by autonomy_decisions.
// Replaces the topology card mapping to getReliabilityStats() (page-load
// uptime ratio), which has nothing to do with policy enforcement. Real Guard
// signal is the allow/deny/escalate trail from Stream QM autonomyDecision.
app.get('/api/engine/guard/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeGuardStats(db, { orgId: req.org_id })
    if (stats.decisionCount === 0) {
      return res.json(implantStatsCollecting('quox-guard', 'Collecting — no autonomy decisions recorded yet'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-guard',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.decisionCount,
        unit: 'decisions',
        label: `${stats.decisionCount} decisions (${stats.allowCount} allow, ${stats.denyCount} deny, ${stats.escalateCount} escalate)`,
      },
      fields: {
        decisionCount: stats.decisionCount,
        allowCount: stats.allowCount,
        denyCount: stats.denyCount,
        escalateCount: stats.escalateCount,
        agentsCovered: stats.agentsCovered,
        decisions24h: stats.decisions24h,
        lastDecisionAt: stats.lastDecisionAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-guard', 'tasks-db', err))
  }
})

// QMH-2 QuoxValue: convention-shaped stats backed by agent_performance,
// but interpreted as quality-per-cost. Replaces the topology card mapping
// to getToolingCortexStats() (entity counts) — unrelated to capability value.
app.get('/api/engine/value/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeValueStats(db, { orgId: req.org_id })
    if (stats.observationCount === 0) {
      return res.json(implantStatsCollecting('quox-value', 'Collecting — no agent performance recorded yet'))
    }
    const qpk = stats.qualityPerKToken !== null ? stats.qualityPerKToken.toFixed(1) : '—'
    return res.json(implantStatsResponse({
      implant: 'quox-value',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.qualityPerKToken,
        unit: 'quality/1k-tokens',
        label: `${qpk} quality per 1k tokens (${stats.observationCount} observations)`,
      },
      fields: {
        observationCount: stats.observationCount,
        totalTokens: stats.totalTokens,
        avgQuality: stats.avgQuality,
        qualityPerKToken: stats.qualityPerKToken,
        byDomain: stats.byDomain,
        lastObservationAt: stats.lastObservationAt,
        pendingPriority: stats.pendingPriority,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-value', 'tasks-db', err))
  }
})

// QMH-2 QuoxInsight: convention-shaped stats backed by implant_signals
// correlation. Replaces the topology card mapping to getIntegrationSpineStats()
// (workflow + uptime monitor counts) — unrelated to cross-implant correlation.
app.get('/api/engine/insight/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const stats = computeInsightStats(db, { orgId: req.org_id })
    if (stats.signalCount === 0) {
      return res.json(implantStatsCollecting('quox-insight', 'Collecting — no implant signals to correlate yet'))
    }
    return res.json(implantStatsResponse({
      implant: 'quox-insight',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.clustersDetected,
        unit: 'clusters',
        label: stats.clustersDetected > 0
          ? `${stats.clustersDetected} clusters detected (${stats.signalsRecentWindow} recent signals)`
          : `${stats.signalsRecentWindow} recent signals, no clusters`,
      },
      fields: {
        signalCount: stats.signalCount,
        signalsRecentWindow: stats.signalsRecentWindow,
        clustersDetected: stats.clustersDetected,
        lastClusterAt: stats.lastClusterAt,
        lastSignalAt: stats.lastSignalAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-insight', 'tasks-db', err))
  }
})

// QMH-3 QuoxFocus: convention-shaped stats backed by server-side WSM.
// Replaces the hardcoded 20+openLoops*10+entities*5 formula in
// cognitiveTopologyService.js. Honest "Premium feature" sentinel when the
// org's plan does not include WSM (quoxmind-pro / quoxmind-complete).
app.get('/api/engine/focus/stats', authenticate, async (req, res) => {
  try {
    // License gate: WSM is part of QuoxMind Pro and above.
    const licensed = await isPluginLicensed(req.org_id, 'quoxmind-pro')
    if (!licensed) {
      return res.json(implantStatsLicenseRequired('quox-focus', 'quoxmind-pro'))
    }

    const db = getDatabase()
    const stats = computeFocusStats(db, { orgId: req.org_id, userId: req.user_id })

    if (stats.healthScore === null) {
      return res.json(implantStatsCollecting('quox-focus', 'Collecting — no working-set state yet'))
    }

    return res.json(implantStatsResponse({
      implant: 'quox-focus',
      healthScore: stats.healthScore,
      primaryMetric: {
        value: stats.openLoops,
        unit: 'open loops',
        label: stats.hasFocus
          ? `${stats.openLoops} loops, ${stats.recentEntities} entities (focus: ${stats.currentTask || stats.currentProject})`
          : `${stats.openLoops} loops, ${stats.recentEntities} entities`,
      },
      fields: {
        hasFocus: stats.hasFocus,
        currentTask: stats.currentTask,
        currentProject: stats.currentProject,
        focusStartedAt: stats.focusStartedAt,
        openLoops: stats.openLoops,
        recentEntities: stats.recentEntities,
        lastEntityAt: stats.lastEntityAt,
      },
    }))
  } catch (err) {
    return res.status(500).json(implantStatsUnreachable('quox-focus', 'tasks-db', err))
  }
})

// QMH-3: WSM write/read endpoints for clients (browser, agents) to push state.
app.get('/api/engine/focus/state', authenticate, async (req, res) => {
  try {
    const licensed = await isPluginLicensed(req.org_id, 'quoxmind-pro')
    if (!licensed) {
      return res.status(402).json({ error: 'LICENSE_REQUIRED', requiredPlugin: 'quoxmind-pro' })
    }
    const db = getDatabase()
    res.json({
      focus: getCurrentFocus(db, { orgId: req.org_id, userId: req.user_id }),
      openLoops: listOpenLoops(db, { orgId: req.org_id, userId: req.user_id }),
      recentEntities: listRecentEntities(db, { orgId: req.org_id, userId: req.user_id }),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/engine/focus/state', authenticate, async (req, res) => {
  try {
    const licensed = await isPluginLicensed(req.org_id, 'quoxmind-pro')
    if (!licensed) {
      return res.status(402).json({ error: 'LICENSE_REQUIRED', requiredPlugin: 'quoxmind-pro' })
    }
    const db = getDatabase()
    const { focus, addLoop, resolveLoop, touchEntity: touchEnt } = req.body || {}

    if (focus !== undefined) {
      if (focus === null) {
        clearCurrentFocus(db, { orgId: req.org_id, userId: req.user_id })
      } else {
        setCurrentFocus(db, {
          orgId: req.org_id, userId: req.user_id,
          task: focus.task, project: focus.project, goal: focus.goal,
          context: focus.context, startedAt: focus.startedAt,
        })
      }
    }
    if (addLoop) {
      addOpenLoop(db, { orgId: req.org_id, userId: req.user_id, ...addLoop })
    }
    if (resolveLoop) {
      resolveOpenLoop(db, { id: resolveLoop.id, outcome: resolveLoop.outcome })
    }
    if (touchEnt) {
      touchEntity(db, { orgId: req.org_id, userId: req.user_id, ...touchEnt })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// QUOXMIND #1110: one call per HUMAN chat turn from the collector. Records the
// ask (QuoxFocus fires), lets QuoxSense perceive trouble once, and returns the
// compact working set (focus + executive + temporal + notable now) the
// collector injects as [CURRENT FOCUS]. Service-key only; org and user come
// from the collector's authenticated turn, never from an end user. Open loops
// are a QuoxMind Pro feature: the licence check is cached and bounded to
// 150 ms, and a slow or failed check omits loops rather than delaying the turn.
app.post('/api/internal/focus/turn', async (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }
  const { org_id: orgId, user_id: userId, prompt, concerns } = req.body || {}
  if (typeof orgId !== 'string' || !orgId || typeof userId !== 'string' || !userId) {
    return res.status(400).json({ error: 'org_id and user_id are required' })
  }
  try {
    let includeOpenLoops = false
    try {
      includeOpenLoops = await Promise.race([
        isPluginLicensed(orgId, 'quoxmind-pro'),
        new Promise((resolve) => setTimeout(() => resolve(false), 150)),
      ])
    } catch { includeOpenLoops = false }
    const out = recordTurnAndReadFocus(getDatabase(), {
      orgId, userId,
      prompt: typeof prompt === 'string' ? prompt : '',
      includeOpenLoops: includeOpenLoops === true,
      concerns: Array.isArray(concerns) ? concerns : [],
    })
    res.json(out)
  } catch (err) {
    console.error(`[Tasks] focus/turn failed for org=${orgId}: ${err.message}`)
    res.status(500).json({ error: 'focus_turn_failed' })
  }
})

// GDPR erasure leg (collector gdprErasureCascade): deletes the user's stored
// focus asks, focus and open loops in every org. Service-key only.
app.post('/internal/erase-user', (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }
  const userId = req.body && req.body.userId
  if (typeof userId !== 'string' || !userId) return res.status(400).json({ error: 'userId is required' })
  try {
    const { n } = eraseUserWorkingSet(getDatabase(), { userId })
    res.json({ erased: true, n })
  } catch (err) {
    console.error(`[Tasks] erase-user failed: ${err.message}`)
    res.status(500).json({ error: 'erase_failed' })
  }
})

// ==========================================
// P6.B: User UI preferences (server-side)
// Replaces localStorage for template var history and PRISM collapse state.
// GET  /api/prefs/:key   — returns { value } (null if not set)
// PUT  /api/prefs/:key   — body: { value } (any JSON-serialisable value)
// ==========================================

app.get('/api/prefs/:key', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT pref_value FROM user_ui_prefs WHERE user_id = ? AND org_id = ? AND pref_key = ?'
    ).get(req.user_id, req.org_id, req.params.key)
    res.json({ value: row ? JSON.parse(row.pref_value) : null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/prefs/:key', authenticate, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const serialised = JSON.stringify(req.body?.value ?? null)
    db.prepare(`
      INSERT INTO user_ui_prefs (user_id, org_id, pref_key, pref_value, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, org_id, pref_key) DO UPDATE
        SET pref_value = excluded.pref_value, updated_at = excluded.updated_at
    `).run(req.user_id, req.org_id, req.params.key, serialised)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// QMH-3 part 2: HITL inbox — pending checkpoints sorted by parent task
// priority (severity). Surfaces priorityScorer output so the user reviews
// the most important blocked work first. Inbox UI calls this to render
// the approval queue.
app.get('/api/checkpoints/pending', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const includeReviewed = req.query.include_reviewed === 'true'
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500)
    const list = listPendingCheckpoints(db, { orgId: req.org_id, includeReviewed, limit })
    res.json({ checkpoints: list, count: list.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/engine/dream/run', authenticate, async (req, res) => {
  try {
    const result = await runDreamCycle()
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ==========================================
// Objectives CRUD
// ==========================================

/**
 * Parse an objective DB row: JSON-decode fields that are stored as TEXT.
 * P10.I-2: metadata is stored as JSON string; clients receive parsed object.
 */
function parseObjectiveRow(row) {
  if (!row) return row
  let capabilityScope = null
  try {
    capabilityScope = row.capability_scope != null ? JSON.parse(row.capability_scope) : null
  } catch {
    // Malformed scope stays as-stored; the autonomy gate fails closed on it.
    capabilityScope = row.capability_scope
  }
  return {
    ...row,
    metadata: row.metadata != null ? JSON.parse(row.metadata) : null,
    capability_scope: capabilityScope,
  }
}

// Create objective
app.post('/api/objectives', authenticate, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const { title, description, max_tokens, max_tool_calls, max_duration_ms,
            require_approval_before_start, checkpoint_after_each_task, team_id, corr_id: clientCorrId,
            // STUDY-REV R3: optional re-observe loop
            goal_condition, max_iterations,
            // P10.I-2: Crystal CTA metadata (candidate_for_crystal flag etc.)
            metadata,
            // MACH-FOLLOWUP WI-D: owner-authored per-task persona/voice channel
            system_prompt,
            // DEVSUITE-DEVMODE 5c: quoxified-loop creation surface
            execution_mode, capability_scope, loop_backend } = req.body

    // Step 4: Input validation
    const valErrors = validateObjectiveInput(req.body)
    if (valErrors) return res.status(400).json({ error: 'Validation failed', fields: valErrors })
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' })

    const id = ulid()
    const corrId = clientCorrId || `OBJ_${id}`

    // Stream E: If team_id is specified, resolve team and create instance
    let teamInstanceId = null
    let orchestratorAgentId = null
    let effectiveMaxTokens = max_tokens || 200000
    let effectiveMaxToolCalls = max_tool_calls || 100
    let effectiveMaxDuration = max_duration_ms || 1800000  // 30min default — CLI path needs headroom
    let effectiveApproval = require_approval_before_start ? 1 : 0
    let effectiveCheckpoint = checkpoint_after_each_task ? 1 : 0

    if (team_id) {
      const teamDef = getTeamDefinition(req.org_id, team_id)
      if (!teamDef) return res.status(404).json({ error: `Team '${team_id}' not found` })

      const manifest = teamDef.manifest
      orchestratorAgentId = manifest.orchestrator?.agentId || 'quox'

      // Apply team policies as defaults (explicit params override)
      const policies = manifest.policies || {}
      if (!max_tokens && policies.maxBudgetTokens) effectiveMaxTokens = policies.maxBudgetTokens
      if (!max_tool_calls && policies.maxBudgetToolCalls) effectiveMaxToolCalls = policies.maxBudgetToolCalls
      if (!max_duration_ms && policies.maxDurationMs) effectiveMaxDuration = policies.maxDurationMs
      if (require_approval_before_start === undefined && policies.requireApprovalBeforeStart !== undefined) {
        effectiveApproval = policies.requireApprovalBeforeStart ? 1 : 0
      }
      if (checkpoint_after_each_task === undefined && policies.checkpointAfterEachTask !== undefined) {
        effectiveCheckpoint = policies.checkpointAfterEachTask ? 1 : 0
      }

      // Create team instance
      teamInstanceId = createTeamInstance(team_id, req.org_id, req.user_id)
      console.log(`[Objectives] Team objective: team=${team_id}, instance=${teamInstanceId}, orchestrator=${orchestratorAgentId}`)
    }

    // STUDY-REV R3: validate + sanitise loop fields. Empty/missing
    // goal_condition disables the loop entirely.
    const trimmedGoal = typeof goal_condition === 'string' ? goal_condition.trim() : ''
    const effectiveGoal = trimmedGoal.length > 0 ? trimmedGoal.slice(0, 2000) : null
    // Clamp INTO range, never silently discard: an out-of-range request
    // (e.g. --max-iterations 40) used to fall through to the default 5 —
    // asking for MORE budget yielded the minimum, and the loop was then
    // SIGKILLed mid-work (2026-08-16, evidence-run take 2: 40 requested,
    // 5 stored, session dead in 48s).
    let effectiveMaxIter = 5
    if (max_iterations !== undefined) {
      const v = Number(max_iterations)
      if (!isNaN(v) && v >= 1) effectiveMaxIter = Math.min(20, Math.floor(v))
    }

    const metadataJson = metadata != null ? JSON.stringify(metadata) : null

    // DEVSUITE-DEVMODE 5c: loop mode. Pre-start approval is ALWAYS required
    // for a loop objective (what gets approved: goal text, budget ceiling,
    // capability_scope) — the loop has no reviewable plan, so the gate is the
    // review. The scope is stored as-given; the autonomy gate treats it as a
    // deny-by-default allowlist (empty array = every tool escalates) and
    // fails closed on malformed JSON.
    const effectiveMode = execution_mode === 'loop' ? 'loop' : 'dag'
    if (effectiveMode === 'loop') effectiveApproval = 1
    const effectiveLoopBackend = normalizeLoopBackend(loop_backend)
    const capabilityScopeJson = Array.isArray(capability_scope)
      ? JSON.stringify(capability_scope.map(t => t.trim()))
      : null

    // MACH-FOLLOWUP WI-D: trim + cap (validated already, but defend against
    // untrimmed whitespace-only input the same way goal_condition does above)
    const trimmedSystemPrompt = typeof system_prompt === 'string' ? system_prompt.trim() : ''
    const effectiveSystemPrompt = trimmedSystemPrompt.length > 0 ? trimmedSystemPrompt.slice(0, 8000) : null

    db.prepare(`
      INSERT INTO objectives (id, org_id, user_id, title, description, max_tokens, max_tool_calls, max_duration_ms, require_approval_before_start, checkpoint_after_each_task, corr_id, team_id, team_instance_id, orchestrator_agent_id, goal_condition, max_iterations, iteration_count, goal_evaluation_log, metadata, system_prompt, execution_mode, capability_scope, loop_backend, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id, req.org_id, req.user_id,
      title.trim(),
      description || null,
      effectiveMaxTokens,
      effectiveMaxToolCalls,
      effectiveMaxDuration,
      effectiveApproval,
      effectiveCheckpoint,
      corrId,
      team_id || null,
      teamInstanceId,
      orchestratorAgentId,
      effectiveGoal,
      effectiveMaxIter,
      metadataJson,
      effectiveSystemPrompt,
      effectiveMode,
      capabilityScopeJson,
      effectiveLoopBackend
    )

    // Link instance to objective
    if (teamInstanceId) {
      updateTeamInstanceStatus(teamInstanceId, 'idle', id)
    }

    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id)
    res.status(201).json(parseObjectiveRow(objective))
  } catch (error) {
    console.error('[Objectives] Create error:', error)
    res.status(500).json({ error: error.message })
  }
})

// List objectives
app.get('/api/objectives', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const { status, team_id, limit = 50, offset = 0 } = req.query

    // F4 completion (2026-08-16): the LIST was the one route the org-scoping
    // sweep missed. user_id-filtering here made an agent-ops-created loop
    // objective INVISIBLE to the org's humans in mission-control/Objectives,
    // while its human-only approval gate sat waiting for exactly those
    // humans (owner hit this live: "i don't see it in objectives anyway").
    // Org-scoped like the detail/approve/checkpoints routes; pass ?mine=true
    // for the old own-objectives-only behavior.
    let sql = 'SELECT * FROM objectives WHERE org_id = ?'
    const params = [req.org_id]
    if (req.query.mine === 'true') {
      sql += ' AND user_id = ?'
      params.push(req.user_id)
    }

    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }
    if (team_id) {
      sql += ' AND team_id = ?'
      params.push(team_id)
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(parseInt(limit, 10), parseInt(offset, 10))

    const objectives = db.prepare(sql).all(...params).map(parseObjectiveRow)
    res.json({ objectives, count: objectives.length })
  } catch (error) {
    console.error('[Objectives] List error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get objective with tasks and active checkpoint
app.get('/api/objectives/:id', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' })
    }
    // F4 (QUOXPERTICUS drive): org-scoped read; an agent-owned patrol must be visible to the org's humans or its human gate is unsatisfiable.
    if (objective.org_id !== req.org_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const tasks = db.prepare('SELECT * FROM tasks WHERE objective_id = ? ORDER BY sequence_num ASC').all(req.params.id)
    const activeCheckpoint = db.prepare(`
      SELECT * FROM checkpoints WHERE objective_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
    `).get(req.params.id)

    // OE-6: Include DAG structure for frontend visualization
    const dag = computeDAG(tasks)
    res.json({
      ...parseObjectiveRow(objective),
      tasks,
      active_checkpoint: activeCheckpoint || null,
      failure_reason: getObjectiveFailureReason(db, req.params.id),
      dag
    })
  } catch (error) {
    console.error('[Objectives] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update objective (while pending only)
app.patch('/api/objectives/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' })
    }
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (objective.status !== 'pending') {
      return res.status(400).json({ error: 'Can only update pending objectives' })
    }

    // Step 4: Validate any fields being updated
    const valErrors = validateObjectiveInput(req.body)
    if (valErrors) return res.status(400).json({ error: 'Validation failed', fields: valErrors })

    const fields = ['title', 'description', 'max_tokens', 'max_tool_calls', 'max_duration_ms', 'require_approval_before_start', 'checkpoint_after_each_task', 'team_id']
    const updates = []
    const values = []

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`)
        const val = req.body[field]
        values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    values.push(req.params.id)
    db.prepare(`UPDATE objectives SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)
    res.json(updated)
  } catch (error) {
    console.error('[Objectives] Update error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Cancel/delete objective
app.delete('/api/objectives/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' })
    }
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    db.prepare(`
      UPDATE objectives SET status = 'cancelled', completed_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id)

    // Cancel any running tasks
    db.prepare(`
      UPDATE tasks SET status = 'cancelled', completed_at = datetime('now')
      WHERE objective_id = ? AND status IN ('pending', 'running')
    `).run(req.params.id)

    emitProgress(req.params.id, { type: 'objective_cancelled' })
    res.json({ status: 'cancelled' })
  } catch (error) {
    console.error('[Objectives] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ==========================================
// Objective lifecycle
// ==========================================

// Step 10+11: Start objective — decompose only (sets 'decomposed', not 'running')
// Phase 4.B: Supports require_approval_before_start + preview-plan flow
app.post('/api/objectives/:id/start', authenticate, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' })
    }
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    if (objective.status !== 'pending') {
      return res.status(400).json({ error: `Cannot start objective with status '${objective.status}'` })
    }

    // Step 7: If require_approval_before_start, create pre_start checkpoint (with dedup guard)
    // skip_checkpoint=true bypasses this for programmatic/scheduled objective creation.
    // P0b (DEC-3): the bypass is an approval sink too — skipping a human gate
    // IS resolving it. A service-key caller or agent-scoped JWT cannot skip;
    // its request is ignored and the checkpoint stands (the start itself is
    // not refused). The one exception is the leased disposable-test sandbox
    // (read server-side from auth, fail-safe locked). A real human JWT skips
    // as before. In-process schedulers use dispatchObjective() directly and
    // never pass through here.
    let skipCheckpoint = req.query.skip_checkpoint === 'true' || req.body.skip_checkpoint === true
    if (skipCheckpoint && (req.viaServiceKey || req.user?.agent_id)) {
      const { hasActiveSandboxApprovalGrant } = await import('./lib/disposableTestInstance.js')
      skipCheckpoint = await hasActiveSandboxApprovalGrant().catch(() => false)
    }
    if (objective.require_approval_before_start && !skipCheckpoint) {
      const existing = db.prepare(`
        SELECT id FROM checkpoints WHERE objective_id = ? AND checkpoint_type = 'before_start' AND status = 'pending' LIMIT 1
      `).get(objective.id)
      if (existing) {
        return res.json({ status: 'awaiting_approval', checkpoint_id: existing.id, message: 'Awaiting approval (checkpoint already exists)' })
      }
      const cpId = ulid()
      db.prepare(`
        INSERT INTO checkpoints (id, objective_id, checkpoint_type, status, title, description, created_at)
        VALUES (?, ?, 'before_start', 'pending', 'Pre-start approval', 'Approve to begin task decomposition', datetime('now'))
      `).run(cpId, objective.id)
      emitProgress(objective.id, { type: 'checkpoint_created', checkpoint_id: cpId, checkpoint_type: 'before_start' })
      // quox#896: the human waiting point lands in the Approvals inbox now (the reconciler backfills any raise that
      // fails here). Journey story-a 2026-10-17: AWAITED, bounded, so the caller gets the item id in this response and
      // the gate exists when the agent's turn reports it.
      let inboxItemId = null
      try {
        const raised = await Promise.race([
          (async () => await raiseCheckpointInboxItem(db, cpId))(),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'raise_timeout' }), 8000)),
        ])
        if (raised && raised.ok) inboxItemId = raised.itemId || null
        else console.warn(`[CheckpointInbox] raise failed for ${cpId}: ${(raised && (raised.error || raised.status)) || 'unknown'} (reconciler retries)`)
      } catch (e) { console.warn(`[CheckpointInbox] raise error for ${cpId}: ${e.message} (reconciler retries)`) }
      // AEE-CHECKPOINT-EVIDENCE (quox#480): the pre-start human gate is an
      // evidence-bearing act and has never emitted an envelope.
      createTaskEnvelope({
        type: 'event', from: 'service.tasks', to: 'human.user',
        intent: TASK_INTENTS.CHECKPOINT_CREATED,
        payload: {
          checkpoint_id: cpId,
          checkpoint_type: 'before_start',
          task_id: null,
          objective_title: objective.title,
          message: 'Approve to begin task decomposition',
        },
        corrId: objective.corr_id, objectiveId: objective.id,
      })
      return res.json({ status: 'awaiting_approval', checkpoint_id: cpId, inbox_item_id: inboxItemId, message: 'Pre-start approval required' })
    }

    // DEVSUITE-DEVMODE 5c: a loop objective has no plan to decompose — after
    // the gate above clears it dispatches straight into the loop branch
    // (pending -> running; dispatchObjective routes on execution_mode). Until
    // the fleet spawn seam lands the default spawner fails LOUD and the
    // objective shows failed, never a phantom running row.
    if (objective.execution_mode === 'loop') {
      res.json({ status: 'starting', message: 'Loop dispatch started' })
      try {
        await dispatchObjective(objective.id)
      } catch (err) {
        console.error('[Objectives] Loop dispatch failed:', err.message)
        db.prepare(`
          UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
          WHERE id = ?
        `).run(`Loop dispatch failed: ${err.message}`, objective.id)
        emitProgress(objective.id, { type: 'objective_failed', reason: err.message })
      }
      return
    }

    // Set status to decomposing BEFORE responding to prevent duplicate starts
    db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run('decomposing', objective.id)

    // Respond immediately — decomposition happens async
    res.json({ status: 'decomposing', message: 'Decomposition started' })

    // Step 10: Decompose only — decomposeObjective now sets 'decomposed' not 'running'
    try {
      await decomposeObjective(objective)
    } catch (err) {
      console.error('[Objectives] Decomposition failed:', err.message)
      db.prepare(`
        UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ?
        WHERE id = ?
      `).run(`Decomposition failed: ${err.message}`, objective.id)
      emitProgress(objective.id, { type: 'objective_failed', reason: err.message })
    }
  } catch (error) {
    console.error('[Objectives] Start error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: error.message })
    }
  }
})

// Step 11: Approve plan — transitions decomposed → running
app.post('/api/objectives/:id/approve-plan', authenticate, requireHumanApproverUnlessSandbox, requireStepUpApprove, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })
    if (objective.status !== 'decomposed') {
      return res.status(400).json({ error: `Can only approve plans for decomposed objectives (current: ${objective.status})` })
    }

    // Shared dispatch path — same helper used by agentScheduler (ACT
    // decisions) and teamScheduler (auto-approve), so there is one
    // execution-kickoff code path, not several divergent ones.
    const result = await dispatchObjective(objective.id)

    if (result.success) {
      res.json({
        status: 'running',
        message: 'Plan approved, executing via QuoxFlow',
        workflowId: result.workflowId,
        executionId: result.executionId,
      })
    } else if (result.code === 'AGENT_HALTED') {
      // quox#506: same typed refusal as every collector chokepoint. The
      // objective stays decomposed — release the E-STOP, approve again.
      res.status(423).json({ error: result.error, code: 'AGENT_HALTED', safetyGate: result.safetyGate })
    } else {
      res.status(500).json({ error: result.error })
    }
  } catch (error) {
    console.error('[Objectives] Approve plan error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Step 11: Reject plan — deletes tasks, resets to pending
app.post('/api/objectives/:id/reject-plan', authenticate, requireHumanApproverUnlessSandbox, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)

    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })
    if (objective.status !== 'decomposed') {
      return res.status(400).json({ error: `Can only reject plans for decomposed objectives (current: ${objective.status})` })
    }

    const { feedback } = req.body || {}

    // Delete all tasks for this objective
    db.prepare('DELETE FROM tasks WHERE objective_id = ?').run(objective.id)

    // Reset objective to pending; store feedback for re-decomposition if provided
    if (feedback) {
      db.prepare(`
        UPDATE objectives SET status = 'pending', task_count = 0, tasks_completed = 0, tasks_failed = 0, started_at = NULL, plan_feedback = ?
        WHERE id = ?
      `).run(feedback, objective.id)
    } else {
      db.prepare(`
        UPDATE objectives SET status = 'pending', task_count = 0, tasks_completed = 0, tasks_failed = 0, started_at = NULL
        WHERE id = ?
      `).run(objective.id)
    }

    emitProgress(objective.id, { type: 'plan_rejected', message: feedback ? 'Plan adjustment requested' : 'Plan rejected, objective reset to pending' })
    res.json({ status: 'pending', message: feedback ? 'Plan adjustment requested, ready for re-planning' : 'Plan rejected, ready for re-planning' })
  } catch (error) {
    console.error('[Objectives] Reject plan error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Save objective as reusable template
app.post('/api/objectives/:id/save-as-template', authenticate, writeRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })

    const { name, variables } = req.body || {}
    const template = saveObjectiveTemplate(objective, name || objective.title, variables)
    res.json({ success: true, template })
  } catch (error) {
    console.error('[Objectives] Save as template error:', error)
    res.status(500).json({ error: error.message })
  }
})

// List objective templates
app.get('/api/templates', authenticate, readRateLimit, (req, res) => {
  try {
    const templates = listObjectiveTemplates(req.org_id)
    res.json({ templates })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Get a template by ID
app.get('/api/templates/:id', authenticate, readRateLimit, (req, res) => {
  try {
    const template = getObjectiveTemplate(req.params.id)
    if (!template) return res.status(404).json({ error: 'Template not found' })
    res.json(template)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Instantiate a template as a new objective
app.post('/api/templates/:id/instantiate', authenticate, writeRateLimit, async (req, res) => {
  try {
    const { autoStart, variableValues } = req.body || {}
    const result = await instantiateTemplate(req.params.id, req.org_id, req.user_id, variableValues)
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// P6.B: Checkpoint approve/reject routes
// HITL checkpoints created by checkpoint_after_each_task can be resolved here.
// Transitions the checkpoint status and emits an SSE event so the UI refreshes.

app.post('/api/objectives/:id/checkpoints/:cpid/approve', authenticate, requireHumanApprover, requireStepUpApprove, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    // F4: HITL checkpoint decisions are ORG-level human acts; owner-scoping made an agent-owned patrol's gate unapprovable by any real operator.
    if (objective.org_id !== req.org_id) return res.status(404).json({ error: 'Objective not found', hint: 'This objective exists but is not in your active organization; switch to the org that owns it (quox org switch <orgId>) and retry.' })

    const checkpoint = db.prepare('SELECT checkpoint_type FROM checkpoints WHERE id = ? AND objective_id = ?').get(req.params.cpid, req.params.id)

    const notes = req.body?.notes || null
    const result = db.prepare(`
      UPDATE checkpoints
      SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ?
      WHERE id = ? AND objective_id = ?
    `).run(req.user_id, notes, req.params.cpid, req.params.id)

    if (result.changes === 0) return res.status(404).json({ error: 'Checkpoint not found' })

    emitProgress(req.params.id, {
      type: 'checkpoint_approved',
      checkpoint_id: req.params.cpid,
      reviewed_by: req.user_id,
    })
    settleCheckpointInbox(db, req.params.cpid, req, 'approve')

    // AEE-CHECKPOINT-EVIDENCE (quox#480): a human approval is the single most
    // evidence-bearing act on this service and had no envelope at all. `from`
    // is the human, matching the direction the old executor used for the
    // agent-authored ones.
    createTaskEnvelope({
      type: 'event', from: `human.${req.user_id}`, to: 'service.tasks',
      intent: TASK_INTENTS.CHECKPOINT_APPROVED,
      payload: {
        checkpoint_id: req.params.cpid,
        checkpoint_type: checkpoint?.checkpoint_type,
        objective_title: objective.title,
        reviewed_by: req.user_id,
        notes: notes ? String(notes).slice(0, 500) : undefined,
      },
      corrId: objective.corr_id, objectiveId: objective.id,
    })

    // TRUST-GATE (2026-07-05): approving a before_start checkpoint must ADVANCE
    // the objective, not just flip the checkpoint. Previously this was a dead
    // end — the objective sat in 'pending' forever (affected every
    // require_approval_before_start objective incl. L4 auto-created ones, which
    // failed safe but could never be approved-to-run). Kick off decomposition
    // the same way POST /start does after its checkpoint gate.
    if (checkpoint?.checkpoint_type === 'before_start' && objective.status === 'pending') {
      // DEVSUITE-DEVMODE 5c: loop objectives skip decomposition — the approved
      // gate IS the plan review (goal, budget, capability_scope), so approval
      // dispatches straight into the loop branch.
      if (objective.execution_mode === 'loop') {
        res.json({ status: 'approved', checkpoint_id: req.params.cpid, objective_status: 'starting' })
        try {
          await dispatchObjective(objective.id)
        } catch (err) {
          console.error('[Checkpoints] Post-approval loop dispatch failed:', err.message)
          db.prepare(`UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`)
            .run(`Loop dispatch failed: ${err.message}`, objective.id)
          emitProgress(objective.id, { type: 'objective_failed', reason: err.message })
        }
        return
      }
      db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run('decomposing', objective.id)
      res.json({ status: 'approved', checkpoint_id: req.params.cpid, objective_status: 'decomposing' })
      try {
        await decomposeObjective(objective)
      } catch (err) {
        console.error('[Checkpoints] Post-approval decomposition failed:', err.message)
        db.prepare(`UPDATE objectives SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`)
          .run(`Decomposition failed: ${err.message}`, objective.id)
        emitProgress(objective.id, { type: 'objective_failed', reason: err.message })
      }
      return
    }

    // QLoop feature 4: a loop_* gate is raised WHILE the session runs, so
    // approving it has no dispatch side effect: the loop never stopped and
    // there is nothing to resume. Record the human's "carry on" for the audit
    // trail and answer.
    if (isLoopCheckpointType(checkpoint?.checkpoint_type)) {
      recordLoopCheckpointApproval(db, objective, {
        checkpointId: req.params.cpid,
        checkpointType: checkpoint.checkpoint_type,
        reviewerId: req.user_id,
        notes,
      })
      return res.json({
        status: 'approved',
        checkpoint_id: req.params.cpid,
        loop_gate: checkpoint.checkpoint_type,
        objective_status: objective.status,
      })
    }

    res.json({ status: 'approved', checkpoint_id: req.params.cpid })
  } catch (error) {
    console.error('[Checkpoints] Approve error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
  }
})

app.post('/api/objectives/:id/checkpoints/:cpid/reject', authenticate, requireHumanApprover, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    // F4: HITL checkpoint decisions are ORG-level human acts; owner-scoping made an agent-owned patrol's gate undecidable by any real operator.
    if (objective.org_id !== req.org_id) return res.status(404).json({ error: 'Objective not found', hint: 'This objective exists but is not in your active organization; switch to the org that owns it (quox org switch <orgId>) and retry.' })

    // Read the checkpoint BEFORE the update: a live loop gate's deny side
    // effect must fire once, on the transition out of 'pending'.
    const checkpoint = db.prepare('SELECT checkpoint_type, status FROM checkpoints WHERE id = ? AND objective_id = ?')
      .get(req.params.cpid, req.params.id)

    const notes = req.body?.notes || null
    const result = db.prepare(`
      UPDATE checkpoints
      SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ?
      WHERE id = ? AND objective_id = ?
    `).run(req.user_id, notes, req.params.cpid, req.params.id)

    if (result.changes === 0) return res.status(404).json({ error: 'Checkpoint not found' })

    emitProgress(req.params.id, {
      type: 'checkpoint_rejected',
      checkpoint_id: req.params.cpid,
      reviewed_by: req.user_id,
    })
    settleCheckpointInbox(db, req.params.cpid, req, 'deny')

    // AEE-CHECKPOINT-EVIDENCE (quox#480): see the approve route above.
    createTaskEnvelope({
      type: 'event', from: `human.${req.user_id}`, to: 'service.tasks',
      intent: TASK_INTENTS.CHECKPOINT_REJECTED,
      payload: {
        checkpoint_id: req.params.cpid,
        checkpoint_type: checkpoint?.checkpoint_type,
        objective_title: objective.title,
        reviewed_by: req.user_id,
        notes: notes ? String(notes).slice(0, 500) : undefined,
      },
      corrId: objective.corr_id, objectiveId: objective.id,
    })

    // QLoop feature 4: denying a live loop gate is the lever with teeth.
    // interrupt the running session (reason 'checkpoint_denied') and fail the
    // objective with a human-deny message.
    if (isLoopCheckpointType(checkpoint?.checkpoint_type) && checkpoint.status === 'pending') {
      const outcome = await denyLoopCheckpoint(db, objective, {
        checkpointId: req.params.cpid,
        checkpointType: checkpoint.checkpoint_type,
        reviewerId: req.user_id,
        notes,
      })
      return res.json({
        status: 'rejected',
        checkpoint_id: req.params.cpid,
        loop_gate: checkpoint.checkpoint_type,
        interrupted: outcome.interrupted,
        objective_status: outcome.failed ? 'failed' : objective.status,
      })
    }

    // F6-sharp (.131 drive, 2026-08-15): denying a BEFORE_START gate is the
    // human saying "this objective does not run". The old behaviour left the
    // objective 'pending' forever: still counted active, still dedup-blocked
    // future patrol wakes, and there was no governed way to clear it. A
    // denied pre-start gate now cancels the objective (terminal).
    if (checkpoint?.checkpoint_type === 'before_start' && checkpoint.status === 'pending'
        && !['completed', 'failed', 'cancelled', 'aborted'].includes(objective.status)) {
      db.prepare(`
        UPDATE objectives SET status = 'cancelled', completed_at = datetime('now'),
          error_message = ?
        WHERE id = ?
      `).run(`Cancelled: pre-start approval rejected by ${req.user_id}${notes ? `: ${notes}` : ''}`.slice(0, 2000), req.params.id)
      emitProgress(req.params.id, { type: 'objective_failed', message: 'Pre-start approval rejected; objective cancelled' })
      return res.json({ status: 'rejected', checkpoint_id: req.params.cpid, objective_status: 'cancelled' })
    }

    res.json({ status: 'rejected', checkpoint_id: req.params.cpid })
  } catch (error) {
    console.error('[Checkpoints] Reject error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
  }
})

// On-demand HALT of a running loop (DEVSUITE-DEVMODE). The deny lever only exists
// while a gate is pending; a human needs an unconditional "stop this loop now"
// action. Same signed-kill teeth as deny (proven live 2026-08-14), reachable at
// any moment the loop is in-flight. Org + ownership scoped like every mutation.
// P3 (QUOXPERTICUS): the wake seam. The persistence supervisor on the
// resident box triggers a wake and chooses NOTHING (DEC-5): mode, org
// binding and capability scope resolve server-side in lib/quoxperticusWake,
// and every wake creates a PRE-START-GATED patrol objective (a human
// approves each patrol from the inbox; the wake never dispatches).
// Supervisor/service-only: a human uses the normal objectives surface.
app.post('/api/internal/quoxperticus/wake', authenticate, writeRateLimit, async (req, res) => {
  if (!req.viaServiceKey) {
    return res.status(403).json({ error: 'The wake seam is supervisor-only (internal service key required)' })
  }
  try {
    const { wakeQuoxperticus } = await import('./lib/quoxperticusWake.js')
    const result = await wakeQuoxperticus(getDatabase())
    res.json(result)
  } catch (error) {
    console.error('[QuoxperticusWake] wake error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/objectives/:id/halt', authenticate, requireHumanApprover, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    // F4: org-scoped, a same-org human must be able to halt an agent-owned patrol loop.
    if (objective.org_id !== req.org_id) return res.status(404).json({ error: 'Objective not found', hint: 'This objective exists but is not in your active organization; switch to the org that owns it (quox org switch <orgId>) and retry.' })
    if (objective.execution_mode !== 'loop') return res.status(400).json({ error: 'Not a loop objective' })

    const outcome = await haltLoopObjective(db, objective, {
      reviewerId: req.user_id,
      notes: req.body?.notes || null,
    })
    if (!outcome.halted) {
      return res.status(409).json({ status: 'not_halted', reason: outcome.message, objective_status: objective.status })
    }
    return res.json({
      status: 'halted',
      interrupted: outcome.interrupted,
      objective_status: 'failed',
      message: outcome.message,
    })
  } catch (error) {
    console.error('[Objectives] Halt error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
  }
})

// ==========================================
// Step 16: Envelope log endpoint
// ==========================================
app.get('/api/objectives/:id/envelopes', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT org_id, user_id FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })

    const envelopes = db.prepare(`
      SELECT * FROM envelopes WHERE objective_id = ? ORDER BY created_at ASC
    `).all(req.params.id)

    res.json({ envelopes })
  } catch (error) {
    console.error('[Envelopes] List error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ==========================================
// EUX-6: SSE progress stream
// ==========================================
app.get('/api/objectives/:id/stream', authenticate, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT org_id, user_id, status FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ objective_id: req.params.id, status: objective.status })}\n\n`)

    // Subscribe to progress events
    subscribe(req.params.id, res)

    // Keep-alive every 30s
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n') }
      catch { clearInterval(keepAlive) }
    }, 30000)

    res.on('close', () => clearInterval(keepAlive))
  } catch (error) {
    console.error('[SSE] Stream setup error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
  }
})

// ==========================================
// BQ Phase 4: Internal progress callback from QuoxFlow agentic executor
// ==========================================
app.post('/api/internal/progress/:objectiveId', (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }

  const { objectiveId } = req.params
  const event = req.body

  if (!event || !event.type) {
    return res.status(400).json({ error: 'event.type is required' })
  }

  // Forward to SSE subscribers
  emitProgress(objectiveId, event)

  // Update task heartbeat if this is an iteration event
  if (event.type === 'agentic_iteration' || event.type === 'agentic_think' || event.type === 'agentic_act') {
    try {
      const db = getDatabase()
      // Find the running task for this objective
      const task = db.prepare(
        "SELECT id FROM tasks WHERE objective_id = ? AND status = 'running' LIMIT 1"
      ).get(objectiveId)
      if (task) {
        db.prepare('UPDATE tasks SET started_at = COALESCE(started_at, datetime(\'now\')) WHERE id = ?').run(task.id)
      }
    } catch { /* non-critical */ }
  }

  res.json({ ok: true })
})

// ==========================================
// Agent Standing — internal event ingestion
// ==========================================
// Cross-service bridge: the auth service's HITL respond handler
// (services/auth/routes/inbox.js, POST /orgs/:orgId/inbox/:itemId/respond)
// is where request_changes ("correction") and explicit deny ("override")
// signals on an autonomy-escalation inbox item actually happen, but
// agent_standing/agent_standing_events live in THIS service's DB (same db
// as agent_performance/tasks, which task_class resolution and risk-tiering
// both need). Mirrors the INTERNAL_SERVICE_KEY pattern used by every other
// /api/internal/* route in this file (see /api/internal/progress above).
app.post('/api/internal/agent-standing/event', (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }

  const { org_id, agent_id, task_class, event_type, task_id, objective_id, actor, reason } = req.body || {}
  if (!org_id || !agent_id || !event_type) {
    return res.status(400).json({ error: 'org_id, agent_id and event_type are required' })
  }

  try {
    const db = getDatabase()
    const resolvedTaskClass = task_class || resolveTaskClass(db, task_id)
    const result = recordStandingEvent(org_id, agent_id, resolvedTaskClass, {
      eventType: event_type,
      taskId: task_id || null,
      objectiveId: objective_id || null,
      actor: actor || null,
      reason: reason || null,
    })
    res.json({ ok: true, standing: result.standing, redemption: result.redemption })
  } catch (err) {
    console.error('[AgentStanding] Event ingestion error:', err.message)
    res.status(400).json({ error: err.message })
  }
})

// Agent Standing — read endpoint for the frontend (Mission Control's
// StandingBadge). Org-scoped via authenticate (same pattern as the
// /api/autonomy/* routes above). Never-seen agent+task_class returns the
// cold-start default (score 50, autonomous, empty history/events) rather
// than a 404 — see getStandingWithHistory()'s doc comment.
app.get('/api/agent-standing/:agentId', authenticate, readRateLimit, (req, res) => {
  try {
    const taskClass = req.query.task_class || 'general'
    const result = getStandingWithHistory(req.org_id, req.params.agentId, taskClass)
    res.json(result)
  } catch (err) {
    console.error('[AgentStanding] Read error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ==========================================
// Logs
// ==========================================
app.get('/api/objectives/:id/logs', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const objective = db.prepare('SELECT org_id, user_id FROM objectives WHERE id = ?').get(req.params.id)
    if (!objective) return res.status(404).json({ error: 'Objective not found' })
    if (objective.org_id !== req.org_id || objective.user_id !== req.user_id) return res.status(403).json({ error: 'Access denied' })

    const { limit = 100 } = req.query
    const logs = db.prepare(`
      SELECT * FROM task_logs WHERE objective_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(req.params.id, parseInt(limit, 10))

    res.json({ logs })
  } catch (error) {
    console.error('[Logs] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ==========================================
// Agentic Teams (Stream E)
// ==========================================

// M-ROOMS: sync a team's auto-assistant and Matrix room after any lifecycle
// change (create, install, update, backfill, or on-demand). Fire-and-forget
// safe: awaits both calls but never throws, so callers can either await it
// or attach a .catch() and move on. The room's lead agent is the
// auto-created `team-<id>` orchestrator assistant provisioned in step 1,
// not the manifest's raw orchestrator.agentId.
async function syncTeamMatrix(orgId, manifest, userId) {
  const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.INTERNAL_SERVICE_KEY ? { 'x-service-key': process.env.INTERNAL_SERVICE_KEY } : {}),
  };

  let assistant;
  try {
    const assistantRes = await fetch(`${AUTH_URL}/api/internal/teams/${manifest.id}/assistant`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org_id: orgId,
        user_id: userId,
        teamName: manifest.displayName,
        orchestratorId: manifest.orchestrator?.agentId,
        members: manifest.members,
        description: manifest.description,
      }),
    });
    assistant = assistantRes.ok ? await assistantRes.json().catch(() => ({ ok: true })) : { error: `status ${assistantRes.status}` };
  } catch (err) {
    console.warn(`[Teams] Matrix sync: assistant step failed (non-fatal): ${err.message}`);
    assistant = { error: err.message };
  }

  let room;
  try {
    const roomRes = await fetch(`${AUTH_URL}/api/internal/matrix/provision-node`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org_id: orgId,
        node_type: 'agentic_team',
        node_id: manifest.id,
        label: manifest.displayName,
        actor_id: userId,
        roster: {
          orchestratorAgentId: `team-${manifest.id}`,
          memberAgentIds: (manifest.members || []).map(m => m.agentId),
        },
      }),
    });
    room = roomRes.ok ? await roomRes.json().catch(() => ({ ok: true })) : { error: `status ${roomRes.status}` };
  } catch (err) {
    console.warn(`[Teams] Matrix sync: room provisioning step failed (non-fatal): ${err.message}`);
    room = { error: err.message };
  }

  return { assistant, room };
}

// List installed teams for org
app.get('/api/teams', authenticate, readRateLimit, (req, res) => {
  try {
    const teams = listTeamDefinitions(req.org_id);
    const result = teams.map(t => ({
      id: t.id,
      displayName: t.manifest.displayName,
      description: t.manifest.description,
      icon: t.manifest.icon,
      accentColor: t.manifest.accentColor,
      tier: t.manifest.tier,
      price: t.manifest.price,
      source: t.source,
      status: t.status,
      agentCount: (t.manifest.members?.length || 0) + 1,
      orchestratorId: t.manifest.orchestrator?.agentId,
      installed_at: t.installed_at,
    }));
    res.json({ teams: result });
  } catch (err) {
    console.error('[Teams] List error:', err.message);
    res.status(500).json({ error: 'Failed to list teams' });
  }
});

// Get team details
app.get('/api/teams/:teamId', authenticate, readRateLimit, (req, res) => {
  try {
    const team = getTeamDefinition(req.org_id, req.params.teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json({
      id: team.id,
      source: team.source,
      status: team.status,
      installed_at: team.installed_at,
      installed_by: team.installed_by,
      manifest: team.manifest,
    });
  } catch (err) {
    console.error('[Teams] Get error:', err.message);
    res.status(500).json({ error: 'Failed to get team' });
  }
});

// Create a custom team from user-provided data
app.post('/api/teams/create', authenticate, writeRateLimit, (req, res) => {
  try {
    const { displayName, description, orchestratorAgentId, members, policies } = req.body;

    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }
    if (!orchestratorAgentId) {
      return res.status(400).json({ error: 'orchestratorAgentId is required' });
    }
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'At least one member is required' });
    }

    // S5: Validate agent IDs are non-empty alphanumeric strings
    const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,49}$/;
    if (!AGENT_ID_RE.test(orchestratorAgentId)) {
      return res.status(400).json({ error: `Invalid orchestrator agent ID: "${orchestratorAgentId}"` });
    }
    for (const m of members) {
      if (!m.agentId || !AGENT_ID_RE.test(m.agentId)) {
        return res.status(400).json({ error: `Invalid member agent ID: "${m.agentId || ''}"` });
      }
    }

    // Generate slug ID from displayName
    const id = displayName.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    if (!id) {
      return res.status(400).json({ error: 'Could not generate valid ID from displayName' });
    }

    // Build the manifest
    const manifest = {
      id,
      type: 'team',
      version: '1.0.0',
      displayName: displayName.trim(),
      description: description?.trim() || '',
      icon: 'cpu',
      accentColor: '#8b5cf6',
      tier: 'custom',
      author: req.user_id,
      orchestrator: { agentId: orchestratorAgentId, role: 'orchestrator' },
      members: members.map(m => ({
        agentId: m.agentId,
        role: m.role || 'specialist',
        domains: m.domains || [],
      })),
      policies: {
        maxBudgetTokens: policies?.maxBudgetTokens || 200000,
        maxBudgetToolCalls: policies?.maxBudgetToolCalls || 100,
        maxDurationMs: policies?.maxDurationMs || 600000,
        maxParallelTasks: policies?.maxParallelTasks || 3,
        requireApprovalBeforeStart: policies?.requireApprovalBeforeStart || false,
        checkpointAfterEachTask: policies?.checkpointAfterEachTask || false,
        voltRequired: policies?.voltRequired || false,
      },
    };

    const validation = validateTeamManifest(manifest);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid team manifest', details: validation.errors });
    }

    const result = installTeam(req.org_id, manifest, req.user_id, 'user');

    // Auto-create assistant + Matrix room (non-fatal, fire-and-forget)
    syncTeamMatrix(req.org_id, manifest, req.user_id).catch(err => {
      console.warn(`[Teams] Auto-assistant creation failed (non-fatal): ${err.message}`);
    });

    res.status(result.action === 'installed' ? 201 : 200).json({
      ...result,
      manifest,
    });
  } catch (err) {
    console.error('[Teams] Create error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create team' });
  }
});

// Update team settings (PATCH)
app.patch('/api/teams/:teamId', authenticate, writeRateLimit, (req, res) => {
  try {
    const existing = getTeamDefinition(req.org_id, req.params.teamId);
    if (!existing) return res.status(404).json({ error: 'Team not found' });

    const manifest = { ...existing.manifest };

    // Deep-merge incoming fields
    if (req.body.displayName) manifest.displayName = req.body.displayName.trim();
    if (req.body.description !== undefined) manifest.description = req.body.description;
    if (req.body.orchestratorAgentId) {
      manifest.orchestrator = { ...manifest.orchestrator, agentId: req.body.orchestratorAgentId };
    }
    if (Array.isArray(req.body.members)) {
      manifest.members = req.body.members.map(m => ({
        agentId: m.agentId,
        role: m.role || 'specialist',
        domains: m.domains || [],
      }));
    }
    if (req.body.policies) {
      manifest.policies = { ...manifest.policies, ...req.body.policies };
    }
    if (req.body.autonomyPolicies) {
      manifest.autonomyPolicies = { ...manifest.autonomyPolicies, ...req.body.autonomyPolicies };
    }
    if (req.body.accentColor) manifest.accentColor = req.body.accentColor;
    if (req.body.icon) manifest.icon = req.body.icon;

    const validation = validateTeamManifest(manifest);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid manifest after update', details: validation.errors });
    }

    const result = installTeam(req.org_id, manifest, req.user_id, existing.source);

    // Sync Matrix room roster after update (non-fatal, fire-and-forget; provisioner is idempotent)
    syncTeamMatrix(req.org_id, manifest, req.user_id).catch(err => {
      console.warn(`[Teams] Matrix sync after update failed (non-fatal): ${err.message}`);
    });

    res.json({ ...result, manifest });
  } catch (err) {
    console.error('[Teams] Update error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to update team' });
  }
});

// Install a team (from manifest JSON)
app.post('/api/teams/install', authenticate, writeRateLimit, (req, res) => {
  try {
    const { manifest } = req.body;
    if (!manifest) return res.status(400).json({ error: 'Missing manifest' });

    const validation = validateTeamManifest(manifest);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid manifest', details: validation.errors });
    }

    const result = installTeam(req.org_id, manifest, req.user_id);

    // Sync assistant + Matrix room for the installed team (non-fatal, fire-and-forget)
    syncTeamMatrix(req.org_id, manifest, req.user_id).catch(err => {
      console.warn(`[Teams] Matrix sync after install failed (non-fatal): ${err.message}`);
    });

    res.status(result.action === 'installed' ? 201 : 200).json(result);
  } catch (err) {
    console.error('[Teams] Install error:', err.message);
    res.status(500).json({ error: 'Failed to install team' });
  }
});

// Uninstall a team
app.delete('/api/teams/:teamId', authenticate, writeRateLimit, (req, res) => {
  try {
    const removed = uninstallTeam(req.org_id, req.params.teamId);
    if (!removed) return res.status(404).json({ error: 'Team not found' });

    // Deprovision the Matrix room (non-fatal, fire-and-forget)
    const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
    fetch(`${AUTH_URL}/api/internal/matrix/deprovision-node`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.INTERNAL_SERVICE_KEY ? { 'x-service-key': process.env.INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({
        org_id: req.org_id,
        node_type: 'agentic_team',
        node_id: req.params.teamId,
        actor_id: req.user_id,
      }),
    }).catch(err => {
      console.warn(`[Teams] Matrix room deprovisioning failed (non-fatal): ${err.message}`);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Teams] Uninstall error:', err.message);
    res.status(500).json({ error: 'Failed to uninstall team' });
  }
});

// Get team shared context (for a specific instance)
app.get('/api/teams/:teamId/context', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase();
    const instance = db.prepare(
      'SELECT id, shared_context_json FROM team_instances WHERE team_definition_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(req.params.teamId, req.org_id);
    if (!instance) return res.json({ context: {} });
    res.json({ context: JSON.parse(instance.shared_context_json || '{}'), instance_id: instance.id });
  } catch (err) {
    console.error('[Teams] Context get error:', err.message);
    res.status(500).json({ error: 'Failed to get team context' });
  }
});

// Update team shared context
app.put('/api/teams/:teamId/context', authenticate, writeRateLimit, (req, res) => {
  try {
    const { instance_id, key, value } = req.body;
    if (!instance_id || !key) return res.status(400).json({ error: 'Missing instance_id or key' });
    // S1: Verify the instance belongs to caller's org before allowing writes
    const instance = getTeamInstance(instance_id);
    if (!instance || instance.org_id !== req.org_id) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    const updated = updateTeamContext(instance_id, key, value);
    if (!updated) return res.status(404).json({ error: 'Instance not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Teams] Context update error:', err.message);
    res.status(500).json({ error: 'Failed to update team context' });
  }
});

// M-ROOMS: on-demand trigger, so the UI can retry provisioning for a team
// whose assistant or Matrix room was never created (or drifted out of sync).
app.post('/api/teams/:teamId/provision-room', authenticate, writeRateLimit, async (req, res) => {
  try {
    const def = getTeamDefinition(req.org_id, req.params.teamId);
    if (!def) return res.status(404).json({ error: 'Team not found' });

    const result = await syncTeamMatrix(req.org_id, def.manifest, req.user_id);
    res.json(result);
  } catch (err) {
    console.error('[Teams] Provision-room error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to provision Matrix room' });
  }
});

// M-ROOMS: internal backfill for teams that existed before Matrix
// provisioning was wired in, or for admin-triggered re-sync of a single org.
// Runs sequentially (not in parallel) to avoid hammering the auth service.
app.post('/api/internal/teams/backfill-matrix', async (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }

  try {
    const { org_id } = req.body || {};
    let definitions;
    if (org_id) {
      definitions = listTeamDefinitions(org_id);
    } else {
      // teamLoader.js has no cross-org listing helper; read all active
      // team_definitions rows directly here, mirroring listTeamDefinitions'
      // own query shape rather than modifying teamLoader.js.
      const db = getDatabase();
      const rows = db.prepare('SELECT * FROM team_definitions WHERE status = ? ORDER BY installed_at DESC').all('active');
      definitions = rows.map(row => ({ ...row, manifest: JSON.parse(row.manifest_json) }));
    }

    const results = [];
    for (const def of definitions) {
      // null actor: backfill has no real user, and a non-null actor would be
      // invited to the room as @human.<actor> by the provisioner.
      const synced = await syncTeamMatrix(def.org_id, def.manifest, null);
      results.push({ org_id: def.org_id, team_id: def.id, assistant: synced.assistant, room: synced.room });
    }

    res.json({ teams: results.length, results });
  } catch (err) {
    console.error('[Teams] Backfill-matrix error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to backfill Matrix rooms' });
  }
});

// ==========================================
// Team Schedules (Stream E4)
// ==========================================

// List schedules for a team
app.get('/api/teams/:teamId/schedules', authenticate, readRateLimit, (req, res) => {
  try {
    const schedules = listSchedules(req.org_id, req.params.teamId);
    res.json({ schedules });
  } catch (err) {
    console.error('[Schedules] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create schedule
app.post('/api/teams/:teamId/schedules', authenticate, writeRateLimit, (req, res) => {
  try {
    const { name, cronExpression, timezone, objectiveTemplate, maxConsecutiveFailures } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!objectiveTemplate?.title?.trim()) return res.status(400).json({ error: 'objectiveTemplate.title is required' });

    const schedule = createSchedule(req.org_id, req.user_id, req.params.teamId, {
      name, cronExpression, timezone, objectiveTemplate, maxConsecutiveFailures,
    });
    res.status(201).json(schedule);
  } catch (err) {
    console.error('[Schedules] Create error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Update schedule
app.patch('/api/teams/:teamId/schedules/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const schedule = updateSchedule(req.org_id, req.params.id, req.body);
    res.json(schedule);
  } catch (err) {
    console.error('[Schedules] Update error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Delete schedule
app.delete('/api/teams/:teamId/schedules/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const deleted = deleteSchedule(req.org_id, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Schedules] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Toggle schedule enabled/disabled
app.post('/api/teams/:teamId/schedules/:id/toggle', authenticate, writeRateLimit, (req, res) => {
  try {
    const { enabled } = req.body;
    const schedule = toggleSchedule(req.org_id, req.params.id, enabled !== false);
    res.json(schedule);
  } catch (err) {
    console.error('[Schedules] Toggle error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// OE-5: Run-now — trigger a schedule immediately without advancing next_trigger_at
app.post('/api/teams/:teamId/schedules/:id/trigger', authenticate, writeRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    const schedule = db.prepare('SELECT * FROM team_schedules WHERE id = ? AND org_id = ?')
      .get(req.params.id, req.org_id)
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' })

    const { triggerSchedule } = await import('./lib/teamScheduler.js')
    await triggerSchedule(schedule)
    res.json({ success: true, message: `Schedule ${req.params.id} triggered` })
  } catch (err) {
    console.error('[Schedules] Run-now error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// WC-5 / P6.A.1: List all schedules for the org (team_schedules + workflow trigger:schedule nodes)
app.get('/api/schedules', authenticate, readRateLimit, async (req, res) => {
  try {
    const db = getDatabase()
    // 1. Team-side schedules (existing). Query extracted to lib/orgSchedules.js
    // with its own pin: td.display_name never existed (name lives in
    // manifest_json.displayName) and the old inline column ref 500'd this
    // whole endpoint for any org with a schedule row.
    const { listTeamSchedulesWithNames } = await import('./lib/orgSchedules.js')
    const teamSchedules = listTeamSchedulesWithNames(db, req.org_id)

    // 2. Workflow-level schedules — fetch active workflows from QuoxFlow, extract trigger:schedule nodes
    const workflowRows = []
    try {
      const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200'
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || ''
      const wfRes = await fetch(`${QUOXFLOW_URL}/api/workflows?active=true&limit=200`, {
        headers: {
          'Content-Type': 'application/json',
          ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
        },
        signal: AbortSignal.timeout(5000),
      })
      if (wfRes.ok) {
        const wfData = await wfRes.json()
        const workflows = wfData?.data || wfData?.workflows || []
        for (const wf of workflows) {
          const nodes = wf.definition?.nodes || wf.nodes || []
          for (const node of nodes) {
            if (node.type === 'trigger:schedule') {
              const cron = node.config?.cron || node.config?.expression || node.data?.cron || node.data?.expression || ''
              workflowRows.push({
                id: `wf:${wf.id}:${node.id}`,
                kind: 'workflow',
                source: 'tasks',
                workflow_id: wf.id,
                workflow_name: wf.name || wf.id,
                node_id: node.id,
                name: wf.name || wf.id,
                cron_expression: cron,
                timezone: node.config?.timezone || node.data?.timezone || 'UTC',
                enabled: wf.active ? 1 : 0,
                next_trigger_at: null,
                team_name: null,
                team_definition_id: null,
                last_status: null,
                objective_template_json: null,
              })
            }
          }
        }
      } else {
        console.warn(`[Schedules] QuoxFlow workflow fetch returned ${wfRes.status} — skipping workflow rows`)
      }
    } catch (wfErr) {
      // Non-fatal: if QuoxFlow is down, return team rows only
      console.warn(`[Schedules] QuoxFlow workflow fetch failed (non-fatal): ${wfErr.message}`)
    }

    // 3. Union: team rows first (maintain existing sort), then workflow rows
    const schedules = [...teamSchedules, ...workflowRows]
    res.json({ schedules })
  } catch (err) {
    console.error('[Schedules] Org-list error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// WC-2: Org-level schedule (no team required) — for template-based scheduling
app.post('/api/schedules', authenticate, writeRateLimit, (req, res) => {
  try {
    const { name, cronExpression, timezone, objectiveTemplate, maxConsecutiveFailures } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' })
    if (!cronExpression || !isValidCron(cronExpression)) return res.status(400).json({ error: 'Invalid cron expression' })
    if (!objectiveTemplate?.title?.trim()) return res.status(400).json({ error: 'objectiveTemplate.title is required' })

    const teamId = objectiveTemplate.team_id || null

    // If template has a team_id, delegate to the existing team scheduler
    if (teamId) {
      const schedule = createSchedule(req.org_id, req.user_id, teamId, {
        name, cronExpression, timezone, objectiveTemplate, maxConsecutiveFailures,
      })
      return res.status(201).json(schedule)
    }

    // No team — create an org-level schedule in team_schedules with team_definition_id = NULL
    const db = getDatabase()
    const id = ulid()
    const nextTrigger = getNextCronRun(cronExpression)

    db.prepare(`
      INSERT INTO team_schedules (id, team_definition_id, org_id, user_id, name, trigger_type, cron_expression, timezone, objective_template_json, enabled, next_trigger_at, max_consecutive_failures, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, 'schedule', ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, req.org_id, req.user_id,
      name.trim(),
      cronExpression.trim(),
      timezone || 'UTC',
      JSON.stringify(objectiveTemplate),
      nextTrigger ? nextTrigger.toISOString() : null,
      maxConsecutiveFailures || 3,
    )

    const schedule = db.prepare('SELECT * FROM team_schedules WHERE id = ?').get(id)
    res.status(201).json(schedule)
  } catch (err) {
    console.error('[Schedules] Org-level create error:', err.message)
    res.status(400).json({ error: err.message })
  }
})

// Daily autonomy usage stats
app.get('/api/teams/:teamId/usage/daily', authenticate, readRateLimit, (req, res) => {
  try {
    const usage = getDailyUsage(req.org_id, req.params.teamId);
    res.json(usage);
  } catch (err) {
    console.error('[Schedules] Usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// AT-5: Agent performance API
// ==========================================

// Team performance — per-agent scores
app.get('/api/teams/:teamId/performance', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const agents = db.prepare(`
      SELECT agent_id,
        COUNT(*) as task_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        AVG(quality_score) as avg_quality,
        AVG(latency_ms) as avg_latency,
        SUM(tokens_used) as total_tokens
      FROM agent_performance
      WHERE org_id = ? AND created_at > datetime('now', '-30 days')
      GROUP BY agent_id
      ORDER BY AVG(quality_score) DESC
    `).all(req.org_id)

    const result = agents.map(a => ({
      agentId: a.agent_id,
      taskCount: a.task_count,
      successRate: a.task_count > 0 ? a.successes / a.task_count : 0,
      avgQuality: Math.round(a.avg_quality || 50),
      avgLatencyMs: Math.round(a.avg_latency || 0),
      totalTokens: a.total_tokens || 0,
      score: Math.round(
        (a.task_count > 0 ? a.successes / a.task_count : 0.5) * 35 +
        Math.max(0, 100 - (a.avg_latency || 5000) / 100) * 0.20 +
        Math.max(0, 100 - ((a.total_tokens / Math.max(a.task_count, 1)) || 0) / 500) * 0.20 +
        ((a.avg_quality || 50) / 100) * 100 * 0.25
      ),
    }))

    res.json({ agents: result })
  } catch (err) {
    console.error('[Performance] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ==========================================
// Stream E5: Pack install + Team export
// ==========================================

// Install all teams from a pack
app.post('/api/teams/install-pack', authenticate, writeRateLimit, (req, res) => {
  try {
    const { packManifest, teamManifests } = req.body;
    if (!packManifest || !teamManifests) {
      return res.status(400).json({ error: 'packManifest and teamManifests are required' });
    }
    const result = installPackFromManifest(req.org_id, req.user_id, packManifest, teamManifests);
    res.json(result);
  } catch (err) {
    console.error('[Packs] Install error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Export a team definition as portable JSON
app.get('/api/teams/:teamId/export', authenticate, readRateLimit, (req, res) => {
  try {
    const manifest = exportTeam(req.org_id, req.params.teamId);
    if (!manifest) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json(manifest);
  } catch (err) {
    console.error('[Packs] Export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Phase 7.A: Agent Autonomy
// ==========================================

// List agent schedules (optional ?agent_id= filter)
app.get('/api/agent-schedules', authenticate, readRateLimit, (req, res) => {
  try {
    const schedules = listAgentSchedules(req.org_id, req.query.agent_id || null)
    res.json(schedules)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create agent schedule
app.post('/api/agent-schedules', authenticate, writeRateLimit, (req, res) => {
  try {
    const { agentId, ...data } = req.body
    if (!agentId) return res.status(400).json({ error: 'agentId is required' })
    const schedule = createAgentSchedule(req.org_id, req.user_id, agentId, data)
    res.status(201).json(schedule)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Update agent schedule
app.patch('/api/agent-schedules/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const schedule = updateAgentSchedule(req.org_id, req.params.id, req.body)
    res.json(schedule)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Delete agent schedule
app.delete('/api/agent-schedules/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const deleted = deleteAgentSchedule(req.org_id, req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Schedule not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Toggle agent schedule
app.post('/api/agent-schedules/:id/toggle', authenticate, writeRateLimit, (req, res) => {
  try {
    const { enabled } = req.body
    const schedule = toggleAgentSchedule(req.org_id, req.params.id, enabled !== false)
    res.json(schedule)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Autonomy summary (active schedules, today's runs, decisions)
app.get('/api/autonomy/summary', authenticate, readRateLimit, (req, res) => {
  try {
    const summary = getAutonomySummary(req.org_id)
    res.json(summary)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Autonomy decision history
app.get('/api/autonomy/decisions', authenticate, readRateLimit, (req, res) => {
  try {
    const decisions = getDecisionHistory(req.org_id, {
      limit: parseInt(req.query.limit || '50'),
      agentId: req.query.agent_id,
      decision: req.query.decision
    })
    res.json(decisions)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Autonomy decision stats
app.get('/api/autonomy/stats', authenticate, readRateLimit, (req, res) => {
  try {
    const stats = getDecisionStats(req.org_id, { since: req.query.since })
    res.json(stats)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ==========================================
// AQ-9B Calendar-Q (Phase 1 — backend only)
// org+user scoped calendar_events CRUD. Recurring events are delegated to
// team_schedules/agent_schedules (the EXISTING scheduler); one-off reminders
// fire via checkDueCalendarEvents()'s poller (lib/calendarEvents.js).
// ==========================================

// List calendar events for the caller's org (optionally filtered to the
// caller's own events + a from/to window on start_at).
app.get('/api/calendar/events', authenticate, readRateLimit, (req, res) => {
  try {
    const scopeToUser = req.query.mine !== 'false'
    const events = listCalendarEvents(req.org_id, scopeToUser ? req.user_id : null, {
      from: req.query.from,
      to: req.query.to,
    })
    res.json({ events })
  } catch (err) {
    console.error('[Calendar] List error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/calendar/events/:id', authenticate, readRateLimit, (req, res) => {
  try {
    const event = getCalendarEvent(req.org_id, req.params.id)
    if (!event) return res.status(404).json({ error: 'Calendar event not found' })
    res.json(event)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/calendar/events', authenticate, writeRateLimit, (req, res) => {
  try {
    const event = createCalendarEvent(req.org_id, req.user_id, req.body || {})
    res.status(201).json(event)
  } catch (err) {
    console.error('[Calendar] Create error:', err.message)
    res.status(400).json({ error: err.message })
  }
})

app.patch('/api/calendar/events/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const event = updateCalendarEvent(req.org_id, req.params.id, req.body || {})
    res.json(event)
  } catch (err) {
    console.error('[Calendar] Update error:', err.message)
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/calendar/events/:id', authenticate, writeRateLimit, (req, res) => {
  try {
    const deleted = deleteCalendarEvent(req.org_id, req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Calendar event not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// NL -> cron utility (WC-2 grammar, server-side port of src/services/cronHelper.js
// naturalLanguageToCron — used by chat-driven event creation / the future
// calendar-q agent tool). Does not persist anything.
app.post('/api/calendar/nl-to-cron', authenticate, readRateLimit, (req, res) => {
  try {
    const { text } = req.body || {}
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' })
    const cron = naturalLanguageToCron(text)
    if (!cron) return res.status(422).json({ error: `Could not parse "${text}" into a schedule`, cron: null })
    res.json({ cron, valid: isValidCron(cron) })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ==========================================
// QuoxMind Wisdom & Outcomes API (QM-5)
// ==========================================

// Record wisdom (from external services like screencap)
app.post('/api/wisdom', (req, res) => {
  try {
    const key = req.headers['x-service-key']
    if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
      return res.status(401).json({ error: 'Invalid service key' })
    }
    const { org_id, pattern_name, category, lesson, directive, severity, tags, source_objective_id } = req.body
    if (!org_id || !pattern_name) {
      return res.status(400).json({ error: 'org_id and pattern_name are required' })
    }
    recordWisdom(org_id, {
      patternName: pattern_name,
      category: category || 'general',
      lesson: lesson || '',
      directive: directive || '',
      severity: severity || 'low',
      tags: tags || [],
      sourceObjectiveId: source_objective_id
    })
    res.json({ success: true })
  } catch (err) {
    console.error('[Wisdom] Record error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Search wisdom entries
app.get('/api/wisdom', authenticate, readRateLimit, (req, res) => {
  try {
    const { q, limit = 10, min_confidence = 0 } = req.query
    const results = q
      ? searchWisdom(req.org_id, q, { limit: parseInt(limit, 10), minConfidence: parseFloat(min_confidence) })
      : listWisdom(req.org_id, { limit: parseInt(limit, 10) })
    res.json({ wisdom: results })
  } catch (err) {
    console.error('[Wisdom] Search error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Get wisdom relevant to a text
app.get('/api/wisdom/relevant', authenticate, readRateLimit, (req, res) => {
  try {
    const { text, limit = 5 } = req.query
    if (!text) return res.status(400).json({ error: 'text parameter is required' })
    const results = getRelevantWisdom(req.org_id, text, { limit: parseInt(limit, 10) })
    res.json({ wisdom: results })
  } catch (err) {
    console.error('[Wisdom] Relevant search error:', err)
    res.status(500).json({ error: err.message })
  }
})

// List recent outcomes
app.get('/api/outcomes', authenticate, readRateLimit, (req, res) => {
  try {
    const db = getDatabase()
    const { limit = 10 } = req.query
    const outcomes = db.prepare(`
      SELECT * FROM objective_outcomes
      WHERE org_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.org_id, parseInt(limit, 10))
    res.json({ outcomes })
  } catch (err) {
    console.error('[Outcomes] List error:', err)
    res.status(500).json({ error: err.message })
  }
})

// CLI-PARITY WP1.1: runtime route-introspection helper for GET /__routes.
// Loaded fail-safe via a guarded dynamic import — a static top-level
// `import` of a missing file is a hard boot failure in ESM (can't be
// wrapped in try/catch at the import site the way require() can), so any
// Dockerfile/path drift would crash-loop the whole tasks service. Degrades
// to an empty route list instead. This service's Docker build context is
// ./services/tasks (see docker-compose.yml `tasks.build.context`), so it
// can't reach services/shared/* — a local copy lives at ./lib/.
let __listRoutes = () => []
try {
  const mod = await import('./lib/routeIntrospection.cjs')
  __listRoutes = mod.listRoutes
} catch (err) {
  console.warn('[ROUTE_INTROSPECTION] Failed to load ./lib/routeIntrospection.cjs:', err.message)
}

// CLI-PARITY WP1.1: GET /__routes — fully-resolved route table for the CLI's
// live-vs-static endpoint diff. Mounted last (after every app.use/route
// above, before the error handlers) so listRoutes(app) reflects every
// router actually attached to this app instance.
// Auth: X-Service-Key header matching INTERNAL_SERVICE_KEY, same pattern
// used by this file's other /api/internal/* routes.
app.get('/__routes', (req, res) => {
  const key = req.headers['x-service-key']
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Invalid service key' })
  }
  res.json({ service: 'tasks', routes: __listRoutes(app) })
})

// ==========================================
// Global error sanitizer — prevent internal details leaking to users
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed' })
  }
  console.error(`[Tasks] Unhandled error on ${req.method} ${req.path}:`, err.message)
  const safeMessage = (process.env.NODE_ENV === 'production')
    ? 'An internal error occurred'
    : err.message?.substring(0, 200) || 'Unknown error'
  res.status(err.status || 500).json({ error: safeMessage })
})

// ==========================================
// Initialize and start
initDatabase(DB_PATH)

// QUOXMIND #1112: retire stale/duplicate wisdom, decay unseen wisdom and
// cancel pending tasks of terminal objectives on a bounded, backed-off
// schedule. Always on (no env flag); its status is in predict stats fields.
// REPORT-ONLY until the owner approves destructive retirement (2026-10-16):
// it logs candidate counts and changes no data. Install-wide, not org-scoped.
const mindRetirement = createMindRetirementScheduler({ getDb: getDatabase, mode: 'report' })

// Under vitest the app is imported by supertest suites (e.g.
// loopCreationApi.test.js) — never bind the port or start schedulers there.
const server = process.env.VITEST ? null : app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Task Service] Running on port ${PORT}`)
  console.log(`[Task Service] Database: ${DB_PATH}`)
  console.log(`[Task Service] Environment: ${process.env.NODE_ENV || 'development'}`)

  // QE2: Execution is handled by QuoxFlow — no scheduler needed
  startTeamScheduler()
  startAgentScheduler()
  // quox#896: backfill + keep checkpoint Approvals cards in step (loop and
  // wake checkpoints are raised here within a minute; bounded, backs off).
  startCheckpointInboxReconciler(getDatabase, { baseMs: 60 * 1000 })
  startCalendarReminderPoller()
  startDreamCycle()
  mindRetirement.start()
  console.log(`[Task Service] Engine: QuoxFlow (${process.env.QUOXFLOW_URL || 'http://quoxflow:3200'})`)

  // TRUST-GATE 1.2: reconcile any objective left `running` by a previous
  // instance (crash/restart orphan), then start the periodic reaper for
  // pollers that die mid-flight without a full service restart.
  try {
    await runBootReconciler()
  } catch (err) {
    console.error('[Task Service] Boot reconciler failed:', err.message)
  }
  startReaper()
})

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[Task Service] ${signal} received, shutting down...`)
  stopTeamScheduler()
  stopAgentScheduler()
  stopCalendarReminderPoller()
  stopReaper()
  mindRetirement.stop()
  if (!server) {
    closeDatabase()
    process.exit(0)
  }
  server.close(() => {
    closeDatabase()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 35000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app
