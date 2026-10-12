/**
 * Canonical Provider Registry — SET-IA Phase 5b.
 *
 * Single source of truth for AI/inference provider metadata. All five
 * pre-existing fragmented lists (INTEGRATION_FIELD_MAP in admin.js,
 * PRIMARY_CHAT_INTEGRATIONS / OTHER_INTEGRATIONS in CoreIntegrations,
 * AdminKeys hardcoded select, PROVIDER_TYPE_MAP +
 * PROVIDER_INSTANCE_KEY_MAP in credentialResolver) collapse to this.
 *
 * Notification providers (Slack/Telegram/etc) are out of scope for
 * SET-IA Phase 5 — they live under org integrations and are typed
 * differently.
 *
 * Backend imports this via the same path through Vite's resolver +
 * a Node ESM shim — keep it pure-data-with-a-tiny-helper.
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

/**
 * Look up a provider by its canonical id or alias.
 * Returns null for unknown ids — callers should fail closed.
 */
export function getProvider(id) {
    return byId.get(id) || null;
}

/**
 * List provider ids (canonical only, no aliases) — for iteration.
 */
export function listProviderIds() {
    return PROVIDERS.map(p => p.id);
}

/**
 * Validate an API key against the provider's prefix rule.
 * Returns true when there is no prefix rule (we don't gatekeep).
 */
export function keyMatchesPrefix(providerId, key) {
    const p = byId.get(providerId);
    if (!p || !p.keyPrefix) return true;
    return typeof key === 'string' && key.startsWith(p.keyPrefix);
}

export default PROVIDERS;
