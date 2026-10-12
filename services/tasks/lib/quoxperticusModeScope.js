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

const OBSERVE_SCOPE = Object.freeze([
  'read_file', 'codebase_query', 'memory_search',
  'skills_list', 'skill_view', 'fleet_status',
  'Read', 'Grep', 'Glob',
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
  'memory_save',
  'Edit', 'Write', 'Bash',
])

const FULL_SCOPE = Object.freeze([
  ...PARTIAL_SCOPE,
  'mcp__quox__skills_list', 'mcp__quox__skill_view', 'mcp__quox__skill_manage',
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
