// transcriptNoise.mjs — ONE-BRAIN CX5 (F2) transcript ingest hygiene.
//
// Pure helper: decides whether a user-role text block is something the human
// wrote, or machinery the harness injected (loaded skill bodies, slash-command
// wrappers, local-command output/caveats, system reminders).
//
// PARITY: services/collector/lib/transcriptNoise.js is the byte-for-byte same
// logic in CJS (the collector image does not ship this directory). Keep them
// identical; test/transcriptNoise.test.js pins them together.
//
// No length heuristics: only structural markers are dropped.

const SKILL_BODY_PREFIX = 'Base directory for this skill:'
const SKILL_LAUNCH_PREFIX = 'Launching skill:'
const WRAPPER_BLOCK = /<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder)>[\s\S]*?<\/\1>/g

/**
 * @param {string} text raw user text block
 * @returns {string|null} cleaned text, or null when nothing human remains
 */
export function cleanUserText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('<system-reminder>')) return null
  if (trimmed.startsWith(SKILL_BODY_PREFIX)) return null
  if (trimmed.startsWith(SKILL_LAUNCH_PREFIX)) return null
  if (!trimmed.includes('<')) return trimmed
  const stripped = trimmed.replace(WRAPPER_BLOCK, '').trim()
  return stripped || null
}
