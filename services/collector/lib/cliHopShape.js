'use strict';
/**
 * The exact argv and env a CLI-tools turn spawns with, as pure functions, plus a DRY RUN of a
 * delegate hop to agent X (QUOXON 2026-10-17).
 *
 * dispatchClaudeCli builds its real args/env through buildCliToolsArgs / buildCliToolsEnvBase
 * below, and hopWarmShape builds agent X's hop through the SAME functions, so the warm key of a
 * dry shape equals the key of the real spawn by construction (pinned in test/cliHopShapeExact.test.js).
 * Nothing here is persisted and nothing carries a credential: the system prompt and message are
 * placeholders (warmArgsFrom strips them) and the per-turn token is added by the dispatcher only.
 *
 * A wrong guess must never produce a spare, so every input that cannot be resolved exactly
 * makes resolveHopShape answer { ok: false, reason: 'shape_unresolved' }.
 */
const path = require('path');
const { pickCliToolsEnv } = require('./turnToken.js');
const { cliOAuthEnv } = require('./cliOAuthEnv.js');
const { CLI_STREAM_OUTPUT_ARGS } = require('./cliStreamJson.js');
const { cliToolsBudgets } = require('./turnBudget.js');

// Same values as claudeCliDispatcher's voice constants (pinned by test/cliHopShapeExact.test.js).
const CLAUDE_CLI_VOICE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_CLI_VOICE_MAX_TURNS = 3;

const explicitModelArgs = (isVoice, requestedModel) => (!isVoice && typeof requestedModel === 'string' && requestedModel ? ['--model', requestedModel] : []);
const nativeAllowedTools = (base, nativeWebSearch) => (nativeWebSearch ? `${base},WebSearch,WebFetch` : base);

/** The CLI-tools argv. Moved verbatim from claudeCliDispatcher.ctBuildArgs. */
function buildCliToolsArgs({ streaming, isVoice, requestedModel, nativeWebSearch, sysPrompt, userMessage, resumeId, legacyResumeId }) {
  return [
    ...(streaming ? CLI_STREAM_OUTPUT_ARGS : ['--output-format', 'json']),
    // #950: ignore the account's own MCP config (claude.ai connectors would bypass AEE/WARD/receipts).
    '--strict-mcp-config',
    // VOICE FAST PATH: fast model + bounded tool loop, ONLY for a phone turn (isVoice).
    ...(isVoice ? ['--model', CLAUDE_CLI_VOICE_MODEL, '--max-turns', String(CLAUDE_CLI_VOICE_MAX_TURNS)] : []),
    ...explicitModelArgs(isVoice, requestedModel),
    '--allowedTools', nativeAllowedTools('Bash(quox tool exec:*)', nativeWebSearch),
    // QUOXON-PARITY (2026-10-13): restrict the BUILT-IN tool set, not just what is pre-approved.
    '--tools', nativeAllowedTools('Bash', nativeWebSearch),
    '--disallowedTools', 'ToolSearch',
    // #970: enforce "only `quox tool exec`" with a PreToolUse Bash hook.
    '--settings', JSON.stringify(require('./cliToolsBashGuard.js').hookSettings(path.join(__dirname, 'cliToolsBashGuardHook.js'))),
    '--system-prompt', sysPrompt,
    ...(resumeId ? ['--resume', resumeId] : (legacyResumeId ? ['-r', legacyResumeId] : [])),
    '-p', userMessage,
  ];
}

/** The CLI-tools env before the per-turn credential. Moved verbatim from the dispatcher's cliToolsEnvBase. */
function buildCliToolsEnvBase({ processEnv, runtimeHomeDir, runtimeUser, cliOAuthToken, turnBudgetMs, orgId, userId, sessionId, agentId, collectorPort }) {
  const cliTurnBudget = (typeof turnBudgetMs === 'number' && turnBudgetMs > 0) ? turnBudgetMs : null;
  const cliHop = cliToolsBudgets(cliTurnBudget);
  return {
    ...pickCliToolsEnv(processEnv),
    HOME: runtimeHomeDir,
    USER: runtimeUser,
    ...cliOAuthEnv(cliOAuthToken, { home: runtimeHomeDir }).env,
    BASH_DEFAULT_TIMEOUT_MS: String(cliHop.bashMs),
    BASH_MAX_TIMEOUT_MS: String(cliHop.bashMs),
    QUOX_TOOL_EXEC_TIMEOUT_MS: String(cliHop.toolExecMs),
    QUOX_ORG_ID: orgId || '',
    QUOX_SESSION_ID: sessionId,
    QUOX_USER_ID: userId || '',
    QUOX_AGENT_ID: agentId || '',
    QUOX_COLLECTOR_URL: (processEnv && processEnv.QUOX_COLLECTOR_URL) || `http://localhost:${collectorPort}`,
  };
}

/** One call for both halves. */
function buildCliToolsShape({ streaming, isVoice, requestedModel, nativeWebSearch, sysPrompt, userMessage, resumeId, legacyResumeId, envInputs }) {
  return {
    args: buildCliToolsArgs({ streaming, isVoice, requestedModel, nativeWebSearch, sysPrompt, userMessage, resumeId, legacyResumeId }),
    envBase: buildCliToolsEnvBase(envInputs || {}),
  };
}

/**
 * The args/env a REAL delegate hop to agentId spawns with (the /chat -> invokeClaudeCli path): stream-json,
 * not voice, no explicit model, no turn budget, a fresh session (no resume). `hop` carries the inputs the
 * hop handler resolves before dispatch (nativeWebSearch, OAuth token, runtime home/user, collector port).
 */
function hopWarmShape({ agentId, orgId, userId, hop }) {
  const h = hop || {};
  return buildCliToolsShape({
    streaming: true,
    isVoice: false,
    requestedModel: null,
    nativeWebSearch: h.nativeWebSearch === true,
    sysPrompt: '',
    userMessage: '',
    resumeId: null,
    legacyResumeId: null,
    envInputs: {
      processEnv: h.processEnv || process.env,
      runtimeHomeDir: h.runtimeHomeDir,
      runtimeUser: h.runtimeUser,
      cliOAuthToken: h.cliOAuthToken,
      turnBudgetMs: null,
      orgId,
      userId,
      sessionId: '',
      agentId,
      collectorPort: h.collectorPort,
    },
  });
}

/**
 * The LLM auth inputs /chat resolves before it picks the CLI path. The /chat handler and the hint-time
 * dry run both call this, so there is one resolution, not two. deps are injected (server.js passes its own).
 */
async function resolveChatLlmAuth(deps, { orgId, userAccessToken, selectedAgent, requestedProvider, requestedModel, requestedCredentialId, vaultCredential = null, localSource = null, keys = null, applyOllama = true }) {
  // keys: the caller's already-resolved org keys (the hint-time dry run passes the parent turn's), so a hinted agent
  // costs no extra vault resolve and cannot feed the vault breaker real turns share (HYPERION review). /chat passes none.
  const providerKeys = keys && keys.providerKeys ? keys.providerKeys : await deps.getProviderKeys(orgId);
  const claudeKeys = keys && keys.claudeKeys ? keys.claudeKeys : await deps.getClaudeKeys(orgId);
  const baseAnthropicApiKey = (vaultCredential?.provider === 'anthropic' && vaultCredential?.key)
    ? vaultCredential.key
    : (claudeKeys.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '');
  let cliOAuthToken = deps.resolveCliOAuthToken(claudeKeys);
  const { plan: resolvedCollectorPlan, policyPayload, policyContext } = await deps.resolveCollectorPolicyPlan({
    orgId,
    userAccessToken,
    selectedAgent,
    requestedProvider,
    requestedModel,
    requestedCredentialId,
    credentialMeta: vaultCredential ? {
      id: requestedCredentialId || null,
      provider: vaultCredential.provider,
      label: vaultCredential.label,
    } : null,
    anthropicApiKey: baseAnthropicApiKey,
    cliOAuthToken,
    providerKeys,
    localSource,
  });
  const core = { providerKeys, claudeKeys, baseAnthropicApiKey, cliOAuthToken, resolvedCollectorPlan, policyPayload, policyContext };
  // applyOllama:false = the caller applies the ollama selection itself (POST /chat does, in its own body, before it
  // reads effectiveProvider: collectorChatOllama.test.js pins that) and then calls finalizeChatLlmAuth.
  if (!applyOllama) return core;
  return finalizeChatLlmAuth(deps, core, deps.applyOllamaSelection(resolvedCollectorPlan, { requestedProvider, requestedModel }));
}

/** After the ollama selection: the OAuth allowance, native web search, and the no_oauth blanking (same order as /chat). */
function finalizeChatLlmAuth(deps, core, collectorPlan) {
  const allowOAuthCredentials = collectorPlan.credentialConstraints?.allowOAuth !== false;
  const nativeWebSearch = deps.isNativeWebSearch({ plan: collectorPlan });
  return { ...core, cliOAuthToken: allowOAuthCredentials ? core.cliOAuthToken : '', collectorPlan, allowOAuthCredentials, nativeWebSearch };
}

const UNRESOLVED = Object.freeze({ ok: false, reason: 'shape_unresolved' });

/**
 * Hint-time dry run for agent X. Returns { ok: true, args, env } only when the hop would run the CLI-tools
 * path with inputs resolved by the same code as the hop handler; anything else is { ok: false, reason }.
 * Never throws.
 */
async function resolveHopShape(deps, { agentId, orgId, userId, userAccessToken, env = process.env, keys = null }) {
  try {
    if (!agentId || !orgId || !userId) return UNRESOLVED;
    if (env.QUOX_TOOL_MODE !== 'cli') return UNRESOLVED; // not the CLI-tools dispatch path
    if (env.QUOX_CLI_WARM_DELEGATE === '0') return UNRESOLVED; // hops do not use the pool
    const selectedAgent = typeof deps.aliasAgentId === 'function' ? deps.aliasAgentId(agentId) : agentId;
    const auth = await resolveChatLlmAuth(deps, { orgId, userAccessToken, selectedAgent, keys });
    // The hop reaches the CLI only on anthropic with the subscription token and no API key.
    if (!auth.collectorPlan || auth.collectorPlan.provider !== 'anthropic') return UNRESOLVED;
    if (auth.baseAnthropicApiKey) return UNRESOLVED;
    if (!auth.cliOAuthToken) return UNRESOLVED;
    if (!deps.runtimeHomeDir || !deps.runtimeUser) return UNRESOLVED;
    const shape = hopWarmShape({
      agentId: selectedAgent,
      orgId,
      userId,
      hop: {
        nativeWebSearch: auth.nativeWebSearch,
        cliOAuthToken: auth.cliOAuthToken,
        runtimeHomeDir: deps.runtimeHomeDir,
        runtimeUser: deps.runtimeUser,
        collectorPort: deps.collectorPort,
        processEnv: env,
      },
    });
    return { ok: true, args: shape.args, env: shape.envBase };
  } catch {
    return UNRESOLVED;
  }
}

module.exports = { buildCliToolsArgs, buildCliToolsEnvBase, buildCliToolsShape, hopWarmShape, resolveChatLlmAuth, finalizeChatLlmAuth, resolveHopShape };
