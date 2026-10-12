/**
 * L3 Policy Gate - Authorization & Safety Layer
 *
 * Enforces policies before requests reach execution:
 * - Rate limiting
 * - Content safety screening
 * - Scope authorization
 * - Budget enforcement
 *
 * Part of AOCL (Agent Orchestration Control Layers)
 */

import { createLayerEvent, storeEnvelope } from '../../lib/aee/index.js'
import { fetchActivePolicies } from '../policyStoreClient.js'
import { evaluateCondition, buildRequestContext } from './conditionEvaluator.js'

// Security configuration - fail closed by default (SECURITY FIX #52)
const POLICY_GATE_FAIL_OPEN = import.meta.env.VITE_POLICY_GATE_FAIL_OPEN === 'true' || false

// Alert callback for security events (can be overridden)
let securityAlertCallback = null

/**
 * Set a callback function for security alerts
 * @param {Function} callback - Function to call on security events: (severity, message, details) => void
 */
export function setSecurityAlertCallback(callback) {
  securityAlertCallback = callback
}

/**
 * Emit a security alert
 * @param {'critical'|'high'|'medium'|'low'} severity
 * @param {string} message
 * @param {Object} details
 */
function emitSecurityAlert(severity, message, details = {}) {
  const alertData = {
    timestamp: new Date().toISOString(),
    severity,
    message,
    component: 'PolicyGate',
    ...details
  }

  // Always log to console
  console.error(`[PolicyGate:SECURITY:${severity.toUpperCase()}] ${message}`, alertData)

  // Call external alert handler if configured
  if (securityAlertCallback && typeof securityAlertCallback === 'function') {
    try {
      securityAlertCallback(severity, message, alertData)
    } catch (callbackError) {
      console.error('[PolicyGate] Security alert callback failed:', callbackError)
    }
  }
}

// Policy configuration
const POLICY_CONFIG = {
  // Rate limiting
  rateLimits: {
    queriesPerMinute: 30,
    queriesPerHour: 300,
    tokensPerDay: 500000
  },

  // Content safety patterns (basic screening)
  blockedPatterns: [
    /\b(drop\s+table|delete\s+from|truncate)\b/i,  // SQL injection attempts
    /\b(rm\s+-rf|sudo\s+rm|format\s+c:)\b/i,       // Dangerous system commands
    /\b(password|secret|api[_-]?key)\s*[:=]/i      // Credential exposure
  ],

  // Warning patterns (allow but flag)
  warningPatterns: [
    /\b(sudo|chmod\s+777|eval\()\b/i,              // Elevated privilege commands
    /\b(production|prod)\b.*\b(delete|remove|drop)\b/i  // Production destructive ops
  ],

  // Scope restrictions per agent
  // Agents not listed fall back to 'quox' scopes (the orchestrator baseline)
  // These define what TOPIC KEYWORDS an agent's queries may contain
  // Note: scopes are WARNINGS not blocks (line ~295), but still affect LLM behavior via context
  agentScopes: {
    quox: ['infrastructure', 'monitoring', 'chat', 'memory', 'files', 'security', 'network', 'deployment'],  // orchestrator — all scopes
    sentinel: ['security', 'monitoring', 'audit', 'infrastructure', 'network'],  // needs infra for ssh_exec on hosts, network for network_check
    cipher: ['network', 'connectivity', 'dns', 'infrastructure'],  // needs infra for ssh_exec + system_admin on hosts
    nova: ['deployment', 'containers', 'orchestration', 'infrastructure', 'monitoring'],  // needs infra for ssh_exec + system_admin, monitoring for alerts
    atlas: ['infrastructure', 'deployment', 'monitoring'],  // proxmox VMs/containers = infrastructure
    metrics: ['monitoring', 'infrastructure'],  // needs infra for ssh_exec on hosts to query metrics
    beacon: ['monitoring', 'infrastructure', 'network'],  // availability = monitoring + network + infra hosts
    archivist: ['files', 'documents', 'search', 'memory']  // file operations + memory
  }
}

// In-memory rate tracking (would use Redis in production)
const rateBuckets = {
  minute: { count: 0, resetAt: Date.now() + 60000 },
  hour: { count: 0, resetAt: Date.now() + 3600000 }
}

/**
 * Check rate limits
 * @returns {{ allowed: boolean, reason?: string, remaining?: number }}
 */
function checkRateLimit() {
  const now = Date.now()

  // Reset buckets if expired
  if (now > rateBuckets.minute.resetAt) {
    rateBuckets.minute = { count: 0, resetAt: now + 60000 }
  }
  if (now > rateBuckets.hour.resetAt) {
    rateBuckets.hour = { count: 0, resetAt: now + 3600000 }
  }

  // Check minute limit
  if (rateBuckets.minute.count >= POLICY_CONFIG.rateLimits.queriesPerMinute) {
    return {
      allowed: false,
      reason: 'Rate limit exceeded (per minute)',
      remaining: 0,
      resetIn: Math.ceil((rateBuckets.minute.resetAt - now) / 1000)
    }
  }

  // Check hour limit
  if (rateBuckets.hour.count >= POLICY_CONFIG.rateLimits.queriesPerHour) {
    return {
      allowed: false,
      reason: 'Rate limit exceeded (per hour)',
      remaining: 0,
      resetIn: Math.ceil((rateBuckets.hour.resetAt - now) / 1000)
    }
  }

  // Increment counters
  rateBuckets.minute.count++
  rateBuckets.hour.count++

  return {
    allowed: true,
    remaining: POLICY_CONFIG.rateLimits.queriesPerMinute - rateBuckets.minute.count
  }
}

/**
 * Check content safety
 * @param {string} query - User query
 * @returns {{ safe: boolean, blocked?: boolean, warnings: string[] }}
 */
function checkContentSafety(query) {
  const warnings = []

  // Check blocked patterns
  for (const pattern of POLICY_CONFIG.blockedPatterns) {
    if (pattern.test(query)) {
      return {
        safe: false,
        blocked: true,
        reason: 'Query contains potentially dangerous content',
        pattern: pattern.toString()
      }
    }
  }

  // Check warning patterns
  for (const pattern of POLICY_CONFIG.warningPatterns) {
    if (pattern.test(query)) {
      warnings.push(`Flagged: ${pattern.toString()}`)
    }
  }

  return {
    safe: true,
    blocked: false,
    warnings
  }
}

/**
 * Check agent scope authorization
 * @param {string} query - User query
 * @param {string} agent - Current agent
 * @returns {{ authorized: boolean, reason?: string }}
 */
function checkAgentScope(query, agent) {
  const allowedScopes = POLICY_CONFIG.agentScopes[agent] || POLICY_CONFIG.agentScopes.quox

  // For now, simple heuristic - could be enhanced with intent classification
  const queryLower = query.toLowerCase()

  // Check if query mentions topics outside agent's scope
  const scopeKeywords = {
    security: /\b(security|firewall|vulnerability|intrusion|audit)\b/i,
    network: /\b(network|dns|ip|routing|subnet|vlan)\b/i,
    deployment: /\b(deploy|kubernetes|docker|container|helm)\b/i,
    files: /\b(file|document|folder|upload|pdf|doc)\b/i,
    infrastructure: /\b(server|host|vm|proxmox|cpu|memory|disk)\b/i,
    monitoring: /\b(monitor|alert|metric|grafana|prometheus)\b/i
  }

  // Check if query targets a specific scope
  for (const [scope, pattern] of Object.entries(scopeKeywords)) {
    if (pattern.test(queryLower)) {
      if (!allowedScopes.includes(scope)) {
        return {
          authorized: false,
          reason: `Query involves ${scope} which is outside ${agent}'s scope`,
          suggestedAgent: Object.entries(POLICY_CONFIG.agentScopes)
            .find(([_, scopes]) => scopes.includes(scope))?.[0] || 'quox'
        }
      }
    }
  }

  return { authorized: true }
}

/**
 * Main policy gate check
 * Runs all policy checks and returns combined result
 *
 * @param {string} query - User query
 * @param {Object} context - Request context
 * @param {string} context.agent - Current agent
 * @param {string} context.corr - Correlation ID for AOCL tracking
 * @returns {Promise<Object>} Policy check result
 */
export async function checkPolicy(query, context = {}) {
  const { agent = 'quox', corr } = context
  const startTime = Date.now()
  const checks = []
  const warnings = []

  // Emit L3 start event
  if (corr) {
    storeEnvelope(createLayerEvent('L3', 'start', {
      query: query.slice(0, 100),
      agent
    }, corr)).catch(err => console.warn('[AOCL] L3 start:', err))
  }

  try {
    // 1. Rate limit check
    const rateResult = checkRateLimit()
    checks.push({ name: 'rate-limit', passed: rateResult.allowed })

    if (!rateResult.allowed) {
      const result = {
        allowed: false,
        reason: rateResult.reason,
        checks,
        resetIn: rateResult.resetIn
      }

      // Emit L3 reject event
      if (corr) {
        storeEnvelope(createLayerEvent('L3', 'reject', {
          reason: rateResult.reason,
          check: 'rate-limit',
          duration_ms: Date.now() - startTime
        }, corr)).catch(err => console.warn('[AOCL] L3 reject:', err))
      }

      return result
    }

    // 2. Content safety check
    const safetyResult = checkContentSafety(query)
    checks.push({ name: 'content-safety', passed: safetyResult.safe })

    if (safetyResult.warnings?.length > 0) {
      warnings.push(...safetyResult.warnings)
    }

    if (!safetyResult.safe) {
      const result = {
        allowed: false,
        reason: safetyResult.reason,
        checks,
        pattern: safetyResult.pattern
      }

      // Emit L3 reject event
      if (corr) {
        storeEnvelope(createLayerEvent('L3', 'reject', {
          reason: safetyResult.reason,
          check: 'content-safety',
          duration_ms: Date.now() - startTime
        }, corr)).catch(err => console.warn('[AOCL] L3 reject:', err))
      }

      return result
    }

    // 3. Scope authorization check
    const scopeResult = checkAgentScope(query, agent)
    checks.push({ name: 'scope-auth', passed: scopeResult.authorized })

    if (!scopeResult.authorized) {
      // Scope violations are warnings, not blocks (agent can still try)
      warnings.push(`Scope warning: ${scopeResult.reason}`)
    }

    // 4. GOV-2: Evaluate store-backed policies
    let storePolicyMatches = []
    try {
      const policies = await fetchActivePolicies(context.orgId)
      if (policies.length > 0) {
        const reqCtx = buildRequestContext(query, {
          agent,
          corr,
          rateContext: {
            queries_per_minute: rateBuckets.minute.count,
            queries_per_hour: rateBuckets.hour.count,
          },
        })

        for (const policy of policies) {
          if (!policy.conditions) continue
          const matched = evaluateCondition(policy.conditions, reqCtx)
          if (matched) {
            storePolicyMatches.push({ id: policy.id, name: policy.name, effect: policy.effect, reason: policy.reason })

            if (policy.effect === 'deny') {
              checks.push({ name: `policy:${policy.id}`, passed: false, policyName: policy.name })
              const denyResult = {
                allowed: false,
                reason: policy.reason || `Denied by policy: ${policy.name}`,
                checks,
                policyId: policy.id,
                policyName: policy.name,
              }

              if (corr) {
                storeEnvelope(createLayerEvent('L3', 'reject', {
                  reason: denyResult.reason,
                  check: `store-policy:${policy.id}`,
                  policyName: policy.name,
                  duration_ms: Date.now() - startTime
                }, corr)).catch(err => console.warn('[AOCL] L3 reject:', err))
              }

              return denyResult
            }

            if (policy.effect === 'require_approval') {
              // SEC-FIX-3: halt the request when require_approval matches.
              // Previously just pushed a warning and let the request proceed,
              // relying on backend (agentTools.js) to block at tool-call time.
              // Now we halt early — saves a round-trip, shows approval UI.
              // Callers should check result.requiresApproval and render the
              // approval-gate message rather than a generic denial.
              const approvalResult = {
                allowed: false,
                requiresApproval: true,
                reason: `Approval required: ${policy.reason || policy.name}`,
                checks,
                policyId: policy.id,
                policyName: policy.name,
              }

              if (corr) {
                storeEnvelope(createLayerEvent('L3', 'reject', {
                  reason: approvalResult.reason,
                  check: `store-policy:${policy.id}`,
                  policyName: policy.name,
                  requiresApproval: true,
                  duration_ms: Date.now() - startTime,
                }, corr)).catch(err => console.warn('[AOCL] L3 reject (approval):', err))
              }

              return approvalResult
            }

            if (policy.effect === 'log_only') {
              warnings.push(`Policy flagged: ${policy.reason || policy.name}`)
            }
          }
        }
        checks.push({ name: 'store-policies', passed: true, evaluated: policies.length, matched: storePolicyMatches.length })
      }
    } catch (storePolicyError) {
      // Fail open for store policies — hardcoded rules already ran above
      console.warn('[PolicyGate] Store policy evaluation failed:', storePolicyError.message)
      warnings.push('Store policy evaluation unavailable — using hardcoded rules only')
    }

    // All checks passed
    const result = {
      allowed: true,
      checks,
      warnings,
      remaining: rateResult.remaining,
      matchedPolicies: storePolicyMatches,
      duration_ms: Date.now() - startTime
    }

    // Emit L3 complete event
    if (corr) {
      storeEnvelope(createLayerEvent('L3', 'complete', {
        allowed: true,
        checksRun: checks.length,
        warningCount: warnings.length,
        matchedPolicies: storePolicyMatches.map(p => p.id),
        duration_ms: result.duration_ms
      }, corr)).catch(err => console.warn('[AOCL] L3 complete:', err))
    }

    return result

  } catch (error) {
    // SECURITY FIX #52: Fail closed by default on policy gate errors
    // This prevents bypass of security checks when errors occur
    const failOpen = POLICY_GATE_FAIL_OPEN
    const allowed = failOpen

    // Emit security alert for policy gate failure
    emitSecurityAlert('high', 'Policy gate error occurred', {
      error: error.message,
      stack: error.stack,
      failOpen,
      requestBlocked: !allowed,
      query: typeof query === 'string' ? query.substring(0, 100) : 'unknown',
      agent: context?.agent || 'unknown'
    })

    const result = {
      allowed,
      checks,
      warnings: [...warnings, `Policy check error: ${error.message}`],
      error: error.message,
      failedClosed: !failOpen
    }

    // Emit L3 complete with error flag
    if (corr) {
      storeEnvelope(createLayerEvent('L3', 'complete', {
        allowed,
        error: error.message,
        failedClosed: !failOpen,
        duration_ms: Date.now() - startTime
      }, corr)).catch(err => console.warn('[AOCL] L3 complete:', err))
    }

    return result
  }
}

/**
 * Get current rate limit status
 * @returns {Object} Rate limit status
 */
export function getRateLimitStatus() {
  const now = Date.now()
  return {
    minute: {
      used: rateBuckets.minute.count,
      limit: POLICY_CONFIG.rateLimits.queriesPerMinute,
      remaining: Math.max(0, POLICY_CONFIG.rateLimits.queriesPerMinute - rateBuckets.minute.count),
      resetIn: Math.max(0, Math.ceil((rateBuckets.minute.resetAt - now) / 1000))
    },
    hour: {
      used: rateBuckets.hour.count,
      limit: POLICY_CONFIG.rateLimits.queriesPerHour,
      remaining: Math.max(0, POLICY_CONFIG.rateLimits.queriesPerHour - rateBuckets.hour.count),
      resetIn: Math.max(0, Math.ceil((rateBuckets.hour.resetAt - now) / 1000))
    }
  }
}

/**
 * Reset rate limits (for testing/admin)
 */
export function resetRateLimits() {
  const now = Date.now()
  rateBuckets.minute = { count: 0, resetAt: now + 60000 }
  rateBuckets.hour = { count: 0, resetAt: now + 3600000 }
}

export default checkPolicy
