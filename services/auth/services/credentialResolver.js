/**
 * Credential Resolver Service — QuoxVault
 *
 * Waterfall credential resolution (SET-IA Phase 5b):
 *   1. User scope (api_keys, scope_type='user') — ONLY when caller
 *      passes options.userId AND keys.allow_user_byok is true
 *   2. Org scope (integration_credentials, vault) — ONLY when
 *      keys.allow_org_override is true (default true)
 *   3. Instance config (global instance keys)
 *   4. Environment variables
 *
 * Pre-Phase-5b the user branch did not exist and the policy flags
 * were stored-but-unenforced. Honour them here is the load-bearing
 * change; the frontend ProviderKeysPanel (5c) builds on top.
 *
 * Every resolution call updates last_used_at for usage tracking.
 */

import { getDb, prepare } from '../db/index.js';
import { decrypt } from '../utils/encryption.js';
import { getDefaultCredential, listCredentials, updateLastUsed, getAgentCredential, getDecryptedCredential } from '../db/integrations.js';
import { selectCredentialForRepo } from './credentialScopeMatcher.js';
import { evaluateLeaseGate } from '../lib/leaseGate.js';
import { writeCredentialReleaseAudit, writeLeaseAccessAudit } from '../lib/credentialReleaseAudit.js';

// Cache resolved credentials for 30s to match existing CLAUDE_KEYS_CACHE_TTL
const CACHE_TTL_MS = 30_000;
// STABILITY-AUDITS: the Map previously only shrank when a caller happened
// to re-GET an already-expired key (getCached()'s lazy delete on read).
// Multi-tenant traffic resolving many distinct org/user/provider/repo
// combinations within a 30s window would otherwise grow this Map without
// bound. Cap it — Map preserves insertion order, so evicting the oldest
// entry first approximates the entries closest to TTL expiry anyway.
const MAX_CACHE_ENTRIES = 500;
const _cache = new Map();

// Provider name → integration_type mapping
const PROVIDER_TYPE_MAP = {
    anthropic: 'anthropic',
    openai: 'openai',
    perplexity: 'perplexity',
    gemini: 'gemini',
    google: 'gemini',
    elevenlabs: 'elevenlabs',
    // Research web search keys (vault only, no instance_config or env slot)
    brave: 'brave',
    tavily: 'tavily',
    // Notification providers
    slack: 'slack',
    telegram: 'telegram',
    discord: 'discord',
    smtp: 'smtp',
    // Expanded channel drivers (Phase 4)
    msteams: 'msteams',
    twilio: 'twilio',
    sms: 'twilio',
    pagerduty: 'pagerduty',
    opsgenie: 'opsgenie',
    mattermost: 'mattermost',
    ntfy: 'ntfy',
    pushover: 'pushover',
    webhook: 'webhook',
    // Phase 4 expansion (batch 2)
    'google-chat': 'google-chat',
    googlechat: 'google-chat',
    gotify: 'gotify',
    rocketchat: 'rocketchat',
    line: 'line'
};

// Provider name → instance_config key mapping
const PROVIDER_INSTANCE_KEY_MAP = {
    anthropic: 'anthropic_api_key',
    openai: 'openai_api_key',
    perplexity: 'perplexity_api_key',
    gemini: 'gemini_api_key',
    elevenlabs: 'elevenlabs_api_key'
};

// Provider name → env var mapping
const PROVIDER_ENV_MAP = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    gemini: 'GEMINI_API_KEY',
    elevenlabs: 'ELEVENLABS_API_KEY',
    // VAULT-INTEG P3: routes/updates.js's GitHub release-check used to read
    // process.env.GITHUB_TOKEN directly under a comment claiming "from
    // QuoxVault" — this makes that true via the same waterfall every other
    // provider key here uses (org vault -> instance_config -> env). 'github'
    // is not in PROVIDER_INSTANCE_KEY_MAP (no instance_config slot exists
    // for it yet), so step 3 is a no-op and this falls straight from the
    // org vault to this env var, same as before but no longer bypassing the
    // vault.
    github: 'GITHUB_TOKEN'
};

// Notification channel → env var mappings
const NOTIFICATION_ENV_MAP = {
    slack: { webhook: 'NOTIFICATION_SLACK_WEBHOOK' },
    telegram: { token: 'NOTIFICATION_TELEGRAM_TOKEN' },
    discord: { webhook: 'NOTIFICATION_DISCORD_WEBHOOK' },
    smtp: {
        host: 'NOTIFICATION_SMTP_HOST',
        port: 'NOTIFICATION_SMTP_PORT',
        user: 'NOTIFICATION_SMTP_USER',
        pass: 'NOTIFICATION_SMTP_PASS',
        from: 'NOTIFICATION_SMTP_FROM'
    },
    // Phase 4 expanded channels
    msteams: { webhook_url: 'NOTIFICATION_MSTEAMS_WEBHOOK' },
    twilio: {
        account_sid: 'NOTIFICATION_TWILIO_ACCOUNT_SID',
        auth_token: 'NOTIFICATION_TWILIO_AUTH_TOKEN',
        from_number: 'NOTIFICATION_TWILIO_FROM_NUMBER'
    },
    pagerduty: { routing_key: 'NOTIFICATION_PAGERDUTY_ROUTING_KEY' },
    opsgenie: { api_key: 'NOTIFICATION_OPSGENIE_API_KEY' },
    mattermost: { webhook_url: 'NOTIFICATION_MATTERMOST_WEBHOOK' },
    ntfy: {
        server_url: 'NOTIFICATION_NTFY_SERVER',
        topic: 'NOTIFICATION_NTFY_TOPIC'
    },
    pushover: {
        app_token: 'NOTIFICATION_PUSHOVER_APP_TOKEN',
        user_key: 'NOTIFICATION_PUSHOVER_USER_KEY'
    },
    webhook: {
        url: 'NOTIFICATION_WEBHOOK_URL',
        secret: 'NOTIFICATION_WEBHOOK_SECRET'
    },
    // Phase 4 expansion (batch 2)
    'google-chat': { webhook_url: 'NOTIFICATION_GOOGLE_CHAT_WEBHOOK' },
    gotify: {
        server_url: 'NOTIFICATION_GOTIFY_SERVER',
        app_token: 'NOTIFICATION_GOTIFY_APP_TOKEN'
    },
    rocketchat: { webhook_url: 'NOTIFICATION_ROCKETCHAT_WEBHOOK' },
    line: { access_token: 'NOTIFICATION_LINE_ACCESS_TOKEN' }
};

// X-PLUGIN P2: field names various integration types use for the secret
// credential value. api_key stays first — every existing integration
// type that resolves today matches api_key/token/secret, so this order
// preserves current behaviour for them. access_token and bearer_token
// are appended for LinkedIn (access_token), YouTube (access_token +
// refresh_token), and the reshaped twitter type, none of which the
// old hardcoded chains at each call site knew about.
const CREDENTIAL_SECRET_FIELDS = ['api_key', 'token', 'secret', 'bot_token', 'access_token', 'bearer_token'];

/**
 * Extract a credential's secret value from its decrypted JSON blob,
 * trying each known field name in CREDENTIAL_SECRET_FIELDS order.
 * Single shared helper so every extraction site (resolveProviderKey's
 * vault branch, resolveForAgent's agent-assignment and org-default
 * branches) stays in sync instead of drifting into divergent chains.
 *
 * @param {Object|null} credentials - decrypted credential JSON
 * @returns {string|null}
 */
function extractCredentialSecret(credentials) {
    if (!credentials) return null;
    for (const field of CREDENTIAL_SECRET_FIELDS) {
        if (credentials[field]) return credentials[field];
    }
    return null;
}

/**
 * Get a cached value or null if expired
 */
function getCached(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL_MS) {
        _cache.delete(key);
        return null;
    }
    return entry.value;
}

function setCache(key, value) {
    // Bound the Map's growth: once at capacity, evict the oldest entry
    // (Map iteration order == insertion order) before adding the new one.
    if (!_cache.has(key) && _cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = _cache.keys().next().value;
        if (oldestKey !== undefined) _cache.delete(oldestKey);
    }
    _cache.set(key, { value, time: Date.now() });
}

/**
 * Read a boolean policy flag from instance_config. Treats unset /
 * non-boolean values as the supplied default. Reads are cheap (single
 * indexed query) and not cached — the default values are usually
 * stable in practice.
 */
function readPolicyFlag(keyName, defaultValue) {
    try {
        const row = getDb().prepare(
            'SELECT value FROM instance_config WHERE key = ?'
        ).get(keyName);
        if (!row?.value) return defaultValue;
        return row.value === 'true' || row.value === true || row.value === '1';
    } catch {
        return defaultValue;
    }
}

/**
 * Read a user-scoped api_keys row + decrypt its ciphertext.
 * scope_type='user', scope_id=userId, is_active=1, default winner.
 * Returns null when no row exists or decryption fails.
 */
function getUserScopeKey(userId, provider) {
    if (!userId) return null;
    try {
        const db = getDb();
        const row = db.prepare(`
            SELECT id, key_ciphertext FROM api_keys
            WHERE scope_type = 'user' AND scope_id = ? AND provider = ?
              AND is_active = 1
            ORDER BY is_default DESC, created_at DESC
            LIMIT 1
        `).get(userId, provider);
        if (!row?.key_ciphertext) return null;
        const plain = decrypt(row.key_ciphertext);
        return plain ? { key: plain, id: row.id } : null;
    } catch (err) {
        console.error(`[CredentialResolver] User-scope lookup failed for ${userId}/${provider}:`, err.message);
        return null;
    }
}

/**
 * Read a key from instance_config table (global instance-level config)
 */
function getInstanceConfigKey(keyName) {
    try {
        const db = getDb();
        const row = db.prepare(
            'SELECT value, encrypted FROM instance_config WHERE key = ?'
        ).get(keyName);

        if (!row?.value) return null;

        return row.encrypted ? decrypt(row.value) : row.value;
    } catch (err) {
        console.error(`[CredentialResolver] Failed to decrypt instance_config key '${keyName}': ${err.message} — value may be encrypted with a previous master key`);
        return null;
    }
}

/**
 * Resolve a provider's API key using the waterfall:
 *   user scope (when allow_user_byok + userId given)
 *     → org vault (when allow_org_override)
 *     → instance_config
 *     → env var
 *
 * @param {string} orgId - Organization ID
 * @param {string} provider - Provider name (e.g., 'anthropic', 'openai')
 * @param {Object} [options]
 * @param {string}  [options.userId]            - When provided + BYOK on, user scope wins
 * @param {boolean} [options.fallbackToInstance=true] - Try instance_config
 * @param {boolean} [options.fallbackToEnv=true]      - Try env vars
 * @param {string}  [options.repo]                    - "owner/name" the caller is acting on.
 *        Selects the org credential whose metadata_json.repos covers that repo
 *        (see credentialScopeMatcher). Absent, or no pattern matches, keeps the
 *        org default — which is every org today, so behaviour is unchanged
 *        until someone declares a scope. quoxai/quox#481.
 * @returns {{ key: string|null, source: 'user'|'vault'|'instance'|'env'|null, credentialId?: string, apiKeyId?: string, scopeReason?: string }}
 */
export function resolveProviderKey(orgId, provider, options = {}) {
    const { userId = null, fallbackToInstance = true, fallbackToEnv = true, repo = null } = options;

    // SET-IA Phase 5b: cache key now namespaces on userId so per-user
    // BYOK keys don't bleed across users sharing the same org.
    // #481: and on repo, or the first repo resolved in a 30s window would
    // hand its token to every other repo asked for in the same window —
    // reintroducing the exact bug the repo scope exists to fix.
    const cacheKey = `provider:${orgId}:${userId || '_'}:${provider}:${repo || '_'}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const integrationType = PROVIDER_TYPE_MAP[provider] || provider;

    const allowOrgOverride = readPolicyFlag('keys.allow_org_override', true);
    const allowUserBYOK    = readPolicyFlag('keys.allow_user_byok',    true);

    // 1. User scope (BYOK) — only when caller passes a userId and
    //    the instance policy allows it.
    if (userId && allowUserBYOK) {
        const userKey = getUserScopeKey(userId, provider);
        if (userKey) {
            const result = { key: userKey.key, source: 'user', apiKeyId: userKey.id };
            setCache(cacheKey, result);
            return result;
        }
    }

    // 2. Org vault — only when policy allows org-level override.
    // X-PLUGIN P2: if a defaultCred is found but its fields don't match
    // any known secret field, we still remember its id/label so the
    // final null-key return below can carry credentialId — callers
    // downstream (e.g. collector connectors/bridge.js) gate their
    // resolve-by-id rescue on credentialId being present, and a bare
    // { key: null, source: null } silently skips that rescue.
    let vaultCredIdOnMiss = null;
    let vaultLabelOnMiss = null;
    if (allowOrgOverride) {
        try {
            // #481: when the caller named a repo, let a repo-scoped credential
            // claim it; otherwise this is byte-for-byte the old default lookup.
            let defaultCred = null;
            let scopeReason = 'org-default';
            if (repo) {
                const selection = selectCredentialForRepo(
                    listCredentials(orgId, { integration_type: integrationType }),
                    repo
                );
                defaultCred = selection.credential;
                scopeReason = selection.reason;
            } else {
                defaultCred = getDefaultCredential(orgId, integrationType);
            }
            if (defaultCred) {
                const db = getDb();
                const row = db.prepare(
                    'SELECT ciphertext FROM integration_credentials WHERE id = ?'
                ).get(defaultCred.id);

                if (row?.ciphertext) {
                    const credentials = JSON.parse(decrypt(row.ciphertext));
                    const apiKey = extractCredentialSecret(credentials);
                    if (!apiKey) {
                        vaultCredIdOnMiss = defaultCred.id;
                        vaultLabelOnMiss = defaultCred.label || null;
                    }
                    if (apiKey) {
                        updateLastUsed(defaultCred.id);
                        // VAULT-P6.J: provider keys are lease-EXEMPT by design
                        // (no lease gating added here) but they are NOT
                        // audit-exempt — every secret release must leave a
                        // WARD-witnessed evidence trail, same as
                        // resolveForAgent's vault branch below.
                        writeCredentialReleaseAudit({
                            orgId, credentialId: defaultCred.id,
                            integrationType: defaultCred.integration_type, label: defaultCred.label,
                            callerService: 'internal', via: 'provider-key',
                        });
                        // scopeReason travels with the key so the caller can log
                        // (and, on failure, SAY) whether this token was chosen
                        // for the repo or merely fell through to the org
                        // default. A fallback indistinguishable from a match is
                        // how the wrong token got used silently.
                        const result = {
                            key: apiKey, source: 'vault', credentialId: defaultCred.id,
                            credentialLabel: defaultCred.label || null,
                            scopeReason,
                        };
                        setCache(cacheKey, result);
                        return result;
                    }
                }
            }
        } catch (err) {
            console.error(`[CredentialResolver] Vault lookup failed for ${provider}:`, err.message);
        }
    }

    // 3. Instance config (global)
    if (fallbackToInstance) {
        const instanceKey = PROVIDER_INSTANCE_KEY_MAP[provider];
        if (instanceKey) {
            const value = getInstanceConfigKey(instanceKey);
            if (value) {
                const result = { key: value, source: 'instance' };
                setCache(cacheKey, result);
                return result;
            }
        }
    }

    // 4. Environment variables
    if (fallbackToEnv) {
        const envVar = PROVIDER_ENV_MAP[provider];
        if (envVar && process.env[envVar]) {
            const result = { key: process.env[envVar], source: 'env' };
            setCache(cacheKey, result);
            return result;
        }
    }

    return vaultCredIdOnMiss
        ? { key: null, source: null, credentialId: vaultCredIdOnMiss, credentialLabel: vaultLabelOnMiss }
        : { key: null, source: null };
}

/**
 * Batch resolve all provider keys for an org
 *
 * @param {string} orgId
 * @param {Object} [options]
 * @returns {Object} Map of provider → { key, source, credentialId? }
 */
export function resolveAllProviderKeys(orgId, options = {}) {
    const providers = ['anthropic', 'openai', 'perplexity', 'gemini', 'elevenlabs'];
    const result = {};

    for (const provider of providers) {
        result[provider] = resolveProviderKey(orgId, provider, options);
    }

    return result;
}

/**
 * Resolve Claude-specific keys (OAuth token + API key)
 * Special case: Claude uses OAuth token from instance_config or API key from vault
 *
 * @param {string} orgId
 * @returns {{ claude_oauth_token?: string, anthropic_api_key?: string, source: Object }}
 */
export function resolveClaudeKeys(orgId) {
    const cacheKey = `claude:${orgId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const result = { source: {} };

    // OAuth token (instance config or env)
    const oauthToken = getInstanceConfigKey('claude_oauth_token')
        || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
        result.claude_oauth_token = oauthToken;
        result.source.oauth = getInstanceConfigKey('claude_oauth_token') ? 'instance' : 'env';
    }

    // API key (vault → instance → env)
    const anthropicResolved = resolveProviderKey(orgId, 'anthropic');
    if (anthropicResolved.key) {
        result.anthropic_api_key = anthropicResolved.key;
        result.source.api_key = anthropicResolved.source;
    }

    setCache(cacheKey, result);
    return result;
}

/**
 * Resolve notification channel credentials
 *
 * @param {string} orgId
 * @param {string} channel - 'slack', 'telegram', 'discord', 'smtp'
 * @returns {{ credentials: Object|null, source: 'vault'|'env'|null }}
 */
export function resolveNotificationCredentials(orgId, channel) {
    const cacheKey = `notification:${orgId}:${channel}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const integrationType = PROVIDER_TYPE_MAP[channel] || channel;

    // 1. Vault
    try {
        const defaultCred = getDefaultCredential(orgId, integrationType);
        if (defaultCred) {
            const db = getDb();
            const row = db.prepare(
                'SELECT ciphertext FROM integration_credentials WHERE id = ?'
            ).get(defaultCred.id);

            if (row?.ciphertext) {
                const credentials = JSON.parse(decrypt(row.ciphertext));
                updateLastUsed(defaultCred.id);
                // VAULT-P6.J: notification credentials are lease-EXEMPT by
                // design (no lease gating added here) but not audit-exempt —
                // every secret release must leave a WARD-witnessed trail.
                writeCredentialReleaseAudit({
                    orgId, credentialId: defaultCred.id,
                    integrationType: defaultCred.integration_type, label: defaultCred.label,
                    callerService: 'internal', via: 'notification',
                });
                const result = { credentials, source: 'vault', credentialId: defaultCred.id };
                setCache(cacheKey, result);
                return result;
            }
        }
    } catch (err) {
        console.error(`[CredentialResolver] Vault notification lookup failed for ${channel}:`, err.message);
    }

    // 2. Environment variables
    const envMap = NOTIFICATION_ENV_MAP[channel];
    if (envMap) {
        const credentials = {};
        let hasValue = false;
        for (const [field, envVar] of Object.entries(envMap)) {
            const value = process.env[envVar];
            if (value) {
                credentials[field] = value;
                hasValue = true;
            }
        }
        if (hasValue) {
            const result = { credentials, source: 'env' };
            setCache(cacheKey, result);
            return result;
        }
    }

    return { credentials: null, source: null };
}

/**
 * Resolve credentials for an agent at runtime
 *
 * 4-level scope chain:
 *   1. Agent-assigned credential (agent_credential_assignments table)
 *   2. Org default credential for the tool type (vault)
 *   3. Instance config (global)
 *   4. Environment variables
 *
 * If a vault credential has lease_required=1, the agent must have an active
 * lease to access it. Without a valid lease, the credential is skipped.
 *
 * @param {string} orgId - Organization ID
 * @param {string} agentId - Agent identifier (e.g., 'inbox-q', 'sentinel')
 * @param {string} toolType - Integration/tool type (e.g., 'smtp', 'openai', 'slack')
 * @param {Object} options - { fallbackToInstance, fallbackToEnv, scopeId }
 * @returns {{ key: string|null, credentials: Object|null, source: string, credentialId: string|null, leaseId?: string, leaseBlocked?: boolean }}
 */
export function resolveForAgent(orgId, agentId, toolType, options = {}) {
    const { fallbackToInstance = true, fallbackToEnv = true } = options;
    const cacheKey = `agent:${orgId}:${agentId}:${toolType}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const integrationType = PROVIDER_TYPE_MAP[toolType] || toolType;

    // 1. Agent-assigned credential
    try {
        const assignment = getAgentCredential(orgId, agentId, toolType);
        if (assignment) {
            // VAULT-P5.G/H (F4): the org's vault.lease_enforcement mode
            // decides what happens when this credential requires a lease
            // the agent doesn't cleanly hold — off/advisory still resolve
            // (advisory logs it), enforced blocks before ANY decryption.
            const leaseGate = evaluateLeaseGate({ orgId, agentId, credentialId: assignment.credential_id });
            if (!leaseGate.allow) {
                writeLeaseAccessAudit({
                    orgId, credentialId: assignment.credential_id, agentId,
                    outcome: 'lease_denied', reason: leaseGate.reason, via: 'resolve-for-agent',
                });
                // Lease required but not available — return blocked result (don't cache)
                return { key: null, credentials: null, source: null, credentialId: assignment.credential_id, leaseBlocked: true, leaseReason: leaseGate.reason };
            }
            if (leaseGate.advisory) {
                writeLeaseAccessAudit({
                    orgId, credentialId: assignment.credential_id, agentId,
                    outcome: 'lease_missing', reason: leaseGate.reason, via: 'resolve-for-agent',
                });
            }

            const decrypted = getDecryptedCredential(assignment.credential_id);
            if (decrypted?.credentials) {
                updateLastUsed(assignment.credential_id);
                writeCredentialReleaseAudit({
                    orgId, credentialId: assignment.credential_id,
                    integrationType: decrypted.integration_type, label: decrypted.label,
                    callerService: `agent:${agentId}`, via: 'resolve-for-agent',
                });
                const key = extractCredentialSecret(decrypted.credentials);
                const result = {
                    key,
                    credentials: decrypted.credentials,
                    source: 'agent_assignment',
                    credentialId: assignment.credential_id,
                    leaseId: leaseGate.leaseId || null
                };
                // F15: never cache a lease_required credential's result — the
                // cache would otherwise let N logical resolves inside the
                // 30s window consume only 1 lease use (the cache-populating
                // call). Skipping the cache forces every call to re-run the
                // lease gate (and its atomic incrementLeaseUse) for real.
                if (!leaseGate.leaseRequired) setCache(cacheKey, result);
                return result;
            }
        }
    } catch (err) {
        console.error(`[CredentialResolver] Agent assignment lookup failed for ${agentId}/${toolType}:`, err.message);
    }

    // 2. Org default credential (vault)
    try {
        const defaultCred = getDefaultCredential(orgId, integrationType);
        if (defaultCred) {
            const leaseGate = evaluateLeaseGate({ orgId, agentId, credentialId: defaultCred.id });
            if (!leaseGate.allow) {
                writeLeaseAccessAudit({
                    orgId, credentialId: defaultCred.id, agentId,
                    outcome: 'lease_denied', reason: leaseGate.reason, via: 'resolve-for-agent',
                });
                return { key: null, credentials: null, source: null, credentialId: defaultCred.id, leaseBlocked: true, leaseReason: leaseGate.reason };
            }
            if (leaseGate.advisory) {
                writeLeaseAccessAudit({
                    orgId, credentialId: defaultCred.id, agentId,
                    outcome: 'lease_missing', reason: leaseGate.reason, via: 'resolve-for-agent',
                });
            }

            const db = getDb();
            const row = db.prepare(
                'SELECT ciphertext FROM integration_credentials WHERE id = ?'
            ).get(defaultCred.id);

            if (row?.ciphertext) {
                const credentials = JSON.parse(decrypt(row.ciphertext));
                updateLastUsed(defaultCred.id);
                writeCredentialReleaseAudit({
                    orgId, credentialId: defaultCred.id,
                    integrationType: defaultCred.integration_type, label: defaultCred.label,
                    callerService: `agent:${agentId}`, via: 'resolve-for-agent',
                });
                const key = extractCredentialSecret(credentials);
                const result = { key, credentials, source: 'vault', credentialId: defaultCred.id, leaseId: leaseGate.leaseId || null };
                // F15: see note above — skip caching lease_required results.
                if (!leaseGate.leaseRequired) setCache(cacheKey, result);
                return result;
            }
        }
    } catch (err) {
        console.error(`[CredentialResolver] Vault lookup failed for agent ${agentId}/${toolType}:`, err.message);
    }

    // 3. Instance config
    if (fallbackToInstance) {
        const instanceKey = PROVIDER_INSTANCE_KEY_MAP[toolType];
        if (instanceKey) {
            try {
                const row = getDb().prepare(
                    'SELECT value FROM instance_config WHERE key = ?'
                ).get(instanceKey);
                if (row?.value) {
                    const result = { key: row.value, credentials: null, source: 'instance', credentialId: null };
                    setCache(cacheKey, result);
                    return result;
                }
            } catch { /* ignore */ }
        }
    }

    // 4. Environment variables
    if (fallbackToEnv) {
        const envVar = PROVIDER_ENV_MAP[toolType];
        if (envVar && process.env[envVar]) {
            const result = { key: process.env[envVar], credentials: null, source: 'env', credentialId: null };
            setCache(cacheKey, result);
            return result;
        }
    }

    return { key: null, credentials: null, source: null, credentialId: null };
}

/**
 * Clear the resolver cache (used after credential updates)
 */
export function clearCache() {
    _cache.clear();
}

/**
 * Get cache stats for health monitoring
 */
export function getCacheStats() {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    for (const [, entry] of _cache) {
        if (now - entry.time <= CACHE_TTL_MS) active++;
        else expired++;
    }
    return { active, expired, total: _cache.size };
}

export default {
    resolveProviderKey,
    resolveAllProviderKeys,
    resolveClaudeKeys,
    resolveNotificationCredentials,
    resolveForAgent,
    clearCache,
    getCacheStats
};
