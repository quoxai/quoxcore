/**
 * Quox Runbook Compiler
 *
 * Compiles and executes parameterized runbooks with safety gates.
 * Part of Wave 3 Memory Overhaul - "giggly-seeking-beacon"
 */

import { getMemoryManager } from './memoryManager.js'

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Supported action types in runbooks
 */
export const ACTION_TYPES = {
  SSH_COMMAND: 'ssh_command',
  API_CALL: 'api_call',
  WAIT: 'wait',
  CONDITION: 'condition',
  LOG: 'log',
  NOTIFY: 'notify',
  SET_VARIABLE: 'set_variable',
  PARALLEL: 'parallel',
  LOOP: 'loop'
}

/**
 * Parameter types for validation
 */
export const PARAM_TYPES = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  HOST: 'host',
  SERVICE: 'service',
  PATH: 'path',
  IP: 'ip',
  PORT: 'port',
  ENUM: 'enum',
  ARRAY: 'array'
}

/**
 * Safety levels for runbooks
 */
export const SAFETY_LEVELS = {
  GREEN: { level: 0, label: 'Safe', requiresApproval: false, description: 'Read-only operations' },
  BLUE: { level: 1, label: 'Low Risk', requiresApproval: false, description: 'Minor changes, easily reversible' },
  AMBER: { level: 2, label: 'Caution', requiresApproval: true, description: 'Service restarts, config changes' },
  RED: { level: 3, label: 'Critical', requiresApproval: true, description: 'Data deletion, production changes' }
}

// ============================================================================
// RUNBOOK SCHEMA
// ============================================================================

/**
 * Create a new runbook definition
 */
export function createRunbook(definition) {
  return {
    id: definition.id || `runbook_${Date.now()}`,
    name: definition.name,
    description: definition.description || '',
    intent: definition.intent || null,
    version: definition.version || '1.0.0',
    author: definition.author || 'unknown',
    createdAt: new Date().toISOString(),

    // Parameters
    parameters: (definition.parameters || []).map(p => ({
      name: p.name,
      type: p.type || 'string',
      required: p.required !== false,
      default: p.default,
      description: p.description || '',
      validation: p.validation || null,
      options: p.options || null  // For enum types
    })),

    // Preconditions (must pass before execution)
    preconditions: definition.preconditions || [],

    // Execution steps
    steps: definition.steps || [],

    // Postconditions (verify after execution)
    postconditions: definition.postconditions || [],

    // Rollback procedure
    rollback: definition.rollback || [],

    // Safety configuration
    safety: {
      level: definition.safety?.level || 'AMBER',
      requiresApproval: definition.safety?.requiresApproval ?? true,
      blastRadius: definition.safety?.blastRadius || [],
      timeout: definition.safety?.timeout || 300,  // seconds
      dryRunSupported: definition.safety?.dryRunSupported !== false
    },

    // Metadata
    tags: definition.tags || [],
    category: definition.category || 'general'
  }
}

// ============================================================================
// RUNBOOK COMPILER
// ============================================================================

/**
 * Compile a runbook with parameters into an execution plan
 */
export function compileRunbook(runbook, params = {}) {
  // Validate parameters
  const paramErrors = validateParameters(runbook.parameters, params)
  if (paramErrors.length > 0) {
    return {
      success: false,
      errors: paramErrors,
      plan: null
    }
  }

  // Fill in defaults
  const resolvedParams = resolveParameters(runbook.parameters, params)

  // Compile steps with parameter substitution
  const compiledSteps = runbook.steps.map((step, index) =>
    compileStep(step, resolvedParams, index)
  )

  // Compile preconditions
  const compiledPreconditions = runbook.preconditions.map(pc =>
    compileCondition(pc, resolvedParams)
  )

  // Compile postconditions
  const compiledPostconditions = runbook.postconditions.map(pc =>
    compileCondition(pc, resolvedParams)
  )

  // Compile rollback
  const compiledRollback = runbook.rollback.map((step, index) =>
    compileStep(step, resolvedParams, index)
  )

  // Calculate blast radius
  const blastRadius = calculateBlastRadius(runbook, resolvedParams)

  return {
    success: true,
    errors: [],
    plan: {
      runbookId: runbook.id,
      runbookName: runbook.name,
      version: runbook.version,
      compiledAt: new Date().toISOString(),
      parameters: resolvedParams,
      preconditions: compiledPreconditions,
      steps: compiledSteps,
      postconditions: compiledPostconditions,
      rollback: compiledRollback,
      safety: {
        ...runbook.safety,
        blastRadius
      },
      estimatedDuration: estimateDuration(compiledSteps)
    }
  }
}

/**
 * Validate parameters against schema
 */
export function validateParameters(schema, params) {
  const errors = []

  for (const param of schema) {
    const value = params[param.name]

    // Check required
    if (param.required && (value === undefined || value === null || value === '')) {
      errors.push({
        param: param.name,
        error: 'required',
        message: `Parameter '${param.name}' is required`
      })
      continue
    }

    // Skip validation if not provided and not required
    if (value === undefined || value === null) continue

    // Type validation
    const typeError = validateType(param, value)
    if (typeError) {
      errors.push(typeError)
      continue
    }

    // Custom validation
    if (param.validation) {
      const customError = runCustomValidation(param, value)
      if (customError) {
        errors.push(customError)
      }
    }
  }

  return errors
}

/**
 * Validate parameter type
 */
function validateType(param, value) {
  switch (param.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { param: param.name, error: 'type', message: `Expected string, got ${typeof value}` }
      }
      break

    case 'number':
      if (typeof value !== 'number' || isNaN(value)) {
        return { param: param.name, error: 'type', message: `Expected number, got ${typeof value}` }
      }
      break

    case 'boolean':
      if (typeof value !== 'boolean') {
        return { param: param.name, error: 'type', message: `Expected boolean, got ${typeof value}` }
      }
      break

    case 'host':
      if (typeof value !== 'string' || !/^[a-z0-9][\w.-]*$/i.test(value)) {
        return { param: param.name, error: 'type', message: 'Invalid hostname format' }
      }
      break

    case 'ip':
      if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
        return { param: param.name, error: 'type', message: 'Invalid IP address format' }
      }
      break

    case 'port':
      const port = parseInt(value)
      if (isNaN(port) || port < 1 || port > 65535) {
        return { param: param.name, error: 'type', message: 'Invalid port number (1-65535)' }
      }
      break

    case 'path':
      if (typeof value !== 'string' || !/^[/~]/.test(value)) {
        return { param: param.name, error: 'type', message: 'Invalid path format' }
      }
      break

    case 'enum':
      if (!param.options || !param.options.includes(value)) {
        return { param: param.name, error: 'type', message: `Value must be one of: ${param.options?.join(', ')}` }
      }
      break

    case 'array':
      if (!Array.isArray(value)) {
        return { param: param.name, error: 'type', message: 'Expected array' }
      }
      break
  }

  return null
}

/**
 * Run custom validation rule
 */
function runCustomValidation(param, value) {
  const { validation } = param

  if (validation.pattern) {
    const regex = new RegExp(validation.pattern)
    if (!regex.test(value)) {
      return {
        param: param.name,
        error: 'validation',
        message: validation.message || `Value doesn't match pattern: ${validation.pattern}`
      }
    }
  }

  if (validation.min !== undefined && value < validation.min) {
    return {
      param: param.name,
      error: 'validation',
      message: `Value must be >= ${validation.min}`
    }
  }

  if (validation.max !== undefined && value > validation.max) {
    return {
      param: param.name,
      error: 'validation',
      message: `Value must be <= ${validation.max}`
    }
  }

  if (validation.minLength !== undefined && value.length < validation.minLength) {
    return {
      param: param.name,
      error: 'validation',
      message: `Value must be at least ${validation.minLength} characters`
    }
  }

  if (validation.maxLength !== undefined && value.length > validation.maxLength) {
    return {
      param: param.name,
      error: 'validation',
      message: `Value must be at most ${validation.maxLength} characters`
    }
  }

  return null
}

/**
 * Resolve parameters with defaults
 */
function resolveParameters(schema, params) {
  const resolved = {}

  for (const param of schema) {
    if (params[param.name] !== undefined) {
      resolved[param.name] = params[param.name]
    } else if (param.default !== undefined) {
      resolved[param.name] = param.default
    }
  }

  return resolved
}

/**
 * Compile a step with parameter substitution
 */
function compileStep(step, params, index) {
  const compiled = {
    index,
    action: step.action,
    name: step.name || `Step ${index + 1}`,
    compiled: {}
  }

  // Substitute parameters in all string fields
  for (const [key, value] of Object.entries(step)) {
    if (key === 'action' || key === 'name') continue

    if (typeof value === 'string') {
      compiled.compiled[key] = substituteParams(value, params)
    } else if (typeof value === 'object' && value !== null) {
      compiled.compiled[key] = JSON.parse(
        substituteParams(JSON.stringify(value), params)
      )
    } else {
      compiled.compiled[key] = value
    }
  }

  // Copy control flow
  if (step.onSuccess) compiled.onSuccess = step.onSuccess
  if (step.onFailure) compiled.onFailure = step.onFailure
  if (step.condition) compiled.condition = substituteParams(step.condition, params)
  if (step.timeout) compiled.timeout = step.timeout
  if (step.retries) compiled.retries = step.retries
  if (step.retryDelay) compiled.retryDelay = step.retryDelay

  return compiled
}

/**
 * Compile a condition
 */
function compileCondition(condition, params) {
  return {
    check: condition.check,
    params: condition.params?.map(p => substituteParams(p, params)) || [],
    message: condition.message || null
  }
}

/**
 * Substitute {{param}} placeholders
 */
function substituteParams(template, params) {
  if (typeof template !== 'string') return template

  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (params[name] !== undefined) {
      return String(params[name])
    }
    return match  // Keep placeholder if not found
  })
}

/**
 * Calculate blast radius from parameters
 */
function calculateBlastRadius(runbook, params) {
  const hosts = new Set()

  // Add explicitly defined blast radius
  for (const item of runbook.safety.blastRadius) {
    const resolved = substituteParams(item, params)
    hosts.add(resolved)
  }

  // Scan steps for host references
  for (const step of runbook.steps) {
    if (step.host) {
      hosts.add(substituteParams(step.host, params))
    }
    if (step.hosts) {
      for (const h of step.hosts) {
        hosts.add(substituteParams(h, params))
      }
    }
  }

  return Array.from(hosts)
}

/**
 * Estimate execution duration
 */
function estimateDuration(steps) {
  let total = 0

  for (const step of steps) {
    switch (step.action) {
      case 'wait':
        total += step.compiled.seconds || 5
        break
      case 'ssh_command':
        total += step.timeout || 30
        break
      case 'api_call':
        total += step.timeout || 10
        break
      default:
        total += 5
    }
  }

  return total
}

// ============================================================================
// RUNBOOK EXECUTOR
// ============================================================================

/**
 * Execute a compiled runbook plan
 */
export async function executeRunbook(plan, options = {}) {
  const {
    dryRun = false,
    onProgress = null,
    onStepComplete = null,
    executeAction = defaultExecuteAction
  } = options

  const execution = {
    planId: plan.runbookId,
    startedAt: new Date().toISOString(),
    dryRun,
    status: 'running',
    currentStep: 0,
    results: [],
    variables: { ...plan.parameters }
  }

  const reportProgress = (message, data = {}) => {
    if (onProgress) {
      onProgress({ ...execution, message, ...data })
    }
  }

  try {
    // Check preconditions
    reportProgress('Checking preconditions...')
    for (const precondition of plan.preconditions) {
      const result = await checkCondition(precondition, execution.variables, dryRun)
      if (!result.passed) {
        execution.status = 'failed'
        execution.error = `Precondition failed: ${precondition.check} - ${result.message}`
        return execution
      }
    }

    // Execute steps
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      execution.currentStep = i

      // Check step condition
      if (step.condition) {
        const conditionMet = evaluateCondition(step.condition, execution.variables)
        if (!conditionMet) {
          execution.results.push({
            step: i,
            action: step.action,
            status: 'skipped',
            reason: 'Condition not met'
          })
          continue
        }
      }

      reportProgress(`Executing step ${i + 1}/${plan.steps.length}: ${step.name}`)

      // Execute with retries
      let result = null
      let attempts = 0
      const maxAttempts = (step.retries || 0) + 1

      while (attempts < maxAttempts) {
        attempts++
        result = await executeStep(step, execution.variables, dryRun, executeAction)

        if (result.success) break

        if (attempts < maxAttempts) {
          reportProgress(`Step failed, retrying (${attempts}/${maxAttempts})...`)
          await sleep(step.retryDelay || 5000)
        }
      }

      execution.results.push({
        step: i,
        action: step.action,
        name: step.name,
        ...result,
        attempts
      })

      if (onStepComplete) {
        onStepComplete(step, result, i)
      }

      // Handle failure
      if (!result.success) {
        if (step.onFailure?.goto === 'rollback') {
          reportProgress('Step failed, initiating rollback...')
          execution.status = 'rolling_back'
          const rollbackResult = await executeRollback(plan, execution, options)
          execution.rollbackResult = rollbackResult
          execution.status = rollbackResult.success ? 'rolled_back' : 'rollback_failed'
          return execution
        } else if (step.onFailure?.goto) {
          // Jump to specific step
          const targetIndex = plan.steps.findIndex(s => s.name === step.onFailure.goto)
          if (targetIndex >= 0) {
            i = targetIndex - 1  // Will be incremented by loop
            continue
          }
        } else if (!step.onFailure?.continue) {
          execution.status = 'failed'
          execution.error = `Step ${i + 1} failed: ${result.error}`
          return execution
        }
      }

      // Update variables from step output
      if (result.output && step.compiled.outputVar) {
        execution.variables[step.compiled.outputVar] = result.output
      }
    }

    // Check postconditions
    reportProgress('Verifying postconditions...')
    for (const postcondition of plan.postconditions) {
      const result = await checkCondition(postcondition, execution.variables, dryRun)
      if (!result.passed) {
        execution.status = 'postcondition_failed'
        execution.error = `Postcondition failed: ${postcondition.check} - ${result.message}`
        return execution
      }
    }

    execution.status = 'completed'
    execution.completedAt = new Date().toISOString()
    reportProgress('Runbook completed successfully')

  } catch (error) {
    execution.status = 'error'
    execution.error = error.message
    reportProgress(`Execution error: ${error.message}`)
  }

  return execution
}

/**
 * Execute a single step
 */
async function executeStep(step, variables, dryRun, executeAction) {
  const startTime = Date.now()

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      action: step.action,
      wouldExecute: step.compiled,
      duration: 0
    }
  }

  try {
    const result = await executeAction(step.action, step.compiled, variables)
    return {
      success: true,
      ...result,
      duration: Date.now() - startTime
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    }
  }
}

/**
 * Execute rollback procedure
 */
async function executeRollback(plan, execution, options) {
  const results = []

  for (const step of plan.rollback) {
    const result = await executeStep(
      step,
      execution.variables,
      options.dryRun,
      options.executeAction || defaultExecuteAction
    )
    results.push(result)

    if (!result.success && !options.dryRun) {
      return { success: false, results, error: result.error }
    }
  }

  return { success: true, results }
}

/**
 * Check a precondition/postcondition
 */
async function checkCondition(condition, variables, dryRun) {
  if (dryRun) {
    return { passed: true, dryRun: true }
  }

  // Built-in condition checks
  switch (condition.check) {
    case 'host_reachable':
      // Would actually ping the host
      return { passed: true, message: 'Host reachable (simulated)' }

    case 'service_exists':
      return { passed: true, message: 'Service exists (simulated)' }

    case 'service_running':
      return { passed: true, message: 'Service running (simulated)' }

    case 'file_exists':
      return { passed: true, message: 'File exists (simulated)' }

    case 'port_open':
      return { passed: true, message: 'Port open (simulated)' }

    default:
      return { passed: true, message: 'Unknown check (assumed passed)' }
  }
}

/**
 * Evaluate a condition expression
 */
function evaluateCondition(condition, variables) {
  try {
    // Simple variable check: {{var}} or {{var}} == "value"
    const substituted = substituteParams(condition, variables)

    if (substituted === 'true') return true
    if (substituted === 'false') return false

    // Try to evaluate as expression
    // Note: In production, use a safe expression evaluator
    return !!substituted
  } catch {
    return false
  }
}

/**
 * Default action executor (simulation)
 */
async function defaultExecuteAction(action, params, variables) {
  switch (action) {
    case 'ssh_command':
      console.log(`[Runbook] SSH: ${params.host} > ${params.command}`)
      return { output: 'Simulated SSH output' }

    case 'api_call':
      console.log(`[Runbook] API: ${params.method} ${params.url}`)
      return { output: { status: 200, body: 'Simulated response' } }

    case 'wait':
      await sleep((params.seconds || 5) * 1000)
      return { output: null }

    case 'log':
      console.log(`[Runbook] Log: ${params.message}`)
      return { output: null }

    case 'set_variable':
      variables[params.name] = params.value
      return { output: params.value }

    case 'notify':
      console.log(`[Runbook] Notify: ${params.channel} - ${params.message}`)
      return { output: null }

    default:
      return { output: null }
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================================
// RUNBOOK STORAGE
// ============================================================================

/**
 * Save a runbook to memory
 */
export function saveRunbook(runbook) {
  const mm = getMemoryManager()
  return mm.addRunbook(runbook)
}

/**
 * Get a runbook by ID
 */
export function getRunbook(id) {
  const mm = getMemoryManager()
  return mm.getRunbook(id)
}

/**
 * List all runbooks
 */
export function listRunbooks(filter = {}) {
  const mm = getMemoryManager()
  let runbooks = mm.getAllRunbooks()

  if (filter.category) {
    runbooks = runbooks.filter(r => r.category === filter.category)
  }

  if (filter.tag) {
    runbooks = runbooks.filter(r => r.tags?.includes(filter.tag))
  }

  if (filter.intent) {
    runbooks = runbooks.filter(r => r.intent === filter.intent)
  }

  return runbooks
}

/**
 * Find runbook by intent
 */
export function findRunbookByIntent(intent) {
  const mm = getMemoryManager()
  const runbooks = mm.getAllRunbooks()
  return runbooks.find(r => r.intent === intent)
}

// ============================================================================
// EXAMPLE RUNBOOKS
// ============================================================================

/**
 * Example: Service restart runbook
 */
export const EXAMPLE_RUNBOOKS = {
  restartService: createRunbook({
    id: 'restart_service',
    name: 'Restart Service',
    description: 'Safely restart a systemd service with health checks',
    intent: 'restart_service',
    category: 'operations',
    tags: ['service', 'restart', 'systemd'],

    parameters: [
      { name: 'host', type: 'host', required: true, description: 'Target host' },
      { name: 'service', type: 'string', required: true, description: 'Service name' },
      { name: 'timeout', type: 'number', default: 60, description: 'Restart timeout in seconds' }
    ],

    preconditions: [
      { check: 'host_reachable', params: ['{{host}}'] },
      { check: 'service_exists', params: ['{{host}}', '{{service}}'] }
    ],

    steps: [
      {
        name: 'Stop service',
        action: 'ssh_command',
        host: '{{host}}',
        command: 'sudo systemctl stop {{service}}',
        timeout: 30,
        onFailure: { goto: 'rollback' }
      },
      {
        name: 'Wait for shutdown',
        action: 'wait',
        seconds: 5
      },
      {
        name: 'Start service',
        action: 'ssh_command',
        host: '{{host}}',
        command: 'sudo systemctl start {{service}}',
        timeout: 30,
        onFailure: { goto: 'rollback' }
      },
      {
        name: 'Log completion',
        action: 'log',
        message: 'Service {{service}} restarted on {{host}}'
      }
    ],

    postconditions: [
      { check: 'service_running', params: ['{{host}}', '{{service}}'] }
    ],

    rollback: [
      {
        name: 'Force start service',
        action: 'ssh_command',
        host: '{{host}}',
        command: 'sudo systemctl start {{service}}'
      }
    ],

    safety: {
      level: 'AMBER',
      requiresApproval: true,
      blastRadius: ['{{host}}'],
      timeout: 120
    }
  }),

  checkDiskSpace: createRunbook({
    id: 'check_disk_space',
    name: 'Check Disk Space',
    description: 'Check disk usage on a host',
    intent: 'check_disk',
    category: 'monitoring',
    tags: ['disk', 'monitoring', 'health'],

    parameters: [
      { name: 'host', type: 'host', required: true },
      { name: 'threshold', type: 'number', default: 80, description: 'Warning threshold %' }
    ],

    preconditions: [
      { check: 'host_reachable', params: ['{{host}}'] }
    ],

    steps: [
      {
        name: 'Get disk usage',
        action: 'ssh_command',
        host: '{{host}}',
        command: 'df -h --output=pcent,target | tail -n +2',
        outputVar: 'disk_usage'
      },
      {
        name: 'Log results',
        action: 'log',
        message: 'Disk usage on {{host}}: {{disk_usage}}'
      }
    ],

    postconditions: [],
    rollback: [],

    safety: {
      level: 'GREEN',
      requiresApproval: false,
      blastRadius: ['{{host}}'],
      timeout: 30
    }
  })
}

export default {
  ACTION_TYPES,
  PARAM_TYPES,
  SAFETY_LEVELS,
  createRunbook,
  compileRunbook,
  validateParameters,
  executeRunbook,
  saveRunbook,
  getRunbook,
  listRunbooks,
  findRunbookByIntent,
  EXAMPLE_RUNBOOKS
}
