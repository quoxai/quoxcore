/**
 * Container Orchestrator for QuoxCORE Agentic Tools
 *
 * SECURITY NOTICE:
 * This module manages Docker containers for isolated execution.
 * Direct command execution has been DISABLED to prevent arbitrary code execution.
 * Only predefined, allowlisted entrypoints can be used.
 *
 * Manages Docker containers for isolated execution of:
 * - Code runners (sandboxed script execution via predefined entrypoints)
 * - AI agents (Gemini, Codex, etc. via predefined entrypoints)
 * - Research tasks (web scraping via predefined entrypoints)
 */

const Docker = require('dockerode')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs').promises

const docker = new Docker()

// SECURITY: Strict allowlist of permitted task types and their fixed entrypoints
// Direct command execution is NOT allowed - only predefined entrypoints
const CONTAINER_TYPES = {
  'code-runner': {
    image: 'quox/code-runner:latest',
    // SECURITY: Fixed entrypoint - no arbitrary commands
    entrypoint: ['/usr/local/bin/run-code.sh'],
    // SECURITY: Allowed script types (validated against file extensions)
    allowedScriptTypes: ['python', 'javascript', 'bash'],
    defaultLimits: {
      Memory: 512 * 1024 * 1024, // 512MB
      NanoCpus: 500000000,       // 0.5 CPU
      PidsLimit: 100
    },
    networkMode: 'none',
    readonlyRootfs: true,
    workDir: '/workspace',
    // SECURITY: Drop all capabilities
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true']
  },
  'ai-agent': {
    image: 'quox/ai-agent:latest',
    // SECURITY: Fixed entrypoint for AI agent tasks
    entrypoint: ['/agent/entrypoint.py'],
    // SECURITY: Allowed AI providers
    allowedProviders: ['gemini', 'claude', 'openai'],
    defaultLimits: {
      Memory: 1024 * 1024 * 1024, // 1GB
      NanoCpus: 1000000000,       // 1 CPU
      PidsLimit: 50
    },
    networkMode: 'quox_ai_network',
    readonlyRootfs: false,
    workDir: '/agent',
    capDrop: ['ALL'],
    capAdd: ['NET_RAW'], // Required for HTTP clients
    securityOpt: ['no-new-privileges:true']
  },
  'researcher': {
    image: 'quox/researcher:latest',
    // SECURITY: Fixed entrypoint for research tasks
    entrypoint: ['/research/research.py'],
    // SECURITY: Allowed research task types
    allowedTaskTypes: ['web-search', 'document-analysis', 'data-extraction'],
    defaultLimits: {
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 1000000000,
      PidsLimit: 100
    },
    // SECURITY: Use isolated network instead of bridge
    networkMode: 'quox_research_network',
    readonlyRootfs: false,
    workDir: '/research',
    capDrop: ['ALL'],
    capAdd: ['NET_RAW'],
    securityOpt: ['no-new-privileges:true']
  }
}

// SECURITY: Filename validation - prevent path traversal and dangerous files
const ALLOWED_FILE_EXTENSIONS = ['.py', '.js', '.json', '.txt', '.md', '.yaml', '.yml', '.csv']
const MAX_FILE_SIZE = 1024 * 1024 // 1MB per file
const MAX_TOTAL_FILES = 10

// SECURITY: Allowlist of permitted base directories for file operations
const ALLOWED_BASE_DIRECTORIES = ['/workspaces', '/tmp/quox-workspaces']

/**
 * SECURITY: Validate that a path is within an allowed directory
 * Prevents path traversal attacks by:
 * 1. Normalizing the path to resolve . and .. components
 * 2. Resolving to absolute path
 * 3. Verifying the resolved path starts with an allowed directory
 * 4. Rejecting paths that contain path traversal sequences
 *
 * @param {string} targetPath - The path to validate
 * @param {string} allowedBaseDir - The base directory that the path must be within
 * @returns {string} The validated, normalized absolute path
 * @throws {Error} If the path is outside the allowed directory or contains traversal sequences
 */
function validatePath(targetPath, allowedBaseDir) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Invalid path: path must be a non-empty string')
  }

  if (!allowedBaseDir || typeof allowedBaseDir !== 'string') {
    throw new Error('Invalid base directory: must be a non-empty string')
  }

  // SECURITY: Reject null bytes which can truncate paths in some systems
  if (targetPath.includes('\0') || allowedBaseDir.includes('\0')) {
    throw new Error('Invalid path: null bytes not allowed')
  }

  // SECURITY: Reject paths containing path traversal sequences before normalization
  // This catches encoded variants and obvious traversal attempts early
  if (targetPath.includes('..')) {
    throw new Error('Invalid path: path traversal sequences not allowed')
  }

  // Normalize the base directory first
  const normalizedBase = path.resolve(path.normalize(allowedBaseDir))

  // SECURITY: Verify the base directory is in our allowlist
  const baseIsAllowed = ALLOWED_BASE_DIRECTORIES.some(allowed =>
    normalizedBase === path.resolve(allowed) ||
    normalizedBase.startsWith(path.resolve(allowed) + path.sep)
  )
  if (!baseIsAllowed) {
    throw new Error(`Invalid base directory: ${allowedBaseDir} is not in the allowed directories list`)
  }

  // Normalize and resolve the target path relative to the base
  const normalizedTarget = path.normalize(targetPath)
  const resolvedPath = path.resolve(normalizedBase, normalizedTarget)

  // SECURITY: Final check - ensure resolved path is within the allowed base
  // Use startsWith with path separator to prevent /workspaces-evil from matching /workspaces
  if (resolvedPath !== normalizedBase && !resolvedPath.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${targetPath} resolves outside allowed directory`)
  }

  return resolvedPath
}

/**
 * SECURITY: Validate a file path for safe file operations
 * Combines filename validation with path containment check
 *
 * @param {string} filename - The filename to validate
 * @param {string} baseDir - The base directory the file should be within
 * @returns {string} The validated absolute file path
 * @throws {Error} If validation fails
 */
function validateFilePath(filename, baseDir) {
  // First validate the filename itself
  if (!validateFilename(filename)) {
    throw new Error(`Invalid filename: ${filename}`)
  }

  // Then validate the full path is within bounds
  return validatePath(filename, baseDir)
}

function validateFilename(filename) {
  // SECURITY: Ensure filename is a string
  if (!filename || typeof filename !== 'string') {
    return false
  }
  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return false
  }
  // Check for dangerous patterns
  if (filename.startsWith('.') || filename.includes('\0')) {
    return false
  }
  // Validate extension
  const ext = path.extname(filename).toLowerCase()
  if (!ALLOWED_FILE_EXTENSIONS.includes(ext)) {
    return false
  }
  // Validate filename length
  if (filename.length > 100) {
    return false
  }
  return true
}

// Active containers map
const activeContainers = new Map()

// SECURITY: Audit logging helper
function auditLog(action, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...details
  }
  console.log('[ORCHESTRATOR_AUDIT]', JSON.stringify(entry))
}

class ContainerOrchestrator {
  constructor(config = {}) {
    const requestedWorkspace = config.workspacePath || '/workspaces'

    // SECURITY: Validate workspace path is in allowed directories
    const normalizedWorkspace = path.resolve(path.normalize(requestedWorkspace))
    const workspaceIsAllowed = ALLOWED_BASE_DIRECTORIES.some(allowed =>
      normalizedWorkspace === path.resolve(allowed) ||
      normalizedWorkspace.startsWith(path.resolve(allowed) + path.sep)
    )
    if (!workspaceIsAllowed) {
      throw new Error(`Invalid workspace path: ${requestedWorkspace} is not in allowed directories`)
    }

    this.workspacePath = normalizedWorkspace
    this.maxConcurrent = config.maxConcurrent || 5
    this.defaultTimeout = config.defaultTimeout || 60000
  }

  /**
   * Validate and sanitize task before execution
   * SECURITY: Prevents arbitrary code execution
   */
  validateTask(taskType, task, config) {
    // Validate task type specific requirements
    if (taskType === 'code-runner') {
      if (!task.scriptType || !config.allowedScriptTypes.includes(task.scriptType)) {
        throw new Error(`Invalid script type. Allowed: ${config.allowedScriptTypes.join(', ')}`)
      }
    }

    if (taskType === 'ai-agent') {
      if (!task.provider || !config.allowedProviders.includes(task.provider)) {
        throw new Error(`Invalid AI provider. Allowed: ${config.allowedProviders.join(', ')}`)
      }
    }

    if (taskType === 'researcher') {
      if (!task.researchType || !config.allowedTaskTypes.includes(task.researchType)) {
        throw new Error(`Invalid research type. Allowed: ${config.allowedTaskTypes.join(', ')}`)
      }
    }

    // SECURITY: Validate files
    if (task.files) {
      if (task.files.length > MAX_TOTAL_FILES) {
        throw new Error(`Too many files. Maximum: ${MAX_TOTAL_FILES}`)
      }

      for (const file of task.files) {
        if (!validateFilename(file.name)) {
          throw new Error(`Invalid filename: ${file.name}`)
        }
        if (file.content && file.content.length > MAX_FILE_SIZE) {
          throw new Error(`File too large: ${file.name}. Maximum: ${MAX_FILE_SIZE} bytes`)
        }
      }
    }

    // SECURITY: Reject any attempt to pass arbitrary commands
    if (task.command) {
      throw new Error('Direct command execution is not allowed. Use predefined task types.')
    }

    return true
  }

  /**
   * Build safe environment variables
   * SECURITY: Only allows specific env vars, sanitizes values
   */
  buildSafeEnv(taskType, task, config) {
    const safeEnv = []

    // Task type specific allowed env vars
    const allowedEnvVars = {
      'code-runner': ['SCRIPT_TYPE', 'TIMEOUT'],
      'ai-agent': ['PROVIDER', 'MODEL', 'MAX_TOKENS'],
      'researcher': ['RESEARCH_TYPE', 'MAX_RESULTS']
    }

    const allowed = allowedEnvVars[taskType] || []

    // Add standard env vars
    safeEnv.push(`TASK_TYPE=${taskType}`)

    if (task.scriptType) safeEnv.push(`SCRIPT_TYPE=${task.scriptType}`)
    if (task.provider) safeEnv.push(`PROVIDER=${task.provider}`)
    if (task.researchType) safeEnv.push(`RESEARCH_TYPE=${task.researchType}`)

    // Filter and sanitize user-provided env vars
    if (task.env) {
      for (const [key, value] of Object.entries(task.env)) {
        // Only allow specific env vars
        if (!allowed.includes(key)) continue
        // Sanitize value - no newlines, no shell metacharacters
        const sanitizedValue = String(value)
          .replace(/[\n\r]/g, '')
          .replace(/[;&|`$(){}[\]<>]/g, '')
          .substring(0, 1000) // Max length
        safeEnv.push(`${key}=${sanitizedValue}`)
      }
    }

    return safeEnv
  }

  /**
   * Run a task in an isolated container
   * SECURITY: Uses fixed entrypoints, no arbitrary command execution
   */
  async runTask(taskType, task, options = {}) {
    const taskId = uuidv4()
    const config = CONTAINER_TYPES[taskType]

    if (!config) {
      throw new Error(`Unknown task type: ${taskType}`)
    }

    // SECURITY: Validate task before execution
    this.validateTask(taskType, task, config)

    auditLog('task_validated', {
      taskId,
      taskType,
      userId: options.userId,
      requestId: options.requestId
    })

    if (activeContainers.size >= this.maxConcurrent) {
      throw new Error('Maximum concurrent containers reached')
    }

    // SECURITY: Validate workspace directory path is within allowed boundaries
    // taskId is a UUID so it shouldn't contain traversal sequences, but validate anyway
    const workspaceDir = validatePath(taskId, this.workspacePath)
    await fs.mkdir(workspaceDir, { recursive: true })

    // SECURITY: Write validated input files only with path validation
    if (task.files) {
      for (const file of task.files) {
        // SECURITY: Validate both filename and full path to prevent traversal
        const filePath = validateFilePath(file.name, workspaceDir)
        await fs.writeFile(filePath, file.content)
      }
    }

    // Write task configuration as JSON (read by entrypoint)
    const taskConfig = {
      type: taskType,
      scriptType: task.scriptType,
      provider: task.provider,
      researchType: task.researchType,
      inputFiles: task.files?.map(f => f.name) || [],
      options: {
        model: task.model,
        maxTokens: task.maxTokens,
        maxResults: task.maxResults
      }
    }
    // SECURITY: Validate task.json path even though it's a fixed filename
    const taskJsonPath = validatePath('task.json', workspaceDir)
    await fs.writeFile(
      taskJsonPath,
      JSON.stringify(taskConfig, null, 2)
    )

    const timeout = Math.min(options.timeout || this.defaultTimeout, 300000) // Max 5 minutes
    const limits = { ...config.defaultLimits } // Don't allow overriding limits

    // SECURITY: Create container with fixed entrypoint, no arbitrary commands
    const container = await docker.createContainer({
      Image: config.image,
      // SECURITY: Use fixed entrypoint from config, NOT from user input
      Entrypoint: config.entrypoint,
      Cmd: [], // No additional commands
      WorkingDir: config.workDir,
      Env: this.buildSafeEnv(taskType, task, config),
      HostConfig: {
        Binds: [`${workspaceDir}:${config.workDir}:rw`],
        Memory: limits.Memory,
        NanoCpus: limits.NanoCpus,
        PidsLimit: limits.PidsLimit,
        NetworkMode: config.networkMode,
        ReadonlyRootfs: config.readonlyRootfs,
        AutoRemove: true,
        // SECURITY: Drop all capabilities, add back only what's needed
        CapDrop: config.capDrop || ['ALL'],
        CapAdd: config.capAdd || [],
        SecurityOpt: config.securityOpt || ['no-new-privileges:true'],
        // SECURITY: Prevent privilege escalation
        Privileged: false
      },
      User: 'nobody',
      Labels: {
        'quox.task_id': taskId,
        'quox.task_type': taskType,
        'quox.user_id': options.userId || 'unknown',
        'quox.request_id': options.requestId || 'unknown'
      }
    })

    const containerRecord = {
      id: container.id,
      taskId,
      taskType,
      workspaceDir,
      startTime: Date.now(),
      status: 'running'
    }

    activeContainers.set(taskId, containerRecord)

    // Start container with timeout
    try {
      await container.start()

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Container timeout')), timeout)
      })

      const waitPromise = container.wait()

      const result = await Promise.race([waitPromise, timeoutPromise])

      containerRecord.status = 'completed'
      containerRecord.exitCode = result.StatusCode

      // Collect output
      const output = await this.collectOutput(workspaceDir, task.outputFiles)

      return {
        taskId,
        status: 'completed',
        exitCode: result.StatusCode,
        output,
        duration: Date.now() - containerRecord.startTime
      }

    } catch (err) {
      containerRecord.status = 'failed'
      containerRecord.error = err.message

      // Try to kill container if timeout
      try {
        await container.kill()
      } catch (killErr) {
        // Container may already be stopped
      }

      throw err

    } finally {
      activeContainers.delete(taskId)
      // Cleanup workspace after delay
      setTimeout(() => this.cleanupWorkspace(workspaceDir), 5000)
    }
  }

  /**
   * Get logs from a running container
   * SECURITY: Only returns logs for containers that exist in our tracking
   */
  async getLogs(taskId) {
    // SECURITY: Validate taskId format (UUID)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
      throw new Error('Invalid task ID format')
    }

    const record = activeContainers.get(taskId)
    if (!record) {
      throw new Error(`Container not found: ${taskId}`)
    }

    const container = docker.getContainer(record.id)
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: 1000 // SECURITY: Limit log size
    })

    auditLog('logs_retrieved', { taskId, taskType: record.taskType })

    return logs.toString().substring(0, 100000) // SECURITY: Max 100KB logs
  }

  /**
   * Stop a running container
   * SECURITY: Only stops containers that exist in our tracking
   */
  async stopTask(taskId) {
    // SECURITY: Validate taskId format (UUID)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
      throw new Error('Invalid task ID format')
    }

    const record = activeContainers.get(taskId)
    if (!record) {
      throw new Error(`Container not found: ${taskId}`)
    }

    auditLog('task_stop_initiated', { taskId, taskType: record.taskType })

    const container = docker.getContainer(record.id)
    await container.kill()

    record.status = 'stopped'
    activeContainers.delete(taskId)

    auditLog('task_stopped', { taskId, taskType: record.taskType })

    return { taskId, status: 'stopped' }
  }

  /**
   * List active containers
   * SECURITY: Only returns safe metadata, no sensitive information
   */
  listActive() {
    return Array.from(activeContainers.values()).map(c => ({
      taskId: c.taskId,
      taskType: c.taskType,
      status: c.status,
      duration: Date.now() - c.startTime
      // SECURITY: Do not expose container ID, workspace path, or user ID
    }))
  }

  // NOTE: buildEnv is replaced by buildSafeEnv above

  /**
   * Collect output files from workspace
   * SECURITY: Validates all file paths to prevent path traversal
   */
  async collectOutput(workspaceDir, outputFiles = ['*']) {
    const results = []

    // SECURITY: Validate workspace directory is within allowed boundaries
    const validatedWorkspaceDir = validatePath(workspaceDir, this.workspacePath)

    const files = await fs.readdir(validatedWorkspaceDir)

    for (const file of files) {
      // SECURITY: Skip files with suspicious names (path traversal attempts)
      if (file.includes('..') || file.includes('/') || file.includes('\\') || file.includes('\0')) {
        auditLog('suspicious_output_file_skipped', { workspaceDir: validatedWorkspaceDir, filename: file })
        continue
      }

      // SECURITY: Validate the full file path is within workspace bounds
      let filePath
      try {
        filePath = validatePath(file, validatedWorkspaceDir)
      } catch (err) {
        auditLog('output_file_path_validation_failed', {
          workspaceDir: validatedWorkspaceDir,
          filename: file,
          error: err.message
        })
        continue
      }

      try {
        // SECURITY: Use lstat to detect symlinks (stat follows symlinks, lstat doesn't)
        const stat = await fs.lstat(filePath)

        // SECURITY: Only read regular files, not symlinks or directories
        // Symlinks could point outside the workspace directory
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 10 * 1024 * 1024) { // Max 10MB per file
          const content = await fs.readFile(filePath)
          results.push({
            name: file,
            size: stat.size,
            content: content.toString('base64')
          })
        } else if (stat.isSymbolicLink()) {
          auditLog('symlink_skipped', { workspaceDir: validatedWorkspaceDir, filename: file })
        }
      } catch (readErr) {
        // File may have been deleted or is inaccessible
        auditLog('output_file_read_failed', {
          workspaceDir: validatedWorkspaceDir,
          filename: file,
          error: readErr.message
        })
      }
    }

    return results
  }

  /**
   * Cleanup workspace directory
   * SECURITY: Validates path to prevent deletion of files outside workspace
   */
  async cleanupWorkspace(workspaceDir) {
    try {
      // SECURITY: Validate workspace directory is within allowed boundaries
      // This prevents an attacker from causing deletion of arbitrary directories
      const validatedWorkspaceDir = validatePath(workspaceDir, this.workspacePath)

      // SECURITY: Additional safety check - ensure we're deleting a UUID-named directory
      const dirName = path.basename(validatedWorkspaceDir)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dirName)) {
        throw new Error(`Invalid workspace directory name: ${dirName}`)
      }

      await fs.rm(validatedWorkspaceDir, { recursive: true, force: true })
      auditLog('workspace_cleaned', { workspaceDir: validatedWorkspaceDir })
    } catch (err) {
      auditLog('workspace_cleanup_failed', { workspaceDir, error: err.message })
      console.error(`Failed to cleanup workspace: ${err.message}`)
    }
  }

  /**
   * Health check - verify Docker connection
   */
  async healthCheck() {
    try {
      await docker.ping()
      return {
        status: 'healthy',
        activeContainers: activeContainers.size,
        maxConcurrent: this.maxConcurrent
      }
    } catch (err) {
      return {
        status: 'unhealthy',
        error: err.message
      }
    }
  }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let isShuttingDown = false

async function gracefulShutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n[ORCHESTRATOR] ${signal} received. Starting graceful shutdown...`)

  // Kill all active containers
  const containerIds = Array.from(activeContainers.keys())
  console.log(`[ORCHESTRATOR] Stopping ${containerIds.length} active containers...`)

  for (const taskId of containerIds) {
    try {
      const record = activeContainers.get(taskId)
      if (record) {
        const container = docker.getContainer(record.id)
        await container.kill()
        console.log(`[ORCHESTRATOR] Stopped container: ${taskId}`)
      }
    } catch (err) {
      // Container may already be stopped
      console.log(`[ORCHESTRATOR] Container ${taskId} already stopped or error: ${err.message}`)
    }
  }

  activeContainers.clear()
  console.log('[ORCHESTRATOR] Graceful shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

module.exports = {
  ContainerOrchestrator,
  CONTAINER_TYPES,
  // SECURITY: Export validation functions for testing and reuse
  validatePath,
  validateFilePath,
  validateFilename,
  ALLOWED_BASE_DIRECTORIES
}
