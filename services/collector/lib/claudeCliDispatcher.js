/**
 * AOCL-DISPATCH Phase 2 — Claude CLI / MCP dispatcher.
 *
 * Pure extraction of server.js handleClaudeCliWithTools (785 lines). Covers
 * both sub-paths:
 *   - MCP path  (claude CLI with --mcp-config, Claude drives tool selection)
 *   - Legacy path (regex pre-execution + single CLI shot with data injected
 *                  into the system prompt)
 *
 * Contract:
 *   dispatchClaudeCli(opts, deps) → {
 *     outcome: 'success' | 'cli_unavailable' | 'cli_error',
 *     path: 'mcp' | 'cli',
 *     text, tokensUsed, toolsUsed, model,
 *     voiceSummary, richContent, cost_usd, cliSessionId?,
 *     decisionEvidence, hint?, errorCode?,
 *   }
 *
 * Behavioural invariants preserved from the legacy handler:
 *   - MCP path runs iff deps.mcpEnabled && !opts.noToolsRequested.
 *   - MCP path writes /tmp/quoxmcp-<sid>.json, spawns claude with
 *     --mcp-config, cleans up the temp file in finally.
 *   - Legacy path: resolveFollowUp → detectAndExecuteTools → optional
 *     auto-diagnostics on flagged/mentioned hosts → single CLI call with
 *     data-injected system prompt.
 *   - Both paths: getClaudeCliHealth before spawn, VOLT run start/complete,
 *     chat.success / chat.cli_error / chat.cli_health_failed envelopes,
 *     emit session.end, kill the child on client disconnect (every 2s).
 *   - MCP: 180s default timeout (override via opts.maxDurationMs).
 *   - Legacy: 600s timeout.
 *   - Raw `prompt` (not userMessage) used for all activity.message summaries
 *     and envelope query_preview fields.
 *
 * AUDIT-REAL-4b: decision evidence support (mirrors claudeMessagesDispatcher.js
 * — payload field names/shapes MUST match exactly for downstream parity):
 *   - opts.decisionEvidenceLevel !== 'none' → deps.buildDecisionEvidenceInstructions(level)
 *     appended to the system prompt (both MCP and legacy sub-paths).
 *   - Response text run through deps.extractDecisionEvidence(); <decision_evidence>
 *     tags stripped from the returned `text`.
 *   - Captured → chat.success envelope gets `requires: {decision_evidence: level}`
 *     + `payload.decision_evidence`; VOLT `agent.decision.recorded`.
 *   - Requested but absent → `payload.decision_evidence_missing: true`, a
 *     dedicated `quox.evidence.missing` envelope, and VOLT `agent.decision.missing`.
 *     Visibility only — never blocks/fails the chat response.
 *   - Legacy sub-path has no pre-existing per-chat VOLT run; a short-lived
 *     run is opened solely to carry the two decision-evidence VOLT events.
 *
 * LLM-CHOICE Phase 2.6: model attribution/metadata (session emission, audit
 * envelopes, decision-evidence bookkeeping) previously hardcoded the literal
 * 'claude-sonnet-4-6' ~11x. Consolidated to CLAUDE_CLI_DEFAULT_MODEL below
 * (env-overridable via CLAUDE_CLI_DEFAULT_MODEL). If a caller passes
 * opts.model it wins over the default; nothing does today, and the CLI spawn
 * args never carried a --model flag either way, so this is a labeling
 * default only — no dispatch behavior changes.
 */

const { applyLenses } = require('./lensComposer.js');
const configResolver = require('./configResolver.js');

// VAULT-INTEG P17: was a bare process.env read frozen at module load — now
// resolved per-call via configResolver.getSetting(orgId, ...)
// (platformCapabilities.js CLAUDE_CLI_DEFAULT_MODEL) inside
// dispatchClaudeCli() below, org-scoped via opts.orgId. Kept here only as
// the ultimate fallback default when the resolver itself has nothing (env
// unset, no stored override, registry unreachable).
const CLAUDE_CLI_DEFAULT_MODEL_FALLBACK = 'claude-sonnet-4-6';

// VOICE FAST PATH (owner 2026-10-09): a phone turn must be snappy. The CLI spawn carried no
// --model and no --max-turns, so voice ran the default (Sonnet) with an unbounded agentic tool
// loop, giving 20-36s (sometimes 56s) governed turns. On a call that is fatal. For isVoice turns
// only, force a fast model and bound the loop. Non-voice paths are untouched. Constants for now
// (not env-read, to stay off the env-only-settings surface); can graduate to org settings later.
const CLAUDE_CLI_VOICE_MODEL = 'claude-haiku-4-5-20251001';
// 3 rounds: a phone ask is almost always a read (1-2 tool rounds). Capping tighter trims the
// worst-case latency; a genuinely multi-step action degrades gracefully to "let me sort that and
// come back" rather than making the caller wait through 5 slow rounds (owner 2026-10-10).
const CLAUDE_CLI_VOICE_MAX_TURNS = 3;

// QUOXLENS P0: no lens has ever been part of this path's prompt (verified —
// "Execution Integrity" text only ever lived in directProviderPrompt.js), so
// the default here is [], a true no-op through applyLenses.
const DEFAULT_LENSES = [];

// BRAIN2-V3 B3 phone recall: a spoken "ask your brain" question is answered by the
// orchestrator's own brain tools, and sources are spoken as natural names.
const VOICE_BRAIN_RECALL_PROMPT = `
Brain questions ("what do I know about X", "did we ever decide Y", "ask my brain", "remind me about Z"): call recall (or quoxbrain_search) yourself and answer ONLY from what comes back. For "what's new" or "catch me up" call brain_brief. Say where each fact came from in plain spoken words, for example "from your saved memory about the billing rules" or "from a note titled Alpha Rollout" or "from a past session about the login fix". Never read out citation markers such as [B1], note ids, file paths or tool names. If nothing matches, say so in one short sentence.
Capture ("note this", "jot this down", "write that down", "take a note", "remind me that..."): call brain_save yourself with the caller's words as the note text (a short title if one is obvious), do NOT delegate, then confirm in one sentence, for example "Saved to your notes." It lands in the caller's private NotesQ notebook, where it can be edited, tagged or shared later. Never claim it was saved unless brain_save succeeded.`;

// Appended AFTER the memory guidance: on voice always, in typed chat whenever the
// agent holds brain_save. Both surfaces lost "note this" to memory_save when the
// later memory text won (voice call 2026-10-07, typed chat scorecard 2026-10-08).
const captureOverride = (isVoice) => `

## ${isVoice ? 'Voice' : 'Note'} capture (overrides the memory guidance above)
When the caller says "note this", "jot this down", "write that down", "take a note" or "add to my notes", save it with brain_save (their NotesQ notebook), not memory_save, even when it reads like a short fact or a reminder. Use memory_save only when they ask you to remember a fact or preference about them. Confirm only after brain_save succeeds.`;

const wantsCaptureOverride = (isVoice, agentTools) => Boolean(isVoice) || (Array.isArray(agentTools) && agentTools.some((t) => t && t.name === 'brain_save'));

// Research turns add the CLI's WebSearch and WebFetch built-ins to the allowlist.
// Nothing else is opened; every existing restriction stays.
const CLI_TOOLS_TURN_TIMEOUT_MS = 285000;
const CLI_TOOLS_BASH_TIMEOUT_MS = 240000;

function nativeAllowedTools(base, nativeWebSearch) {
  return nativeWebSearch ? `${base},WebSearch,WebFetch` : base;
}

// The CLI runs --output-format json, which has no per-tool trace, but the result
// carries server-tool usage counts. Record WebSearch / WebFetch from those so the
// "Tools used" line shows them. Only consulted when native search was enabled.
function mergeNativeTools(tracked, cliResponse, nativeWebSearch) {
  const out = Array.isArray(tracked) ? [...tracked] : [];
  if (!nativeWebSearch) return out;
  const stu = cliResponse?.usage?.server_tool_use || {};
  if ((stu.web_search_requests || 0) > 0 && !out.includes('WebSearch')) out.push('WebSearch');
  if ((stu.web_fetch_requests || 0) > 0 && !out.includes('WebFetch')) out.push('WebFetch');
  return out;
}

async function dispatchClaudeCli(opts, deps) {
  const {
    finalSystemPrompt,
    persona,
    userMessage,
    prompt,
    session_id,
    effectiveSessionId,
    selected_agent,
    agentTools,
    cliOAuthToken,
    userAccessToken,
    jwtOrgId,
    jwtUserId,
    conversation_history,
    memory_context,
    quox_context,
    userId,
    orgId,
    noToolsRequested,
    isVoice,
    maxDurationMs,
    clientDisconnected,
    aoclCtx,
    decisionEvidenceLevel,
    model: requestedModel = null,
    nativeWebSearch = false, // research turns: allow the CLI's WebSearch + WebFetch built-ins
  } = opts;

  const {
    spawnFn,
    fetchFn = (typeof fetch === 'function' ? fetch : null),
    fsWriteFile,
    fsUnlink,
    getClaudeCliHealth,
    resolveFollowUp,
    detectAndExecuteTools,
    executeTool,
    getTrackedTools,
    clearTrackedTools,
    getToolCache,
    setToolCache,
    isValidUUID,
    sanitizeErrorForUser,
    voltEmitter,
    persistVoltContent,
    storeAuditEnvelope,
    emitAgentSession,
    emitAgentEvent,
    getCollectorMirrorCompact,
    memorySystemPrompt,
    actionSystemPrompt,
    buildDecisionEvidenceInstructions,
    extractDecisionEvidence,
    extractVoiceSummary,
    generateEnvelopeId,
    runtimeHomeDir,
    runtimeUser,
    bastionHost = '',
    collectorPort = 9848,
    internalServiceKey = '',
    tasksServiceUrl = 'http://tasks:3104',
    mcpEnabled = false,
  } = deps || {};

  if (typeof spawnFn !== 'function') throw new Error('dispatchClaudeCli: spawnFn dep missing');
  if (typeof fetchFn !== 'function') throw new Error('dispatchClaudeCli: fetchFn dep missing');

  // VAULT-INTEG P17: resolved once per call, org-scoped via opts.orgId —
  // see the module-header comment on CLAUDE_CLI_DEFAULT_MODEL_FALLBACK above.
  const claudeCliDefaultModel = configResolver.getSetting(orgId || null, 'CLAUDE_CLI_DEFAULT_MODEL').value
    || CLAUDE_CLI_DEFAULT_MODEL_FALLBACK;

  const rawPrompt = typeof prompt === 'string' ? prompt : '';

  // ────────────────────────────────────────────────────────────────────────
  // CLI-TOOLS PATH — COMMANDERQ dispatch mode. On-server agents reach tools
  // via the governed `quox tool exec <name> --args '<json>'` CLI (invoked by
  // Claude through its native Bash tool), never via MCP. Opt-in only:
  // QUOX_TOOL_MODE=cli. When unset (default) or any other value, behaviour
  // below is UNCHANGED — falls through to the existing mcpEnabled→mcp /
  // else→legacy selection.
  //
  // Security posture (do not relax without an explicit owner decision):
  //   - NO --mcp-config (no MCP server is spawned/exposed on this path).
  //   - NO --dangerously-skip-permissions. --allowedTools is scoped to the
  //     single literal `Bash(quox tool exec:*)` pattern, so the model can
  //     run nothing else in the container (no arbitrary Bash, no native
  //     file/Task/SendMessage tools). This is the entire point of the mode:
  //     the container's blast radius is exactly what `quox tool exec` itself
  //     governs (auth, org scoping, tool allowlist) server-side.
  //   - Auth reaches the collector via QUOX_SERVICE_KEY (the same
  //     internalServiceKey the MCP path injects into its MCP config env
  //     above) + QUOX_FORCE_SERVICE_KEY=1 + QUOX_ORG_ID, matching exactly
  //     what cli/lib/core/client.js and cli/lib/commands/tool.js `tool exec`
  //     read (verified against the CLAUDE-INSTALLED /opt/quoxcli and the
  //     dev quox-dashboard-cli worktree source, not guessed).
  // ────────────────────────────────────────────────────────────────────────
  if (process.env.QUOX_TOOL_MODE === 'cli') {
    console.log(`[CLI-TOOLS] PATH enabled — agent=${selected_agent}, session=${session_id}`);

    const ctSessionId = effectiveSessionId || session_id
      || `SESSION_${typeof generateEnvelopeId === 'function' ? generateEnvelopeId() : Date.now().toString(36)}`;
    const ctStartTime = Date.now();

    if (typeof emitAgentSession === 'function') {
      emitAgentSession({
        id: ctSessionId,
        org_id: jwtOrgId,
        host_id: 'collector',
        agent_type: 'chat_assistant',
        agent_name: selected_agent,
        provider: 'anthropic',
        model: (requestedModel || claudeCliDefaultModel),
        status: 'running',
        user: jwtUserId || 'anonymous',
        project: 'quox-dashboard',
      });
    }
    if (typeof emitAgentEvent === 'function') {
      emitAgentEvent({
        session_id: ctSessionId,
        org_id: jwtOrgId,
        agent_name: selected_agent,
        type: 'activity.message',
        data: { role: 'user', length: rawPrompt.length, agent: selected_agent, path: 'cli-tools' },
        summary: `User: ${rawPrompt.length > 80 ? rawPrompt.substring(0, 80) + '...' : rawPrompt}`,
      });
      emitAgentEvent({
        session_id: ctSessionId,
        org_id: jwtOrgId,
        agent_name: selected_agent,
        type: 'activity.thinking',
        data: { path: 'cli-tools', agent: selected_agent },
        summary: `${selected_agent} processing via CLI tools...`,
      });
    }

    const ctVoltRunId = voltEmitter && typeof voltEmitter.startRun === 'function'
      ? voltEmitter.startRun(ctSessionId, {
          org_id: jwtOrgId || undefined,
          user_id: jwtUserId || undefined,
          agent_id: selected_agent,
          path: 'cli-tools',
        })
      : null;
    if (aoclCtx && ctVoltRunId) aoclCtx.voltRunId = ctVoltRunId;

    const ctVoltEmit = (runId, eventType, payload) => {
      if (voltEmitter && typeof voltEmitter.emit === 'function' && runId) {
        return voltEmitter.emit(runId, eventType, payload);
      }
      return null;
    };

    // Host inventory — same best-effort context the MCP path fetches.
    let ctAllHostIds = [];
    try {
      const agentsData = await fetchFn(`http://127.0.0.1:${collectorPort}/api/v1/agents`).then((r) => r.json());
      ctAllHostIds = (agentsData.agents || []).map((a) => a.host_id);
    } catch (e) {
      console.warn('[CLI-TOOLS] Could not fetch host inventory:', e.message);
    }

    // Tool catalogue for the prompt — name + one-line description only
    // (never the full JSON schema) to keep the prompt bounded. Sourced from
    // opts.agentTools, the same resolved-per-agent tool list (already
    // capped upstream by applySmartToolCap in server.js) that the MCP
    // path's quoxmcp server exposes over MCP — so the catalogue seen here
    // matches what the agent would have seen as MCP tools, just described
    // in prose instead of as callable MCP entries.
    const ctToolList = Array.isArray(agentTools) ? agentTools : [];
    const ctToolCatalogue = ctToolList.length > 0
      ? ctToolList.map((t) => {
        // Argument NAMES only, never the full schema: without them the model
        // guessed (addTags for add) and a half-applied call reported success.
        // Never in name(...) shape: that made the model hunt for native tools
        // instead of running quox tool exec (AQ-9D scorecard, 2026-10-07).
        const schema = t.input_schema || t.inputSchema || t.parameters || {};
        const req = new Set(schema.required || []);
        const names = Object.keys(schema.properties || {}).map((k) => (req.has(k) ? `${k} (required)` : k));
        return `- ${t.name}${names.length ? ` | args: ${names.join(', ')} |` : ':'} ${t.description || '(no description)'}`;
      }).join('\n')
      : '(no tools resolved for this agent)';

    // Build system prompt — same shape/sections as the MCP path's
    // mcpSysPrompt builder, with tool-invocation instructions swapped from
    // "call the MCP tool" to "run it via Bash `quox tool exec`".
    let cliToolsSysPrompt = finalSystemPrompt + `\n\n## Voice Personality\n${persona}`;

    if (quox_context && typeof quox_context === 'string' && quox_context.includes('## QuoxMind Mirror')) {
      const mirrorStart = quox_context.indexOf('## QuoxMind Mirror');
      const mirrorEnd = quox_context.indexOf('\n\n', mirrorStart + 20);
      const mirrorSection = mirrorEnd > mirrorStart
        ? quox_context.substring(mirrorStart, mirrorEnd)
        : quox_context.substring(mirrorStart);
      cliToolsSysPrompt += `\n\n${mirrorSection}`;
    } else {
      const collectorMirror = typeof getCollectorMirrorCompact === 'function'
        ? getCollectorMirrorCompact() : '';
      if (collectorMirror) {
        cliToolsSysPrompt += `\n\n## System Status\n${collectorMirror}`;
      }
    }

    cliToolsSysPrompt += `\n\n## Rules
- You are ${selected_agent.toUpperCase()}, an AI infrastructure agent for QuoxCORE.
- You have infrastructure tools available via the governed \`quox tool exec\` CLI (run through your Bash tool). Use them to answer questions.
- When asked about hosts, fleet, containers, security, disk, memory, CPU — call the relevant tool.
- Present findings with clear markdown tables and actionable analysis.
- Never say "I can't access" or "I don't have tools" — call the tool.
- Never claim you are in a "sandbox" or that infrastructure is "not accessible" — you ARE connected.
- Never ask the user to run SSH commands — use ssh_exec (via quox tool exec) to run them yourself.
- After getting tool results, analyse them and provide recommendations.
- If a tool call fails or times out, that IS diagnostic data — explain what the failure means.
- DO the work. Do NOT write assessment reports or escalation plans. Execute commands and show results.

## Live tools — use the CLI, never guess
To read live data or run an action, call this via Bash and parse its JSON result:
  quox tool exec <name> --args '<json-args>'
These are NOT native tools: never call one directly and never look one up with ToolSearch (it will not be found). Even where this prompt writes a tool like a function call, e.g. quoxbrain_search({query:'x'}), run it as: quox tool exec quoxbrain_search --args '{"query":"x"}'
Available tools:
${ctToolCatalogue}`;

    cliToolsSysPrompt += `\n\n## Chat and Room Reply Style
- In a chat or room conversation, keep replies short and conversational, like a helpful colleague, not a report.
- Prefer plain sentences over large markdown tables. Only use a table if the user explicitly asks for one or the data genuinely needs columns to compare.
- Do not surface internal tool identifiers, function names, or system plumbing (for example bastionClient, memory_search, quox tool exec, or any other internal tool name) to the user. Describe what you did in plain language instead of naming the tool you called.
- Say what you found and what you recommend, then stop. Skip preambles and restating the question.`;

    if (selected_agent === 'quox' && Array.isArray(agentTools) && agentTools.some((t) => t.name === 'delegate_to_agent')) {
      cliToolsSysPrompt += isVoice ? `\n\n## Tools first (live voice call)
You are on a live VOICE call: every extra hop is dead air the caller hears. For live data or a simple action, CALL YOUR OWN TOOL directly (fleet_status, docker_status, email_read, ssh_exec, memory_search, and the rest, via quox tool exec) and answer from the real result, NEVER from memory. Use delegate_to_agent ONLY for genuinely specialist, multi-step work you cannot do yourself; a single status check, read, or lookup is never worth delegating. One or two tool calls, then answer.${VOICE_BRAIN_RECALL_PROMPT}` : `\n\n## Agent Delegation (your primary role)
You are the ORCHESTRATOR. For any task in a specialist's domain, DELEGATE it with the delegate_to_agent tool (run via quox tool exec) rather than doing it yourself. Prefer delegation by default; self-serve only for orchestration, synthesis, planning, and simple general queries.
Use delegate_to_agent with the real agent id:
- sentinel = security, cipher = networking, metrics = monitoring, forge = code/devops, scholar = research, prism = analysis; also atlas, nova, beacon, insight, corey, tester, or any custom agent id.
- Plugin specialists (only when the org has that plugin; if a delegation is refused as not enabled, tell the user plainly): inboxq = email and inbox, calendar-q = calendar and schedule, contactsq = people, contacts and reaching them, notesq = notes ("jot this down", "write that down", find, read or edit a note). Never claim you saved a note yourself: delegate to notesq and report what it returned.
- People (ContactsQ): a single quick lookup you do YOURSELF: contacts_search finds a person by name (if it says ambiguous, ask the user which one; never guess) and contacts_resolve maps a number or email to a contact. Anything beyond that (calling or messaging someone, channel choice, objections, history, facts, do-not-call) delegate to contactsq. You never see or need the number. Report the tool result exactly: 'queued' or 'pending approval' is not 'called'.
- The query spans multiple domains (e.g., "check security then deploy a fix") — delegate each leg.
Delegation guidelines:
- Give the specialist a clear, specific task — not the user's full query
- You can delegate multiple times in sequence, and set deadline_ms for time-sensitive turns
- After receiving delegation results, synthesize them into a coherent answer for the user
- If delegation fails or breaches its deadline, degrade gracefully or fall back to your own tools`;
    }

    if (memorySystemPrompt) cliToolsSysPrompt += memorySystemPrompt;
    if (wantsCaptureOverride(isVoice, agentTools)) cliToolsSysPrompt += captureOverride(isVoice);
    if (actionSystemPrompt) cliToolsSysPrompt += actionSystemPrompt;

    cliToolsSysPrompt += `\n\n## Response Format
Provide a clear, well-formatted response using markdown. Start with a brief summary, then details.
Agent: ${selected_agent}

## Tool Usage Rules
- If a tool call fails 2 times in a row, STOP retrying that tool and explain the failure to the user.
- Do NOT attempt more than 10 tool calls total per response. After 10 calls, summarize what you accomplished and what remains.
- If the bastion rejects a command (forbidden pattern), do NOT retry with variations — explain the limitation.
- Always respond with something useful even if tools fail. Never leave the user with no response.`;

    if (ctAllHostIds.length > 0) {
      cliToolsSysPrompt += `\n\n## Managed Infrastructure\n${ctAllHostIds.length} hosts: ${ctAllHostIds.join(', ')}\nAll accessible via ssh_exec (through quox tool exec) via the bastion${bastionHost ? ` (${bastionHost})` : ''}.`;
    }

    if (Array.isArray(conversation_history) && conversation_history.length > 0) {
      cliToolsSysPrompt += '\n\n## Recent Conversation\n';
      for (const turn of conversation_history.slice(-6)) {
        if (turn.role && turn.content) {
          cliToolsSysPrompt += `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.substring(0, 500)}\n`;
        }
      }
    }

    if (memory_context) {
      cliToolsSysPrompt += `\n\n## Memory\n${typeof memory_context === 'string' ? memory_context : JSON.stringify(memory_context)}`;
    }
    if (quox_context) {
      cliToolsSysPrompt += `\n\n## Context\n${typeof quox_context === 'string' ? quox_context : JSON.stringify(quox_context)}`;
    }

    if (decisionEvidenceLevel && decisionEvidenceLevel !== 'none' && typeof buildDecisionEvidenceInstructions === 'function') {
      cliToolsSysPrompt += buildDecisionEvidenceInstructions(decisionEvidenceLevel);
    }

    cliToolsSysPrompt = applyLenses(cliToolsSysPrompt, DEFAULT_LENSES);

    const ctIsUuid = typeof isValidUUID === 'function' ? isValidUUID(session_id) : false;

    const cliToolsArgs = [
      '--output-format', 'json',
      // VOICE FAST PATH: fast model + bounded tool loop, ONLY for a phone turn (isVoice). This is
      // what turns a 20-36s governed turn into a few seconds. Default (typed) chat is unchanged.
      ...(isVoice ? ['--model', CLAUDE_CLI_VOICE_MODEL, '--max-turns', String(CLAUDE_CLI_VOICE_MAX_TURNS)] : []),
      '--allowedTools', nativeAllowedTools('Bash(quox tool exec:*)', nativeWebSearch),
      // ToolSearch can never find a catalogue tool here (they are not native);
      // the model used it to conclude tools were missing (AQ-9D scorecard).
      '--disallowedTools', 'ToolSearch',
      '--system-prompt', cliToolsSysPrompt,
      ...(session_id && ctIsUuid ? ['-r', session_id] : []),
      '-p', userMessage,
    ];

    console.log(`[CLI-TOOLS] CLI call (${selected_agent}, sys_prompt: ${cliToolsSysPrompt.length} chars${ctIsUuid ? `, resume=${session_id.slice(0, 8)}...` : ''})`);

    const ctModelReqEvent = ctVoltEmit(ctVoltRunId, 'model.requested', {
      actor: { actor_type: 'system', actor_id: 'collector' },
      model: (requestedModel || claudeCliDefaultModel), path: 'cli-tools', prompt_length: cliToolsSysPrompt.length,
    });
    if (ctModelReqEvent?.event_id && typeof persistVoltContent === 'function') {
      persistVoltContent(ctVoltRunId, ctModelReqEvent.event_id, 'model.requested', {
        system_prompt: cliToolsSysPrompt,
        user_message: rawPrompt,
        model: (requestedModel || claudeCliDefaultModel),
        provider: 'anthropic-cli',
      });
    }

    // Extend the SAME cliEnv shape the MCP path builds (HOME/USER/OAuth
    // token), plus the service-key + org + collector-URL vars the `quox`
    // CLI's tool.js `exec` action + core/client.js resolve auth/routing
    // from (verified against source, see block comment above).
    const cliToolsEnv = {
      ...process.env,
      HOME: runtimeHomeDir,
      USER: runtimeUser,
      ...(cliOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: cliOAuthToken } : {}),
      // A `quox tool exec` of a delegating tool (notesq_research) can outlast the
      // CLI's 120s Bash default; the turn timeout above still bounds the whole turn.
      BASH_DEFAULT_TIMEOUT_MS: String(CLI_TOOLS_BASH_TIMEOUT_MS),
      BASH_MAX_TIMEOUT_MS: String(CLI_TOOLS_BASH_TIMEOUT_MS),
      QUOX_SERVICE_KEY: internalServiceKey,
      QUOX_FORCE_SERVICE_KEY: '1',
      QUOX_ORG_ID: orgId || jwtOrgId || '',
      // QUOXHAT T0 driven finding (2026-10-01): without these, `quox tool
      // exec` POSTed /api/v1/tools/execute with no session/user — the hat
      // gate on that route resolved the DEFAULT hat while the chat leg wore
      // the conversation's bound hat (exposure/execution disagreed), and
      // hat_load_bundle refused outright ("no conversation id"). Same env
      // channel org_id already rides; tool.js forwards them into the body.
      QUOX_SESSION_ID: ctSessionId,
      QUOX_USER_ID: userId || jwtUserId || '',
      // QUOXHAT #657 P-C.2: tell the spawned `quox` CLI which agent it is acting
      // as, so its service-key tool-exec calls carry agent_id=<this specialist>
      // instead of defaulting to the orchestrator 'quox'. Closes the "CLI exec
      // silently becomes quox" privilege-escalation bypass: under enforce the
      // hat gate now authorizes against the SPECIALIST's grant, not quox's.
      QUOX_AGENT_ID: selected_agent || '',
      QUOX_COLLECTOR_URL: process.env.QUOX_COLLECTOR_URL || `http://localhost:${collectorPort}`,
    };
    if (cliOAuthToken) {
      console.log('[Claude] Passing OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var');
    }

    const ctCliHealthy = typeof getClaudeCliHealth === 'function'
      ? await getClaudeCliHealth({ timeoutMs: 15000, cacheMs: 60000 })
      : { ok: true };

    if (!ctCliHealthy.ok) {
      const hint = ctCliHealthy.error && ctCliHealthy.error.includes('ENOENT')
        ? 'Claude CLI is not installed in the container.'
        : `Claude CLI error: ${(ctCliHealthy.error || '').substring(0, 100)}`;
      if (voltEmitter && typeof voltEmitter.failRun === 'function' && ctVoltRunId) {
        voltEmitter.failRun(ctVoltRunId, new Error(hint));
      }
      return {
        outcome: 'cli_unavailable',
        path: 'cli-tools',
        text: `Chat is temporarily unavailable. ${hint}`,
        voiceSummary: 'Chat is temporarily unavailable.',
        tokensUsed: 0,
        toolsUsed: [],
        model: (requestedModel || claudeCliDefaultModel),
        cost_usd: 0,
        hint,
        errorCode: 'cli_unavailable',
      };
    }

    try {
      const ctCliStart = Date.now();
      // Spawn + parse — same shape as the MCP path's block (timeout,
      // client-disconnect kill every 2s), args/env only differ per the
      // security posture documented above.
      const ctOutput = await new Promise((resolve, reject) => {
        const proc = spawnFn('claude', cliToolsArgs, { env: cliToolsEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
        // 285s: under the dashboard's 300s fetch abort and nginx's 300s read timeout.
        // 180s killed a research-then-save turn mid-save (AQ-9D, 2026-10-10).
        const CT_TIMEOUT_MS = (typeof maxDurationMs === 'number' && maxDurationMs > 0)
          ? maxDurationMs : CLI_TOOLS_TURN_TIMEOUT_MS;
        const timer = setTimeout(() => {
          console.error(`[CLI-TOOLS] CLI timeout after ${CT_TIMEOUT_MS / 1000}s — killing (stdout: ${stdout.length} chars)`);
          proc.kill();
        }, CT_TIMEOUT_MS);
        const disconnectCheck = setInterval(() => {
          if (typeof clientDisconnected === 'function' && clientDisconnected()) {
            clearInterval(disconnectCheck);
            console.log(`[CLI-TOOLS] Client disconnected — killing CLI process`);
            proc.kill();
          }
        }, 2000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          clearInterval(disconnectCheck);
          const elapsed = Math.round((Date.now() - ctCliStart) / 1000);
          if (code !== 0) {
            console.error(`[CLI-TOOLS] CLI failed after ${elapsed}s, code: ${code}`);
            if (stderr) console.error(`[CLI-TOOLS] stderr: ${stderr.substring(0, 500)}`);
            const err = new Error(`CLI exited with code ${code}`);
            err._stderr = stderr;
            err._stdout = stdout;
            reject(err);
          } else {
            console.log(`[CLI-TOOLS] CLI completed in ${elapsed}s, ${stdout.length} chars`);
            resolve(stdout);
          }
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          clearInterval(disconnectCheck);
          reject(err);
        });
      });

      const ctClaudeResponse = JSON.parse(ctOutput);

      if (ctClaudeResponse.is_error) {
        if (voltEmitter && typeof voltEmitter.failRun === 'function' && ctVoltRunId) {
          voltEmitter.failRun(ctVoltRunId, new Error(ctClaudeResponse.result || 'CLI error'));
        }
        if (typeof storeAuditEnvelope === 'function') {
          storeAuditEnvelope({
            type: 'error',
            from: `agent.${selected_agent}`,
            to: 'audit.system',
            intent: 'quox.chat.cli_error',
            corr: effectiveSessionId || session_id || `ERR_${Date.now()}`,
            payload: { error: ctClaudeResponse.result, agent: selected_agent, path: 'cli-tools' },
          });
        }
        if (typeof emitAgentEvent === 'function') {
          emitAgentEvent({
            session_id: ctSessionId,
            org_id: jwtOrgId,
            agent_name: selected_agent,
            type: 'session.end',
            data: { status: 'failed', error: ctClaudeResponse.result },
            summary: `Error: ${(ctClaudeResponse.result || 'CLI error').substring(0, 80)}`,
          });
        }
        return {
          outcome: 'cli_error',
          path: 'cli-tools',
          text: ctClaudeResponse.result || 'Claude error',
          voiceSummary: 'Sorry, there was an error.',
          tokensUsed: 0,
          toolsUsed: [],
          model: (requestedModel || claudeCliDefaultModel),
          cost_usd: 0,
          hint: 'Claude CLI returned an error. Check API keys in Settings → Core Integrations.',
          errorCode: ctClaudeResponse.result,
        };
      }

      const ctContent = ctClaudeResponse.result || '';
      const ctVoiceSummary = typeof extractVoiceSummary === 'function' ? extractVoiceSummary(ctContent) : '';

      const ctDecisionEvidence = typeof extractDecisionEvidence === 'function'
        ? extractDecisionEvidence(ctContent)
        : null;
      if (ctDecisionEvidence) {
        console.log(`[Claude] Decision evidence captured (level: ${decisionEvidenceLevel}, path: cli-tools)`);
      }
      const ctDecisionEvidenceRequested = !!(decisionEvidenceLevel && decisionEvidenceLevel !== 'none');
      const ctDecisionEvidenceMissing = ctDecisionEvidenceRequested && !ctDecisionEvidence;
      const ctEvidenceCorr = effectiveSessionId || ctClaudeResponse.session_id || session_id || `CHAT_${Date.now()}`;
      const ctCleanContent = ctDecisionEvidence
        ? ctContent.replace(/<decision_evidence>[\s\S]*?<\/decision_evidence>/g, '').trim()
        : ctContent;

      // getTrackedTools is keyed on the tools/execute body's session_id, which
      // `quox tool exec` sends from QUOX_SESSION_ID = ctSessionId (QUOXHAT T0).
      // Look up by THAT id: the caller's session_id is empty on a new chat, so
      // keying on it reported tools_used: [] for every turn (AQ-9D scorecard).
      const ctToolsUsed = mergeNativeTools(typeof getTrackedTools === 'function' ? getTrackedTools(ctSessionId) : [], ctClaudeResponse, nativeWebSearch);
      if (typeof clearTrackedTools === 'function') clearTrackedTools(ctSessionId);
      const ctToolExecutions = ctToolsUsed.map((name) => ({ name, args: {}, success: true, result: null }));

      ctVoltEmit(ctVoltRunId, 'model.responded', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        model: (requestedModel || claudeCliDefaultModel), path: 'cli-tools',
        response_length: ctContent.length,
        tool_count: ctToolsUsed.length,
        cost_usd: ctClaudeResponse.total_cost_usd || 0,
      });
      for (const toolName of ctToolsUsed) {
        const ctToolEvent = ctVoltEmit(ctVoltRunId, 'tool.call.executed', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          tool: toolName, path: 'cli-tools', success: true,
        });
        if (ctToolEvent?.event_id && typeof persistVoltContent === 'function') {
          persistVoltContent(ctVoltRunId, ctToolEvent.event_id, 'tool.call.executed', {
            tool_name: toolName,
            agent_id: selected_agent,
          });
        }
      }
      if (ctDecisionEvidenceMissing && voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && ctVoltRunId) {
        ctVoltEmit(ctVoltRunId, 'agent.decision.missing', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          level_required: decisionEvidenceLevel,
        });
      }
      if (ctDecisionEvidence && voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && ctVoltRunId) {
        ctVoltEmit(ctVoltRunId, 'agent.decision.recorded', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          evidence_level: decisionEvidenceLevel,
          decision: ctDecisionEvidence.decision,
          confidence: ctDecisionEvidence.confidence,
        });
      }
      if (voltEmitter && typeof voltEmitter.completeRun === 'function' && ctVoltRunId) {
        voltEmitter.completeRun(ctVoltRunId);
      }

      if (typeof emitAgentEvent === 'function') {
        emitAgentEvent({
          session_id: ctSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'session.end',
          data: { status: 'finished', tools_used: ctToolsUsed, duration_ms: Date.now() - ctStartTime },
          summary: `Chat completed (${ctToolsUsed.length} tools, ${Date.now() - ctStartTime}ms)`,
        });
      }
      if (typeof storeAuditEnvelope === 'function') {
        const ctEnvelopePayload = {
          agent: selected_agent,
          path: 'cli-tools',
          response_length: ctContent.length,
          query_preview: rawPrompt.length > 240 ? rawPrompt.slice(0, 237) + '…' : rawPrompt,
          response_preview: ctContent.length > 240 ? ctContent.slice(0, 237) + '…' : ctContent,
          text: ctContent.length > 240 ? ctContent.slice(0, 237) + '…' : ctContent,
          model: ctClaudeResponse.model || (requestedModel || claudeCliDefaultModel),
          provider: 'anthropic',
          input_tokens: ctClaudeResponse.usage?.input_tokens,
          output_tokens: ctClaudeResponse.usage?.output_tokens,
          cost_usd: ctClaudeResponse.total_cost_usd || 0,
          duration_ms: Date.now() - ctStartTime,
          tools_used: ctToolsUsed,
          tools_used_count: ctToolsUsed.length,
        };
        if (ctDecisionEvidence) ctEnvelopePayload.decision_evidence = ctDecisionEvidence;
        if (ctDecisionEvidenceMissing) ctEnvelopePayload.decision_evidence_missing = true;
        storeAuditEnvelope({
          type: 'event',
          from: `agent.${selected_agent}`,
          to: 'audit.system',
          intent: 'quox.chat.success',
          org_id: jwtOrgId || undefined,
          corr: ctEvidenceCorr,
          requires: ctDecisionEvidenceRequested
            ? { decision_evidence: decisionEvidenceLevel }
            : undefined,
          payload: ctEnvelopePayload,
        });
        if (ctDecisionEvidenceMissing) {
          storeAuditEnvelope({
            type: 'event',
            from: `agent.${selected_agent}`,
            to: 'audit.system',
            intent: 'quox.evidence.missing',
            corr: ctEvidenceCorr,
            payload: {
              agent: selected_agent,
              level_required: decisionEvidenceLevel,
              corr: ctEvidenceCorr,
            },
          });
        }
      }

      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(ctSessionId, ctCleanContent)).catch(() => {});
      } catch { /* non-fatal — evidence must never affect the chat path */ }

      return {
        outcome: 'success',
        path: 'cli-tools',
        text: ctCleanContent,
        voiceSummary: ctVoiceSummary,
        tokensUsed: (ctClaudeResponse.usage?.input_tokens || 0) + (ctClaudeResponse.usage?.output_tokens || 0),
        toolsUsed: ctToolsUsed,
        toolExecutions: ctToolExecutions,
        model: ctClaudeResponse.model || (requestedModel || claudeCliDefaultModel),
        cost_usd: ctClaudeResponse.total_cost_usd || 0,
        cliSessionId: ctClaudeResponse.session_id || null,
        richContent: null,
        decisionEvidence: ctDecisionEvidence || null,
        inputTokens: ctClaudeResponse.usage?.input_tokens,
        outputTokens: ctClaudeResponse.usage?.output_tokens,
        durationMs: Date.now() - ctStartTime,
      };
    } catch (ctErr) {
      const errMsg = ctErr.message || 'CLI-tools execution error';
      console.error(`[CLI-TOOLS] Error: ${errMsg}`);
      if (ctErr._stderr) console.error(`[CLI-TOOLS] stderr: ${ctErr._stderr.substring(0, 500)}`);
      if (ctErr._stdout) console.error(`[CLI-TOOLS] stdout (first 300): ${ctErr._stdout.substring(0, 300)}`);
      if (voltEmitter && typeof voltEmitter.failRun === 'function' && ctVoltRunId) {
        voltEmitter.failRun(ctVoltRunId, ctErr);
      }
      throw ctErr;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // MCP PATH — Claude drives tool selection via MCP
  // ────────────────────────────────────────────────────────────────────────
  if (mcpEnabled && !noToolsRequested) {
    console.log(`[MCP] PATH enabled — agent=${selected_agent}, session=${session_id}`);

    const mcpChatSessionId = effectiveSessionId || session_id
      || `SESSION_${typeof generateEnvelopeId === 'function' ? generateEnvelopeId() : Date.now().toString(36)}`;
    const mcpChatStartTime = Date.now();

    if (typeof emitAgentSession === 'function') {
      emitAgentSession({
        id: mcpChatSessionId,
        org_id: jwtOrgId,
        host_id: 'collector',
        agent_type: 'chat_assistant',
        agent_name: selected_agent,
        provider: 'anthropic',
        model: (requestedModel || claudeCliDefaultModel),
        status: 'running',
        user: jwtUserId || 'anonymous',
        project: 'quox-dashboard',
      });
    }

    if (typeof emitAgentEvent === 'function') {
      emitAgentEvent({
        session_id: mcpChatSessionId,
        org_id: jwtOrgId,
        agent_name: selected_agent,
        type: 'activity.message',
        data: { role: 'user', length: rawPrompt.length, agent: selected_agent, path: 'mcp' },
        summary: `User: ${rawPrompt.length > 80 ? rawPrompt.substring(0, 80) + '...' : rawPrompt}`,
      });
      emitAgentEvent({
        session_id: mcpChatSessionId,
        org_id: jwtOrgId,
        agent_name: selected_agent,
        type: 'activity.thinking',
        data: { path: 'mcp', agent: selected_agent },
        summary: `${selected_agent} processing via MCP...`,
      });
    }

    const voltRunId = voltEmitter && typeof voltEmitter.startRun === 'function'
      ? voltEmitter.startRun(mcpChatSessionId, {
          org_id: jwtOrgId || undefined,
          user_id: jwtUserId || undefined,
          agent_id: selected_agent,
          path: 'mcp',
        })
      : null;
    if (aoclCtx && voltRunId) aoclCtx.voltRunId = voltRunId;

    const voltEmit = (runId, eventType, payload) => {
      if (voltEmitter && typeof voltEmitter.emit === 'function' && runId) {
        return voltEmitter.emit(runId, eventType, payload);
      }
      return null;
    };

    // Get host inventory for system prompt context
    let allHostIds = [];
    try {
      const agentsData = await fetchFn(`http://127.0.0.1:${collectorPort}/api/v1/agents`).then((r) => r.json());
      allHostIds = (agentsData.agents || []).map((a) => a.host_id);
    } catch (e) {
      console.warn('[MCP] Could not fetch host inventory:', e.message);
    }

    // Write temporary MCP config with session-specific env vars
    const tmpConfig = `/tmp/quoxmcp-${session_id || Date.now()}.json`;
    const mcpConfig = {
      mcpServers: {
        'quox-tools': {
          command: 'node',
          args: ['/app/quoxmcp/server.js'],
          env: {
            QUOX_AGENT_ID: selected_agent,
            // BRAIN2-CORTEX P1b fix: use mcpChatSessionId (effectiveSessionId ||
            // session_id), NOT raw session_id. On the stack-mode path session_id
            // is empty (the client sends none; effectiveSessionId is the real
            // per-turn id and is what the response returns). An empty
            // QUOX_SESSION_ID makes quoxmcp mint its OWN random id, so
            // registerRetrieval keyed on a value nothing else knows and the
            // citation route 404'd. Forwarding effectiveSessionId aligns the
            // tool ctx.session_id with finalizeAnswer and the response id.
            QUOX_SESSION_ID: mcpChatSessionId || '',
            QUOX_COLLECTOR_URL: `http://127.0.0.1:${collectorPort}`,
            QUOX_SERVICE_KEY: internalServiceKey,
            QUOX_ORG_ID: orgId || jwtOrgId || '',
            QUOX_USER_ID: userId || jwtUserId || '',
            QUOX_AUTH_TOKEN: userAccessToken || '',
          },
        },
      },
    };
    const writeFile = typeof fsWriteFile === 'function'
      ? fsWriteFile
      : require('fs').writeFileSync;
    const unlinkFile = typeof fsUnlink === 'function'
      ? fsUnlink
      : (p) => { try { require('fs').unlinkSync(p); } catch {} };
    writeFile(tmpConfig, JSON.stringify(mcpConfig));

    // Build simplified system prompt — Claude calls tools itself
    let mcpSysPrompt = finalSystemPrompt + `\n\n## Voice Personality\n${persona}`;

    if (quox_context && typeof quox_context === 'string' && quox_context.includes('## QuoxMind Mirror')) {
      const mirrorStart = quox_context.indexOf('## QuoxMind Mirror');
      const mirrorEnd = quox_context.indexOf('\n\n', mirrorStart + 20);
      const mirrorSection = mirrorEnd > mirrorStart
        ? quox_context.substring(mirrorStart, mirrorEnd)
        : quox_context.substring(mirrorStart);
      mcpSysPrompt += `\n\n${mirrorSection}`;
    } else {
      const collectorMirror = typeof getCollectorMirrorCompact === 'function'
        ? getCollectorMirrorCompact() : '';
      if (collectorMirror) {
        mcpSysPrompt += `\n\n## System Status\n${collectorMirror}`;
      }
    }
    mcpSysPrompt += `\n\n## Rules
- You are ${selected_agent.toUpperCase()}, an AI infrastructure agent for QuoxCORE.
- You have infrastructure tools available via MCP. Use them to answer questions.
- When asked about hosts, fleet, containers, security, disk, memory, CPU — call the relevant tool.
- Present findings with clear markdown tables and actionable analysis.
- Never say "I can't access" or "I don't have tools" — call the tool.
- Never claim you are in a "sandbox" or that infrastructure is "not accessible" — you ARE connected.
- Never ask the user to run SSH commands — use ssh_exec to run them yourself.
- After getting tool results, analyse them and provide recommendations.
- If a tool call fails or times out, that IS diagnostic data — explain what the failure means.
- DO the work. Do NOT write assessment reports or escalation plans. Execute commands and show results.`;

    // CORECOMM-UX #190 — Rooms/chat replies were coming back as huge markdown
    // tables and were leaking internal tool identifiers to the user. This
    // keeps the existing Rules/Response Format blocks intact and adds a
    // short, separate instruction for the conversational surfaces.
    mcpSysPrompt += `\n\n## Chat and Room Reply Style
- In a chat or room conversation, keep replies short and conversational, like a helpful colleague, not a report.
- Prefer plain sentences over large markdown tables. Only use a table if the user explicitly asks for one or the data genuinely needs columns to compare.
- Do not surface internal tool identifiers, function names, or system plumbing (for example bastionClient, memory_search, quox-tools, or any other internal tool name) to the user. Describe what you did in plain language instead of naming the tool you called.
- Say what you found and what you recommend, then stop. Skip preambles and restating the question.`;

    if (selected_agent === 'quox' && Array.isArray(agentTools) && agentTools.some((t) => t.name === 'delegate_to_agent')) {
      mcpSysPrompt += isVoice ? `\n\n## Tools first (live voice call)
You are on a live VOICE call: every extra hop is dead air the caller hears. For live data or a simple action, CALL YOUR OWN TOOL directly (fleet_status, docker_status, email_read, ssh_exec, memory_search, and the rest) and answer from the real result, NEVER from memory. Use delegate_to_agent ONLY for genuinely specialist, multi-step work you cannot do yourself; a single status check, read, or lookup is never worth delegating. One or two tool calls, then answer.${VOICE_BRAIN_RECALL_PROMPT}` : `\n\n## Agent Delegation (your primary role)
You are the ORCHESTRATOR. For any task in a specialist's domain, DELEGATE it with the delegate_to_agent tool rather than doing it yourself. Prefer delegation by default; self-serve only for orchestration, synthesis, planning, and simple general queries.
Use delegate_to_agent (NOT any native messaging/subagent tool) with the real agent id:
- sentinel = security, cipher = networking, metrics = monitoring, forge = code/devops, scholar = research, prism = analysis; also atlas, nova, beacon, insight, corey, tester, or any custom agent id.
- Plugin specialists (only when the org has that plugin; if a delegation is refused as not enabled, tell the user plainly): inboxq = email and inbox, calendar-q = calendar and schedule, contactsq = people, contacts and reaching them, notesq = notes ("jot this down", "write that down", find, read or edit a note). Never claim you saved a note yourself: delegate to notesq and report what it returned.
- People (ContactsQ): a single quick lookup you do YOURSELF: contacts_search finds a person by name (if it says ambiguous, ask the user which one; never guess) and contacts_resolve maps a number or email to a contact. Anything beyond that (calling or messaging someone, channel choice, objections, history, facts, do-not-call) delegate to contactsq. You never see or need the number. Report the tool result exactly: 'queued' or 'pending approval' is not 'called'.
- The query spans multiple domains (e.g., "check security then deploy a fix") — delegate each leg.
Delegation guidelines:
- Give the specialist a clear, specific task — not the user's full query
- You can delegate multiple times in sequence, and set deadline_ms for time-sensitive turns
- After receiving delegation results, synthesize them into a coherent answer for the user
- If delegation fails or breaches its deadline, degrade gracefully or fall back to your own tools`;
    }

    if (memorySystemPrompt) mcpSysPrompt += memorySystemPrompt;
    if (wantsCaptureOverride(isVoice, agentTools)) mcpSysPrompt += captureOverride(isVoice);
    if (actionSystemPrompt) mcpSysPrompt += actionSystemPrompt;

    mcpSysPrompt += `\n\n## Response Format
Provide a clear, well-formatted response using markdown. Start with a brief summary, then details.
Agent: ${selected_agent}

## Tool Usage Rules
- If a tool call fails 2 times in a row, STOP retrying that tool and explain the failure to the user.
- Do NOT attempt more than 10 tool calls total per response. After 10 calls, summarize what you accomplished and what remains.
- If the bastion rejects a command (forbidden pattern), do NOT retry with variations — explain the limitation.
- Always respond with something useful even if tools fail. Never leave the user with no response.`;

    if (allHostIds.length > 0) {
      mcpSysPrompt += `\n\n## Managed Infrastructure\n${allHostIds.length} hosts: ${allHostIds.join(', ')}\nAll accessible via ssh_exec through the bastion${bastionHost ? ` (${bastionHost})` : ''}.`;
    }

    if (Array.isArray(conversation_history) && conversation_history.length > 0) {
      mcpSysPrompt += '\n\n## Recent Conversation\n';
      for (const turn of conversation_history.slice(-6)) {
        if (turn.role && turn.content) {
          mcpSysPrompt += `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.substring(0, 500)}\n`;
        }
      }
    }

    if (memory_context) {
      mcpSysPrompt += `\n\n## Memory\n${typeof memory_context === 'string' ? memory_context : JSON.stringify(memory_context)}`;
    }
    if (quox_context) {
      mcpSysPrompt += `\n\n## Context\n${typeof quox_context === 'string' ? quox_context : JSON.stringify(quox_context)}`;
    }

    // AUDIT-REAL-4b: Decision Evidence injection — mirrors
    // claudeMessagesDispatcher.js so evidence requests survive on the
    // OAuth/CLI path too, not just the API-key path.
    if (decisionEvidenceLevel && decisionEvidenceLevel !== 'none' && typeof buildDecisionEvidenceInstructions === 'function') {
      mcpSysPrompt += buildDecisionEvidenceInstructions(decisionEvidenceLevel);
    }

    // QUOXLENS P0 seam. DEFAULT_LENSES is [] here, so this is a no-op today —
    // see the comment on DEFAULT_LENSES above for why.
    mcpSysPrompt = applyLenses(mcpSysPrompt, DEFAULT_LENSES);

    // GAP-2: resume the CLI's own conversation when the caller passed back a
    // real UUID session id (the CLI always returns one in claudeResponse.session_id
    // — see the `cliSessionId` field on the returned object below). The
    // collector's own generated ids (e.g. `SESSION_ENV_...`) are never UUIDs,
    // so isValidUUID correctly refuses those and the CLI starts a fresh turn.
    const mcpIsUuid = typeof isValidUUID === 'function' ? isValidUUID(session_id) : false;

    const mcpCliArgs = [
      '--output-format', 'json',
      // VOICE FAST PATH (owner 2026-10-09): a phone turn forces a fast model + bounded tool loop.
      // This is the path a live voice call actually takes (mcpEnabled). Default chat is unchanged.
      ...(isVoice ? ['--model', CLAUDE_CLI_VOICE_MODEL, '--max-turns', String(CLAUDE_CLI_VOICE_MAX_TURNS)] : []),
      '--dangerously-skip-permissions',
      // COMMANDERQ P7 (root cause #1): scope the CLI to ONLY the governed
      // quox-tools MCP server. Without this the model also saw Claude Code's
      // NATIVE tools (Task/SendMessage subagents, Bash, file IO) and used the
      // native subagent tool INSTEAD of the governed delegate_to_agent — so
      // delegation happened ungoverned (no routing_verdict, no latency
      // contract) and the model held every native tool unrestricted under
      // --dangerously-skip-permissions (a security hole). Allowlisting the MCP
      // server (not denylisting natives — allowlist is the safe posture) makes
      // delegate_to_agent the ONLY delegation path and removes native tool access.
      '--allowedTools', nativeAllowedTools('mcp__quox-tools', nativeWebSearch),
      '--mcp-config', tmpConfig,
      '--system-prompt', mcpSysPrompt,
    ];
    if (session_id && mcpIsUuid) {
      mcpCliArgs.push('-r', session_id);
    }
    mcpCliArgs.push('-p', userMessage);

    console.log(`[MCP] CLI call (${selected_agent}, mcp_config=${tmpConfig}, sys_prompt: ${mcpSysPrompt.length} chars${mcpIsUuid ? `, resume=${session_id.slice(0, 8)}...` : ''})`);

    const mcpModelReqEvent = voltEmit(voltRunId, 'model.requested', {
      actor: { actor_type: 'system', actor_id: 'collector' },
      model: (requestedModel || claudeCliDefaultModel), path: 'mcp', prompt_length: mcpSysPrompt.length,
    });
    if (mcpModelReqEvent?.event_id && typeof persistVoltContent === 'function') {
      persistVoltContent(voltRunId, mcpModelReqEvent.event_id, 'model.requested', {
        system_prompt: mcpSysPrompt,
        user_message: rawPrompt,
        model: (requestedModel || claudeCliDefaultModel),
        provider: 'anthropic-cli',
      });
    }

    const cliEnv = {
      ...process.env,
      HOME: runtimeHomeDir,
      USER: runtimeUser,
      ...(cliOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: cliOAuthToken } : {}),
    };
    if (cliOAuthToken) {
      console.log('[Claude] Passing OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var');
    }

    const cliHealthy = typeof getClaudeCliHealth === 'function'
      ? await getClaudeCliHealth({ timeoutMs: 15000, cacheMs: 60000 })
      : { ok: true };

    if (!cliHealthy.ok) {
      unlinkFile(tmpConfig);
      const hint = cliHealthy.error && cliHealthy.error.includes('ENOENT')
        ? 'Claude CLI is not installed in the container.'
        : `Claude CLI error: ${(cliHealthy.error || '').substring(0, 100)}`;
      if (voltEmitter && typeof voltEmitter.failRun === 'function' && voltRunId) {
        voltEmitter.failRun(voltRunId, new Error(hint));
      }
      return {
        outcome: 'cli_unavailable',
        path: 'mcp',
        text: `Chat is temporarily unavailable. ${hint}`,
        voiceSummary: 'Chat is temporarily unavailable.',
        tokensUsed: 0,
        toolsUsed: [],
        model: (requestedModel || claudeCliDefaultModel),
        cost_usd: 0,
        hint,
        errorCode: 'cli_unavailable',
      };
    }

    try {
      const cliStart = Date.now();
      const output = await new Promise((resolve, reject) => {
        const proc = spawnFn('claude', mcpCliArgs, { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
        const MCP_TIMEOUT_MS = (typeof maxDurationMs === 'number' && maxDurationMs > 0)
          ? maxDurationMs : 180000;
        const timer = setTimeout(() => {
          console.error(`[MCP] CLI timeout after ${MCP_TIMEOUT_MS / 1000}s — killing (stdout: ${stdout.length} chars)`);
          proc.kill();
        }, MCP_TIMEOUT_MS);
        const disconnectCheck = setInterval(() => {
          if (typeof clientDisconnected === 'function' && clientDisconnected()) {
            clearInterval(disconnectCheck);
            console.log(`[MCP] Client disconnected — killing CLI process`);
            proc.kill();
          }
        }, 2000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          clearInterval(disconnectCheck);
          const elapsed = Math.round((Date.now() - cliStart) / 1000);
          if (code !== 0) {
            console.error(`[MCP] CLI failed after ${elapsed}s, code: ${code}`);
            if (stderr) console.error(`[MCP] stderr: ${stderr.substring(0, 500)}`);
            const err = new Error(`CLI exited with code ${code}`);
            err._stderr = stderr;
            err._stdout = stdout;
            reject(err);
          } else {
            console.log(`[MCP] CLI completed in ${elapsed}s, ${stdout.length} chars`);
            resolve(stdout);
          }
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          clearInterval(disconnectCheck);
          reject(err);
        });
      });

      const claudeResponse = JSON.parse(output);

      if (claudeResponse.is_error) {
        if (voltEmitter && typeof voltEmitter.failRun === 'function' && voltRunId) {
          voltEmitter.failRun(voltRunId, new Error(claudeResponse.result || 'CLI error'));
        }
        if (typeof storeAuditEnvelope === 'function') {
          storeAuditEnvelope({
            type: 'error',
            from: `agent.${selected_agent}`,
            to: 'audit.system',
            intent: 'quox.chat.cli_error',
            corr: effectiveSessionId || session_id || `ERR_${Date.now()}`,
            payload: { error: claudeResponse.result, agent: selected_agent, path: 'mcp' },
          });
        }
        if (typeof emitAgentEvent === 'function') {
          emitAgentEvent({
            session_id: mcpChatSessionId,
            org_id: jwtOrgId,
            agent_name: selected_agent,
            type: 'session.end',
            data: { status: 'failed', error: claudeResponse.result },
            summary: `Error: ${(claudeResponse.result || 'CLI error').substring(0, 80)}`,
          });
        }
        return {
          outcome: 'cli_error',
          path: 'mcp',
          text: claudeResponse.result || 'Claude error',
          voiceSummary: 'Sorry, there was an error.',
          tokensUsed: 0,
          toolsUsed: [],
          model: (requestedModel || claudeCliDefaultModel),
          cost_usd: 0,
          hint: 'Claude CLI returned an error. Check API keys in Settings → Core Integrations.',
          errorCode: claudeResponse.result,
        };
      }

      const content = claudeResponse.result || '';
      const voiceSummary = typeof extractVoiceSummary === 'function' ? extractVoiceSummary(content) : '';

      // AUDIT-REAL-4b: extract decision evidence from the CLI response —
      // mirrors claudeMessagesDispatcher.js response handling.
      const decisionEvidence = typeof extractDecisionEvidence === 'function'
        ? extractDecisionEvidence(content)
        : null;
      if (decisionEvidence) {
        console.log(`[Claude] Decision evidence captured (level: ${decisionEvidenceLevel}, path: mcp)`);
      }
      const decisionEvidenceRequested = !!(decisionEvidenceLevel && decisionEvidenceLevel !== 'none');
      const decisionEvidenceMissing = decisionEvidenceRequested && !decisionEvidence;
      const evidenceCorr = effectiveSessionId || claudeResponse.session_id || session_id || `CHAT_${Date.now()}`;
      const cleanContent = decisionEvidence
        ? content.replace(/<decision_evidence>[\s\S]*?<\/decision_evidence>/g, '').trim()
        : content;

      const mcpToolsUsed = mergeNativeTools(typeof getTrackedTools === 'function' ? getTrackedTools(session_id) : [], claudeResponse, nativeWebSearch);
      if (typeof clearTrackedTools === 'function') clearTrackedTools(session_id);
      const mcpToolExecutions = mcpToolsUsed.map((name) => ({ name, args: {}, success: true, result: null }));

      voltEmit(voltRunId, 'model.responded', {
        actor: { actor_type: 'agent', actor_id: selected_agent },
        model: (requestedModel || claudeCliDefaultModel), path: 'mcp',
        response_length: content.length,
        tool_count: mcpToolsUsed.length,
        cost_usd: claudeResponse.total_cost_usd || 0,
      });
      for (const toolName of mcpToolsUsed) {
        const mcpToolEvent = voltEmit(voltRunId, 'tool.call.executed', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          tool: toolName, path: 'mcp', success: true,
        });
        if (mcpToolEvent?.event_id && typeof persistVoltContent === 'function') {
          persistVoltContent(voltRunId, mcpToolEvent.event_id, 'tool.call.executed', {
            tool_name: toolName,
            agent_id: selected_agent,
          });
        }
      }
      // AUDIT-REAL-4b: VOLT decision-evidence signals — recorded/missing —
      // must land on the still-open run, before completeRun below.
      if (decisionEvidenceMissing && voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && voltRunId) {
        voltEmit(voltRunId, 'agent.decision.missing', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          level_required: decisionEvidenceLevel,
        });
      }
      if (decisionEvidence && voltEmitter && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable() && voltRunId) {
        voltEmit(voltRunId, 'agent.decision.recorded', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          evidence_level: decisionEvidenceLevel,
          decision: decisionEvidence.decision,
          confidence: decisionEvidence.confidence,
        });
      }
      if (voltEmitter && typeof voltEmitter.completeRun === 'function' && voltRunId) {
        voltEmitter.completeRun(voltRunId);
      }

      if (typeof emitAgentEvent === 'function') {
        emitAgentEvent({
          session_id: mcpChatSessionId,
          org_id: jwtOrgId,
          agent_name: selected_agent,
          type: 'session.end',
          data: { status: 'finished', tools_used: mcpToolsUsed, duration_ms: Date.now() - mcpChatStartTime },
          summary: `Chat completed (${mcpToolsUsed.length} tools, ${Date.now() - mcpChatStartTime}ms)`,
        });
      }
      if (typeof storeAuditEnvelope === 'function') {
        const mcpEnvelopePayload = {
          agent: selected_agent,
          path: 'mcp',
          response_length: content.length,
          query_preview: rawPrompt.length > 240 ? rawPrompt.slice(0, 237) + '…' : rawPrompt,
          response_preview: content.length > 240 ? content.slice(0, 237) + '…' : content,
          text: content.length > 240 ? content.slice(0, 237) + '…' : content,
          model: claudeResponse.model || (requestedModel || claudeCliDefaultModel),
          provider: 'anthropic',
          input_tokens: claudeResponse.usage?.input_tokens,
          output_tokens: claudeResponse.usage?.output_tokens,
          cost_usd: claudeResponse.total_cost_usd || 0,
          duration_ms: Date.now() - mcpChatStartTime,
          tools_used: mcpToolsUsed,
          tools_used_count: mcpToolsUsed.length,
        };
        if (decisionEvidence) {
          mcpEnvelopePayload.decision_evidence = decisionEvidence;
        }
        if (decisionEvidenceMissing) {
          mcpEnvelopePayload.decision_evidence_missing = true;
        }
        storeAuditEnvelope({
          type: 'event',
          from: `agent.${selected_agent}`,
          to: 'audit.system',
          intent: 'quox.chat.success',
          org_id: jwtOrgId || undefined,
          corr: evidenceCorr,
          requires: decisionEvidenceRequested
            ? { decision_evidence: decisionEvidenceLevel }
            : undefined,
          payload: mcpEnvelopePayload,
        });

        if (decisionEvidenceMissing) {
          storeAuditEnvelope({
            type: 'event',
            from: `agent.${selected_agent}`,
            to: 'audit.system',
            intent: 'quox.evidence.missing',
            corr: evidenceCorr,
            payload: {
              agent: selected_agent,
              level_required: decisionEvidenceLevel,
              corr: evidenceCorr,
            },
          });
        }
      }

      // Stream R: build richContent from response text / tracked tools
      let mcpRichContent = null;
      const hasObjectiveSignal = mcpToolsUsed.includes('orchestrate_objective')
        || content.includes('Objective') || content.includes('objective')
        || content.includes('decompos') || content.includes('auto-approve');
      if (hasObjectiveSignal) {
        const objIdMatch = content.match(/\b(01[A-HJ-NP-Z0-9]{24,26})\b/);
        if (objIdMatch) {
          try {
            const svcKey = internalServiceKey || '';
            const objRes = await fetchFn(`${tasksServiceUrl}/api/objectives/${objIdMatch[1]}`, {
              headers: svcKey ? { 'x-service-key': svcKey, 'x-org-id': jwtOrgId || '', 'x-user-id': jwtUserId || '' } : {},
              signal: AbortSignal.timeout(5000),
            });
            if (objRes && objRes.ok) {
              const objData = await objRes.json();
              mcpRichContent = {
                type: objData.status === 'running' ? 'objective_progress'
                  : objData.status === 'completed' ? 'objective_complete'
                  : 'objective_created',
                objectiveId: objData.id,
                title: objData.title,
                status: objData.status,
                taskCount: objData.task_count || (objData.tasks || []).length,
                teamId: objData.team_id,
                links: { mission_control: '/mission-control?tab=objectives', opsdeck: `/opsdeck?objective=${objData.id}` },
                tasks: (objData.tasks || []).map((t) => ({ title: t.title, agent_id: t.agent_id, status: t.status })),
              };
            }
          } catch (e) { console.warn('[MCP] Rich content fetch failed:', e.message); }
        }
      } else if (mcpToolsUsed.includes('save_as_workflow')) {
        mcpRichContent = { type: 'workflow_saved', title: 'Workflow saved', links: { schedules: '/mission-control?tab=schedules' } };
      }

      if (!mcpRichContent && (
        mcpToolsUsed.includes('browser_objective_create')
          || mcpToolsUsed.includes('browser_objective_execute')
          || mcpToolsUsed.includes('browser_objective_save_sequence')
      )) {
        const objIdMatch = content.match(/obj_[a-z0-9_]+/);
        mcpRichContent = {
          type: mcpToolsUsed.includes('browser_objective_execute') ? 'browser_objective_running'
            : mcpToolsUsed.includes('browser_objective_save_sequence') ? 'browser_objective_saved'
            : 'browser_objective_created',
          objectiveId: objIdMatch ? objIdMatch[0] : null,
          links: { browser_q: '/browser-q' },
        };
      }

      // BRAIN2-V2-1: retrieval → answer. On this sub-path the tool call goes
      // out of process (claude CLI → quoxmcp → POST /api/v1/tools/execute on
      // THIS collector), and quoxmcp forwards QUOX_SESSION_ID — written from
      // `session_id` at the MCP config above — as the request's session_id,
      // which becomes ctx.session_id. mcpChatSessionId (effectiveSessionId ||
      // session_id) is written to QUOX_SESSION_ID above, so the SAME value keys
      // registerRetrieval (ctx.session_id), finalizeAnswer here, AND the
      // response session_id the dock fetches with. brainCitationTrace
      // canonicalises it to absorb quoxmcp's SAFE_ID sanitisation of
      // non-conforming ids (e.g. matrix room ids).
      try {
        const { finalizeAnswer } = require('./brainCitationTrace.js');
        Promise.resolve(finalizeAnswer(mcpChatSessionId, cleanContent)).catch(() => {});
      } catch { /* non-fatal — evidence must never affect the chat path */ }

      return {
        outcome: 'success',
        path: 'mcp',
        text: cleanContent,
        voiceSummary,
        tokensUsed: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
        toolsUsed: mcpToolsUsed,
        toolExecutions: mcpToolExecutions,
        model: claudeResponse.model || (requestedModel || claudeCliDefaultModel),
        cost_usd: claudeResponse.total_cost_usd || 0,
        cliSessionId: claudeResponse.session_id || null,
        richContent: mcpRichContent,
        decisionEvidence: decisionEvidence || null,
        inputTokens: claudeResponse.usage?.input_tokens,
        outputTokens: claudeResponse.usage?.output_tokens,
        durationMs: Date.now() - mcpChatStartTime,
      };
    } catch (mcpErr) {
      const errMsg = mcpErr.message || 'MCP execution error';
      console.error(`[MCP] Error: ${errMsg}`);
      if (mcpErr._stderr) console.error(`[MCP] stderr: ${mcpErr._stderr.substring(0, 500)}`);
      if (mcpErr._stdout) console.error(`[MCP] stdout (first 300): ${mcpErr._stdout.substring(0, 300)}`);

      if (voltEmitter && typeof voltEmitter.failRun === 'function' && voltRunId) {
        voltEmitter.failRun(voltRunId, mcpErr);
      }
      throw mcpErr;
    } finally {
      unlinkFile(tmpConfig);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // LEGACY PATH — regex pre-execution + single CLI shot
  // ────────────────────────────────────────────────────────────────────────

  const resolvedPrompt = typeof resolveFollowUp === 'function'
    ? resolveFollowUp(rawPrompt, conversation_history)
    : rawPrompt;

  const toolResults = typeof detectAndExecuteTools === 'function'
    ? await detectAndExecuteTools(resolvedPrompt, selected_agent)
    : [];
  const toolsUsed = toolResults.map((r) => r.tool);
  const toolExecutions = toolResults.map((r) => ({
    name: r.tool,
    args: r.input ?? {},
    success: r.result?.success !== false && !r.result?.error && !r.error,
    result: r.result ?? null,
  }));

  if (typeof storeAuditEnvelope === 'function') {
    for (const tr of toolResults) {
      storeAuditEnvelope({
        type: 'event',
        from: `agent.${selected_agent}`,
        to: 'system.tools',
        intent: 'quox.tool.pre_executed',
        corr: effectiveSessionId || session_id || `TOOL_${Date.now()}`,
        payload: { tool_name: tr.tool, pre_detected: true, agent: selected_agent, success: !tr.error },
      });
    }
  }

  // Inject cached fleet data for context — hosts inventory valuable regardless
  const sessionToolCache = typeof getToolCache === 'function' ? getToolCache(session_id) : null;
  if (sessionToolCache) {
    const hasFleetData = toolResults.some((r) => r.tool === 'fleet_status');
    const cachedFleetResults = sessionToolCache.filter((r) => r.tool === 'fleet_status');
    if (!hasFleetData && cachedFleetResults.length > 0) {
      console.log(`[Tools] Injecting cached fleet data for host context`);
      toolResults.push(...cachedFleetResults.map((r) => ({ ...r, cached: true })));
    }
    if (toolResults.length === 0) {
      console.log(`[Tools] No tools matched — re-injecting ${sessionToolCache.length} cached results`);
      toolResults.push(...sessionToolCache.map((r) => ({ ...r, cached: true })));
    }
  }

  // Cache this turn's fresh results
  const freshResults = toolResults.filter((r) => !r.cached);
  if (freshResults.length > 0 && typeof setToolCache === 'function') {
    setToolCache(session_id, freshResults);
  }

  // Context-aware auto-diagnostics
  const fleetData = toolResults.find((r) => r.tool === 'fleet_status')?.result;
  const allHostIds = (fleetData?.hosts || []).map((h) => h.host);

  function extractHostsFromConversation(history) {
    if (!Array.isArray(history) || allHostIds.length === 0) return [];
    const mentioned = new Set();
    const text = history.map((t) => t.content || '').join(' ').toLowerCase();
    for (const hostId of allHostIds) {
      if (text.includes(hostId.toLowerCase())) mentioned.add(hostId);
    }
    return [...mentioned];
  }

  const cachedFleet = toolResults.find((r) => r.cached && r.tool === 'fleet_status');
  if (cachedFleet?.result?.hosts && typeof executeTool === 'function') {
    const flaggedHosts = cachedFleet.result.hosts.filter((h) =>
      h.health !== 'healthy' || h.connection !== 'connected',
    );
    const conversationHosts = extractHostsFromConversation(conversation_history);
    const diagTargets = new Set(flaggedHosts.map((h) => h.host));
    for (const ch of conversationHosts) diagTargets.add(ch);

    if (diagTargets.size > 0) {
      console.log(`[Tools] Auto-diagnosing ${diagTargets.size} host(s): ${[...diagTargets].join(', ')}`);
      const diagPromises = [...diagTargets].slice(0, 4).flatMap((hostId) => [
        executeTool('docker_status', { host: hostId, all: true }, { agentId: selected_agent })
          .then((r) => ({ tool: 'docker_status', result: { host: hostId, ...r } }))
          .catch((e) => ({ tool: 'docker_status', result: { host: hostId, error: e.message } })),
        executeTool('ssh_exec', { host: hostId, command: 'systemctl --failed' }, { agentId: selected_agent })
          .then((r) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'failed_services', ...r } }))
          .catch((e) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'failed_services', error: e.message } })),
        executeTool('ssh_exec', { host: hostId, command: 'journalctl --no-pager -p err -n 20' }, { agentId: selected_agent })
          .then((r) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'recent_errors', ...r } }))
          .catch((e) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'recent_errors', error: e.message } })),
        executeTool('ssh_exec', { host: hostId, command: 'ss -tlnp' }, { agentId: selected_agent })
          .then((r) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'listening_ports', ...r } }))
          .catch((e) => ({ tool: 'ssh_exec', result: { host: hostId, check: 'listening_ports', error: e.message } })),
      ]);
      const diagResults = await Promise.all(diagPromises);
      for (const dr of diagResults) {
        toolResults.push(dr);
        const ok = !dr.result?.error && dr.result?.success !== false;
        console.log(`[Tools] ${dr.tool} on ${dr.result?.host} (${dr.result?.check || 'docker'}): ${ok ? 'success' : 'failed'}`);
      }
    }
  }

  // Build system prompt: rules first, data second, capabilities last
  let sysPrompt = finalSystemPrompt + `\n\n## Voice Personality\n${persona}`;

  sysPrompt += `\n\n## Operating Rules (CRITICAL — follow these exactly)
- You are ${selected_agent.toUpperCase()}, an AI agent controlling real infrastructure via SSH bastion.
- The system has ALREADY executed tools and collected data for you. It is below in "Live Data".
- Your job: ANALYSE the data and present findings. Do NOT say "I'll check" or "let me investigate" — the data is already here.
- If some checks failed (SSH timeout), that IS diagnostic information — explain what the failure means (firewall, sshd down, etc).
- NEVER suggest manual SSH commands for the user to run.
- NEVER ask "shall I investigate?" — just present your analysis.
- NEVER say you are waiting for data or that sweeps are running. The data collection is COMPLETE.
- Present findings with clear markdown tables and assessment.`;

  if (toolResults.length > 0) {
    const successResults = toolResults.filter((tr) => tr.result?.success !== false && !tr.result?.error);
    const failedResults = toolResults.filter((tr) => tr.result?.success === false || tr.result?.error);

    if (successResults.length > 0) {
      sysPrompt += '\n\n## Live Data (collected just now from real systems — analyse this)\n';
      for (const tr of successResults) {
        const label = tr.tool + (tr.result?.host ? ` (${tr.result.host})` : '') + (tr.result?.check ? ` — ${tr.result.check}` : '');
        sysPrompt += `\n### ${label}:\n\`\`\`json\n${JSON.stringify(tr.result, null, 2).substring(0, 4000)}\n\`\`\`\n`;
      }
    }
    if (failedResults.length > 0) {
      sysPrompt += '\n\n## Failed Checks (these failures are diagnostic clues)\n';
      for (const tr of failedResults) {
        const host = tr.result?.host || 'unknown';
        const check = tr.result?.check || tr.tool;
        const err = tr.result?.error || tr.result?.stderr || 'timeout/unreachable';
        sysPrompt += `- ${check} on ${host}: ${err}\n`;
      }
      sysPrompt += 'SSH timeouts mean the host OS is alive (agent heartbeating) but port 22 is blocked or sshd is down.\n';
    }
  }

  if (allHostIds.length > 0) {
    const hostSummary = (fleetData?.hosts || []).map((h) =>
      `${h.host} (${h.ip || '?'}) [${h.health}] cpu:${h.cpu} mem:${h.memory}`,
    ).join('\n');
    sysPrompt += `\n\n## All Hosts (${allHostIds.length} connected)\n${hostSummary}`;
  }

  if (Array.isArray(conversation_history) && conversation_history.length > 0) {
    sysPrompt += '\n\n## Recent Conversation\n';
    for (const turn of conversation_history.slice(-6)) {
      if (turn.role && turn.content) {
        sysPrompt += `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.substring(0, 600)}\n`;
      }
    }
  }

  if (memory_context) {
    sysPrompt += `\n\n## Memory\n${typeof memory_context === 'string' ? memory_context : JSON.stringify(memory_context)}`;
  }
  if (quox_context) {
    sysPrompt += `\n\n## Infrastructure Context\n${typeof quox_context === 'string' ? quox_context : JSON.stringify(quox_context)}`;
  }

  sysPrompt += `\n\n## System Capabilities (for reference)
The system pre-executes these tools before each turn: ${(Array.isArray(agentTools) ? agentTools.map((t) => t.name) : []).join(', ')}.
Specialist agents available for delegation (delegate to these ids via delegate_to_agent): sentinel (security), cipher (networking), metrics (monitoring), forge (code/devops), scholar (research), prism (analysis), plus atlas, nova, beacon, insight, corey, tester.
All ${allHostIds.length} hosts are reachable via SSH bastion.`;

  // AUDIT-REAL-4b: Decision Evidence injection — mirrors
  // claudeMessagesDispatcher.js so evidence requests survive on the legacy
  // (pre-executed tools) CLI path too.
  if (decisionEvidenceLevel && decisionEvidenceLevel !== 'none' && typeof buildDecisionEvidenceInstructions === 'function') {
    sysPrompt += buildDecisionEvidenceInstructions(decisionEvidenceLevel);
  }

  const cliArgs = ['--output-format', 'json', '--dangerously-skip-permissions'];
  const hasCachedTools = toolResults.some((r) => r.cached);
  const isUuid = typeof isValidUUID === 'function' ? isValidUUID(session_id) : false;
  if (session_id && isUuid && !hasCachedTools) {
    cliArgs.push('-r', session_id);
  }
  cliArgs.push('--system-prompt', sysPrompt, '-p', userMessage);

  const allToolNames = toolResults.map((r) => r.tool);
  console.log(`[Claude] CLI call (${selected_agent}, ${allToolNames.length} pre-executed tools [${allToolNames.join(', ') || 'none'}], sys_prompt: ${sysPrompt.length} chars, user_msg: ${userMessage.length} chars) (subscription)`);

  const cliEnv = {
    ...process.env,
    HOME: runtimeHomeDir,
    USER: runtimeUser,
    ...(cliOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: cliOAuthToken } : {}),
  };
  if (cliOAuthToken) {
    console.log('[Claude] Passing OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var');
  }

  const cliHealthy = typeof getClaudeCliHealth === 'function'
    ? await getClaudeCliHealth({ timeoutMs: 10000, cacheMs: 60000 })
    : { ok: true };

  if (!cliHealthy.ok) {
    const hint = cliHealthy.error && cliHealthy.error.includes('ENOENT')
      ? 'Claude CLI is not installed in the container.'
      : cliHealthy.error && cliHealthy.error.includes('timeout')
        ? 'Claude CLI is not responding. The OAuth token may be expired.'
        : `Claude CLI error: ${typeof sanitizeErrorForUser === 'function' ? sanitizeErrorForUser(cliHealthy.error) : cliHealthy.error}`;
    if (typeof storeAuditEnvelope === 'function') {
      storeAuditEnvelope({
        type: 'error',
        from: `agent.${selected_agent}`,
        to: 'audit.system',
        intent: 'quox.chat.cli_health_failed',
        corr: effectiveSessionId || session_id || `ERR_${Date.now()}`,
        payload: { error: hint, agent: selected_agent },
      });
    }
    return {
      outcome: 'cli_unavailable',
      path: 'cli',
      text: `Chat is temporarily unavailable. ${hint} Consider adding an OpenAI or Anthropic API Key in Settings → Core Integrations for a more reliable connection.`,
      voiceSummary: 'Chat is temporarily unavailable.',
      tokensUsed: 0,
      toolsUsed: allToolNames,
      toolExecutions,
      model: (requestedModel || claudeCliDefaultModel),
      cost_usd: 0,
      hint: 'Add an OpenAI or Anthropic API Key in Settings → Core Integrations for direct API access (recommended).',
      errorCode: 'cli_unavailable',
    };
  }

  const cliStart = Date.now();
  const output = await new Promise((resolve, reject) => {
    const proc = spawnFn('claude', cliArgs, { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
    const timer = setTimeout(() => {
      console.error(`[Claude] CLI timeout after 600s, killing (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`);
      proc.kill();
    }, 600000);
    const disconnectCheck = setInterval(() => {
      if (typeof clientDisconnected === 'function' && clientDisconnected()) {
        clearInterval(disconnectCheck);
        console.log(`[Claude] Client disconnected — killing legacy CLI process`);
        proc.kill();
      }
    }, 2000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(disconnectCheck);
      const elapsed = Math.round((Date.now() - cliStart) / 1000);
      if (code !== 0) {
        console.error(`[Claude] CLI failed after ${elapsed}s, code: ${code}, stdout: ${stdout.length} chars`);
        const err = new Error(`CLI exited with code ${code}`);
        err._stderr = stderr;
        err._stdout = stdout;
        reject(err);
      } else {
        console.log(`[Claude] CLI completed in ${elapsed}s, ${stdout.length} chars`);
        resolve(stdout);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(disconnectCheck);
      err._stderr = stderr;
      err._stdout = stdout;
      reject(err);
    });
  });

  const claudeResponse = JSON.parse(output);

  if (claudeResponse.is_error) {
    if (typeof storeAuditEnvelope === 'function') {
      storeAuditEnvelope({
        type: 'error',
        from: `agent.${selected_agent}`,
        to: 'audit.system',
        intent: 'quox.chat.cli_error',
        corr: effectiveSessionId || session_id || `ERR_${Date.now()}`,
        payload: { error: claudeResponse.result, agent: selected_agent, path: 'cli_legacy' },
      });
    }
    return {
      outcome: 'cli_error',
      path: 'cli',
      text: claudeResponse.result || 'Claude error',
      voiceSummary: 'Sorry, there was an error.',
      tokensUsed: 0,
      toolsUsed: allToolNames,
      toolExecutions,
      model: (requestedModel || claudeCliDefaultModel),
      cost_usd: 0,
      errorCode: claudeResponse.result,
    };
  }

  const content = claudeResponse.result || '';
  const voiceSummary = typeof extractVoiceSummary === 'function' ? extractVoiceSummary(content) : '';
  const toolSuffix = toolsUsed.length > 0 ? `\n\n---\n*Tools used: ${toolsUsed.join(', ')}*` : '';

  // AUDIT-REAL-4b: extract decision evidence from the CLI response —
  // mirrors claudeMessagesDispatcher.js response handling.
  const decisionEvidence = typeof extractDecisionEvidence === 'function'
    ? extractDecisionEvidence(content)
    : null;
  if (decisionEvidence) {
    console.log(`[Claude] Decision evidence captured (level: ${decisionEvidenceLevel}, path: cli)`);
  }
  const decisionEvidenceRequested = !!(decisionEvidenceLevel && decisionEvidenceLevel !== 'none');
  const decisionEvidenceMissing = decisionEvidenceRequested && !decisionEvidence;
  const evidenceCorr = effectiveSessionId || claudeResponse.session_id || session_id || `CHAT_${Date.now()}`;
  const cleanContent = decisionEvidence
    ? content.replace(/<decision_evidence>[\s\S]*?<\/decision_evidence>/g, '').trim()
    : content;

  console.log('[Claude] CLI success, session:', claudeResponse.session_id, ', tools:', toolsUsed.join(', ') || 'none');

  // Cache tool results under the CLI-returned session_id too
  if (claudeResponse.session_id && claudeResponse.session_id !== session_id && typeof setToolCache === 'function') {
    const fresh = toolResults.filter((r) => !r.cached);
    if (fresh.length > 0) setToolCache(claudeResponse.session_id, fresh);
  }

  if (typeof storeAuditEnvelope === 'function') {
    const legacyEnvelopePayload = {
      agent: selected_agent,
      path: 'cli',
      tools_used: allToolNames,
      response_length: content.length,
      cost_usd: claudeResponse.total_cost_usd || 0,
    };
    if (decisionEvidence) {
      legacyEnvelopePayload.decision_evidence = decisionEvidence;
    }
    if (decisionEvidenceMissing) {
      legacyEnvelopePayload.decision_evidence_missing = true;
    }
    storeAuditEnvelope({
      type: 'event',
      from: `agent.${selected_agent}`,
      to: 'audit.system',
      intent: 'quox.chat.success',
      org_id: jwtOrgId || undefined,
      corr: evidenceCorr,
      requires: decisionEvidenceRequested
        ? { decision_evidence: decisionEvidenceLevel }
        : undefined,
      payload: legacyEnvelopePayload,
    });

    if (decisionEvidenceMissing) {
      storeAuditEnvelope({
        type: 'event',
        from: `agent.${selected_agent}`,
        to: 'audit.system',
        intent: 'quox.evidence.missing',
        corr: evidenceCorr,
        payload: {
          agent: selected_agent,
          level_required: decisionEvidenceLevel,
          corr: evidenceCorr,
        },
      });
    }
  }

  // AUDIT-REAL-4b: VOLT decision-evidence signals. The legacy CLI path has
  // no existing per-chat VOLT run (unlike the MCP path / messages
  // dispatcher), so a short-lived run is opened here purely to carry these
  // two events — never invented for any other purpose.
  if ((decisionEvidence || decisionEvidenceMissing) && voltEmitter
    && typeof voltEmitter.isAvailable === 'function' && voltEmitter.isAvailable()
    && typeof voltEmitter.startRun === 'function') {
    const evidenceVoltRunId = voltEmitter.startRun(evidenceCorr, {
      org_id: jwtOrgId || undefined,
      user_id: jwtUserId || undefined,
      agent_id: selected_agent,
      path: 'cli',
    });
    if (evidenceVoltRunId && typeof voltEmitter.emit === 'function') {
      if (decisionEvidenceMissing) {
        voltEmitter.emit(evidenceVoltRunId, 'agent.decision.missing', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          level_required: decisionEvidenceLevel,
        });
      }
      if (decisionEvidence) {
        voltEmitter.emit(evidenceVoltRunId, 'agent.decision.recorded', {
          actor: { actor_type: 'agent', actor_id: selected_agent },
          evidence_level: decisionEvidenceLevel,
          decision: decisionEvidence.decision,
          confidence: decisionEvidence.confidence,
        });
      }
    }
    if (evidenceVoltRunId && typeof voltEmitter.completeRun === 'function') {
      voltEmitter.completeRun(evidenceVoltRunId);
    }
  }

  // BRAIN2-V2-1: retrieval → answer. The legacy sub-path's own executeTool
  // calls pass only `{ agentId }` (no session_id), so nothing registers from
  // there and this is a no-op — kept so a turn that reached the brain through
  // any other in-process route still gets closed out rather than left to TTL.
  // Key on effectiveSessionId || session_id to match the response id (same
  // alignment as the MCP path above), should this ever stop being a no-op.
  try {
    const { finalizeAnswer } = require('./brainCitationTrace.js');
    Promise.resolve(finalizeAnswer(effectiveSessionId || session_id, cleanContent)).catch(() => {});
  } catch { /* non-fatal — evidence must never affect the chat path */ }

  return {
    outcome: 'success',
    path: 'cli',
    text: cleanContent + toolSuffix,
    voiceSummary,
    tokensUsed: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
    toolsUsed: allToolNames,
    toolExecutions,
    model: claudeResponse.model || (requestedModel || claudeCliDefaultModel),
    cost_usd: claudeResponse.total_cost_usd || 0,
    cliSessionId: claudeResponse.session_id || null,
    richContent: null,
    decisionEvidence: decisionEvidence || null,
  };
}

module.exports = { dispatchClaudeCli, CLI_TOOLS_TURN_TIMEOUT_MS, CLI_TOOLS_BASH_TIMEOUT_MS, nativeAllowedTools, mergeNativeTools, VOICE_BRAIN_RECALL_PROMPT, captureOverride, wantsCaptureOverride };
