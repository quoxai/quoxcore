/**
 * QM-7: Per-Resource Circuit Breakers
 *
 * Simple circuit breaker per resource type.
 * States: closed (normal) → open (rejecting) → half-open (probing)
 *
 * Resources: ssh, llm, collector
 */

class CircuitBreaker {
  constructor(name, { threshold = 3, resetMs = 60000 } = {}) {
    this.name = name
    this.threshold = threshold
    this.resetMs = resetMs
    this.state = 'closed'    // closed | open | half-open
    this.failures = 0
    this.lastFailure = 0
    this.lastSuccess = 0
  }

  canExecute() {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      // Check if reset time has passed → transition to half-open
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = 'half-open'
        return true  // Allow one probe request
      }
      return false
    }
    // half-open: allow one request
    return true
  }

  recordSuccess() {
    this.failures = 0
    this.state = 'closed'
    this.lastSuccess = Date.now()
  }

  recordFailure() {
    this.failures++
    this.lastFailure = Date.now()
    if (this.state === 'half-open') {
      this.state = 'open'  // Probe failed, go back to open
      console.log(`[CircuitBreaker] ${this.name} OPEN — probe failed (reset in ${this.resetMs / 1000}s)`)
    } else if (this.failures >= this.threshold) {
      this.state = 'open'
      console.log(`[CircuitBreaker] ${this.name} OPEN — ${this.failures} failures (reset in ${this.resetMs / 1000}s)`)
    }
  }

  getState() {
    // Auto-transition open→half-open if reset time passed
    if (this.state === 'open' && Date.now() - this.lastFailure > this.resetMs) {
      this.state = 'half-open'
    }
    return { name: this.name, state: this.state, failures: this.failures, lastFailure: this.lastFailure }
  }
}

// ── Pre-configured breakers ──────────────────────────────────────────

const breakers = {
  ssh:       new CircuitBreaker('ssh',       { threshold: 3, resetMs: 60000 }),   // 3 failures, 60s reset
  llm:       new CircuitBreaker('llm',       { threshold: 5, resetMs: 30000 }),   // 5 failures, 30s reset
  collector: new CircuitBreaker('collector', { threshold: 3, resetMs: 45000 }),   // 3 failures, 45s reset
}

/**
 * Get a circuit breaker by resource type. Returns the llm breaker for unknown types.
 * @param {string} resourceType
 * @returns {CircuitBreaker}
 */
export function getBreaker(resourceType) {
  return breakers[resourceType] || breakers.llm
}

/**
 * Check if a resource type can accept a request.
 * @param {string} resourceType
 * @returns {boolean}
 */
export function canExecuteResource(resourceType) {
  return getBreaker(resourceType).canExecute()
}

/**
 * Record a successful execution for a resource type.
 * @param {string} resourceType
 */
export function recordResourceSuccess(resourceType) {
  getBreaker(resourceType).recordSuccess()
}

/**
 * Record a failed execution for a resource type.
 * @param {string} resourceType
 */
export function recordResourceFailure(resourceType) {
  getBreaker(resourceType).recordFailure()
}

/**
 * Get the state of all circuit breakers.
 * @returns {object[]}
 */
export function getAllBreakerStates() {
  return Object.values(breakers).map(b => b.getState())
}

/**
 * Reset all breakers to their initial closed state. Test-only escape hatch —
 * the `breakers` map is a module-level singleton shared by every caller in
 * the process, so without this, failures recorded by one test leak into the
 * next test that happens to share the same resource type.
 */
export function resetAllBreakers() {
  for (const b of Object.values(breakers)) {
    b.state = 'closed'
    b.failures = 0
    b.lastFailure = 0
    b.lastSuccess = 0
  }
}

/**
 * Typed error thrown/returned at a call site when its resource breaker is
 * OPEN. Callers key failure accounting off `err.name` /
 * `err instanceof CircuitBreakerOpenError` rather than parsing message text.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(resourceType) {
    const breaker = getBreaker(resourceType)
    const retryAfterMs = Math.max(0, breaker.resetMs - (Date.now() - breaker.lastFailure))
    super(`circuit breaker OPEN for resource '${resourceType}' — ${breaker.failures} recent failure(s), retry in ${Math.ceil(retryAfterMs / 1000)}s`)
    this.name = 'CircuitBreakerOpenError'
    this.resourceType = resourceType
    this.retryAfterMs = retryAfterMs
  }
}

// ── Resource type detection ──────────────────────────────────────────

const SSH_KEYWORDS = /\b(ssh|host|fleet|bastion|deploy|server|node|proxmox|docker\d|gw-01|pve\d|kuma)\b/i

/**
 * Detect the resource type from a task's prompt and metadata.
 * @param {object} task - Task object with prompt, agent_id, tools_used
 * @returns {string} 'ssh' | 'llm' | 'collector'
 */
export function detectResourceType(task) {
  const prompt = task.prompt || ''
  const agentId = (task.agent_id || '').toLowerCase()
  const toolsUsed = task.tools_used || ''

  // SSH-related agents
  if (agentId === 'sentinel' || agentId === 'atlas') {
    return 'ssh'
  }

  // Keyword match on prompt
  if (SSH_KEYWORDS.test(prompt)) {
    return 'ssh'
  }

  // Tool-based detection
  if (typeof toolsUsed === 'string' && /\b(ssh|exec_command|bastion|fleet)\b/i.test(toolsUsed)) {
    return 'ssh'
  }

  // Default to llm
  return 'llm'
}
