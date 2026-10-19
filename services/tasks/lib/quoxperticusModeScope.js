/**
 * QUOXPERTICUS mode -> capability scope (P1 mode substrate)
 *
 * The per-instance mode (instance.mode.quoxperticus, resolved server-side by
 * the auth service; FULL is capped to PARTIAL off a disposable_test
 * instance) narrows what the resident agent may do by mapping to a concrete
 * deny-by-default capability_scope for its QLoop objectives. DEC-6 makes an
 * absent scope refuse to dispatch entirely, so OFF maps to null and nothing
 * runs.
 *
 * The lists echo the owner-signed loop scope presets
 * (src/config/loopScopePresets.js): OBSERVE = the read-only preset, PARTIAL
 * = the dev-loop preset, FULL = dev-loop plus the governed self-extension
 * tools. Kept server-side here because this is enforcement input, not UX; if
 * the presets and this file drift, the narrower list wins by construction
 * (the scope is what actually dispatches).
 *
 * Strictly widening by design: OBSERVE ⊂ PARTIAL ⊂ FULL, tested in
 * test/quoxperticusModeScope.test.js.
 */

// VOCABULARY CONTRACT (backendVocabulary.js module doc): capability_scope is
// authored in CLAUDE's tool vocabulary — governed Quox tools as
// 'mcp__quox__<tool>', loop-backend NATIVE tools bare ('Read', 'Bash(git *)').
// This matters twice: scopeToBackendArgs passes the scope verbatim to claude's
// --allowedTools (where an MCP tool is only matched under the 'quox' server key,
// i.e. mcp__quox__read_file), and enabledToolsFromScope grants tool_access ONLY
// for mcp__quox__-prefixed entries (stripping the prefix for the agent's
// enabled_tools). A BARE Quox name ('read_file') is therefore dropped on BOTH
// paths: claude auto-denies it AND no tool_access is minted, so the spawned
// claude gets no --mcp-config and the patrol has zero Quox tools. (Found
// 2026-10-15 running self-learning for real: an OBSERVE patrol ran with
// mcpServers empty because every Quox tool here was bare; gripe #1039.)
const OBSERVE_SCOPE = Object.freeze([
  // Governed read + the two tools the patrol's standing goal REQUIRES:
  // create_inbox_item (file a finding) and continuity (commit the closing
  // self-delta — the self-learning act). Both were missing before, so even a
  // correctly-wired MCP left the patrol unable to do its job (#1039).
  // memory_search is deliberately NOT here: it belongs to the 'data-ops'
  // PRODUCT preset, and loop mode scopes stay isolated from product tools
  // (loopScopeProductPresets.test.js); the patrol orients via codebase_query,
  // read_file and native shell instead.
  'mcp__quox__read_file', 'mcp__quox__codebase_query',
  'mcp__quox__skills_list', 'mcp__quox__skill_view', 'mcp__quox__fleet_status',
  'mcp__quox__create_inbox_item', 'mcp__quox__continuity',
  // ToolSearch loads the deferred mcp__quox__ tool schemas so claude can call
  // them; it performs no external action (HARNESS_INTERNAL_TOOLS). Without it
  // in --allowedTools, claude auto-denies the loader and never reaches a Quox
  // tool (first scoped loop, 2026-08-14).
  'ToolSearch', 'Read', 'Grep', 'Glob',
  // F8 (first live patrol, 2026-08-15): the claude loop backend is
  // shell-first, so a read-only mode with NO shell knots on Bash every turn
  // and the patrol does nothing. Argument-scoped read-only shell only
  // (claude enforces these patterns via --allowedTools); nothing that writes,
  // deletes, or mutates git state. NOT granted to codex, which cannot honour
  // argument patterns (a bare-shell widening) and is refused a patterned
  // scope by assertCodexScopeHonorable.
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(pwd)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)',
])

const PARTIAL_SCOPE = Object.freeze([
  ...OBSERVE_SCOPE,
  'mcp__quox__memory_save',
  'Edit', 'Write', 'Bash',
])

// FULL only ADDS skill_manage: skills_list/skill_view are already granted by
// OBSERVE (inherited through PARTIAL), so listing them here again would be a
// duplicate. The self-extension write tool is the one FULL-only grant.
const FULL_SCOPE = Object.freeze([
  ...PARTIAL_SCOPE,
  'mcp__quox__skill_manage',
])

export const QUOXPERTICUS_MODE_SCOPES = Object.freeze({
  OFF: null,
  OBSERVE: OBSERVE_SCOPE,
  PARTIAL: PARTIAL_SCOPE,
  FULL: FULL_SCOPE,
})

/**
 * @param {string} mode - OFF | OBSERVE | PARTIAL | FULL (any case/padding)
 * @returns {string[]|null} a fresh scope array, or null (OFF/unknown: nothing dispatches)
 */
export function scopeForQuoxperticusMode(mode) {
  const key = String(mode ?? '').trim().toUpperCase()
  const scope = QUOXPERTICUS_MODE_SCOPES[key]
  return Array.isArray(scope) ? [...scope] : null
}
