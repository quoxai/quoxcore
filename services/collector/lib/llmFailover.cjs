/**
 * LLM-CHOICE Phase 1 — on-error runtime failover for the collector's LLM
 * dispatch layer.
 *
 * The policy engine (llmRoutingPolicy.cjs) already picks an
 * availability-based plan (skips providers with no configured key). This
 * module adds the missing piece: a provider that HAS a key but fails at
 * call time (quota exhausted, 429/5xx, OAuth expiry, timeout, network) gets
 * retried on the next candidate in the resolved chain instead of the whole
 * request failing.
 */

/**
 * Builds an ordered, deduplicated candidate chain from a resolved policy
 * plan: plan primary -> policyContext.policyFallbacks -> policyContext.systemDefault.
 * Dedup is keyed on `provider:model`.
 *
 * @param {{ plan: { provider: string, model: string } | null, policyContext: { policyFallbacks?: Array<{provider:string,model:string}>, systemDefault?: {provider:string,model:string} } | null }} opts
 * @returns {Array<{ provider: string, model: string, source: string }>}
 */
function buildCandidateChain({ plan, policyContext } = {}) {
  const chain = []
  const seen = new Set()

  function push(provider, model, source) {
    if (!provider || !model) return
    const key = `${provider}:${model}`
    if (seen.has(key)) return
    seen.add(key)
    chain.push({ provider, model, source })
  }

  if (plan) push(plan.provider, plan.model, 'plan_primary')

  if (Array.isArray(policyContext?.policyFallbacks)) {
    for (const fallback of policyContext.policyFallbacks) {
      push(fallback?.provider, fallback?.model, 'policy_fallback')
    }
  }

  if (policyContext?.systemDefault) {
    push(policyContext.systemDefault.provider, policyContext.systemDefault.model, 'system_default')
  }

  return chain
}

const RETRYABLE_HTTP_STATUS = new Set([401, 403, 408, 425, 429])
const NON_RETRYABLE_HTTP_STATUS = new Set([400, 404, 422])

// Returns true/false when the status is decisive, or null when the status
// doesn't tell us anything (caller should fall back to heuristics).
function httpStatusVerdict(status) {
  if (typeof status !== 'number') return null
  if (NON_RETRYABLE_HTTP_STATUS.has(status)) return false
  if (RETRYABLE_HTTP_STATUS.has(status)) return true
  if (status >= 500 && status <= 599) return true // incl. Anthropic's 529 overloaded
  return null
}

const RETRYABLE_SYSTEM_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENOENT', // e.g. CLI binary spawn failure
  'EPIPE',
])

/**
 * Decides whether a failed LLM call is worth retrying against the next
 * candidate in the chain. Accepts either a raw HTTP status code or an Error
 * (with optional `.status`/`.statusCode`/`.httpStatus`/`.code`/`.name`).
 *
 * Retryable: network/fetch errors, AbortError/timeout, CLI spawn/timeout
 * errors, HTTP 401/403/408/425/429/5xx (auth/quota failures should try the
 * next provider — that's the point of failover).
 *
 * Non-retryable: HTTP 400/404/422 (bad request won't heal by switching
 * providers), consent-denied.
 *
 * @param {number | Error | { status?: number, statusCode?: number, httpStatus?: number, code?: string, name?: string, message?: string, consentDenied?: boolean, killed?: boolean, signal?: string }} errOrStatus
 * @returns {boolean}
 */
function isRetryableLlmError(errOrStatus) {
  if (typeof errOrStatus === 'number') {
    return httpStatusVerdict(errOrStatus) === true
  }

  if (!errOrStatus) return false

  if (errOrStatus.consentDenied === true || errOrStatus.code === 'consent_denied') return false

  const status = typeof errOrStatus.status === 'number'
    ? errOrStatus.status
    : (typeof errOrStatus.statusCode === 'number'
      ? errOrStatus.statusCode
      : (typeof errOrStatus.httpStatus === 'number' ? errOrStatus.httpStatus : null))

  if (status !== null) {
    const verdict = httpStatusVerdict(status)
    if (verdict !== null) return verdict
  }

  const name = errOrStatus.name || ''
  const code = errOrStatus.code || ''
  const message = String(errOrStatus.message || errOrStatus || '').toLowerCase()

  if (name === 'AbortError') return true
  if (code && RETRYABLE_SYSTEM_ERROR_CODES.has(code)) return true
  if (errOrStatus.killed === true || errOrStatus.signal) return true // process timeout/kill (CLI spawn)
  if (/timeout|timed out/.test(message)) return true
  if (/network|fetch failed|spawn|econnrefused|econnreset|enotfound|eai_again|enoent/.test(message)) return true

  return false
}

/**
 * Walks an ordered candidate chain, calling `attempt(candidate)` for each
 * until one succeeds. Retryable failures advance to the next candidate
 * (recording a hop and invoking `onHop`); non-retryable failures rethrow
 * immediately. If every candidate fails retryably, throws
 * Error('all_providers_failed') with `.hops` attached.
 *
 * @param {{ candidates: Array<{provider:string, model:string, source?:string}>, attempt: (candidate: object) => Promise<any>, onHop?: (hop: object, next: object|null) => void }} opts
 * @returns {Promise<{ result: any, candidate: object, hops: Array<object> }>}
 */
async function executeWithFailover({ candidates, attempt, onHop } = {}) {
  const hops = []

  if (!Array.isArray(candidates) || candidates.length === 0) {
    const err = new Error('all_providers_failed')
    err.hops = hops
    throw err
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await attempt(candidate)
      return { result, candidate, hops }
    } catch (err) {
      if (!isRetryableLlmError(err)) {
        throw err
      }

      const status = typeof err?.status === 'number'
        ? err.status
        : (typeof err?.statusCode === 'number'
          ? err.statusCode
          : (typeof err?.httpStatus === 'number' ? err.httpStatus : null))

      const hop = {
        provider: candidate.provider,
        model: candidate.model,
        error: err?.message || String(err),
        status,
      }
      hops.push(hop)

      const next = candidates[i + 1] || null
      if (typeof onHop === 'function') {
        try {
          onHop(hop, next)
        } catch { /* audit/logging hook must never break failover */ }
      }
      // continue to next candidate
    }
  }

  const finalErr = new Error('all_providers_failed')
  finalErr.hops = hops
  throw finalErr
}

// ─────────────────────────────────────────────────────────────────────────
// LLM-FAILOVER P1: failure classification, per-provider cooldowns, and the
// governed chat candidate walk. isRetryableLlmError above stays as-is for
// existing callers; classifyLlmError is the finer-grained replacement used
// by the governed chat dispatch.
// ─────────────────────────────────────────────────────────────────────────

const LLM_ERROR_CLASSES = new Set([
  'auth_expired',
  'quota_exhausted',
  'rate_limited',
  'overloaded',
  'transient',
  'fatal',
])

const QUOTA_MESSAGE_RE = /weekly limit|monthly limit|usage limit reached|insufficient_quota|quota exceeded|exceeded your.{0,20}quota|credit balance is too low|out of credits/i
const AUTH_MESSAGE_RE = /invalid.{0,10}api.{0,5}key|authentication_error|unauthorized|oauth.{0,30}(expired|revoked|invalid)|token.{0,15}(expired|revoked)|credential.{0,15}(expired|revoked|invalid)/i
const OVERLOADED_MESSAGE_RE = /overloaded/i

// Collects every text field a failed LLM call might carry the real story in.
// The Claude CLI failure mode from the 2026-07-23 incident throws
// Error('CLI exited with code 1') with the useful part (api_error_status:429,
// "You've hit your weekly limit · resets 10pm (UTC)") in err._stdout.
function extractLlmErrorText(errOrResult) {
  if (!errOrResult) return ''
  if (typeof errOrResult === 'string') return errOrResult
  const parts = []
  for (const key of ['message', 'detail', 'text', 'result', '_stdout', '_stderr', 'stdout', 'stderr']) {
    const v = errOrResult[key]
    if (typeof v === 'string' && v) parts.push(v)
  }
  return parts.join('\n')
}

function extractLlmErrorStatus(errOrResult, text) {
  if (typeof errOrResult === 'number') return errOrResult
  if (!errOrResult) return null
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    if (typeof errOrResult[key] === 'number') return errOrResult[key]
  }
  const source = typeof text === 'string' ? text : extractLlmErrorText(errOrResult)
  // CLI stdout marker, e.g. "api_error_status:429"
  let m = /api_error_status[:\s]*(\d{3})\b/i.exec(source)
  if (m) return Number(m[1])
  // attempt-helper messages, e.g. "anthropic_api_429" / "openai_vision_api_503"
  m = /\bapi[_-](\d{3})\b/i.exec(source)
  if (m) return Number(m[1])
  return null
}

/**
 * Classifies a failed LLM call (an Error, an HTTP status number, or a
 * structured failure result like the CLI dispatcher's cli_error outcome)
 * into one of:
 *   'auth_expired':    401/403 or auth-ish wording; credential is dead
 *   'quota_exhausted': 429 with weekly/monthly-limit wording, or explicit
 *                       quota text (works without a status too)
 *   'rate_limited':    other 429
 *   'overloaded':      529/503 or "overloaded"
 *   'transient':       timeouts, connection resets, other 5xx
 *   'fatal':           400/404/422, consent denial, anything unrecognised
 *                       (switching providers will not heal a bad request)
 *
 * @param {number | Error | object} errOrResult
 * @returns {'auth_expired'|'quota_exhausted'|'rate_limited'|'overloaded'|'transient'|'fatal'}
 */
function classifyLlmError(errOrResult) {
  if (errOrResult === null || errOrResult === undefined) return 'fatal'

  if (typeof errOrResult === 'object') {
    // Respect a pre-computed class (lets the walk re-throw classified errors).
    const explicit = errOrResult.errorClass || errOrResult.error_class
    if (typeof explicit === 'string' && LLM_ERROR_CLASSES.has(explicit)) return explicit
    if (errOrResult.consentDenied === true || errOrResult.code === 'consent_denied') return 'fatal'
  }

  const text = extractLlmErrorText(errOrResult)
  const status = extractLlmErrorStatus(errOrResult, text)

  if (status !== null) {
    if (status === 429) return QUOTA_MESSAGE_RE.test(text) ? 'quota_exhausted' : 'rate_limited'
    if (status === 401 || status === 403) return 'auth_expired'
    if (status === 529 || status === 503) return 'overloaded'
    if (status === 400 || status === 404 || status === 422) return 'fatal'
    if (status >= 500 && status <= 599) return 'transient'
  }

  // No decisive status: message and error-shape heuristics.
  if (QUOTA_MESSAGE_RE.test(text)) return 'quota_exhausted'
  if (OVERLOADED_MESSAGE_RE.test(text)) return 'overloaded'
  if (AUTH_MESSAGE_RE.test(text)) return 'auth_expired'

  if (typeof errOrResult === 'object') {
    if (errOrResult.name === 'AbortError') return 'transient'
    if (errOrResult.code && RETRYABLE_SYSTEM_ERROR_CODES.has(errOrResult.code)) return 'transient'
    if (errOrResult.killed === true || errOrResult.signal) return 'transient'
  }
  if (/timeout|timed out|econnreset|econnrefused|enotfound|eai_again|fetch failed|network error|socket hang up/i.test(text)) {
    return 'transient'
  }

  return 'fatal'
}

/**
 * Best-effort parse of a provider reset hint like "resets 10pm (UTC)" or
 * "resets 3:30am" into an epoch-ms timestamp (next occurrence, UTC).
 * Returns null when no hint is found.
 *
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {number | null}
 */
function parseResetHint(text, nowMs = Date.now()) {
  if (typeof text !== 'string' || !text) return null
  const m = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3] ? m[3].toLowerCase() : null
  if (Number.isNaN(hour) || hour > 23 || minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  }
  const now = new Date(nowMs)
  let ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
  if (ts <= nowMs) ts += 24 * 60 * 60 * 1000
  return ts
}

// ── Per-(provider, credential-kind) cooldown state ───────────────────────
// In-memory only, resets on process restart.
// TODO(LLM-FAILOVER P2): persist cooldowns (survive restarts) and invalidate
// auth_expired cooldowns when the underlying credential changes in the
// vault / Core Integrations (credential-change hook + audit event).
const providerCooldowns = new Map()

const QUOTA_COOLDOWN_DEFAULT_MS = 60 * 60 * 1000 // 60 min when no reset hint
const AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000     // 24 h or process restart

function cooldownKey(provider, credentialKind) {
  return `${provider}:${credentialKind || 'default'}`
}

function markProviderCooldown(provider, credentialKind, { until, errorClass = null, reason = null } = {}) {
  if (!provider || !Number.isFinite(until)) return null
  const entry = {
    provider,
    credentialKind: credentialKind || 'default',
    until,
    errorClass,
    reason,
    markedAt: Date.now(),
  }
  providerCooldowns.set(cooldownKey(provider, credentialKind), entry)
  return entry
}

function getProviderCooldown(provider, credentialKind, nowMs = Date.now()) {
  const entry = providerCooldowns.get(cooldownKey(provider, credentialKind))
  if (!entry) return null
  if (entry.until <= nowMs) {
    providerCooldowns.delete(cooldownKey(provider, credentialKind))
    return null
  }
  return entry
}

function clearProviderCooldowns() {
  providerCooldowns.clear()
}

// ── Governed chat candidate list ─────────────────────────────────────────

function credentialKindFor(provider, authState = {}) {
  const { anthropicApiKey = '', cliOAuthToken = '', vaultCredential = null, allowOAuth = true } = authState
  if (vaultCredential?.provider === provider && vaultCredential?.key) return 'vault'
  if (provider === 'anthropic') {
    if (anthropicApiKey) return 'api_key'
    if (allowOAuth !== false && cliOAuthToken) return 'oauth_cli'
    return 'api_key'
  }
  if (provider === 'local') return 'local'
  return 'api_key'
}

/**
 * LLM-FAILOVER P1: candidate list for one governed chat turn:
 * policy primary, then the declared per-capability fallback chain, then the
 * system default (only when the org policy does not block hidden fallbacks;
 * mirrors the block_hidden_fallbacks gate in llmRoutingPolicy.cjs). Each
 * candidate is annotated with whether SOME auth is configured for its
 * provider (via hasProviderAuth) and which credential kind would be used.
 *
 * @param {{ plan: object|null, policyContext: object|null, authState: object }} opts
 * @returns {Array<{ provider, model, source: 'primary'|'policy_fallback'|'system_default', attemptable: boolean, credentialKind: string }>}
 */
function buildGovernedChatCandidates({ plan, policyContext, authState = {} } = {}) {
  const { hasProviderAuth } = require('./llmRoutingPolicy.cjs')
  const list = []
  const seen = new Set()

  function push(provider, model, source) {
    if (!provider || !model) return
    const key = `${provider}:${model}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ provider, model, source })
  }

  if (plan?.provider && plan?.model) push(plan.provider, plan.model, 'primary')

  if (Array.isArray(policyContext?.policyFallbacks)) {
    for (const fallback of policyContext.policyFallbacks) {
      push(fallback?.provider, fallback?.model, 'policy_fallback')
    }
  }

  // Same gate expression llmRoutingPolicy.cjs uses for its pre-dispatch
  // hidden-fallback scan: system default participates unless the org policy
  // explicitly blocks hidden fallbacks.
  const allowHiddenFallbacks = policyContext?.policyEnabled !== false
    && policyContext?.policyEnforcement?.block_hidden_fallbacks !== false
  if (allowHiddenFallbacks && policyContext?.systemDefault) {
    push(policyContext.systemDefault.provider, policyContext.systemDefault.model, 'system_default')
  }

  for (const candidate of list) {
    candidate.attemptable = hasProviderAuth(candidate.provider, authState)
    candidate.credentialKind = credentialKindFor(candidate.provider, authState)
  }

  return list
}

function buildFailoverMeta(active, attempted) {
  return {
    used_fallback: !!active && active.source !== 'primary',
    active: active
      ? { provider: active.provider, model: active.model, source: active.source }
      : null,
    attempted: attempted.map((entry) => ({ ...entry })),
  }
}

/**
 * LLM-FAILOVER P1: the governed candidate walk.
 *
 * Walks candidates in order:
 *   - attemptable === false        → skipped (reason 'no_credential' or the
 *                                    candidate's own skipReason)
 *   - (provider, kind) in cooldown → skipped (reason 'cooldown')
 *   - otherwise call attempt(candidate); classify failures:
 *       fatal            → abort the walk, rethrow (with .failover attached)
 *       auth_expired     → 24h cooldown, next candidate
 *       quota_exhausted  → cooldown until parsed reset hint or 60min, next
 *       transient        → at most ONE immediate retry on the same
 *                          candidate, then next
 *       rate_limited /
 *       overloaded       → next candidate
 * Total actual provider calls are capped at maxProviderCalls (default 3) so
 * latency stays bounded; candidates beyond the budget are skipped.
 *
 * On success resolves { result, active, attempted, failover }. When every
 * candidate fails, throws Error('all_providers_failed') with .failover and
 * .lastErrorClass attached.
 *
 * @param {{ candidates: Array<object>, attempt: (candidate) => Promise<any>, maxProviderCalls?: number, now?: () => number }} opts
 */
async function executeGovernedFailover({ candidates, attempt, maxProviderCalls = 3, now = Date.now } = {}) {
  const attempted = []
  let calls = 0
  let lastErr = null

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const base = { provider: candidate.provider, model: candidate.model, source: candidate.source }

    if (candidate.attemptable === false) {
      attempted.push({ ...base, outcome: 'skipped', reason: candidate.skipReason || 'no_credential' })
      continue
    }

    const cooldown = getProviderCooldown(candidate.provider, candidate.credentialKind, now())
    if (cooldown) {
      attempted.push({
        ...base,
        outcome: 'skipped',
        reason: 'cooldown',
        error_class: cooldown.errorClass || undefined,
        cooldown_until: new Date(cooldown.until).toISOString(),
      })
      continue
    }

    if (calls >= maxProviderCalls) {
      attempted.push({ ...base, outcome: 'skipped', reason: 'attempt_budget_exhausted' })
      continue
    }

    let retriedTransient = false
    let moveToNextCandidate = false
    while (!moveToNextCandidate) {
      calls += 1
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await attempt(candidate)

        // The CLI dispatcher reports some failures as a structured result
        // (outcome: 'cli_error') instead of throwing. Promote the ones we
        // can classify to failover failures; leave unclassifiable ones as
        // the reply (preserves today's behavior of surfacing the error
        // text) rather than turning them into a 403.
        if (result && typeof result === 'object' && result.outcome === 'cli_error') {
          const resultClass = classifyLlmError(result)
          if (resultClass !== 'fatal') {
            const cliErr = new Error(extractLlmErrorText(result) || 'cli_error')
            cliErr.errorClass = resultClass
            throw cliErr
          }
        }

        attempted.push({ ...base, outcome: 'ok' })
        return { result, active: base, attempted, failover: buildFailoverMeta(base, attempted) }
      } catch (err) {
        lastErr = err
        const errorClass = classifyLlmError(err)
        const entry = { ...base, outcome: 'failed', error_class: errorClass }

        if (errorClass === 'fatal') {
          attempted.push(entry)
          err.failover = buildFailoverMeta(null, attempted)
          throw err
        }

        if (errorClass === 'auth_expired') {
          const until = now() + AUTH_COOLDOWN_MS
          markProviderCooldown(candidate.provider, candidate.credentialKind, {
            until,
            errorClass,
            reason: (err?.message || '').slice(0, 200),
          })
          entry.cooldown_until = new Date(until).toISOString()
          attempted.push(entry)
          moveToNextCandidate = true
          continue
        }

        if (errorClass === 'quota_exhausted') {
          const until = parseResetHint(extractLlmErrorText(err), now()) || (now() + QUOTA_COOLDOWN_DEFAULT_MS)
          markProviderCooldown(candidate.provider, candidate.credentialKind, {
            until,
            errorClass,
            reason: (err?.message || '').slice(0, 200),
          })
          entry.cooldown_until = new Date(until).toISOString()
          attempted.push(entry)
          moveToNextCandidate = true
          continue
        }

        if (errorClass === 'transient' && !retriedTransient && calls < maxProviderCalls) {
          retriedTransient = true
          continue // one immediate retry on the same candidate
        }

        // rate_limited / overloaded / transient after its retry
        attempted.push(entry)
        moveToNextCandidate = true
      }
    }
  }

  const finalErr = new Error('all_providers_failed')
  finalErr.failover = buildFailoverMeta(null, attempted)
  const failedEntries = attempted.filter((entry) => entry.outcome === 'failed')
  finalErr.lastErrorClass = failedEntries.length ? failedEntries[failedEntries.length - 1].error_class : null
  finalErr.lastError = lastErr
  throw finalErr
}

module.exports = {
  buildCandidateChain,
  isRetryableLlmError,
  executeWithFailover,
  // LLM-FAILOVER P1
  classifyLlmError,
  parseResetHint,
  extractLlmErrorText,
  buildGovernedChatCandidates,
  executeGovernedFailover,
  markProviderCooldown,
  getProviderCooldown,
  clearProviderCooldowns,
  QUOTA_COOLDOWN_DEFAULT_MS,
  AUTH_COOLDOWN_MS,
}
