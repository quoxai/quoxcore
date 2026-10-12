/**
 * LLM Service - Manages available LLM providers and models
 *
 * Fetches configured API keys from backend and provides
 * a list of available LLM options for assistant configuration.
 *
 * Model/provider data is sourced from MODEL_CATALOG (single source of truth).
 * This service adds runtime concerns: API key detection, caching, validation.
 */

import { MODEL_CATALOG } from '../config/modelCatalog.js';

// Maps provider IDs to backend config key names (from /api/setup/config)
const PROVIDER_CONFIG_KEYS = {
  anthropic:  'hasAnthropicKey',
  openai:     'hasOpenaiKey',
  gemini:     'hasGeminiKey',
  perplexity: 'hasPerplexityKey',
  groq:       'hasGroqKey',
  mistral:    'hasMistralKey',
  xai:        'hasXaiKey',
  deepseek:   'hasDeepseekKey',
  together:   'hasTogetherKey',
};

// LLM_PROVIDERS derived from MODEL_CATALOG + config keys (backwards-compatible export)
export const LLM_PROVIDERS = Object.fromEntries(
  Object.entries(MODEL_CATALOG).map(([id, provider]) => [
    id,
    { ...provider, configKey: PROVIDER_CONFIG_KEYS[id] || `has${id.charAt(0).toUpperCase() + id.slice(1)}Key` }
  ])
);

// Default LLM configuration
export const DEFAULT_LLM_CONFIG = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 4096
};

// Cache for configured providers
let configuredProvidersCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Fetch which LLM providers are configured (have API keys set)
 */
export async function getConfiguredProviders() {
  const now = Date.now();

  // Return cached if valid
  if (configuredProvidersCache && (now - cacheTimestamp) < CACHE_TTL) {
    return configuredProvidersCache;
  }

  try {
    const res = await fetch('/api/setup/config');
    if (!res.ok) {
      console.error('Failed to fetch config status');
      return getDefaultProviders();
    }

    const data = await res.json();
    const keys = data.keys || {};

    // Build list of configured providers (checks all providers in catalog)
    const configured = [];
    for (const [providerId, provider] of Object.entries(LLM_PROVIDERS)) {
      const configKey = provider.configKey;
      if (configKey && keys[configKey]) {
        configured.push({
          ...provider,
          configured: true
        });
      }
    }

    // Always include the generic default provider as fallback even if not configured
    // (it remains selectable and might be configured elsewhere like env vars)
    if (!configured.find(p => p.id === DEFAULT_LLM_CONFIG.provider)) {
      configured.unshift({
        ...LLM_PROVIDERS[DEFAULT_LLM_CONFIG.provider],
        configured: false,
        fallback: true
      });
    }

    configuredProvidersCache = configured;
    cacheTimestamp = now;

    return configured;
  } catch (err) {
    console.error('Error fetching LLM config:', err);
    return getDefaultProviders();
  }
}

/**
 * Get default providers when API is unavailable
 */
function getDefaultProviders() {
  return [{
    ...LLM_PROVIDERS[DEFAULT_LLM_CONFIG.provider],
    configured: true,
    fallback: true
  }];
}

/**
 * Get all available providers (configured + not configured for display)
 */
export async function getAllProviders() {
  const configured = await getConfiguredProviders();
  const configuredIds = new Set(configured.map(p => p.id));

  const all = [...configured];

  // Add unconfigured providers (greyed out in UI)
  for (const [providerId, provider] of Object.entries(LLM_PROVIDERS)) {
    if (!configuredIds.has(providerId)) {
      all.push({
        ...provider,
        configured: false
      });
    }
  }

  return all;
}

/**
 * Get models for a specific provider
 */
export function getModelsForProvider(providerId) {
  const provider = LLM_PROVIDERS[providerId];
  if (!provider) return [];
  return provider.models;
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(providerId) {
  const models = getModelsForProvider(providerId);
  const defaultModel = models.find(m => m.default);
  return defaultModel?.id || models[0]?.id || null;
}

/**
 * Validate LLM configuration
 */
export function validateLLMConfig(llmConfig) {
  if (!llmConfig) return { valid: false, error: 'No LLM configuration' };

  const { provider, model } = llmConfig;

  if (!provider || !LLM_PROVIDERS[provider]) {
    return { valid: false, error: `Invalid provider: ${provider}` };
  }

  const models = getModelsForProvider(provider);
  if (model && !models.find(m => m.id === model)) {
    return { valid: false, error: `Invalid model ${model} for provider ${provider}` };
  }

  return { valid: true };
}

/**
 * Get display name for provider
 */
export function getProviderDisplayName(providerId) {
  return LLM_PROVIDERS[providerId]?.name || providerId;
}

/**
 * Get display name for model
 */
export function getModelDisplayName(providerId, modelId) {
  const models = getModelsForProvider(providerId);
  const model = models.find(m => m.id === modelId);
  return model?.name || modelId;
}

/**
 * Clear the provider cache (call when config changes)
 */
export function clearProviderCache() {
  configuredProvidersCache = null;
  cacheTimestamp = 0;
}

export default {
  LLM_PROVIDERS,
  DEFAULT_LLM_CONFIG,
  getConfiguredProviders,
  getAllProviders,
  getModelsForProvider,
  getDefaultModel,
  validateLLMConfig,
  getProviderDisplayName,
  getModelDisplayName,
  clearProviderCache
};
