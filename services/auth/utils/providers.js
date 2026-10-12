/**
 * Canonical Provider Registry (backend mirror) — SET-IA Phase 5b.
 *
 * Source of truth lives here; src/lib/providers.js is the frontend
 * mirror. Keep in sync — there's a test in
 * services/auth/tests/providers-sync.test.js that fails if they
 * drift.
 *
 * Notification providers (Slack/Telegram/SMTP/etc) are out of scope
 * for SET-IA Phase 5 — they live under org integrations and use a
 * different schema.
 */

export const PROVIDERS = Object.freeze([
    {
        id:                 'anthropic',
        displayName:        'Anthropic (Claude)',
        purpose:            'chat',
        instanceConfigKey:  'anthropic_api_key',
        envVar:             'ANTHROPIC_API_KEY',
        keyPrefix:          'sk-ant-',
        supportsTest:       true,
        defaultModel:       'claude-sonnet-4-5',
    },
    {
        id:                 'openai',
        displayName:        'OpenAI',
        purpose:            'chat',
        instanceConfigKey:  'openai_api_key',
        envVar:             'OPENAI_API_KEY',
        keyPrefix:          'sk-',
        supportsTest:       true,
        defaultModel:       'gpt-4o',
    },
    {
        id:                 'gemini',
        aliases:            ['google'],
        displayName:        'Google Gemini',
        purpose:            'chat',
        instanceConfigKey:  'gemini_api_key',
        envVar:             'GEMINI_API_KEY',
        keyPrefix:          'AIza',
        supportsTest:       false,
        defaultModel:       'gemini-2.0-flash',
    },
    {
        id:                 'perplexity',
        displayName:        'Perplexity',
        purpose:            'chat',
        instanceConfigKey:  'perplexity_api_key',
        envVar:             'PERPLEXITY_API_KEY',
        keyPrefix:          'pplx-',
        supportsTest:       false,
        defaultModel:       'sonar-pro',
    },
    {
        id:                 'codex',
        displayName:        'Codex',
        purpose:            'chat',
        instanceConfigKey:  'codex_api_key',
        envVar:             'CODEX_API_KEY',
        keyPrefix:          null,
        supportsTest:       false,
        defaultModel:       null,
    },
    {
        id:                 'elevenlabs',
        displayName:        'ElevenLabs (TTS)',
        purpose:            'voice',
        instanceConfigKey:  'elevenlabs_api_key',
        envVar:             'ELEVENLABS_API_KEY',
        keyPrefix:          null,
        supportsTest:       false,
        defaultModel:       null,
    },
]);

const byId = new Map();
for (const p of PROVIDERS) {
    byId.set(p.id, p);
    for (const alias of p.aliases || []) byId.set(alias, p);
}

export function getProvider(id) {
    return byId.get(id) || null;
}

export function listProviderIds() {
    return PROVIDERS.map(p => p.id);
}

export function keyMatchesPrefix(providerId, key) {
    const p = byId.get(providerId);
    if (!p || !p.keyPrefix) return true;
    return typeof key === 'string' && key.startsWith(p.keyPrefix);
}

export default PROVIDERS;
