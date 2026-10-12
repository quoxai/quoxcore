/**
 * backendVocabulary.js: DEVSUITE-DEVMODE / QLoop feature 3.
 *
 * A loop objective's `capability_scope` is authored ONCE, by a human, in
 * claude's tool vocabulary ('Read', 'Bash(git *)', 'mcp__quox__skill_manage').
 * The loop itself may be driven by any backend, and the backends neither name
 * tools the same way nor accept the same enforcement flags. This module is the
 * single place that knows the differences, so loopDispatch stays backend-neutral:
 *
 *   canonicalToolName()    stream name -> scope vocabulary (read side)
 *   scopeToBackendArgs()   scope -> the argv that backend actually understands
 *   enabledToolsFromScope() scope -> the plain tool names the agent side grants
 *
 * Backend facts, verified 2026-08-14:
 *   claude  --append-system-prompt <text>, --allowedTools <comma list>. The CLI
 *           itself auto-denies an out-of-scope tool in `-p` stream mode, so the
 *           scope is genuine pre-flight enforcement.
 *   codex   has NO --allowedTools and no system-prompt flag. Its real levers are
 *           --sandbox {read-only,workspace-write,danger-full-access},
 *           -a/--ask-for-approval, and `-c` config overrides. Per-server MCP tool
 *           allowlists live in codex's own config (mcp_servers.<name>.enabled_tools),
 *           which the HOST side writes: tasks must never emit a `-c` argument,
 *           because argv is world-readable in `ps` and an MCP server config can
 *           carry credentials. The system prompt therefore travels in the stdin
 *           payload instead of a flag.
 */

/** The shell-execution family, in either backend's spelling. */
const SHELL_NAMES = new Set(['bash', 'command'])

// Harness-internal tools the CLI needs in order to operate at all under a
// scope. ToolSearch performs no external action: it only loads deferred tool
// schemas, and is the loop's ONLY way to reach a scoped mcp__quox__ tool.
// Proven necessary 2026-08-14: the first live scoped loop was interrupted by
// the backstop for calling ToolSearch on its way to mcp__quox__skill_manage.
// Additions to this set need the same justification: internal, no side effect.
export const HARNESS_INTERNAL_TOOLS = new Set(['ToolSearch'])

/** Strip a scope entry's argument pattern: 'Bash(git *)' -> 'Bash'. */
function entryName(entry) {
  if (typeof entry !== 'string') return ''
  const paren = entry.indexOf('(')
  return (paren > 0 ? entry.slice(0, paren) : entry).trim()
}

/**
 * Translate a tool name as it appeared in a backend's event stream into the
 * canonical (claude) vocabulary the capability_scope is written in.
 *
 * claude is identity by definition: it IS the canonical vocabulary.
 *
 * codex names things differently, and loopDispatch's normalizer mints two
 * shapes that need mapping:
 *   'command'            a command_execution turn (shell), canonically 'Bash',
 *                        so a scope entry of 'Bash' or 'Bash(git *)' covers it
 *   '<server>.<tool>'    an mcp_tool_call turn, canonically 'mcp__<server>__<tool>'.
 *                        Only the FIRST segment is the server: a tool name may
 *                        itself contain dots and keeps them.
 * Anything else passes through untouched, including the normalizer's
 * 'mcp_tool' fallback for a call that named neither server nor tool.
 */
export function canonicalToolName(backend, rawTool) {
  if (backend !== 'codex') return rawTool
  if (typeof rawTool !== 'string' || rawTool === '') return rawTool
  if (rawTool === 'command') return 'Bash'
  const dot = rawTool.indexOf('.')
  if (dot > 0 && dot < rawTool.length - 1) {
    return `mcp__${rawTool.slice(0, dot)}__${rawTool.slice(dot + 1)}`
  }
  return rawTool
}

/** Does this scope authorise shell execution at all? Decides codex's sandbox level. */
function scopeAllowsShell(scope) {
  if (!Array.isArray(scope)) return false
  return scope.some(entry => SHELL_NAMES.has(entryName(entry).toLowerCase()))
}

/**
 * Compile a capability scope (plus the objective's system prompt) into the
 * per-backend CLI arguments, and say what could NOT be expressed as a flag.
 *
 * @param {string} backend 'claude' | 'codex'
 * @param {string[]|null} scope parsed capability_scope, or null for "unscoped"
 * @param {string|null} systemPrompt objectives.system_prompt, or null
 * @returns {{ args: string[]|undefined, systemPromptText: string|null }}
 *   args             extra argv beyond quoxagent's structuredBaseArgs(),
 *                    undefined when the backend needs none
 *   systemPromptText the prompt the CALLER must fold into the stdin payload,
 *                    null when a flag already carries it
 */
export function scopeToBackendArgs(backend, scope, systemPrompt) {
  const prompt = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : null
  const scoped = Array.isArray(scope) && scope.length > 0 ? scope : null

  // P1 DEC-6: refuse to build unrestricted args. A null/empty scope used to
  // mean "no --allowedTools" on claude (a fully unrestricted CLI) and a
  // silently-chosen read-only sandbox on codex; both are the allow-side of a
  // missing value. Dispatch already refuses scope-less loops; throwing here
  // keeps any other caller from re-opening the hole.
  if (!scoped) {
    throw new Error('empty or missing capability_scope: deny-all (DEC-6) — refusing to build unrestricted loop args')
  }

  if (backend === 'codex') {
    // Deny by default: a scope that never names the shell family runs read-only.
    // `codex exec` (headless) takes --sandbox as its ONLY safety lever and
    // rejects -a/--ask-for-approval outright ("unexpected argument '-a'",
    // proven on dev-01 2026-08-14 codex 0.118): in exec mode there
    // is no operator to prompt, so approvals never fire and the flag is invalid.
    // The human gate happened at objective approval, upstream of the spawn.
    // --skip-git-repo-check: codex exec refuses to run outside a trusted (git)
    // directory otherwise ("Not inside a trusted directory", proven live 2026-08-14).
    // The loop's cwd is the agent's working dir, not a repo, and the sandbox is
    // the real containment, so the git-trust check adds nothing here.
    return {
      args: ['--sandbox', scopeAllowsShell(scoped) ? 'workspace-write' : 'read-only', '--skip-git-repo-check'],
      systemPromptText: prompt,
    }
  }

  // claude (canonical): both levers are real flags.
  const args = []
  if (prompt) args.push('--append-system-prompt', prompt)
  if (scoped) args.push('--allowedTools', scoped.join(','))
  return { args: args.length > 0 ? args : undefined, systemPromptText: null }
}

/**
 * Fail-loud guard for a CODEX loop: codex cannot enforce argument PATTERNS, so a
 * patterned scope entry would be SILENTLY WIDENED rather than honored. This
 * covers both shapes in one check, because both widen the same way:
 *   'Bash(git *)'                    codex governs shell only via
 *                                    `codex exec --sandbox` (shell on/off), never
 *                                    argument patterns, so this flips to arbitrary
 *                                    shell in a writable workspace, NOT git-only.
 *   'mcp__quox__skill_manage(read *)' codex MCP grants are whole-tool
 *                                    (enabled_tools names a tool, not an
 *                                    argument filter), so this grants the WHOLE
 *                                    tool, not the read-only slice authored.
 *
 * An argument pattern is any entry containing '(' (the CLI allowlist syntax's
 * open-paren). Codex loops are rare (only proof runs exist, all on unpatterned
 * mcp__quox__ scopes), so rejecting a patterned scope for codex is safe and
 * honest: the alternative is a scope that lies about what it grants. claude is
 * unaffected, since `claude --allowedTools` DOES honor argument patterns.
 *
 * @param {string[]|null} scope parsed capability_scope, or null/[] for "unscoped"
 * @throws {Error} naming the offending entry when the codex scope is patterned
 */
export function assertCodexScopeHonorable(scope) {
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
}

/**
 * The governed Quox tools this scope grants, as PLAIN names (prefix stripped),
 * for the spawn's tool_access.enabled_tools. The agent side consumes these to
 * write the backend's own MCP tool allowlist host-side, where a per-backend
 * config file is the right home for it and no name reaches argv.
 */
export function enabledToolsFromScope(scope) {
  if (!Array.isArray(scope)) return []
  return scope
    .map(entryName)
    .filter(name => name.startsWith('mcp__quox__'))
    .map(name => name.slice('mcp__quox__'.length))
    .filter(Boolean)
}
