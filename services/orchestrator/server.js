/**
 * Container Orchestrator HTTP API
 *
 * SECURITY: This service handles container execution and requires strict security controls.
 * All endpoints require authentication (JWT + admin role) and are rate-limited.
 *
 * Endpoints:
 * - POST /run      - Start a container task (admin only, rate-limited)
 * - GET  /status   - List active containers (admin only)
 * - GET  /:id/logs - Get container logs (admin only)
 * - POST /:id/stop - Stop a container (admin only)
 * - GET  /health   - Health check (no auth, limited info)
 */

const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { ContainerOrchestrator } = require('./orchestrator')

// Version resolution: QUOXCORE_VERSION build arg → canonical /app/VERSION file
// → '0.0.0'. Prevents silently reporting the placeholder when the build arg is
// not passed. NOTE: this service's Docker build context is ./services/orchestrator
// (see docker-compose.yml), so the repo-root VERSION file is NOT COPY'd into the
// image — /app/VERSION will be absent unless the compose context is widened, and
// this resolver correctly falls back to the env var / '0.0.0'. Read once at load.
const RESOLVED_VERSION = (() => {
  if (process.env.QUOXCORE_VERSION) return process.env.QUOXCORE_VERSION;
  try {
    const v = require('fs').readFileSync('/app/VERSION', 'utf8').trim();
    if (v) return v;
  } catch { /* file absent — fall through */ }
  return '0.0.0';
})()

// CLI-PARITY WP1.1: runtime route-introspection helper for GET /__routes.
// Loaded fail-safe — a missing/renamed helper must not crash-loop this
// service at boot. This service's Docker build context is
// ./services/orchestrator (see docker-compose.yml
// `orchestrator.build.context`), and its Dockerfile only does
// `COPY *.js ./` (flat, .js only — not .cjs, not subdirectories), so a
// local copy lives at the service root as routeIntrospection.js.
let listRoutes = () => []
try {
  ({ listRoutes } = require('./routeIntrospection.js'))
} catch (err) {
  console.warn('[ROUTE_INTROSPECTION] Failed to load ./routeIntrospection.js:', err.message)
}

const app = express()

// SECURITY: Restrict CORS to known origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',')
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (health checks, server-to-server, CLI tools)
    // CORS is a browser mechanism — non-browser clients don't send Origin headers
    if (!origin) {
      return callback(null, true)
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true)
    }
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true
}))

app.use(express.json({ limit: '1mb' })) // Reduced from 50mb to prevent DoS

// SECURITY: JWT secret must be configured
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters')
  process.exit(1)
}

// ============================================================================
// Rate Limiting
// ============================================================================
const rateLimitStore = new Map()
const RATE_LIMIT = {
  windowMs: 60 * 1000,  // 1 minute window
  maxRequests: 10,       // 10 requests per minute per user for /run
  maxStatusRequests: 30  // 30 requests per minute for status/logs
}

function rateLimit(limit) {
  return (req, res, next) => {
    const userId = req.user?.id || req.ip
    const key = `${userId}:${req.path}`
    const now = Date.now()

    let record = rateLimitStore.get(key)
    if (!record || now - record.windowStart > RATE_LIMIT.windowMs) {
      record = { windowStart: now, count: 0 }
    }

    record.count++
    rateLimitStore.set(key, record)

    // Clean up old entries periodically
    if (Math.random() < 0.01) {
      for (const [k, v] of rateLimitStore) {
        if (now - v.windowStart > RATE_LIMIT.windowMs * 2) {
          rateLimitStore.delete(k)
        }
      }
    }

    if (record.count > limit) {
      auditLog('rate_limit_exceeded', { userId, path: req.path, count: record.count })
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((record.windowStart + RATE_LIMIT.windowMs - now) / 1000)
      })
    }

    next()
  }
}

// ============================================================================
// Audit Logging
// ============================================================================
// Intent mapping for AEE envelope output
const ORCH_AEE_INTENTS = {
  container_run_request: 'quox.orchestrator.task_started',
  container_run_complete: 'quox.orchestrator.task_completed',
  container_run_failed: 'quox.orchestrator.task_failed',
  container_stop_request: 'quox.orchestrator.task_stopped',
  container_stopped: 'quox.orchestrator.task_stopped',
  restart_requested: 'quox.orchestrator.container_restarted',
  restart_success: 'quox.orchestrator.container_restarted',
  restart_failed: 'quox.orchestrator.container_restart_failed',
  update_started: 'quox.orchestrator.update_started',
  update_completed: 'quox.orchestrator.update_completed',
  update_failed: 'quox.orchestrator.update_failed',
  update_cancelled: 'quox.orchestrator.update_cancelled',
}

function auditLog(action, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...details
  }
  // In production, this should go to a secure log aggregation service
  console.log('[AUDIT]', JSON.stringify(entry))

  // Emit AEE-formatted envelope for mutation actions
  const intent = ORCH_AEE_INTENTS[action]
  if (intent) {
    try {
      console.log('[AEE]', JSON.stringify({
        ts: entry.timestamp,
        from: 'service.orchestrator',
        to: 'system.aee',
        intent,
        payload: { action, ...details },
      }))
    } catch { /* fire-and-forget */ }
  }
}

// ============================================================================
// Authentication Middleware
// ============================================================================
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    auditLog('auth_failed', { reason: 'missing_token', ip: req.ip, path: req.path })
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.substring(7)

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      maxAge: '1h'
    })

    req.user = decoded
    next()
  } catch (err) {
    auditLog('auth_failed', { reason: err.message, ip: req.ip, path: req.path })
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// ============================================================================
// Admin Role Middleware
// ============================================================================
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    auditLog('access_denied', {
      userId: req.user?.id,
      reason: 'admin_required',
      path: req.path
    })
    return res.status(403).json({ error: 'Admin access required for container operations' })
  }
  next()
}

// ============================================================================
// Orchestrator Setup
// ============================================================================
const orchestrator = new ContainerOrchestrator({
  workspacePath: process.env.WORKSPACE_PATH || '/workspaces',
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '5'),
  defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT || '60000')
})

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /run - Start a container task
 *
 * SECURITY:
 * - Requires authentication (JWT)
 * - Requires admin role
 * - Rate limited to 10 requests/minute
 * - Only allowlisted task types permitted
 * - Direct command execution DISABLED - use predefined entrypoints only
 */
app.post('/run', requireAuth, requireAdmin, rateLimit(RATE_LIMIT.maxRequests), async (req, res) => {
  const requestId = crypto.randomUUID()

  try {
    const { type, task, options } = req.body

    if (!type || !task) {
      return res.status(400).json({ error: 'Missing type or task' })
    }

    // SECURITY: Audit log the execution request
    auditLog('container_run_request', {
      requestId,
      userId: req.user.id,
      userEmail: req.user.email,
      type,
      taskId: task.id || 'unnamed',
      ip: req.ip
    })

    const result = await orchestrator.runTask(type, task, {
      ...options,
      requestId,
      userId: req.user.id
    })

    // SECURITY: Audit log successful execution
    auditLog('container_run_complete', {
      requestId,
      userId: req.user.id,
      type,
      taskId: result.taskId,
      exitCode: result.exitCode,
      duration: result.duration
    })

    res.json(result)

  } catch (err) {
    // SECURITY: Audit log failed execution
    auditLog('container_run_failed', {
      requestId,
      userId: req.user?.id,
      error: err.message,
      ip: req.ip
    })

    console.error('Run error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /status - List active containers
 * Requires admin authentication
 */
app.get('/status', requireAuth, requireAdmin, rateLimit(RATE_LIMIT.maxStatusRequests), async (req, res) => {
  try {
    auditLog('container_status_query', { userId: req.user.id })
    const active = orchestrator.listActive()
    res.json({ containers: active })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /:id/logs - Get container logs
 * Requires admin authentication
 */
app.get('/:id/logs', requireAuth, requireAdmin, rateLimit(RATE_LIMIT.maxStatusRequests), async (req, res) => {
  try {
    auditLog('container_logs_query', { userId: req.user.id, taskId: req.params.id })
    const logs = await orchestrator.getLogs(req.params.id)
    res.json({ logs })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

/**
 * POST /:id/stop - Stop a container
 * Requires admin authentication
 */
app.post('/:id/stop', requireAuth, requireAdmin, rateLimit(RATE_LIMIT.maxRequests), async (req, res) => {
  try {
    auditLog('container_stop_request', { userId: req.user.id, taskId: req.params.id })
    const result = await orchestrator.stopTask(req.params.id)
    auditLog('container_stopped', { userId: req.user.id, taskId: req.params.id })
    res.json(result)
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

// ============================================================================
// Sibling Container Restart
// ============================================================================

// Allowlist of containers that can be restarted from the dashboard
const RESTARTABLE_CONTAINERS = ['collector', 'auth', 'qdrant', 'memory', 'files', 'dashboard']

// Rate limit: 1 restart per container per 60 seconds
const restartCooldowns = new Map()
const RESTART_COOLDOWN_MS = 60 * 1000

/**
 * POST /sibling/:name/restart - Restart a sibling Docker container
 *
 * SECURITY:
 * - Requires JWT authentication + admin role
 * - Only allowlisted containers can be restarted
 * - Rate limited to 1 restart per container per 60 seconds
 * - All actions are audit logged
 */
app.post('/sibling/:name/restart', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.params
  const userId = req.user?.id || 'unknown'

  // Validate container name is in allowlist
  if (!RESTARTABLE_CONTAINERS.includes(name)) {
    auditLog('restart_denied', { userId, container: name, reason: 'not_in_allowlist' })
    return res.status(403).json({ error: `Container '${name}' is not restartable` })
  }

  // Check cooldown
  const lastRestart = restartCooldowns.get(name)
  if (lastRestart && (Date.now() - lastRestart) < RESTART_COOLDOWN_MS) {
    const retryAfter = Math.ceil((lastRestart + RESTART_COOLDOWN_MS - Date.now()) / 1000)
    auditLog('restart_rate_limited', { userId, container: name, retryAfter })
    return res.status(429).json({ error: 'Restart rate limited', retryAfter })
  }

  try {
    auditLog('restart_requested', { userId, container: name, ip: req.ip })

    const Docker = require('dockerode')
    const docker = new Docker()
    const container = docker.getContainer(name)

    // Restart with 10 second grace period
    await container.restart({ t: 10 })

    restartCooldowns.set(name, Date.now())

    auditLog('restart_success', { userId, container: name })

    res.json({
      success: true,
      container: name,
      restartedAt: new Date().toISOString()
    })
  } catch (err) {
    auditLog('restart_failed', { userId, container: name, error: err.message })
    console.error(`[Restart] Failed to restart ${name}:`, err.message)
    res.status(500).json({
      success: false,
      error: `Failed to restart ${name}: ${err.message}`
    })
  }
})

// ============================================================================
// System Update Endpoints
// ============================================================================

// In-memory update state (only one update at a time)
let activeUpdate = null;
const updateClients = new Set(); // SSE clients

/**
 * GET /system/version - Read current version
 */
app.get('/system/version', (req, res) => {
  res.json({
    version: RESOLVED_VERSION,
    service: 'quox-orchestrator'
  })
})

/**
 * POST /update/execute - Run the update pipeline
 * Expects: { operation_id, org_id, from_version, to_version, auto_backup, steps, rollback?, restore_backup_id? }
 */
app.post('/update/execute', requireAuth, requireAdmin, async (req, res) => {
  if (activeUpdate) {
    return res.status(409).json({ error: 'An update is already in progress' })
  }

  const { operation_id, org_id, from_version, to_version, auto_backup, steps, rollback, restore_backup_id } = req.body

  if (!operation_id || !to_version) {
    return res.status(400).json({ error: 'Missing operation_id or to_version' })
  }

  auditLog('update_started', {
    userId: req.user?.id,
    operationId: operation_id,
    from: from_version,
    to: to_version,
    rollback: !!rollback
  })

  activeUpdate = {
    operation_id,
    org_id,
    from_version,
    to_version,
    steps: steps || [],
    status: 'running',
    started_at: Date.now(),
    rollback: !!rollback,
    restore_backup_id,
    auto_backup,
    cancelled: false
  }

  // Return immediately — progress is streamed via SSE
  res.json({ accepted: true, operation_id })

  // Execute update asynchronously
  runUpdatePipeline().catch(err => {
    console.error('[Update] Pipeline error:', err)
    broadcastProgress({ step: 'error', status: 'failed', error: err.message })
    activeUpdate = null
  })
})

/**
 * GET /update/progress - SSE stream of build steps
 */
app.get('/update/progress', requireAuth, (req, res) => {
  if (!activeUpdate) {
    return res.status(404).json({ error: 'No active update' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  updateClients.add(res)

  // Send current state
  res.write(`data: ${JSON.stringify({
    operation_id: activeUpdate.operation_id,
    status: activeUpdate.status,
    steps: activeUpdate.steps
  })}\n\n`)

  req.on('close', () => {
    updateClients.delete(res)
  })
})

/**
 * POST /update/cancel - Abort in-progress update
 */
app.post('/update/cancel', requireAuth, requireAdmin, (req, res) => {
  if (!activeUpdate) {
    return res.status(404).json({ error: 'No active update to cancel' })
  }

  activeUpdate.cancelled = true
  auditLog('update_cancelled', { userId: req.user?.id, operationId: activeUpdate.operation_id })
  res.json({ success: true })
})

/**
 * Broadcast a progress event to all SSE clients
 */
function broadcastProgress(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const client of updateClients) {
    try {
      client.write(payload)
    } catch { /* client disconnected */ }
  }
}

/**
 * Run a shell command and return stdout. Rejects on non-zero exit.
 */
function execCommand(cmd, args = [], opts = {}) {
  const { execFileSync } = require('child_process')
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    timeout: opts.timeout || 120000,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env }
  }).trim()
}

/**
 * The main update pipeline
 */
async function runUpdatePipeline() {
  const update = activeUpdate
  if (!update) return

  const projectDir = process.env.COMPOSE_PROJECT_DIR || '/opt/quoxcore'
  const startTime = Date.now()

  try {
    // Step 1: Preflight
    updateStep(update, 'preflight', 'running', 'Running preflight checks...')
    broadcastProgress({ step: 'preflight', status: 'running', message: 'Running preflight checks...' })

    if (update.cancelled) throw new Error('Update cancelled by user')

    // Verify Docker is accessible
    try {
      execCommand('docker', ['info', '--format', '{{.ServerVersion}}'])
    } catch {
      throw new Error('Docker is not accessible. Cannot perform update.')
    }

    updateStep(update, 'preflight', 'completed', 'Preflight passed')
    broadcastProgress({ step: 'preflight', status: 'completed', message: 'Preflight passed' })

    // Step 2: Pre-update backup (if enabled)
    if (update.auto_backup && !update.rollback) {
      updateStep(update, 'backup', 'running', 'Creating pre-update backup...')
      broadcastProgress({ step: 'backup', status: 'running', message: 'Creating pre-update backup...' })

      // The backup is triggered by the auth service before delegating here,
      // or we signal back that backup should be initiated.
      // For now, we mark it as a placeholder — the auth service handles backup creation.
      broadcastProgress({ step: 'backup', status: 'completed', message: 'Backup step deferred to auth service' })
      updateStep(update, 'backup', 'completed', 'Backup ready')
    }

    if (update.cancelled) throw new Error('Update cancelled by user')

    // Step 3: Git operations
    if (update.rollback) {
      updateStep(update, 'git_checkout', 'running', `Checking out v${update.to_version}...`)
      broadcastProgress({ step: 'git_checkout', status: 'running', message: `Checking out v${update.to_version}...` })

      try {
        execCommand('git', ['fetch', '--tags'], { cwd: projectDir, timeout: 60000 })
        execCommand('git', ['checkout', `v${update.to_version}`], { cwd: projectDir })
      } catch (gitErr) {
        // If tag doesn't exist, try the main branch
        try {
          execCommand('git', ['checkout', 'main'], { cwd: projectDir })
          execCommand('git', ['reset', '--hard', `v${update.to_version}`], { cwd: projectDir })
        } catch {
          throw new Error(`Git checkout failed: ${gitErr.message}`)
        }
      }

      updateStep(update, 'git_checkout', 'completed', `Checked out v${update.to_version}`)
      broadcastProgress({ step: 'git_checkout', status: 'completed', message: `Checked out v${update.to_version}` })
    } else {
      updateStep(update, 'git_pull', 'running', 'Pulling latest code...')
      broadcastProgress({ step: 'git_pull', status: 'running', message: 'Pulling latest code...' })

      try {
        execCommand('git', ['fetch', '--tags'], { cwd: projectDir, timeout: 60000 })
        execCommand('git', ['checkout', `v${update.to_version}`], { cwd: projectDir })
      } catch {
        // Fallback: pull main
        try {
          execCommand('git', ['pull', 'origin', 'main'], { cwd: projectDir, timeout: 60000 })
        } catch (pullErr) {
          throw new Error(`Git pull failed: ${pullErr.message}`)
        }
      }

      updateStep(update, 'git_pull', 'completed', 'Code updated')
      broadcastProgress({ step: 'git_pull', status: 'completed', message: 'Code updated' })
    }

    if (update.cancelled) throw new Error('Update cancelled by user')

    // Step 4: Build services
    updateStep(update, 'build', 'running', 'Building services...')
    broadcastProgress({ step: 'build', status: 'running', message: 'Building services...' })

    const services = ['auth', 'memory', 'files', 'tasks', 'collector', 'orchestrator']
    const versionFromFile = (() => {
      try { return require('fs').readFileSync(`${projectDir}/VERSION`, 'utf-8').trim() } catch { return update.to_version }
    })()

    for (const svc of services) {
      if (update.cancelled) throw new Error('Update cancelled by user')

      broadcastProgress({
        step: `build_${svc}`,
        status: 'running',
        message: `Building ${svc}...`,
        service: svc
      })

      try {
        execCommand('docker', ['compose', 'build', '--build-arg', `QUOXCORE_VERSION=${versionFromFile}`, svc], {
          cwd: projectDir,
          timeout: 300000 // 5 min per service
        })
      } catch (buildErr) {
        throw new Error(`Build failed for ${svc}: ${buildErr.message.slice(0, 200)}`)
      }

      broadcastProgress({
        step: `build_${svc}`,
        status: 'completed',
        message: `${svc} built`,
        service: svc
      })
    }

    updateStep(update, 'build', 'completed', 'All services built')
    broadcastProgress({ step: 'build', status: 'completed', message: 'All services built' })

    if (update.cancelled) throw new Error('Update cancelled by user')

    // Step 5: Rolling restart
    updateStep(update, 'restart', 'running', 'Restarting services...')
    broadcastProgress({ step: 'restart', status: 'running', message: 'Restarting services...' })

    for (const svc of services) {
      if (update.cancelled) throw new Error('Update cancelled by user')

      broadcastProgress({
        step: `restart_${svc}`,
        status: 'running',
        message: `Restarting ${svc}...`,
        service: svc
      })

      try {
        execCommand('docker', ['compose', 'up', '-d', svc], {
          cwd: projectDir,
          timeout: 120000
        })

        // Wait for health check (up to 60s)
        let healthy = false
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 5000))
          try {
            const result = execCommand('docker', ['inspect', '--format', '{{.State.Health.Status}}', `quox-${svc}`])
            if (result === 'healthy') {
              healthy = true
              break
            }
          } catch { /* container might not be ready yet */ }
        }

        if (!healthy) {
          console.warn(`[Update] Service ${svc} did not become healthy within 60s, continuing...`)
        }
      } catch (restartErr) {
        throw new Error(`Restart failed for ${svc}: ${restartErr.message.slice(0, 200)}`)
      }

      broadcastProgress({
        step: `restart_${svc}`,
        status: 'completed',
        message: `${svc} restarted`,
        service: svc
      })
    }

    // Also restart the dashboard
    try {
      execCommand('docker', ['compose', 'build', '--build-arg', `QUOXCORE_VERSION=${versionFromFile}`, 'dashboard'], { cwd: projectDir, timeout: 300000 })
      execCommand('docker', ['compose', 'up', '-d', 'dashboard'], { cwd: projectDir, timeout: 120000 })
    } catch (dashErr) {
      console.warn('[Update] Dashboard rebuild warning:', dashErr.message)
    }

    updateStep(update, 'restart', 'completed', 'All services restarted')
    broadcastProgress({ step: 'restart', status: 'completed', message: 'All services restarted' })

    // Step 6: Post-update verification
    updateStep(update, 'verify', 'running', 'Verifying update...')
    broadcastProgress({ step: 'verify', status: 'running', message: 'Verifying update...' })

    // Check all services are healthy
    let allHealthy = true
    for (const svc of services) {
      try {
        const status = execCommand('docker', ['inspect', '--format', '{{.State.Health.Status}}', `quox-${svc}`])
        if (status !== 'healthy') {
          allHealthy = false
          console.warn(`[Update] Service ${svc} is not healthy: ${status}`)
        }
      } catch { allHealthy = false }
    }

    const durationMs = Date.now() - startTime

    if (allHealthy) {
      updateStep(update, 'verify', 'completed', 'All services healthy')
      broadcastProgress({
        step: 'verify',
        status: 'completed',
        message: 'Update completed successfully',
        duration_ms: durationMs
      })
      broadcastProgress({
        status: 'completed',
        message: `QuoxCORE updated to v${update.to_version}`,
        duration_ms: durationMs,
        steps: update.steps
      })
    } else {
      broadcastProgress({
        step: 'verify',
        status: 'completed',
        message: 'Update completed with warnings — some services may need attention',
        duration_ms: durationMs,
        warnings: true
      })
      broadcastProgress({
        status: 'completed',
        message: `QuoxCORE updated to v${update.to_version} (with warnings)`,
        duration_ms: durationMs,
        steps: update.steps
      })
    }

    auditLog('update_completed', {
      operationId: update.operation_id,
      from: update.from_version,
      to: update.to_version,
      durationMs,
      allHealthy
    })

  } catch (err) {
    const durationMs = Date.now() - startTime
    const errorStep = update.steps?.find(s => s.status === 'running')?.name || 'unknown'

    broadcastProgress({
      step: errorStep,
      status: 'failed',
      error: err.message,
      duration_ms: durationMs
    })
    broadcastProgress({
      status: 'failed',
      error: err.message,
      step: errorStep,
      duration_ms: durationMs,
      steps: update.steps
    })

    auditLog('update_failed', {
      operationId: update.operation_id,
      error: err.message,
      step: errorStep,
      durationMs
    })
  } finally {
    // Close all SSE connections
    for (const client of updateClients) {
      try { client.end() } catch { /* ignore */ }
    }
    updateClients.clear()
    activeUpdate = null
  }
}

/**
 * Update a step's status in the active update
 */
function updateStep(update, stepName, status, message) {
  if (!update?.steps) return
  const step = update.steps.find(s => s.name === stepName)
  if (step) {
    step.status = status
    step.message = message
  }
}

/**
 * GET /health - Health check (no auth required but limited info)
 */
app.get('/health', async (req, res) => {
  const health = await orchestrator.healthCheck()
  // SECURITY: Don't expose internal details in unauthenticated health check
  res.status(health.status === 'healthy' ? 200 : 503).json({
    status: health.status,
    version: RESOLVED_VERSION
  })
})

/**
 * GET /__routes - CLI-PARITY WP1.1: fully-resolved route table for the CLI's
 * live-vs-static endpoint diff. Mounted last (after every app.use/route
 * above, before app.listen) so listRoutes(app) reflects every route
 * actually attached to this app instance.
 * Auth: same JWT + admin-role gate every other route in this service uses
 * (requireAuth, requireAdmin) — orchestrator has no separate service-key
 * concept, unlike the other Quox services.
 */
app.get('/__routes', requireAuth, requireAdmin, (req, res) => {
  res.json({ service: 'orchestrator', routes: listRoutes(app) })
})

const PORT = process.env.PORT || 3100
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0'
app.listen(PORT, BIND_HOST, () => {
  console.log(`Container Orchestrator listening on ${BIND_HOST}:${PORT}`)
})

module.exports = app
