/**
 * Local Model Registry
 *
 * Manages local inference sources (Ollama, vLLM, llama.cpp, NVIDIA NIM)
 * and their discovered models. Sources are stored in localStorage with
 * runtime-discovered model lists.
 *
 * This is the core service for the Local Inference plugin.
 */

const STORAGE_KEY = 'quox_local_inference_sources';
const DETECTION_TIMEOUT_MS = 5000;

// ─── Model Normalisation ─────────────────────────────────────────────

/**
 * Normalise Ollama /api/tags response into standard model format
 */
export function normaliseOllamaModels(response) {
    if (!response?.models || !Array.isArray(response.models)) return [];
    return response.models.map(m => ({
        id: m.name || m.model,
        name: m.name || m.model,
        sizeBytes: m.size || null,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null,
        family: m.details?.family || null,
        contextWindow: null,
        type: 'chat'
    }));
}

/**
 * Normalise OpenAI-compatible /v1/models response into standard model format
 * Works for vLLM, llama.cpp, and NVIDIA NIM
 */
export function normaliseOpenAIModels(response) {
    if (!response?.data || !Array.isArray(response.data)) return [];
    return response.data.map(m => ({
        id: m.id,
        name: m.id,
        ownedBy: m.owned_by || null,
        contextWindow: null,
        type: 'chat'
    }));
}

// ─── Backend Detection ───────────────────────────────────────────────

/**
 * Detect backend type by probing endpoints.
 * Tries Ollama-specific /api/tags first, then generic /v1/models.
 *
 * @param {string} baseUrl - Base URL of the inference server
 * @param {Function} fetchFn - Fetch function (injectable for testing)
 * @returns {Promise<string|null>} 'ollama', 'openai-compatible', or null
 */
export async function detectBackendType(baseUrl, fetchFn = fetch) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DETECTION_TIMEOUT_MS);

    try {
        // Try Ollama first
        const ollamaRes = await fetchFn(`${baseUrl}/api/tags`, {
            signal: controller.signal
        });
        if (ollamaRes.ok) {
            clearTimeout(timeout);
            return 'ollama';
        }
    } catch {
        // Ollama endpoint not available, try OpenAI-compatible
    }

    try {
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), DETECTION_TIMEOUT_MS);
        const openaiRes = await fetchFn(`${baseUrl}/v1/models`, {
            signal: controller2.signal
        });
        clearTimeout(timeout2);
        if (openaiRes.ok) {
            return 'openai-compatible';
        }
    } catch {
        // Neither endpoint available
    }

    clearTimeout(timeout);
    return null;
}

// ─── Connection Test ─────────────────────────────────────────────────

/**
 * Test connection to an inference server and discover models.
 *
 * @param {string} baseUrl - Server base URL
 * @param {string} backendType - 'auto', 'ollama', 'vllm', 'llamacpp', 'nim'
 * @param {string|null} authToken - Optional auth token
 * @param {Function} fetchFn - Fetch function (injectable for testing)
 * @returns {Promise<Object>} { success, backendType, models, latencyMs, error? }
 */
export async function testConnection(baseUrl, backendType = 'auto', authToken = null, fetchFn = fetch) {
    const start = Date.now();
    const headers = {};
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    const fetchOpts = {
        headers,
        signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS)
    };

    // Determine which endpoint to hit
    let resolvedType = backendType;
    if (backendType === 'auto') {
        resolvedType = await detectBackendType(baseUrl, fetchFn);
        if (!resolvedType) {
            return {
                success: false,
                error: `Cannot reach inference server at ${baseUrl}. Neither /api/tags nor /v1/models responded.`,
                latencyMs: Date.now() - start
            };
        }
    }

    try {
        let models = [];
        if (resolvedType === 'ollama') {
            const res = await fetchFn(`${baseUrl}/api/tags`, fetchOpts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            models = normaliseOllamaModels(data);
        } else {
            // vllm, llamacpp, nim, openai-compatible all use /v1/models
            const res = await fetchFn(`${baseUrl}/v1/models`, fetchOpts);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            models = normaliseOpenAIModels(data);
        }

        return {
            success: true,
            backendType: resolvedType,
            models,
            latencyMs: Date.now() - start
        };
    } catch (err) {
        return {
            success: false,
            backendType: resolvedType,
            error: err.message || 'Connection failed',
            latencyMs: Date.now() - start
        };
    }
}

// ─── Source Registry ─────────────────────────────────────────────────

/**
 * Create a local model registry instance.
 * Manages inference sources and their discovered models.
 *
 * @returns {Object} Registry API
 */
export function createLocalModelRegistry() {
    let sources = [];
    let modelsBySource = {};

    // Load from localStorage if available
    try {
        const stored = typeof localStorage !== 'undefined'
            ? localStorage.getItem(STORAGE_KEY)
            : null;
        if (stored) {
            const parsed = JSON.parse(stored);
            sources = parsed.sources || [];
            modelsBySource = parsed.modelsBySource || {};
        }
    } catch {
        // localStorage not available or corrupt
    }

    function persist() {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ sources, modelsBySource }));
            }
        } catch {
            // localStorage quota or unavailable
        }
    }

    return {
        /**
         * Get all configured sources
         */
        getSources() {
            return [...sources];
        },

        /**
         * Get a single source by ID
         */
        getSource(id) {
            return sources.find(s => s.id === id) || null;
        },

        /**
         * Add an inference source.
         * @param {Object} source - { id, name, baseUrl, backendType, authToken?, dataResidencyTag?, maxConcurrency? }
         * @param {Object} opts - { maxSources? } tier limits
         * @returns {Object} { success: true } or { error: string }
         */
        addSource(source, opts = {}) {
            const { maxSources = -1 } = opts;
            if (maxSources !== -1 && sources.length >= maxSources) {
                return { error: `Source limit reached (${maxSources}). Upgrade to add more sources.` };
            }
            if (sources.find(s => s.id === source.id)) {
                return { error: `Source with ID '${source.id}' already exists.` };
            }
            sources.push({
                id: source.id,
                name: source.name,
                baseUrl: source.baseUrl,
                backendType: source.backendType || 'auto',
                authToken: source.authToken || null,
                dataResidencyTag: source.dataResidencyTag || 'local',
                maxConcurrency: source.maxConcurrency || 1,
                createdAt: new Date().toISOString(),
                lastHealthCheck: null,
                healthy: null
            });
            persist();
            return { success: true };
        },

        /**
         * Update an existing source
         */
        updateSource(id, updates) {
            const idx = sources.findIndex(s => s.id === id);
            if (idx === -1) return { error: `Source '${id}' not found.` };
            sources[idx] = { ...sources[idx], ...updates, id }; // id cannot change
            persist();
            return { success: true };
        },

        /**
         * Remove a source and its models
         */
        removeSource(id) {
            sources = sources.filter(s => s.id !== id);
            delete modelsBySource[id];
            persist();
        },

        /**
         * Store discovered models for a source
         */
        setModels(sourceId, models) {
            modelsBySource[sourceId] = models;
            persist();
        },

        /**
         * Get models for a specific source
         */
        getModels(sourceId) {
            return modelsBySource[sourceId] || [];
        },

        /**
         * Get all models from all sources, tagged with sourceId
         */
        getAllModels() {
            const all = [];
            for (const source of sources) {
                const models = modelsBySource[source.id] || [];
                for (const model of models) {
                    all.push({ ...model, sourceId: source.id, sourceName: source.name });
                }
            }
            return all;
        },

        /**
         * Convert registry state into a modelCatalog-compatible provider entry.
         * This allows local models to appear alongside cloud providers.
         */
        toModelCatalogFormat() {
            const allModels = this.getAllModels();
            return {
                id: 'local',
                name: 'Local Inference',
                vaultType: 'local_inference',
                isDynamic: true,
                models: allModels.map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    tier: 'smart', // local models default to 'smart' tier
                    contextWindow: m.contextWindow || 4096,
                    sourceId: m.sourceId,
                    sourceName: m.sourceName,
                    backendType: sources.find(s => s.id === m.sourceId)?.backendType || 'unknown'
                }))
            };
        },

        /**
         * Update health status for a source
         */
        setHealthStatus(sourceId, healthy, lastCheck = new Date().toISOString()) {
            const idx = sources.findIndex(s => s.id === sourceId);
            if (idx !== -1) {
                sources[idx].healthy = healthy;
                sources[idx].lastHealthCheck = lastCheck;
                persist();
            }
        }
    };
}

// ─── Singleton Instance ──────────────────────────────────────────────

let _registry = null;

/**
 * Get the shared local model registry instance
 */
export function getLocalModelRegistry() {
    if (!_registry) {
        _registry = createLocalModelRegistry();
    }
    return _registry;
}

export default {
    createLocalModelRegistry,
    getLocalModelRegistry,
    normaliseOllamaModels,
    normaliseOpenAIModels,
    detectBackendType,
    testConnection
};
