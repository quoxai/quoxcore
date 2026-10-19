import {
  DEFAULT_EXECUTION_POLICY_ENFORCEMENT,
  LLM_POLICY_VERSION,
  VERIFIED_PROVIDERS,
  PARITY_FALLBACK_PROVIDER,
} from './contract.js'

const SEED_POLICY = Object.freeze({
  version: LLM_POLICY_VERSION,
  policy_id: 'seed-default',
  enabled: true,
  metadata: {
    label: 'Seed execution policy',
    source: 'codebase_seed',
  },
  enforcement: {
    ...DEFAULT_EXECUTION_POLICY_ENFORCEMENT,
    require_explicit_for_non_default_provider: true,
  },
  system_default: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
  },
  capabilities: {
    general_assistant: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'General assistant',
      policyLabel: 'General assistant default',
    },
    planning: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'Planning',
      policyLabel: 'Planning default',
    },
    coding: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'Coding',
      policyLabel: 'Coding default',
    },
    analysis: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'Analysis',
      policyLabel: 'Analysis default',
    },
    research: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'Research',
      policyLabel: 'Research default',
    },
    image_generation: {
      primary: { provider: 'gemini', model: 'gemini-2.5-flash-image' },
      fallbacks: [],
      allow_user_override: true,
      capabilityLabel: 'Image generation',
      policyLabel: 'Image generation default',
    },
    executive_advisory: {
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      // LLM-CHOICE P1: declared (governance-visible) fallback so OpenAI-only
      // deployments keep working — replaces the old hardcoded last-resort.
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
      allow_user_override: true,
      capabilityLabel: 'Executive advisory',
      policyLabel: 'Executive advisory default',
    },
  },
})

export function getSeedLlmRoutingPolicy() {
  return structuredClone(SEED_POLICY)
}
