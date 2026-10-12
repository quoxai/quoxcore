const READINESS_REASON_META = {
  collector_unavailable: {
    title: 'Collector unavailable',
    message: 'Chat service unavailable. Ensure the collector service is running before starting chat.',
    action: 'Start or restore the collector service, then retry.',
  },
  status_check_failed: {
    title: 'Status check failed',
    message: 'Collector status could not be checked.',
    action: 'Check collector health and logs, then retry.',
  },
  node_pty_unavailable: {
    title: 'PTY support unavailable',
    message: 'Claude terminal login is unavailable because PTY support is not installed in the collector runtime.',
    action: 'Install build tooling so node-pty can compile, or use the supported container deployment.',
  },
  claude_cli_missing: {
    title: 'Claude CLI missing',
    message: 'Claude terminal login is unavailable because the Claude CLI is not installed.',
    action: 'Install Claude Code CLI, or use an OpenAI or Anthropic API key instead.',
  },
  claude_cli_unhealthy: {
    title: 'Claude CLI unhealthy',
    message: 'Claude terminal login is unavailable because the Claude CLI is not responding correctly.',
    action: 'Repair the CLI runtime, or use an OpenAI or Anthropic API key instead.',
  },
  provider_unconfigured: {
    title: 'No provider configured',
    message: 'No chat-capable provider is configured.',
    action: 'Add an OpenAI or Anthropic API key, or authenticate Claude in Core Integrations.',
  },
  auth_service_unavailable: {
    title: 'Auth service unavailable',
    message: 'Setup cannot continue because the authentication service is unreachable.',
    action: 'Ensure the auth service is running and the frontend can reach /api/setup/status, then retry.',
  },
  session_expired: {
    title: 'Session expired',
    message: 'Your session has expired or is no longer valid. The chat service itself is running.',
    action: 'Sign out and sign back in, then retry.',
  },
}

export function getReadinessReasonMeta(reason, detail = null) {
  const base = READINESS_REASON_META[reason] || {
    title: 'Service unavailable',
    message: 'A required service is unavailable.',
    action: 'Check service health and retry.',
  }

  return {
    code: reason || 'unknown',
    title: base.title,
    message: base.message,
    action: base.action,
    detail: detail || null,
  }
}

function normalizeTerminalCapability(capability) {
  if (!capability) return null
  const readiness = getReadinessReasonMeta(capability.reason || null, capability.detail || null)
  return {
    available: capability.available !== false,
    reason: capability.reason || null,
    recommendation: capability.recommendation || readiness.message,
    detail: capability.detail || null,
    readiness,
  }
}

export function getSessionExpiredStatus(error = 'Session expired') {
  const readiness = getReadinessReasonMeta('session_expired', error)
  return {
    ready: false,
    authMethod: 'unauthenticated',
    recommendation: readiness.message,
    loading: false,
    error,
    readiness,
  }
}

export function getCollectorUnavailableStatus(error = 'Chat service unavailable') {
  const readiness = getReadinessReasonMeta('collector_unavailable', error)
  return {
    ready: false,
    authMethod: 'unavailable',
    recommendation: readiness.message,
    loading: false,
    error,
    readiness,
    capabilities: {
      terminalOAuth: {
        available: false,
        reason: 'collector_unavailable',
        recommendation: 'Claude terminal login is unavailable because the collector service is unreachable.',
        detail: error,
        readiness: getReadinessReasonMeta('collector_unavailable', error),
      },
    },
  }
}

export function normalizeLlmStatusPayload(data) {
  const terminalCapability = normalizeTerminalCapability(
    data?.capabilities?.terminal_oauth
    || data?.capabilities?.terminalOAuth
    || data?.terminal_oauth
    || data?.terminalOAuth
  )

  const readiness = data?.ready
    ? null
    : getReadinessReasonMeta(
      terminalCapability?.reason || (data?.auth_method === 'none' ? 'provider_unconfigured' : null),
      terminalCapability?.detail || null
    )

  return {
    ready: !!data?.ready,
    authMethod: data?.auth_method || data?.authMethod || null,
    recommendation: data?.recommendation || null,
    loading: false,
    error: null,
    debug: data?.debug || null,
    readiness,
    // LLM-FAILOVER P2 (UX audit A1): degraded-but-working signal, additive.
    degraded: !!data?.degraded,
    degradedReason: data?.degraded_reason || null,
    degradedUntil: data?.degraded_until || null,
    fallbackHint: data?.fallback_hint || null,
    // UI-10: per-provider connection flags + CLI-specific status. The
    // single authMethod was masking CLI auth whenever another provider
    // (e.g. OpenAI) took priority in the auth chain, making the Claude
    // Subscription badge in settings show "Not Connected" even when the
    // CLI was happily authenticated.
    providers: data?.providers || null,
    cliCredentials: data?.cli_credentials || null,
    // DEVSUITE-DEVMODE 5c: codex CLI status for the Codex Subscription
    // settings item ({ installed, authenticated }).
    codexCli: data?.codex_cli || null,
    capabilities: {
      terminalOAuth: terminalCapability,
    },
  }
}

export function describeSetupStatusFailure(error) {
  const detail = error?.message || String(error || 'Unknown error')
  const lower = detail.toLowerCase()

  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('fetch')) {
    return getReadinessReasonMeta('auth_service_unavailable', detail)
  }

  if (lower.includes('http 5')) {
    return getReadinessReasonMeta('auth_service_unavailable', detail)
  }

  return getReadinessReasonMeta('auth_service_unavailable', detail)
}
