/**
 * loopProviders.js: QLOOP-ENGINE P2b, the single provider-adapter registry.
 *
 * A QLoop hands an objective's goal to a model's native loop. Which backend
 * drives it used to be decided by literal 'claude'/'codex' string checks
 * scattered across loopDispatch, backendVocabulary and server. This module is
 * the one extensible place that knows which backends exist. Each backend
 * registers an adapter:
 *
 *   id               stable id stored in objectives.loop_backend
 *   displayName      human label
 *   kind             'cli' (child process, e.g. claude -p) | 'api' (HTTP tool-call loop)
 *   payloadFormat    'stream-json' (claude stdin line) | 'text' (plain stdin text)
 *   isAvailable()    can this backend be dispatched right now?
 *   unavailableReason() text for the refusal when it cannot
 *   buildArgs(scope, prompt) -> { args, systemPromptText }   scope -> argv
 *   canonicalToolName(raw)   stream tool name -> scope (claude) vocabulary
 *   assertScopeHonorable(scope)  throw if the backend cannot enforce the scope
 *
 * Governance (DEC-6 deny-all, capability gate, WARD, HITL, kill path) lives
 * outside the adapters and is not touched by registration.
 */

export const DEFAULT_LOOP_BACKEND = 'claude'

const registry = new Map()

export function registerLoopProvider(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id) {
    throw new Error('loop provider adapter requires a string id')
  }
  registry.set(adapter.id, Object.freeze({ ...adapter }))
}

export function getLoopProvider(id) {
  return registry.get(id) || null
}

export function listLoopProviders() {
  return [...registry.values()]
}

/** Registered ids (recognised by validation), available or not. */
export function recognisedLoopBackendIds() {
  return [...registry.keys()]
}

export function isRecognisedLoopBackend(id) {
  return registry.has(id)
}

/** Registered AND dispatchable right now. */
export function isLoopBackendAvailable(id) {
  const p = registry.get(id)
  return !!p && p.isAvailable() === true
}

/** "'claude' or 'codex'": the available ids, for error strings. */
export function availableBackendsPhrase() {
  return listLoopProviders().filter(p => p.isAvailable()).map(p => `'${p.id}'`).join(' or ')
}

/** Stored/requested backend -> effective id: a recognised id, else the default. */
export function normalizeLoopBackend(id) {
  return registry.has(id) ? id : DEFAULT_LOOP_BACKEND
}

/**
 * Refuse a backend that is unknown or registered but not yet live. The unknown
 * message is the pre-registry string verbatim.
 */
export function assertLoopBackendDispatchable(id) {
  const p = registry.get(id)
  if (!p) {
    throw new Error(`unknown loop backend '${id}' (expected ${availableBackendsPhrase()})`)
  }
  if (!p.isAvailable()) {
    throw new Error(p.unavailableReason ? p.unavailableReason() : `loop backend '${id}' is not yet available`)
  }
  return p
}

// ---- shared scope helpers (also used by backendVocabulary) ----------------

const SHELL_NAMES = new Set(['bash', 'command'])

/** Strip a scope entry's argument pattern: 'Bash(git *)' -> 'Bash'. */
export function entryName(entry) {
  if (typeof entry !== 'string') return ''
  const paren = entry.indexOf('(')
  return (paren > 0 ? entry.slice(0, paren) : entry).trim()
}

function scopeAllowsShell(scope) {
  if (!Array.isArray(scope)) return false
  return scope.some(entry => SHELL_NAMES.has(entryName(entry).toLowerCase()))
}

// ---- cli adapters ---------------------------------------------------------

registerLoopProvider({
  id: 'claude',
  displayName: 'Claude Code',
  kind: 'cli',
  payloadFormat: 'stream-json',
  // Base argv the core-local runner spawns with. Mirrored by CLI_BACKENDS in
  // services/collector/lib/coreLocalLoopRunner.js; pinned by
  // services/collector/test/loopBackendAgreement.test.js.
  baseArgs: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
  isAvailable: () => true,
  // claude (canonical): both levers are real flags.
  buildArgs(scoped, prompt) {
    const args = []
    if (prompt) args.push('--append-system-prompt', prompt)
    if (scoped) args.push('--allowedTools', scoped.join(','))
    return { args: args.length > 0 ? args : undefined, systemPromptText: null }
  },
  canonicalToolName: rawTool => rawTool,
  assertScopeHonorable: () => {},
})

registerLoopProvider({
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  kind: 'cli',
  payloadFormat: 'text',
  baseArgs: ['exec', '--json', '--skip-git-repo-check', '-'],
  isAvailable: () => true,
  // Deny by default: a scope that never names the shell family runs read-only.
  // `codex exec` takes --sandbox as its ONLY safety lever and rejects
  // -a/--ask-for-approval (proven dev-01 2026-08-14, codex 0.118).
  // --skip-git-repo-check: the loop cwd is not a repo (proven live 2026-08-14);
  // the sandbox is the real containment.
  buildArgs(scoped, prompt) {
    return {
      args: ['--sandbox', scopeAllowsShell(scoped) ? 'workspace-write' : 'read-only', '--skip-git-repo-check'],
      systemPromptText: prompt,
    }
  },
  // 'command' -> 'Bash'; '<server>.<tool>' -> 'mcp__<server>__<tool>' (first
  // segment only is the server). Anything else passes through.
  canonicalToolName(rawTool) {
    if (typeof rawTool !== 'string' || rawTool === '') return rawTool
    if (rawTool === 'command') return 'Bash'
    const dot = rawTool.indexOf('.')
    if (dot > 0 && dot < rawTool.length - 1) {
      return `mcp__${rawTool.slice(0, dot)}__${rawTool.slice(dot + 1)}`
    }
    return rawTool
  },
  // codex cannot enforce argument patterns: a patterned entry would be
  // silently widened, so refuse loudly.
  assertScopeHonorable(scope) {
    if (!Array.isArray(scope)) return
    for (const entry of scope) {
      if (typeof entry === 'string' && entry.includes('(')) {
        throw new Error(
          `capability_scope entry '${entry}' carries an argument pattern, but a codex loop ` +
          `cannot enforce argument patterns: codex exec --sandbox is shell on/off only, and its ` +
          `MCP grants are whole-tool. A patterned scope would be silently widened (a shell pattern ` +
          `becomes arbitrary shell in a writable workspace, an MCP pattern grants the whole tool). ` +
          `Author the scope without argument patterns for codex, or drive this objective on claude.`
        )
      }
    }
  },
})

// ---- api adapter STUB (gated OFF) -----------------------------------------

/**
 * 'openai' (general Chat Completions tool-call loop, collector openaiLoopRunner).
 * Dispatchable when QLOOP_OPENAI_BACKEND=1. Availability is FLAG-ONLY, matching
 * the collector runner's isAvailable: the per-org key is resolved collector-side
 * through the existing vault seam at spawn (resolveProviderKey), NOT from a
 * process env, so requiring OPENAI_API_KEY here would both contradict the
 * per-org vault design and wrongly report the backend unavailable when a real
 * org key exists. A missing org key fails the session loudly in the runner.
 * Read at call time so tests can toggle the flag.
 */
export function openaiFlagOn(env = process.env) {
  return env.QLOOP_OPENAI_BACKEND === '1'
}

registerLoopProvider({
  id: 'openai',
  displayName: 'OpenAI (Chat Completions)',
  kind: 'api',
  payloadFormat: 'api',
  // Live runner: collector openaiLoopRunner.js (real OpenAI Chat Completions
  // model client). Dispatchable when QLOOP_OPENAI_BACKEND=1 (flag-only). The
  // per-org key is resolved collector-side via the existing vault seam at spawn;
  // a missing org key fails the session loudly there. Default OFF.
  isAvailable: () => openaiFlagOn(),
  unavailableReason: () => "loop backend 'openai' is not yet available",
  // No argv: the api runner owns the loop. The prompt rides the text payload.
  buildArgs(_scoped, prompt) {
    if (!openaiFlagOn()) throw new Error("loop backend 'openai' is not yet available")
    return { args: undefined, systemPromptText: prompt }
  },
  canonicalToolName: rawTool => rawTool,
  assertScopeHonorable: () => {},
})
