/**
 * Model Catalog — Single Source of Truth for LLM Providers & Models
 *
 * All provider/model definitions live here. llmService.js derives
 * LLM_PROVIDERS from this catalog (adding runtime config key mapping).
 *
 * Fields per provider: id, name, vaultType, models[]
 * Fields per model: id, name, tier (fast/smart/frontier), contextWindow, default?
 *
 * Used by ModelSelector, CredentialPicker, llmService, agent config, and tests.
 */

export const MODEL_CATALOG = {
    anthropic: {
        id: 'anthropic',
        name: 'Anthropic (Claude)',
        vaultType: 'anthropic',
        models: [
            { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'frontier', contextWindow: 200000 },
            { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'frontier', contextWindow: 200000 },
            { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'smart', contextWindow: 200000, default: true },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (legacy)', tier: 'smart', contextWindow: 200000 },
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'frontier', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tier: 'fast', contextWindow: 200000 },
            { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'smart', contextWindow: 200000 },
            { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', tier: 'frontier', contextWindow: 200000 },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', tier: 'fast', contextWindow: 200000 },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', tier: 'smart', contextWindow: 200000 }
        ]
    },
    openai: {
        id: 'openai',
        name: 'OpenAI',
        vaultType: 'openai',
        models: [
            { id: 'gpt-5.4', name: 'GPT-5.4', tier: 'frontier', contextWindow: 1050000, default: true },
            { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', tier: 'smart', contextWindow: 400000 },
            { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', tier: 'fast', contextWindow: 400000 }
        ]
    },
    gemini: {
        id: 'gemini',
        name: 'Google Gemini',
        vaultType: 'gemini',
        models: [
            // QUOXHAT P3 live finding (2026-10-01): Google retired gemini-2.0-flash
            // ("This model ... is no longer available. Please update your code to
            // use models/gemini-3.8-flash") — with it as catalog default, EVERY
            // gemini chat turn 404'd. gemini-3.8-flash is the replacement Google's
            // own error names; it is the new default.
            { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', tier: 'fast', contextWindow: 1000000, default: true },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'frontier', contextWindow: 1048576 },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (retired by Google)', tier: 'fast', contextWindow: 1000000 },
            { id: 'gemini-2.5-flash-image', name: 'Gemini Flash Image', tier: 'fast', contextWindow: 1000000 },
            { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', tier: 'smart', contextWindow: 2000000 },
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', tier: 'fast', contextWindow: 1000000 }
        ]
    },
    perplexity: {
        id: 'perplexity',
        name: 'Perplexity',
        vaultType: 'perplexity',
        models: [
            { id: 'sonar-pro', name: 'Sonar Pro', tier: 'frontier', contextWindow: 200000 },
            { id: 'llama-3.1-sonar-large-128k-online', name: 'Sonar Large (Online)', tier: 'smart', contextWindow: 128000, default: true },
            { id: 'llama-3.1-sonar-small-128k-online', name: 'Sonar Small (Online)', tier: 'fast', contextWindow: 128000 },
            { id: 'llama-3.1-sonar-large-128k-chat', name: 'Sonar Large (Chat)', tier: 'smart', contextWindow: 128000 },
            { id: 'llama-3.1-sonar-small-128k-chat', name: 'Sonar Small (Chat)', tier: 'fast', contextWindow: 128000 }
        ]
    },
    groq: {
        id: 'groq',
        name: 'Groq',
        vaultType: 'groq',
        models: [
            { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B', tier: 'smart', contextWindow: 131072, default: true },
            { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', tier: 'fast', contextWindow: 131072 },
            { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', tier: 'smart', contextWindow: 32768 }
        ]
    },
    mistral: {
        id: 'mistral',
        name: 'Mistral AI',
        vaultType: 'mistral',
        models: [
            { id: 'mistral-large-latest', name: 'Mistral Large', tier: 'frontier', contextWindow: 128000, default: true },
            { id: 'mistral-medium-latest', name: 'Mistral Medium', tier: 'smart', contextWindow: 32000 },
            { id: 'mistral-small-latest', name: 'Mistral Small', tier: 'fast', contextWindow: 32000 },
            { id: 'open-mixtral-8x22b', name: 'Mixtral 8x22B', tier: 'smart', contextWindow: 65536 }
        ]
    },
    xai: {
        id: 'xai',
        name: 'xAI (Grok)',
        vaultType: 'xai',
        models: [
            { id: 'grok-2', name: 'Grok 2', tier: 'smart', contextWindow: 131072, default: true },
            { id: 'grok-2-mini', name: 'Grok 2 Mini', tier: 'fast', contextWindow: 131072 }
        ]
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        vaultType: 'deepseek',
        models: [
            { id: 'deepseek-chat', name: 'DeepSeek V3', tier: 'smart', contextWindow: 64000, default: true },
            { id: 'deepseek-reasoner', name: 'DeepSeek R1', tier: 'frontier', contextWindow: 64000 }
        ]
    },
    together: {
        id: 'together',
        name: 'Together AI',
        vaultType: 'together',
        models: [
            { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B Turbo', tier: 'smart', contextWindow: 131072, default: true },
            { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo', tier: 'fast', contextWindow: 131072 },
            { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B', tier: 'smart', contextWindow: 32768 }
        ]
    }
};

// ─── Dynamic Provider Support ─────────────────────────────────────────
// Local inference models are discovered at runtime and injected here.
// The _dynamicProviders map is populated by the Local Inference settings panel
// as it loads each configured source's model list.
//
// LICENSE-LAUNCH LL-7 local-inference strip: the map hangs off `window` rather
// than module scope, and that is required rather than tidy. The panel that
// calls registerDynamicProvider now ships INSIDE the signed local-inference
// bundle, which compiles its own copy of this module — so with a module-scope
// object the bundle would register local models into a map the dashboard's
// model pickers never read, and an entitled customer's discovered models would
// simply not appear. Same defect class, same fix, as capabilityPanelRegistry's
// window-scoped Map (a8ce9ec4) and the shared contexts (63de032d): one host,
// one instance. Falls back to a module-local object under Node/SSR, where
// there is no window and only ever one copy anyway.
const _dynamicProviders = (() => {
    if (typeof window === 'undefined') return {};
    if (!window.__quoxDynamicModelProviders) window.__quoxDynamicModelProviders = {};
    return window.__quoxDynamicModelProviders;
})();

/**
 * Register a dynamic provider (e.g. local inference).
 * Dynamic providers have isDynamic: true and models populated at runtime.
 * @param {string} providerId
 * @param {Object} providerEntry - { id, name, vaultType, isDynamic, models[] }
 */
export function registerDynamicProvider(providerId, providerEntry) {
    _dynamicProviders[providerId] = { ...providerEntry, isDynamic: true };
}

/**
 * Remove a dynamic provider
 * @param {string} providerId
 */
export function unregisterDynamicProvider(providerId) {
    delete _dynamicProviders[providerId];
}

/**
 * Get all models for a given provider (static or dynamic)
 * @param {string} providerId
 * @returns {Array} Models array or empty array
 */
export function getModelsForProvider(providerId) {
    return MODEL_CATALOG[providerId]?.models || _dynamicProviders[providerId]?.models || [];
}

/**
 * Get the default model for a provider
 * @param {string} providerId
 * @returns {Object|null} Default model or null
 */
export function getDefaultModel(providerId) {
    const models = getModelsForProvider(providerId);
    return models.find(m => m.default) || models[0] || null;
}

/**
 * Get a specific model by provider and model ID
 * @param {string} providerId
 * @param {string} modelId
 * @returns {Object|null} Model object or null
 */
export function getModelById(providerId, modelId) {
    const models = getModelsForProvider(providerId);
    return models.find(m => m.id === modelId) || null;
}

/**
 * Get all provider IDs
 * @returns {string[]}
 */
export function getAllProviderIds() {
    return [...Object.keys(MODEL_CATALOG), ...Object.keys(_dynamicProviders)];
}

/**
 * Get provider metadata (without models)
 * @param {string} providerId
 * @returns {Object|null} { id, name, vaultType } or null
 */
export function getProviderMeta(providerId) {
    const provider = MODEL_CATALOG[providerId] || _dynamicProviders[providerId];
    if (!provider) return null;
    return { id: provider.id, name: provider.name, vaultType: provider.vaultType, isDynamic: provider.isDynamic || false };
}
