// loopScopePresets.js — DEVSUITE-DEVMODE 5c (owner-signed-off UX 2026-08-11)
//
// Named starting points for a loop objective's capability_scope: the
// deny-by-default tool allowlist the autonomy gate enforces (any tool
// outside the scope forces ESCALATE, fail-closed; an EMPTY scope
// escalates every tool). Editing a preset's list in the picker flips the
// selection to 'custom' — presets are starting points, not locks.
//
// Two name families are legitimate scope entries and both appear here:
//  - Quox registry tool names (agentRegistry.js: read_file,
//    codebase_query, memory_search, ...) — what task rows carry in
//    tools_required and what makeDecision() compares against today.
//  - Loop-backend native tool names (claude -p: Read, Grep, Bash, ...)
//    — what the loop's own stream events will name once the fleet seam
//    lands. Scoping them now means the signed scope already covers the
//    session's real tool vocabulary.
export const LOOP_SCOPE_PRESETS = [
  {
    id: 'read-only',
    label: 'Read-only investigation',
    description: 'Look, search and report. Nothing that mutates.',
    tools: [
      'read_file', 'codebase_query', 'memory_search',
      'skills_list', 'skill_view', 'fleet_status',
      'Read', 'Grep', 'Glob',
    ],
  },
  {
    id: 'dev-loop',
    label: 'Code and build',
    description: 'Read, edit, run builds and tests inside the session workspace.',
    tools: [
      'read_file', 'codebase_query', 'memory_search', 'memory_save',
      'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash',
    ],
  },
  {
    id: 'self-extension',
    label: 'Self-extension',
    description: 'Loop may author QSKL skills through the governed chokepoint.',
    tools: [
      'Read', 'Grep', 'Glob',
      'mcp__quox__skills_list', 'mcp__quox__skill_view', 'mcp__quox__skill_manage',
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Hand-picked scope. Starts from whatever was selected.',
    tools: null, // keeps the current selection
  },
]

export function getPreset(id) {
  return LOOP_SCOPE_PRESETS.find(p => p.id === id) || null
}

/** Which preset exactly matches this tool list, else 'custom'. */
export function matchPreset(tools) {
  const sorted = [...tools].sort().join('|')
  const hit = LOOP_SCOPE_PRESETS.find(p => p.tools && [...p.tools].sort().join('|') === sorted)
  return hit ? hit.id : 'custom'
}
