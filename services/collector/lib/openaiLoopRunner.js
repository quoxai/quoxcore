'use strict';

/**
 * openaiLoopRunner.js: QLOOP-ENGINE P2b increment 2, the api-kind loop runner
 * SKELETON. It parallels coreLocalLoopRunner.js but runs a model tool-call
 * loop in-process instead of a child CLI.
 *
 *   collector spawn route -> THIS runner (model client + governed tools)
 *                          -> POST /api/v1/dev-sessions/:id/events (self-fetch,
 *                             session ingest token), exactly like the CLI runner
 *
 * NOTHING governance-shaped is reimplemented here:
 *   - tools run ONLY through governedToolDispatch.dispatchGovernedToolCall,
 *     which calls executeTool (RBAC, approval/HITL gate, risk gate, per-tool
 *     AEE/AOCL evidence, VOLT). The runner never calls a tool directly.
 *   - per-turn WARD witnessing, VOLT turn entries and AOCL happen in the
 *     collector's /:id/events ingest route, which this runner posts to.
 *   - the signed kill reaches this runner through the same /:id/interrupt
 *     route (registry keyed by session ref AND agent session id).
 *   - loopDispatch's per-turn capability backstop, safety gate and checkpoint
 *     logic consume the events this runner posts, unchanged.
 * The only gate local to the runner is "do not even OFFER or run a tool the
 * scope does not name" (deny-by-default, patterned entries are never offered).
 *
 * Events are emitted in the claude stream-json shapes loopDispatch's
 * normalizeLoopEvent already understands (assistant/tool_use, user/tool_result,
 * result), so no downstream normaliser branch is needed.
 *
 * SECRET HYGIENE: the per-org key is resolved through the EXISTING auth seam
 * (POST {AUTH_BASE_URL}/api/setup/internal/resolve -> resolveProviderKey) and
 * lives in this closure only: never argv, never an env, never an emitted
 * event (every outgoing line is scrubbed of the key as defence in depth).
 *
 * MODEL CLIENT: defaultModelClient makes ONE live OpenAI /chat/completions
 * round per turn, reusing the collector's proven OpenAI mappers (openaiRequest,
 * providerToolNames, openaiToolCompat) behind the
 * { apiKey, messages, tools, signal } -> { text, toolCalls, usage } contract.
 * Chat Completions (not the Responses API) is deliberate: it is the OpenAI
 * tool-calling path already proven in production here, so this reuses it rather
 * than forking a second implementation. A test injects its own modelClient.
 */

const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');
const { buildGovernedToolCtx, dispatchGovernedToolCall } = require('./governedToolDispatch.js');
const { serializeToolResultForModel } = require('./openaiInvokeDispatcher.js');
const { toOpenAIChatTools, flattenOpenAIMessageContent, buildOpenAIChatCompletionBody } = require('./openaiRequest.js');
const { encodeToolName, toolNameDecoder } = require('./providerToolNames.js');
const toolCompat = require('./openaiToolCompat.js');

const ESCALATE_MS = 5000;
const DEFAULT_MAX_TURNS = 25;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

function safeParseArgs(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/**
 * Translate the runner's internal message log (the hybrid shape startOpenAILoop
 * builds: { role:'user', content }, { role:'assistant', text, toolCalls },
 * { role:'tool', tool_call_id, content }) into OpenAI /chat/completions wire
 * messages. The assistant turn is echoed back with the SAME provider tool names
 * and raw argument strings the model emitted, so the tool_call ids line up with
 * the tool-result messages that follow (round-trip faithful).
 */
function toChatMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      const msg = { role: 'assistant', content: m.text ? String(m.text) : '' };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c._providerName || encodeToolName(c.name),
            arguments: typeof c._rawArguments === 'string' ? c._rawArguments : JSON.stringify(c.arguments || {}),
          },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content == null ? '' : m.content) });
    } else {
      out.push({ role: m.role || 'user', content: String(m.content == null ? '' : m.content) });
    }
  }
  return out;
}

/** OpenAI chat response -> the runner's { text, toolCalls, usage } contract. */
function parseChatResponse(data, decodeName) {
  const message = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  const text = flattenOpenAIMessageContent(message.content);
  const rawCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((c) => c && c.type === 'function' && c.function && c.function.name)
    : [];
  const toolCalls = rawCalls.map((c) => ({
    id: c.id,
    name: decodeName ? decodeName(c.function.name) : c.function.name,
    arguments: safeParseArgs(c.function.arguments),
    _providerName: c.function.name,
    _rawArguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}),
  }));
  const u = data && data.usage;
  const usage = u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.total_tokens } : undefined;
  return { text, toolCalls, usage };
}

const registry = new Map();

function flagOn(env = process.env) {
  return env.QLOOP_OPENAI_BACKEND === '1';
}

function isAvailable(env = process.env) {
  return flagOn(env);
}

/**
 * Resolve the org's OpenAI key via the existing vault seam (same call
 * server.js resolveCredentials/getClaudeKeys makes). Returns the key string
 * or null. A non-2xx is an error, never "no key".
 */
async function resolveOpenAIKey(orgId, {
  fetchFn = fetch,
  authBaseUrl = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`,
} = {}) {
  const resp = await fetchFn(`${authBaseUrl}/api/setup/internal/resolve`, {
    method: 'POST',
    headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ org_id: orgId || 'default', providers: ['openai'], channels: [] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`openai key resolve returned ${resp.status}`);
  const data = await resp.json();
  return (data && data.providers && data.providers.openai && data.providers.openai.key) || null;
}

/**
 * The live model client: ONE OpenAI /chat/completions round per call. Reuses
 * the SAME proven mappers the governed chat loop uses (openaiRequest.js,
 * providerToolNames.js, openaiToolCompat.js) rather than a second
 * implementation of OpenAI tool-calling. The runner owns the turn loop; this
 * makes exactly one model call and returns { text, toolCalls, usage }.
 *
 * Chat Completions (not the Responses API) is deliberate: it is the OpenAI
 * tool-calling path already proven in production in this collector (handleOpenAIChat
 * / the governed loop). Building a parallel Responses client would duplicate a
 * working capability. Injectable deps (fetchFn/apiUrl/model) keep it unit-testable
 * with no network. The key lives only in this call's args, never logged.
 */
async function defaultModelClient({
  apiKey,
  messages,
  tools = [],
  signal,
  model = DEFAULT_OPENAI_MODEL,
  apiUrl = OPENAI_CHAT_URL,
  fetchFn = fetch,
}) {
  if (!apiKey) throw new Error('openai loop: no api key for the model call');
  const decodeName = toolNameDecoder(() => (Array.isArray(tools) ? tools : []));
  const chatTools = Array.isArray(tools) && tools.length > 0 ? toOpenAIChatTools(tools) : [];
  const body = buildOpenAIChatCompletionBody({
    model,
    messages: toChatMessages(messages),
    maxTokens: 4096,
    tools: chatTools.length > 0 ? chatTools : undefined,
    toolChoice: chatTools.length > 0 ? 'auto' : undefined,
  });
  toolCompat.applyToolCompat(body, apiUrl);
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const send = () => fetchFn(apiUrl, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  let resp = await send();
  // QUOXON lane S: a reasoning model that refuses function tools at its default
  // reasoning effort is retried once with reasoning_effort 'none' (the provider's
  // own remedy, remembered per apiUrl+model). Non-refusal errors throw plainly.
  if (!resp.ok && Array.isArray(body.tools) && body.tools.length > 0 && body.reasoning_effort === undefined) {
    const firstErr = await resp.text();
    if (toolCompat.isReasoningEffortToolsRefusal(resp.status, firstErr)) {
      toolCompat.rememberNeedsEffortNone(apiUrl, model);
      body.reasoning_effort = 'none';
      resp = await send();
    } else {
      throw new Error(toolCompat.plainProviderErrorMessage({ providerLabel: 'OpenAI (loop)', model, status: resp.status, text: firstErr }));
    }
  }
  if (!resp.ok) {
    const errText = await (resp.text ? resp.text().catch(() => '') : Promise.resolve(''));
    throw new Error(toolCompat.plainProviderErrorMessage({ providerLabel: 'OpenAI (loop)', model, status: resp.status, text: errText }));
  }
  const data = await resp.json();
  return parseChatResponse(data, decodeName);
}

/** Names the scope grants, argument-patterned entries excluded (fail closed). */
function allowedToolNames(capabilityScope) {
  const out = new Set();
  for (const e of Array.isArray(capabilityScope) ? capabilityScope : []) {
    if (typeof e === 'string' && e && !e.includes('(')) out.add(e.trim());
  }
  return out;
}

function startOpenAILoop({
  sessionRef,
  ingestToken,
  orgId,
  agentId = 'quox',
  payload = '',
  capabilityScope = [],
  tools = [],
  maxDurationMs = 0,
  maxTurns = 0,
  collectorUrl,
  deps = {},                       // { executeTool, voltEmitter, storeAuditEnvelope, emitToolEvidence }
  modelClient = defaultModelClient,
  resolveKeyFn = resolveOpenAIKey,
  fetchFn = fetch,
  log = console,
}) {
  if (!flagOn()) throw new Error("loop backend 'openai' is not yet available");
  if (!sessionRef || !ingestToken || !collectorUrl || !orgId) {
    throw new Error('openaiLoopRunner: sessionRef, ingestToken, orgId and collectorUrl are required');
  }
  const allowed = allowedToolNames(capabilityScope);
  const offered = (Array.isArray(tools) ? tools : []).filter((t) => t && allowed.has(t.name));
  const agentSessionId = `openai-api-${sessionRef}`;
  const abort = new AbortController();
  const entry = { sessionRef, agentSessionId, killed: false, killReason: null, abort };
  registry.set(sessionRef, entry);
  registry.set(agentSessionId, entry);

  let apiKey = null;
  let seq = 0;
  let sending = Promise.resolve();
  const ingestUrl = `${String(collectorUrl).replace(/\/+$/, '')}/api/v1/dev-sessions/${encodeURIComponent(sessionRef)}/events`;

  const scrub = (s) => (apiKey ? s.split(apiKey).join('[redacted]') : s);
  const post = (events, done) => {
    sending = sending.then(async () => {
      try {
        const resp = await fetchFn(ingestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ingest_token: ingestToken, events, done }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) log.error(`[OpenAILoop] ${sessionRef}: ingest returned ${resp.status}`);
      } catch (err) {
        log.error(`[OpenAILoop] ${sessionRef}: ingest failed: ${err.message}`);
      }
    });
    return sending;
  };
  const emit = (obj) => {
    seq += 1;
    return post([{ seq, type: String(obj.type || ''), raw: scrub(JSON.stringify(obj)) }], false);
  };

  const doKill = (reason) => {
    if (entry.killed) return;
    entry.killed = true;
    entry.killReason = reason;
    try { abort.abort(); } catch { /* already aborted */ }
  };
  entry.doKill = doKill;

  let durationTimer = null;
  if (maxDurationMs > 0) {
    durationTimer = setTimeout(() => doKill('max_duration'), maxDurationMs);
    if (durationTimer.unref) durationTimer.unref();
  }

  const turnCap = maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS;
  const toolCtx = buildGovernedToolCtx({ body: {} }, {
    selected_agent: agentId, orgId, session_id: sessionRef, effectiveSessionId: sessionRef,
  });

  const run = (async () => {
    let failure = null;
    try {
      apiKey = await resolveKeyFn(orgId);
      if (!apiKey) throw new Error("no OpenAI key resolvable for this org (existing vault seam returned none)");
      const messages = [{ role: 'user', content: String(payload || '') }];
      for (let turn = 0; turn < turnCap && !entry.killed; turn++) {
        const out = await modelClient({ apiKey, messages, tools: offered, signal: abort.signal });
        if (entry.killed) break;
        const toolCalls = Array.isArray(out && out.toolCalls) ? out.toolCalls : [];
        const content = [];
        if (out && out.text) content.push({ type: 'text', text: String(out.text) });
        for (const c of toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
        await emit({ type: 'assistant', message: { content, usage: (out && out.usage) || undefined } });
        messages.push({ role: 'assistant', text: out && out.text, toolCalls });
        if (toolCalls.length === 0) {
          await emit({ type: 'result', subtype: 'success', usage: (out && out.usage) || undefined });
          return;
        }
        for (const call of toolCalls) {
          let result;
          if (!allowed.has(call.name)) {
            // Deny by default: never reaches executeTool. The loopDispatch
            // per-turn backstop independently flags the same call.
            result = { success: false, error: `tool '${call.name}' is not in this loop's capability scope; it was not run` };
          } else {
            result = await dispatchGovernedToolCall({
              callId: call.id,
              toolName: call.name,
              startedInput: call.arguments || {},
              input: call.arguments || {},
              argsError: call.argsError || null,
              toolCtx,
              deps,
              emitEvent: (ev) => {
                if (ev && ev.type === 'approval.requested') {
                  emit({ type: 'approval.requested', call_id: ev.call_id, tool: ev.tool });
                }
              },
              selectedAgent: agentId,
              providerLabel: 'OpenAI (loop)',
              voltRunId: sessionRef,
              evidenceCorrId: sessionRef,
            });
          }
          await emit({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: call.id, is_error: result && result.success === false }] },
          });
          messages.push({ role: 'tool', tool_call_id: call.id, content: serializeToolResultForModel(call.name, result) });
        }
      }
      if (entry.killed) failure = `stopped: ${entry.killReason}`;
      else failure = 'max_turns';
    } catch (err) {
      failure = entry.killed ? `stopped: ${entry.killReason}` : scrub(String(err && err.message ? err.message : err));
      log.warn(`[OpenAILoop] ${sessionRef}: ${failure}`);
    } finally {
      if (durationTimer) clearTimeout(durationTimer);
      registry.delete(sessionRef);
      registry.delete(agentSessionId);
    }
    if (failure) await emit({ type: 'result', subtype: 'error', is_error: true, error: failure });
  })().then(() => post([], true), () => post([], true));

  entry.done = run;
  return { agentSessionId, done: run };
}

function killOpenAILoop(idOrRef, reason = 'interrupt') {
  const entry = registry.get(idOrRef);
  if (!entry) return { killed: false, error: `no live openai loop session "${idOrRef}"` };
  entry.doKill(reason);
  return { killed: true };
}

function hasOpenAILoop(idOrRef) {
  return registry.has(idOrRef);
}

module.exports = {
  isAvailable,
  startOpenAILoop,
  killOpenAILoop,
  hasOpenAILoop,
  resolveOpenAIKey,
  allowedToolNames,
  defaultModelClient,
  toChatMessages,
  parseChatResponse,
  ESCALATE_MS,
};
