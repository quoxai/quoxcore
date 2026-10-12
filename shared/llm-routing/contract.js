export const EXECUTION_CAPABILITIES = [
  'general_assistant',
  'planning',
  'coding',
  'analysis',
  'research',
  'image_generation',
  'executive_advisory',
]

export const DEFAULT_EXECUTION_POLICY_ENFORCEMENT = {
  allow_user_provider_override: true,
  allow_user_model_override: true,
  credential_selection_priority: true,
  block_hidden_fallbacks: true,
  // Temporary parity gate: when true, non-explicit provider selections
  // (policy_default, personal_preference, assistant_recommendation, system_default)
  // are coerced to a verified provider if the resolved provider lacks full
  // tool/history/consent parity. Remove once all providers reach parity.
  require_explicit_for_non_default_provider: false,
  // LLM-CHOICE Phase 1: default-on. When false at the org policy root (or
  // overridden per-capability via credential_constraints.allow_oauth), the
  // OAuth/CLI credential path is refused even when OAuth creds are present —
  // "prod-critical: no-OAuth" lanes fail toward the fallback chain instead.
  allow_oauth_credentials: true,
}

// Providers with full tool-calling, conversation history, and consent parity.
// Used by require_explicit_for_non_default_provider enforcement.
// Add providers here as they reach parity via executeOpenAICompatibleToolLoop.
export const VERIFIED_PROVIDERS = ['anthropic', 'openai']

// The provider to coerce to when require_explicit_for_non_default_provider fires.
export const PARITY_FALLBACK_PROVIDER = 'anthropic'

export const LLM_POLICY_VERSION = 1

export function getLlmIdentityKey(llm = {}) {
  return `${llm.provider || ''}:${llm.model || ''}`
}

// LLM-CHOICE Phase 1: lightweight prefix-map inference used by the collector
// fast path (agents/invoke no_tools) when a caller supplies only `model`
// without `provider`. Deliberately simpler than
// shared/llm-routing/resolve.js's inferProviderFromModelId (catalog lookup +
// wider provider set) — that function lives in resolve.js, which imports
// this file, so it can't be reused here without a circular import. Keep this
// prefix map in sync with resolve.js's fallback prefixes for the providers
// this file is aware of.
export function inferProviderFromModel(model) {
  if (!model || typeof model !== 'string') return null
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('chatgpt-')) return 'openai'
  if (model.startsWith('gemini-')) return 'gemini'
  if (model.includes('sonar')) return 'perplexity'
  return null
}

