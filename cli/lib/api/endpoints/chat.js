/**
 * 'chat.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const chat = {
  'chat.claude': {
    method: 'POST',
    service: 'collector',
    path: () => `/chat/claude`,
    tags: ['live-write'],
  },
  'chat.status.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/chat/status`,
    tags: ['live-safe'],
  },
  'chat.stream': {
    method: 'STREAM',
    service: 'collector',
    path: () => `/chat/stream`,
    tags: ['live-write'],
  },
  // CLI-QUOX B3: probe an Ollama URL server side (human org admin; GET <url>/api/tags; stores
  // nothing) and list the saved Ollama connection's installed models.
  'chat.providers.ollama.probe': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/providers/ollama/probe`,
    tags: ['live-safe'],
  },
  // QUOXON-MODEL: live model list for the hosted providers (openai | anthropic), server cached 1 h.
  'chat.providers.models': {
    method: 'GET',
    service: 'collector',
    path: ({ provider }) => `/api/v1/providers/${encodeURIComponent(provider)}/models`,
    tags: ['live-safe'],
  },
  'chat.providers.ollama.models': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/providers/ollama/models`,
    tags: ['live-safe'],
  },
  // CLI-QUOX B5: OpenAI-compatible presets. Probe a self-hosted or custom base URL server side
  // (human org admin; stores nothing) and list the saved connection's models (key stays server side).
  'chat.providers.compat.probe': {
    method: 'POST',
    service: 'collector',
    path: ({ preset }) => `/api/v1/providers/compat/${encodeURIComponent(preset)}/probe`,
    tags: ['live-safe'],
  },
  'chat.providers.compat.models': {
    method: 'GET',
    service: 'collector',
    path: ({ preset }) => `/api/v1/providers/compat/${encodeURIComponent(preset)}/models`,
    tags: ['live-safe'],
  },
};
